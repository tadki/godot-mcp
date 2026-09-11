#!/usr/bin/env bash
# SEE-1129 sidecar-guard real-machine self-test (sub-step e43cdc73).
#
# Verifies the eviction mechanism (stop-godot-editor.sh + reap-stale-leases.sh)
# that evictStaleHolder() runs in the proxy reuse path actually frees a residual
# holder on the REAL filesystem — modelling Archi's reproduced scenario:
#   - a residual holder with an ACTIVE lease on worktree c508560b
#   - a stale editor pidfile (the editor self-exited but the pidfile lingered)
#   - NO .worktree sidecar (pre-#499 spawn convention) OR a sidecar pointing at
#     c508560b (worktree mismatch vs this slot 7a634b21)
#
# The proxy's sidecar-guard predicate (decideSidecarGuard) returns 'evict' for
# both these holder states, so the proxy would call evictStaleHolder(). This
# test confirms the eviction actually clears the holder (lease released, port
# freed, sidecars cleaned) so the subsequent spawn path writes a FRESH sidecar
# for 7a634b21.
#
# Isolation: a throwaway HOME/MULTICA_DIR under /tmp so it never touches the
# real ~/.multica or real workspace leases. A fake "live" editor PID is used
# that is guaranteed dead so stop's Stop-Process/kill is a no-op (we only
# assert the lease/sidecar release path, not process termination, which the
# boundary-matrix test already covers).

set -u
cd "$(dirname "$0")/../../.." || exit 1

LAUNCH="./addons/godot_mcp/launch"
STOP="$LAUNCH/stop-godot-editor.sh"
REAPER="$LAUNCH/reap-stale-leases.sh"
PREDICATE="./addons/godot_mcp/launch/see1129-sidecar-guard-predicate.mjs"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok   - $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL - $*"; }

SUF="$(date +%s%N 2>/dev/null || echo $$)"
BASE="/tmp/kol-see1129-selftest-${SUF}"
rm -rf "$BASE"; mkdir -p "$BASE"
export HOME="$BASE/home"; mkdir -p "$HOME/.multica"
export TMPDIR="$BASE/tmp"; mkdir -p "$TMPDIR"

WS="11111111-2222-3333-4444-555555555555"
ARCHI_OLD="$BASE/ws/${WS}/c508560b/workdir/KingOfLikes-Godot"   # residual holder's project
ARCHI_NEW="$BASE/ws/${WS}/7a634b21/workdir/KingOfLikes-Godot"   # this slot's project
mkdir -p "$ARCHI_OLD/.godot" "$ARCHI_NEW/.godot"
printf 'config_version=5\n' > "$ARCHI_OLD/project.godot"
printf 'config_version=5\n' > "$ARCHI_NEW/project.godot"

DEAD_PID=999999  # guaranteed not to exist

# write a sidecar-style lease (matches <worktree>/.godot/mcp-lease.json schema)
write_lease() {
    local wt="$1" port="$2" agent="$3" state="$4" cfgpid="$5"
    SIDE_WT="$wt" SIDE_PORT="$port" SIDE_AGENT="$agent" SIDE_PID="$cfgpid" SIDE_STATE="$state" \
    node -e '
        const crypto=require("crypto"),env=process.env;
        const released=env.SIDE_STATE==="released";
        process.stdout.write(JSON.stringify({
            schema_version:1, port:Number(env.SIDE_PORT), agent:env.SIDE_AGENT||"",
            label:(env.SIDE_AGENT||"").toLowerCase(), state:env.SIDE_STATE,
            lease_id:crypto.randomUUID(), worktree:env.SIDE_WT||"",
            configured_at:new Date(0).toISOString(), configured_by_pid:Number(env.SIDE_PID)||null,
            released_at:released?new Date(0).toISOString():null, notes:"selftest"
        },null,2)+"\n");
    ' > "$wt/.godot/mcp-lease.json"
}
lease_state() { node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).state||"")}catch(e){process.stdout.write("ABSENT")}' "$1"; }

echo "=== Scenario 1: residual holder, sidecar ABSENT (pre-#499 spawn) ==="
# Active lease on c508560b, stale editor pidfile, NO .worktree sidecar.
write_lease "$ARCHI_OLD" 6552 Archi active "$DEAD_PID"
printf '%s\n' "$DEAD_PID" > "$HOME/.multica/godot-editor-archi.pid"
# (no godot-editor-archi.worktree — pre-#499)
# Predicate must say 'evict'
got="$(node --input-type=module -e "
import { decideSidecarGuard } from '${PREDICATE}';
process.stdout.write(decideSidecarGuard(null, process.argv[1]));
" "$ARCHI_NEW")"
[[ "$got" == "evict" ]] && ok "S1 predicate: sidecar absent → evict" || bad "S1 predicate: got=$got want=evict"
# Run the eviction mechanism (stop + reap), as evictStaleHolder would.
KOL_AGENT_NAME=Archi KOL_MCP_PORT=6552 bash "$STOP" --label archi >/dev/null 2>&1 || true
bash "$REAPER" --root "$BASE/ws" >/dev/null 2>&1 || true
st="$(lease_state "$ARCHI_OLD/.godot/mcp-lease.json")"
[[ "$st" == "released" ]] && ok "S1 eviction: residual lease released (was active)" || bad "S1: lease state=$st want=released"
[[ ! -f "$HOME/.multica/godot-editor-archi.pid" ]] && ok "S1 eviction: stale pidfile cleaned" || bad "S1: pidfile lingered"

echo
echo "=== Scenario 2: residual holder, sidecar MISMATCH (c508560b vs this slot 7a634b21) ==="
# Fresh residual: active lease on c508560b, .worktree sidecar points at c508560b
# (so stop can locate it), this slot is 7a634b21.
write_lease "$ARCHI_OLD" 6552 Archi active "$DEAD_PID"
printf '%s\n' "$DEAD_PID" > "$HOME/.multica/godot-editor-archi.pid"
printf '%s\n' "$ARCHI_OLD" > "$HOME/.multica/godot-editor-archi.worktree"
# Predicate must say 'evict' (worktree mismatch)
got="$(node --input-type=module -e "
import { decideSidecarGuard } from '${PREDICATE}';
process.stdout.write(decideSidecarGuard(process.argv[1], process.argv[2]));
" "$ARCHI_OLD" "$ARCHI_NEW")"
[[ "$got" == "evict" ]] && ok "S2 predicate: worktree mismatch → evict" || bad "S2 predicate: got=$got want=evict"
# Eviction
KOL_AGENT_NAME=Archi KOL_MCP_PORT=6552 bash "$STOP" --label archi >/dev/null 2>&1 || true
bash "$REAPER" --root "$BASE/ws" >/dev/null 2>&1 || true
st="$(lease_state "$ARCHI_OLD/.godot/mcp-lease.json")"
[[ "$st" == "released" ]] && ok "S2 eviction: mismatched-holder lease released" || bad "S2: lease state=$st want=released"
# After eviction, the worktree sidecar for the old holder must be gone, so a
# fresh spawn for 7a634b21 starts clean and writes its own sidecar.
[[ ! -f "$HOME/.multica/godot-editor-archi.worktree" ]] && ok "S2 eviction: old .worktree sidecar removed (fresh spawn starts clean)" || bad "S2: old .worktree sidecar lingered"

echo
echo "=== Scenario 3: this slot's OWN holder (sidecar matches) → REUSE, never evicted ==="
# Active lease on 7a634b21, sidecar points at 7a634b21 = this slot. Predicate
# must say 'reuse' (NOT evict) — principle #1/#2: same slot reuses its editor.
write_lease "$ARCHI_NEW" 6552 Archi active "$DEAD_PID"
printf '%s\n' "$ARCHI_NEW" > "$HOME/.multica/godot-editor-archi.worktree"
got="$(node --input-type=module -e "
import { decideSidecarGuard } from '${PREDICATE}';
process.stdout.write(decideSidecarGuard(process.argv[1], process.argv[2]));
" "$ARCHI_NEW" "$ARCHI_NEW")"
[[ "$got" == "reuse" ]] && ok "S3 predicate: own-slot holder confirmed → reuse (no false evict)" || bad "S3 predicate: got=$got want=reuse"

echo
echo "pass=$PASS fail=$FAIL"
rm -rf "$BASE"
[[ "$FAIL" -eq 0 ]]
