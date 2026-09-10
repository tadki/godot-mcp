#!/usr/bin/env bash
# SEE-1148 T14: reaper 防误杀守卫回归 (grace-guard regression).
#
# Verifies the reaper NEVER reaps an ACTIVE lease inside the grace window
# (SEE-1134), even when configured_by_pid is dead (it always is — it's the
# configure shell) and no editor pidfile exists. This is the single most
# load-bearing safety property of the reaper; P1's schema v2 + runtime_id
# extraction must not have weakened it.
#
# Also verifies the SEE-1148 additions:
#   - schema_version=2 sidecar with runtime_id parses and participates in the
#     grace guard exactly like v1.
#   - schema_version=99 (unknown) is quarantined, NOT reaped silently.
#
# Pure sandbox: runs against a temp --root; no real workspace touched.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_DIR="$(cd "$SCRIPT_DIR/../../../launch" && pwd)"
REAPER="$LAUNCH_DIR/reap-stale-leases.sh"
[[ -x "$REAPER" ]] || { echo "FAIL: reaper not executable: $REAPER"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "FAIL: node required"; exit 1; }

# Hermetic: this suite spawns the reaper several times; with the D1 powershell
# fallback active each run also does 3 live Get-CimInstance sweeps against the
# real host (~15s each), dominating the suite runtime. The reaper's own
# jurisdiction/grace logic is what is under test, not the Win32 plumbing, so
# force the fast /proc path.
export KOL_REAP_DISABLE_PWSH=1

SBOX="$(mktemp -d)"
trap 'rm -rf "$SBOX"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# make_lease <worktree> <schema_json_body>
make_lease() {
    local wt="$1" body="$2"
    mkdir -p "$wt/.godot"
    printf '%s\n' "$body" > "$wt/.godot/mcp-lease.json"
}

NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "== T14.1: fresh v1 ACTIVE lease (dead cfg pid, no pidfile) is KEPT =="
make_lease "$SBOX/wt1" "{
  \"schema_version\": 1, \"port\": 6553, \"agent\": \"Bachi\", \"label\": \"bachi\",
  \"state\": \"active\", \"lease_id\": \"t14-1\",
  \"worktree\": \"$SBOX/wt1\", \"configured_at\": \"$NOW_ISO\",
  \"configured_by_pid\": 999999999, \"released_at\": null, \"notes\": \"\"
}"
OUT="$("$REAPER" --root "$SBOX" --dry-run 2>&1)"
if echo "$OUT" | grep -q "ACTIVE-fresh.*kept"; then ok "fresh v1 lease kept"; else bad "fresh v1 lease not kept: $OUT"; fi

echo "== T14.2: fresh v2 ACTIVE lease with runtime_id is KEPT =="
make_lease "$SBOX/wt2" "{
  \"schema_version\": 2, \"runtime_id\": \"Bachi-aabbccdd\", \"task_id\": \"\",
  \"port\": 6553, \"agent\": \"Bachi\", \"label\": \"bachi\",
  \"state\": \"active\", \"lease_id\": \"t14-2\",
  \"worktree\": \"$SBOX/wt2\", \"configured_at\": \"$NOW_ISO\",
  \"configured_by_pid\": 999999999, \"released_at\": null, \"notes\": \"\"
}"
OUT="$("$REAPER" --root "$SBOX" --dry-run 2>&1)"
if echo "$OUT" | grep -q "ACTIVE-fresh.*kept" && echo "$OUT" | grep -q "total=2"; then ok "fresh v2 lease kept"; else bad "fresh v2 lease not kept: $OUT"; fi

echo "== T14.3: unknown schema_version is quarantined, never silently reaped =="
make_lease "$SBOX/wt3" "{
  \"schema_version\": 99, \"port\": 6553, \"agent\": \"Bachi\", \"label\": \"bachi\",
  \"state\": \"active\", \"lease_id\": \"t14-3\",
  \"worktree\": \"$SBOX/wt3\", \"configured_at\": \"$NOW_ISO\",
  \"configured_by_pid\": 999999999, \"released_at\": null, \"notes\": \"\"
}"
OUT="$("$REAPER" --root "$SBOX" --dry-run 2>&1)"
if echo "$OUT" | grep -q "schema_version_unexpected"; then ok "unknown schema_version quarantined"; else bad "unknown schema_version not flagged: $OUT"; fi

echo "== T14.4: old ACTIVE lease with dead owner IS reaped (guard is time-bounded) =="
OLD_ISO="$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)"
make_lease "$SBOX/wt4" "{
  \"schema_version\": 2, \"runtime_id\": \"Bachi-aabbccdd\", \"task_id\": \"\",
  \"port\": 6599, \"agent\": \"Bachi\", \"label\": \"bachi\",
  \"state\": \"active\", \"lease_id\": \"t14-4\",
  \"worktree\": \"$SBOX/wt4\", \"configured_at\": \"$OLD_ISO\",
  \"configured_by_pid\": 999999999, \"released_at\": null, \"notes\": \"\"
}"
OUT="$("$REAPER" --root "$SBOX" --dry-run 2>&1)"
if echo "$OUT" | grep -q "STALE.*owner_pid_dead"; then ok "stale v2 lease flagged"; else bad "stale v2 lease not flagged: $OUT"; fi

echo "== T14 summary: pass=$PASS fail=$FAIL =="
(( FAIL == 0 )) || exit 1
exit 0
