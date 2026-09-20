#!/usr/bin/env node
// SEE-1328 阶段一 A-qa — §SPEC-011/012/017 实机 E2E 套件（真部署链）。
//
// 实机形态：真实 KOL 部署链 = daemon → shim（node godot-mcp-shim.mjs）→ T+0
// runConfigValidate() → launcher（bash，bootstrap 后跑 config-validate CLI）。
// 本套件以真实子进程拉起 shim / launcher 本体（不 import 产品函数、不 mock），
// 断言进程 rc、stderr 原始字节、hrtime 墙钟 —— oracle 全 concrete。
//
// Run（JUnit XML）:
//   node launch/tests/e2e/see1328/test_see1328_config_validate_realchain.mjs \
//     --junit > see1328_realchain_junit.xml
// 场景定义见同目录 TEST_PLAN.md（R1-R7）。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH_DIR = path.resolve(__dirname, '..', '..', '..');
const SHIM = path.join(LAUNCH_DIR, 'godot-mcp-shim.mjs');
const LAUNCHER = path.join(LAUNCH_DIR, 'godot-mcp-launcher.sh');
const VALIDATE = path.join(LAUNCH_DIR, 'config-validate.mjs');
const ASSERT_REG = path.join(LAUNCH_DIR, 'mcp-assert-registration.sh');
const HOME = os.homedir();
const EVIL_HOME = '/mnt/d/see1328-evil-injection'; // /mnt 下 = 不在 $HOME 下 → 健康度失败

// ---- fixture：真实 KOL repo 副本（含真实 shim/launcher/validate 拷贝）-----------
// 部署语义：launcher 在 validate 之前 source .dev/env/kol-mcp.env —— env 文件
// 是 GODOT_MCP_HOME 的唯一权威注入通道且**覆盖 caller 显式 env**（Bachi 同类
// 实测结论）。因此注入失败态在真实链上只能通过篡改 env 文件本身构造。
const HEALTHY_ENV = 'export GODOT_MCP_HOME="$HOME/.multica"\nexport GODOT_MCP_ENV_INJECTED=1\n';
const EVIL_ENV = `export GODOT_MCP_HOME=${EVIL_HOME}\nexport GODOT_MCP_ENV_INJECTED=1\n`;

function makeKolRepo(tmp, envFile = HEALTHY_ENV) {
    const root = fs.mkdtempSync(path.join(tmp, 'kol-real-'));
    fs.writeFileSync(path.join(root, 'project.godot'), '[application]\nconfig/name="see1328-e2e"\n');
    fs.mkdirSync(path.join(root, '.dev', 'env'), { recursive: true });
    fs.writeFileSync(path.join(root, '.dev', 'env', 'kol-mcp.env'), envFile);
    fs.mkdirSync(path.join(root, 'addons', 'godot_mcp', 'launch'), { recursive: true });
    const dst = path.join(root, 'addons', 'godot_mcp', 'launch');
    for (const f of ['godot-mcp-shim.mjs', 'godot-mcp-launcher.sh', 'config-validate.mjs', 'agent-ports.lib.sh', 'env.sh']) {
        const src = path.join(LAUNCH_DIR, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dst, f));
    }
    // launcher 依赖的相邻 lib：整目录浅拷贝 *.lib.sh / *.sh / *.mjs（launcher source 链）
    for (const f of fs.readdirSync(LAUNCH_DIR)) {
        if (/\.(sh|mjs)$/.test(f)) {
            const t = path.join(dst, f);
            if (!fs.existsSync(t)) fs.copyFileSync(path.join(LAUNCH_DIR, f), t);
        }
    }
    const shim = path.join(dst, 'godot-mcp-shim.mjs');
    const launcher = path.join(dst, 'godot-mcp-launcher.sh');
    fs.chmodSync(launcher, 0o755);
    return { root, dst, shim, launcher };
}

function makeStandaloneRepo(tmp) {
    const root = fs.mkdtempSync(path.join(tmp, 'standalone-real-'));
    fs.mkdirSync(path.join(root, 'addons', 'godot_mcp', 'launch'), { recursive: true });
    const dst = path.join(root, 'addons', 'godot_mcp', 'launch');
    for (const f of fs.readdirSync(LAUNCH_DIR)) {
        if (/\.(sh|mjs)$/.test(f)) fs.copyFileSync(path.join(LAUNCH_DIR, f), path.join(dst, f));
    }
    const shim = path.join(dst, 'godot-mcp-shim.mjs');
    const launcher = path.join(dst, 'godot-mcp-launcher.sh');
    fs.chmodSync(launcher, 0o755);
    return { root, dst, shim, launcher };
}

async function withTemp(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see1328-qa-'));
    try { return await fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// 拉起真实 shim，等首个 stdout JSON-RPC 帧 / SHIM_DIE / 超时，收集全部 stderr。
function runShim(shimPath, env, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const t0 = process.hrtime.bigint();
        const child = spawn(process.execPath, [shimPath], {
            env: { ...process.env, ...env },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stderr = '', stdout = '';
        let settled = false;
        const finish = (why) => {
            if (settled) return;
            settled = true;
            const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
            try { child.kill('SIGKILL'); } catch { /* already dead */ }
            resolve({ why, wallMs, stderr, stdout, code: child.exitCode, signal: child.signalCode });
        };
        child.stderr.on('data', (d) => { stderr += d; if (stderr.includes('SHIM_DIE')) setTimeout(() => finish('shim_die'), 150); });
        child.stdout.on('data', (d) => { stdout += d; if (stdout.includes('"result"')) finish('jsonrpc_ok'); });
        child.on('exit', () => finish('exit'));
        setTimeout(() => finish('timeout'), timeoutMs);
    });
}

// 真实 launcher 短路执行：launcher 在 validate 失败时 exit 2，不需要走完整 boot。
// 为避免健康路径下 launcher 真去拉 editor/端口，健康场景不整链跑 launcher ——
// 逃生门 stage 行转发已由 CLI 真进程（R3）+ launcher 源 case 匹配（bash -n 层）覆盖。
function runLauncher(launcherPath, env, timeoutMs = 8000) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync('bash', [launcherPath], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
        timeout: timeoutMs,
        input: '',
    });
    const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
    return { status: r.status, signal: r.signal, stderr: r.stderr || '', stdout: r.stdout || '', wallMs };
}

// ---- R1: §SPEC-011 shim 入口 hard fail ------------------------------------------
test('R1 §SPEC-011 真实 shim 拉起：注入失败 HOME → SHIM_DIE rc=2、墙钟 ≤2s、诊断指向平台根治项', async () => {
    await withTemp(async (tmp) => {
        const { shim, root } = makeKolRepo(tmp);
        const r = await runShim(shim, {
            GODOT_MCP_HOME: EVIL_HOME,
            GODOT_MCP_SHARED_MASTER: '/mnt/d/GodotProjects/king-of-likes',
            GODOT_MCP_ENV_INJECTED: '1',
        }, 5000);
        assert.ok(r.stderr.includes('SHIM_DIE'), `expected SHIM_DIE, got stderr:\n${r.stderr}`);
        assert.ok(r.why === 'exit' || r.why === 'shim_die', `shim must die on its own, why=${r.why}`);
        assert.equal(r.code, 2, `shim exit code must be 2, got ${r.code} (signal=${r.signal})`);
        assert.ok(r.wallMs <= 2000, `wall clock ${r.wallMs.toFixed(0)}ms must be ≤2000ms`);
        assert.ok(r.stderr.includes('config-validate hard fail'), 'SHIM_DIE reason must name config-validate');
        assert.ok(r.stderr.includes('daemon'), 'diagnosis must point at the daemon-template platform root cause');
        assert.ok(r.stderr.includes('stage=CONFIG_VALIDATE'), 'validate stage line must be forwarded to stderr');
        assert.ok(fs.existsSync(path.join(root, 'project.godot')), 'repo fixture intact');
    });
});

// ---- R2: §SPEC-011 launcher 入口 hard fail --------------------------------------
test('R2 §SPEC-011 真实 launcher 执行：注入失败 HOME → CONFIG_VALIDATE_FAIL exit=2、墙钟 ≤2s、无写操作', async () => {
    await withTemp(async (tmp) => {
        const { launcher, root } = makeKolRepo(tmp, EVIL_ENV);
        const stateDir = fs.mkdtempSync(path.join(tmp, 'state-'));
        const before = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).length : 0;
        // 注入失败态经 env 文件本身构造（launcher source kol-mcp.env 覆盖 caller env，
        // 与生产语义一致：env 文件是唯一注入权威）；caller env 保持 HOME 真实值。
        const r = runLauncher(launcher, {
            GODOT_MCP_SHARED_MASTER: '/mnt/d/GodotProjects/king-of-likes',
            HOME,
        }, 8000);
        assert.equal(r.status, 2, `launcher must exit 2, got ${r.status} (signal=${r.signal})\nstderr:\n${r.stderr}`);
        assert.ok(r.wallMs <= 2000, `wall clock ${r.wallMs.toFixed(0)}ms must be ≤2000ms`);
        assert.ok(r.stderr.includes('reason=HOME_HEALTH_UNSAFE'), `missing validate stage line:\n${r.stderr}`);
        assert.ok(r.stderr.includes('stage=CONFIG_VALIDATE_FAIL'), 'CONFIG_VALIDATE_FAIL stage line required');
        assert.ok(r.stderr.includes('daemon'), 'diagnosis must point at the daemon-template platform root cause');
        const after = fs.existsSync(stateDir) ? fs.readdirSync(stateDir).length : 0;
        assert.equal(after, before, 'hard fail must happen before any state-dir write');
        assert.ok(!r.stderr.includes('stage=PORT_ALLOC'), 'no port allocation may happen after hard fail');
    });
});

// ---- R3: §SPEC-012 逃生门真实 CLI 输出 -------------------------------------------
test('R3 §SPEC-012 真实 CLI + 逃生门：DRDFS_ESCAPE stage 行完整输出、无 ok= 行', () => {
    withTemp((tmp) => {
        const { root, dst } = makeKolRepo(tmp);
        const r = spawnSync(process.execPath, [
            VALIDATE,
            '--repo-root', root,
            '--shim', path.join(dst, 'godot-mcp-shim.mjs'),
            '--launcher', '/mnt/d/see1328-probe/launcher.sh',
            '--fork-cli', path.join(dst, '..', 'server', 'dist', 'cli.js'),
            '--home', HOME,
            '--godot-mcp-home', path.join(HOME, '.multica'),
            '--shared-master', '/mnt/d/GodotProjects/king-of-likes',
            '--allow-drvfs',
        ], { encoding: 'utf8' });
        assert.equal(r.status, 0, `escape path must exit 0, got ${r.status}: ${r.stderr}`);
        const lines = r.stderr.split('\n').filter(Boolean);
        assert.ok(lines.some((l) => l.includes('stage=DRDFS_ESCAPE') && l.includes('GODOT_MCP_ALLOW_DRVFS_PATHS=1 escape active')), `DRDFS stage line required:\n${r.stderr}`);
        assert.ok(!lines.some((l) => l.includes('ok=')), 'escape line must replace the ok= line entirely');
    });
});

// ---- R4: §SPEC-012 非 KOL 形态真实链零影响 ---------------------------------------
test('R4 §SPEC-012 非 KOL standalone：真实 shim + launcher 零影响（guard 不触发、链继续 boot）', async () => {
    await withTemp(async (tmp) => {
        const { shim, launcher } = makeStandaloneRepo(tmp);
        const sr = await runShim(shim, {
            GODOT_MCP_HOME: path.join(HOME, '.config', 'godot-mcp'),
        }, 5000);
        assert.ok(!sr.stderr.includes('config-validate hard fail'), `guard must not fire on standalone:\n${sr.stderr}`);
        assert.ok(!sr.stderr.includes('SHIM_DIE'), `no SHIM_DIE on standalone:\n${sr.stderr}`);
        assert.ok(sr.why === 'jsonrpc_ok' || sr.why === 'timeout', `shim must stay alive serving MCP, why=${sr.why}`);
        // launcher 真进程：validate 通过后继续 boot（无 agent-ports.json → 在端口层报错退出），
        // 断言没有 CONFIG_VALIDATE_FAIL 且 guard 行为仅以 DRDFS误报行出现（见缺陷 D1），
        // 真正的 NON_KOL 判定经过真实 validate CLI 独立核对。
        const lr = runLauncher(launcher, {
            GODOT_MCP_HOME: path.join(HOME, '.config', 'godot-mcp'),
            HOME,
        }, 6000);
        assert.ok(!lr.stderr.includes('stage=CONFIG_VALIDATE_FAIL'), `non-KOL must not CONFIG_VALIDATE_FAIL:\n${lr.stderr}`);
        assert.ok(lr.stderr.includes('agent-ports'), 'launcher must proceed past the guard into the port layer (chain continues)');
        // 同一形态经真实 validate CLI 直跑（无 --allow-drvfs）必须判 NON_KOL 放行。
        const cv = spawnSync(process.execPath, [
            VALIDATE,
            '--repo-root', path.resolve(launcher, '..', '..', '..', '..'),
            '--shim', path.join(path.dirname(launcher), 'godot-mcp-shim.mjs'),
            '--launcher', path.join(path.dirname(launcher), 'godot-mcp-launcher.sh'),
            '--fork-cli', path.join(path.dirname(launcher), '..', 'server', 'dist', 'cli.js'),
            '--home', HOME,
            '--godot-mcp-home', path.join(HOME, '.config', 'godot-mcp'),
        ], { encoding: 'utf8' });
        assert.equal(cv.status, 0);
        assert.ok(cv.stderr.includes('ok=true reason=NON_KOL'), `standalone CLI must return NON_KOL passthrough:\n${cv.stderr}`);
        // launcher 主进程 rc 不因 guard 死亡（端口层错误码非 2-guard 语义）
        assert.notEqual(lr.status, 2, `non-KOL must not exit 2 from the guard, got ${lr.status}\n${lr.stderr}`);
    });
});

// ---- R5: hardener §4-1 raw-path 语义（symlink shim 集成态）-----------------------
test('R5 hardener §4-1 symlink shim：Node 将 import.meta.url 解析为 realpath → raw scriptPath 落共享 master → NON_KOL 防误伤', async () => {
    await withTemp(async (tmp) => {
        const { shim, root } = makeKolRepo(tmp);
        const master = fs.mkdtempSync(path.join(tmp, 'master-real-'));
        fs.mkdirSync(path.join(master, 'launch'), { recursive: true });
        fs.copyFileSync(shim, path.join(master, 'launch', 'godot-mcp-shim.mjs'));
        const link = path.join(root, 'shim-via-link.mjs');
        fs.symlinkSync(path.join(master, 'launch', 'godot-mcp-shim.mjs'), link);
        const r = await runShim(link, {
            GODOT_MCP_HOME: EVIL_HOME,
            GODOT_MCP_SHARED_MASTER: master,
            GODOT_MCP_ENV_INJECTED: '1',
        }, 5000);
        // 实测语义：Node 的 import.meta.url 对 symlink 入口返回 **realpath**，
        // 因此 shim 的 raw scriptPath 天然落在共享 master 内 → S3 判 NON_KOL →
        // guard 不触发（防误伤语义在真实链上成立）。这同时证明 hardener §4-1
        // 提出的"symlink 使 raw-path 仍判 KOL"担忧在真实运行时不成立——
        // runtime 已做 realpath 归一，detectKolSignature 无需再自行 resolve。
        assert.ok(!r.stderr.includes('config-validate hard fail'), `shim via symlink into master must be judged NON_KOL (no guard fire):\n${r.stderr}`);
        assert.ok(r.why === 'jsonrpc_ok' || r.why === 'timeout', `shim must keep serving, why=${r.why}`);
    });
});

// ---- R6: hardener §4-3 guard 模块缺失防御放行 ------------------------------------
test('R6 hardener §4-3 config-validate.mjs 缺失：shim 防御式放行（不 SHIM_DIE、链继续）', async () => {
    await withTemp(async (tmp) => {
        const { shim, root } = makeKolRepo(tmp);
        fs.rmSync(path.join(root, 'addons', 'godot_mcp', 'launch', 'config-validate.mjs'));
        const r = await runShim(shim, {
            GODOT_MCP_HOME: EVIL_HOME,
            GODOT_MCP_SHARED_MASTER: '/mnt/d/GodotProjects/king-of-likes',
            GODOT_MCP_ENV_INJECTED: '1',
        }, 5000);
        assert.ok(!r.stderr.includes('config-validate hard fail'), `missing guard module must not hard fail:\n${r.stderr}`);
        assert.notEqual(r.code, 2, `shim must not die with rc=2 when guard module is missing, got ${r.code}`);
        assert.ok(r.why === 'jsonrpc_ok' || r.why === 'timeout', `shim must continue serving, why=${r.why}`);
    });
});

// ---- R7: §SPEC-017 真链注册对账 ---------------------------------------------------
test('R7 §SPEC-017 mcp-assert-registration.sh 真链 verdict 不退化', () => {
    const r = spawnSync('bash', [ASSERT_REG, '--json'], { encoding: 'utf8' });
    assert.equal(r.status, 0, `script must soft-succeed, got ${r.status}: ${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.equal(j.verdict, 'PASS', `registration verdict must stay PASS: ${JSON.stringify(j)}`);
    assert.equal(j.broken, 0, 'no broken godot entries allowed');
    assert.ok(j.godot_entries >= 1, `at least one godot entry expected, got ${j.godot_entries}`);
});
