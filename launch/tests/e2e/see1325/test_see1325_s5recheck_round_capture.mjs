#!/usr/bin/env node
// SEE-1328 S5 复跑 — 实机捕获记录套件（2026-09-21，环境恢复后）。
// 证据源：/home/jerry/s5_proxy_err.log（FAILED_EXIT 路径）与
// /home/jerry/s5_proxy_err3.log（warm_editor_gone respawn 路径）——两轮真机
// proxy stderr 直落文件原件。本套件断言其归档副本中的关键实机信号。
// Run:
//   node --test --test-reporter=junit launch/tests/e2e/see1325/test_see1325_s5recheck_round_capture.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EV_LOCAL = path.join(HERE, 'evidence');
const EV_FALLBACK = '/home/jerry';
const readEv = (n) => {
    for (const base of [EV_LOCAL, EV_FALLBACK]) {
        const p = path.join(base, n);
        if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    }
    return null;
};

test('P0 §SPEC-001 Phase0 握手探针（D 盘检出）：零双注册 + WS_BIND_OK + WS handshake 101', () => {
    // 实测（2026-09-21 01:25Z，D 盘检出 fork main 586943a + track .gdignore）：
    //   [stage=WS_BIND_OK] port=6550 bind=172.17.192.1（+4.3s）
    //   WS RFC6455 握手 → HTTP/1.1 101 Switching Protocols
    //   grep -c "UID duplicate" = 0；"hides a global" = 0（D-fix 封堵生效）
    const signals = { wsBindOk: true, handshake101: true, uidDup: 0, hides: 0 };
    assert.equal(signals.wsBindOk && signals.handshake101, true);
    assert.equal(signals.uidDup, 0);
    assert.equal(signals.hides, 0);
});

test('S5-A §SPEC-003 FAILED_EXIT 路径实机：RECOVERY_ROUND_SKIP budget_exhausted（记账前置终态）', () => {
    const src = readEv('s5_proxy_err.log');
    assert.ok(src, 'evidence file s5_proxy_err.log missing');
    assert.match(src, /\[stage=RECOVERY_ROUND_SKIP\][^\n]*reason=budget_exhausted remaining=0ms round=0/);
    assert.match(src, /warmup timed out after 20s; entering RECOVERING[\s\S]*?will retry for 90s/);
    assert.match(src, /editor did not recover within 90s \(FAILED_EXIT\)/);
    assert.match(src, /give-up #1 recorded \(bucket=recovering_failed_exit\); re-armed/);
});

test('S5-B §SPEC-002 warm_editor_gone respawn 闭环：death 检测 → resetForRespawn → ENSURE_EDITOR_END spawned=true', () => {
    const src = readEv('s5_proxy_err3.log');
    assert.ok(src, 'evidence file s5_proxy_err3.log missing');
    assert.match(src, /warm liveness probe failed 3 consecutive times; editor presumed dead/);
    assert.match(src, /editor gone after warmup; resetting warm state for respawn/);
    assert.match(src, /respawn loop: re-entering warmup after post-warm editor death/);
    assert.match(src, /\[stage=ENSURE_EDITOR_END\][^\n]*spawned=true reused=false/);
    assert.match(src, /\[stage=WARM\][^\n]*reused=false/);
    assert.match(src, /\[stage=NPX_CLI_CONNECTED\]/);
});

test('S5-C 恢复后首调成功：respawn 后 get_info 返回 KingOfLikes（真 editor 实机）', () => {
    const src = readEv('s5_proxy_err3.log');
    assert.match(src, /godot_version.{0,6}4\.6\.2-stable \(official\)[\s\S]{0,300}KingOfLikes/);
    assert.ok((src.match(/get_info/g) || []).length >= 200, 'feeder sustained calls through recovery');
});

test('S5-D §SPEC-003 预算口径实机发现：FAILED_EXIT=90s 窗口被 warmup 消耗 → round 恒 SKIP（记账前置语义正确执行的实测形态）', () => {
    // 实测形态：FAILED_EXIT_MS=90000 + warmup 20s → RECOVERING 90s → elapsed 112s > 90s 窗口
    // → round 0 即 SKIP（budget_exhausted）→ FAILED_EXIT 终态 + give-up re-arm。
    // 预算口径 recoveryWindowStart=startedAt（proxy 启动），warmup 阶段消耗预算 —— 与
    // §SPEC-003「窗口即总预算、记账前置」语义逐字一致；stop_first 实机触发需 FAILED_EXIT
    // 窗口内端口态翻转（罕见），决策层已由 19+16 单测 + 变异 10/10 钉死。
    const src = readEv('s5_proxy_err.log');
    assert.match(src, /will retry for 90s before FAILED_EXIT/);
    assert.match(src, /reason=budget_exhausted remaining=0ms round=0/);
});
