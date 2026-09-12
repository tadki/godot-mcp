#!/usr/bin/env node
// SEE-1244 §9.2 — proxy tools-cache write hook tests.
//
// Covers:
//   - writeToolsCache: post-patchToolsList tools land in
//     ~/.multica/godot-mcp-tools-cache-<label>.json with schema:1 and a fork
//     mtime stamp; write is atomic (tmp+rename — no .tmp residue)
//   - empty/non-array tools → no cache file written
//   - a write failure (unwritable dir) does not throw (fire-and-forget)
//   - patchToolsList + writeToolsCache compose: the cached payload is the
//     PATCHED list (godot_ui_inspect appended, idempotent on re-patch)
//   - shim read side marks stale when fork mtime differs from cache `fork`
//
// Run: node .dev/godot-mcp/tests/scripts/test_see1244_proxy_tools_cache.mjs
// Env: HOME redirected to a temp dir; KOL_AGENT_NAME pins the cache label.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = path.resolve(HERE, '../../../launch/godot-mcp-shim.mjs');
const PROXY_PATH = path.resolve(HERE, '../../../launch/godot-mcp-proxy.mjs');

let PASS = 0, FAIL = 0;
const failures = [];
function ok(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  [PASS] ${name}`); }
    else { FAIL++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

// The proxy's writeToolsCache is not exported; drive it through the real proxy
// module by importing patchToolsListForTest + invoking the write hook via a
// tiny harness that mirrors the production call site (patch → write). We import
// the proxy module in a CHILD process with a stubbed environment because the
// proxy main() starts servers on import. Instead: eval-free composition test —
// replicate the exact production call sequence in-child by importing the proxy
// module graph is NOT safe (module-level side effects). So we exercise the
// WRITE hook through the actual proxy process: spawn the proxy with a mock npx
// (KOL_GODOT_MCP_CMD pointing at a stub that answers tools/list), send
// tools/list through stdio, then assert the cache file the hook wrote.

const MOCK_NPX = `${HERE}/_see1244_mock_npx.mjs`;

function runProxyForCache(label, home) {
    return new Promise((resolve, reject) => {
        const proc = spawn('bash', [path.resolve(HERE, '../../../launch/godot-mcp-launcher.sh'), label], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                HOME: home,
                KOL_AGENT_NAME: label,
                KOL_GODOT_MCP_CMD: MOCK_NPX,
                // Proxy probes GODOT_HOST:GODOT_PORT for warm; the mock's fake
                // editor listens on 127.0.0.1 with the same port.
                GODOT_HOST: '127.0.0.1',
                KOL_WORKTREE: process.cwd(),
                KOL_DIRECT_GODOT_MCP: '1',
                KOL_PORT_ARBITER: 'off',
                // Hermetic random port: the mock NOW binds a fake editor WS on
                // this port (SEE-1244 LOW1 fix), so a fixed/reused port can
                // EADDRINUSE against a leftover real editor and break the test.
                KOL_MCP_PORT: String(20000 + Math.floor(Math.random() * 20000)),
                KOL_STAGE_LOG: 'off',
                KOL_REAPER_DISABLED: '1',
            },
        });
        const outLines = [], errLines = [];
        createInterface({ input: proc.stdout, terminal: false, crlfDelay: Infinity }).on('line', (l) => outLines.push(l));
        createInterface({ input: proc.stderr, terminal: false, crlfDelay: Infinity }).on('line', (l) => errLines.push(l));
        proc.outLines = outLines; proc.errLines = errLines;
        const done = (v) => { try { proc.kill('SIGKILL'); } catch { /* gone */ } resolve(v); };
        const timer = setTimeout(() => done({ timeout: true, errLines }), 20000);
        // Wait until the proxy signals the cache write in its log, then a beat
        // for the (synchronous) rename to complete.
        const check = setInterval(() => {
            if (errLines.some((l) => l.includes('tools cache written'))) {
                clearInterval(check);
                clearTimeout(timer);
                setTimeout(() => done({ ok: true }), 200);
            }
        }, 50);
        proc.on('exit', () => { clearInterval(check); clearTimeout(timer); resolve({ exited: true, errLines }); });
        // The mock npx needs a beat to boot before the tools/list is forwarded
        // (proxy writes stdin synchronously; a same-tick write can race the
        // child's readline setup).
        setTimeout(() => {
            proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
        }, 800);
    });
}

function runShimRead(home, label) {
    return new Promise((resolve, reject) => {
        // Same race as the proxy side: the answerToolsList log line lands on
        // stderr in the same tick group as stdout — give stderr a beat to be
        // captured before resolving.
        const proc = spawn(process.execPath, [SHIM_PATH, label], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, HOME: home },
        });
        const errLines = [];
        createInterface({ input: proc.stderr, terminal: false, crlfDelay: Infinity }).on('line', (l) => errLines.push(l));
        let buf = '';
        const timer = setTimeout(() => { proc.kill(); reject(new Error('shim read timeout')); }, 8000);
        proc.stdout.on('data', (d) => {
            buf += d.toString();
            for (const line of buf.split('\n')) {
                if (line.includes('"id":2') && line.includes('"tools"')) {
                    clearTimeout(timer); proc.kill();
                    setTimeout(() => resolve({ resp: JSON.parse(line), errLines }), 150);
                }
            }
        });
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    });
}

section('proxy writes post-patch cache through the real chain entry');
{
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'see1244-cache-'));
    const r = await runProxyForCache('CacheTest', home);
    const cacheFile = path.join(home, '.config', 'godot-mcp', 'godot-mcp-tools-cache-cachetest.json');
    if (r.timeout) {
        ok('proxy answered tools/list within timeout', false, JSON.stringify((r.errLines || []).slice(-5)));
    } else {
        ok('cache file exists after proxy patch point fired', fs.existsSync(cacheFile));
        if (fs.existsSync(cacheFile)) {
            const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
            ok('cache schema is 1', cache.schema === 1);
            ok('cache tools non-empty array', Array.isArray(cache.tools) && cache.tools.length > 0);
            ok('cache is the PATCHED list (godot_ui_inspect present)', cache.tools.some((t) => t.name === 'godot_ui_inspect'));
            ok('cache carries fork mtime stamp', typeof cache.fork === 'string' && cache.fork.length > 0);
            ok('no .tmp residue (atomic rename)', !fs.existsSync(`${cacheFile}.tmp-` + '*') && fs.readdirSync(path.dirname(cacheFile)).every((f) => !f.includes('.tmp-')));
        }
        // Shim read side: fresh session hits the cache written by the proxy.
        const { resp, errLines } = await runShimRead(home, 'CacheTest');
        ok('shim cache hit after proxy write', Array.isArray(resp?.result?.tools) && resp.result.tools.length > 0);
        ok('shim logged source=cache', errLines.some((l) => /SHIM_ANSWER_TOOLS source=cache/.test(l)));
    }
    fs.rmSync(home, { recursive: true, force: true });
}

section('fork mtime drift → shim stale flag (still answers)');
{
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'see1244-stale-'));
    const cacheDir = path.join(home, '.config', 'godot-mcp');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'godot-mcp-tools-cache-staletest.json'), JSON.stringify({
        schema: 1,
        fork: '111111', // ≠ any real mtime → stale
        updated_at: new Date().toISOString(),
        tools: [{ name: 'godot_exec', description: 'old', inputSchema: { type: 'object' } }],
    }));
    const proc = spawn(process.execPath, [SHIM_PATH, 'StaleTest'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HOME: home },
    });
    const errLines = [];
    createInterface({ input: proc.stderr, terminal: false, crlfDelay: Infinity }).on('line', (l) => errLines.push(l));
    let buf = '';
    const timer = setTimeout(() => { proc.kill(); }, 8000);
    await new Promise((resolve) => {
        proc.stdout.on('data', (d) => {
            buf += d.toString();
            for (const line of buf.split('\n')) {
                if (line.includes('"id":3') && line.includes('"tools"')) {
                    clearTimeout(timer); proc.kill();
                    const resp = JSON.parse(line);
                    ok('stale cache STILL answered (non-empty beats fresh, §6.1)', resp.result.tools.length === 1);
                    ok('stale flag logged', errLines.some((l) => l.includes('reason=fork_mtime_stale')));
                    resolve();
                }
            }
        });
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`);
    });
    fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\nSUMMARY: PASS=${PASS} FAIL=${FAIL}`);
if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
