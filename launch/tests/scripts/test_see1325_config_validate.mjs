#!/usr/bin/env node
// SEE-1325 H2 / SEE-1328 阶段一 — config-validate.mjs 双轨 guard 参数化单测
// (§SPEC-011 / §SPEC-012)。Run:
//   node --test --test-reporter=junit launch/tests/scripts/test_see1325_config_validate.mjs
//
// Spec: SEE-1328 issue description §SPEC-011 (KOL 部署签名 + 注入健康度双轨
// 判定，签名命中 + HOME 判定失败 → rc≤2、墙钟 ≤2s、结构化诊断指向平台根治
// 项) 与 §SPEC-012 (非误伤专项)。
//
// 磁盘签名（非 env 证据）三条同时成立才算 KOL 部署：
//   S1 repo 布局：repo root 有 project.godot
//   S2 .dev/env/kol-mcp.env 存在于 repo root
//   S3 shim/launcher 的 realpath 不落在共享 master 检出（GODOT_MCP_SHARED_MASTER）之内
// 注入健康度（仅签名命中时参与判定）：
//   H1 GODOT_MCP_HOME 位于 $HOME 之下
//   H2 GODOT_MCP_HOME ≠ 内置默认 ~/.config/godot-mcp
// marker（GODOT_MCP_ENV_INJECTED）只进诊断日志，绝不改变判定结果（§SPEC-011）。
// /mnt/ 字面量拒绝仅限执行路径（LAUNCHER_PATH / FORK_CLI）；SHARED_MASTER
// 不参与校验；GODOT_MCP_ALLOW_DRVFS_PATHS=1 逃生门 + DRDFS_ESCAPE=1 stage
// log（§SPEC-012）。

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALIDATE_MJS = path.join(__dirname, '..', '..', 'config-validate.mjs');
const MODULE_EXISTS = fs.existsSync(VALIDATE_MJS);

// TDD RED 阶段：模块不存在 → 全部用例跳过机制不可用，这里用动态 import，
// 模块缺失时让每个用例显式失败（RED 证据），实现后自然转绿。
const mod = MODULE_EXISTS
    ? await import(VALIDATE_MJS)
    : null;

const { validateLaunchConfig, SHIM_STAGE_LINE, LAUNCHER_STAGE_LINE } = mod ?? {};

// ---- fixture helpers ---------------------------------------------------------
const HOME = os.homedir();

function makeRepo(tmp) {
    const root = fs.mkdtempSync(path.join(tmp, 'kol-repo-'));
    fs.writeFileSync(path.join(root, 'project.godot'), '[application]\n');
    fs.mkdirSync(path.join(root, '.dev', 'env'), { recursive: true });
    fs.writeFileSync(path.join(root, '.dev', 'env', 'kol-mcp.env'), 'export GODOT_MCP_HOME="$HOME/.multica"\n');
    fs.mkdirSync(path.join(root, 'addons', 'godot_mcp', 'launch'), { recursive: true });
    const shim = path.join(root, 'addons', 'godot_mcp', 'launch', 'godot-mcp-shim.mjs');
    const launcher = path.join(root, 'addons', 'godot_mcp', 'launch', 'godot-mcp-launcher.sh');
    fs.writeFileSync(shim, '#!/usr/bin/env node\n');
    fs.writeFileSync(launcher, '#!/usr/bin/env bash\n');
    return { root, shim, launcher };
}

const DEFAULT_HOME = path.join(HOME, '.config', 'godot-mcp');

// 非 KOL standalone 检出：无 kol-mcp.env、无 project.godot 于 repo root。
function makeStandalone(tmp) {
    const root = fs.mkdtempSync(path.join(tmp, 'standalone-'));
    fs.mkdirSync(path.join(root, 'launch'), { recursive: true });
    const shim = path.join(root, 'launch', 'godot-mcp-shim.mjs');
    fs.writeFileSync(shim, '#!/usr/bin/env node\n');
    return { root, shim };
}

// ---- §SPEC-011: 双轨判定 -------------------------------------------------------
test('§SPEC-011 KOL 签名 + HOME 判定失败 → hard fail rc=2', () => {
    if (!mod) return assert.fail('RED: config-validate.mjs 不存在（TDD RED 套件先行）');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see1325-'));
    const { root, shim, launcher } = makeRepo(tmp);
    // 健康度失败：GODOT_MCP_HOME 落在共享 master（D 盘）内 → 双轨全失败
    const r = validateLaunchConfig({
        repoRoot: root,
        scriptPath: shim,
        launcherPath: launcher,
        forkCli: path.join(root, 'server', 'dist', 'cli.js'),
        godotMcpHome: '/mnt/d/GodotProjects/king-of-likes',
        home: HOME,
        sharedMaster: '/mnt/d/GodotProjects/king-of-likes',
    });
    assert.equal(r.ok, false);
    assert.ok(r.rc >= 0 && r.rc <= 2, `rc must be ≤2, got ${r.rc}`);
    assert.equal(r.reason, 'HOME_HEALTH_UNSAFE');
    // 结构化诊断：指明注入通道失效 + 指向平台根治项（daemon 模板硬编码 D 盘）
    assert.ok(r.diagnostics && typeof r.diagnostics === 'object', 'structured diagnostics required');
    assert.ok(r.diagnostics.reason, 'diagnostics.reason required');
    assert.ok(r.diagnostics.reason.includes('daemon'), 'diagnosis must point at the daemon-template platform root cause (平台根治项)');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('§SPEC-011 HOME 不在 $HOME 下 → 失败', () => {
    if (!mod) return assert.fail('RED: config-validate.mjs 不存在');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see1325-'));
    const { root, shim, launcher } = makeRepo(tmp);
    const r = validateLaunchConfig({
        repoRoot: root, scriptPath: shim, launcherPath: launcher,
        forkCli: path.join(root, 'server', 'dist', 'cli.js'),
        godotMcpHome: '/opt/somewhere/godot-mcp',
        home: HOME, sharedMaster: '/mnt/d/GodotProjects/king-of-likes',
    });
    assert.equal(r.ok, false);
    assert.ok(r.rc <= 2);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('§SPEC-011 HOME == 内置默认 ~/.config/godot-mcp → 失败（NEUTRAL 默认 = 注入未生效）', () => {
    if (!mod) return assert.fail('RED: config-validate.mjs 不存在');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see1325-'));
    const { root, shim, launcher } = makeRepo(tmp);
    const r = validateLaunchConfig({
        repoRoot: root, scriptPath: shim, launcherPath: launcher,
        forkCli: path.join(root, 'server', 'dist', 'cli.js'),
        godotMcpHome: DEFAULT_HOME,
        home: HOME, sharedMaster: '/mnt/d/GodotProjects/king-of-likes',
    });
    assert.equal(r.ok, false, 'neutral default under a KOL signature means daemon-injected env was bypassed');
    assert.equal(r.reason, 'HOME_HEALTH_UNSAFE');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('§SPEC-011 KOL 签名 + 健康度通过（$HOME 下且 ≠ 默认）→ ok', () => {
    if (!mod) return assert.fail('RED: config-validate.mjs 不存在');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see1325-'));
    const { root, shim, launcher } = makeRepo(tmp);
    const r = validateLaunchConfig({
        repoRoot: root, scriptPath: shim, launcherPath: launcher,
        forkCli: path.join(root, 'server', 'dist', 'cli.js'),
        godotMcpHome: path.join(HOME, '.multica'),
        home: HOME, sharedMaster: '/mnt/d/GodotProjects/king-of-likes',
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.rc <= 2);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('§SPEC-011 marker 缺失 → 仍 hard fail rc≤2（marker 不参与判定）', () => {
    if (!mod) return assert.fail('RED: config-validate.mjs 不存在');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see1325-'));
    const { root, shim, launcher } = makeRepo(tmp);
    const r = validateLaunchConfig({
        repoRoot: root, scriptPath: shim, launcherPath: launcher,
        forkCli: path.join(root, 'server', 'dist', 'cli.js'),
        godotMcpHome: '/mnt/d/GodotProjects/king-of-likes',
        home: HOME, sharedMaster: '/mnt/d/GodotProjects/king-of-likes',
        envInjectedMarker: '', // marker 缺失
    });
    assert.equal(r.ok, false);
    assert.ok(r.rc <= 2, 'marker 缺失场景 rc≤2 (§SPEC-011)');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('§SPEC-011 marker 命中不改变判定结果（仅入诊断日志）', () => {
    if (!mod) return assert.fail('RED: config-validate.mjs 不存在');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see1325-'));
    const { root, shim, launcher } = makeRepo(tmp);
    const base = {
        repoRoot: root, scriptPath: shim, launcherPath: launcher,
        forkCli: path.join(root, 'server', 'dist', 'cli.js'),
        godotMcpHome: '/mnt/d/GodotProjects/king-of-likes',
        home: HOME, sharedMaster: '/mnt/d/GodotProjects/king-of-likes',
    };
    const without = validateLaunchConfig(base);
    const withMarker = validateLaunchConfig({ ...base, envInjectedMarker: '1' });
    assert.equal(withMarker.ok, without.ok, 'marker must not affect the verdict');
    assert.equal(withMarker.reason, without.reason);
    // marker 只作为诊断信息出现
    assert.ok(withMarker.diagnostics.envInjectedMarker === '1');
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- §SPEC-012: 非误伤专项 -----------------------------------------------------
test('§SPEC-012 非 KOL 签名 → 零影响（standalone 检出 NEUTRAL HOME 亦 ok）', () => {
    if (!mod) return assert.fail('RED: config-validate.mjs 不存在');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see1325-'));
    const { root, shim } = makeStandalone(tmp);
    const r = validateLaunchConfig({
        repoRoot: root, scriptPath: shim, launcherPath: '',
        forkCli: path.join(root, 'server', 'dist', 'cli.js'),
        godotMcpHome: DEFAULT_HOME,
        home: HOME, sharedMaster: '/mnt/d/GodotProjects/king-of-likes',
    });
    assert.equal(r.ok, true, 'non-KOL signature must be untouched (zero false positives)');
    assert.ok(r.rc <= 2);
    assert.ok(!r.reason || r.reason === 'NON_KOL', `expected NON_KOL passthrough, got ${r.reason}`);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('§SPEC-012 /mnt/ 字面量拒绝仅限执行路径：LAUNCHER_PATH / FORK_CLI 落 /mnt → fail', () => {
    if (!mod) return assert.fail('RED: config-validate.mjs 不存在');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see1325-'));
    const { root, shim, launcher } = makeRepo(tmp);
    const r1 = validateLaunchConfig({
        repoRoot: root, scriptPath: shim, launcherPath: '/mnt/d/GodotProjects/king-of-likes/addons/godot_mcp/launch/godot-mcp-launcher.sh',
        forkCli: path.join(root, 'server', 'dist', 'cli.js'),
        godotMcpHome: path.join(HOME, '.multica'),
        home: HOME, sharedMaster: '/mnt/d/GodotProjects/king-of-likes',
    });
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, 'DRDFS_EXEC_PATH');
    const r2 = validateLaunchConfig({
        repoRoot: root, scriptPath: shim, launcherPath: launcher,
        forkCli: '/mnt/d/other/server/dist/cli.js',
        godotMcpHome: path.join(HOME, '.multica'),
        home: HOME, sharedMaster: '/mnt/d/GodotProjects/king-of-likes',
    });
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, 'DRDFS_EXEC_PATH');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('§SPEC-012 SHARED_MASTER 值本身不参与校验（数据路径非执行路径）', () => {
    if (!mod) return assert.fail('RED: config-validate.mjs 不存在');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see1325-'));
    const { root, shim, launcher } = makeRepo(tmp);
    // sharedMaster 是 D 盘路径 —— 不允许仅凭它触发 DRDFS_EXEC_PATH / hard fail
    const r = validateLaunchConfig({
        repoRoot: root, scriptPath: shim, launcherPath: launcher,
        forkCli: path.join(root, 'server', 'dist', 'cli.js'),
        godotMcpHome: path.join(HOME, '.multica'),
        home: HOME,
        sharedMaster: '/mnt/d/GodotProjects/king-of-likes',
    });
    assert.equal(r.ok, true, 'SHARED_MASTER must not participate in validation');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('§SPEC-012 逃生门 GODOT_MCP_ALLOW_DRVFS_PATHS=1 → DRDFS 执行路径放行 + DRDFS_ESCAPE=1 stage log', () => {
    if (!mod) return assert.fail('RED: config-validate.mjs 不存在');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see1325-'));
    const { root, shim, launcher } = makeRepo(tmp);
    const r = validateLaunchConfig({
        repoRoot: root, scriptPath: shim, launcherPath: '/mnt/d/GodotProjects/king-of-likes/addons/godot_mcp/launch/godot-mcp-launcher.sh',
        forkCli: path.join(root, 'server', 'dist', 'cli.js'),
        godotMcpHome: path.join(HOME, '.multica'),
        home: HOME, sharedMaster: '/mnt/d/GodotProjects/king-of-likes',
        allowDrvfsPaths: true,
    });
    assert.equal(r.ok, true, 'escape hatch must allow DRDFS exec paths');
    assert.equal(r.escape, 'DRDFS_ESCAPE', 'escape must be reported so the caller emits stage log DRDFS_ESCAPE=1');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('§SPEC-012 逃生门只豁免 DRDFS 执行路径，不豁免 HOME 健康度失败', () => {
    if (!mod) return assert.fail('RED: config-validate.mjs 不存在');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see1325-'));
    const { root, shim, launcher } = makeRepo(tmp);
    const r = validateLaunchConfig({
        repoRoot: root, scriptPath: shim, launcherPath: '/mnt/d/x/godot-mcp-launcher.sh',
        forkCli: path.join(root, 'server', 'dist', 'cli.js'),
        godotMcpHome: '/mnt/d/GodotProjects/king-of-likes',
        home: HOME, sharedMaster: '/mnt/d/GodotProjects/king-of-likes',
        allowDrvfsPaths: true,
    });
    assert.equal(r.ok, false, 'escape hatch must not rescue an unhealthy HOME injection');
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- stage log 常量 -------------------------------------------------------------
test('stage log 常量：launcher 侧 [stage=...] 行含 DRDFS_ESCAPE 与失败诊断键', () => {
    if (!mod) return assert.fail('RED: config-validate.mjs 不存在');
    assert.match(LAUNCHER_STAGE_LINE, /DRDFS_ESCAPE=1/);
    assert.match(LAUNCHER_STAGE_LINE, /\[stage=/);
    assert.ok(typeof SHIM_STAGE_LINE === 'string' && SHIM_STAGE_LINE.length > 0);
});

// ---- CLI 墙钟断言（§SPEC-011：墙钟 ≤2s）------------------------------------------
// 真 CLI 入口（node config-validate.mjs --shim <path> ...）以 execFileSync 墙钟
// 计时，硬断言 <2000ms。实现后此用例自然转绿。
test('§SPEC-011 CLI 入口 hard-fail 场景 墙钟 ≤2s', () => {
    if (!mod) return assert.fail('RED: config-validate.mjs 不存在');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see1325-'));
    const { root, shim, launcher } = makeRepo(tmp);
    const t0 = process.hrtime.bigint();
    try {
        execFileSync(process.execPath, [
            VALIDATE_MJS,
            '--repo-root', root,
            '--shim', shim,
            '--launcher', launcher,
            '--fork-cli', path.join(root, 'server', 'dist', 'cli.js'),
            '--home', HOME,
            '--godot-mcp-home', '/mnt/d/GodotProjects/king-of-likes',
            '--shared-master', '/mnt/d/GodotProjects/king-of-likes',
        ], { encoding: 'utf8' });
        assert.fail('CLI must exit non-zero on hard fail');
    } catch (e) {
        const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.ok(wallMs <= 2000, `wall clock ${wallMs.toFixed(0)}ms must be ≤2000ms`);
        assert.ok(e.status >= 0 && e.status <= 2, `exit code ${e.status} must be ≤2`);
        const out = `${e.stdout || ''}${e.stderr || ''}`;
        assert.ok(out.includes('daemon'), 'structured diagnosis must name the daemon-template platform root cause');
    }
    fs.rmSync(tmp, { recursive: true, force: true });
});
