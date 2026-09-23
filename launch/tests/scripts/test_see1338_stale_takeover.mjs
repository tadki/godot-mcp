// SEE-1338 spec v2.1 P0 — R2 hard-cap backstop + §4.2 AMEND-1 takeover guard.
// Run: node --test --test-reporter=junit launch/tests/scripts/test_see1338_stale_takeover.mjs
//
// Covers (spec v2.1 §4.2/§6, Atlas P0 dispatch):
//   1. §4.2 AMEND-1: decideStaleProxyAction — a LIVE holder is 前任在管
//      ('busy', never killed/cleaned); ONLY a dead holder's residue is
//      evictable; own pid = our own round.
//   2. classifyHeldProxy IO + maybeEvictStaleHeld guard (live → no evict,
//      dead → evict) against a real live child process.
//   3. §6 R2: RECOVERING hard cap constant = 2× cold timeout.
//   4. §6 FAILED_CLEAN reentrant state: spawnFailedDiagnostic state naming,
//      streak backoff (base × 2^(n-1), capped), give-up rearm budget reset.
//   5. AMEND-1 regression: no live-proxy kill machinery anywhere.

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

// Isolate state writes + backoff seams BEFORE the proxy modules load (config
// captures these at import).
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'see1338-home-'));
process.env.GODOT_MCP_HOME = tmpHome;
process.env.KOL_PORT_HELD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'see1338-held-'));
process.env.GODOT_PORT = '6578';
process.env.KOL_SPAWN_RETRY_BACKOFF_MS = '200';
process.env.KOL_GIVEUP_COOLDOWN_MS = '1000';

const { decideStaleProxyAction } = await import(
    path.join(LAUNCH, 'see1338-stale-takeover.mjs'));
const staleProxy = await import(path.join(LAUNCH, 'proxy', 'stale-proxy.mjs'));
const spawnMod = await import(path.join(LAUNCH, 'proxy', 'spawn.mjs'));
const config = await import(path.join(LAUNCH, 'proxy', 'config.mjs'));
const { S } = await import(path.join(LAUNCH, 'proxy', 'state.mjs'));

const HELD_DIR = process.env.KOL_PORT_HELD_DIR;
const PORT = 6578;
const OUR_PID = process.pid;

function writeHeld(pid, rid = 'agent-old0099') {
    const dir = path.join(HELD_DIR, String(PORT));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pid'), `${pid}\n`);
    fs.writeFileSync(path.join(dir, 'meta'), `runtime_id=${rid}\n`);
}

// ---- §4.2 AMEND-1: the classification matrix ------------------------------------

test('§4.2 T1 无 held 记录 → free（无可分类对象）', () => {
    const d = decideStaleProxyAction({ holderPid: null, ourPid: OUR_PID, holderAlive: null });
    assert.equal(d.action, 'free');
});

test('§4.2 T2 held pid 是我们自己 → own（自有轮次，允许清理）', () => {
    const d = decideStaleProxyAction({ holderPid: OUR_PID, ourPid: OUR_PID, holderAlive: true });
    assert.equal(d.action, 'own');
});

test('§4.2 T3 AMEND-1 核心：holder proxy 存活 → busy（绝不清理绝不杀）', () => {
    const d = decideStaleProxyAction({ holderPid: 4242, ourPid: OUR_PID, holderAlive: true });
    assert.equal(d.action, 'busy');
    assert.equal(d.reason, 'HOLDER_PROXY_ALIVE_AMEND1');
});

test('§4.2 T4 holder proxy 已死 → takeover（收尸：evict 孤儿 editor）', () => {
    const d = decideStaleProxyAction({ holderPid: 4242, ourPid: OUR_PID, holderAlive: false });
    assert.equal(d.action, 'takeover');
    assert.equal(d.reason, 'HOLDER_PROXY_DEAD_RESIDUE');
});

test('§4.2 T5 校验失败（不可读）→ 保守判死可收尸（宁可接管不冒进）', () => {
    const d = decideStaleProxyAction({ holderPid: 4242, ourPid: OUR_PID, holderAlive: null });
    assert.equal(d.action, 'takeover');
});

// ---- classifyHeldProxy IO --------------------------------------------------------

test('§4.2 T6 classifyHeldProxy：自己 pid → own', async () => {
    writeHeld(OUR_PID);
    const d = await staleProxy.classifyHeldProxy(PORT);
    assert.equal(d.action, 'own');
});

test('§4.2 T7 classifyHeldProxy：死 pid → takeover', async () => {
    writeHeld(999999999);
    const d = await staleProxy.classifyHeldProxy(PORT);
    assert.equal(d.action, 'takeover');
});

test('§4.2 T8 classifyHeldProxy：无 held 目录 → free', async () => {
    const d = await staleProxy.classifyHeldProxy(6099);
    assert.equal(d.action, 'free');
});

test('§4.2 T9 AMEND-1 守卫：活 holder → maybeEvictStaleHeld 拒绝 evict', async () => {
    const child = childSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
        await new Promise((r) => setTimeout(r, 150)); // let it register in /proc
        writeHeld(child.pid, 'agent-live777');
        let evictCalled = 0;
        const r = await staleProxy.maybeEvictStaleHeld(async () => { evictCalled += 1; }, PORT);
        assert.equal(r.action, 'busy');
        assert.equal(r.reason, 'HOLDER_PROXY_ALIVE_AMEND1');
        assert.equal(evictCalled, 0, 'live holder MUST NOT be evicted (前任在管)');
    } finally {
        child.kill('SIGKILL');
    }
});

test('§4.2 T10 守卫放行：死 holder → maybeEvictStaleHeld 执行 evict', async () => {
    writeHeld(999999999);
    let evictCalled = 0;
    const r = await staleProxy.maybeEvictStaleHeld(async () => { evictCalled += 1; }, PORT);
    assert.equal(r.action, 'takeover');
    assert.equal(evictCalled, 1);
});

// ---- §6 R2: RECOVERING hard cap = 2× cold timeout --------------------------------

test('§6 T11 RECOVERING_HARD_CAP_MS 缺省 = 2× cold timeout', () => {
    assert.equal(config.RECOVERING_HARD_CAP_MS, 2 * config.COLD_WARMUP_TIMEOUT_MS);
});

// ---- §6 FAILED_CLEAN reentrant state ---------------------------------------------

test('§6 T12 FAILED_CLEAN 终态诊断：state=FAILED_CLEAN 且可重入（retryable=true）', () => {
    const d = spawnMod.spawnFailedDiagnostic('spawn_failed_start', new Error('x'), true);
    assert.equal(d.state, 'FAILED_CLEAN');
    assert.equal(d.retryable, true, 'FAILED_CLEAN 是可重入状态 — 下一次 tools/call 直接重走冷启动');
});

test('§6 T13 spawn 失败退避：streak 1 → base，streak 2 → 2×base（env seam=200ms）', () => {
    S.spawnFailedStreak = 0;
    S.spawnFailedBucket = null;
    S.spawnBackoffUntil = 0;
    spawnMod.handleSpawnFailure(Object.assign(new Error('attempt 1'), { bucket: 'configure_failed' }));
    const b1 = S.spawnBackoffUntil - Date.now();
    assert.ok(b1 > 0 && b1 <= 250, `streak1 backoff ≈ 200ms, got ${b1}ms`);
    spawnMod.handleSpawnFailure(Object.assign(new Error('attempt 2'), { bucket: 'configure_failed' }));
    const b2 = S.spawnBackoffUntil - Date.now();
    assert.ok(b2 > 250 && b2 <= 450, `streak2 backoff ≈ 400ms (2×base), got ${b2}ms`);
    assert.ok(S.spawnLastFailed, '首报 latch stays armed for the next call');
});

test('§6 T14 退避封顶 60s：GIVEUP_MAX_COOLDOWN_MS 缺省 60000', () => {
    assert.equal(config.GIVEUP_MAX_COOLDOWN_MS, 60000);
});

test('§6 T15 giveUpAndRearm 重置全部重试预算（FAILED_CLEAN 可重入语义）', () => {
    S.recoveryRound = 5;
    S.recoveryWindowStart = Date.now() - 999999;
    S.forceRestartCount = 3;
    S.spawnBackoffUntil = Date.now() + 999999;
    spawnMod.giveUpAndRearm('test_bucket', 'unit test');
    assert.equal(S.recoveryRound, 0);
    assert.equal(S.recoveryWindowStart, null);
    assert.equal(S.forceRestartCount, 0, 'FAILED_CLEAN 重入 = 硬上限重启预算重置');
    assert.equal(S.spawnBackoffUntil, 0);
    assert.equal(S.spawnTerminal, false, 'rearm 模式下无永久终态');
});

test('§6 T16 forceColdRestart 存在且 warmup 引用硬上限（R2 强制冷重启接线）', () => {
    assert.equal(typeof spawnMod.forceColdRestart, 'function');
    const wu = readSrc('proxy/warmup.mjs');
    assert.ok(wu.includes('forceColdRestart'), 'warmup loop wires the forced restart');
    assert.ok(wu.includes('RECOVERING_HARD_CAP_MS'), 'warmup loop gates on the spec cap');
});

// ---- AMEND-1 regression: live-proxy kill machinery must not exist ----------------

test('AMEND-1 R1 全库无 attemptStaleProxyTakeover / killProxyTree 残留', () => {
    for (const f of ['proxy/spawn.mjs', 'proxy/takeover.mjs', 'proxy/stale-proxy.mjs', 'proxy/router.mjs']) {
        const src = readSrc(f);
        assert.equal(src.includes('attemptStaleProxyTakeover'), false, `${f}`);
        assert.equal(src.includes('killProxyTree'), false, `${f}`);
    }
});

test('AMEND-1 R2 busy_foreign/reuse 判定保持「活 holder 不杀」原语义', () => {
    const src = readSrc('proxy/spawn.mjs');
    assert.ok(/verdict === 'busy_foreign'[\s\S]*?editor_busy[\s\S]*?AMEND-1/.test(src));
    assert.ok(/AMEND-1 \(spec v2\.1 §4\.2\)/.test(src));
});

// ---- SEE-1338 QA defect #1 (HIGH): warm-gate + HANDOFF regressions ---------------

test('QA#1 R1 warm-gate：fork 车道 wsProbe 完全退出生产路径（线性单源）', () => {
    const src = readSrc('proxy/warmup.mjs');
    // P1 线性单源裁决: fork lane never schedules wsProbe; legacy lane keeps it.
    assert.ok(/const forkLane = cliConnectSignalExpected\(\);\s*\n\s*const probeOk = forkLane \? true : await wsProbe\(\);/.test(src),
        'fork lane must bypass wsProbe structurally, legacy lane keeps it');
});

test('QA#1 R2 evict/respawn 判定：worktree 匹配的 holder editor 降级为 HANDOFF 复用', () => {
    const src = readSrc('proxy/spawn.mjs');
    assert.ok(/verdict === 'evict' \|\| verdict === 'respawn'[\s\S]*?decideSidecarGuard\(holderWorktree, ourWorktree\) === 'reuse'[\s\S]*?HANDOFF reuse/.test(src),
        'dead-proxy verdicts must check the SEE-1129 worktree-match reuse before killing');
    assert.ok(/HANDOFF reuse/.test(src));
});

test('QA#1 R3 evict 后等待端口释放（异步 stop 竞态防线）', () => {
    const src = readSrc('proxy/spawn.mjs');
    const evictLane = src.slice(src.indexOf("verdict === 'evict' || verdict === 'respawn'"),
        src.indexOf("} else if (verdict === 'reuse')"));
    const waits = (evictLane.match(/waitForPortRelease\('respawn'\)/g) || []).length;
    assert.ok(waits >= 2, `both evict exits must wait for port release, got ${waits}`);
});

// ---- SEE-1338 QA defect #2 (LOW): reaper authoritative-reason quarantine ---------

test('QA#2 R1 reap 隔离必须携带权威理由（node 探测失败 ≠ 内容损坏）', () => {
    const src = readSrc('reap-stale-leases.sh');
    assert.ok(/case "\$err_msg" in/.test(src));
    assert.ok(/unparseable:\*\|missing:\*\|schema_version_unexpected:\*/.test(src));
    assert.ok(/NODE-FAILED sidecar probe/.test(src));
});
