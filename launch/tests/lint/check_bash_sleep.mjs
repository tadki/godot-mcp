#!/usr/bin/env node
// check_bash_sleep.mjs — SEE-1363 §SPEC-005: bash-domain fixed-sleep lint gate.
//
// The JS domain has had this coverage since SEE-1344 ⑬ (ESLint
// no-restricted-syntax on setTimeout(fn, N), warning tier + --max-warnings
// ratchet). Bash has no linter of its own, so the same policy lands here as a
// grep-class gate: a literal `sleep N` used as a synchronization wait is a
// violation; the count is pinned by bash-sleep-baseline.txt and may ONLY
// ratchet down (new unannotated sites turn the gate red).
//
// Domain: launch/*.sh + launch/tests/**/*.sh
//
// Violation: a line matching a literal numeric sleep — /(^|[\s;&|(])sleep\s+[0-9]/ —
// minus two exempt classes (repo CLAUDE.md 「同步等待」正例/边界):
//   1. Bounded predicate polling (正例 #4): the sleep sits inside a
//      while/until/for loop body (loop-depth tracked over `done`).
//   2. Escape hatch (边界条款): the line carries an inline annotation naming
//      the delay's semantic role — for delays that ARE the semantics under
//      test (race windows, injected slow-path latency). Accepted forms: the
//      SEE-1344 house style `# 竞态窗口语义（CLAUDE.md 边界）：<why>` and the
//      ASCII alias `# sleep-ok: <why>`.
//
// Full-comment lines (^\s*#) never match. Variable delays (`sleep "$X"`) are
// not literal sites and are not counted.
//
// Exit 0 when violations <= baseline (and prints a ratchet-down hint when the
// count dropped); exit 1 with the full site list when violations grow.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BASELINE_FILE = path.join(REPO, 'launch/tests/lint/bash-sleep-baseline.txt');

const SLEEP_RE = /(^|[\s;&|(])sleep\s+[0-9]/;
const LOOP_OPEN_RE = /^\s*(while|until|for)\b/;
const LOOP_CLOSE_RE = /\bdone\b/;
const COMMENT_RE = /^\s*#/;
const HATCH_RE = /#\s*(sleep-ok:|竞态窗口语义（CLAUDE\.md 边界）)[:：]?\s*\S/;

function collectSh(dir, recursive, out = []) {
    for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) { if (recursive) collectSh(p, recursive, out); continue; }
        if (name.endsWith('.sh')) out.push(p);
    }
    return out;
}

const files = [
    ...collectSh(path.join(REPO, 'launch'), false),
    ...collectSh(path.join(REPO, 'launch/tests'), true),
].sort();

const violations = [];
for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    let depth = 0;
    let heredocTag = null;
    lines.forEach((text, i) => {
        // SEE-1363 §SPEC-016: heredoc bodies and comment lines are not shell
        // control flow — their loop keywords must not move the depth counter
        // (a python heredoc's `for` line used to pin depth>0 forever, hiding
        // every later sleep in the file — Final Review LOW #2,实证于 see1070).
        if (heredocTag !== null) {
            if (new RegExp(`^\\t*${heredocTag}\\s*$`).test(text)) { heredocTag = null; return; }
            // heredoc body: not shell control flow — no loop-depth tracking.
            // Sleep matching still applies (embedded sleeps are real;
            // cf. the SPEC-002 awk-string precedent) but can never claim the
            // in-loop exemption (no loop tracking here by design).
            if (!COMMENT_RE.test(text) && SLEEP_RE.test(text) && !HATCH_RE.test(text)) {
                violations.push(`${path.relative(REPO, file)}:${i + 1}: ${text.trim()}`);
            }
            return;
        }
        const hd = text.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
        if (hd) heredocTag = hd[1];
        const opensLoop = !COMMENT_RE.test(text) && LOOP_OPEN_RE.test(text);
        if (!COMMENT_RE.test(text) && SLEEP_RE.test(text)) {
            if (HATCH_RE.test(text)) {
                // escape hatch: annotated under-test semantics
            } else if (depth > 0 || opensLoop) {
                // bounded predicate polling (loop body; a one-line loop header
                // covers its own `...; do sleep 0.2; done` body)
            } else {
                violations.push(`${path.relative(REPO, file)}:${i + 1}: ${text.trim()}`);
            }
        }
        if (opensLoop) depth += 1;
        if (!COMMENT_RE.test(text) && LOOP_CLOSE_RE.test(text)) depth = Math.max(0, depth - 1);
    });
}

const baselineText = readFileSync(BASELINE_FILE, 'utf8');
const baseline = Number(baselineText.split('\n').map((l) => l.trim()).find((l) => /^\d+$/.test(l)));
if (!Number.isInteger(baseline)) {
    console.error(`[bash-sleep-gate] FATAL: no bare-integer line in ${path.relative(REPO, BASELINE_FILE)}`);
    process.exit(2);
}

console.log(`[bash-sleep-gate] files=${files.length} violations=${violations.length} baseline=${baseline}`);
if (violations.length > baseline) {
    console.error(`[bash-sleep-gate] FAIL: fixed-sleep sites grew past the ratchet baseline (${violations.length} > ${baseline}).`);
    console.error('[bash-sleep-gate] convert to event-driven waits (launch/tests/scripts/_wait_helpers.sh),');
    console.error('[bash-sleep-gate] or — only for delays that ARE the semantics under test — annotate inline:');
    console.error('[bash-sleep-gate]   # 竞态窗口语义（CLAUDE.md 边界）：<why>   (or ASCII alias:  # sleep-ok: <why>)');
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
}
if (violations.length < baseline) {
    console.log(`[bash-sleep-gate] count dropped ${baseline} → ${violations.length}: ratchet the baseline down in launch/tests/lint/bash-sleep-baseline.txt`);
}
