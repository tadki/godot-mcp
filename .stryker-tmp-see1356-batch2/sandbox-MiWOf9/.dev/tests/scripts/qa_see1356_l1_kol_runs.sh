#!/usr/bin/env bash
# qa_see1356_l1_kol_runs.sh — SEE-1356 §SPEC-L1-03 live evidence: run
# `gqt mutation` twice on the REAL KOL checkout against the same timing-store
# key; assert the second run's wall-clock drops significantly (negotiated
# budget from the store anchor vs the bootstrap anchor) with the JSON contract
# unchanged, then re-run the run_error regression test.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QATK="$(cd "$HERE/../../../../godot-qa-toolkit" && pwd)"
KOL="${KOL_ROOT:-/home/jerry/multica_workspaces/seed-478690824e46/see-1356-ef9f21ac6d16/workdir/KingOfLikes-Godot}"
GQT="$QATK/.venv/bin/gqt"
TARGET="${L1_TARGET:-utils/yaml_parser.gd}"
TESTS_GLOB="${L1_TESTS:-res://tests/unit/utils/}"
SB="$(mktemp -d)"
PASS=0; FAIL=0
ok() { if [[ "$2" == "1" ]]; then PASS=$((PASS+1)); echo "  [PASS] $1"; else FAIL=$((FAIL+1)); echo "  [FAIL] $1${3:+ — $3}"; fi; }

[[ -x "$GQT" ]] || { echo "gqt venv missing at $GQT"; exit 1; }
rm -rf "$KOL/.qa-cache/gqt-timing"

run_mutation() { # $1=out-json
    local t0 t1
    t0=$(date +%s)
    ( cd "$KOL" && PYTHONPATH="$QATK/src" "$GQT" mutation "$TARGET" --project-root "$KOL" --tests "$TESTS_GLOB" --budget 12 ) > "$1" 2> "$SB/gqt-err.log"
    local rc=$?
    t1=$(date +%s)
    echo "$((t1 - t0)) $rc"
}

echo "== L1 run 1 (fresh timing store; bootstrap anchor) =="
read -r W1 RC1 <<< "$(run_mutation "$SB/run1.json")"
ok "run1 exit=0 (rc=$RC1, wall=${W1}s)" "$([[ "$RC1" == "0" ]] && echo 1 || echo 0)" "$(tail -2 "$SB/gqt-err.log")"
TS1="$(jq -r '.summary.timing_source // "n/a"' "$SB/run1.json" 2>/dev/null)"
SN1="$(jq -r '.summary.samples_n // "n/a"' "$SB/run1.json" 2>/dev/null)"

echo "== L1 run 2 (store anchor; negotiated budget) =="
read -r W2 RC2 <<< "$(run_mutation "$SB/run2.json")"
ok "run2 exit=0 (rc=$RC2, wall=${W2}s)" "$([[ "$RC2" == "0" ]] && echo 1 || echo 0)" "$(tail -2 "$SB/gqt-err.log")"
TS2="$(jq -r '.summary.timing_source // "n/a"' "$SB/run2.json" 2>/dev/null)"
SN2="$(jq -r '.summary.samples_n // "n/a"' "$SB/run2.json" 2>/dev/null)"
P90="$(jq -r '.summary.baseline_p90 // "n/a"' "$SB/run2.json" 2>/dev/null)"

ok "timing_source: run1=bootstrap($TS1) → run2=store($TS2)" \
    "$([[ "$TS1" == "bootstrap" && "$TS2" == "store" ]] && echo 1 || echo 0)"
ok "samples_n 递增（$SN1 → $SN2）+ baseline_p90 落盘($P90)" \
    "$([[ "$SN1" != "n/a" && "$SN2" != "n/a" && "$SN2" -gt "$SN1" && "$P90" != "n/a" && "$P90" != "null" ]] && echo 1 || echo 0)"
RATIO="$(python3 -c "print(round($W2 / max($W1, 1), 3))" 2>/dev/null || echo 9)"
ok "第二次 wall-clock 显著降低（${W1}s → ${W2}s，ratio=$RATIO < 0.7）" \
    "$([[ "$RC1" == "0" && "$RC2" == "0" ]] && python3 -c "import sys; sys.exit(0 if ($W2 < $W1 * 0.7) else 1)" && echo 1 || echo 0)" \
    "w1=${W1}s w2=${W2}s"
K1="$(jq -r '.summary | keys | sort | join(",")' "$SB/run1.json" 2>/dev/null)"
K2="$(jq -r '.summary | keys | sort | join(",")' "$SB/run2.json" 2>/dev/null)"
ok "JSON 契约键集不变（run1 == run2）" "$([[ -n "$K1" && "$K1" == "$K2" ]] && echo 1 || echo 0)" "$K1"

echo "== run_error 复测 =="
( cd "$QATK" && PYTHONPATH="$QATK/src" .venv/bin/python -m pytest tests/unit/test_timing_l1.py::test_baseline_timeout_run_error_carries_suggested_action -q ) > "$SB/pytest.log" 2>&1
PYRC=$?
ok "test_baseline_timeout_returns_run_error_json_not_crash 全绿" \
    "$([[ "$PYRC" == "0" ]] && echo 1 || echo 0)" "rc=$PYRC $(tail -1 "$SB/pytest.log")"

cp "$SB/run1.json" "$SB/run2.json" "$SB/pytest.log" /tmp/see1356-l1-artifacts/ 2>/dev/null || mkdir -p /tmp/see1356-l1-artifacts && cp "$SB/run1.json" "$SB/run2.json" "$SB/pytest.log" /tmp/see1356-l1-artifacts/
echo "SUMMARY: PASS=$PASS FAIL=$FAIL (w1=${W1}s w2=${W2}s)"
rm -rf "$SB"
[[ $FAIL -gt 0 ]] && exit 1
exit 0
