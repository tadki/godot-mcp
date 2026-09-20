#!/usr/bin/env node
// SEE-1328 A-recheck — D1 修复 A/B 实机验证（测试脚本，跑在各检出真 launch 文件上）。
// 用法: node see1328_abtest_d1.mjs <launch-dir>   （launch-dir 指向被测 launch/ 目录）
//   A 组（before 46fdccb）预期: 输出含 DRDFS_ESCAPE（D1 复现）
//   B 组（after  f750d0d）    输出零 DRDFS_ESCAPE 字节
// 判据独立的两个互斥探针；套件级对比断言由 node--test 包装（run 内联 junit 不需要——
// 直接由 caller 比较两侧输出）。

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const launchDir = process.argv[2];
if (!launchDir) { console.error('usage: node see1328_abtest_d1.mjs <launch-dir>'); process.exit(64); }
const HOME = os.homedir();

// non-KOL standalone fixture（A-qa R4 复现形态；无 project.godot 于 repo root、无 kol-mcp.env）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'see1328-ab-'));
const root = fs.mkdtempSync(path.join(tmp, 'standalone-'));
fs.mkdirSync(path.join(root, 'launch'), { recursive: true });

// 真实 launcher 拷贝到 standalone fixture（A 组将复现 D1）
const launcherSrc = path.join(launchDir, 'godot-mcp-launcher.sh');
const shimSrc = path.join(launchDir, 'godot-mcp-shim.mjs');
for (const f of fs.readdirSync(launchDir)) {
    if (/\.(sh|mjs)$/.test(f)) fs.copyFileSync(path.join(launchDir, f), path.join(root, 'launch', f));
}
fs.chmodSync(path.join(root, 'launch', 'godot-mcp-launcher.sh'), 0o755);

// launcher 真进程（validate 通过后走到 agent-ports 层报错 —— 与 A-qa R4 相同短路形态）
const r = spawnSync('bash', [path.join(root, 'launch', 'godot-mcp-launcher.sh')], {
    env: { ...process.env, GODOT_MCP_HOME: path.join(HOME, '.config', 'godot-mcp'), HOME },
    encoding: 'utf8', timeout: 15000, input: '',
});

fs.rmSync(tmp, { recursive: true, force: true });

const out = {
    stderr: r.stderr || '',
    status: r.status,
    launcherSrc,
};
console.log(JSON.stringify(out, null, 1));
