// SEE-1134 release-after-start sidecar race mock.
//
// Atlas trigger 44f50c2e (SEE-1129 thread c5feaf05): under multi-agent
// concurrent cold-start, Bachi's mcp-lease.json was found state=released even
// though Bachi's editor was actively starting. Atlas's hypothesis: a cleanup
// path writes sidecar active→released AFTER the editor already grabbed the
// port. Bachi's own earlier report (3ed8eef3) flagged exactly this: "sidecar
// 在 editor 起来之后又被某条清理路径写回 released".
//
// This mock distills the reaper's staleness verdict into a pure function and
// proves:
//   - BEFORE fix: a freshly-written active lease (cfg PID = the configure
//     shell, always dead post-exit; editor pidfile = "pending" or absent,
//     which fails the ^[0-9]+$ regex → treated as dead) is ruled STALE and
//     released by ANOTHER agent's reaper running concurrently. This is the
//     release-after-start race.
//   - AFTER fix: a freshness grace-period guard refuses to reap any lease
//     whose configured_at is within the last N seconds, so the concurrent
//     reaper leaves the fresh lease alone. Stale-lease cleanup (case #2/#9)
//     still works for genuinely old leases past the grace window.
//
// Why a grace period (not "skip self-agent" / "skip on startup configure"):
//   - configure-mcp-port.sh runs the reaper globally on every cold start, so
//     "skip on configure" would also skip the real case-#2 cleanup the reaper
//     exists for.
//   - the race is fundamentally temporal: cfg_dead is ALWAYS true post-exit
//     (configured_by_pid = the configure shell, SIDE_PID=$$), and the editor
//     PID is unknown during the async Windows-CIM resolution window. The only
//     signal that distinguishes "fresh lease whose editor is still resolving"
//     from "stale lease from a crashed prior run" is HOW LONG AGO it was
//     written. So a configured_at-based grace window is the correct gate.
//
// Constants from the real code:
//   GRACE_S default 120 — covers the cold-boot + CIM resolve window measured
//   in prior turns (cold ~40s per SEE-1110 §5, CIM resolve observed ~6s, plus
//   multi-agent scheduler spread).

function isNumPid(s) {
    return typeof s === 'string' && /^[0-9]+$/.test(s);
}

// Faithful port of reap-stale-leases.sh pid_alive for the "pending"/absent case.
// We do NOT model powershell here — only the regex gate, which is the failure
// mode that matters (a numeric Windows PID resolved via CIM would pass; the
// race happens before that resolves).
function pid_alive(pid, opts) {
    if (!isNumPid(pid)) return false;       // 'pending' / '' / non-numeric → dead
    // A numeric editor PID supplied as "live" in the fixture simulates a
    // resolved Windows PID that powershell.exe would confirm alive.
    if (opts && opts.liveEditorPids && opts.liveEditorPids.has(Number(pid))) return true;
    return false;                            // numeric but not in the live set → dead
}

// BEFORE fix: the current reaper verdict (staleness branches A/B/C), no grace.
function reaperVerdict_master(lease, ctx) {
    if (lease.state !== 'active') return { stale: false, keep: true };
    const cfgPid = lease.configured_by_pid == null ? '' : String(lease.configured_by_pid);
    let editorPid = '';
    if (ctx.editorPidfiles[lease.label] !== undefined) {
        editorPid = String(ctx.editorPidfiles[lease.label]).trim();
    }
    if (editorPid === '') editorPid = cfgPid;

    const cfgDead = cfgPid === '' ? false : !pid_alive(cfgPid, ctx);
    const edDead  = editorPid === '' ? false : !pid_alive(editorPid, ctx);
    let portCold = false;
    if (lease.port && ctx.portListeners && !ctx.portListeners.has(lease.port)) portCold = true;

    if (cfgDead && (editorPid === '' || edDead)) {
        return { stale: true, reason: 'owner_pid_dead', keep: false };
    }
    if (editorPid !== '' && edDead && cfgDead) {
        return { stale: true, reason: 'editor+cfg_pid_dead', keep: false };
    }
    if (lease.port && portCold && (editorPid === '' || edDead)) {
        return { stale: true, reason: 'port_cold_no_listener', keep: false };
    }
    return { stale: false, keep: true };
}

// AFTER fix: same verdict but with a configured_at freshness grace gate that
// runs FIRST. A lease younger than GRACE_S is never reaped, regardless of how
// dead its cfg/editor PIDs look.
function reaperVerdict_fixed(lease, ctx) {
    if (lease.state !== 'active') return { stale: false, keep: true };
    const graceS = (ctx.graceS == null) ? 120 : ctx.graceS;
    const ageS = (ctx.nowMs - Date.parse(lease.configured_at)) / 1000;
    if (Number.isFinite(ageS) && ageS >= 0 && ageS < graceS) {
        return { stale: false, keep: true, grace: true };
    }
    return reaperVerdict_master(lease, ctx);
}

const AGENT_BACHI = 'Bachi';
const AGENT_FRONTI = 'Fronti';

// Fixture: Bachi's lease, written 5s ago (fresh). configured_by_pid = a PID
// that is NOT in the live set (simulating the configure shell which already
// exited). editor pidfile holds 'pending' (start-godot-editor.sh:437 writes
// 'pending' before the async CIM resolver overwrites it). This is the exact
// configure→start window.
const FRESH_BACHI_LEASE = {
    schema_version: 1, port: 6553, agent: AGENT_BACHI, label: 'bachi',
    state: 'active', lease_id: 'L-1',
    worktree: '/ws/41115b3c/workdir/KingOfLikes-Godot',
    configured_at: new Date(Date.now() - 5_000).toISOString(),
    configured_by_pid: 999999, // the configure shell; not in liveEditorPids → dead
    released_at: null,
};

// Fixture: a genuinely stale lease from a prior crashed run, written 600s ago.
const STALE_OLD_LEASE = {
    schema_version: 1, port: 6551, agent: AGENT_FRONTI, label: 'fronti',
    state: 'active', lease_id: 'L-2',
    worktree: '/ws/deadbeef/workdir/KingOfLikes-Godot',
    configured_at: new Date(Date.now() - 600_000).toISOString(),
    configured_by_pid: 888888, // dead
    released_at: null,
};

// Concurrent context: Fronti's configure-mcp-port.sh runs the global reaper
// while Bachi is in the configure→start window. No editor PIDs are live yet
// (Bachi's editor is still resolving its Windows PID; Fronti's reaper sees an
// empty/pending pidfile). Port listeners empty = nothing booted yet.
const concurrentCtx = () => ({
    nowMs: Date.now(),
    graceS: 120,
    editorPidfiles: { bachi: 'pending', fronti: '' },
    liveEditorPids: new Set(),    // nothing resolved yet
    portListeners: new Set(),     // nothing listening yet
});

const cases = [
    ['R1 race: Bachi fresh active lease + concurrent Fronti reaper → master REAPS (bug), fixed KEEPS (grace)',
     FRESH_BACHI_LEASE, concurrentCtx(),
     { masterStale: true, fixedStale: false, fixedGrace: true }],

    ['R2 old genuinely-stale lease (600s) → both master and fixed REAP (case #2/#9 cleanup preserved)',
     STALE_OLD_LEASE, concurrentCtx(),
     { masterStale: true, fixedStale: true, fixedGrace: false }],

    ['R3 fresh lease whose editor PID already resolved live → both keep (no-op, grace or not)',
     (() => { const c = concurrentCtx(); c.editorPidfiles.bachi = '12345'; c.liveEditorPids.add(12345); return c; })(),
     null,
     { editorPidfileLive: '12345' }],

    ['R4 lease exactly at grace boundary (age == grace) → reaped (boundary is exclusive on the low side)',
     (() => { const l = JSON.parse(JSON.stringify(FRESH_BACHI_LEASE)); l.configured_at = new Date(Date.now() - 120_000).toISOString(); return l; })(),
     concurrentCtx(),
     { masterStale: true, fixedStale: true, fixedGrace: false }],

    ['R5 malformed configured_at (unparseable) → grace gate skipped, falls through to PID verdict (master behavior)',
     (() => { const l = JSON.parse(JSON.stringify(FRESH_BACHI_LEASE)); l.configured_at = 'not-a-date'; return l; })(),
     concurrentCtx(),
     { masterStale: true, fixedStale: true, fixedGrace: false }],

    ['R6 released lease → both keep (no work, regardless of age)',
     (() => { const l = JSON.parse(JSON.stringify(FRESH_BACHI_LEASE)); l.state = 'released'; return l; })(),
     concurrentCtx(),
     { masterStale: false, fixedStale: false, fixedGrace: false }],
];

// Normalize each case to {lease, ctx, want} so per-case arg packing is explicit.
const N = cases.map(([label, leaseOrCtx, ctxOrNull, want]) => {
    if (want && want.editorPidfileLive) {
        // R3-style: arg2 is a custom ctx, lease is the canonical fresh one.
        return { label, lease: FRESH_BACHI_LEASE, ctx: leaseOrCtx, want };
    }
    return { label, lease: leaseOrCtx, ctx: ctxOrNull ?? concurrentCtx(), want };
});

let pass = 0, fail = 0;
for (const { label, lease, ctx, want } of N) {
    const m = reaperVerdict_master(lease, ctx);
    const f = reaperVerdict_fixed(lease, ctx);
    let ok = true;
    const notes = [];
    if ('masterStale' in want) {
        const got = m.stale;
        if (got !== want.masterStale) { ok = false; notes.push(`master stale=${got} want=${want.masterStale}`); }
    }
    if ('fixedStale' in want) {
        const got = f.stale;
        if (got !== want.fixedStale) { ok = false; notes.push(`fixed stale=${got} want=${want.fixedStale}`); }
    }
    if ('fixedGrace' in want) {
        const got = !!f.grace;
        if (got !== want.fixedGrace) { ok = false; notes.push(`fixed grace=${got} want=${want.fixedGrace}`); }
    }
    if (ok) { pass++; console.log(`ok   - ${label}`); }
    else { fail++; console.log(`FAIL - ${label}\n       ${notes.join('; ')}`); }
}

// Core invariant: across the realistic concurrent-start window (fresh lease,
// dead cfg PID, pending editor pidfile, no listeners), fixed NEVER reaps what
// master reaps. This is the release-after-start race closing.
const invCtx = concurrentCtx();
const m1 = reaperVerdict_master(FRESH_BACHI_LEASE, invCtx).stale;
const f1 = reaperVerdict_fixed(FRESH_BACHI_LEASE, invCtx).stale;
if (m1 === true && f1 === false) {
    pass++;
    console.log(`ok   - INVARIANT: master reaps fresh concurrent lease, fixed keeps it (race closed)`);
} else {
    fail++;
    console.log(`FAIL - INVARIANT: master=${m1} fixed=${f1} (expected master=true fixed=false)`);
}

console.log();
if (fail === 0) {
    console.log(`M_release_after_start_race OK (pass=${pass})`);
    process.exit(0);
} else {
    console.log(`M_release_after_start_race FAIL (pass=${pass} fail=${fail})`);
    process.exit(1);
}
