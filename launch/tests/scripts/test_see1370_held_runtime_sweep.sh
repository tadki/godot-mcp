#!/usr/bin/env bash
# test_see1370_held_runtime_sweep.sh
#
# SEE-1370 #7 (§SPEC-004): the reaper's held-lock sweep must cover the THIRD
# family — the per-runtime logical lock at $(state-dir)/held-runtime/<rid>/
# (state-file.mjs:63) — with its own owner-file name (`owner`, NOT `pid`) and a
# missing-owner staleness discriminator.
#
# Harness mirrors test_see1152_reaper_held_sweep.sh: vendored reaper+libs in a
# private tmp SCRIPT_DIR, hermetic pwsh, resident mode, sandboxed
# GODOT_MCP_HOME (the family root is $GODOT_MCP_HOME/held-runtime) and
# KOL_PORT_HELD_DIR. Liveness is controlled by the arbiter's
# KOL_PORT_ARBITER_TEST_PID_NODE seam (a real PID force-treated as node) plus a
# dead 99999999 pid.
#
# Cases (all against the REAL reap-stale-leases.sh, live + dry):
#   T1: held-runtime dir, owner file + LIVE node pid     -> KEPT
#       (the exact shape a family-blind `pid`-only sweep would rm -rf)
#   T2: held-runtime dir, owner file + DEAD pid          -> REAPED
#   T3: held-runtime dir, owner file MISSING + fresh dir -> KEPT
#       (mkdir→owner-write in-flight window; resolveLockContention never steals)
#   T4: held-runtime dir, owner file MISSING + stale     -> REAPED
#       (crash after mkdir; without this the runtime wedges in contention)
#   T5: dry-run reports T2/T4 but deletes NOTHING (all four dirs survive)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
STUB_LAUNCH="$(mktemp -d)"
cp "$REPO_ROOT/launch/reap-stale-leases.sh" "$REPO_ROOT/launch/"*.lib.sh "$STUB_LAUNCH/"
cp "$REPO_ROOT/launch/agent-ports.json" "$STUB_LAUNCH/"
REAPER="$STUB_LAUNCH/reap-stale-leases.sh"

PASS=0
FAIL=0
FAILS=()
ok()   { echo "  [PASS] $*"; PASS=$((PASS+1)); }
ko()   { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }
sect() { echo; echo "===== $* ====="; }

[[ -x "$REAPER" ]] || { echo "FATAL: reaper not executable: $REAPER" >&2; exit 2; }

SBOX="$(mktemp -d)"
cleanup() { rm -rf "$SBOX" "$STUB_LAUNCH"; return 0; }
trap cleanup EXIT

mkdir -p "$SBOX/ws"                       # empty workspace root — no lease sidecars
MULTICA="$SBOX/multica"
HELD_RUNTIME="$MULTICA/held-runtime"      # the #7 family root
PORT_HELD="$SBOX/port-held"               # arbiter family (kept empty — not under test)
REG="$SBOX/registry.json"                 # registry sandbox (kept absent)
mkdir -p "$HELD_RUNTIME" "$PORT_HELD"

# run_reaper <dry_run:0|1> — real reaper: sandboxed GODOT_MCP_HOME + port-held +
# registry, pwsh disabled, resident mode (skip the 3s live abort window), this
# shell's PID force-treated as node for the KEPT case.
run_reaper() {
    local dry="$1"
    local args=(--root "$SBOX/ws")
    (( dry == 1 )) && args+=(--dry-run)
    GODOT_MCP_HOME="$MULTICA" \
    KOL_PORT_ARBITER_TEST_PID_NODE="$$" \
    KOL_PORT_HELD_DIR="$PORT_HELD" \
    KOL_PORT_REGISTRY_PATH_OVERRIDE="$REG" \
    KOL_REAP_DISABLE_PWSH=1 \
    KOL_REAP_RESIDENT=1 \
    "$REAPER" "${args[@]}" 2>&1
}

seed_dirs() {
    rm -rf "$HELD_RUNTIME"; mkdir -p "$HELD_RUNTIME"
    # T1: owner file + live node pid -> KEPT
    mkdir -p "$HELD_RUNTIME/Live";  printf '%s\n' "$$"       > "$HELD_RUNTIME/Live/owner"
    # T2: owner file + dead pid -> REAPED
    mkdir -p "$HELD_RUNTIME/Dead";  printf '%s\n' "99999999" > "$HELD_RUNTIME/Dead/owner"
    # T3: owner file missing + fresh dir (mtime now) -> KEPT
    mkdir -p "$HELD_RUNTIME/Fresh"
    # T4: owner file missing + stale since (300s > 60s grace) -> REAPED
    mkdir -p "$HELD_RUNTIME/Stale"; printf '%s\n' "$(( $(date +%s%3N) - 300000 ))" > "$HELD_RUNTIME/Stale/since"
}

sect "T1-T4 live: live/fresh KEPT, dead/stale REAPED (held-runtime family)"
seed_dirs
OUT="$(run_reaper 0)"
echo "$OUT" | grep -q "HELD-DEAD dir=${HELD_RUNTIME}/Dead/"  && ok "T2: dead-owner held-runtime reported"    || ko "T2: dead-owner not reported: $OUT"
echo "$OUT" | grep -q "HELD-DEAD dir=${HELD_RUNTIME}/Stale/" && ok "T4: stale owner-less reported"          || ko "T4: stale owner-less not reported: $OUT"
echo "$OUT" | grep -q "HELD-DEAD dir=${HELD_RUNTIME}/Live/"  && ko "T1: live-owner wrongly reaped"         || ok "T1: live-owner not reported as dead"
echo "$OUT" | grep -q "HELD-DEAD dir=${HELD_RUNTIME}/Fresh/" && ko "T3: fresh owner-less wrongly reaped"   || ok "T3: fresh owner-less not reported as dead"
[[ -d "$HELD_RUNTIME/Live" ]]  && ok "T1: live-owner dir KEPT on disk"   || ko "T1: live-owner dir was deleted"
[[ -d "$HELD_RUNTIME/Fresh" ]] && ok "T3: fresh owner-less dir KEPT"     || ko "T3: fresh owner-less dir was deleted"
[[ ! -d "$HELD_RUNTIME/Dead" ]]  && ok "T2: dead-owner dir deleted"      || ko "T2: dead-owner dir still present"
[[ ! -d "$HELD_RUNTIME/Stale" ]] && ok "T4: stale owner-less dir deleted" || ko "T4: stale owner-less dir still present"

sect "T5 dry-run: reports but deletes NOTHING"
seed_dirs
OUT="$(run_reaper 1)"
echo "$OUT" | grep -q "(dry-run) would delete held dir ${HELD_RUNTIME}/Dead/"  && ok "T5: dry-run reports dead-owner"  || ko "T5: dry-run did not report dead-owner: $OUT"
echo "$OUT" | grep -q "(dry-run) would delete held dir ${HELD_RUNTIME}/Stale/" && ok "T5: dry-run reports stale"       || ko "T5: dry-run did not report stale: $OUT"
[[ -d "$HELD_RUNTIME/Live" && -d "$HELD_RUNTIME/Fresh" && -d "$HELD_RUNTIME/Dead" && -d "$HELD_RUNTIME/Stale" ]] \
    && ok "T5: dry-run deleted nothing (all four dirs survive)" || ko "T5: dry-run deleted a dir"

echo
echo "===== summary: pass=$PASS fail=$FAIL ====="
if (( FAIL > 0 )); then
    for f in "${FAILS[@]}"; do echo "  - $f"; done
    exit 1
fi
exit 0
