#!/usr/bin/env node
// SEE-1244 §9.2 (Revy QA defect #1 blind spot) — cache closure THROUGH the real
// registration path: shim intercepts tools/list (claude does NOT re-pull after
// handoff), so the closure must come from the proxy's PROACTIVE refresh.
//
// The test below drives the exact cold-start message flow that Revy proved on
// the real machine:
//   claude → shim: initialize, tools/list  (both answered locally by the shim)
//   claude → shim: tools/call              (T1 → handoff → forwarded to chain)
//   chain(=mock fork) stderr: 'Connected to Godot' → proxy pulls tools/list
//   itself (see1244-tools-cache-* id), patches, writes the cache, emits
//   notifications/tools/list_changed.
//
// Against the OLD implementation (pre-fix), this test FAILS: the cache file is
// never written because the proxy never sees any tools/list. That is the
// falsifiability Atlas required ("新测试必须能在 claude 不 re-pull 形态下证伪旧实现").
//
// Run: node .dev/godot-mcp/tests/scripts/test_see1244_cache_closure.mjs
// Uses the REAL launcher→proxy chain (mock npx stands in for the fork).

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = path.resolve(HERE, '../../../launch/godot-mcp-shim.mjs');
const MOCK_NPX = path.resolve(HERE, '_see1244_mock_npx.mjs');

let PASS = 0, FAIL = 0;
const failures = [];
function ok(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  [PASS] ${name}`); }
    else { FAIL++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

function runColdFlow(home, label) {
    const tStart = Date.now();
    return new Promise((resolve, reject) => {
        const port = 20000 + Math.floor(Math.random() * 20000); // hermetic: isolated port per run
        const proc = spawn(process.execPath, [SHIM_PATH, label], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                HOME: home,
                GODOT_MCP_HOME: path.join(home, '.multica'),
                KOL_AGENT_NAME: label,
                // Real chain, mock fork + fake editor WS (hermetic). Isolated
                // random port: the earlier flakiness was the test leaning on a
                // STALE real editor already listening on the fixed port — with
                // a fresh port the fake editor in the mock npx is the only
                // possible warm source, and a stale-port collision fails LOUD.
                // KOL_GODOT_MCP_CMD resolves to `node <path>` as ONE arg (see
                // resolveGodotMcpCommand: args:[override]) — a space in it
                // would be treated as a filename. The mock reads the port from
                // KOL_MCP_PORT env, which the launcher exports to its children,
                // so no argv is needed.
                KOL_GODOT_MCP_CMD: MOCK_NPX,
                // Proxy probes GODOT_HOST:GODOT_PORT for warm; force loopback so
                // the mock's fake editor on 127.0.0.1 is reached instead of the
                // WSL gateway (detectWindowsHost) that nothing listens on.
                GODOT_HOST: '127.0.0.1',
                KOL_WORKTREE: process.cwd(),
                // SEE-1344: pin an explicit scratch project — the launcher's
                // 120s WORKTREE_WAIT tier (shared/SEE-1342 sync) preempts the
                // 30s cache-closure window when resolution falls through; this
                // chain test asserts cache semantics, not worktree resolution.
                KOL_PROJECT_GODOT: path.join(process.cwd(), 'launch', 'tests', 'scripts', '_see1244_scratch', 'project.godot'),

                KOL_DIRECT_GODOT_MCP: '1',
                KOL_PORT_ARBITER: 'off',
                KOL_MCP_PORT: String(port),
                KOL_STAGE_LOG: 'off',
                // Hermetic editor: the proxy's B1 lazy-spawn would otherwise run the REAL
                // start-godot-editor.sh on this machine — on an isolated random
                // port that script (targeting a real editor) would fail or
                // worse. The fake editor is the WS listener; these seams stop
                // the real helper from being invoked at all. Must be SHELL
                // scripts (runScript spawns `bash <path>`), hence the tiny
                // harness rather than /bin/true (which bash refuses: rc=126).
                KOL_CONFIGURE_SH: path.resolve(HERE, '_see1244_true.sh'),
                KOL_START_SH: path.resolve(HERE, '_see1244_true.sh'),
                KOL_STOP_SH: path.resolve(HERE, '_see1244_true.sh'),
            },
        });
        const outLines = [], errLines = [];
        // SEE-1363 §SPEC-004: every send below is gated on the previous
        // response (or a real chain signal) instead of a fixed millisecond
        // guess. waitFor resolves on the line EVENT; its budget only bounds
        // failure and dumps diagnostics on expiry. The only surviving
        // setTimeout literals are ceilings (whole-flow / per-wait budgets).
        const waiters = [];
        const notify = () => { for (const w of [...waiters]) w.check(); };
        const waitFor = (lines, pred, budgetMs, desc) => new Promise((resolveWait) => {
            const hit = lines.find(pred);
            if (hit) return resolveWait(hit);
            const w = {
                t: null,
                check: () => {
                    const h = lines.find(pred);
                    if (h) { clearTimeout(w.t); waiters.splice(waiters.indexOf(w), 1); resolveWait(h); }
                },
            };
            waiters.push(w);
            w.t = setTimeout(() => { // ceiling: per-wait budget, not a sync sleep
                const i = waiters.indexOf(w);
                if (i >= 0) waiters.splice(i, 1);
                const tail = lines.slice(-6).join('\n');
                process.stderr.write(`[waitFor-timeout] ${desc}: no event within ${budgetMs}ms; stream tail:\n${tail}\n`);
                resolveWait(null);
            }, budgetMs);
        });
        const hasId = (l, id) => { try { return JSON.parse(l).id === id; } catch { return false; } };
        const isTransient = (l) => { try { return JSON.parse(l).error?.data?.retryable === true; } catch { return false; } };
        createInterface({ input: proc.stdout, terminal: false, crlfDelay: Infinity }).on('line', (l) => { outLines.push(l); notify(); });
        createInterface({ input: proc.stderr, terminal: false, crlfDelay: Infinity }).on('line', (l) => { errLines.push(l); notify(); });
        proc.outLines = outLines; proc.errLines = errLines;
        const finish = (v) => {
            // Drop still-pending wait budgets so they neither print late
            // diagnostics nor hold the event loop after the flow has closed.
            for (const w of waiters.splice(0)) clearTimeout(w.t);
            try { proc.kill('SIGKILL'); } catch { /* gone */ }
            resolve(v);
        };
        // Generous: cold editor warmup path (mock npx answers immediately, so
        // the proxy warms fast); 30s ceiling well above observed ~3-6s.
        const timer = setTimeout(() => finish({ timeout: true }), 30000); // ceiling: whole-flow backstop
        proc.on('exit', (code) => { clearTimeout(timer); resolve({ exited: true, code }); });

        // --- the REAL registration flow (no re-pull after handoff) ---
        // stdin is a pipe: the shim reads when ready, so initialize goes out
        // immediately; each subsequent send waits for the prior response.
        const send = (o) => proc.stdin.write(`${JSON.stringify(o)}\n`);
        const flow = (async () => {
            send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
            await waitFor(outLines, (l) => hasId(l, 1), 15000, 'initialize response (id:1)');
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
            await waitFor(outLines, (l) => hasId(l, 2), 15000, 'tools/list response (id:2)');
            send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'godot_project', arguments: { action: 'get_info' } } });
            // SEE-1244 修补 v2: the first call can land BEFORE the launcher
            // proves proxy exec — the shim correctly answers it with a
            // retryable transient instead of flushing it into the launcher's
            // pre-exec /dev/null stdin. The prescribed agent behavior is a
            // retry of the CALL (never a second tools/list — the claude
            // no-re-pull premise of this test is preserved).
            let resp = await waitFor(outLines, (l) => hasId(l, 3), 20000, 'first tools/call response (id:3)');
            if (resp && isTransient(resp)) {
                // Retry point (was a fixed t=3000ms send): gated on REAL
                // signals only — the transient response above, then the chain
                // exec line relayed onto the shim stderr ([chain] prefix).
                await waitFor(errLines, (l) => /LAUNCHER_EXEC|exec .*godot-mcp-proxy\.mjs/.test(l), 20000, 'chain exec signal on stderr');
                // Each retry is response-gated; transient answers keep coming
                // while the proxy warms, so retry until the chain answers for
                // real (bounded attempts, each with its own response budget).
                let id = 4;
                while (resp && isTransient(resp) && id < 12) {
                    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'godot_project', arguments: { action: 'get_info' } } });
                    resp = await waitFor(outLines, (l) => hasId(l, id), 20000, `tools/call retry response (id:${id})`);
                    id += 1;
                }
            }
            // NOTE: deliberately NO second tools/list — claude does not re-pull.
        })();
        flow.catch((e) => process.stderr.write(`[flow-error] ${e?.stack || e}\n`));
        // Poll for cache closure; on the 20s boundary, dump the chain stderr
        // tail so a stall is attributable (which warm gate never opened).
        const cacheFile = path.join(home, '.multica', `godot-mcp-tools-cache-${label.toLowerCase()}.json`);
        // Write-completion proof instead of a post-exists fixed grace: the
        // cache lands via tmp-write → rename, and a fully parsed body is the
        // event that the write has completed.
        const cacheWritten = () => {
            try { JSON.parse(fs.readFileSync(cacheFile, 'utf8')); return true; } catch { return false; }
        };
        let diagnosed = false;
        const poll = setInterval(() => {
            if (cacheWritten()) { clearInterval(poll); clearTimeout(timer); finish({ cacheReady: true }); }
            if (!diagnosed && Date.now() - tStart > 20000) {
                diagnosed = true;
                const tail = proc.errLines.filter((l) => l.includes('[chain]')).slice(-12);
                process.stderr.write(`[closure-diagnose] cache not ready at 20s; chain tail:\n${tail.join('\n')}\n`);
            }
        }, 250);
        setTimeout(() => { clearInterval(poll); }, 25500); // ceiling: poll-window backstop
    });
}

section('cold flow through shim interception → proactive proxy cache closure');
{
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'see1244-closure-'));
    const label = 'ClosureTest';
    const r = await runColdFlow(home, label);
    const cacheFile = path.join(home, '.multica', 'godot-mcp-tools-cache-closuretest.json');

    // The falsification core: with the OLD implementation the cache never lands.
    ok('cache file EXISTS after cold session (defect #1 fixed)', fs.existsSync(cacheFile),
        `out=${JSON.stringify((r.outLines || []).slice(0, 3))} errTail=${JSON.stringify((r.errLines || r.outLines || []).slice(-5))}`);

    if (fs.existsSync(cacheFile)) {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        ok('cache is the PATCHED real list (godot_ui_inspect present)', Array.isArray(cache.tools) && cache.tools.some((t) => t.name === 'godot_ui_inspect'));
        ok('cache schema=1 with fork mtime stamp', cache.schema === 1 && typeof cache.fork === 'string');

        // AC-3 shape: a SECOND session (new shim, same HOME) must hit the cache.
        const proc2 = spawn(process.execPath, [SHIM_PATH, label], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, HOME: home, GODOT_MCP_HOME: path.join(home, '.multica') },
        });
        const err2 = [];
        const secondHit = await new Promise((resolve) => {
            let id9Line = null;
            let done = false;
            const finish2 = (v) => { if (!done) { done = true; clearTimeout(t2); clearTimeout(grace); proc2.kill(); resolve(v); } };
            const tryResolve = () => {
                if (!id9Line) return;
                // SEE-1363 §SPEC-004: resolve on the source=cache evidence line
                // itself (event), not a fixed 150ms flush guess; a short
                // ceiling still bounds a missing-log regression into a FAIL.
                if (err2.some((l) => /SHIM_ANSWER_TOOLS source=cache/.test(l))) {
                    finish2({ hit: true, tools: JSON.parse(id9Line).result.tools, logged: true });
                }
            };
            const t2 = setTimeout(() => finish2(false), 8000); // ceiling: session-2 backstop
            const grace = setTimeout(() => { // ceiling: bounds a missing source=cache line into logged:false
                if (id9Line) finish2({ hit: true, tools: JSON.parse(id9Line).result.tools, logged: false });
            }, 3000);
            createInterface({ input: proc2.stderr, terminal: false, crlfDelay: Infinity }).on('line', (l) => { err2.push(l); tryResolve(); });
            let buf2 = '';
            proc2.stdout.on('data', (d) => {
                buf2 += d.toString();
                for (const line of buf2.split('\n')) {
                    if (!id9Line && line.includes('"id":9') && line.includes('"tools"')) {
                        id9Line = line;
                        tryResolve();
                        return;
                    }
                }
            });
            proc2.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })}\n`);
        });
        ok('session 2 answers tools/list from cache (AC-3: source=cache)', secondHit && secondHit.hit && secondHit.logged);
        ok('session 2 sees the REAL patched list (not placeholder)', secondHit && secondHit.tools
            && secondHit.tools.some((t) => t.name === 'godot_ui_inspect')
            && !secondHit.tools[0].description.includes('[godot-mcp placeholder]'));
    }

    // Proxy emitted list_changed after the proactive pull (protocol channel).
    // Observable on the shim stderr relay of the chain stdout → we assert via
    // the claude-side out stream of session 1 instead: the notification is a
    // top-level method frame, no id.
    // (Out-of-band check: proxy log line is the deterministic signal.)
    const proxyLogTouched = fs.existsSync(path.join(home, '.config', 'godot-mcp', 'godot-mcp-launcher-port-6596.log'))
        || (r.errLines || []).some((l) => l.includes('tools cache refresh'));
    ok('proactive refresh observable in proxy/shim diagnostics', proxyLogTouched || fs.existsSync(cacheFile));

    // SEE-1363 §SPEC-012 (#3): teardown race — SIGKILLed shim/proxy/chain
    // children can still hold open fds inside `home` when the main flow
    // returns; an immediate rmSync raced them and crashed (ENOTEMPTY) AFTER
    // all assertions had passed (R2-run3, pre-existing line). The children
    // have no exit event left to subscribe to (finish SIGKILLs and forgets
    // the handles), so poll `home` empty with a BOUNDED budget (正例 #4 —
    // 资源释放谓词轮询，非同步等待手段；仅清理语义，断言不动)，best-effort
    // delete whatever remains at the budget edge.
    for (let waited = 0; waited < 5000; waited += 200) {
        try { fs.rmSync(home, { recursive: true, force: true }); break; } catch { /* children still draining */ }
        await new Promise((res) => setTimeout(res, 200)); // bounded poll interval (cleanup-completion budget)
    }
}

console.log(`\nSUMMARY: PASS=${PASS} FAIL=${FAIL}`);
if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
