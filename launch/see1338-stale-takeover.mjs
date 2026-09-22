// SEE-1338 spec v2.1 — stale-holder classification (pure, no IO).
//
// Classification precedes any takeover/cleanup action. AMEND-1 (Atlas,
// frozen): a WARM/stale record must NEVER be cleaned up while its owning
// proxy is verifiably ALIVE — "前任在管" wins over staleness, and a live
// foreign editor is never touched (T10 mirror: 物理活不盲杀, §4.2). Only a
// DEAD holder's residue is takeoverable: its orphaned editor is evicted so
// the next spawn can run against a clean slate.
//
//   free     — no held record; nothing to classify (port may still be bound
//              by an unregistered stray — callers treat as foreign, no kill)
//   own      — the held pid IS this proxy (our own editor/round):
//              cleanup allowed and expected (R2 force restart, eviction)
//   busy     — holder proxy ALIVE (foreign or same-runtime）：never cleaned,
//              never killed; callers must surface a clean retryable
//              editor_busy instead (spec §4.2 AMEND-1 branch)
//   takeover — holder proxy DEAD (pid dead / exe mismatch = PID-reuse
//              treated as dead): its editor may linger as an orphan →
//              caller evicts (stop editor + reap) and cold-starts.
export function decideStaleProxyAction({ holderPid = null, ourPid = null, holderAlive = null }) {
    if (!Number.isInteger(holderPid) || holderPid <= 0) {
        return { action: 'free', reason: 'NO_HELD_PROXY', pid: holderPid };
    }
    if (ourPid !== null && holderPid === ourPid) {
        return { action: 'own', reason: 'SELF_RUNTIME_PROXY', pid: holderPid };
    }
    return holderAlive === true
        ? { action: 'busy', reason: 'HOLDER_PROXY_ALIVE_AMEND1', pid: holderPid }
        : { action: 'takeover', reason: 'HOLDER_PROXY_DEAD_RESIDUE', pid: holderPid };
}
