#!/usr/bin/env bash
# test_see1152_reaper_registry_sweep.sh
#
# SEE-1152 (Owner directive, Atlas 子步骤 目标3): the reaper's registry sweep
# must delete ONLY registry entries whose proxy_pid fails the ARBITER liveness
# standard (kill -0 + /proc/<pid>/exe must be node), and must survive a
# missing / malformed registry without crashing.
#
# Cases (all run against the REAL reap-stale-leases.sh binary — the sweep is
# only reachable end-to-end there):
#   T1: live entry whose proxy_pid is alive AND node          -> KEPT
#   T2: entry whose proxy_pid is dead                         -> DELETED
#   T3: entry whose proxy_pid is alive but NON-node (PID reused
#       by an unrelated process)                              -> DELETED
#   T4: registry file absent                                  -> no crash
#   T5: registry file malformed JSON                          -> no crash, left untouched
#   T6: dry-run reports dead entries but deletes NOTHING
#
# Sandbox strategy: the registry path is redirected via the lib's
# KOL_PORT_REGISTRY_PATH_OVERRIDE seam (production never sets it) so the real
# reaper binary can run without relocating HOME. PID liveness is controlled
# two ways:
#   - a REAL live pid (the test's own bash) is force-treated as node via the
#     arbiter's KOL_PORT_ARBITER_TEST_PID_NODE seam (its /proc/self/exe is
#     bash, not node, so the seam is required for the KEPT case);
#   - a REAL live NON-node pid (sleep) for the PID-reuse case.
# Both seams live in the LIBS, not the reaper, so reaper and arbiter share
# one liveness implementation (Atlas 子步骤约束4).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REAPER="$REPO_ROOT/launch/reap-stale-leases.sh"

PASS=0
FAIL=0
FAILS=()
ok()   { echo "  [PASS] $*"; PASS=$((PASS+1)); }
ko()   { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }
sect() { echo; echo "===== $* ====="; }

[[ -x "$REAPER" ]] || { echo "FATAL: reaper not executable: $REAPER" >&2; exit 2; }

SBOX="$(mktemp -d)"
trap 'rm -rf "$SBOX"; [[ -n "${SLEEP_PID:-}" ]] && kill "$SLEEP_PID" 2>/dev/null' EXIT
mkdir -p "$SBOX/ws"          # empty workspace root — no lease sidecars
REG="$SBOX/registry.json"

# A live NON-node process for the PID-reuse case.
sleep 120 &
SLEEP_PID=$!

# run_reaper <dry_run:0|1> — invokes the real reaper against the sandbox
# registry, pwsh disabled (hermetic), resident mode (skip the 3s live abort
# window), this shell's PID force-treated as node for the KEPT case.
run_reaper() {
    local dry="$1"
    local args=(--root "$SBOX/ws")
    (( dry == 1 )) && args+=(--dry-run)
    KOL_PORT_ARBITER_TEST_PID_NODE="$$" \
    KOL_PORT_REGISTRY_PATH_OVERRIDE="$REG" \
    KOL_REAP_DISABLE_PWSH=1 \
    KOL_REAP_RESIDENT=1 \
    "$REAPER" "${args[@]}" 2>&1
}

seed_registry() {
    node -e '
        const fs = require("fs");
        const out = { schema_version: 1, updated_at: new Date().toISOString(), entries: {
            "Live-node":   { port: 6560, proxy_pid: Number(process.argv[1]), heartbeat_at: new Date().toISOString(), agent: "Bachi", label: "a", worktree: "/a" },
            "Dead-pid":    { port: 6561, proxy_pid: 99999999,                 heartbeat_at: new Date().toISOString(), agent: "Atlas", label: "b", worktree: "/b" },
            "Reused-bash": { port: 6562, proxy_pid: Number(process.argv[2]), heartbeat_at: new Date().toISOString(), agent: "Revy",  label: "c", worktree: "/c" }
        }};
        fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2));
    ' "$1" "$SLEEP_PID" "$REG"
}

reg_keys() {
    node -e 'try { console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).entries).sort().join(",")); } catch (e) { console.log("UNREADABLE"); }' "$REG"
}

sect "T1+T2+T3: live node KEPT, dead pid DELETED, non-node-reused pid DELETED"
seed_registry "$$"
OUT="$(run_reaper 0)"
echo "$OUT" | grep -q "REGISTRY-DEAD runtime_id=Dead-pid"    && ok "T2: dead pid reported"            || ko "T2: dead pid not reported: $OUT"
echo "$OUT" | grep -q "REGISTRY-DEAD runtime_id=Reused-bash" && ok "T3: non-node reuse reported"      || ko "T3: non-node reuse not reported: $OUT"
echo "$OUT" | grep -q "REGISTRY-DEAD runtime_id=Live-node"   && ko "T1: live node wrongly reaped"     || ok "T1: live node not reported as dead"
KEYS="$(reg_keys)"
[[ "$KEYS" == "Live-node" ]] && ok "T1+T2+T3: final registry = Live-node only (got: $KEYS)" || ko "T1+T2+T3: final registry wrong: $KEYS"

sect "T4: registry file absent — no crash, exit 0"
rm -f "$REG"
OUT="$(run_reaper 0)"; RC=$?
[[ $RC -eq 0 ]] && ok "T4: absent registry exits 0" || ko "T4: absent registry rc=$RC"
echo "$OUT" | grep -qiE "no registry file" && ok "T4: absence logged" || ko "T4: absence not logged: $OUT"

sect "T5: malformed registry — no crash, file left untouched"
echo "{ not valid json" > "$REG"
OUT="$(run_reaper 0)"; RC=$?
[[ $RC -eq 0 ]] && ok "T5: malformed registry exits 0" || ko "T5: malformed registry rc=$RC"
echo "$OUT" | grep -qiE "unparseable" && ok "T5: malformed logged" || ko "T5: malformed not logged: $OUT"
[[ "$(cat "$REG")" == "{ not valid json" ]] && ok "T5: malformed file left byte-identical" || ko "T5: malformed file was modified"

sect "T6: dry-run reports but deletes NOTHING"
seed_registry "$$"
OUT="$(run_reaper 1)"
echo "$OUT" | grep -q "(dry-run) would delete registry entry Dead-pid" && ok "T6: dry-run reports dead entry" || ko "T6: dry-run did not report: $OUT"
KEYS="$(reg_keys)"
[[ "$KEYS" == "Dead-pid,Live-node,Reused-bash" ]] && ok "T6: dry-run deleted nothing (got: $KEYS)" || ko "T6: dry-run modified registry: $KEYS"

echo
echo "===== summary: pass=$PASS fail=$FAIL ====="
if (( FAIL > 0 )); then
    for f in "${FAILS[@]}"; do echo "  - $f"; done
    exit 1
fi
exit 0
