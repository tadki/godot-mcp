#!/usr/bin/env bash
# SEE-1244 探针 #3 (SEE-1255) + 并发套件 B (SEE-1259) FAIL 修复 — same-runtime
# held-lock wait tests.
#
# Cases:
#   C1  live same-runtime holder exits (and is zombie/unreaped — production
#       shape: previous round's launcher exited inside its lease grace) →
#       launcher WAITS (RUNTIME_WAIT stream), recovers once the holder
#       lapses, RUNTIME_READY logged — no die
#   C2  live holder outlives the wait budget (KOL_RUNTIME_HELD_WAIT_S) →
#       die with waited seconds + the original fast-fail wording (red-line)
#   C3  stale holder (dead pid) → immediate recovery, zero waiting
#   C4  live-but-NON-node pid (PID reused by an unrelated process) →
#       treated dead, recovered (anti-PID-reuse gate intact)
#   C5  holder alive at the first probe but DIES MID-WAIT → the next 2s
#       re-probe detects the death and takes over in <5s total (never
#       waits the full budget on a corpse — the SEE-1259 concurrent-suite
#       failure shape)
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1244_runtime_held_wait.sh

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../" && pwd)"
LAUNCHER="$REPO/launch/godot-mcp-launcher.sh"

PASS=0; FAIL=0
ok() { if [[ "$2" == "1" ]]; then PASS=$((PASS+1)); echo "  [PASS] $1"; else FAIL=$((FAIL+1)); echo "  [FAIL] $1${3:+ — $3}"; fi; }
section() { echo; echo "== $1 =="; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Extract the real log()/log_stage()/die() + held-lock wait block from the
# launcher (single source of truth — no duplicated logic in the test) and run
# it against a sandboxed HELD_DIR. Exit code contract: rc≠0 = die path taken.
run_held_block() {
    local held_root="$1" wait_max_s="${2:-}" out="$3"
    python3 - "$LAUNCHER" "$held_root" "$wait_max_s" >"$out" 2>>"$out" <<'PYEOF'
import subprocess, sys
launcher, held_root, wait_max_s = sys.argv[1:4]
src = open(launcher).read()
prelude = src[src.find('log() {'):src.find('\n}\n', src.find('die() {')) + 3]
start = src.find('HELD_DIR="${SCRIPT_DIR}/held"')
end_marker = 'printf \'%s\\n\' "$$" > "${RUNTIME_HELD}/pid"'
block = src[start : src.find(end_marker, start) + len(end_marker) + 1]
block = block.replace('HELD_DIR="${SCRIPT_DIR}/held"', f'HELD_DIR="{held_root}/held"')
block = block.replace('RUNTIME_HELD="${HELD_DIR}/${KOL_RUNTIME_ID}"', 'RUNTIME_HELD="${HELD_DIR}/Revy-solo"')
head = 'LAUNCHER_LOG_FILE="" KOL_RUNTIME_ID=Revy-solo\n'
if wait_max_s: head += f'KOL_RUNTIME_HELD_WAIT_S={wait_max_s}\n'
r = subprocess.run(['bash','-c', head + prelude + '\n' + block + '\necho ACQUIRED; exit 0'],
                   capture_output=True, text=True, timeout=120)
# Marker first so the caller can read the held-block rc without a pipe race.
sys.stderr.write(f'RC={r.returncode}\n')
sys.stdout.write(r.stdout); sys.stderr.write(r.stderr)
PYEOF
    RC=$?
    # Python exit 0 even when the inner bash died — extract the inner rc.
    if grep -q '^RC=1$' "$out"; then RC=1; fi
    return $RC
}

mkheld() { local root="$1"; mkdir -p "$root/held/Revy-solo"; printf '%s' "$2" > "$root/held/Revy-solo/pid"; }

section "C1: zombie holder (exited, unreaped — production shape) → wait + recover"
{
    R="$TMP/c1"; mkheld "$R" ""; OUTFILE="$TMP/c1.out"
    node -e 'setTimeout(()=>{},5000)' & H_PID=$!
    printf '%s' "$H_PID" > "$R/held/Revy-solo/pid"
    T0=$(date +%s)
    run_held_block "$R" "" "$OUTFILE"; RC=$?
    DT=$(( $(date +%s) - T0 ))
    wait $H_PID 2>/dev/null || true
    OUT="$(cat "$OUTFILE")"
    ok "C1 acquires after holder lapses (no die)" "$([[ $RC -eq 0 && "$OUT" == *ACQUIRED* ]] && echo 1 || echo 0)" "rc=$RC dt=${DT}s out_tail=${OUT: -180}"
    ok "C1 RUNTIME_WAIT stream present" "$(grep -qc 'stage=RUNTIME_WAIT' "$OUTFILE" && echo 1 || echo 0)"
    ok "C1 RUNTIME_READY logged with waited_s" "$(grep -q 'stage=RUNTIME_READY.*waited_s=' "$OUTFILE" && echo 1 || echo 0)"
    ok "C1 acquired within holder lifetime window (~5s)" "$([[ $DT -ge 4 && $DT -le 14 ]] && echo 1 || echo 0)" "dt=${DT}s"
}

section "C2: live holder outlives the wait budget → die (red-line preserved)"
{
    R="$TMP/c2"; mkheld "$R" ""; OUTFILE="$TMP/c2.out"
    node -e 'setTimeout(()=>{},60000)' & H_PID=$!
    printf '%s' "$H_PID" > "$R/held/Revy-solo/pid"
    run_held_block "$R" 4 "$OUTFILE"; RC=$?
    kill $H_PID 2>/dev/null; wait $H_PID 2>/dev/null || true
    ok "C2 dies after timeout" "$([[ $RC -ne 0 ]] && ! grep -q 'ACQUIRED' "$OUTFILE" && echo 1 || echo 0)" "rc=$RC"
    ok "C2 die carries waited seconds + original fast-fail wording" "$(grep -q 'after waiting 4s' "$OUTFILE" && grep -q 'another proxy holds runtime_id=Revy-solo' "$OUTFILE" && echo 1 || echo 0)"
    ok "C2 RUNTIME_WAIT stream present" "$(grep -qc 'stage=RUNTIME_WAIT' "$OUTFILE" && echo 1 || echo 0)"
}

section "C3: stale holder (dead pid) → immediate recovery, zero waiting"
{
    R="$TMP/c3"; mkheld "$R" "999999999"; OUTFILE="$TMP/c3.out"
    run_held_block "$R" "" "$OUTFILE"; RC=$?
    ok "C3 stale clears + acquires immediately" "$([[ $RC -eq 0 ]] && grep -q 'ACQUIRED' "$OUTFILE" && echo 1 || echo 0)"
    ok "C3 fast-fail recovery log (stale, pid dead)" "$(grep -q 'fast-fail recovery' "$OUTFILE" && grep -q 'stale' "$OUTFILE" && echo 1 || echo 0)"
    ok "C3 no RUNTIME_WAIT stream (no wait needed)" "$(grep -q 'stage=RUNTIME_WAIT' "$OUTFILE" && echo 0 || echo 1)"
}

section "C4: live-but-non-node pid (PID reused) → treated dead, recovered"
{
    R="$TMP/c4"; mkheld "$R" ""; OUTFILE="$TMP/c4.out"
    sleep 30 & H_PID=$!
    printf '%s' "$H_PID" > "$R/held/Revy-solo/pid"
    run_held_block "$R" "" "$OUTFILE"; RC=$?
    kill $H_PID 2>/dev/null; wait $H_PID 2>/dev/null || true
    ok "C4 reused non-node pid recovered" "$([[ $RC -eq 0 ]] && grep -q 'ACQUIRED' "$OUTFILE" && echo 1 || echo 0)"
}

section "C5: holder dies MID-WAIT → next 2s tick takes over (<5s total)"
{
    # 并发验收套件 B 探针 (SEE-1259) 的失败形态：RUNTIME_WAIT 已进入但 holder
    # 在等待中途死亡（lease lapse 前），重探必须立刻检测死亡并清锁接管，
    # 绝不空等剩余预算。holder 活 3s（probe 1 时活着，probe 2 时已死）。
    R="$TMP/c5"; mkheld "$R" ""; OUTFILE="$TMP/c5.out"
    node -e 'setTimeout(()=>{},3000)' & H_PID=$!
    printf '%s' "$H_PID" > "$R/held/Revy-solo/pid"
    T0=$(date +%s)
    run_held_block "$R" "" "$OUTFILE"; RC=$?
    DT=$(( $(date +%s) - T0 ))
    wait $H_PID 2>/dev/null || true
    ok "C5 holder dies mid-wait → takeover (no die)" "$([[ $RC -eq 0 ]] && grep -q 'ACQUIRED' "$OUTFILE" && echo 1 || echo 0)" "rc=$RC dt=${DT}s"
    ok "C5 takeover within one 2s tick + reclaim (<5s)" "$([[ $DT -lt 5 ]] && echo 1 || echo 0)" "dt=${DT}s"
    ok "C5 RUNTIME_WAIT then RUNTIME_READY stream" "$(grep -q 'stage=RUNTIME_WAIT' "$OUTFILE" && grep -q 'stage=RUNTIME_READY' "$OUTFILE" && echo 1 || echo 0)"
}

echo
echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
if [[ $FAIL -gt 0 ]]; then exit 1; fi
