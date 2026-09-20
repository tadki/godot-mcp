#!/usr/bin/env node
// SEE-1244 §9.2 — shim direct-answer protocol unit tests (spawn-based, real stdio).
//
// Covers:
//   - initialize: echoes the client's protocolVersion; serverInfo version is
//     the shim marker kol-proxy-shim-1.0; responds <1s (AC-2 unit bound)
//   - tools/list: cache miss → placeholder (source=placeholder in log);
//     cache hit → cached tools returned verbatim (source=cache)
//   - ping → empty result object
//   - invalid JSON line does not crash the shim
//   - stdin EOF exits cleanly (code 0)
//
// Run: node .dev/godot-mcp/tests/scripts/test_see1244_shim_handshake.mjs
// Env: KOL_SEE1244_TEST_HOME to redirect ~/.multica (isolated per test).

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SHIM_PATH = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../launch/godot-mcp-shim.mjs');
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'see1244-handshake-'));

let PASS = 0, FAIL = 0;
const failures = [];
function ok(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  [PASS] ${name}`); }
    else { FAIL++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

function startShim(extraEnv = {}) {
    const proc = spawn(process.execPath, [SHIM_PATH, 'HandshakeTest'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
            ...process.env,
            HOME: TEST_HOME,
            // SEE-1328 H2 guard 适配：fresh temp HOME 下注入合法 GODOT_MCP_HOME
            // （模拟 daemon 合法注入形态），防 KOL 签名 + NEUTRAL 默认误判 hard fail。
            GODOT_MCP_HOME: path.join(TEST_HOME, '.multica'),
            MULTICA_AGENT_NAME: '', CLAUDE_AGENT_NAME: '', KOL_AGENT_NAME: '',
            KOL_AGENT_NAME_OVERRIDE: undefined,
            ...extraEnv,
        },
    });
    const outLines = [];
    const errLines = [];
    createInterface({ input: proc.stdout, terminal: false, crlfDelay: Infinity }).on('line', (l) => outLines.push(l));
    createInterface({ input: proc.stderr, terminal: false, crlfDelay: Infinity }).on('line', (l) => errLines.push(l));
    proc.outLines = outLines;
    proc.errLines = errLines;
    return proc;
}

function send(proc, obj) {
    proc.stdin.write(`${JSON.stringify(obj)}\n`);
}

function waitFor(proc, pred, timeoutMs = 5000) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            const found = proc.outLines.find(pred);
            if (found) return resolve(found);
            if (Date.now() - t0 > timeoutMs) return reject(new Error('waitFor timeout'));
            setTimeout(tick, 20);
        };
        tick();
    });
}

// Wait for the shim to be logically ready: SHIM_START has been logged AND the
// background chain spawn attempt has been logged (spawn-skipped is fine — the
// launcher may not exist from a hostile cwd).
async function waitShimStarted(proc) {
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
        if (proc.errLines.some((l) => l.includes('SHIM_START'))) return;
        await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('SHIM_START never logged');
}

section('initialize echo + latency');
{
    const proc = startShim();
    await waitShimStarted(proc);
    const t0 = Date.now();
    send(proc, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    const line = await waitFor(proc, (l) => l.includes('"id":1') && l.includes('serverInfo'));
    const resp = JSON.parse(line);
    const elapsed = Date.now() - t0;
    ok('protocolVersion echoes client request', resp.result.protocolVersion === '2025-06-18', resp.result.protocolVersion);
    ok('serverInfo.name is godot-mcp', resp.result.serverInfo.name === 'godot-mcp');
    ok('serverInfo.version carries shim marker', resp.result.serverInfo.version === 'kol-proxy-shim-1.0');
    ok('capabilities.tools.listChanged declared', resp.result.capabilities?.tools?.listChanged === true);
    ok('initialize answered <1s (AC-2 unit bound)', elapsed < 1000, `${elapsed}ms`);
    ok('SHIM_ANSWER_INIT logged with elapsed_ms', proc.errLines.some((l) => /SHIM_ANSWER_INIT elapsed_ms=\d+ protocol=2025-06-18/.test(l)));

    // protocolVersion fallback when client omits it
    send(proc, { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
    const l2 = await waitFor(proc, (l) => l.includes('"id":2') && l.includes('serverInfo'));
    ok('missing protocolVersion falls back to 2024-11-05', JSON.parse(l2).result.protocolVersion === '2024-11-05');
    proc.stdin.end();
    const code = await new Promise((r) => proc.on('exit', r));
    ok('stdin EOF → exit code 0', code === 0, `code=${code}`);
}

section('tools/list: cache miss → placeholder');
{
    // fresh HOME → no cache file → placeholder
    const proc = startShim();
    await waitShimStarted(proc);
    send(proc, { jsonrpc: '2.0', id: 10, method: 'tools/list' });
    const line = await waitFor(proc, (l) => l.includes('"id":10') && l.includes('tools'));
    const resp = JSON.parse(line);
    ok('cache miss returns non-empty tools', Array.isArray(resp.result.tools) && resp.result.tools.length > 0, `n=${resp.result.tools?.length}`);
    ok('placeholder tools carry godot_ui_inspect (§5骨架含 proxy 工具)', resp.result.tools.some((t) => t.name === 'godot_ui_inspect'));
    ok('placeholder description self-describes', resp.result.tools[0].description.includes('[godot-mcp placeholder]'));
    ok('SHIM_ANSWER_TOOLS source=placeholder logged', proc.errLines.some((l) => /SHIM_ANSWER_TOOLS source=placeholder /.test(l)));
    proc.stdin.end();
    await new Promise((r) => proc.on('exit', r));
}

section('tools/list: cache hit');
{
    // SEE-1292 §DECPL-001: the shim resolves its state dir from GODOT_MCP_HOME
    // (default ${HOME}/.config/godot-mcp, NOT the legacy ~/.multica) — seed the
    // cache at the path the shim actually reads under the sandboxed HOME.
    const cacheDir = path.join(TEST_HOME, '.multica');
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheTools = [
        { name: 'godot_exec', description: 'real exec schema', inputSchema: { type: 'object', properties: { action: { type: 'string' } } } },
        { name: 'godot_ui_inspect', description: 'real patched inspect', inputSchema: { type: 'object' } },
    ];
    fs.writeFileSync(path.join(cacheDir, 'godot-mcp-tools-cache-handshaketest.json'), JSON.stringify({
        schema: 1, fork: '1700000000000', updated_at: new Date().toISOString(), tools: cacheTools,
    }));
    const proc = startShim();
    await waitShimStarted(proc);
    send(proc, { jsonrpc: '2.0', id: 11, method: 'tools/list' });
    const line = await waitFor(proc, (l) => l.includes('"id":11') && l.includes('tools'));
    const resp = JSON.parse(line);
    ok('cache hit returns cached list verbatim', JSON.stringify(resp.result.tools) === JSON.stringify(cacheTools));
    ok('SHIM_ANSWER_TOOLS source=cache logged', proc.errLines.some((l) => /SHIM_ANSWER_TOOLS source=cache tools=2/.test(l)));
    ok('cache_age_s reported as number', proc.errLines.some((l) => /SHIM_ANSWER_TOOLS source=cache tools=2 cache_age_s=\d+/.test(l)));
    proc.stdin.end();
    await new Promise((r) => proc.on('exit', r));
}

section('tools/list: corrupt cache → placeholder fallback (D5)');
{
    const cacheDir = path.join(TEST_HOME, '.multica');
    fs.writeFileSync(path.join(cacheDir, 'godot-mcp-tools-cache-handshaketest.json'), '{not-json');
    const proc = startShim();
    await waitShimStarted(proc);
    send(proc, { jsonrpc: '2.0', id: 12, method: 'tools/list' });
    const line = await waitFor(proc, (l) => l.includes('"id":12') && l.includes('tools'));
    const resp = JSON.parse(line);
    ok('corrupt cache falls back to non-empty placeholder', Array.isArray(resp.result.tools) && resp.result.tools.length > 0);
    ok('corruption warned on stderr', proc.errLines.some((l) => l.includes('SHIM_CACHE_WARN') && l.includes('reason=corrupt')));
    ok('placeholder source logged after corrupt cache', proc.errLines.some((l) => /SHIM_ANSWER_TOOLS source=placeholder/.test(l)));
    proc.stdin.end();
    await new Promise((r) => proc.on('exit', r));
}

section('ping + invalid JSON resilience');
{
    const proc = startShim();
    await waitShimStarted(proc);
    send(proc, { jsonrpc: '2.0', id: 20, method: 'ping' });
    const line = await waitFor(proc, (l) => l.includes('"id":20'));
    ok('ping answered with empty result', JSON.parse(line).result && Object.keys(JSON.parse(line).result).length === 0);

    proc.stdin.write('this is not json at all\n\n');
    proc.stdin.write('{"jsonrpc":"2.0","id":21,"method":"ping"}\n');
    const l21 = await waitFor(proc, (l) => l.includes('"id":21'));
    ok('shim survives invalid JSON line and answers next request', JSON.parse(l21).id === 21);
    ok('WARNING logged for invalid line', proc.errLines.some((l) => l.includes('WARNING') && l.includes('invalid JSON')));
    proc.stdin.end();
    await new Promise((r) => proc.on('exit', r));
}

fs.rmSync(TEST_HOME, { recursive: true, force: true });
console.log(`\nSUMMARY: PASS=${PASS} FAIL=${FAIL}`);
if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
