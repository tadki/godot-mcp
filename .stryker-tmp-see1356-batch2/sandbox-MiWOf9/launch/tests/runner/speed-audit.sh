#!/usr/bin/env bash
# launch fast-tier speed audit — SEE-1334 Phase 2 / SPEC-023 (plan §6).
#
# Runs the launch vitest suite (fast+long headless buckets), then audits
# per-test durations from vitest's JSON report:
#   - any single entry > 60s  → flagged for downgrade review (move to long)
#   - total suite time > 8min → flagged (80% of the 10min fast job budget)
#
# Non-blocking advisory: exit 0 always (nightly evidence), findings are
# printed machine-greppably (`[speed-audit] ...`) and attached to the run
# log. Downgrade review = a documented decision on the issue, not an auto-move.
#
# Usage: bash launch/tests/runner/speed-audit.sh   (from repo root or anywhere)
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO/launch"

OUT_JSON="$(mktemp /tmp/speed-audit-XXXXXX.json)"
trap 'rm -f "$OUT_JSON"' EXIT

# Per-child-process coverage is NOT needed here — plain run, JSON durations.
npx vitest run --reporter=json --outputFile="$OUT_JSON" > /tmp/speed-audit-vitest.log 2>&1
RC=$?
if [ "$RC" -ne 0 ]; then
    echo "[speed-audit] ERROR: vitest run failed rc=$RC — audit aborted"
    echo "[speed-audit] vitest log tail:"
    tail -30 /tmp/speed-audit-vitest.log | sed 's/^/    | /'
    exit 1
fi

# job budget: 8min = 80% of the 10min fast-tier job budget (plan §6)
MAX_ENTRY_MS=60000
MAX_TOTAL_MS=480000

node - "$OUT_JSON" <<'EOF'
import { readFileSync } from 'node:fs';
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
// jest-style JSON: testResults[].assertionResults[] carries duration directly.
const rows = [];
for (const f of report.testResults ?? []) {
  for (const t of f.assertionResults ?? []) {
    if (t.status === 'skipped') continue;
    rows.push({ name: t.fullName, ms: t.duration ?? 0 });
  }
}
const total = rows.reduce((a, r) => a + r.ms, 0);
console.log(`[speed-audit] entries=${rows.length} total=${(total / 1000).toFixed(1)}s`);
let breaches = 0;
for (const r of rows.sort((a, b) => b.ms - a.ms)) {
  if (r.ms > 60000) {
    breaches++;
    console.log(`[speed-audit] ENTRY>60s (${(r.ms / 1000).toFixed(1)}s): ${r.name} — downgrade review candidate (long tier)`);
  }
}
if (total > 480000) {
  breaches++;
  console.log(`[speed-audit] JOB>8min (${(total / 1000 / 60).toFixed(1)}min) — fast-tier budget breach, review required`);
}
console.log(breaches === 0
  ? '[speed-audit] OK: no downgrade-review breaches'
  : `[speed-audit] ${breaches} breach(es) — downgrade review required (see plan §6, leave a decision trail on the issue)`);
EOF
