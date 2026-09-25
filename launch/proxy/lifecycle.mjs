// proxy/lifecycle.mjs — shutdown + registry sidecars (extracted from
// godot-mcp-proxy.mjs, SEE-1334 Phase 0a): clean-exit release markers, dynamic
// port release, steady-state registry heartbeat, proxy self-registration.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { S } from './state.mjs';
import {
    GODOT_MCP_HOME, GODOT_PORT, HEARTBEAT_INTERVAL_MS, PORT_ARBITER_ENABLED,
    PORT_ARBITER_LIB, REGISTRY_LOCK_PATH, REGISTRY_PATH, RUNTIME_ID,
} from './config.mjs';
import { log } from './log.mjs';
import { maybeProgressLog, rejectQueue } from './router.mjs';
import { finishRestartHold } from './restart.mjs';
import { editorPidAlive, readRuntimeState, writeRuntimeState, releaseRuntimeLock } from './state-file.mjs';

function shutdown() {
    S.shutdownRequested = true;
    if (S.leaseTimer) { clearInterval(S.leaseTimer); S.leaseTimer = null; }
    // SEE-1134 Q1: a held restart call must not leak into a client hang when the
    // proxy shuts down mid-restart.
    if (S.restartHold) {
        finishRestartHold(S.restartHold, { restarted: false, reason: 'shutdown' });
    }
    if (S.npx && S.npxRunning && !S.npx.killed) {
        S.npx.kill('SIGTERM');
    }
    // Do not kill the editor; the godot_mcp addon uses a lease and exits when
    // the WS client disconnects.
    rejectQueue('proxy shutting down');
    // SEE-1338 spec v2.1 §3.3 PROXY_EXIT: release ONLY the proxy ownership —
    // the editor state stays on disk (the editor outlives the proxy; the
    // successor's startup handoff reads WARM + 无 proxy 所有者 → HANDOFF).
    if (RUNTIME_ID) {
        try {
            writeRuntimeState(RUNTIME_ID, {
                proxy_pid: null,
                proxy_pid_started_at: null,
                heartbeat_at: new Date().toISOString(),
            }, { event: 'PROXY_EXIT', detail: 'clean shutdown; editor state preserved' });
        } catch { /* best-effort */ }
        releaseRuntimeLock(RUNTIME_ID);
    }
    markIntentionalRelease();
    releaseArbiterPort();
    setTimeout(() => process.exit(0), 500);
}

// SEE-1148 P3 (§2.5 第二层 proxy 主动): on a NORMAL shutdown, stamp this
// runtime's lease sidecar with `intentional_release=true`. The editor stays
// alive (the addon's own 120s disconnect-suicide still runs) — the marker is
// only a "I left deliberately" credential. The resident reaper reads it and
// SKIPS the 120s fresh-lease grace, reclaiming the idle editor on its next
// 5min sweep instead of waiting out a grace that was designed to protect a
// still-starting editor. Without this, a cleanly-exited proxy leaves an editor
// nobody is using sitting idle until the disconnect timer + grace elapse.
//
// Guarded to THIS runtime: the sidecar is only marked when its recorded
// runtime_id matches ours (or is absent/legacy — we then also match on port),
// so a clean shutdown of runtime A never marks a lease that concurrent
// runtime B just wrote on the same worktree.
//
// Synchronous (execFileSync) because shutdown() runs just before
// process.exit — an async mark would be abandoned. Best-effort: a mark
// failure only means the reaper falls back to the normal grace path.
function markIntentionalRelease() {
    if (!RUNTIME_ID) return;
    const projectGodot = process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT;
    if (!projectGodot) return;
    try {
        execFileSync('bash', ['-c', `
            set -euo pipefail
            sidecar="$(dirname "$1")/.godot/mcp-lease.json"
            [[ -f "$sidecar" ]] || exit 0
            # SEE-1348 WP4 (§SPEC-007): all sidecar writers serialize on
            # <sidecar>.lock — the same flock the sidecar lib's sidecar_mutate
            # holds. -w 5 + skip on contention: this is a best-effort shutdown
            # marker, never worth blocking exit for (the next heartbeat tick of
            # the reaper falls back to the grace path).
            exec 9>"$sidecar.lock"
            flock -w 5 9 || exit 0
            RID="$2" SIDE="$sidecar" node -e '
                const fs = require("fs");
                let o;
                try { o = JSON.parse(fs.readFileSync(process.env.SIDE, "utf8")); } catch (e) { process.exit(0); }
                const rid = process.env.RID;
                // Only mark OUR runtime's lease. A legacy/absent runtime_id is
                // acceptable only when it is empty (never set); a DIFFERENT
                // runtime_id means a concurrent slot owns this lease — do not touch.
                if (o.runtime_id && o.runtime_id !== rid) process.exit(0);
                if (o.state !== "active") process.exit(0);
                o.intentional_release = true;
                o.intentional_release_at = new Date().toISOString();
                const tmp = process.env.SIDE + ".tmp." + process.pid;
                fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + "\\n", "utf8");
                fs.renameSync(tmp, process.env.SIDE);
            '
        `, 'mark', projectGodot, RUNTIME_ID],
            { env: { ...process.env }, timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'] });
        log(`marked intentional_release on lease for runtime ${RUNTIME_ID} on shutdown.`);
    } catch (e) {
        log(`markIntentionalRelease: non-fatal mark failure for runtime ${RUNTIME_ID}: ${e && e.message ? e.message : e}`);
    }
}

// SEE-1148 P2 (release path): on a clean proxy exit, release this runtime's
// dynamically-granted port so a DIFFERENT runtime can re-grant it after the
// 60s cooldown. Synchronous (execFileSync) because shutdown() runs just before
// process.exit — an async release would be abandoned. Best-effort: a release
// failure only leaves a stale held dir, which the reaper backstop sweeps.
// Same-runtime respawn re-grabs instantly (cooldown skipped), so releasing on
// a same-slot restart does NOT cost the respawn its port.
function releaseArbiterPort() {
    if (!PORT_ARBITER_ENABLED || !RUNTIME_ID || !GODOT_PORT) return;
    // Only release ports in the dynamic pool — the legacy per-agent table
    // ports (6551-6556) are not arbiter-granted and must never be released
    // (a concurrent same-agent legacy holder could be using one).
    if (GODOT_PORT < 6560 || GODOT_PORT > 6609) return;
    try {
        execFileSync('bash', ['-c',
            'source "$1" && port_arbiter_release "$2"',
            'rel', PORT_ARBITER_LIB, String(GODOT_PORT)],
            { env: { ...process.env }, timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'] });
        log(`released dynamic port ${GODOT_PORT} for runtime ${RUNTIME_ID} on shutdown.`);
    } catch (e) {
        log(`releaseArbiterPort: non-fatal release failure for port ${GODOT_PORT}: ${e && e.message ? e.message : e}`);
    }
}

// SEE-1148 P1 (steady-state heartbeat → registry): refresh
// ~/.multica/godot-port-registry.json heartbeat_at while the proxy is alive
// AND post-WARM. Gated on stage === 'WARM' so warmup-phase transients (npx
// restarts, RC gate bounces) don't pollute the registry with a "this slot is
// healthy" signal that an early-running reader would trust. Refreshing only
// in steady state matches the brief: "挂到现有 steady-state 监控循环（非
// warmup 循环）". On any non-fatal upsert error we stay quiet — the registry
// is observability, not a gate.

async function refreshRegistryHeartbeat() {
    if (!RUNTIME_ID) return;
    if (S.stage !== 'WARM') return;
    // Throttle to ~HEARTBEAT_INTERVAL_MS so we don't fan out a write per poll.
    const now = Date.now();
    if (now - S.lastRegistryRefreshMs < HEARTBEAT_INTERVAL_MS) return;
    S.lastRegistryRefreshMs = now;
    const tmp = `${REGISTRY_PATH}.tmp.${process.pid}.${now}`;
    try {
        // F6 (Atlas P2): the heartbeat is a recurring writer on the SAME rid the
        // launcher's port_registry_upsert writes. Without a shared lock the two
        // read-modify-write interleave and the launcher's upsert can overwrite a
        // fresher heartbeat_at (heartbeat regresses → the reaper reads the slot
        // as stale → mis-kill). Serialize on the SAME flock the P1 registry lib
        // uses (godot-port-registry.json.lock) so heartbeat and launcher upsert
        // share one critical section — the P1 lock primitive, not a new lock.
        // flock -w 5 bounds the wait; a contended write is skipped (the next 2s
        // heartbeat re-attempts), never blocks the proxy. `flock <lock> node -e`
        // holds the fd for exactly the child read-modify-write — no fd crosses
        // an exec, no long-lived spawn inside the section.
        const mergeScript = `
            const fs = require("fs");
            const now = Number(process.env.REG_NOW);
            let cur = { schema_version: 1, updated_at: new Date(now).toISOString(), entries: {} };
            try { cur = JSON.parse(fs.readFileSync(process.env.REG_PATH, "utf8")); } catch (e) {}
            if (!cur.entries || typeof cur.entries !== "object") cur.entries = {};
            const rid = process.env.REG_RID;
            const prev = (cur.entries[rid] && typeof cur.entries[rid] === "object") ? cur.entries[rid] : {};
            cur.entries[rid] = Object.assign({}, prev, {
                heartbeat_at: new Date(now).toISOString(),
                proxy_pid: process.env.REG_PID ? Number(process.env.REG_PID) : process.pid,
            });
            cur.updated_at = new Date(now).toISOString();
            fs.writeFileSync(process.env.REG_TMP, JSON.stringify(cur, null, 2) + "\n", "utf8");
        `;
        execFileSync('flock', ['-w', '5', REGISTRY_LOCK_PATH, 'node', '-e', mergeScript], {
            env: Object.assign({}, process.env, {
                REG_PATH: REGISTRY_PATH, REG_TMP: tmp, REG_RID: RUNTIME_ID,
                REG_PID: String(process.pid), REG_NOW: String(now),
            }),
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        await rename(tmp, REGISTRY_PATH);
    } catch {
        // Best-effort: drop the tmp file if anything went wrong so we don't
        // leak state. Registry writes are not a correctness gate; a lost lock
        // just defers the heartbeat to the next interval.
        try { await unlink(tmp); } catch { /* ignore */ }
    }
}

function startHeartbeat() {
    // Heartbeat here means logging that the proxy is still alive and waiting.
    // We do NOT perform a WebSocket handshake to avoid stealing the addon's
    // single WS-client slot (constraint 2).
    setInterval(() => {
        if (S.shutdownRequested) return;
        maybeProgressLog();
        refreshRegistryHeartbeat().catch(() => {});
        selfRegisterProxyPid().catch(() => {});
        backfillEditorPid().catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
}

// SEE-1348 WP4 (§SPEC-008) heartbeat 兜底: start-godot-editor.sh backfills
// editor_pid at its CIM-resolution site, but editors launched by an OLDER
// script (or a failed CLI write) leave the slot null. While WARM, adopt the
// lifecycle pidfile's numeric pid once — the same file kol_lifecycle_path
// maintains and godot-status reads. Source is inferred (documented, not
// guessed silently): a pid visible under /proc is WSL-side; anything else in
// this deployment is a Windows editor pid. A dead pid is never landed.
async function backfillEditorPid() {
    if (!RUNTIME_ID || S.stage !== 'WARM') return;
    const now = Date.now();
    if (now - S.lastEditorPidBackfillMs < HEARTBEAT_INTERVAL_MS) return;
    S.lastEditorPidBackfillMs = now;
    const st = readRuntimeState(RUNTIME_ID);
    // no state / schema mismatch → not ours to fix; populated pid or a
    // non-WARM record → the primary write point owns it / it doesn't matter.
    if (!st.ok || st.state.editor_pid || st.state.state !== 'WARM') return;
    const pid = readLifecyclePidfilePid();
    if (!pid) return;
    const source = existsSync(`/proc/${pid}`) ? 'wsl' : 'windows';
    if (!editorPidAlive(pid, source)) return; // never land a dead pid
    writeRuntimeState(RUNTIME_ID, {
        editor_pid: pid,
        editor_pid_started_at: now,
        editor_pid_source: source,
    }, { event: 'EDITOR_PID_BACKFILL', detail: `heartbeat fallback pid=${pid} source=${source}` });
    log(`editor_pid backfilled from lifecycle pidfile: pid=${pid} source=${source}`);
}

// Lifecycle pidfile (dir form only — the legacy flat name predates the
// per-runtime layout and has no runtime_id to key on from the proxy side).
function readLifecyclePidfilePid() {
    const p = path.join(GODOT_MCP_HOME, 'godot-editor', `${RUNTIME_ID}.pid`);
    try {
        const v = readFileSync(p, 'utf8').trim();
        return /^\d+$/.test(v) ? Number(v) : null;
    } catch {
        return null;
    }
}

// SEE-1316 (hardener) — reaper contract closure, proxy self-registration: stamp
// this proxy's PID onto its own runtime's ACTIVE lease sidecar. The reaper's
// proxy_pid_dead branch (reap-stale-leases.sh) needs an attributable,
// killable owner PID: configured_by_pid is the short-lived configure shell
// (always dead post-exit) and nothing else in the sidecar names the proxy, so
// a SIGKILLed proxy used to strand the editor until the addon's internal
// 45s/120s windows ran out with no reaper backstop. Best-effort and idempotent
// (sidecar_set_proxy_pid skips foreign-runtime / non-active sidecars and never
// clobbers a live different proxy_pid); retried on the heartbeat cadence until
// it lands, so a race with configure's sidecar write resolves itself.

async function selfRegisterProxyPid() {
    if (S.proxyPidRegistered || !RUNTIME_ID || S.stage !== 'WARM') return;
    if (!GODOT_PORT) return;
    const worktree = process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE;
    if (!worktree) return;
    const projectGodot = process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT
        || `${worktree}/project.godot`;
    const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp-sidecar.lib.sh'); // SEE-1334: one level deeper
    try {
        await new Promise((resolve, reject) => {
            execFile('bash', ['-c',
                'source "$1" && sidecar_set_proxy_pid "$2" "$3"',
                'regpid', lib, projectGodot, String(process.pid)],
            { env: { ...process.env }, timeout: 5000 }, (err) => err ? reject(err) : resolve());
        });
        S.proxyPidRegistered = true;
        log(`self-registered proxy_pid=${process.pid} on lease sidecar (runtime ${RUNTIME_ID}).`);
    } catch (e) {
        // Non-fatal: the next heartbeat retries; a sidecar without proxy_pid
        // simply falls back to the pre-fix reaper behavior.
        log(`selfRegisterProxyPid: non-fatal failure (will retry on heartbeat): ${e && e.message ? e.message : e}`);
    }
}

export {
    shutdown,
    markIntentionalRelease,
    releaseArbiterPort,
    refreshRegistryHeartbeat,
    startHeartbeat,
    selfRegisterProxyPid,
};
