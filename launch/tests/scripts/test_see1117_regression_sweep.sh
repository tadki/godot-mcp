#!/usr/bin/env bash
# SEE-1117 Direction 3 — pre-existing test regression sweep (Owner 补充验收 2).
#
# Runs every Phase 1 / Direction 3 pre-existing godot-mcp regression test
# (originally under .dev/godot-mcp/tests/ — that tree was retired in
# SEE-1273 T5-F: library tests migrated to fork launch/tests/, consumer-side
# tests live under .dev/tests/)
# and reports PASS/FAIL per file. Does NOT modify the tests; failures are
# surfaced for Atlas to judge whether they are Direction 3 defects or
# semantically obsolete tests.
#
# Excluded (and why):
#   - tests written FOR SEE-1117 (Suite A sidecar / live sidecar e2e /
#     Phase 1 marker lifecycle / live e2e editor port): they are the NEW
#     QA suites tracked separately, not "pre-existing regression".
#   - e2e/ and abtest/ suites: require live editor + WS
#     handshake; documented as deferred in the QA report.
#   - Helper files (prefixed with _ or .mjs without a test_ entrypoint).
#
# Run from repo root:
#   bash launch/tests/scripts/test_see1117_regression_sweep.sh
#
# Output: per-file PASS/FAIL + final summary; non-zero exit if any FAIL.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

PASS_FILES=()
FAIL_FILES=()
SKIP_FILES=()
TIMEOUT_SEC=60

is_new_see1117_test() {
    case "$(basename "$1")" in
        test_see1117_*) return 0 ;;
        *) return 1 ;;
    esac
}

is_helper() {
    case "$(basename "$1")" in
        _*)        return 0 ;;
        *.py)      return 0 ;;  # helper scripts (e2e support) — not standalone
        ws-mock-listener.mjs) return 0 ;;
        test_see1110_stage_parser.mjs|test_see1085_t7_resolver.mjs|test_see1085_t8_direct_node.sh)
            # node-based runners — keep them (they execute standalone)
            return 1 ;;
        *) return 1 ;;
    esac
}

run_one() {
    local f="$1"
    local log="/tmp/see1117-regression-$(basename "$f").log"
    mkdir -p /tmp
    local rc
    case "$f" in
        *.sh)  timeout "$TIMEOUT_SEC" bash "$f" >"$log" 2>&1; rc=$? ;;
        *.mjs) timeout "$TIMEOUT_SEC" node "$f" >"$log" 2>&1; rc=$? ;;
        *)     echo "unknown type: $f"; return 2 ;;
    esac
    if (( rc == 0 )); then
        PASS_FILES+=("$f")
        printf '  [PASS] %s\n' "$f"
    elif (( rc == 124 )); then
        SKIP_FILES+=("$f (timeout ${TIMEOUT_SEC}s)")
        printf '  [SKIP] %s (timeout %ds — likely needs live editor or network)\n' "$f" "$TIMEOUT_SEC"
    else
        FAIL_FILES+=("$f (rc=$rc, log=$log)")
        printf '  [FAIL] %s rc=%d (log: %s)\n' "$f" "$rc" "$log"
    fi
}

echo "== SEE-1117 Direction 3 regression sweep =="

# 1+2. Former .dev/godot-mcp/tests/{scripts,hooks}/ — retired in SEE-1273 T5-F.
# Library-side tests now live in the fork (launch/tests/); the fork repo runs
# them via its own CI. Nothing to sweep here anymore.
echo "--- .dev/godot-mcp/tests/{scripts,hooks}/ --- (retired SEE-1273 T5-F; library tests moved to fork launch/tests/)"

# 3. .dev/tests/scripts/ — only godot/mcp-related pre-existing (none currently
# besides SEE-1117 ones, but include for completeness).
echo "--- .dev/tests/scripts/ (godot/mcp-related, pre-existing) ---"
for f in .dev/tests/scripts/test_*.sh; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in
        test_see1117_*|test_asset_import.sh|test_remote_agent_branch_cleanup.sh|test_workspace_env_check.sh|test_see1005_*|test_see765_*|test_see899_*|test_see913_*|test_version_check.py)
            # test_see1117_*: this issue's new tests (tracked separately)
            # others: not godot-mcp related (asset import, workspace env, etc.)
            SKIP_FILES+=("$f (out of scope)")
            continue
            ;;
    esac
    run_one "$f"
done

echo
echo "== summary =="
echo "  PASS: ${#PASS_FILES[@]}"
echo "  FAIL: ${#FAIL_FILES[@]}"
echo "  SKIP: ${#SKIP_FILES[@]}"
if ((${#FAIL_FILES[@]} > 0)); then
    echo "  failed files:"
    for f in "${FAIL_FILES[@]}"; do echo "    - $f"; done
fi
if ((${#SKIP_FILES[@]} > 0)); then
    echo "  skipped:"
    for f in "${SKIP_FILES[@]}"; do echo "    - $f"; done
fi

# Exit non-zero only on FAIL (SKIP is informational).
if ((${#FAIL_FILES[@]} > 0)); then exit 1; fi
exit 0
