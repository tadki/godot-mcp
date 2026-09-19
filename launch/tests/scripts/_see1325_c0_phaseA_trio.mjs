#!/usr/bin/env node
// C0 §SPEC-001 Phase A（构造态驱动）：warm 后 SIGKILL editor（崩溃模拟），
// 再 SIGKILL 整条 shim/launcher/proxy 链（跳过干净退出 → 无 intentional_release
// / released_at 痕迹），留下「lease active + editor 死 + reaper 未对它跑」三要素态。
// 用法: node _see1325_c0_phaseA_trio.mjs <agentLabel> <timeoutMs> <worktree>
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.resolve(HERE, '../../godot-mcp-shim.mjs');
const label = process.argv[2] || 'C0Probe';
const timeoutMs = Number(process.argv[3] || 420000);
const worktree = process.argv[4] || '';

const proc = spawn(process.execPath, [SHIM, label], { stdio: ['pipe', 'pipe', 'pipe'] });
const stderrLines = [];
createInterface({ input: proc.stderr, terminal: false }).on('line', (l) => stderrLines.push(l));

const t0 = Date.now();
const send = (o) => proc.stdin.write(`${JSON.stringify(o)}\n`);
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
const retryTimer = setInterval(() => {
    if (Date.now() - t0 > timeoutMs) return;
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'godot_project', arguments: { action: 'get_info' } } });
}, 3000);
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'godot_project', arguments: { action: 'get_info' } } }), 500);

const warmResult = await new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve({ ok: false, reason: 'warm timeout', elapsedMs: Date.now() - t0 }), timeoutMs);
    proc.stdout.on('data', (d) => {
        buf += d.toString();
        for (const line of buf.split('\n')) {
            if (!line.includes('"id":2')) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.error && msg.error.data && msg.error.data.retryable) continue;
            clearTimeout(timer);
            resolve({ ok: !msg.error, elapsedMs: Date.now() - t0, response: msg });
            return;
        }
    });
});

// ---- 构造三要素态：SIGKILL editor → SIGKILL 整链进程树（无干净退出痕迹）----
function killEditorByWorktree(wt) {
    // 只杀打开本 worktree 的 Godot（own-process 约束：本测试自有的 editor 实例）。
    // Godot 的 --path 显示为 \\wsl.localhost\... 反斜杠形式；用目录名段匹配。
    const dirName = wt.split('/').filter(Boolean).pop();
    const ps = `(Get-CimInstance Win32_Process -Filter "Name like 'Godot%'" | Where-Object { $_.CommandLine -like '*${dirName}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; 'done')`;
    try {
        return String(execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 20000, env: { ...process.env, PATH: `${process.env.PATH}:/mnt/c/Windows/System32/WindowsPowerShell/v1.0` } })).trim();
    } catch (e) { return `pwsh-error: ${e.message}`; }
}

function killTree(pid) {
    // 收集整棵进程树再逐一 SIGKILL（SIGKILL 父进程不会带走子树，
    // 否则存活的 proxy 会走 editor_gone 干净释放路径污染三要素态）。
    const kids = [];
    const walk = (p) => {
        kids.push(p);
        try {
            for (const line of execFileSync('ps', ['-o', 'pid=', '--ppid', String(p)], { encoding: 'utf8' }).split('\n')) {
                const c = parseInt(line.trim(), 10);
                if (c) walk(c);
            }
        } catch { /* gone */ }
    };
    walk(pid);
    for (const p of kids) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
    return kids.length;
}

let sidecarAfter = null;
let killInfo = null;
if (warmResult.ok) {
    killInfo = { editor: killEditorByWorktree(worktree) };
    await new Promise((r) => setTimeout(r, 1200));
    killInfo.treeSize = killTree(proc.pid);
}
await new Promise((r) => setTimeout(r, 800));

const sidecarPath = path.join(worktree, '.godot', 'mcp-lease.json');
try { sidecarAfter = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')); } catch { /* absent */ }
console.log(JSON.stringify({ warmResult, killInfo, sidecarAfter, stderrTail: stderrLines.slice(-15) }, null, 1));
