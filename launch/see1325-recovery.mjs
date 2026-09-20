// SEE-1325 阶段三 H1 — RECOVERING 内嵌恢复轮纯决策函数（§SPEC-002/003/004/005/007）。
//
// 设计约束（派单 + gqt 勘误）：函数 <50 行 / cc≤6；mock seam 由入参注入；
// 调用方（proxy.mjs runRecoveryRound）只做 IO 编排，判定全部在这里。
//
// 三个纯函数：
//   1. decideRecoveryAction(input) — 三支判定表（§SPEC-005）。
//   2. planRecoveryBudget(state)   — 预算记账口径 (a)（§SPEC-003）。
//   3. attributeHolder(input)      — 归因通道（§SPEC-007），文件 cross-check 主，
//      PS 兜底结果作为入参传入（本模块不做 IO）。
//
// C0 实测输入（§SPEC-001 未闭合实锤）：误判根因 = configure 快路径健康结论
// vs 其触发的异步 reaper stale 释放在同一 spawn 窗口内竞态。恢复轮的预算
// 与判定均以"健康度先行"为原则——先核 editor 端口 + lease 释放痕迹，
// 再决定 stop-first 或等待，绝不信快路径的历史结论。

// 单轮完整自愈链最坏耗时实测总和（§SPEC-004）：
//   stop（自有 stop-godot-editor 实测 ~2s）+ /dev/tcp 二次确认（≤3s 窗口）
//   + configure 快路径（0.3s）+ editor 冷启动 boot（C0 实测 45s，最坏 60s）
//   + warm 握手（C0 实测 ~10s）+ reaper 窗口翻转防护余量（重写 stale-traces
//   后 editor 读到的一定是 fresh lease，无 120s grace 等待）
//   ⇒ 实测总和 ≈ 75.3s，单轮最坏取 90s。FAILED_EXIT_MS 默认须 ≥ 90s × 1 轮
//   + 原 warmup 300s 窗口（窗口即总预算，恢复轮在 FAILED_EXIT_MS 内消耗）。
export const RECOVERY_ROUND_WORST_MS = 90000;

// 三支判定表（§SPEC-005）：
//   'takeover_wait'   — 活 proxy（holder PID 存活 + 同 runtime）：takeover 窗口等待
//   'stop_first'      — 自有 runtime half-dead（holder PID 死 or 健康度判定不健康）：
//                        自有 stop → /dev/tcp 二次确认 → KOL_CONFIGURE_SYNC_REAPER=1 → 同端口 respawn
//   'fail_fast'       — 跨 runtime 或身份不可读：fail-fast 不 evict，诊断含原端口/holder/下一步指引
export function decideRecoveryAction(input) {
    const {
        portOpen = false,
        holderProxyAlive = false,
        holderRuntimeId = '',
        ourRuntimeId = '',
        leaseState = '',
        releasedAt = null,
        holderIdentityReadable = true,
    } = input;
    // 端口未开：无 holder 可谈，直接 respawn（冷分支，恢复轮的常规起点）
    if (!portOpen) return { action: 'respawn', reason: 'PORT_CLOSED', evict: false };
    // 归因不可读（文件 cross-check 失败 + PS 兜底失败）：fail-closed 不 evict（§SPEC-007）
    if (!holderIdentityReadable) {
        return { action: 'fail_fast', reason: 'HOLDER_IDENTITY_UNREADABLE', evict: false,
            diagnostic: 'port holder identity unreadable (lease cross-check + PS cmdline both failed); refusing to evict — inspect port holder manually, then retry or re-pin the port' };
    }
    const sameRuntime = holderRuntimeId !== '' && holderRuntimeId === ourRuntimeId;
    if (holderProxyAlive && sameRuntime) {
        // 活 proxy + 同 runtime：自有会话活着，takeover 等待（绝不 stop）
        return { action: 'takeover_wait', reason: 'LIVE_PROXY_SAME_RUNTIME', evict: false };
    }
    if (holderProxyAlive || (holderRuntimeId !== '' && !sameRuntime)) {
        // 活/死 proxy + 跨 runtime：不是本 runtime 的持有物，fail-fast 不 evict（保守）
        const life = holderProxyAlive ? 'LIVE' : 'DEAD';
        return {
            action: 'fail_fast', reason: `${life}_PROXY_FOREIGN_RUNTIME`, evict: false,
            diagnostic: `port held by a ${life.toLowerCase()} proxy of foreign runtime ${holderRuntimeId} (ours: ${ourRuntimeId || '?'}) — not ours to evict from this runtime;${holderProxyAlive ? ' wait for its release or use a different port' : " run the holder's own stop helper or its reaper"}`,
        };
    }
    // 死 proxy + 同 runtime（或 runtime 空 = legacy sidecar）：自有 half-dead。
    // 健康度先行：lease 已带释放痕迹 → 端口是残响，直接 respawn；无痕迹
    // （C0 竞态形态：active + proxy_pid 死）→ stop-first 清场。
    if (leaseState === 'released' || releasedAt) {
        return { action: 'respawn', reason: 'OWN_RUNTIME_LEASE_RELEASED', evict: false };
    }
    return { action: 'stop_first', reason: 'OWN_RUNTIME_HALF_DEAD_ACTIVE_LEASE', evict: true };
}

// 预算记账口径 (a)（§SPEC-003）：恢复轮预算在 FAILED_EXIT_MS 窗口内消耗，
// 窗口即总预算；记账前置——剩余不足单轮最坏耗时（RECOVERY_ROUND_WORST_MS）
// 即直接终态；env 可调不扩窗（窗口由调用方传入，本函数不读 env）。
export function planRecoveryBudget({ failedExitMs, startedAt, now }) {
    const total = Number(failedExitMs) || 0;
    const elapsed = Math.max(0, now - startedAt);
    const remaining = Math.max(0, total - elapsed);
    const maxRounds = total > 0 ? Math.floor(total / RECOVERY_ROUND_WORST_MS) : 0;
    return {
        totalMs: total,
        remainingMs: remaining,
        // 剩余不足单轮最坏耗时 → 不再启动新一轮（记账前置），返回 terminal
        canStartRound: remaining >= RECOVERY_ROUND_WORST_MS,
        maxRounds,
        roundWorstMs: RECOVERY_ROUND_WORST_MS,
    };
}

// 归因通道（§SPEC-007）：文件 cross-check（lease runtime_id/proxy_pid + port
// registry worktree 匹配）为主通道；PS PID→cmdline（≤2s，调用方执行）结果作为
// psCmdlineMatch 传入。归因先于二分——先定身份再选动作。
// 返回 { holderIdentityReadable, holderRuntimeId, holderWorktreeMatches }。
export function attributeHolder({ leaseRuntimeId = '', ourRuntimeId = '', registryWorktree = '', holderWorktree = '', ourWorktree = '', psCmdlineMatch = null }) {
    const fileCrossCheck = leaseRuntimeId !== '' && registryWorktree !== '' && holderWorktree !== '';
    if (fileCrossCheck) {
        return {
            holderIdentityReadable: true,
            holderRuntimeId: leaseRuntimeId,
            holderWorktreeMatches: holderWorktree === ourWorktree || registryWorktree === holderWorktree,
            channel: 'file_cross_check',
        };
    }
    // PS 兜底（≤2s 由调用方保证超时）：cmdline 匹配本 worktree 目录名 → 可读同 runtime
    if (psCmdlineMatch === true) {
        return { holderIdentityReadable: true, holderRuntimeId: ourRuntimeId, holderWorktreeMatches: true, channel: 'ps_cmdline' };
    }
    if (psCmdlineMatch === false) {
        // PS 明确说不是我们的进程 → 身份可读但跨 runtime（可能 legacy）
        return { holderIdentityReadable: true, holderRuntimeId: leaseRuntimeId || 'unknown-legacy', holderWorktreeMatches: false, channel: 'ps_cmdline' };
    }
    // 双通道全败：fail-closed
    return { holderIdentityReadable: false, holderRuntimeId: '', holderWorktreeMatches: false, channel: 'none' };
}
