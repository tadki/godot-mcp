// see1338-handoff.mjs — SEE-1338 spec v2.1 §4.2 (D3): the startup handoff
// decision tree (pure, no IO — mock seam by injection, same discipline as
// see1325-recovery.mjs). Decision input is the ON-DISK state ONLY (盘上状态
// = 决策唯一依据, spec §3.4); the connection is the ACTION RECEIPT layered by
// the caller, never a decision input (warm-gate 教训).
//
// Inputs:
//   disk        — readRuntimeState() result ({ok:false} = no/corrupt state)
//   holderProxy — { pid, startedAt } of the state's proxy_pid (null when
//                 absent) OR null to signal "record names a dead proxy"
//   nowMs       — clock injection
//   opts        — { heartbeatMaxAgeMs }
//
// Outcomes (one per spec §4.2 branch):
//   cold_start      — FAILED_CLEAN / stale / no-file / corrupt → wipe & cold
//   handoff_warm    — WARM + fresh heartbeat + live proxy → connect receipt,
//                     connect success = HANDOFF (no new editor)
//   editor_busy     — WARM + fresh heartbeat + LIVE proxy (AMEND-1: 前任在管)
//                     OR heartbeat-stale + live proxy (AMEND-1 守卫: never
//                     clean/kill while the owner proxy is verifiably alive)
//   reclaim_dead    — proxy dead/failed-check + same-worktree editor →
//                     connect receipt; connect = HANDOFF adopt, fail = clean
//   editor_gone     — holder identity unreadable → fail-closed, no evict
//                     (§SPEC-007); caller surfaces a retryable diagnostic
export function decideHandoffAction(input = {}) {
    const { heartbeatMaxAgeMs = 10 * 60 * 1000 } = input.opts || {};
    const st = handoffState(input.disk);
    if (!st) return coldStart(`NO_STATE:${diskReason(input.disk)}`);
    const ctx = handoffCtx(st, input.holderProxy, input.nowMs, heartbeatMaxAgeMs);
    return (HANDOFF_DISPATCH[ctx.stName] || decideUnknown)(ctx);
}

function handoffState(disk) {
    return disk && disk.ok ? disk.state : null;
}

function diskReason(disk) {
    return disk ? disk.reason : 'no-input';
}

function coldStart(reason) {
    return { action: 'cold_start', reason };
}

function handoffCtx(st, holderProxy, nowMs, heartbeatMaxAgeMs) {
    return {
        stName: String(st.state || ''),
        fresh: heartbeatFreshPure(st.heartbeat_at, nowMs, heartbeatMaxAgeMs),
        proxyAlive: isProxyAlive(holderProxy),
    };
}

const HANDOFF_DISPATCH = {
    WARM: decideWarm,
    WARMING: decideInFlight,
    RECOVERING: decideInFlight,
    FAILED_CLEAN: () => ({ action: 'cold_start', reason: 'FAILED_CLEAN_REENTRANT' }),
    COLD: () => ({ action: 'cold_start', reason: 'COLD_RECORD' }),
};

function decideUnknown({ stName }) {
    return { action: 'cold_start', reason: `UNKNOWN_STATE:${stName}` };
}

function isProxyAlive(holderProxy) {
    return !!(holderProxy && holderProxy.pid
        && (holderProxy.verified === true
            || (holderProxy.verified !== false && holderProxy.alive !== false)));
}

// SEE-1338 P1 线性单源裁决 — REUSE lane single-source decision (pure).
// Replaces the legacy four-flow stack (arbiter verdict → SEE-1129 reuse
// predicate → sidecar guard → HANDOFF downgrade) for runtimes WITH a readable
// .state record: every input is an on-disk field plus the holder-pid triple
// check, computed by the caller. No live probes, no new conditions at the
// call site — any future condition must land on the record first.
//   handoff_reuse  — editor provably serves this slot: adopt (no new editor)
//   editor_busy    — a LIVE same-runtime proxy owns it (AMEND-1: 前任在管)
//   cold_start     — record says the chain is broken (dead holder on a
//                    mismatched worktree / FAILED_CLEAN / stale dead record):
//                    legacy cleanup lane owns physical attribution
const WT_MATCH_PREFIXES = { WARM: 'WARM_DEAD_HOLDER', WARMING: 'WARMING_DEAD_HOLDER', RECOVERING: 'RECOVERING_DEAD_HOLDER' };

// SEE-1348 WP7 (§SPEC-012): the reuse-lane single-source decision now ALSO
// weighs the recorded editor_pid. WP4 populated editor_pid/editor_pid_source
// on the .state record; when the proxy is dead AND the recorded editor pid is
// ALSO dead (split-source probe: WSL kill(0) / Windows Get-Process), there is
// no live editor to adopt even on a worktree match — a cold_start beats a
// handoff that would spend the whole warmup budget connecting to a corpse
// before falling back. The liveness INPUT is still the on-disk record + the
// pure split-source probe (no live network probes; the warm-gate lesson).
export function decideReuseSingleSource({ state = '', holderProxyAlive = false, holderWorktree = '', ourWorktree = '', samePort = true, editorAlive = null }) {
    if (!samePort) return { action: 'cold_start', reason: 'PORT_MISMATCH_RECORD' };
    if (state === 'FAILED_CLEAN') return { action: 'cold_start', reason: 'FAILED_CLEAN_REENTRANT' };
    if (!(state in WT_MATCH_PREFIXES)) return { action: 'cold_start', reason: `RECORD_STATE:${state}` };
    // editorAlive === false is a POSITIVE on-disk+probe verdict that the
    // recorded editor is dead; null (no record / unknown source / probe
    // unavailable) keeps the historical behavior — unknown must not guess.
    if (editorAlive === false) {
        return { action: 'cold_start', reason: `${WT_MATCH_PREFIXES[state]}_EDITOR_DEAD` };
    }
    return decideReuseByLane({ state, holderProxyAlive, holderWorktree, ourWorktree });
}

function decideReuseByLane({ state, holderProxyAlive, holderWorktree, ourWorktree }) {
    if (state === 'WARM' && holderProxyAlive) {
        return { action: 'editor_busy', reason: 'HOLDER_PROXY_ALIVE_AMEND1' };
    }
    if (worktreeServes(ourWorktree, holderWorktree)) {
        return { action: 'handoff_reuse', reason: `${WT_MATCH_PREFIXES[state]}_WORKTREE_MATCH` };
    }
    // 形态 B corpse: the chain died halfway; a worktree match means the editor
    // may already be warm → adopt via connect receipt. No match → legacy
    // cleanup lane owns physical attribution.
    return { action: 'cold_start', reason: `${WT_MATCH_PREFIXES[state]}_WORKTREE_MISMATCH` };
}

// worktreeServes(ourWorktree, holderWorktree): the holder record provably
// serves this slot (equal or our slot nested under the holder root).
function worktreeServes(ourWorktree, holderWorktree) {
    return !!holderWorktree && !!ourWorktree
        && (holderWorktree === ourWorktree
            || holderWorktree.startsWith(ourWorktree + '/')
            || ourWorktree.startsWith(holderWorktree + '/'));
}

function decideWarm({ fresh, proxyAlive }) {
    if (fresh) {
        return proxyAlive
            ? { action: 'handoff_warm', reason: 'WARM_FRESH_LIVE_PROXY' }
            : { action: 'reclaim_dead', reason: 'WARM_FRESH_PROXY_DEAD' };
    }
    return proxyAlive
        ? { action: 'editor_busy', reason: 'WARM_STALE_LIVE_PROXY_AMEND1' }
        : { action: 'reclaim_dead', reason: 'WARM_STALE_PROXY_DEAD' };
}

function decideInFlight({ stName, fresh, proxyAlive }) {
    return (proxyAlive && fresh)
        ? { action: 'join_wait', reason: `${stName}_LIVE_PROXY_JOIN` }
        : { action: 'reclaim_dead', reason: `${stName}_PROXY_DEAD` };
}

function heartbeatFreshPure(heartbeatAt, nowMs, maxAgeMs) {
    if (!heartbeatAt) return false;
    const t = Date.parse(heartbeatAt);
    if (!Number.isFinite(t)) return false;
    return (nowMs - t) <= maxAgeMs;
}
