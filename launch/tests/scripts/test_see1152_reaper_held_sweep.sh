#!/usr/bin/env bash
# test_see1152_reaper_held_sweep.sh
#
# SEE-1152 (Owner directive, Atlas 综合补丁 目标1): the reaper's held-dir sweep
# must delete ONLY held-lock dirs whose recorded pid fails the ARBITER liveness
# standard (port_arbiter_pid_alive: kill -0 + /proc/<pid>/exe must be node),
# and must NEVER delete a live dir. Covers both held-dir families:
#   1. per-port arbiter grants   $(port_arbiter_held_dir)/<port>/   (sandboxed
#      via the KOL_PORT_HELD_DIR seam);
#   2. per-runtime launcher locks ${SCRIPT_DIR}/held/<runtime_id>/  (present in
#      this worktree only when a launcher ran here — created when absent so the
#      sweep is always exercised, then cleaned up).
#
# Cases (all run against the REAL reap-stale-leases.sh binary):
#   T1: port-held dir whose pid is alive AND node          -> KEPT
#   T2: port-held dir whose pid is dead                    -> DELETED
#   T3: port-held dir whose pid is alive but NON-node
#       (PID reused by an unrelated process)               -> DELETED
#   T4: launcher-held dir with a dead pid                  -> DELETED
#   T5: launcher-held dir with a live node pid             -> KEPT
#   T6: dry-run reports dead dirs but deletes NOTHING
#
# Sandbox strategy mirrors test_see1152_reaper_registry_sweep.sh: PID liveness
# is controlled with a REAL live pid force-treated as node via the arbiter's
# KOL_PORT_ARBITER_TEST_PID_NODE seam (this shell's /proc/self/exe is bash, not
# node, so the seam is required for the KEPT case) plus a REAL live NON-node
# pid (sleep) for the PID-reuse case. Both seams live in the LIBS, so reaper
# and arbiter share one liveness implementation (约束: held PID 校验复用
# port_arbiter_pid_alive，不新造).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REAPER="$REPO_ROOT/launch/reap-stale-leases.sh"
LAUNCH_HELD="$REPO_ROOT/launch/held"

PASS=0
FAIL=0
FAILS=()
ok()   { echo "  [PASS] $*"; PASS=$((PASS+1)); }
ko()   { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }
sect() { echo; echo "===== $* ====="; }

[[ -x "$REAPER" ]] || { echo "FATAL: reaper not executable: $REAPER" >&2; exit 2; }

SBOX="$(mktemp -d)"
CREATED_LAUNCH_HELD=0
cleanup() {
    rm -rf "$SBOX"
    [[ -n "${SLEEP_PID:-}" ]] && kill "$SLEEP_PID" 2>/dev/null
    # Remove only the launcher-held dirs this test created; never touch a
    # pre-existing held/ tree (a live launcher could be using it).
    rm -rf "$LAUNCH_HELD/Live-node" "$LAUNCH_HELD/Dead-pid" 2>/dev/null
    (( CREATED_LAUNCH_HELD == 1 )) && rmdir "$LAUNCH_HELD" 2>/dev/null
    return 0
}
trap cleanup EXIT

mkdir -p "$SBOX/ws"            # empty workspace root — no lease sidecars
PORT_HELD="$SBOX/port-held"    # sandbox for ~/.multica/godot-mcp-held
REG="$SBOX/registry.json"      # sandbox registry (kept absent — not under test)
mkdir -p "$PORT_HELD"

# A live NON-node process for the PID-reuse case.
sleep 120 &
SLEEP_PID=$!

# run_reaper <dry_run:0|1> — real reaper, sandboxed port-held + registry,
# pwsh disabled (hermetic), resident mode (skip the 3s live abort window),
# this shell's PID force-treated as node for the KEPT case.
run_reaper() {
    local dry="$1"
    local args=(--root "$SBOX/ws")
    (( dry == 1 )) && args+=(--dry-run)
    KOL_PORT_ARBITER_TEST_PID_NODE="$$" \
    KOL_PORT_HELD_DIR="$PORT_HELD" \
    KOL_PORT_REGISTRY_PATH_OVERRIDE="$REG" \
    KOL_REAP_DISABLE_PWSH=1 \
    KOL_REAP_RESIDENT=1 \
    "$REAPER" "${args[@]}" 2>&1
}

seed_dirs() {
    rm -rf "$PORT_HELD" "$LAUNCH_HELD/Live-node" "$LAUNCH_HELD/Dead-pid"
    mkdir -p "$PORT_HELD"
    # Per-port arbiter dirs.
    mkdir -p "$PORT_HELD/6560"; printf '%s\n' "$1"        > "$PORT_HELD/6560/pid"   # live node -> KEPT
    mkdir -p "$PORT_HELD/6561"; printf '%s\n' "99999999"  > "$PORT_HELD/6561/pid"   # dead pid  -> DELETED
    mkdir -p "$PORT_HELD/6562"; printf '%s\n' "$SLEEP_PID" > "$PORT_HELD/6562/pid"  # non-node  -> DELETED
    # Per-runtime launcher dirs.
    [[ -d "$LAUNCH_HELD" ]] || { mkdir -p "$LAUNCH_HELD"; CREATED_LAUNCH_HELD=1; }
    mkdir -p "$LAUNCH_HELD/Live-node"; printf '%s\n' "$1"       > "$LAUNCH_HELD/Live-node/pid"  # KEPT
    mkdir -p "$LAUNCH_HELD/Dead-pid";  printf '%s\n' "99999999" > "$LAUNCH_HELD/Dead-pid/pid"   # DELETED
}

sect "T1-T5: live dirs KEPT, dead/non-node dirs DELETED (port + launcher held)"
seed_dirs "$$"
OUT="$(run_reaper 0)"
echo "$OUT" | grep -q "HELD-DEAD dir=${PORT_HELD}/6561/"        && ok "T2: dead port-held reported"        || ko "T2: dead port-held not reported: $OUT"
echo "$OUT" | grep -q "HELD-DEAD dir=${PORT_HELD}/6562/"        && ok "T3: non-node port-held reported"    || ko "T3: non-node port-held not reported: $OUT"
echo "$OUT" | grep -q "HELD-DEAD dir=${LAUNCH_HELD}/Dead-pid/"  && ok "T4: dead launcher-held reported"    || ko "T4: dead launcher-held not reported: $OUT"
echo "$OUT" | grep -q "HELD-DEAD dir=${PORT_HELD}/6560/"        && ko "T1: live port-held wrongly reaped"  || ok "T1: live port-held not reported as dead"
echo "$OUT" | grep -q "HELD-DEAD dir=${LAUNCH_HELD}/Live-node/" && ko "T5: live launcher-held wrongly reaped" || ok "T5: live launcher-held not reported as dead"
[[ -d "$PORT_HELD/6560" ]]        && ok "T1: live port-held dir KEPT on disk"       || ko "T1: live port-held dir was deleted"
[[ -d "$LAUNCH_HELD/Live-node" ]] && ok "T5: live launcher-held dir KEPT on disk"   || ko "T5: live launcher-held dir was deleted"
[[ ! -d "$PORT_HELD/6561" ]]      && ok "T2: dead port-held dir deleted"            || ko "T2: dead port-held dir still present"
[[ ! -d "$PORT_HELD/6562" ]]      && ok "T3: non-node port-held dir deleted"        || ko "T3: non-node port-held dir still present"
[[ ! -d "$LAUNCH_HELD/Dead-pid" ]] && ok "T4: dead launcher-held dir deleted"       || ko "T4: dead launcher-held dir still present"

sect "T6: dry-run reports but deletes NOTHING"
seed_dirs "$$"
OUT="$(run_reaper 1)"
echo "$OUT" | grep -q "(dry-run) would delete held dir ${PORT_HELD}/6561/"       && ok "T6: dry-run reports dead port-held"    || ko "T6: dry-run did not report port-held: $OUT"
echo "$OUT" | grep -q "(dry-run) would delete held dir ${LAUNCH_HELD}/Dead-pid/" && ok "T6: dry-run reports dead launcher-held" || ko "T6: dry-run did not report launcher-held: $OUT"
[[ -d "$PORT_HELD/6561" ]] && [[ -d "$PORT_HELD/6562" ]] && [[ -d "$LAUNCH_HELD/Dead-pid" ]] \
    && ok "T6: dry-run deleted nothing" || ko "T6: dry-run deleted a dir"

echo
echo "===== summary: pass=$PASS fail=$FAIL ====="
if (( FAIL > 0 )); then
    for f in "${FAILS[@]}"; do echo "  - $f"; done
    exit 1
fi
exit 0
