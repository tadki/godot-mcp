// SEE-1325 H1 — see1325-recovery.mjs 纯决策函数参数化单测（§SPEC-002/003/004/005/007）。
// Run: node --test --test-reporter=junit launch/tests/scripts/test_see1325_recovery.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE = path.join(__dirname, '..', '..', 'see1325-recovery.mjs');
const MOD_EXISTS = fs.existsSync(MODULE);
const { decideRecoveryAction, planRecoveryBudget, attributeHolder, RECOVERY_ROUND_WORST_MS } = MOD_EXISTS
    ? await import(MODULE)
    : {};

const fail = (name) => assert.fail(`RED: see1325-recovery.mjs 未实现（TDD RED 套件先行）— ${name}`);

// ---- §SPEC-005 三支判定表 -------------------------------------------------------
test('§SPEC-005 T1 端口未开 → respawn（冷分支，不 evict）', () => {
    if (!MOD_EXISTS) return fail('decideRecoveryAction');
    const r = decideRecoveryAction({ portOpen: false, holderProxyPid: 5, holderProxyAlive: true, holderRuntimeId: 'X-solo', ourRuntimeId: 'A-solo' });
    assert.equal(r.action, 'respawn');
    assert.equal(r.evict, false);
});

test('§SPEC-005 T2 活 proxy + 同 runtime → takeover_wait（绝不 stop）', () => {
    if (!MOD_EXISTS) return fail('decideRecoveryAction');
    const r = decideRecoveryAction({ portOpen: true, holderProxyAlive: true, holderRuntimeId: 'A-solo', ourRuntimeId: 'A-solo' });
    assert.equal(r.action, 'takeover_wait');
    assert.equal(r.evict, false);
});

test('§SPEC-005 T3 活 proxy + 跨 runtime → fail_fast 不 evict，诊断含双 runtime', () => {
    if (!MOD_EXISTS) return fail('decideRecoveryAction');
    const r = decideRecoveryAction({ portOpen: true, holderProxyAlive: true, holderRuntimeId: 'B-solo', ourRuntimeId: 'A-solo' });
    assert.equal(r.action, 'fail_fast');
    assert.equal(r.evict, false);
    assert.ok(r.diagnostic.includes('B-solo') && r.diagnostic.includes('A-solo'));
});

test('§SPEC-005 T4 死 proxy + 跨 runtime → fail_fast 不 evict（保守）', () => {
    if (!MOD_EXISTS) return fail('decideRecoveryAction');
    const r = decideRecoveryAction({ portOpen: true, holderProxyAlive: false, holderRuntimeId: 'B-solo', ourRuntimeId: 'A-solo' });
    assert.equal(r.action, 'fail_fast');
    assert.equal(r.evict, false);
});

test('§SPEC-005 T5 死 proxy + 同 runtime + lease active 无痕迹（C0 竞态形态）→ stop_first', () => {
    if (!MOD_EXISTS) return fail('decideRecoveryAction');
    const r = decideRecoveryAction({ portOpen: true, holderProxyAlive: false, holderRuntimeId: 'A-solo', ourRuntimeId: 'A-solo', leaseState: 'active', releasedAt: null });
    assert.equal(r.action, 'stop_first');
    assert.equal(r.evict, true, 'own-runtime half-dead with active lease = the ONLY evict leg');
});

test('§SPEC-005 T6 死 proxy + 同 runtime + lease released（残响端口）→ respawn 不 stop', () => {
    if (!MOD_EXISTS) return fail('decideRecoveryAction');
    const r = decideRecoveryAction({ portOpen: true, holderProxyAlive: false, holderRuntimeId: 'A-solo', ourRuntimeId: 'A-solo', leaseState: 'released', releasedAt: '2026-09-19T22:01:17Z' });
    assert.equal(r.action, 'respawn');
    assert.equal(r.evict, false);
});

test('§SPEC-007 归因不可读（文件 + PS 双败）→ fail_fast 不 evict（fail-closed）', () => {
    if (!MOD_EXISTS) return fail('decideRecoveryAction');
    const r = decideRecoveryAction({ portOpen: true, holderIdentityReadable: false });
    assert.equal(r.action, 'fail_fast');
    assert.equal(r.evict, false);
    assert.ok(r.diagnostic.includes('unreadable'));
});

// ---- §SPEC-006 stop-first 唯一性 -------------------------------------------------
test('§SPEC-006 stop-first/evict 仅出现在「自有 runtime half-dead active lease」一腿', () => {
    if (!MOD_EXISTS) return fail('decideRecoveryAction');
    const cases = [
        { portOpen: false },
        { portOpen: true, holderProxyAlive: true, holderRuntimeId: 'A-solo', ourRuntimeId: 'A-solo' },
        { portOpen: true, holderProxyAlive: true, holderRuntimeId: 'B-solo', ourRuntimeId: 'A-solo' },
        { portOpen: true, holderProxyAlive: false, holderRuntimeId: 'B-solo', ourRuntimeId: 'A-solo' },
        { portOpen: true, holderProxyAlive: false, holderRuntimeId: 'A-solo', ourRuntimeId: 'A-solo', leaseState: 'released', releasedAt: 'x' },
        { portOpen: true, holderIdentityReadable: false },
    ];
    for (const c of cases) {
        const r = decideRecoveryAction(c);
        assert.equal(r.evict, false, `evict must be false for ${JSON.stringify(c).slice(0, 80)}`);
        assert.notEqual(r.action, 'stop_first');
    }
});

// ---- §SPEC-003 预算口径 (a) -------------------------------------------------------
test('§SPEC-003 B1 剩余充足 → 可开轮，remaining 正确', () => {
    if (!MOD_EXISTS) return fail('planRecoveryBudget');
    const p = planRecoveryBudget({ failedExitMs: 390000, startedAt: 0, now: 300000 });
    assert.equal(p.remainingMs, 90000);
    assert.equal(p.canStartRound, true, 'remaining == worst round exactly → allowed (boundary)');
    assert.equal(p.maxRounds, 4);
});

test('§SPEC-003 B2 剩余不足单轮最坏耗时 → 记账前置终态', () => {
    if (!MOD_EXISTS) return fail('planRecoveryBudget');
    const p = planRecoveryBudget({ failedExitMs: 390000, startedAt: 0, now: 300001 });
    assert.equal(p.canStartRound, false, 'remaining 89999ms < worst 90000ms → terminal, no new round');
});

test('§SPEC-003 B3 窗口耗尽 → 终态且不越窗', () => {
    if (!MOD_EXISTS) return fail('planRecoveryBudget');
    const p = planRecoveryBudget({ failedExitMs: 390000, startedAt: 0, now: 400000 });
    assert.equal(p.remainingMs, 0);
    assert.equal(p.canStartRound, false);
});

test('§SPEC-003 B4 越窗不扩：elapsed 超 total 时 remaining 钳到 0（env 可调不扩窗语义）', () => {
    if (!MOD_EXISTS) return fail('planRecoveryBudget');
    const p = planRecoveryBudget({ failedExitMs: 100000, startedAt: 0, now: 250000 });
    assert.equal(p.remainingMs, 0);
    assert.equal(p.canStartRound, false);
});

// ---- §SPEC-004 默认值口径 ---------------------------------------------------------
test('§SPEC-004 RECOVERY_ROUND_WORST_MS ≥ C0 实测单轮链总和（75.3s 实测 → 90s 上取）', () => {
    if (!MOD_EXISTS) return fail('RECOVERY_ROUND_WORST_MS');
    // C0 实测总和：stop ~2s + 确认 ≤3s + configure 0.3s + boot 60s + warm 10s ≈ 75.3s
    assert.ok(RECOVERY_ROUND_WORST_MS >= 75300, `worst round ${RECOVERY_ROUND_WORST_MS}ms must cover the measured chain (75.3s)`);
});

test('§SPEC-004 FAILED_EXIT_MS 默认口径：常量文档值 ≥ 300s warmup + ≥1 轮 worst', () => {
    if (!MOD_EXISTS) return fail('RECOVERY_ROUND_WORST_MS');
    // proxy 默认 = 2×COLD_WARMUP_TIMEOUT_MS = 600s ≥ 300s + 90s ✓；此处钉模块侧口径
    assert.ok(300000 + RECOVERY_ROUND_WORST_MS <= 600000, '2xCOLD(600s) covers warmup(300s) + one worst round(90s)');
});

// ---- §SPEC-007 归因通道 ------------------------------------------------------------
test('§SPEC-007 A1 文件 cross-check 主通道（lease runtime_id + registry + holder worktree 全在）→ readable', () => {
    if (!MOD_EXISTS) return fail('attributeHolder');
    const a = attributeHolder({ leaseRuntimeId: 'A-solo', ourRuntimeId: 'A-solo', registryWorktree: '/wt', holderWorktree: '/wt', ourWorktree: '/wt' });
    assert.equal(a.holderIdentityReadable, true);
    assert.equal(a.channel, 'file_cross_check');
    assert.equal(a.holderRuntimeId, 'A-solo');
});

test('§SPEC-007 A2 文件通道缺失 → PS cmdline 命中兜底', () => {
    if (!MOD_EXISTS) return fail('attributeHolder');
    const a = attributeHolder({ leaseRuntimeId: '', psCmdlineMatch: true, ourRuntimeId: 'A-solo' });
    assert.equal(a.holderIdentityReadable, true);
    assert.equal(a.channel, 'ps_cmdline');
});

test('§SPEC-007 A3 双通道全败 → fail-closed 不可读', () => {
    if (!MOD_EXISTS) return fail('attributeHolder');
    const a = attributeHolder({ leaseRuntimeId: '', psCmdlineMatch: null });
    assert.equal(a.holderIdentityReadable, false);
    assert.equal(a.channel, 'none');
});

test('§SPEC-007 A4 PS 明确非本进程 → 可读但跨 runtime（legacy 形态）', () => {
    if (!MOD_EXISTS) return fail('attributeHolder');
    const a = attributeHolder({ leaseRuntimeId: '', psCmdlineMatch: false, ourRuntimeId: 'A-solo' });
    assert.equal(a.holderIdentityReadable, true);
    assert.notEqual(a.holderRuntimeId, 'A-solo');
});

// ---- 设计约束：函数行数 / 导出面 ----------------------------------------------------
test('设计约束：三个导出函数各 <50 行（行数审计）', () => {
    if (!MOD_EXISTS) return fail('source audit');
    const src = fs.readFileSync(MODULE, 'utf8');
    const fnNames = ['decideRecoveryAction', 'planRecoveryBudget', 'attributeHolder'];
    for (const name of fnNames) {
        const m = src.match(new RegExp(`export function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}`));
        assert.ok(m, `${name} found`);
        const lines = m[1].split('\n').length;
        assert.ok(lines < 50, `${name} body ${lines} lines must be <50`);
    }
});
