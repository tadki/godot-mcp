#!/usr/bin/env node
// launch coverage gate — SEE-1334 SPEC-021 (revised per QA D1 rework).
//
// One repo-internal, reproducible command: run the launch vitest suite with
// NODE_V8_COVERAGE pointed at a dump dir (injected per-child by the generated
// wrappers — see vitest.config.ts), merge the raw child-process v8 output
// with c8, and judge line+branch thresholds. Exit 0 = gate green.
//
// Why this shape: the launch harnesses exercise the proxy through CHILD
// processes, so vitest's own coverage provider always reports 0% for the
// launch runtime — its thresholds were a fake gate. The raw v8 dump dir is
// the only place child-process coverage exists; c8 (already a transitive of
// the toolchain, pinned as a direct devDep) merges it. Numbers equal the
// P2-measured baseline (71.6% lines / 69.4% branch / 73.0% funcs).
//
// Usage: node launch/tests/runner/coverage-gate.mjs   (repo root; or
//        npm run coverage:launch). Env: LAUNCH_COVERAGE_DIR overrides the
//        dump dir (default: <repo>/coverage/launch-v8-raw).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DUMP_DIR = process.env.LAUNCH_COVERAGE_DIR || path.join(REPO, 'coverage', 'launch-v8-raw');
const MERGED_DIR = path.join(REPO, 'coverage', 'launch-v8-merged');
const VITEST_TIMEOUT_MS = 15 * 60 * 1000; // full suite ≈11min measured on 4 cores

// First measured P2 baseline (run over the full fast+long suite): 71.6%
// statements/lines, 69.4% branch, 73.0% functions. Floors sit just below —
// ratchet ONLY-UP (plan §8); they gate REGRESSIONS, not aspirations.
const THRESHOLDS = { lines: 70, branches: 68, statements: 70, functions: 72 };
const RUN_INCLUDE = [
    'launch/godot-mcp-proxy.mjs',
    'launch/proxy/**/*.mjs',
    'launch/*.mjs',
];
const RUN_EXCLUDE = ['launch/tests/**', 'launch/vitest.config.ts'];

function fail(msg) {
    console.error(`[coverage-gate] ERROR: ${msg}`);
    process.exit(1);
}

mkdirSync(DUMP_DIR, { recursive: true });
rmSync(MERGED_DIR, { recursive: true, force: true });

// 1) Run the suite; the generated wrappers inject NODE_V8_COVERAGE into every
//    harness child when LAUNCH_COVERAGE_DIR is set (this process's env).
//    Scope = the FAST tier (66 entries) — the set PR CI actually gates. The
//    long tier stays in launch-special's long-suites job: its ws5 harness
//    reads a dev-box artifact from the real $HOME (R3.5) and cannot pass on
//    a clean CI runner — a pre-existing harness property (reported, not
//    fixed here: 用例语义不动).
console.log('[coverage-gate] 1/3 running launch vitest fast tier (children dump raw v8)...');
const vitest = spawnSync('npx', ['vitest', 'run', 'launch/tests/.vitest-gen/fast'], {
    cwd: path.join(REPO, 'launch'),
    stdio: 'inherit',
    env: { ...process.env, LAUNCH_COVERAGE_DIR: DUMP_DIR },
    timeout: VITEST_TIMEOUT_MS,
});
if (vitest.error) fail(`vitest could not run: ${vitest.error.message}`);
if (vitest.status !== 0) fail(`vitest suite failed (rc=${vitest.status}) — coverage gate cannot judge a red suite`);

// 2) Merge raw child dumps. c8 merges every *.json in the dir into one
//    coverage-final.json; a pristine copy keeps the merge deterministic
//    (stray stale dumps from earlier runs must not inflate the numbers).
const dumpFiles = readdirSync(DUMP_DIR).filter((f) => f.endsWith('.json'));
if (dumpFiles.length === 0) {
    fail(`no raw v8 dumps found in ${DUMP_DIR} — the wrappers did not inject NODE_V8_COVERAGE (regenerated config missing?)`);
}
console.log(`[coverage-gate] 2/3 merging ${dumpFiles.length} child-process v8 dump(s) via c8...`);
const staging = mkdtempSync(path.join(REPO, 'coverage', 'launch-v8-stage-'));
for (const f of dumpFiles) cpSync(path.join(DUMP_DIR, f), path.join(staging, f));
const c8Args = [
    'c8', 'report',
    '--temp-directory', staging,
    '--reporter', 'json-summary',
    '--reporter', 'text',
    '--report-dir', MERGED_DIR,
];
for (const inc of RUN_INCLUDE) c8Args.push('--include', inc);
for (const exc of RUN_EXCLUDE) c8Args.push('--exclude', exc);
const c8 = spawnSync('npx', c8Args, { cwd: REPO, stdio: 'inherit', timeout: 5 * 60 * 1000 });
rmSync(staging, { recursive: true, force: true });
if (c8.status !== 0) fail(`c8 merge failed (rc=${c8.status})`);

// 3) Judge thresholds from the merged summary (single source of truth).
const summaryPath = path.join(MERGED_DIR, 'coverage-summary.json');
if (!existsSync(summaryPath)) fail('c8 produced no coverage-summary.json');
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const total = summary.total;
const pct = {
    lines: total.lines.pct,
    branches: total.branches.pct,
    statements: total.statements.pct,
    functions: total.functions.pct,
};
console.log('[coverage-gate] 3/3 judging thresholds:',
    `lines=${pct.lines} (≥${THRESHOLDS.lines})`,
    `branches=${pct.branches} (≥${THRESHOLDS.branches})`,
    `statements=${pct.statements} (≥${THRESHOLDS.statements})`,
    `functions=${pct.functions} (≥${THRESHOLDS.functions})`);

const breaches = Object.entries(THRESHOLDS)
    .filter(([k, floor]) => pct[k] < floor)
    .map(([k, floor]) => `${k} ${pct[k]} < ${floor}`);
if (breaches.length > 0) {
    console.error(`[coverage-gate] FAIL: threshold breach(es): ${breaches.join('; ')} — ratchet ONLY-UP, fix coverage before lowering`);
    process.exit(1);
}
console.log('[coverage-gate] PASS: launch coverage gate green (repo-internal, reproducible)');
