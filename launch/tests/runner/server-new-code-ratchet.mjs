#!/usr/bin/env node
// server new-code coverage ratchet — SEE-1334 SPEC-062.
//
// Global floors (75/68/79/75) stay in server/vitest.config.ts. This adds the
// NEW-CODE ≥95 per-file rule: source files added to server/src AFTER the
// grandfather anchor (the pre-hardening tip) must each reach 95% lines.
// Grandfathered files are governed only by the global floors — the ~25%
// legacy gap is not backfilled (Owner ruling, 2026-09-22).
//
// Mechanism: vitest run --coverage (json-summary) + git diff vs the anchor.
// Runs as part of the PR gate via build-and-test? Standalone:
//   npm run coverage:server-new
// Exit 1 on any new-file breach.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GRANDFATHER_ANCHOR = '6123f882ff54a2969a0b0b017d18df35984f38ae';
const NEW_FILE_FLOOR = 95;

const fail = (msg) => { console.error(`[server-ratchet] ERROR: ${msg}`); process.exit(1); };

const git = spawnSync('git', ['diff', '--name-only', '--diff-filter=A', `${GRANDFATHER_ANCHOR}`, '--cached', '--', 'server/src', ':(exclude)server/src/__tests__/**'], {
    cwd: REPO, encoding: 'utf8', timeout: 30_000,
});
if (git.status !== 0) {
    console.log('[server-ratchet] no git context — ratchet skipped (sandbox)');
    process.exit(0);
}
const added = git.stdout.split('\n').filter(Boolean);
if (added.length === 0) {
    console.log('[server-ratchet] no new server/src files since the anchor — nothing to ratchet');
    process.exit(0);
}
console.log(`[server-ratchet] new files under the ≥${NEW_FILE_FLOOR}% rule:\n  ${added.join('\n  ')}`);

const covDir = path.join(REPO, 'coverage', 'server-new');
rmSync(covDir, { recursive: true, force: true });
const vitest = spawnSync('npx', ['vitest', 'run', '--coverage.coverageProvider', 'v8', '--coverage.reporter', 'json-summary', '--coverage.reportsDirectory', covDir], {
    cwd: path.join(REPO, 'server'), stdio: 'inherit', timeout: 10 * 60 * 1000,
    env: { ...process.env, NODE_V8_COVERAGE: '' },
});
if (vitest.status !== 0) fail(`vitest failed (rc=${vitest.status})`);

const summaryPath = path.join(covDir, 'coverage-summary.json');
if (!existsSync(summaryPath)) fail('vitest produced no coverage-summary.json');
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));

const breaches = [];
for (const rel of added) {
    const abs = path.join(REPO, rel);
    const entry = summary[abs] ?? summary[rel];
    if (!entry) {
        breaches.push(`${rel}: 0% (no coverage data — file never imported by tests)`);
        continue;
    }
    if (entry.lines.pct < NEW_FILE_FLOOR) {
        breaches.push(`${rel}: lines ${entry.lines.pct}% < ${NEW_FILE_FLOOR}%`);
    }
}
if (breaches.length > 0) {
    console.error(`[server-ratchet] FAIL: new-code ≥${NEW_FILE_FLOOR}% breach(es):\n  ${breaches.join('\n  ')}`);
    process.exit(1);
}
console.log(`[server-ratchet] PASS: all ${added.length} new file(s) ≥${NEW_FILE_FLOOR}% lines`);
