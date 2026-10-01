#!/usr/bin/env bash
# SEE-1316 hardener: proxy_pid reaper-contract closure — mock-seam suite.
#
# Three scenarios (per the fix brief):
#   S1. Rejected-connection / orphaned-editor reclaim: an ACTIVE lease whose
#       recorded proxy_pid is DEAD but whose editor is still ALIVE is now
#       judged STALE by the reaper ("proxy_pid_dead") — pre-fix, this shape
#       matched no stale branch and the editor stranded until the addon's own
#       45s/120s windows ran out. Fresh leases (< grace) are still KEPT.
#   S2. Proxy self-registration semantics (sidecar_set_proxy_pid): stamps own
#       runtime's active lease; never touches a foreign runtime's lease, a
#       released lease, or clobbers a LIVE different proxy_pid; dead recorded
#       pid IS replaceable; legacy empty-runtime sidecars are accepted.
#   S3. Proxy-exit marking interplay: a lease stamped intentional_release=true
#       skips the fresh-lease grace even when proxy_pid is present and the
#       editor is alive (clean-exit fast reclaim still wins).
#
# Hermetic: temp worktrees + sandbox PIDs only; no proxy, no editor, no
# registry writes (reaper runs with --root scoped to the sandbox and
# KOL_REAP_DISABLE_PWSH=1 for the fast /proc path).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_DIR="$(cd "$SCRIPT_DIR/../../../launch" && pwd)"
REAPER="$LAUNCH_DIR/reap-stale-leases.sh"
SIDECAR_LIB="$LAUNCH_DIR/mcp-sidecar.lib.sh"
[[ -x "$REAPER" ]] || { echo "FAIL: reaper not executable: $REAPER"; exit 1; }
[[ -f "$SIDECAR_LIB" ]] || { echo "FAIL: sidecar lib missing: $SIDECAR_LIB"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "FAIL: node required"; exit 1; }

export KOL_REAP_DISABLE_PWSH=1

SBOX="$(mktemp -d)"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

make_lease() {  # <worktree> <json-body>
    local wt="$1" body="$2"
    mkdir -p "$wt/.godot"
    printf '%s\n' "$body" > "$wt/.godot/mcp-lease.json"
}

NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OLD_ISO="$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)"

# A long-lived sandbox "editor" and a long-lived sandbox "proxy" whose liveness
# the reaper can observe (proxy liveness checks /proc/<pid>/exe for *node* —
# so the sandbox proxy must BE a node process to be seen alive).
# Sandbox proxy: a short-lived background node process the reaper can prove
# alive via /proc/<pid>/exe. Started once; killed at trap.
node -e 'setInterval(()=>{}, 1000)' >/dev/null 2>&1 &
NODE_PROXY_PID=$!
sleep 0.3
SANDBOX_NODE_PID="$NODE_PROXY_PID"
trap 'kill "$SANDBOX_NODE_PID" 2>/dev/null; rm -rf "$SBOX"' EXIT

echo "== S1.1: proxy_pid DEAD sandboxed + editor alive + past grace =="
echo "==   expected: STALE proxy_pid_dead =="
WT1="$SBOX/wt1"
make_lease "$WT1" "{
  \"schema_version\": 2, \"runtime_id\": \"Bachi-1316aabb\", \"task_id\": \"\",
  \"port\": 6595, \"agent\": \"Bachi\", \"label\": \"bachi\",
  \"state\": \"active\", \"lease_id\": \"s1-1\",
  \"worktree\": \"$WT1\", \"configured_at\": \"$OLD_ISO\",
  \"configured_by_pid\": 999999999, \"proxy_pid\": 999999998, \"released_at\": null, \"notes\": \"\"
}"
mkdir -p "$WT1" && printf '%s\n' "$NODE_PROXY_PID" > /dev/null # (no pidfile: editor_pid falls back to cfg_pid, dead → stale also fires, but the NEW reason must be proxy_pid_dead)
OUT="$("$REAPER" --root "$SBOX" --dry-run 2>&1)"
if echo "$OUT" | grep -q "STALE.*proxy_pid_dead"; then ok "proxy-dead orphan flagged proxy_pid_dead"; else bad "proxy-dead orphan not flagged: $OUT"; fi

echo "== S1.2: proxy_pid ALIVE sandboxed node + editor alive =="
echo "==   expected: KEPT =="
WT2="$SBOX/wt2"
make_lease "$WT2" "{
  \"schema_version\": 2, \"runtime_id\": \"Bachi-1316aabb\", \"task_id\": \"\",
  \"port\": 6596, \"agent\": \"Bachi\", \"label\": \"bachi\",
  \"state\": \"active\", \"lease_id\": \"s1-2\",
  \"worktree\": \"$WT2\", \"configured_at\": \"$OLD_ISO\",
  \"configured_by_pid\": 999999999, \"proxy_pid\": $NODE_PROXY_PID, \"released_at\": null, \"notes\": \"\"
}"
# A live "editor": the reaper reads the editor PID from the runtime pidfile
# (kol_lifecycle_path .pid <label> <runtime_id>) — sandbox sleep stands in.
EDITOR_SANDBOX_PID=""
sleep 300 >/dev/null 2>&1 &
EDITOR_SANDBOX_PID=$!
mkdir -p "${GODOT_MCP_HOME:-$HOME/.config/godot-mcp}/godot-editor"
printf '%s\n' "$EDITOR_SANDBOX_PID" > "${GODOT_MCP_HOME:-$HOME/.config/godot-mcp}/godot-editor/Bachi-1316aabb.pid"
OUT="$("$REAPER" --root "$SBOX" --dry-run 2>&1)"
kill "$EDITOR_SANDBOX_PID" 2>/dev/null
rm -f "${GODOT_MCP_HOME:-$HOME/.config/godot-mcp}/godot-editor/Bachi-1316aabb.pid"
if echo "$OUT" | grep -q "ACTIVE-but-live.*kept"; then ok "live-proxy + live-editor lease kept"; else bad "live-proxy lease wrongly flagged: $OUT"; fi

echo "== S1.3: proxy_pid DEAD but lease FRESH under grace =="
echo "==   expected: KEPT by fresh-grace =="
WT3="$SBOX/wt3"
make_lease "$WT3" "{
  \"schema_version\": 2, \"runtime_id\": \"Bachi-1316aabb\", \"task_id\": \"\",
  \"port\": 6597, \"agent\": \"Bachi\", \"label\": \"bachi\",
  \"state\": \"active\", \"lease_id\": \"s1-3\",
  \"worktree\": \"$WT3\", \"configured_at\": \"$NOW_ISO\",
  \"configured_by_pid\": 999999999, \"proxy_pid\": 999999998, \"released_at\": null, \"notes\": \"\"
}"
OUT="$("$REAPER" --root "$SBOX" --dry-run 2>&1)"
if echo "$OUT" | grep -q "ACTIVE-fresh.*kept"; then ok "fresh proxy-dead lease kept by grace"; else bad "fresh lease not grace-kept: $OUT"; fi

echo "== S1.4: NO proxy_pid - pre-fix sidecar keeps legacy behavior =="
WT4="$SBOX/wt4"
make_lease "$WT4" "{
  \"schema_version\": 2, \"runtime_id\": \"Bachi-1316aabb\", \"task_id\": \"\",
  \"port\": 6598, \"agent\": \"Bachi\", \"label\": \"bachi\",
  \"state\": \"active\", \"lease_id\": \"s1-4\",
  \"worktree\": \"$WT4\", \"configured_at\": \"$OLD_ISO\",
  \"configured_by_pid\": 999999999, \"released_at\": null, \"notes\": \"\"
}"
OUT="$("$REAPER" --root "$SBOX" --dry-run 2>&1)"
if echo "$OUT" | grep -q "STALE.*owner_pid_dead"; then ok "legacy sidecar keeps owner_pid_dead verdict"; else bad "legacy verdict changed: $OUT"; fi

echo "== S2.1: sidecar_set_proxy_pid stamps OWN-runtime active lease =="
WT5="$SBOX/wt5"
make_lease "$WT5" "{
  \"schema_version\": 2, \"runtime_id\": \"Bachi-1316aabb\", \"port\": 6599,
  \"agent\": \"Bachi\", \"state\": \"active\", \"lease_id\": \"s2-1\",
  \"worktree\": \"$WT5\", \"configured_at\": \"$NOW_ISO\",
  \"configured_by_pid\": 123, \"proxy_pid\": null, \"released_at\": null, \"notes\": \"\"
}"
MYNODE_PID="$NODE_PROXY_PID"
KOL_RUNTIME_ID="Bachi-1316aabb" bash -c "source '$SIDECAR_LIB' && sidecar_set_proxy_pid '$WT5/project.godot' '$MYNODE_PID'" >/dev/null
got="$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(o.proxy_pid))' "$WT5/.godot/mcp-lease.json")"
if [[ "$got" == "$MYNODE_PID" ]]; then ok "own-runtime proxy_pid stamped"; else bad "own-runtime stamp failed: got=$got want=$MYNODE_PID"; fi

echo "== S2.2: does NOT stamp a FOREIGN-runtime lease =="
WT6="$SBOX/wt6"
make_lease "$WT6" "{
  \"schema_version\": 2, \"runtime_id\": \"Bachi-zzzzffff\", \"port\": 6599,
  \"agent\": \"Bachi\", \"state\": \"active\", \"lease_id\": \"s2-2\",
  \"worktree\": \"$WT6\", \"configured_at\": \"$NOW_ISO\",
  \"configured_by_pid\": 124, \"proxy_pid\": 555, \"released_at\": null, \"notes\": \"\"
}"
KOL_RUNTIME_ID="Bachi-1316aabb" bash -c "source '$SIDECAR_LIB' && sidecar_set_proxy_pid '$WT6/project.godot' '$MYNODE_PID'" >/dev/null
got="$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(o.proxy_pid))' "$WT6/.godot/mcp-lease.json")"
if [[ "$got" == "555" ]]; then ok "foreign-runtime lease untouched"; else bad "foreign-runtime lease clobbered: got=$got"; fi

echo "== S2.3: does NOT stamp a RELEASED lease =="
WT7="$SBOX/wt7"
make_lease "$WT7" "{
  \"schema_version\": 2, \"runtime_id\": \"Bachi-1316aabb\", \"port\": 6599,
  \"agent\": \"Bachi\", \"state\": \"released\", \"lease_id\": \"s2-3\",
  \"worktree\": \"$WT7\", \"configured_at\": \"$NOW_ISO\",
  \"configured_by_pid\": 125, \"proxy_pid\": null, \"released_at\": \"$NOW_ISO\", \"notes\": \"\"
}"
KOL_RUNTIME_ID="Bachi-1316aabb" bash -c "source '$SIDECAR_LIB' && sidecar_set_proxy_pid '$WT7/project.godot' '$MYNODE_PID'" >/dev/null
got="$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(o.proxy_pid===null?"null":o.proxy_pid))' "$WT7/.godot/mcp-lease.json")"
if [[ "$got" == "null" ]]; then ok "released lease untouched"; else bad "released lease stamped: got=$got"; fi

echo "== S2.4: does NOT clobber a LIVE different proxy_pid; replaces a DEAD one =="
WT8="$SBOX/wt8"
make_lease "$WT8" "{
  \"schema_version\": 2, \"runtime_id\": \"Bachi-1316aabb\", \"port\": 6599,
  \"agent\": \"Bachi\", \"state\": \"active\", \"lease_id\": \"s2-4\",
  \"worktree\": \"$WT8\", \"configured_at\": \"$NOW_ISO\",
  \"configured_by_pid\": 126, \"proxy_pid\": $NODE_PROXY_PID, \"released_at\": null, \"notes\": \"\"
}"
KOL_RUNTIME_ID="Bachi-1316aabb" bash -c "source '$SIDECAR_LIB' && sidecar_set_proxy_pid '$WT8/project.godot' '$MYNODE_PID'" >/dev/null
got="$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(o.proxy_pid))' "$WT8/.godot/mcp-lease.json")"
if [[ "$got" == "$NODE_PROXY_PID" ]]; then ok "live foreign proxy_pid not clobbered"; else bad "live proxy_pid clobbered: got=$got want=$NODE_PROXY_PID"; fi
WT9="$SBOX/wt9"
make_lease "$WT9" "{
  \"schema_version\": 2, \"runtime_id\": \"Bachi-1316aabb\", \"port\": 6599,
  \"agent\": \"Bachi\", \"state\": \"active\", \"lease_id\": \"s2-5\",
  \"worktree\": \"$WT9\", \"configured_at\": \"$NOW_ISO\",
  \"configured_by_pid\": 127, \"proxy_pid\": 999999997, \"released_at\": null, \"notes\": \"\"
}"
KOL_RUNTIME_ID="Bachi-1316aabb" bash -c "source '$SIDECAR_LIB' && sidecar_set_proxy_pid '$WT9/project.godot' '$MYNODE_PID'" >/dev/null
got="$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(o.proxy_pid))' "$WT9/.godot/mcp-lease.json")"
if [[ "$got" == "$MYNODE_PID" ]]; then ok "dead recorded proxy_pid replaced"; else bad "dead proxy_pid not replaced: got=$got want=$MYNODE_PID"; fi

echo "== S3.1: intentional_release=true skips grace even with proxy_pid present =="
WT10="$SBOX/wt10"
make_lease "$WT10" "{
  \"schema_version\": 2, \"runtime_id\": \"Bachi-1316aabb\", \"port\": 6594,
  \"agent\": \"Bachi\", \"state\": \"active\", \"lease_id\": \"s3-1\",
  \"worktree\": \"$WT10\", \"configured_at\": \"$NOW_ISO\",
  \"configured_by_pid\": 128, \"proxy_pid\": $NODE_PROXY_PID,
  \"intentional_release\": true, \"released_at\": null, \"notes\": \"\"
}"
OUT="$("$REAPER" --root "$SBOX" --dry-run 2>&1)"
if echo "$OUT" | grep -q 'intentional_release .grace skipped.'; then ok "intentional_release skips grace"; else bad "intentional_release grace not skipped: $OUT"; fi
if echo "$OUT" | grep -q "STALE.*intentional_release"; then ok "intentional_release flagged stale despite live proxy_pid"; else bad "intentional_release not stale-flagged: $OUT"; fi

echo "== SEE-1316 summary: pass=$PASS fail=$FAIL =="
(( FAIL == 0 )) || exit 1
exit 0
