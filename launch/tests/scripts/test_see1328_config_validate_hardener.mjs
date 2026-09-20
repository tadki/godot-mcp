#!/usr/bin/env node
// SEE-1328 阶段一 A-hardener — config-validate.mjs 判别力审计对抗性用例
// （补 §SPEC-011/012 现有 13 用例测不出的判定分支与边界）。
// Run:
//   node --test --test-reporter=junit launch/tests/scripts/test_see1328_config_validate_hardener.mjs
//
// 审计口径："默认代码是错误的"——每个用例钉死一个既有套件未覆盖的分支：
//   H1  S3 正向（shim 落共享 master 内 → NON_KOL，即使 HOME 不健康也不拦）
//   H2  S3 降级语义（sharedMaster 空/不存在 → S1+S2 主判，非 fail-open 不校验）
//   H3  空 GODOT_MCP_HOME（launcher 真实传参 "--godot-mcp-home \"\""）→ hard fail
//   H4  neutral 比较锚定自定义 home（home ≠ env.HOME 分支，config-validate.mjs:66-68）
//   H5  逃生门 + 不健康 HOME：reason 仍 HOME_HEALTH_UNSAFE 且 escape=DRDFS_ESCAPE 逐字段
//   H6  marker 有/无逐位一致：ok/reason/rc/escape 四字段全等（含 hard-fail 场景）
//   H7  空 LAUNCHER_PATH / FORK_CLI 不误报 DRDFS_EXEC_PATH
//   H8  /mnt/ 前缀精确性：/mnt2 与 /MNT（大小写）不误伤
//   H9  CLI hard-fail 退出码精确 == 2
//   H10 CLI ok 路径 stderr stage 行（ok=true reason=KOL_HEALTHY / NON_KOL）
//   H11 CLI escape-ok 输出完整 DRDFS_STAGE_LINE 而非 ok= 行（Refacty 交接注记断言形态）

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALIDATE_MJS = path.join(__dirname, '..', '..', 'config-validate.mjs');
const { validateLaunchConfig, DRDFS_STAGE_LINE, LAUNCHER_STAGE_LINE } = await import(VALIDATE_MJS);

const HOME = os.homedir();

function makeRepo(tmp) {
    const root = fs.mkdtempSync(path.join(tmp, 'kol-repo-'));
    fs.writeFileSync(path.join(root, 'project.godot'), '[application]\n');
    fs.mkdirSync(path.join(root, '.dev', 'env'), { recursive: true });
    fs.writeFileSync(path.join(root, '.dev', 'env', 'kol-mcp.env'), 'export GODOT_MCP_HOME="$HOME/.multica"\n');
    const shim = path.join(root, 'shim.mjs');
    const launcher = path.join(root, 'launcher.sh');
    fs.writeFileSync(shim, '#!/usr/bin/env node\n');
    fs.writeFileSync(launcher, '#!/usr/bin/env bash\n');
    return { root, shim, launcher };
}

function withTemp(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see1328-hard-'));
    try { return fn(tmp); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function cli(args) {
    return spawnSync(process.execPath, [VALIDATE_MJS, ...args], { encoding: 'utf8' });
}

// ---- H1/H2: S3 磁盘签名三要素组合 ------------------------------------------------
test('H1 S3 正向：shim 落共享 master 内 → NON_KOL，HOME 不健康也不拦', () => {
    withTemp((tmp) => {
        const { root, launcher } = makeRepo(tmp);
        const r = validateLaunchConfig({
            repoRoot: root,
            scriptPath: '/mnt/d/GodotProjects/king-of-likes/addons/godot_mcp/launch/godot-mcp-shim.mjs',
            launcherPath: launcher,
            forkCli: path.join(root, 'cli.js'),
            godotMcpHome: '/mnt/d/evil',
            home: HOME,
            sharedMaster: '/mnt/d/GodotProjects/king-of-likes',
        });
        assert.equal(r.ok, true, 'shim inside shared master must downgrade to NON_KOL (S3 anti false-positive)');
        assert.equal(r.reason, 'NON_KOL');
    });
});

test('H2 S3 降级：sharedMaster 为空串/不存在目录 → 仍判 KOL 并 hard fail（非 fail-open）', () => {
    withTemp((tmp) => {
        const { root, shim, launcher } = makeRepo(tmp);
        for (const sharedMaster of ['', '/nonexistent/see1328-probe']) {
            const r = validateLaunchConfig({
                repoRoot: root, scriptPath: shim, launcherPath: launcher,
                forkCli: path.join(root, 'cli.js'),
                godotMcpHome: '/mnt/d/evil', home: HOME, sharedMaster,
            });
            assert.equal(r.ok, false, `sharedMaster=${JSON.stringify(sharedMaster)} missing anchor must degrade to S1+S2, not skip validation`);
            assert.equal(r.reason, 'HOME_HEALTH_UNSAFE');
        }
    });
});

// ---- H3/H4: HOME 健康度边界 -------------------------------------------------------
test('H3 空 GODOT_MCP_HOME（launcher 真实传参形态 "--godot-mcp-home \\"\\""）→ hard fail', () => {
    withTemp((tmp) => {
        const { root, shim, launcher } = makeRepo(tmp);
        const r = validateLaunchConfig({
            repoRoot: root, scriptPath: shim, launcherPath: launcher,
            forkCli: path.join(root, 'cli.js'),
            godotMcpHome: '', home: HOME, sharedMaster: '/mnt/d/master',
        });
        assert.equal(r.ok, false, 'empty GODOT_MCP_HOME under KOL signature = injection bypassed');
        assert.equal(r.reason, 'HOME_HEALTH_UNSAFE');
        assert.equal(r.rc, 2);
    });
});

test('H4 neutral 比较锚定自定义 home（home ≠ env.HOME 分支）双向', () => {
    withTemp((tmp) => {
        const { root, shim, launcher } = makeRepo(tmp);
        const customHome = '/home/see1328-custom';
        // 方向一：gmh == 自定义 home 的内置默认 → 失败（neutral 以 input.home 计算）
        const bad = validateLaunchConfig({
            repoRoot: root, scriptPath: shim, launcherPath: launcher,
            forkCli: path.join(root, 'cli.js'),
            godotMcpHome: path.join(customHome, '.config', 'godot-mcp'),
            home: customHome, sharedMaster: '/mnt/d/master',
        });
        assert.equal(bad.ok, false, 'neutral default must be computed against input.home, not env.HOME');
        assert.equal(bad.reason, 'HOME_HEALTH_UNSAFE');
        // 方向二：home ≠ env.HOME 时，custom home 下的非 neutral 注入路径 → 放行
        //（证明 custom-home 分支的 neutral 以 input.home 计算，env 默认不误伤）
        const good = validateLaunchConfig({
            repoRoot: root, scriptPath: shim, launcherPath: launcher,
            forkCli: path.join(root, 'cli.js'),
            godotMcpHome: path.join(customHome, '.multica'),
            home: customHome, sharedMaster: '/mnt/d/master',
        });
        assert.equal(good.ok, true, `healthy injection under custom home must pass: ${JSON.stringify(good)}`);
    });
});

// ---- H5/H6: 逃生门与 marker 判定隔离 ----------------------------------------------
test('H5 逃生门 + 不健康 HOME：reason=HOME_HEALTH_UNSAFE 且 escape=DRDFS_ESCAPE 逐字段', () => {
    withTemp((tmp) => {
        const { root, shim } = makeRepo(tmp);
        const r = validateLaunchConfig({
            repoRoot: root, scriptPath: shim, launcherPath: '/mnt/d/x/launcher.sh',
            forkCli: path.join(root, 'cli.js'),
            godotMcpHome: '/mnt/d/evil', home: HOME,
            sharedMaster: '/mnt/d/master', allowDrvfsPaths: true,
        });
        assert.equal(r.ok, false);
        assert.equal(r.rc, 2);
        assert.equal(r.reason, 'HOME_HEALTH_UNSAFE', 'escape must not rescue unhealthy HOME');
        assert.equal(r.escape, 'DRDFS_ESCAPE', 'escape still reported for stage log even on HOME failure');
    });
});

test('H6 marker 有/无逐位一致：ok/reason/rc/escape 四字段全等（hard-fail 场景）', () => {
    withTemp((tmp) => {
        const { root, shim, launcher } = makeRepo(tmp);
        for (const base of [
            { godotMcpHome: '/mnt/d/evil' },
            { godotMcpHome: path.join(HOME, '.multica'), launcherPath: '/mnt/d/x/l' },
        ]) {
            const input = { repoRoot: root, scriptPath: shim, launcherPath: launcher, forkCli: path.join(root, 'cli.js'), home: HOME, sharedMaster: '/mnt/d/master', ...base };
            const without = validateLaunchConfig(input);
            const withMarker = validateLaunchConfig({ ...input, envInjectedMarker: '1' });
            assert.deepEqual(
                [withMarker.ok, withMarker.reason, withMarker.rc, withMarker.escape],
                [without.ok, without.reason, without.rc, without.escape],
                'marker must leave verdict fields bitwise identical',
            );
        }
    });
});

// ---- H7/H8: /mnt/ 执行路径判定的边界 ----------------------------------------------
test('H7 空 LAUNCHER_PATH / FORK_CLI 不误报 DRDFS_EXEC_PATH', () => {
    withTemp((tmp) => {
        const { root, shim, launcher } = makeRepo(tmp);
        const r1 = validateLaunchConfig({
            repoRoot: root, scriptPath: shim, launcherPath: launcher, forkCli: '',
            godotMcpHome: path.join(HOME, '.multica'), home: HOME, sharedMaster: '/mnt/d/master',
        });
        assert.equal(r1.ok, true);
        assert.equal(r1.reason, 'KOL_HEALTHY');
        const r2 = validateLaunchConfig({
            repoRoot: root, scriptPath: shim, launcherPath: '', forkCli: path.join(root, 'cli.js'),
            godotMcpHome: path.join(HOME, '.multica'), home: HOME, sharedMaster: '/mnt/d/master',
        });
        assert.equal(r2.ok, true);
        assert.equal(r2.escape, '', 'empty exec path must not produce escape');
    });
});

test('H8 /mnt/ 前缀精确：/mnt2 与 /MNT（大小写）不误伤', () => {
    withTemp((tmp) => {
        const { root, shim } = makeRepo(tmp);
        for (const p of ['/mnt2/x/launcher.sh', '/MNT/d/x/launcher.sh', '/home/mnt/x/l']) {
            const r = validateLaunchConfig({
                repoRoot: root, scriptPath: shim, launcherPath: p,
                forkCli: path.join(root, 'cli.js'),
                godotMcpHome: path.join(HOME, '.multica'), home: HOME, sharedMaster: '/mnt/d/master',
            });
            assert.equal(r.ok, true, `${p} must not be treated as a /mnt/ DRDFS path`);
        }
    });
});

// ---- H9-H11: CLI rc 与 stage 行 ---------------------------------------------------
test('H9 CLI hard-fail 退出码精确 == 2（非 1/非其他）', () => {
    withTemp((tmp) => {
        const { root, shim, launcher } = makeRepo(tmp);
        const r = cli(['--repo-root', root, '--shim', shim, '--launcher', launcher,
            '--fork-cli', path.join(root, 'cli.js'), '--home', HOME,
            '--godot-mcp-home', '/mnt/d/evil', '--shared-master', '/mnt/d/master']);
        assert.equal(r.status, 2, `CLI hard fail must exit exactly 2, got ${r.status}`);
    });
});

test('H10 CLI ok 路径 stderr stage 行：KOL_HEALTHY 与 NON_KOL 两种形态', () => {
    withTemp((tmp) => {
        const { root, shim, launcher } = makeRepo(tmp);
        const ok = cli(['--repo-root', root, '--shim', shim, '--launcher', launcher,
            '--fork-cli', path.join(root, 'cli.js'), '--home', HOME,
            '--godot-mcp-home', path.join(HOME, '.multica'), '--shared-master', '/mnt/d/master']);
        assert.equal(ok.status, 0);
        assert.ok(ok.stderr.includes('ok=true reason=KOL_HEALTHY'), `got ${JSON.stringify(ok.stderr)}`);
        const non = cli(['--repo-root', '/tmp', '--shim', shim, '--launcher', launcher,
            '--fork-cli', path.join(root, 'cli.js'), '--home', HOME, '--godot-mcp-home', '/any']);
        assert.equal(non.status, 0);
        assert.ok(non.stderr.includes('ok=true reason=NON_KOL'), `got ${JSON.stringify(non.stderr)}`);
    });
});

test('H11 CLI escape-ok 输出完整 DRDFS_STAGE_LINE 而非 ok= 行（Refacty 交接断言形态）', () => {
    withTemp((tmp) => {
        const { root, shim } = makeRepo(tmp);
        const r = cli(['--repo-root', root, '--shim', shim, '--launcher', '/mnt/d/x/launcher.sh',
            '--fork-cli', path.join(root, 'cli.js'), '--home', HOME,
            '--godot-mcp-home', path.join(HOME, '.multica'), '--shared-master', '/mnt/d/master',
            '--allow-drvfs']);
        assert.equal(r.status, 0);
        assert.ok(r.stderr.includes('stage=DRDFS_ESCAPE'), `escape-ok must emit the DRDFS stage line, got ${JSON.stringify(r.stderr)}`);
        assert.ok(!r.stderr.includes('ok='), 'escape line replaces the ok= line entirely (launcher case-matches *DRDFS_ESCAPE*)');
        assert.ok(!r.stderr.includes(LAUNCHER_STAGE_LINE.slice(0, 40)), 'no CONFIG_VALIDATE line on escape path');
    });
});

test('H12 逃生门 stage 常量与 CLI 输出逐字一致（DRDFS_STAGE_LINE 钉死）', () => {
    withTemp((tmp) => {
        const { root, shim } = makeRepo(tmp);
        const r = cli(['--repo-root', root, '--shim', shim, '--launcher', '/mnt/d/x/l',
            '--fork-cli', path.join(root, 'cli.js'), '--home', HOME,
            '--godot-mcp-home', path.join(HOME, '.multica'), '--shared-master', '/mnt/d/master',
            '--allow-drvfs']);
        assert.ok(r.stderr.trim().endsWith(DRDFS_STAGE_LINE), `stderr must end with the exact DRDFS_STAGE_LINE, got ${JSON.stringify(r.stderr)}`);
    });
});
