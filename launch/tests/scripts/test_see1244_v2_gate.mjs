#!/usr/bin/env node
// SEE-1244 修补 v2 (final decision 01a08100) — CRITICAL blind-spot test:
// "launcher wait window T1 → state=worktree_wait transient answer, call NEVER
// reaches /dev/null". This is the exact scenario three reviewers proved the
// f9bab277 implementation got wrong (T1 gated on stdin.writable flushed the
// call into the launcher's /dev/null stdin, silently lost).
//
// Mock chain timeline: 4s of stage=WORKTREE_WAIT stderr lines, then
// WORKTREE_READY + stage=LAUNCHER_EXEC + serving. Assertions:
//   W1  T1 mid-wait → structured transient with data.state='worktree_wait',
//       retryable:true; the call is NOT written to chain stdin (mock only
//       serves after READY, so any WAITMOCK echo for id:11 would prove a
//       /dev/null-bound write slipped through — asserted absent)
//   W2  post-READY retry reaches the live chain (handoff works, exec-proof
//       gate satisfied via LAUNCHER_EXEC stderr)
//   W3  state reachability: all four states observable across this + rechain
//       suites (worktree_wait here; proxy_warming/chains in rechain suite)
//   W4  override production defense: override WITHOUT the allow flag is
//       ignored (SHIM_OVERRIDE_REJECTED logged; real launcher attempted —
//       which dies on unknown test agent → chain_exhausted, NOT the mock)
//
// Run: node .dev/godot-mcp/tests/scripts/test_see1244_v2_gate.mjs

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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'see1244-v2-'));
    const proc = spawn(process.execPath, [SHIM_PATH, 'V2GateTest'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home, ...env },
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

// Wait-window mock: WORKTREE_WAIT for `waitMs`, then READY + LAUNCHER_EXEC,
// then serve every request with a WAITMOCK marker.
function writeWaitMock(waitMs) {
    const mock = path.join(os.tmpdir(), `see1244-waitmock-${waitMs}.mjs`);
    fs.writeFileSync(mock, `
const WAIT_MS = ${waitMs};
let n = 0;
const t1 = setInterval(() => {
    n++;
    process.stderr.write('[godot-mcp-launcher] stage=WORKTREE_WAIT msg="waiting" retry=' + n + ' waited_s=' + (n * 2) + '\\n');
}, 200);
setTimeout(() => {
    clearInterval(t1);
    process.stderr.write('[godot-mcp-launcher] stage=WORKTREE_READY waited_s=' + (WAIT_MS / 1000) + '\\n');
    process.stderr.write('[godot-mcp-launcher] stage=LAUNCHER_EXEC msg="exec proxy"\\n');
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/ready' }) + '\\n'); // proxy stdio live proof — opens the shim's handoff gate
}, WAIT_MS);
const { createInterface } = await import('node:readline');
createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.trim()) return;
    let id = null; try { id = JSON.parse(line).id; } catch {}
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { WAITMOCK: true } }) + '\\n');
});
`);
    return mock;
}

section('W1/W2: wait-window T1 → worktree_wait transient (never /dev/null); post-READY retry reaches chain');
{
    const mock = writeWaitMock(4000);
    const proc = startShim({
        KOL_SEE1244_LAUNCHER_OVERRIDE: `node ${mock}`,
        KOL_SEE1244_ALLOW_TEST_OVERRIDE: '1',
    });
    // T1 mid-wait (500ms — inside the 4s wait window)
    setTimeout(() => proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'godot_project', arguments: {} } })}\n`), 500);
    await new Promise((r) => setTimeout(r, 1300));
    const trLine = proc.outLines.find((l) => l.includes('"id":11') && l.includes('"error"'));
    ok('W1 T1 mid-wait answered (not silently dropped)', !!trLine, JSON.stringify(proc.outLines));
    if (trLine) {
        const m = JSON.parse(trLine);
        ok('W1 data.state=worktree_wait', m.error?.data?.state === 'worktree_wait', JSON.stringify(m.error?.data));
        ok('W1 retryable:true', m.error?.data?.retryable === true);
        ok('W1 retry_after_s present', typeof m.error?.data?.retry_after_s === 'number');
    }
    // The mock serves only AFTER READY — any WAITMOCK echo for id:11 would mean
    // the call was written to chain stdin during the wait window (the hole).
    await new Promise((r) => setTimeout(r, 4000));
    ok('W1 call never written to chain stdin during wait window', !proc.outLines.some((l) => l.includes('"id":11') && l.includes('WAITMOCK')));
    ok('W1 worktree_wait state reached via WORKTREE_WAIT stderr subscription', proc.errLines.some((l) => l.includes('SHIM_TRANSIENT_ANSWERED') && l.includes('state=worktree_wait')));

    // W2: post-READY retry reaches the live chain. The mock's FIRST stdout
    // frame only exists after READY, so the handoff gate (first-frame proof)
    // opens exactly at READY — the retry flushes through it.
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'godot_project', arguments: {} } })}\n`);
    await new Promise((r) => setTimeout(r, 1500));
    const okLine = proc.outLines.find((l) => l.includes('"id":12') && l.includes('WAITMOCK'));
    ok('W2 post-READY retry reaches the live chain (handoff completes)', !!okLine, JSON.stringify(proc.outLines.filter((l) => l.includes('"id":12'))));
    await cleanup(proc);
    try { fs.rmSync(mock, { force: true }); } catch { /* best-effort */ }
}

section('W3: proxy_warming reachable; exec-proved call flushes to the pipe (never lost)');
{
    // Mock: emits LAUNCHER_EXEC but delays its stdin reader by 1.5s — mirrors
    // the real proxy (exec at LAUNCHER_EXEC, node module loading before the
    // reader is up). A T1 inside that window is flushed into the pipe (the
    // gate is open: exec proven), buffered by the kernel until the reader
    // starts — NOT answered with a transient, NOT lost.
    const mock = path.join(os.tmpdir(), 'see1244-warmmock.mjs');
    fs.writeFileSync(mock, `process.stderr.write('[godot-mcp-launcher] stage=LAUNCHER_EXEC msg="exec proxy"\\n');
setTimeout(() => {
    import('node:readline').then(({ createInterface }) => {
        createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity }).on('line', (line) => {
            if (!line.trim()) return;
            let id = null; try { id = JSON.parse(line).id; } catch {}
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { WARMMOCK: true } }) + '\\n');
        });
        // A post-exec probe frame so T2/handoff can complete deterministically.
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/late-probe' }) + '\\n');
    });
}, 1500);
`);
    const proc = startShim({
        KOL_SEE1244_LAUNCHER_OVERRIDE: `node ${mock}`,
        KOL_SEE1244_ALLOW_TEST_OVERRIDE: '1',
    });
    await new Promise((r) => setTimeout(r, 400)); // LAUNCHER_EXEC seen, reader not yet up
    // W3: LAUNCHER_EXEC proves proxy exec — the gate opens and the call is
    // flushed into the chain stdin PIPE. The mock's reader comes up 1.5s
    // later, drains the kernel-buffered call, and answers it. Nothing is
    // dropped (the /dev/null hole) and no transient is needed.
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'x', arguments: {} } })}\n`);
    // t=2.4s: reader up (1.5s) + probe frame emitted → handoff; id:21 must
    // have been served from the pipe buffer.
    await new Promise((r) => setTimeout(r, 2200));
    ok('W3 exec-proved T1 flushed into the pipe and served by the reader', proc.outLines.some((l) => l.includes('"id":21') && l.includes('WARMMOCK')), JSON.stringify(proc.outLines.filter((l) => l.includes('"id":21'))));
    // Post-handoff retry also reaches the chain.
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'x', arguments: {} } })}\n`);
    await new Promise((r) => setTimeout(r, 800));
    ok('W3 post-warming retry reaches chain', proc.outLines.some((l) => l.includes('"id":22') && l.includes('WARMMOCK')));
    await cleanup(proc);
    try { fs.rmSync(mock, { force: true }); } catch { /* best-effort */ }
}

section('W4: override production defense (allow flag required)');
{
    // Override WITHOUT the allow flag → ignored loudly; the shim attempts the
    // REAL launcher (which dies on the unknown test agent → chain_exhausted).
    const proc = startShim({ KOL_SEE1244_LAUNCHER_OVERRIDE: '/nonexistent/evil.sh' });
    await new Promise((r) => setTimeout(r, 600));
    ok('W4 override rejected loudly (SHIM_OVERRIDE_REJECTED)', proc.errLines.some((l) => l.includes('SHIM_OVERRIDE_REJECTED')));
    ok('W4 mock NOT used (no chain spawn with the override cmd)', !proc.errLines.some((l) => l.includes('SHIM_SPAWN_CHAIN') && l.includes('/nonexistent/evil.sh')));
    await cleanup(proc);
}

console.log(`\nSUMMARY: PASS=${PASS} FAIL=${FAIL}`);
if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
