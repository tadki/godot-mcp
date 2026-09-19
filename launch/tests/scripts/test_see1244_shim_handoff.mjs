#!/usr/bin/env node
// SEE-1244 §9.2 — shim handoff unit tests (T1/T2 triggers, pipe splice, thunk mode).
//
// Covers:
//   - T1: first tools/call triggers handoff; the call line is flushed to the
//     mock chain's stdin (proxy B1 holds it warm-side; shim just forwards)
//   - T2: first parseable JSON frame on chain stdout triggers handoff
//   - after handoff shim is a pure thunk: a second tools/list is NOT answered
//     locally (it reaches the chain stdin untouched)
//   - chain death post-handoff → shim exits (die chain_died)
//   - notifications/initialized is dropped (never reaches chain stdin)
//
// Run: node .dev/godot-mcp/tests/scripts/test_see1244_shim_handoff.mjs

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = path.resolve(HERE, '../../../launch/godot-mcp-shim.mjs');

let PASS = 0, FAIL = 0;
const failures = [];
function ok(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  [PASS] ${name}`); }
    else { FAIL++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

// Mock chain: an echo server on stdio. Every line it receives on stdin is
// echoed back on stdout with {"echo":...}; --die exits after the first line.
const MOCK_CHAIN = `${HERE}/_see1244_mock_chain.mjs`;

function startShimWithChain(mockArgs, extraEnv = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'see1244-handoff-'));
    const proc = spawn(process.execPath, [SHIM_PATH, 'HandoffTest'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
            ...process.env,
            HOME: home,
            // SEE-1328 H2 guard 适配：fresh temp HOME 下注入合法 GODOT_MCP_HOME
            // （模拟 daemon 合法注入形态），防 KOL 签名 + NEUTRAL 默认误判 hard fail。
            GODOT_MCP_HOME: path.join(home, '.multica'),
            KOL_AGENT_NAME: '', CLAUDE_AGENT_NAME: '', MULTICA_AGENT_NAME: '',
            KOL_SEE1244_LAUNCHER_OVERRIDE: [process.execPath, MOCK_CHAIN, ...(mockArgs || [])].join(' '),
            KOL_SEE1244_ALLOW_TEST_OVERRIDE: '1',
            ...extraEnv,
        },
    });
    proc.testHome = home;
    const outLines = [], errLines = [];
    createInterface({ input: proc.stdout, terminal: false, crlfDelay: Infinity }).on('line', (l) => outLines.push(l));
    createInterface({ input: proc.stderr, terminal: false, crlfDelay: Infinity }).on('line', (l) => errLines.push(l));
    proc.outLines = outLines;
    proc.errLines = errLines;
    return proc;
}

function waitFor(proc, pred, timeoutMs = 8000, what = 'condition') {
    const t0 = Date.now();
    const predFn = typeof pred === 'string' ? (l) => l.includes(pred)
        : (pred instanceof RegExp) ? (l) => pred.test(l)
        : pred;
    return new Promise((resolve, reject) => {
        const tick = () => {
            const found = proc.errLines.find(predFn) || proc.outLines.find(predFn);
            if (found) return resolve(found);
            if (Date.now() - t0 > timeoutMs) {
                return reject(new Error(`waitFor timeout: ${what}\n  stderr=${JSON.stringify(proc.errLines)}\n  stdout=${JSON.stringify(proc.outLines)}`));
            }
            setTimeout(tick, 20);
        };
        tick();
    });
}

async function cleanup(proc) {
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
    try { fs.rmSync(proc.testHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// The shim spawns `bash <launcher>`, but for tests we redirect the spawn via
// the test-only KOL_SEE1244_LAUNCHER_OVERRIDE seam (documented in the shim):
// it substitutes the whole chain command with the mock stdio process below.

section('T1: first tools/call triggers handoff and call is flushed to chain');
{
    const proc = startShimWithChain([]);
    await waitFor(proc, 'SHIM_SPAWN_CHAIN', 8000, 'chain spawn');
    // Give the mock chain a moment to boot; then make the first call.
    await new Promise((r) => setTimeout(r, 300));
    const call = { jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'godot_project', arguments: { action: 'get_info' } } };
    proc.stdin.write(`${JSON.stringify(call)}\n`);
    // Mock chain echoes the call back on its stdout; shim forwards it to us.
    const echo = await waitFor(proc, (l) => l.includes('"id":30') && l.includes('MOCK_CHAIN_ECHO'), 8000, 'call echo');
    ok('tools/call reached chain and response came back', !!echo);
    ok('SHIM_HANDOFF_BEGIN trigger=first_call logged', proc.errLines.some((l) => /SHIM_HANDOFF_BEGIN trigger=first_call/.test(l)));
    ok('SHIM_HANDOFF_DONE logged', proc.errLines.some((l) => /SHIM_HANDOFF_DONE/.test(l)));

    // Post-handoff thunk: a tools/list must NOT be answered locally (no shim
    // answer payload) — it flows to the chain, whose echo marks it.
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'tools/list' })}\n`);
    const echo31 = await waitFor(proc, (l) => l.includes('"id":31') && l.includes('MOCK_CHAIN_ECHO'), 8000, 'thunk passthrough');
    ok('post-handoff tools/list forwarded as thunk (not locally answered)', !!echo31);
    ok('no local tools/list answer post-handoff', !proc.outLines.some((l) => l.includes('"id":31') && !l.includes('MOCK_CHAIN_ECHO')));
    await cleanup(proc);
}

section('T2: chain stdout first JSON frame triggers handoff (no tools/call)');
{
    const proc = startShimWithChain(['--emit-frame']);
    await waitFor(proc, 'SHIM_CHAIN_STDOUT_OPEN', 8000, 'chain stdout open');
    await waitFor(proc, /SHIM_HANDOFF_BEGIN trigger=proxy_ready/, 8000, 'T2 handoff');
    ok('T2 proxy_ready handoff fired on first JSON frame', true);
    ok('T2 precedes any tools/call (no call was sent)', !proc.outLines.some((l) => l.includes('tools/call')));
    // Buffered pre-handoff chain frames are drained to claude at handoff (the
    // drained probe frame carries the mock's notifications/probe payload).
    const drained = proc.outLines.some((l) => l.includes('notifications/probe'));
    ok('pre-handoff buffered chain frame drained to claude stdout', drained,
        JSON.stringify(proc.outLines));
    await cleanup(proc);
}

section('notifications/initialized dropped pre-handoff (never forwarded)');
{
    const proc = startShimWithChain([]);
    await waitFor(proc, 'SHIM_SPAWN_CHAIN', 8000, 'chain spawn');
    await new Promise((r) => setTimeout(r, 300));
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await new Promise((r) => setTimeout(r, 500));
    // Trigger handoff with a call; the mock chain will echo everything it got.
    // Scope the assertion to lines echoed AFTER id:40 lands — the mock's own
    // boot frame (notifications/ready) must not be confused with a forwarded
    // notifications/initialized.
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'godot_scene', arguments: {} } })}\n`);
    await waitFor(proc, (l) => l.includes('"id":40') && l.includes('MOCK_CHAIN_ECHO'), 8000, 'call echo');
    const idx40 = proc.outLines.findIndex((l) => l.includes('"id":40') && l.includes('MOCK_CHAIN_ECHO'));
    const chainSawInitialized = proc.outLines.slice(idx40).some((l) => l.includes('notifications/initialized'));
    ok('initialized notification NOT forwarded to chain', !chainSawInitialized, JSON.stringify(proc.outLines.filter((l) => l.includes('initialized'))));
    await cleanup(proc);
}

section('post-handoff chain death → shim exits (D4 = current proxy-death semantics)');
{
    const proc = startShimWithChain(['--die-after-echo']);
    await waitFor(proc, 'SHIM_SPAWN_CHAIN', 8000, 'chain spawn');
    await new Promise((r) => setTimeout(r, 300));
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 50, method: 'tools/call', params: { name: 'godot_exec', arguments: {} } })}\n`);
    const exitCode = await new Promise((resolve) => {
        const t0 = Date.now();
        proc.on('exit', (code) => resolve(code));
        setTimeout(() => resolve('timeout'), 8000);
    });
    ok('shim exits after chain death (no hang)', exitCode === 1, `exit=${exitCode}`);
    ok('SHIM_DIE reason=chain_died logged', proc.errLines.some((l) => l.includes('SHIM_DIE') && l.includes('chain_died')));
    await cleanup(proc);
}

console.log(`\nSUMMARY: PASS=${PASS} FAIL=${FAIL}`);
if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
