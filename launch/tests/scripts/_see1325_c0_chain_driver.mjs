#!/usr/bin/env node
// C0 §SPEC-001 链路驱动器：spawn 真 shim 链，发 initialize + tools/call，
// 等 warm 应答（保持 stdin 打开直到收到 id 或超时）。输出 JSON 结果到 stdout。
// 用法: node _see1325_c0_chain_driver.mjs <agentLabel> <timeoutMs>
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.resolve(HERE, '../../godot-mcp-shim.mjs');
const label = process.argv[2] || 'C0Probe';
const timeoutMs = Number(process.argv[3] || 240000);

const proc = spawn(process.execPath, [SHIM, label], { stdio: ['pipe', 'pipe', 'pipe'] });
const stderrLines = [];
createInterface({ input: proc.stderr, terminal: false }).on('line', (l) => stderrLines.push(l));

const t0 = Date.now();
const send = (o) => proc.stdin.write(`${JSON.stringify(o)}\n`);
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
// shim 在链 warm 前应答 retryable 瞬态错误 —— 像真实 agent 一样重试直到 warm。
const retryTimer = setInterval(() => {
    if (Date.now() - t0 > timeoutMs) { clearInterval(retryTimer); return; }
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'godot_project', arguments: { action: 'get_info' } } });
}, 2000);
setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'godot_project', arguments: { action: 'get_info' } } }), 300);

const result = await new Promise((resolve) => {
    let buf = '';
    const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout', elapsedMs: Date.now() - t0 }), timeoutMs);
    proc.stdout.on('data', (d) => {
        buf += d.toString();
        for (const line of buf.split('\n')) {
            if (!line.includes('"id":2')) continue;
            let msg;
            try { msg = JSON.parse(line); } catch { continue; }
            if (msg.error && msg.error.data && msg.error.data.retryable) continue; // transient, keep waiting
            clearInterval(retryTimer);
            clearTimeout(timer);
            resolve({ ok: !msg.error, elapsedMs: Date.now() - t0, response: msg });
            return;
        }
    });
    proc.on('exit', (code) => { clearTimeout(timer); resolve({ ok: false, reason: `chain exit ${code}`, elapsedMs: Date.now() - t0 }); });
});

proc.stdin.end();
proc.kill('SIGKILL');
console.log(JSON.stringify({ ...result, stderrTail: stderrLines.slice(-40) }, null, 1));
