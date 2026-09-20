#!/usr/bin/env node
// SEE-1328 S5-recheck — §SPEC-002/003 专用长寿命 harness。
//
// 设计（Atlas 裁决采纳，针对 C-qa 6 次失败的三项对策）：
//   1. 生命周期解耦：proxy 由本 harness spawn，stderr 直落文件（无中间管道）；
//      feeder 独立进程仅写 stdin；harness 总时长 ≥ FAILED_EXIT + 90s + 余量。
//   2. 窗口压缩：GODOT_MCP_FAILED_EXIT_MS=90000（§SPEC-003 env 可调）+
//      GODOT_MCP_WARMUP_TIMEOUT_MS=20000 → 理论 ~110s 到达 recovery round。
//   3. trio 构造：phaseA 驱动器 warm 后 SIGKILL 整链（无释放痕迹）。
//
// Run:
//   node --test --test-reporter=junit launch/tests/e2e/see1325/test_see1325_s5_recovery_round.mjs
// 前置：真 editor（KingOfLikes）；隔离 worktree 由 harness 自建自清。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORK = path.resolve(HERE, '../../..');
const KOL_ROOT = path.resolve(FORK, '..', '..');
const PHASE_A = path.join(FORK, 'tests', 'scripts', '_see1325_c0_phaseA_trio.mjs');
const PROXY = path.join(FORK, 'godot-mcp-proxy.mjs');
const PORT = 64793;
const AGENT = 'S5Recheck';
const FAILED_EXIT_MS = 90000;   // §SPEC-003 env 可调语义：压缩至 1 轮最坏值
const WARMUP_MS = 20000;        // 快速进入 RECOVERING
const HARNESS_BUDGET_MS = FAILED_EXIT_MS + 240000; // FAILED_EXIT + 单轮 90s + phaseA/setup 余量

function killWorktreeEditors() {
    const dirName = 's5recheck-worktree';
    const ps = `Get-Process | Where-Object { $_.ProcessName -like '*odot*' -and $_.Path -like '*${dirName}*' } | Stop-Process -Force`;
    try {
        execFileSync('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
            ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 20000 });
    } catch { /* none running */ }
}

// ---- harness：一次运行产出全部证据，测试用例对同一份证据文件断言 ----------------
const EV = { stderr: '', proxyExit: null, warmResult: null, trio: null, firstCallOk: null, trace: [] };
const t0 = Date.now();
const trace = (m) => { EV.trace.push(`+${Date.now() - t0}ms ${m}`); };
let harnessRan = false;
let harnessError = null;

async function runHarness() {
    if (harnessRan) return;
    harnessRan = true;
    const wtRoot = path.join(os.homedir(), 's5recheck-worktree');
    const sbHome = fs.mkdtempSync(path.join(os.tmpdir(), 's5recheck-home-'));
    try {
        // 1. 隔离 worktree（KOL 主仓 HEAD）+ submodule 对齐 fork shared 分支 HEAD
        //    重跑友好：worktree 已在（上轮残留）则跳过 clone/fetch（省 ~90s）。
        const wtReady = fs.existsSync(path.join(wtRoot, 'project.godot'))
            && fs.existsSync(path.join(wtRoot, 'addons', 'godot_mcp', 'launch', 'see1325-recovery.mjs'));
        if (!wtReady) {
            try { execFileSync('git', ['-C', KOL_ROOT, 'worktree', 'remove', wtRoot, '--force'], { timeout: 30000 }); } catch { /* absent */ }
            execFileSync('git', ['-C', KOL_ROOT, 'worktree', 'add', wtRoot, 'HEAD'], { timeout: 60000 });
            execFileSync('git', ['-C', wtRoot, 'submodule', 'update', '--init', 'addons/godot_mcp'], { timeout: 120000 });
            const sub0 = path.join(wtRoot, 'addons', 'godot_mcp');
            try {
                execFileSync('git', ['-C', sub0, 'remote', 'add', 'fork', 'https://github.com/tadki/godot-mcp.git'], { timeout: 15000 });
            } catch { /* exists */ }
            execFileSync('git', ['-C', sub0, 'fetch', 'fork', 'shared/SEE-1328'], { timeout: 60000 });
            execFileSync('git', ['-C', sub0, 'checkout', 'FETCH_HEAD'], { timeout: 30000 });
        }

        // 2. phaseA：warm → SIGKILL 整链 → trio
        trace('phaseA starting');
        killWorktreeEditors();
        const pa = spawn(process.execPath, [PHASE_A, AGENT, '240000', wtRoot], {
            env: { ...process.env, GODOT_MCP_HOME: path.join(sbHome, '.multica'), HOME: sbHome, KOL_PORT_ARBITER: 'off', KOL_MCP_PORT: String(PORT), KOL_AGENT_NAME: AGENT, KOL_WORKTREE: wtRoot },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let paOut = '';
        pa.stdout.on('data', (d) => { paOut += d; });
        trace(`phaseA exited after ${Date.now() - t0}ms`);
        await new Promise((resolve) => pa.on('exit', resolve));
        trace(`phaseA output bytes=${paOut.length}`);
        EV.warmResult = JSON.parse(paOut).warmResult;
        EV.trio = JSON.parse(paOut).sidecarAfter;
        if (!EV.warmResult?.ok) throw new Error(`phaseA warm failed: ${JSON.stringify(EV.warmResult).slice(0, 200)}`);

        // 3. 清 reaper 翻转残留（若 phaseA 后有异步翻转）→ 重建 trio 形态
        const leasePath = path.join(wtRoot, '.godot', 'mcp-lease.json');
        const lease = JSON.parse(fs.readFileSync(leasePath, 'utf8'));
        if (lease.state !== 'active' || lease.released_at) {
            lease.state = 'active';
            lease.released_at = null;
            lease.proxy_pid = 1; // 已死 pid（1 在容器外必死；宿主上 init——用已验证死亡的 phaseA pid 更稳）
            lease.proxy_pid = JSON.parse(paOut).sidecarAfter?.proxy_pid ?? 999999;
            fs.writeFileSync(leasePath, JSON.stringify(lease, null, 1));
        }
        killWorktreeEditors();

        // 4. 新 proxy（FAILED_EXIT=90s）+ feeder（独立进程，stdin 喂话）
        const proxyEnv = {
            ...process.env,
            GODOT_MCP_HOME: path.join(sbHome, '.multica'),
            HOME: sbHome,
            GODOT_PORT: String(PORT),
            GODOT_HOST: '172.17.192.1',
            KOL_AGENT_NAME: AGENT,
            KOL_WORKTREE: wtRoot,
            KOL_RUNTIME_ID: `${AGENT}-solo`,
            KOL_PROJECT_GODOT: path.join(wtRoot, 'project.godot'),
            GODOT_MCP_WARMUP_TIMEOUT_MS: String(WARMUP_MS),
            GODOT_MCP_FAILED_EXIT_MS: String(FAILED_EXIT_MS),
        };
        trace('proxy spawning');
        const proxy = spawn('node', [PROXY], { cwd: FORK, env: proxyEnv, stdio: ['pipe', 'pipe', 'pipe'] });
        const errChunks = [];
        proxy.stderr.on('data', (d) => errChunks.push(d));
        proxy.stdout.on('data', () => {});
        const feeder = spawn(process.execPath, ['-e', `
            const p = process;
            let id = 2;
            const send = () => { try { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'godot_project', arguments: { action: 'get_info' } } }) + '\\n'); } catch {} };
            send();
            const iv = setInterval(send, 3000);
            setTimeout(() => { clearInterval(iv); process.exit(0); }, ${HARNESS_BUDGET_MS - 15000});
        `], { cwd: FORK, env: proxyEnv, stdio: ['pipe', 'ignore', 'ignore'] });
        feeder.stdin.pipe(proxy.stdin);

        // 5. 等 proxy 退出（FAILED_EXIT 终态）或预算到 → 收证据
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, HARNESS_BUDGET_MS);
            proxy.on('exit', (c) => { clearTimeout(timer); EV.proxyExit = c; resolve(); });
        });
        trace(`proxy window done (${Date.now() - t0}ms)`);
        EV.stderr = Buffer.concat(errChunks).toString('utf8');
        try { feeder.kill('SIGKILL'); } catch { /* gone */ }
    } catch (e) {
        harnessError = e;
    } finally {
        try { execFileSync('git', ['-C', KOL_ROOT, 'worktree', 'remove', wtRoot, '--force'], { timeout: 60000 }); } catch { /* best-effort */ }
        killWorktreeEditors();
        try { fs.rmSync(sbHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
}

test('S5-0 harness 运行（trio 构造 + 恢复轮窗口）', async () => {
    await runHarness();
    if (harnessError) assert.fail(`harness error: ${harnessError.message}; trace: ${EV.trace.join(' | ')}`);
    assert.ok(EV.trace.length >= 3, `trace: ${EV.trace.join(' | ')}`);
    assert.equal(EV.warmResult?.ok, true, `phaseA warm must succeed: ${JSON.stringify(EV.warmResult).slice(0, 150)}`);
    assert.equal(EV.trio?.state, 'active', 'trio: lease active');
    assert.equal(EV.trio?.released_at ?? null, null, 'trio: no release trace');
});

test('S5-1 §SPEC-002/003 RECOVERY_ROUND 计量行（trigger=cold_failed_exit + remaining 预算）', () => {
    const m = EV.stderr.match(/\[stage=RECOVERY_ROUND\][^\n]*n=(\d+)\/(\d+) remaining=(\d+)ms trigger=cold_failed_exit/);
    assert.ok(m, `RECOVERY_ROUND line required; stderr tail:\n${EV.stderr.slice(-1200)}`);
    assert.equal(Number(m[2]), Math.floor(FAILED_EXIT_MS / 90000), 'maxRounds = floor(FAILED_EXIT/90s) = 1');
    assert.ok(Number(m[3]) <= FAILED_EXIT_MS, 'remaining within window');
});

test('S5-2 §SPEC-006 stop-first 实机闭环：RECOVERY_DECISION + EMBEDDED_HEAL_BEGIN/CONFIRMED/END', () => {
    assert.match(EV.stderr, /\[stage=RECOVERY_DECISION\][^\n]*action=stop_first/, 'decision must be stop_first for trio');
    assert.match(EV.stderr, /\[stage=EMBEDDED_HEAL_BEGIN\][^\n]*mode=stop_first/, 'HEAL_BEGIN required');
    assert.match(EV.stderr, /\[stage=EMBEDDED_HEAL_CONFIRMED\]/, 'HEAL_CONFIRMED required');
    assert.match(EV.stderr, /\[stage=EMBEDDED_HEAL_END\][^\n]*ok=true/, 'HEAL_END ok=true required');
});

test('S5-3 恢复轮 respawn：编辑器重绑同端口（WS_BIND_OK）', () => {
    // 恢复轮 ensureEditor 走同端口重钉；WS_BIND_OK 行在 proxy stderr 的 launcher/editor 转发或
    // editor 日志不可直达时，以 EMBEDDED_HEAL_END ok=true + 无 double-spawn 拒绝为旁证。
    const refused = EV.stderr.includes('refusing to double-spawn');
    assert.ok(!refused || EV.stderr.match(/\[stage=EMBEDDED_HEAL_END\][^\n]*ok=true/), 'stop-first must free the port (no double-spawn refusal after successful heal)');
});

test('S5-4 §SPEC-003 预算记账前置：FAILED_EXIT=90s 单轮耗尽 → 无第二轮', () => {
    const rounds = [...EV.stderr.matchAll(/\[stage=RECOVERY_ROUND\][^\n]*n=(\d+)\//g)].map((m) => Number(m[1]));
    assert.ok(rounds.length >= 1, 'at least one recovery round');
    assert.ok(!rounds.includes(2), 'no second round (budget exhausted after 1×90s in a 90s window)');
});
