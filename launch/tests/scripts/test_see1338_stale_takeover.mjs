// SEE-1338 §SPEC-GM1a/GM1b — stale-proxy takeover + no-dead-end regressions.
// Run: node --test --test-reporter=junit launch/tests/scripts/test_see1338_stale_takeover.mjs
//
// Covers:
//   1. see1338-stale-takeover.mjs decision matrix (the ONLY killing gate —
//      a holder must be provably a leftover godot-mcp proxy for OUR port).
//   2. SEE-1334 drift-triage regressions: the three undeclared-identifier
//      landmines (heal.mjs KOL_RUNTIME_ID, takeover.mjs warmFlushed,
//      lifecycle.mjs REG_PATH) that crashed the recovery/self-heal lanes.
//   3. GM1a budget reset: give-up re-arm / warm-respawn start a NEW recovery
//      episode (fresh planRecoveryBudget window), otherwise every later
//      recovery round degrades to "budget exhausted" with no respawn.
//   4. held-dir reader + declined takeover against our own pid.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH = path.join(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(LAUNCH, rel), 'utf8');

// Isolate state writes (giveup status file) in a temp GODOT_MCP_HOME BEFORE
// the proxy modules load (config.mjs captures it at import).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'see1338-home-'));
process.env.GODOT_MCP_HOME = tmpHome;
process.env.KOL_PORT_HELD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'see1338-held-'));
// GODOT_PORT is captured at config import — pin it for attemptStaleProxyTakeover.
process.env.GODOT_PORT = '6578';

const { decideStaleProxyTakeover } = await import(
    path.join(LAUNCH, 'see1338-stale-takeover.mjs'));
const staleProxy = await import(path.join(LAUNCH, 'proxy', 'stale-proxy.mjs'));
const spawnMod = await import(path.join(LAUNCH, 'proxy', 'spawn.mjs'));
const { S } = await import(path.join(LAUNCH, 'proxy', 'state.mjs'));

const OUR_PID = process.pid;
const OUR_PORT = 6577;
const PROXY_CMDLINE = 'node /x/godot-mcp/launch/godot-mcp-proxy.mjs';

// ---- §SPEC-GM1b: the takeover decision matrix -----------------------------------

test('§GM1b T1 无 holder pid → 拒绝接管（NO_HOLDER_PID）', () => {
    const d = decideStaleProxyTakeover({ holderPid: null, holderCmdline: PROXY_CMDLINE, holderPort: OUR_PORT, ourPort: OUR_PORT });
    assert.equal(d.takeover, false);
    assert.equal(d.reason, 'NO_HOLDER_PID');
});

test('§GM1b T2 holder 是我们自己 → 拒绝接管（SELF）', () => {
    const d = decideStaleProxyTakeover({ holderPid: OUR_PID, holderCmdline: PROXY_CMDLINE, holderPort: OUR_PORT, ourPort: OUR_PORT });
    assert.equal(d.takeover, false);
    assert.equal(d.reason, 'SELF');
});

test('§GM1b T3 cmdline 不是 godot-mcp proxy → 拒绝接管（不误杀无关进程）', () => {
    for (const cmdline of ['', 'godot', '/usr/bin/godot4 --editor --path /proj', 'bash start-godot-editor.sh']) {
        const d = decideStaleProxyTakeover({ holderPid: 4242, holderCmdline: cmdline, holderPort: OUR_PORT, ourPort: OUR_PORT });
        assert.equal(d.takeover, false, `cmdline=${cmdline}`);
        assert.equal(d.reason, 'CMDLINE_NOT_PROXY');
    }
});

test('§GM1b T4 cmdline 是 proxy 但端口不匹配 → 拒绝接管', () => {
    const d = decideStaleProxyTakeover({ holderPid: 4242, holderCmdline: PROXY_CMDLINE, holderPort: 6553, ourPort: OUR_PORT });
    assert.equal(d.takeover, false);
    assert.equal(d.reason, 'PORT_MISMATCH');
});

test('§GM1b T5 同 runtime 活 holder 未升级 → 拒绝（SAME_RUNTIME_LIVE）', () => {
    const d = decideStaleProxyTakeover({
        holderPid: 4242, holderRuntimeId: 'agent-a1b2c3d4', ourRuntimeId: 'agent-a1b2c3d4',
        holderCmdline: PROXY_CMDLINE, holderPort: OUR_PORT, ourPort: OUR_PORT,
    });
    assert.equal(d.takeover, false);
    assert.equal(d.reason, 'SAME_RUNTIME_LIVE');
});

test('§GM1b T6 同 runtime + 已证明不释放（takeover 超时）→ 允许接管', () => {
    const d = decideStaleProxyTakeover({
        holderPid: 4242, holderRuntimeId: 'agent-a1b2c3d4', ourRuntimeId: 'agent-a1b2c3d4',
        holderCmdline: PROXY_CMDLINE, holderPort: OUR_PORT, ourPort: OUR_PORT, allowSameRuntime: true,
    });
    assert.equal(d.takeover, true);
    assert.equal(d.reason, 'SAME_RUNTIME_NONRELEASE_STALE');
});

test('§GM1b T7 跨 runtime 残留 proxy → 允许接管（FOREIGN_RUNTIME_STALE）', () => {
    const d = decideStaleProxyTakeover({
        holderPid: 4242, holderRuntimeId: 'agent-old0099', ourRuntimeId: 'agent-a1b2c3d4',
        holderCmdline: PROXY_CMDLINE, holderPort: OUR_PORT, ourPort: OUR_PORT,
    });
    assert.equal(d.takeover, true);
    assert.equal(d.reason, 'FOREIGN_RUNTIME_STALE');
});

test('§GM1b T8 meta 无 runtime_id（legacy holder）+ 验证通过 → 允许接管', () => {
    const d = decideStaleProxyTakeover({
        holderPid: 4242, holderRuntimeId: '', ourRuntimeId: 'agent-a1b2c3d4',
        holderCmdline: PROXY_CMDLINE, holderPort: OUR_PORT, ourPort: OUR_PORT,
    });
    assert.equal(d.takeover, true);
    assert.equal(d.reason, 'UNMARKED_STALE_PROXY');
});

// ---- held-dir reader ------------------------------------------------------------

test('§GM1b T9 readHeldProxy 读取 held/<port>/{pid,meta}', async () => {
    const dir = path.join(process.env.KOL_PORT_HELD_DIR, String(OUR_PORT));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pid'), `${OUR_PID}\n`);
    fs.writeFileSync(path.join(dir, 'meta'), 'runtime_id=agent-old0099\n');
    const held = await staleProxy.readHeldProxy(OUR_PORT);
    assert.deepEqual(held, { pid: OUR_PID, runtimeId: 'agent-old0099' });
});

test('§GM1b T10 held 目录缺失 → readHeldProxy 返回 null', async () => {
    const r = await staleProxy.readHeldProxy(6099);
    assert.equal(r, null);
});

test('§GM1b T11 attemptStaleProxyTakeover 拒绝自己的 pid（SELF，不写计数器）', async () => {
    const dir = path.join(process.env.KOL_PORT_HELD_DIR, '6578');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pid'), `${process.pid}\n`);
    fs.writeFileSync(path.join(dir, 'meta'), 'runtime_id=agent-a1b2c3d4\n');
    const before = S.staleProxyTakeovers;
    const r = await staleProxy.attemptStaleProxyTakeover({ allowSameRuntime: true });
    assert.equal(r.tookOver, false);
    assert.equal(r.reason, 'SELF');
    assert.equal(S.staleProxyTakeovers, before);
});

// ---- SEE-1334 drift-triage regressions (undeclared-identifier landmines) --------

test('§GM1a D1 heal.mjs 无裸 KOL_RUNTIME_ID 引用（恢复轮不再 ReferenceError）', () => {
    assert.equal(/\bKOL_RUNTIME_ID\b/.test(readSrc('proxy/heal.mjs')), false);
});

test('§GM1a D2 takeover.mjs 无 warmFlushed 赋值残留（self-heal finally 不再崩）', () => {
    const src = readSrc('proxy/takeover.mjs');
    // The bug shape: a bare assignment `warmFlushed = false` referencing the
    // undeclared identifier. Prose comments mentioning it are fine.
    assert.equal(/\bwarmFlushed\s*=[^=]/.test(src), false);
});

test('§GM1a D3 lifecycle.mjs heartbeat env 使用 REGISTRY_PATH（无裸 REG_PATH shorthand）', () => {
    const src = readSrc('proxy/lifecycle.mjs');
    // The mergeScript string legitimately reads process.env.REG_PATH; the bug
    // shape is the bare shorthand `REG_PATH,` in the execFileSync env object.
    assert.equal(/env, \{\s*\n\s*REG_PATH,/.test(src), false);
    assert.ok(/REG_PATH:\s*REGISTRY_PATH/.test(src));
});

test('§GM1a D4 三个受损模块可正常 import 并导出（smoke）', async () => {
    const heal = await import(path.join(LAUNCH, 'proxy', 'heal.mjs'));
    const takeover = await import(path.join(LAUNCH, 'proxy', 'takeover.mjs'));
    const lifecycle = await import(path.join(LAUNCH, 'proxy', 'lifecycle.mjs'));
    assert.equal(typeof heal.runRecoveryRound, 'function');
    assert.equal(typeof takeover.enterTakeoverWaiter, 'function');
    assert.equal(typeof lifecycle.shutdown, 'function');
});

// ---- §SPEC-GM1a: recovery budget resets per episode ------------------------------

test('§GM1a B1 giveUpAndRearm 重置 recovery 预算窗口（新恢复周期）', () => {
    S.recoveryRound = 5;
    S.recoveryWindowStart = Date.now() - 999999;
    spawnMod.giveUpAndRearm('test_bucket', 'unit test');
    assert.equal(S.recoveryRound, 0);
    assert.equal(S.recoveryWindowStart, null);
    assert.ok(S.giveUpArmedAt > 0);
});

test('§GM1a B2 beginWarmEditorRespawn 重置 recovery 预算窗口', () => {
    S.warmRespawnInFlight = false;
    S.recoveryRound = 3;
    S.recoveryWindowStart = Date.now() - 999999;
    spawnMod.beginWarmEditorRespawn();
    assert.equal(S.recoveryRound, 0);
    assert.equal(S.recoveryWindowStart, null);
    assert.equal(S.warmEditorDead, true);
    S.warmRespawnInFlight = false;
    S.warmEditorDead = false;
});

test('§GM1a B3 giveUpAndRearm 允许重试：spawnTerminal 保持 false（无永久终态）', () => {
    spawnMod.giveUpAndRearm('test_bucket', 'unit test');
    assert.equal(S.spawnTerminal, false);
    assert.equal(S.spawnTriggered, false);
});
