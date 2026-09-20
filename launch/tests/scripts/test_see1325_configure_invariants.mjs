// SEE-1325 §SPEC-009 — configure-mcp-port.sh 加固不变量套件（C-code）。
// 锁死：① stale-traces 清理函数级强制（active+同端口+痕迹 → 重写后双痕迹归零
// 且 lease_id 保留，SEE-1152 82cd3679 回归锁）；② 端口迁移 → predecessor_lease_id
// + LEASE_PORT_MIGRATED stage log；③ /mnt/d 宿主 worktree 字段 Windows 形态
// （D:/...）——阻断项② writer 侧归一。
// Run: node --test --test-reporter=junit launch/tests/scripts/test_see1325_configure_invariants.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FORK = path.resolve(__dirname, '..', '..', '..');
const CONFIGURE = path.join(FORK, 'launch', 'configure-mcp-port.sh');

function makeWorktree(tmp, name) {
    const wt = fs.mkdtempSync(path.join(tmp, `${name}-`));
    fs.writeFileSync(path.join(wt, 'project.godot'), '[application]\nconfig/name=X\n');
    fs.mkdirSync(path.join(wt, '.godot'), { recursive: true });
    return wt;
}

function writeLease(wt, fields) {
    const base = {
        schema_version: 2, runtime_id: 'CTL-solo', task_id: '', port: 64777, agent: 'CTL',
        label: 'ctl', state: 'active', lease_id: 'lease-aaaa', worktree: wt,
        configured_at: new Date().toISOString(), configured_by_pid: process.pid,
        released_at: null, notes: 'test', proxy_pid: process.pid,
    };
    fs.writeFileSync(path.join(wt, '.godot', 'mcp-lease.json'), JSON.stringify({ ...base, ...fields }, null, 1));
}

function runConfigure(wt, port) {
    // configure 的 stage log 走 stderr（_cfg_stage_log → >&2）；spawnSync 分流捕获。
    const r = spawnSync('bash', [CONFIGURE, 'CTL', '--port', String(port), '--project-godot', path.join(wt, 'project.godot')], {
        encoding: 'utf8', timeout: 60000,
        env: { ...process.env, KOL_PORT_ARBITER: 'off', KOL_AGENT_NAME: 'CTL', KOL_WORKTREE: wt },
    });
    return `${r.stdout || ''}${r.stderr || ''}`;
}

test('§SPEC-009 INV1（SEE-1152 回归锁）：active 同端口带 released_at 痕迹 → 重写后痕迹归零 + lease_id 保留', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inv1-'));
    const wt = makeWorktree(tmp, 'wt');
    writeLease(wt, { released_at: new Date().toISOString(), intentional_release: false });
    runConfigure(wt, 64777);
    const after = JSON.parse(fs.readFileSync(path.join(wt, '.godot', 'mcp-lease.json'), 'utf8'));
    assert.equal(after.state, 'active');
    assert.ok(after.released_at === null || after.released_at === undefined, `released_at must be cleared, got ${after.released_at}`);
    assert.notEqual(after.intentional_release, true);
    assert.equal(after.lease_id, 'lease-aaaa', 'lease_id must survive the cleanup rewrite (A2 oracle)');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('§SPEC-009 INV2：端口迁移（64777→64788）→ predecessor_lease_id 落盘 + LEASE_PORT_MIGRATED stage log', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inv2-'));
    const wt = makeWorktree(tmp, 'wt');
    writeLease(wt, { port: 64777 });
    const out = runConfigure(wt, 64788);
    const after = JSON.parse(fs.readFileSync(path.join(wt, '.godot', 'mcp-lease.json'), 'utf8'));
    assert.equal(after.port, 64788);
    assert.equal(after.predecessor_lease_id, 'lease-aaaa', 'predecessor_lease_id must record the pre-migration lease');
    assert.ok(after.predecessor_lease_id !== after.lease_id, 'new lease gets a fresh id on migration');
    assert.match(out, /stage=LEASE_PORT_MIGRATED/, 'stage log required');
    assert.match(out, /predecessor_lease_id=lease-aaaa/);
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('§SPEC-009 INV3：同端口重写不写 predecessor（清理 ≠ 迁移）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inv3-'));
    const wt = makeWorktree(tmp, 'wt');
    writeLease(wt, { port: 64777, released_at: new Date().toISOString() });
    runConfigure(wt, 64777);
    const after = JSON.parse(fs.readFileSync(path.join(wt, '.godot', 'mcp-lease.json'), 'utf8'));
    assert.equal(after.predecessor_lease_id, undefined, 'same-port rewrite must NOT set predecessor');
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('§SPEC-009 INV4（阻断项②）：/mnt/d 宿主 worktree → sidecar worktree 字段为 Windows 形态（D:/...）', () => {
    // 真实 /mnt/d 路径不可在单测里凭空造；用 wslpath 断言 writer 行为——
    // 构造一个 /mnt/<letter> 前缀的假宿主目录（wslpath 对存在的 /mnt 路径有效）。
    const host = '/mnt/c';
    if (!fs.existsSync(host)) return; // 非此环境形态则跳过
    const tmp = fs.mkdtempSync(path.join(host, 'inv4-'));
    try {
        const wt = makeWorktree(path.dirname(tmp), path.basename(tmp));
        writeLease(wt, { port: 64777 });
        runConfigure(wt, 64777);
        const after = JSON.parse(fs.readFileSync(path.join(wt, '.godot', 'mcp-lease.json'), 'utf8'));
        // 断言 Windows 形态且指向同一目录（反斜杠 → 正斜杠、盘符小写对齐）。
        assert.ok(/^[A-Za-z]:[\\/]/.test(after.worktree), `worktree field must be Windows form, got ${after.worktree}`);
        // D:/ 形态映射回同一目录：盘符 'c:' ↔ '/mnt/c'，去冒号后目录段一致。
        const wtNorm = after.worktree.replace(/\\/g, '/').replace(/\/$/, '').replace(':', '').toLowerCase();
        const linNorm = wt.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase().replace(/^\/mnt\//, '');
        assert.equal(wtNorm, linNorm, `D:/ form must map to the same dir: ${after.worktree} vs ${wt}`);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('§SPEC-009 INV5（阻断项①，D-fix 翻新）：.gdignore 为 git track 版 + copy-addon build 保留写回', () => {
    // Owner 定稿方案（SEE-1328 thread 01a0bf51）：gdignore 直接加 git track，
    // 替代 C-code 的 launcher 运行时 touch；copy-addon rmSync 需保留写回。
    const tracked = execFileSync('git', ['-C', FORK, 'ls-files', 'server/addon/.gdignore'], { encoding: 'utf8' }).trim();
    assert.equal(tracked, 'server/addon/.gdignore', '.gdignore must be git-tracked in server/addon/');
    const gdi = fs.readFileSync(path.join(FORK, 'server', 'addon', '.gdignore'), 'utf8');
    assert.match(gdi, /scan-skip|double-register/i, 'tracked .gdignore must carry the WHY comment');
    const copyAddon = fs.readFileSync(path.join(FORK, 'server', 'scripts', 'copy-addon.ts'), 'utf8');
    assert.match(copyAddon, /gdignoreBackup/, 'copy-addon must preserve .gdignore across the rmSync wipe');
    // launcher 运行时 touch 已退役（防回归复活）
    const launcher = fs.readFileSync(path.join(FORK, 'launch', 'godot-mcp-launcher.sh'), 'utf8');
    assert.doesNotMatch(launcher, /touch[^\n]*gdignore/, 'runtime touch of .gdignore must stay retired (track版替代)');
});
