#!/usr/bin/env node
// SEE-1244 改动 C/D (decision 01a08059) — shim transient answer + chain revival
// state machine tests (spawn-based, real stdio).
//
// Covers:
//   R1  T1 lands while the chain is dead & backoff pending → structured
//       retryable transient error with data.state='chain_restarting',
//       retryable:true, retry_after_s; shim stays alive and in direct-answer
//       mode (subsequent tools/list still answered — server never disappears)
//   R2  revival: mock chain dies once, shim respawns (SHIM_RECHAIN log), and
//       a POST-revival call reaches the live chain (T1/splice, no latch)
//   R3  exhaustion: KOL_SHIM_RECHAIN_MAX=0 → first death settles
//       chain_exhausted; T1 gets retryable:false terminal error naming the
//       launcher log
//   R4  rechain log stream: SHIM_RECHAIN state=chain_restarting lines carry
//       attempt counters and backoff delays
//
// Run: node .dev/godot-mcp/tests/scripts/test_see1244_rechain.mjs

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

function startShim(env) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'see1244-rechain-'));
    const proc = spawn(process.execPath, [SHIM_PATH, 'RechainTest'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home, GODOT_MCP_HOME: path.join(home, '.multica'), ...env },
    });
    const outLines = [], errLines = [];
    createInterface({ input: proc.stdout, terminal: false, crlfDelay: Infinity }).on('line', (l) => outLines.push(l));
    createInterface({ input: proc.stderr, terminal: false, crlfDelay: Infinity }).on('line', (l) => errLines.push(l));
    proc.outLines = outLines; proc.errLines = errLines; proc.testHome = home;
    return proc;
}
async function cleanup(proc) {
    try { proc.kill('SIGKILL'); } catch { /* gone */ }
    try { fs.rmSync(proc.testHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}
async function waitFor(proc, pred, timeoutMs = 10000, what = 'condition') {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        const found = proc.outLines.find(pred) || proc.errLines.find(pred);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`waitFor timeout: ${what}\n  stderr=${JSON.stringify(proc.errLines.slice(-6))}`);
}
function send(proc, obj) { proc.stdin.write(`${JSON.stringify(obj)}\n`); }

section("R1: T1 during backoff → structured retryable transient, server stays alive");
{
    // launcher missing → exit → scheduleRechain(exit_1) → backoff pending
    const proc = startShim({ KOL_SEE1244_LAUNCHER_OVERRIDE: '/nonexistent/launcher.sh', KOL_SEE1244_ALLOW_TEST_OVERRIDE: '1' });
    await new Promise((r) => setTimeout(r, 400)); // first spawn + death + rechain scheduled
    send(proc, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'godot_project', arguments: { action: 'get_info' } } });
    const line = await waitFor(proc, (l) => l.includes('"id":7') && l.includes('"error"'), 8000, 'transient answer');
    const m = JSON.parse(line);
    ok('R1 transient error code -32000', m.error.code === -32000);
    ok('R1 data.state=chain_restarting', m.error.data?.state === 'chain_restarting', JSON.stringify(m.error.data));
    ok('R1 retryable:true', m.error.data?.retryable === true);
    ok('R1 retry_after_s present', typeof m.error.data?.retry_after_s === 'number');
    // Server stays alive: tools/list still answered afterwards
    send(proc, { jsonrpc: '2.0', id: 8, method: 'tools/list' });
    const tl = await waitFor(proc, (l) => l.includes('"id":8') && l.includes('"tools"'), 5000, 'tools/list after transient');
    ok('R1 server still alive (tools/list answered post-transient)', Array.isArray(JSON.parse(tl).result.tools) && JSON.parse(tl).result.tools.length > 0);
    await cleanup(proc);
}

section("R2: chain dies once → shim respawns → post-revival call reaches the live chain");
{
    const flag = '/tmp/see1244-rechain-flag';
    try { fs.rmSync(flag, { force: true }); } catch { /* absent */ }
    // mock: first spawn dies (creates flag), later spawns serve
    const mock = `${HERE}/_see1244_rechain_mock.mjs`;
    const proc = startShim({ KOL_SEE1244_LAUNCHER_OVERRIDE: `node ${mock}`, KOL_SEE1244_ALLOW_TEST_OVERRIDE: '1' });
    // T1 during the first (dying) chain → transient answer
    setTimeout(() => send(proc, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'x', arguments: {} } }), 500);
    await waitFor(proc, (l) => l.includes('"id":5') && l.includes('"error"'), 8000, 'first transient');
    // wait for the rechain respawn (10s backoff → second SHIM_SPAWN_CHAIN),
    // then the agent retry reaches the live chain
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
        const spawnCount = proc.errLines.filter((l) => l.includes('SHIM_SPAWN_CHAIN')).length;
        if (spawnCount >= 2) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    const spawnCount = proc.errLines.filter((l) => l.includes('SHIM_SPAWN_CHAIN')).length;
    if (spawnCount < 2) throw new Error(`respawn never happened (spawnCount=${spawnCount})`);
    await new Promise((r) => setTimeout(r, 500));
    send(proc, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'x', arguments: {} } });
    const revived = await waitFor(proc, (l) => l.includes('"id":6') && l.includes('RECHAIN_REVIVED'), 8000, 'revival answer');
    ok('R2 post-revival call reaches the live chain', JSON.parse(revived).result?.RECHAIN_REVIVED === true);
    ok('R2 rechain respawn happened (SHIM_RECHAIN restarting logged)', proc.errLines.some((l) => l.includes('SHIM_RECHAIN') && l.includes('chain_restarting')));
    try { fs.rmSync(flag, { force: true }); } catch { /* absent */ }
    await cleanup(proc);
}

section("R3: exhaustion → terminal retryable:false with launcher-log pointer");
{
    const proc = startShim({
        KOL_SEE1244_LAUNCHER_OVERRIDE: '/nonexistent/launcher.sh',
        KOL_SEE1244_ALLOW_TEST_OVERRIDE: '1',
        KOL_SHIM_RECHAIN_MAX: '0',
    });
    await new Promise((r) => setTimeout(r, 400));
    send(proc, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'x', arguments: {} } });
    const line = await waitFor(proc, (l) => l.includes('"id":9') && l.includes('"error"'), 8000, 'terminal answer');
    const m = JSON.parse(line);
    ok('R3 state=chain_exhausted', m.error.data?.state === 'chain_exhausted', JSON.stringify(m.error.data));
    ok('R3 retryable:false (no false-transient masking of permanent failure)', m.error.data?.retryable === false);
    ok('R3 message names the launcher log (recovery pointer)', m.error.message.includes('godot-mcp-launcher'));
    ok('R3 SHIM_RECHAIN exhausted log present', proc.errLines.some((l) => l.includes('chain_exhausted')));
    await cleanup(proc);
}

section("R4: rechain log stream carries counters/backoff");
{
    const proc = startShim({ KOL_SEE1244_LAUNCHER_OVERRIDE: '/nonexistent/launcher.sh', KOL_SEE1244_ALLOW_TEST_OVERRIDE: '1' });
    await new Promise((r) => setTimeout(r, 400));
    const rec = proc.errLines.find((l) => l.includes('SHIM_RECHAIN') && l.includes('chain_restarting'));
    ok('R4 SHIM_RECHAIN state=chain_restarting present', !!rec);
    ok('R4 attempt counter present', !!rec && /attempt=1\/\d+/.test(rec), rec);
    ok('R4 delay_ms present', !!rec && /delay_ms=\d+/.test(rec), rec);
    await cleanup(proc);
}

console.log(`\nSUMMARY: PASS=${PASS} FAIL=${FAIL}`);
if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
