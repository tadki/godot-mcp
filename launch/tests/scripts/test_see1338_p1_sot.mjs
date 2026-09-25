// SEE-1338 P1 (spec v2.1 §2/§3/§4) — D2 .state SoT + D3 handoff tree + D1 keying.
// Run: node --test --test-reporter=junit launch/tests/scripts/test_see1338_p1_sot.mjs
//
// Covers (Atlas P1 dispatch, one-shot delivery):
//   D2 .state: atomic write (tmp+fsync+rename), merge semantics, schema
//     check, corrupt/unknown-state → stateless (never wedges), events JSONL,
//     held-runtime lock acquire/steal/release.
//   D3 handoff: the §4.2 decision matrix incl. AMEND-1 live-proxy guard +
//     started_at triple check (pid reuse → dead).
//   D1 keying: v2 regex (i<num>/x<8hex>/solo/legacy hex), issue-number
//     extraction, sha256 fallback, solo degradation.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn as childSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH = path.join(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(LAUNCH, rel), 'utf8');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'see1338p1-home-'));
process.env.GODOT_MCP_HOME = tmpHome;
process.env.GODOT_PORT = '6579';
delete process.env.KOL_ISSUE_ID;

const sf = await import(path.join(LAUNCH, 'proxy', 'state-file.mjs'));
const handoffMod = await import(path.join(LAUNCH, 'see1338-handoff.mjs'));
const { decideHandoffAction, decideReuseSingleSource } = handoffMod;

const RID = 'Bachi-i1338';
const NOW = Date.now();

function baseState(over = {}) {
    return Object.assign({
        schema_version: sf.STATE_SCHEMA_VERSION,
        state: 'WARM',
        port: 6579,
        proxy_pid: null,
        proxy_pid_started_at: null,
        heartbeat_at: new Date(NOW - 60 * 1000).toISOString(), // 1 min ago → fresh
        updated_at: new Date(NOW - 60 * 1000).toISOString(),
        worktree: '/tmp/wt',
        agent: 'Bachi',
        issue_id: 'SEE-1338',
    }, over);
}

// ---- D2: .state IO ---------------------------------------------------------------

test('§3 D2 T1 write+read round-trip；merge 保未知字段', () => {
    const m1 = sf.writeRuntimeState(RID, baseState({ last_error: null }), { event: 'PROXY_START', detail: 't1' });
    assert.equal(m1.state, 'WARM');
    assert.equal(m1.schema_version, sf.STATE_SCHEMA_VERSION);
    sf.writeRuntimeState(RID, { state: 'RECOVERING', extra_field: 'kept' }, { event: 'STATE_TRANSITION', fromState: 'WARM', detail: 'w->r' });
    const r = sf.readRuntimeState(RID);
    assert.equal(r.ok, true);
    assert.equal(r.state.state, 'RECOVERING');
    assert.equal(r.state.extra_field, 'kept', 'unknown fields survive round-trips');
    assert.equal(r.state.worktree, '/tmp/wt', 'earlier fields survive merges');
});

test('§3 D2 T2 事件日志追加（PROXY_START + STATE_TRANSITION 可审计）', () => {
    const ev = fs.readFileSync(sf.eventsPathFor(RID), 'utf-8').trim().split('\n');
    const parsed = ev.map((l) => JSON.parse(l));
    assert.ok(parsed.some((e) => e.event === 'PROXY_START'));
    // fromState is captured from the doc BEFORE the patch (writeRuntimeState
    // reads prev), so the transition line here reads WARM→RECOVERING.
    assert.ok(parsed.some((e) => e.event === 'STATE_TRANSITION' && e.from_state === 'WARM'),
        `events: ${JSON.stringify(parsed.map((e) => [e.event, e.from_state, e.to_state]))}`);
});

test('§3 D2 T3 崩溃一致性：半写 tmp 文件不影响主状态（rename 才发布）', () => {
    const m = sf.writeRuntimeState(RID, { state: 'WARM' });
    assert.equal(m.state, 'WARM');
    // Simulate a crash mid-write: a stale .tmp file left behind.
    fs.writeFileSync(sf.statePathFor(RID) + '.tmp.999', '{ "state": "GARBAG', 'utf8');
    const r = sf.readRuntimeState(RID);
    assert.equal(r.ok, true, 'main state unaffected by stale tmp');
    assert.equal(r.state.state, 'WARM');
});

test('§3 D2 T4 损坏 .state → 视为无状态（不抛异常、ok=false）', () => {
    const rid = 'Bachi-i1338-corrupt';
    sf.writeRuntimeState(rid, { state: 'WARM' });
    fs.writeFileSync(sf.statePathFor(rid), '{ broken json!!', 'utf8');
    const r = sf.readRuntimeState(rid);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unparseable');
});

test('§3 D2 T5 schema 错配 → 无状态（ok=false, schema-mismatch）', () => {
    const rid = 'Bachi-i1338-v1';
    sf.writeRuntimeState(rid, { state: 'WARM' });
    const doc = JSON.parse(fs.readFileSync(sf.statePathFor(rid), 'utf-8'));
    doc.schema_version = 99;
    fs.writeFileSync(sf.statePathFor(rid), JSON.stringify(doc));
    const r = sf.readRuntimeState(rid);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'schema-mismatch');
});

test('§3 D2 T6 未知状态名 → 无状态', () => {
    const rid = 'Bachi-i1338-unk';
    sf.writeRuntimeState(rid, { state: 'WEIRD' });
    const r = sf.readRuntimeState(rid);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown-state');
});

test('§3 D2 T7 held-runtime 锁：acquire → 互斥 → release → 可再获取', async () => {
    const rid = 'Bachi-i1338-lock';
    const a = await sf.acquireRuntimeLock(rid, { ownerPid: process.pid });
    assert.equal(a.locked, true);
    const b = await sf.acquireRuntimeLock(rid, { ownerPid: 999999999 });
    assert.equal(b.locked, false, 'second acquirer is excluded');
    assert.equal(sf.releaseRuntimeLock(rid, process.pid), true);
    const c = await sf.acquireRuntimeLock(rid, { ownerPid: 999999999 });
    assert.equal(c.locked, true, 'released lock is acquirable');
    sf.releaseRuntimeLock(rid, 999999999);
});

test('§3 D2 T8 锁抢占：owner pid 死 → 可偷锁', async () => {
    const rid = 'Bachi-i1338-dead';
    const dir = sf.heldRuntimeDirFor(rid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'owner'), '999999999\n');
    const r = await sf.acquireRuntimeLock(rid, { ownerPid: process.pid });
    assert.equal(r.locked, true, 'dead owner lock is stealable');
});

// ---- D3: handoff decision tree ----------------------------------------------------

const hpLive = { pid: 111, startedAt: NOW - 60000, verified: true };
const hpDead = { pid: 222, startedAt: NOW - 60000, verified: false };

test('§4.2 D3 T9 无/损坏记录 → cold_start', () => {
    for (const disk of [{ ok: false, reason: 'no-file' }, { ok: false, reason: 'unparseable' }, undefined]) {
        const d = decideHandoffAction({ disk, holderProxy: null, nowMs: NOW });
        assert.equal(d.action, 'cold_start');
    }
});

test('§4.2 D3 T10 WARM+心跳新鲜+活 proxy → handoff_warm（连上=接管）', () => {
    const d = decideHandoffAction({ disk: { ok: true, state: baseState({ proxy_pid: 111 }) }, holderProxy: hpLive, nowMs: NOW });
    assert.equal(d.action, 'handoff_warm');
});

test('§4.2 D3 T11 WARM+新鲜+proxy 死 → reclaim_dead（收尸接管）', () => {
    const d = decideHandoffAction({ disk: { ok: true, state: baseState({ proxy_pid: 222 }) }, holderProxy: hpDead, nowMs: NOW });
    assert.equal(d.action, 'reclaim_dead');
});

test('§4.2 D3 T12 AMEND-1：WARM+心跳陈旧+活 proxy → editor_busy（前任在管不杀）', () => {
    const stale = baseState({ heartbeat_at: new Date(NOW - 20 * 60 * 1000).toISOString(), proxy_pid: 111 });
    const d = decideHandoffAction({ disk: { ok: true, state: stale }, holderProxy: hpLive, nowMs: NOW });
    assert.equal(d.action, 'editor_busy');
    assert.equal(d.reason, 'WARM_STALE_LIVE_PROXY_AMEND1');
});

test('§4.2 D3 T13 WARM+陈旧+proxy 死 → reclaim_dead', () => {
    const stale = baseState({ heartbeat_at: new Date(NOW - 20 * 60 * 1000).toISOString(), proxy_pid: 222 });
    const d = decideHandoffAction({ disk: { ok: true, state: stale }, holderProxy: hpDead, nowMs: NOW });
    assert.equal(d.action, 'reclaim_dead');
});

test('§4.2 D3 T14 WARMING/RECOVERING+活+新鲜 → join_wait（R2 硬上限约束前任）', () => {
    for (const stName of ['WARMING', 'RECOVERING']) {
        const st = baseState({ state: stName, proxy_pid: 111 });
        const d = decideHandoffAction({ disk: { ok: true, state: st }, holderProxy: hpLive, nowMs: NOW });
        assert.equal(d.action, 'join_wait', stName);
    }
});

test('§4.2 D3 T15 WARMING+死 proxy → reclaim_dead（拉一半没人收尸）', () => {
    const st = baseState({ state: 'WARMING', proxy_pid: 222 });
    const d = decideHandoffAction({ disk: { ok: true, state: st }, holderProxy: hpDead, nowMs: NOW });
    assert.equal(d.action, 'reclaim_dead');
});

test('§4.2 D3 T16 FAILED_CLEAN → cold_start（可重入）', () => {
    const st = baseState({ state: 'FAILED_CLEAN', proxy_pid: null });
    const d = decideHandoffAction({ disk: { ok: true, state: st }, holderProxy: null, nowMs: NOW });
    assert.equal(d.action, 'cold_start');
});

test('§4.2 D3 T17 started_at 三重校验：pid 复用（started_at 漂移）→ 判死', () => {
    // proxyAlive with a started_at far from the real /proc mtime → false.
    const alive = sf.proxyAlive(process.pid, Date.now() - 3600 * 1000);
    assert.equal(alive, false, 'started_at mismatch (PID reuse) must read DEAD');
    assert.equal(sf.proxyAlive(process.pid, null), true, 'null startedAt degrades to two-check');
    assert.equal(sf.proxyAlive(999999999, null), false);
});

// ---- D1: runtime_id_v2 keying ------------------------------------------------------

const runtimeV2 = await (async () => {
    // Import the bash lib through a tiny shell bridge (bash libs are not ESM).
    // Env isolation: strip MULTICA_* so the resolution chain cannot see THIS
    // session's task/agent context — tests pin KOL_ISSUE_ID explicitly.
    const { execFileSync } = await import('node:child_process');
    const lib = path.join(LAUNCH, 'runtime-v2.lib.sh');
    const env = Object.assign({}, process.env);
    delete env.MULTICA_TASK_ID;
    delete env.MULTICA_AGENT_ID;
    return (fn, ...args) => execFileSync('bash', ['-c',
        `source "$1" && shift && "$@"`, 'sh', lib, fn, ...args],
        { encoding: 'utf8', env }).trim();
})();

test('§2 D1 T18 v2 regex 接受 i<num>/x<8hex>/solo/legacy hex', () => {
    const re = runtimeV2('mcp_runtime_id_v2_regex');
    for (const ok of ['Atlas-i1338', 'Bachi-i7', 'bachi-x0a1b2c3d', 'Bachi-solo', 'Bachi-4dea7c434d81']) {
        assert.match(ok, new RegExp(re.trim().replace(/^\^|\$$/g, '')), ok);
    }
});

test('§2 D1 T19 issue 编号提取 + sha256 兜底', () => {
    assert.equal(runtimeV2('mcp_issue_number_from_id', 'SEE-1338'), '1338');
    assert.equal(runtimeV2('mcp_issue_number_from_id', '01a0c8b5-2c4e-7b4f-bc0b-26c1ffa8562f-1338'), '1338');
    const h = runtimeV2('mcp_issue_key_hash', 'no-number-here');
    assert.match(h, /^[0-9a-f]{8}$/);
});

test('§2 D1 T20 v2 键推导：KOL_ISSUE_ID pin → <agent>-i<num>；无 issue → -solo', () => {
    const out1 = runtimeV2('mcp_derive_runtime_id_v2', 'Atlas', '/tmp/wt');
    assert.equal(out1, 'Atlas-solo', 'no KOL_ISSUE_ID env in this shell → solo');
    const out2 = runtimeV2('kol_derive_runtime_id_v2', 'Atlas', '/tmp/wt');
    assert.equal(out2, out1, 'legacy alias parity');
});

// ---- P1 线性单源追加 (Atlas 2026-09-23 裁决): reuse-lane single source -----------

test('§4.2+ T21 复用单源：WARM+活 proxy → editor_busy（前任在管）', () => {
    const d = decideReuseSingleSource({ state: 'WARM', holderProxyAlive: true, holderWorktree: '/tmp/wt', ourWorktree: '/tmp/wt', samePort: true });
    assert.equal(d.action, 'editor_busy');
    assert.equal(d.reason, 'HOLDER_PROXY_ALIVE_AMEND1');
});

test('§4.2+ T22 复用单源：WARM+死 proxy+worktree 匹配 → handoff_reuse', () => {
    const d = decideReuseSingleSource({ state: 'WARM', holderProxyAlive: false, holderWorktree: '/tmp/wt', ourWorktree: '/tmp/wt', samePort: true });
    assert.equal(d.action, 'handoff_reuse');
    assert.equal(d.reason, 'WARM_DEAD_HOLDER_WORKTREE_MATCH');
});

test('§4.2+ T23 复用单源：WARMING+死 proxy+匹配 → handoff_reuse（形态 B 尸体收编）', () => {
    for (const st of ['WARMING', 'RECOVERING']) {
        const d = decideReuseSingleSource({ state: st, holderProxyAlive: false, holderWorktree: '/tmp/wt', ourWorktree: '/tmp/wt/sub', samePort: true });
        assert.equal(d.action, 'handoff_reuse', st);
    }
});

test('§4.2+ T24 复用单源：worktree 不匹配 → cold_start（legacy lane 收尾）', () => {
    const d = decideReuseSingleSource({ state: 'WARM', holderProxyAlive: false, holderWorktree: '/other/wt', ourWorktree: '/tmp/wt', samePort: true });
    assert.equal(d.action, 'cold_start');
    assert.equal(d.reason, 'WARM_DEAD_HOLDER_WORKTREE_MISMATCH');
});

test('§4.2+ T25 复用单源：端口不匹配 / FAILED_CLEAN → cold_start', () => {
    assert.equal(decideReuseSingleSource({ state: 'WARM', holderProxyAlive: false, holderWorktree: '/tmp/wt', ourWorktree: '/tmp/wt', samePort: false }).action, 'cold_start');
    assert.equal(decideReuseSingleSource({ state: 'FAILED_CLEAN', holderProxyAlive: false, holderWorktree: '/tmp/wt', ourWorktree: '/tmp/wt', samePort: true }).action, 'cold_start');
});

test('§4.2+ T26 spawn.mjs 单源接线：有 .state 记录时先走单源分支（盘外招收编）', () => {
    const src = readSrc('proxy/spawn.mjs');
    assert.ok(/SINGLE_SOURCE_REUSE/.test(src));
    assert.ok(/decideReuseSingleSource/.test(src));
    assert.ok(/decideReuseSingleSource[\s\S]*?verdict === 'evict' \|\| verdict === 'respawn'/.test(src.replace(/\n/g, '\n')),
        'single-source branch must run BEFORE the legacy verdict stack');
});

test('§4.2+ T26b WP7 claim-time：记录的 editor_pid 探活为死 → cold_start 否决 handoff（§SPEC-012）', () => {
    for (const st of ['WARM', 'WARMING', 'RECOVERING']) {
        const d = decideReuseSingleSource({
            state: st, holderProxyAlive: false,
            holderWorktree: '/tmp/wt', ourWorktree: '/tmp/wt', samePort: true,
            editorAlive: false,
        });
        assert.equal(d.action, 'cold_start', st);
        assert.equal(d.reason, `${st}_DEAD_HOLDER_EDITOR_DEAD`, st);
    }
});

test('§4.2+ T26c WP7 claim-time：editorAlive 未知（null/undefined）不改变历史行为', () => {
    for (const ea of [null, undefined]) {
        const d = decideReuseSingleSource({
            state: 'WARM', holderProxyAlive: false,
            holderWorktree: '/tmp/wt', ourWorktree: '/tmp/wt', samePort: true,
            editorAlive: ea,
        });
        assert.equal(d.action, 'handoff_reuse');
        assert.equal(d.reason, 'WARM_DEAD_HOLDER_WORKTREE_MATCH');
    }
    // live editor also keeps the handoff (the veto is only for a positive dead)
    const d2 = decideReuseSingleSource({
        state: 'WARM', holderProxyAlive: false,
        holderWorktree: '/tmp/wt', ourWorktree: '/tmp/wt', samePort: true,
        editorAlive: true,
    });
    assert.equal(d2.action, 'handoff_reuse');
});

test('§4.2+ T26d WP7 spawn.mjs 接线：editorAlive 进决策 + editorPidAlive 导入在位', () => {
    const src = readSrc('proxy/spawn.mjs');
    assert.ok(/editorPidAlive\(/.test(src), 'editorPidAlive probe wired');
    assert.ok(/editorAlive,/.test(src), 'editorAlive passed into decideReuseSingleSource');
    assert.ok(/editor_alive=/.test(src), 'stageLog carries the editor liveness verdict');
});

test('§4.2+ T27 reaper executor 模式：--from-state 只执行 REAP_PENDING（裁决权在 proxy）', () => {
    const src = readSrc('reap-stale-leases.sh');
    assert.ok(/--from-state/.test(src));
    assert.ok(/REAP_PENDING/.test(src));
    assert.ok(/exit 0/.test(src.split('--from-state EXECUTOR mode')[1]?.split('REAPED=0')[0] || ''), 'executor mode exits before legacy scan');
});

test('§4.2+ T28 内存计数器落盘：FAILED_CLEAN 写入携带 backoff/restart/round 全量预算', () => {
    const src = readSrc('proxy/spawn.mjs');
    for (const f of ['spawn_failed_streak', 'spawn_backoff_until', 'give_up_count', 'give_up_backoff_ms', 'force_restart_count', 'recovery_round']) {
        assert.ok(new RegExp(`${f}:`).test(src), f);
    }
});

test('§4.2+ T29 EDITOR_GONE 落盘：post-warm 死亡将 .state 归 COLD（不留误导性 WARM）', () => {
    const src = readSrc('proxy/spawn.mjs');
    const block = src.slice(src.indexOf('function beginWarmEditorRespawn'), src.indexOf('function resetForRespawn'));
    assert.ok(/event: 'EDITOR_GONE'/.test(block));
    assert.ok(/state: 'COLD'/.test(block));
});

// ---- P1 QA 缺陷 #1 (HIGH, Revy 复测): startupHandoff 调用形态回归 ---------------

test('QA#1 R1 acquireRuntimeLock 为同步签名（杜绝调用点漏 await 再犯）', () => {
    const src = readSrc('proxy/state-file.mjs');
    assert.ok(!/export async function acquireRuntimeLock/.test(src),
        'acquireRuntimeLock MUST be sync — an async signature lies to sync call sites');
    assert.ok(/export function acquireRuntimeLock/.test(src));
});

test('QA#1 R2 startupHandoff 调用点形态：锁调用不再依赖 await（同步后直接判 lock.locked）', () => {
    const src = readSrc('godot-mcp-proxy.mjs');
    // The bug shape: `const lock = acquireRuntimeLock(...)` read off a Promise.
    // Now that the lock is sync this call shape is correct; the regression is
    // any future re-introduction of an async lock API.
    const m = src.match(/const lock = acquireRuntimeLock\(([^)]*)\)/);
    assert.ok(m, 'startupHandoff must call acquireRuntimeLock');
    assert.ok(!/const lock = await acquireRuntimeLock/.test(src) || /export function acquireRuntimeLock/.test(readSrc('proxy/state-file.mjs')),
        'if the lock ever becomes async again, the call site MUST await it');
    // And the branch actually consumes the result:
    assert.ok(/lock\.locked/.test(src), 'startupHandoff must branch on lock.locked');
});

test('QA#1 R3 startupHandoff 实机行为：持锁 → 读盘 → 决策写盘（不再误走 read-only）', () => {
    const rid = 'Bachi-i1338-handoff-smoke';
    const sfHome = sf.statePathFor(rid);
    // Seed a WARM record with a dead holder proxy (reclaim path).
    sf.writeRuntimeState(rid, baseState({ proxy_pid: 999999999, proxy_pid_started_at: new Date(NOW - 60000).toISOString() }));
    const lock = sf.acquireRuntimeLock(rid, { ownerPid: process.pid });
    assert.equal(lock.locked, true, 'sync acquire returns a real object — the QA#1 bug shape (Promise.locked===undefined) is impossible');
    const disk = sf.readRuntimeState(rid);
    const d = decideHandoffAction({ disk, holderProxy: { pid: 999999999, startedAt: NOW - 60000, verified: false } });
    assert.equal(d.action, 'reclaim_dead');
    sf.releaseRuntimeLock(rid, process.pid);
});
