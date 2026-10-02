#!/usr/bin/env node
// probe_bash_sleep_gate.mjs — SEE-1363 §SPEC-009: discrimination probes for
// the bash-domain fixed-sleep lint gate (check_bash_sleep.mjs).
//
// Machine-judged, repeatable: each step spawns the real gate against a
// controlled repo state and asserts on rc + output. Every mutation is a
// probe-owned temp file inside the gate domain (launch/tests/lint/) except
// the baseline step, which saves/restores the real baseline file in a
// try/finally — a crashed probe cannot leave the gate red.
//
// Steps:
//   1  positive        clean tree                → rc=0, violations==baseline
//   2  negative        inject `sleep 9`          → rc≠0, site listed; restore → rc=0
//   3  hatch ascii     `# sleep-ok: <why>`       → rc=0
//   4  hatch cn        `# 竞态窗口语义（CLAUDE.md 边界）：` → rc=0
//   5  hatch bare      `# sleep-ok:` (no reason) → rc≠0 (bare tag is not a pass)
//   6  loop exempt     bounded-predicate poll    → rc=0
//   7  baseline gone   no bare-integer line      → rc≠0 (FATAL, not silent)
//   8  restored        clean tree again          → rc=0
//
// Exit 0 iff every expectation holds. Run: node launch/tests/lint/probe_bash_sleep_gate.mjs

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GATE = path.join(REPO, 'launch/tests/lint/check_bash_sleep.mjs');
const BASELINE = path.join(REPO, 'launch/tests/lint/bash-sleep-baseline.txt');

let passed = 0, failed = 0;
function step(id, cond, detail = '') {
    const verdict = cond ? 'PASS' : 'FAIL';
    console.log(`[probe-gate] STEP=${id} ${verdict}${detail ? ` — ${detail}` : ''}`);
    if (cond) passed += 1; else failed += 1;
}

function runGate() {
    const r = spawnSync('node', [GATE], { encoding: 'utf8' });
    return { rc: r.status, out: r.stdout || '', err: r.stderr || '' };
}

function gateSummary(out) {
    const m = out.match(/violations=(\d+) baseline=(\d+)/);
    return m ? { violations: Number(m[1]), baseline: Number(m[2]) } : null;
}

// Probe-owned .sh artifact inside the gate domain; removed in finally.
const TMP_SH = path.join(REPO, 'launch/tests/lint/_probe_tmp.sh');
function withTmpSh(content, fn) {
    writeFileSync(TMP_SH, content);
    try { return fn(); } finally { try { unlinkSync(TMP_SH); } catch {} }
}

const results = {};

// 1 — positive: the committed tree is green.
{
    const r = runGate();
    const s = gateSummary(r.out);
    results.positive_rc = r.rc;
    results.positive_summary = r.out.trim().split('\n')[0] || '';
    step('positive', r.rc === 0 && s && s.violations === s.baseline,
        `rc=${r.rc} ${results.positive_summary}`);
}

// 2 — negative: an unannotated literal sleep turns the gate red and is
// listed by site; removing it restores green.
{
    const r = withTmpSh('# probe artifact (negative)\nsleep 9\n', runGate);
    results.negative_inject_rc = r.rc;
    const listed = r.err.includes('launch/tests/lint/_probe_tmp.sh');
    step('negative-inject', r.rc !== 0 && listed,
        `rc=${r.rc} site_listed=${listed}`);
    const back = runGate();
    results.after_restore_rc = back.rc;
    step('negative-restore', back.rc === 0, `rc=${back.rc}`);
}

// 3/4 — escape hatch, both accepted forms: annotated under-test semantics
// stay within baseline.
{
    const ascii = withTmpSh('sleep 9 # sleep-ok: probe: injected slow-path latency IS the semantics under test\n', runGate);
    results.hatch_ascii_rc = ascii.rc;
    step('hatch-ascii', ascii.rc === 0, `rc=${ascii.rc}`);

    const cn = withTmpSh('sleep 9 # 竞态窗口语义（CLAUDE.md 边界）：probe: race-window reproduction delay\n', runGate);
    results.hatch_cn_rc = cn.rc;
    step('hatch-cn', cn.rc === 0, `rc=${cn.rc}`);
}

// 5 — control: a bare `# sleep-ok:` tag with no reason must NOT exempt.
{
    const r = withTmpSh('sleep 9 # sleep-ok:\n', runGate);
    results.hatch_bare_rc = r.rc;
    step('hatch-bare-not-exempt', r.rc !== 0, `rc=${r.rc}`);
}

// 6 — bounded predicate polling (loop body) is exempt by design.
{
    const loop = [
        'while ! grep -q "^ready$" "$1/state"; do',
        '    sleep 9',
        'done',
    ].join('\n');
    const r = withTmpSh(loop + '\n', runGate);
    results.loop_exempt_rc = r.rc;
    step('loop-exempt', r.rc === 0, `rc=${r.rc}`);
}

// 7 — baseline line deleted (stock converged but baseline not synced): the
// gate must fail loudly (FATAL), never pass without a baseline.
{
    const orig = readFileSync(BASELINE, 'utf8');
    writeFileSync(BASELINE, '# baseline number deleted (simulated unsynced ratchet edit)\n');
    let r;
    try { r = runGate(); } finally { writeFileSync(BASELINE, orig); }
    results.baseline_deleted_rc = r.rc;
    const fatal = /FATAL/.test(r.err);
    step('baseline-deleted', r.rc !== 0 && fatal, `rc=${r.rc} fatal=${fatal}`);
    const back = runGate();
    results.baseline_restored_rc = back.rc;
    step('baseline-restore', back.rc === 0, `rc=${back.rc}`);
}

// 8 — final state: probe left the tree exactly as it found it.
{
    const st = spawnSync('git', ['status', '--porcelain', '--', 'launch/tests/lint'], { encoding: 'utf8', cwd: REPO });
    results.tree_clean = st.stdout.trim() === '';
    step('tree-clean', results.tree_clean, st.stdout.trim() || 'clean');
}

console.log(`[probe-gate] SUMMARY: PASS=${passed} FAIL=${failed}`);
console.log(`[probe-gate] RC_SEQUENCE: ${JSON.stringify(results)}`);
process.exit(failed === 0 ? 0 : 1);
