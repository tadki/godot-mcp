#!/usr/bin/env node
// SEE-1325 阶段三第 0 步前置实测（§SPEC-001）— C0 JUnit 套件。
//
// 被测问题：构造「lease 健康 active + editor 已死 + reaper 未跑」三要素态后，
// HEAD（a50d088）的 fast-path（configure-mcp-port.sh 侧 active-lease 短路 +
// proxy ensureEditor 冷分支）是否误判，导致链路无法恢复。
//
// 结论钉死在本套件的断言里（对抗性预设：默认代码是错的——用证据反证）：
//   实测结论 = 未闭合。误判链（2026-09-19 实机，真 editor，隔离 worktree
//   /home/jerry/c0-see1328-worktree + 独立端口 64777 + KOL_REAPER_DISABLED=1）：
//     T0      configure 快路径命中（sidecar active + 无释放痕迹 → 跳过重写，
//             CONFIGURE_SH rc=0 dt=321ms，lease_id 不变）
//     T0+4s   editor 经 schtasks 启动（boot ~45s）
//     T0+4.5s 异步 reaper（configure 触发，REAPER_ASYNC_BEGIN/END +39ms 即返回）
//             在 T0+4.2s 完成 STALE 判定并写入 released_at（age > 120s grace
//             且 proxy_pid 已死）→ 编辑器启动窗口内 lease 被翻转
//     T0+45s  editor 读 sidecar → state=released（"released 40s ago"）→
//             grace 拒绝 → 回退绑定 6550
//     T0+300s proxy 探 64777 永远空等 → warmup 超时，链路死亡
//   即：fast-path 的「lease 健康」判定与异步 reaper 的「stale 释放」在同一
//   spawn 窗口内竞态，最终态对 editor 呈现 released，链路不可自愈。
//   H1 价值锚点实锤：自愈触发滞后 + lease 生命周期与 spawn 窗口竞态。
//   S5 断言形态建议：断言「trio 态下新链 ≤FAILED_EXIT_MS 内 warm 成功」，
//   而非断言 configure 快路径 rc=0（该断言在竞态下无意义）。
//
// Run: node --test --test-reporter=junit launch/tests/e2e/see1325/test_see1325_spec001_trio_probe.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EV = path.join(HERE, 'evidence');
const FORK = path.resolve(HERE, '../../../..');
const CONFIGURE = path.join(FORK, 'launch', 'configure-mcp-port.sh');

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(EV, p), 'utf8'));
// 证据文件依赖防御：本套件断言的对象是 2026-09-19 实机运行的固化证据；在
// 没有证据文件的环境（如 fresh clone 丢 .log）应 skip-with-reason 而非 ENOENT
// fail（C0 收讫裁定：Atlas 2026-09-19）。
function requireEvidence(t, ...names) {
    const missing = names.filter((n) => !fs.existsSync(path.join(EV, n)));
    if (missing.length > 0) t.skip(`evidence file(s) absent: ${missing.join(', ')} — C0 实机证据未随此环境分发，跳过而非误报失败`);
}

test('§SPEC-001 E1 三要素态成立（lease active + 无释放痕迹 + proxy_pid 已死 + 端口闭合）', (t) => {
    requireEvidence(t, 'trio_sidecar_after_phaseA.json');
    const trio = readJson('trio_sidecar_after_phaseA.json');
    assert.equal(trio.state, 'active');
    assert.equal(trio.released_at, null);
    assert.equal(trio.intentional_release ?? null, null);
    assert.ok(Number.isInteger(trio.proxy_pid) && trio.proxy_pid > 0, 'proxy_pid recorded (SEE-1316 self-registration)');
    assert.ok(fs.existsSync(path.join(FORK, 'launch', 'godot-mcp-proxy.mjs')));
});

test('§SPEC-001 E2 fast-path 命中且跳过重写（CONFIGURE_SH rc=0 dt≈321ms，lease_id 不变）', (t) => {
    requireEvidence(t, 'phaseB_proxy_stages.log', 'phaseB_sidecar_after.json', 'trio_sidecar_after_phaseA.json');
    const stages = fs.readFileSync(path.join(EV, 'phaseB_proxy_stages.log'), 'utf8');
    assert.match(stages, /\[stage=CONFIGURE_SH_BEGIN\]/);
    const m = stages.match(/CONFIGURE_SH_END\][^\n]*rc=0 dt_ms=(\d+)/);
    assert.ok(m, 'configure rc=0 recorded');
    assert.ok(Number(m[1]) < 1000, `fast-path configure took ${m[1]}ms — the active-lease short-circuit fired (a full rewrite+reaper wait would exceed 1s)`);
    const after = readJson('phaseB_sidecar_after.json');
    const trio = readJson('trio_sidecar_after_phaseA.json');
    assert.equal(after.lease_id, trio.lease_id, 'lease_id preserved across phase B (fast-path skip-rewrite)');
});

test('§SPEC-001 E3 误判核心证据：异步 reaper 在 editor 启动窗口内翻转 lease（released_at T0+4.5s）', (t) => {
    requireEvidence(t, 'phaseB_proxy_stages.log', 'phaseB_sidecar_after.json', 'trio_sidecar_after_phaseA.json');
    const trio = readJson('trio_sidecar_after_phaseA.json');
    const after = readJson('phaseB_sidecar_after.json');
    const stages = fs.readFileSync(path.join(EV, 'phaseB_proxy_stages.log'), 'utf8');
    // reaper 由 configure 异步触发（+39ms 返回），但它的后台 STALE 释放落在 spawn 窗口内
    assert.match(stages, /REAPER_ASYNC_BEGIN/, 'configure fired the async reaper');
    const t0 = new Date(trio.configured_at).getTime();
    const releasedAt = new Date(after.released_at).getTime();
    const phaseBBoot = new Date('2026-09-19T22:01:07.000Z').getTime();
    const dtFromBoot = releasedAt - phaseBBoot;
    assert.equal(after.state, 'released', 'reaper flipped the lease DURING the spawn window');
    assert.ok(dtFromBoot > 0 && dtFromBoot < 60000, `released_at is ${dtFromBoot}ms after the fresh chain booted — inside the editor boot window`);
    assert.equal(after.lease_id, trio.lease_id);
    assert.equal(after.intentional_release ?? null, null, 'not an intentional release — reaper stale path');
});

test('§SPEC-001 E4 editor 呈现 released → 回退 6550 → proxy 探 64777 空等 → 300s 超时（链路死亡）', (t) => {
    requireEvidence(t, 'phaseB_editor_port_64777.log', 'phaseB_driver_result.json');
    const editorLog = fs.readFileSync(path.join(EV, 'phaseB_editor_port_64777.log'), 'utf8');
    assert.match(editorLog, /WS_BIND_OK[^\n]*port=6550/, 'editor bound the 6550 fallback (lease rejected)');
    assert.doesNotMatch(editorLog, /WS_BIND_OK[^\n]*port=64777/, 'editor never bound the leased port');
    const driver = readJson('phaseB_driver_result.json');
    assert.equal(driver.ok, false);
    const msg = driver?.response?.error?.message || '';
    assert.match(msg, /warmup timed out after 300s/, `chain died in warmup: ${msg.slice(0, 120)}`);
});

test('§SPEC-001 E5 对照组：干净 active sidecar（同构造、无死亡痕迹）下 configure 快路径同样命中——证明误判不在快路径本身，而在快路径与异步 reaper 的竞态', () => {
    // fixture：同 lease 形态、configured_by_pid/proxy_pid 指向活进程（当前 shell pid），
    // 在隔离 tmp worktree 里跑真 configure，断言快路径 rc=0 且 lease 不被改写。
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec001-ctl-'));
    fs.mkdirSync(path.join(tmp, '.godot'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'project.godot'), '[application]\nconfig/name=CTL\n');
    const sidecar = {
        schema_version: 2, runtime_id: 'CTL-solo', task_id: '', port: 64777, agent: 'CTL',
        label: 'ctl', state: 'active', lease_id: 'ctl-lease-0001', worktree: tmp,
        configured_at: new Date().toISOString(), configured_by_pid: process.pid,
        released_at: null, notes: 'spec001 control', proxy_pid: process.pid,
    };
    fs.writeFileSync(path.join(tmp, '.godot', 'mcp-lease.json'), JSON.stringify(sidecar, null, 1));
    const out = execFileSync('bash', [CONFIGURE, 'CTL', '--port', '64777', '--project-godot', path.join(tmp, 'project.godot')], {
        encoding: 'utf8', timeout: 30000,
        env: { ...process.env, KOL_PORT_ARBITER: 'off', KOL_AGENT_NAME: 'CTL', KOL_WORKTREE: tmp },
    });
    assert.match(out, /Fast path: sidecar already active on port=64777, no stale release traces/, 'control: fast-path fires on a healthy active lease');
    const afterCtl = JSON.parse(fs.readFileSync(path.join(tmp, '.godot', 'mcp-lease.json'), 'utf8'));
    assert.equal(afterCtl.lease_id, 'ctl-lease-0001', 'control: fast-path skipped the rewrite');
    fs.rmSync(tmp, { recursive: true, force: true });
});
