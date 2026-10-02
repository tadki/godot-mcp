#!/usr/bin/env node
// probe_wait_negative.mjs — SEE-1363 §SPEC-009: negative-discrimination
// probes for the event-driven harness waits. Breaks each harness's wait
// condition / signal source IN MEMORY (save → mutate → run → restore),
// then asserts the harness fails LOUDLY (non-zero rc + wait diagnostics)
// instead of going false-green. Every mutation is byte-restored in a
// finally; the script verifies `git status` cleanliness per mutated file.
//
// Mutations:
//   A  fork_wiring   delete the marker-env publish line (signal source gone)
//                    → W2 must FAIL with [wait-timeout] diagnostics, rc≠0
//   B  fork_wiring   typo the observer wait pattern only (advisory wait)
//                    → verdicts are assertion-judged by design: expected
//                      outcome is a SLOW GREEN carrying [wait-timeout]; if
//                      the run goes red instead, the advisory-wait masking
//                      assumption is wrong and must be re-examined. Either
//                      way the diagnostics MUST be present.
//   C  stdio_proxy   break the mock responder's reply id (signal source gone)
//                    → initialize-response assertions must FAIL, rc≠0
//   D  cache_closure delete the id:3 tools/call send line (event trigger gone)
//                    → cache-closure flow must FAIL with [waitFor-timeout],
//                      rc≠0
//
// Exit 0 iff every step's stated expectation holds.
// Run: node launch/tests/scripts/probe_wait_negative.mjs
// Optional step filter (comma-separated ids) for short CI windows:
//   PROBE_STEPS=fork-signal-gone,fork-pattern-typo,stdio-signal-gone,cache-trigger-gone

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPTS = path.join(REPO, 'launch/tests/scripts');
const SELECTED = new Set((process.env.PROBE_STEPS || '').split(',').map((s) => s.trim()).filter(Boolean));
const isSelected = (id) => SELECTED.size === 0 || SELECTED.has(id);

let passed = 0, failed = 0;
function step(id, cond, detail = '') {
    const verdict = cond ? 'PASS' : 'FAIL';
    console.log(`[probe-wait] STEP=${id} ${verdict}${detail ? ` — ${detail}` : ''}`);
    if (cond) passed += 1; else failed += 1;
}

// save → mutate → run → restore (byte-identical), verified via git.
function withMutation(file, mutate, run) {
    const p = path.join(REPO, file);
    const orig = readFileSync(p, 'utf8');
    const n = mutate(orig);
    if (n === orig) throw new Error(`mutation did not change ${file} (anchor not found)`);
    writeFileSync(p, n);
    try {
        const out = run();
        const st = spawnSync('git', ['status', '--porcelain', '--', file], { encoding: 'utf8', cwd: REPO });
        writeFileSync(p, orig);
        const st2 = spawnSync('git', ['status', '--porcelain', '--', file], { encoding: 'utf8', cwd: REPO });
        step(`${out.id}:restored`, st2.stdout.trim() === '', `post-run dirty=${st.stdout.trim() !== ''} after-restore clean=${st2.stdout.trim() === ''}`);
        return out;
    } catch (e) {
        writeFileSync(p, orig);
        throw e;
    }
}

function runBash(script, timeoutMs) {
    const r = spawnSync('bash', [path.join(SCRIPTS, script)], { encoding: 'utf8', timeout: timeoutMs });
    return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function runNode(script, timeoutMs) {
    const r = spawnSync('node', [path.join(SCRIPTS, script)], { encoding: 'utf8', timeout: timeoutMs });
    return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// First lines matching any diagnostic marker — the machine-readable evidence
// that a broken wait announced itself before the assertion failed.
function diagExcerpt(out) {
    return out.split('\n')
        .filter((l) => /\[(wait|waitFor)-timeout\]|\[FAIL\]|\[closure-diagnose\]|SUMMARY: PASS=/.test(l))
        .slice(0, 6)
        .join(' | ');
}

// A — fork_wiring: signal source gone (mock never records QUICK= env).
if (isSelected('fork-signal-gone')) {
    const out = withMutation(
        'launch/tests/scripts/test_see1111_fork_wiring.sh',
        (s) => {
            const line = s.split('\n').findIndex((l) => l.includes("appendFileSync(MARKER, 'QUICK='"));
            if (line < 0) return s;
            return s.split('\n').filter((l) => !l.includes("appendFileSync(MARKER, 'QUICK='")).join('\n');
        },
        () => ({ id: 'fork-signal-gone', ...runBash('test_see1111_fork_wiring.sh', 300000) }),
    );
    step('fork-signal-gone:red', out.rc !== 0, `rc=${out.rc}`);
    step('fork-signal-gone:wait-timeout-diag', out.out.includes('[wait-timeout]'), diagExcerpt(out.out));
    step('fork-signal-gone:W2-fail', /FAIL.*W2|W2: external timeout override lost/.test(out.out), 'W2 assertion fired');
}

// B — fork_wiring: typo'd observer wait pattern (advisory wait; verdicts
// are judged by assertions independent of the wait).
if (isSelected('fork-pattern-typo')) {
    const out = withMutation(
        'launch/tests/scripts/test_see1111_fork_wiring.sh',
        (s) => {
            const anchor = 'wait_for_pattern "$TMPDIR/fork.marker" \'QUICK=\' 60000 "caseA fork marker" || true';
            if (!s.includes(anchor)) return s;
            return s.replace(anchor, anchor.replace("'QUICK='", "'QUICK_TYPO='"));
        },
        () => ({ id: 'fork-pattern-typo', ...runBash('test_see1111_fork_wiring.sh', 300000) }),
    );
    step('fork-pattern-typo:wait-timeout-diag', out.out.includes('[wait-timeout]'), 'broken wait announces its timeout');
    console.log(`[probe-wait] OBSERVATION fork-pattern-typo rc=${out.rc} — ${out.rc === 0 ? 'SLOW GREEN (advisory-wait masking; verdicts assertion-judged by design)' : 'RED (advisory-wait masking assumption wrong — re-examine)'}`);
}

// C — stdio_proxy: signal source gone (mock answers initialize with id:99,
// '"id":1' never lands on stdout).
if (isSelected('stdio-signal-gone')) {
    const out = withMutation(
        'launch/tests/scripts/test_see1045_stdio_proxy.sh',
        (s) => {
            const anchor = "const resp = { jsonrpc: '2.0', id: msg.id, result: { name: 'mock-godot-mcp'";
            if (!s.includes(anchor)) return s;
            return s.replace("id: msg.id, result: { name: 'mock-godot-mcp'", "id: 99, result: { name: 'mock-godot-mcp'");
        },
        () => ({ id: 'stdio-signal-gone', ...runBash('test_see1045_stdio_proxy.sh', 590000) }),
    );
    step('stdio-signal-gone:red', out.rc !== 0, `rc=${out.rc}`);
    step('stdio-signal-gone:wait-timeout-diag', out.out.includes('[wait-timeout]'), diagExcerpt(out.out));
    step('stdio-signal-gone:assert-fail', out.out.includes('[FAIL]'), 'case assertion fired');
}

// D — cache_closure: event trigger gone (id:3 tools/call never sent →
// cache closure flow stalls into its ceilings with diagnostics).
if (isSelected('cache-trigger-gone')) {
    const out = withMutation(
        'launch/tests/scripts/test_see1244_cache_closure.mjs',
        (s) => s.split('\n').filter((l) => !l.includes("id: 3, method: 'tools/call'")).join('\n'),
        () => ({ id: 'cache-trigger-gone', ...runNode('test_see1244_cache_closure.mjs', 300000) }),
    );
    step('cache-trigger-gone:red', out.rc !== 0, `rc=${out.rc}`);
    step('cache-trigger-gone:waitFor-timeout-diag', out.out.includes('[waitFor-timeout]'), diagExcerpt(out.out));
    step('cache-trigger-gone:assert-fail', out.out.includes('[FAIL]'), 'closure assertion fired');
}

console.log(`[probe-wait] SUMMARY: PASS=${passed} FAIL=${failed}`);
process.exit(failed === 0 ? 0 : 1);
