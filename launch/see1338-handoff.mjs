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
export function decideHandoffAction({ disk, holderProxy = null, nowMs = Date.now(), opts = {} } = {}) {
    const { heartbeatMaxAgeMs = 10 * 60 * 1000 } = opts;
    const st = disk && disk.ok ? disk.state : null;
    if (!st) return { action: 'cold_start', reason: `NO_STATE:${disk ? disk.reason : 'no-input'}` };

    const stName = String(st.state || '');
    const proxyAlive = isProxyAlive(holderProxy);

    if (stName === 'FAILED_CLEAN') return { action: 'cold_start', reason: 'FAILED_CLEAN_REENTRANT' };

    const fresh = heartbeatFreshPure(st.heartbeat_at, nowMs, heartbeatMaxAgeMs);

    if (stName === 'WARM') {
        return decideWarm({ fresh, proxyAlive });
    }
    if (stName === 'WARMING' || stName === 'RECOVERING') {
        return decideInFlight({ stName, fresh, proxyAlive });
    }
    if (stName === 'COLD') return { action: 'cold_start', reason: 'COLD_RECORD' };
    return { action: 'cold_start', reason: `UNKNOWN_STATE:${stName}` };
}

function isProxyAlive(holderProxy) {
    return !!(holderProxy && holderProxy.pid
        && (holderProxy.verified === true
            || (holderProxy.verified !== false && holderProxy.alive !== false)));
}

function decideWarm({ fresh, proxyAlive }) {
    if (fresh) {
        if (proxyAlive) return { action: 'handoff_warm', reason: 'WARM_FRESH_LIVE_PROXY' };
        return { action: 'reclaim_dead', reason: 'WARM_FRESH_PROXY_DEAD' };
    }
    if (proxyAlive) return { action: 'editor_busy', reason: 'WARM_STALE_LIVE_PROXY_AMEND1' };
    return { action: 'reclaim_dead', reason: 'WARM_STALE_PROXY_DEAD' };
}

function decideInFlight({ stName, fresh, proxyAlive }) {
    if (proxyAlive && fresh) {
        return { action: 'join_wait', reason: `${stName}_LIVE_PROXY_JOIN` };
    }
    return { action: 'reclaim_dead', reason: `${stName}_PROXY_DEAD` };
}

function heartbeatFreshPure(heartbeatAt, nowMs, maxAgeMs) {
    if (!heartbeatAt) return false;
    const t = Date.parse(heartbeatAt);
    if (!Number.isFinite(t)) return false;
    return (nowMs - t) <= maxAgeMs;
}
