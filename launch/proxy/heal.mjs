// proxy/heal.mjs — SEE-1325 H1 embedded recovery round (extracted from
// godot-mcp-proxy.mjs, SEE-1334 Phase 0a): attribution → decision →
// stop-first/respawn, budget-booked inside the FAILED_EXIT window.
import { S } from './state.mjs';
import { FAILED_EXIT_MS, GODOT_PORT, RUNTIME_ID } from './config.mjs';
import { log, stageLog } from './log.mjs';
import {
    attributeHolder, decideRecoveryAction, planRecoveryBudget, RECOVERY_ROUND_WORST_MS,
} from '../see1325-recovery.mjs';
import {
    pidAlive, probeHolderCmdline, readHolderWorktree, readLeaseSidecar,
    resolveWorktreeForSpawn,
} from './worktree.mjs';
import { tcpProbe } from './probes.mjs';
import { ensureEditor, evictStaleHolder, handleSpawnFailure } from './spawn.mjs';

// SEE-1325 H1（§SPEC-002/003）：RECOVERING 内嵌恢复轮。复用 runScript/
// evictStaleHolder/ensureEditor 已有编排；判定全部走 see1325-recovery.mjs
// 纯函数。触发于冷（warmup timeout）与暖（editor_gone respawn）两分支入口；
// 预算口径 (a)：恢复轮在 FAILED_EXIT_MS 窗口内消耗，剩余不足单轮最坏耗时
// （RECOVERY_ROUND_WORST_MS）即记账前置终态，不再开轮。失败计入
// SPAWN_MAX_ATTEMPTS 连击通道（handleSpawnFailure 已统一计数）。

async function runRecoveryRound(trigger) {
    // 共用门：与 warmRespawnInFlight/spawnTriggered 互斥，防止恢复轮与
    // respawn 循环并发对同一端口做双 stop/double-spawn。
    if (S.warmRespawnInFlight) return false;
    S.warmRespawnInFlight = true;
    try {
        if (S.recoveryWindowStart === null) S.recoveryWindowStart = S.startedAt;
        const budget = planRecoveryBudget({ failedExitMs: FAILED_EXIT_MS, startedAt: S.recoveryWindowStart, now: Date.now() });
        if (!budget.canStartRound) {
            stageLog('RECOVERY_ROUND_SKIP', `reason=budget_exhausted remaining=${budget.remainingMs}ms round=${S.recoveryRound}`);
            log(`recovery: budget exhausted (remaining ${budget.remainingMs}ms < worst round ${RECOVERY_ROUND_WORST_MS}ms); giving up (记账前置终态).`);
            return false;
        }
        S.recoveryRound += 1;
        stageLog('RECOVERY_ROUND', `n=${S.recoveryRound}/${budget.maxRounds} remaining=${budget.remainingMs}ms trigger=${trigger}`);
        log(`recovery round ${S.recoveryRound}/${budget.maxRounds} (trigger=${trigger}, remaining=${budget.remainingMs}ms).`);
        // 归因先于二分（§SPEC-007）：文件 cross-check 主通道；PS 兜底 ≤2s。
        const lease = await readLeaseSidecar();
        const holderWorktree = await readHolderWorktree();
        const ourWorktree = await resolveWorktreeForSpawn();
        const holderPidAlive = lease?.proxy_pid ? pidAlive(Number(lease.proxy_pid)) : false;
        const psMatch = holderPidAlive ? await probeHolderCmdline(Number(lease.proxy_pid), ourWorktree) : null;
        const attr = attributeHolder({
            leaseRuntimeId: String(lease?.runtime_id || ''),
            ourRuntimeId: String(RUNTIME_ID || ''),
            registryWorktree: holderWorktree || '',
            holderWorktree: String(lease?.worktree || ''),
            ourWorktree,
            psCmdlineMatch: psMatch,
        });
        const portOpen = await tcpProbe();
        const decision = decideRecoveryAction({
            portOpen,
            holderProxyAlive: holderPidAlive,
            holderRuntimeId: attr.holderRuntimeId,
            ourRuntimeId: String(RUNTIME_ID || ''),
            leaseState: String(lease?.state || ''),
            releasedAt: lease?.released_at || null,
            holderIdentityReadable: attr.holderIdentityReadable,
        });
        stageLog('RECOVERY_DECISION', `action=${decision.action} reason=${decision.reason} channel=${attr.channel}`);
        if (decision.action === 'fail_fast') {
            log(`ERROR: recovery refused: ${decision.diagnostic}`);
            return false;
        }
        if (decision.action === 'takeover_wait') {
            // 活同 runtime proxy：沿用既有 takeover 等待语义，不做任何 stop。
            log('recovery: live same-runtime proxy holds the slot; deferring to takeover wait (no stop).');
            return false;
        }
        if (decision.action === 'stop_first') {
            stageLog('EMBEDDED_HEAL_BEGIN', `mode=stop_first port=${GODOT_PORT}`);
            await evictStaleHolder(holderWorktree);
            const stillOpen = await tcpProbe();
            stageLog('EMBEDDED_HEAL_CONFIRMED', `port_still_open=${stillOpen}`);
            if (stillOpen) {
                log('ERROR: recovery stop-first could not free the port after evict; refusing to double-spawn.');
                return false;
            }
            stageLog('EMBEDDED_HEAL_END', 'mode=stop_first ok=true');
        }
        // respawn（冷分支或 stop-first 清场后）：同端口重钉（GODOT_PORT 不变），
        // 走既有 ensureEditor 全链（prepare→configure→spawn 由其内部编排）。
        try {
            await ensureEditor(Date.now());
            return true;
        } catch (err) {
            // 自愈 spawn 失败同步计入 SPAWN_MAX_ATTEMPTS 连击通道。
            handleSpawnFailure(err);
            return false;
        }
    } finally {
        S.warmRespawnInFlight = false;
    }
}

export {
    runRecoveryRound,
};
