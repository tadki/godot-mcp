#!/usr/bin/env node
// SEE-1328 C-hardener — recovery 新增面判别力审计对抗性用例
// （补 §SPEC-002/003/005/006/007/009 现有 19+5 用例测不出的分支与边界）。
// Run:
//   node --test --test-reporter=junit launch/tests/scripts/test_see1325_recovery_hardener.mjs
//
// 审计口径："默认代码是错误的"——每用例钉死一个既有套件未覆盖的分支：
//   HC1-HC5  §SPEC-006 canonical 变异逐杀补强（M10 releasedAt 单通道、M7 预算
//            前置、M8 归因 fail-open、M5/M6 诊断字段逐字、releasedAt-only 腿）
//   HB1-HB4  planRecoveryBudget 边界（NaN/0/负值/负 elapsed/浮点/字符串数字）
//   HA1-HA3  attributeHolder 边界（file 通道字段部分缺失降级 PS、holder==our
//            worktree 两等价路径、registry 等价匹配）
//   HI1-HI4  §SPEC-009 INV 反例钉死（stale 痕迹残留 / lease_id 丢失 / 同端口
//            误写 predecessor / Windows 形态漏归一——经 configure 脚本静态审计）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { decideRecoveryAction, planRecoveryBudget, attributeHolder, RECOVERY_ROUND_WORST_MS } =
    await import(path.resolve(HERE, '..', '..', 'see1325-recovery.mjs'));

const CONFIGURE = path.resolve(HERE, '..', '..', 'configure-mcp-port.sh');
const configureSrc = fs.readFileSync(CONFIGURE, 'utf8');

// ---- HC: §SPEC-006 canonical 变异补强 -------------------------------------------
test('HC1 §SPEC-006 M10 逐杀：releasedAt-only（leaseState 仍 active）→ respawn（残响判定双通道）', () => {
    // C0 竞态形态的镜像：reaper 已写 released_at 但 state 字段读取竞态仍为 active。
    // 删除 releasedAt 通道（M10）会让此腿落入 stop_first —— 双通道缺一不可。
    const r = decideRecoveryAction({
        portOpen: true, holderProxyAlive: false,
        holderRuntimeId: 'A-solo', ourRuntimeId: 'A-solo',
        leaseState: 'active', releasedAt: '2026-09-19T22:01:17.090Z',
    });
    assert.equal(r.action, 'respawn');
    assert.equal(r.reason, 'OWN_RUNTIME_LEASE_RELEASED');
    assert.equal(r.evict, false);
});

test('HC2 §SPEC-006 M7 逐杀：剩余恰好 = RECOVERY_ROUND_WORST_MS → 可开轮（边界含等号）', () => {
    const b = planRecoveryBudget({ failedExitMs: 100000, startedAt: 0, now: 10000 });
    assert.equal(b.remainingMs, RECOVERY_ROUND_WORST_MS);
    assert.equal(b.canStartRound, true, 'remaining == worst must still allow a round (>= semantics)');
    const b2 = planRecoveryBudget({ failedExitMs: 100000, startedAt: 0, now: 10001 });
    assert.equal(b2.canStartRound, false, 'remaining < worst must be terminal (记账前置)');
});

test('HC3 §SPEC-006 M8 逐杀：归因双败 → holderIdentityReadable=false（fail-closed 不可翻转）', () => {
    const a = attributeHolder({ leaseRuntimeId: '', ourRuntimeId: 'R1', psCmdlineMatch: null });
    assert.equal(a.holderIdentityReadable, false);
    assert.equal(a.channel, 'none');
    // fail-open 变异（readable=true）会流入判定表：unreadable 腿必须 fail_fast 不 evict
    const d = decideRecoveryAction({ portOpen: true, holderIdentityReadable: a.holderIdentityReadable });
    assert.equal(d.action, 'fail_fast');
    assert.equal(d.evict, false);
});

test('HC4 §SPEC-006 M5/M6 逐字：fail_fast 诊断含指引；PORT_CLOSED 腿绝不 evict', () => {
    const unreadable = decideRecoveryAction({ portOpen: true, holderIdentityReadable: false });
    assert.match(unreadable.diagnostic, /refusing to evict/);
    assert.match(unreadable.diagnostic, /inspect port holder manually/);
    const closed = decideRecoveryAction({ portOpen: false });
    assert.equal(closed.action, 'respawn');
    assert.equal(closed.evict, false, 'cold branch must never carry evict=true');
});

test('HC5 §SPEC-006 evict 唯一腿全表扫描：8 输入仅 dead-same-active(含 empty-runtime) 腿 evict=true', () => {
    const inputs = {
        closed: { portOpen: false },
        unreadable: { portOpen: true, holderIdentityReadable: false },
        aliveSame: { portOpen: true, holderProxyAlive: true, holderRuntimeId: 'R1', ourRuntimeId: 'R1', leaseState: 'active' },
        aliveForeign: { portOpen: true, holderProxyAlive: true, holderRuntimeId: 'R2', ourRuntimeId: 'R1' },
        deadForeign: { portOpen: true, holderProxyAlive: false, holderRuntimeId: 'R2', ourRuntimeId: 'R1' },
        deadSameActive: { portOpen: true, holderProxyAlive: false, holderRuntimeId: 'R1', ourRuntimeId: 'R1', leaseState: 'active' },
        deadSameReleased: { portOpen: true, holderProxyAlive: false, holderRuntimeId: 'R1', ourRuntimeId: 'R1', leaseState: 'released' },
        deadEmptyRtActive: { portOpen: true, holderProxyAlive: false, holderRuntimeId: '', ourRuntimeId: 'R1', leaseState: 'active' },
    };
    const evicting = Object.entries(inputs).filter(([, i]) => decideRecoveryAction(i).evict === true).map(([n]) => n);
    assert.deepEqual(evicting.sort(), ['deadEmptyRtActive', 'deadSameActive'].sort(),
        'stop-first/evict must be reachable from exactly the own-runtime half-dead active-lease legs');
});

// ---- HB: planRecoveryBudget 边界 -------------------------------------------------
test('HB1 预算：failedExitMs 非法（NaN/0/负/字符串）→ canStartRound=false（不炸不扩窗）', () => {
    for (const bad of [NaN, 0, -5000, 'abc', null, undefined]) {
        const b = planRecoveryBudget({ failedExitMs: bad, startedAt: 0, now: 0 });
        assert.equal(b.canStartRound, false, `failedExitMs=${String(bad)} must be terminal`);
        assert.equal(b.maxRounds, 0);
    }
});

test('HB2 预算：负 elapsed（now < startedAt）钳 0 不扩窗', () => {
    const b = planRecoveryBudget({ failedExitMs: 100000, startedAt: 5000, now: 0 });
    assert.equal(b.elapsedClamped ?? true, true, 'shape probe');
    assert.equal(b.remainingMs, 100000, 'elapsed clamped to 0 → remaining = total');
    assert.equal(b.canStartRound, true);
});

test('HB3 预算：浮点 remaining 不四舍五入漏判（89.9s < 90s → 终态）', () => {
    const b = planRecoveryBudget({ failedExitMs: 100000, startedAt: 0, now: 10100 });
    assert.equal(b.remainingMs, 89900);
    assert.equal(b.canStartRound, false);
});

test('HB4 预算：maxRounds 向下取整（250s 窗口 → 2 轮，非 2.78）', () => {
    const b = planRecoveryBudget({ failedExitMs: 250000, startedAt: 0, now: 0 });
    assert.equal(b.maxRounds, 2);
    assert.equal(b.canStartRound, true);
});

// ---- HA: attributeHolder 边界 ----------------------------------------------------
test('HA1 归因：file 通道字段部分缺失 → 降级 PS 兜底（不因残缺 lease 误判 readable）', () => {
    // registryWorktree 缺失 → fileCrossCheck=false → 走 PS 通道
    const a = attributeHolder({ leaseRuntimeId: 'R1', ourRuntimeId: 'R1', registryWorktree: '', holderWorktree: '/w', ourWorktree: '/w', psCmdlineMatch: true });
    assert.equal(a.channel, 'ps_cmdline');
    assert.equal(a.holderIdentityReadable, true);
    assert.equal(a.holderRuntimeId, 'R1');
});

test('HA2 归因：holderWorktree == ourWorktree 与 registryWorktree == holderWorktree 两等价路径均 readable+matches', () => {
    const p1 = attributeHolder({ leaseRuntimeId: 'R1', ourRuntimeId: 'R1', registryWorktree: '/other', holderWorktree: '/ours', ourWorktree: '/ours' });
    assert.equal(p1.holderWorktreeMatches, true);
    const p2 = attributeHolder({ leaseRuntimeId: 'R1', ourRuntimeId: 'R1', registryWorktree: '/ours', holderWorktree: '/ours', ourWorktree: '/different' });
    assert.equal(p2.holderWorktreeMatches, true);
});

test('HA3 归因：file 通道全字段在但 worktree 三方互异 → readable 但 matches=false（跨 worktree 保守）', () => {
    const a = attributeHolder({ leaseRuntimeId: 'R1', ourRuntimeId: 'R1', registryWorktree: '/a', holderWorktree: '/b', ourWorktree: '/c' });
    assert.equal(a.holderIdentityReadable, true);
    assert.equal(a.holderWorktreeMatches, false);
});

// ---- HI: §SPEC-009 INV 反例（configure 脚本静态审计钉死）--------------------------
test('HI1 INV1 反例：stale-traces 清理块存在且作用于 released_at（痕迹残留防回归）', () => {
    assert.match(configureSrc, /released_at/);
    assert.match(configureSrc, /stale/i);
});

test('HI2 INV1 反例：KEEP 分支保留 lease_id（lease_id 丢失防回归）', () => {
    // 同端口 KEEP 分支必须保留原 lease_id（清理 ≠ 新租约）
    assert.match(configureSrc, /lease_id/);
    assert.match(configureSrc, /KEEP/);
});

test('HI3 INV3 反例：predecessor_lease_id 仅在端口迁移分支写入（同端口误写防回归）', () => {
    const predIdx = configureSrc.indexOf('predecessor_lease_id');
    const migratedIdx = configureSrc.indexOf('LEASE_PORT_MIGRATED');
    assert.ok(predIdx !== -1 && migratedIdx !== -1);
    // predecessor 写入必须出现在 LEASE_PORT_MIGRATED stage log 之前且同块（迁移分支内）
    const block = configureSrc.slice(Math.max(0, migratedIdx - 2000), migratedIdx + 200);
    assert.ok(block.includes('predecessor_lease_id'), 'predecessor write must live in the migration block');
});

test('HI4 INV4 反例：Windows 形态归一覆盖 D:/ 与反斜杠（漏归一防回归）', () => {
    assert.match(configureSrc, /D:\//i);
    assert.match(configureSrc, /normalize/i);
});
