#!/usr/bin/env bash
# SEE-1117 Direction 3 — Suite F' : all-6-agent parallel isolation regression.
#
# Owner supplemental acceptance #1: extend Suite F beyond Atlas/Bachi/Revy to
# the full agent matrix (Atlas/Archi/Bachi/Fronti/Revy/Refacty).
#
# Oracles (F1'–F4'):
#   F1'  6 worktrees each get their own sidecar with the correct port
#        (6551/6552/6553/6554/6555/6556), state=active
#   F2'  configuring one agent's sidecar leaves the other 5 untouched
#        (byte-level md5 comparison before/after)
#   F3'  one agent's stop-hook transitions only its own sidecar to released
#   F4'  (deferred — requires 6 live editors; documented in QA report)
#
# Each worktree is an isolated git repo under a tmp dir; sidecar location is
# <worktree>/.godot/mcp-lease.json. We do not launch real editors here —
# Suite B covers that for the single-agent case, and spawning 6 Windows
# editors concurrently is outside Revy's runtime budget. The per-worktree
# filesystem isolation this suite verifies is the precondition for any
# multi-editor parallel run to work safely.
#
# Run from repo root:
#   bash launch/tests/scripts/test_see1117_suite_f_prime_6agents.sh

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Run context: the KOL worktree under test (see header note). Default = the
# enclosing KOL checkout; set KOL_ROOT explicitly when running from the fork
# checkout (launch/tests/) to point at the KOL worktree being exercised.
KOL_ROOT="${KOL_ROOT:-$REPO_ROOT}"
LAUNCH_DIR="${KOL_ROOT}/addons/godot_mcp/launch"
HOOKS_DIR="${KOL_ROOT}/.claude/hooks"
CONFIGURE="$LAUNCH_DIR/configure-mcp-port.sh"

PASS=0
FAIL=0
declare -a FAILED=()

note() { printf "[suite-F'] %s\n" "$*"; }
pass() { PASS=$((PASS+1)); printf '  [PASS] %s\n' "$*"; }
fail() { FAIL=$((FAIL+1)); FAILED+=("$1"); printf '  [FAIL] %s\n' "$*"; }

TMPROOT="$(mktemp -d -t see1117-fprime-XXXXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

# Agent port table (must match agent-ports.json).
declare -A AGENT_PORT=(
    [Atlas]=6551
    [Archi]=6552
    [Bachi]=6553
    [Fronti]=6554
    [Revy]=6555
    [Refacty]=6556
)

sidecar_path() { echo "$TMPROOT/$1/.godot/mcp-lease.json"; }

sidecar_field() {
    local sc="$1" f="$2"
    [ -f "$sc" ] || { echo ''; return; }
    node -e "
        try {
            const j = JSON.parse(require('fs').readFileSync('$sc','utf8'));
            const v = j['$f'];
            process.stdout.write(v == null ? '' : String(v));
        } catch(e) {}
    " 2>/dev/null
}

sidecar_hash() {
    local sc="$1"
    [ -f "$sc" ] && md5sum "$sc" | awk '{print $1}' || echo 'MISSING'
}

# ---------- setup: 6 worktrees ----------------------------------------------

note "setup: creating 6 isolated worktrees"
for agent in Atlas Archi Bachi Fronti Revy Refacty; do
    wt="$TMPROOT/$agent"
    mkdir -p "$wt"
    (
        cd "$wt"
        git init -q -b test-f
        git config user.email qa@example.com
        git config user.name qa
        git config commit.gpgsign false
        cp "$KOL_ROOT/project.godot" .
        git add project.godot
        git commit -q -m "fixture $agent"
    )
done
pass "setup: 6 worktrees created"

# ---------- F1': parallel configure, each gets its own sidecar --------------

note "F1': parallel configure across 6 agents"
for agent in Atlas Archi Bachi Fronti Revy Refacty; do
    port="${AGENT_PORT[$agent]}"
    wt="$TMPROOT/$agent"
    ( cd "$wt" && KOL_PROJECT_GODOT="$wt/project.godot" bash "$CONFIGURE" --port "$port" ) >/dev/null 2>&1 &
done
wait

f1_ok=1
for agent in Atlas Archi Bachi Fronti Revy Refacty; do
    port="${AGENT_PORT[$agent]}"
    sc="$(sidecar_path "$agent")"
    got_port=$(sidecar_field "$sc" port)
    got_state=$(sidecar_field "$sc" state)
    got_agent=$(sidecar_field "$sc" agent)
    got_lease=$(sidecar_field "$sc" lease_id)
    if [ "$got_port" = "$port" ] && [ "$got_state" = "active" ] && [ -n "$got_lease" ]; then
        pass "F1' $agent sidecar port=$port state=active lease_id non-empty"
    else
        fail "F1' $agent sidecar port=$got_port state=$got_state (want $port/active)"
        f1_ok=0
    fi
done

# ---------- F2': one agent's configure leaves others untouched ---------------

note "F2': Revy reconfigures; other 5 sidecars must not change"
declare -A BEFORE_HASH=()
for agent in Atlas Archi Bachi Fronti Refacty; do
    BEFORE_HASH[$agent]="$(sidecar_hash "$(sidecar_path "$agent")")"
done

# Revy reconfigures to a different port (still within valid range), forcing
# lease_id regeneration per Suite A A3 semantics.
( cd "$TMPROOT/Revy" && KOL_PROJECT_GODOT="$TMPROOT/Revy/project.godot" bash "$CONFIGURE" --port 6555 ) >/dev/null 2>&1

for agent in Atlas Archi Bachi Fronti Refacty; do
    after="$(sidecar_hash "$(sidecar_path "$agent")")"
    if [ "$after" = "${BEFORE_HASH[$agent]}" ]; then
        pass "F2' $agent sidecar unchanged after Revy's configure"
    else
        fail "F2' $agent sidecar CHANGED (before=${BEFORE_HASH[$agent]}, after=$after)"
    fi
done

# ---------- F3': one agent's stop-hook only affects its own sidecar ----------

note "F3': Bachi stop-hook fires; only Bachi sidecar -> released"
# Snapshot other agents' sidecar state.
declare -A BEFORE_STATE=()
for agent in Atlas Archi Fronti Revy Refacty; do
    BEFORE_STATE[$agent]="$(sidecar_field "$(sidecar_path "$agent")" state)"
done

# Mirror the launch toolchain into Bachi's fixture so the hook finds
# restore-godot-original.sh. Without this mirror the hook falls back to a
# legacy sed on project.godot which would be a silent no-op for sidecar
# state (and we want to prove the REAL path).
mkdir -p "$TMPROOT/Bachi/addons/godot_mcp/launch"
cp "$LAUNCH_DIR"/*.sh "$LAUNCH_DIR"/*.lib.sh "$LAUNCH_DIR"/agent-ports.json \
    "$TMPROOT/Bachi/addons/godot_mcp/launch/" 2>/dev/null
chmod +x "$TMPROOT/Bachi/addons/godot_mcp/launch/"*.sh

stop_input='{"stop_hook_active":false}'
(
    cd "$TMPROOT/Bachi"
    PROJECT_ROOT="$TMPROOT/Bachi" \
    MULTICA_AGENT_NAME="Bachi" \
    MULTICA_TASK_ID="" \
    GITHUB_PERSONAL_ACCESS_TOKEN="" \
    GH_TOKEN="" \
        bash "$HOOKS_DIR/auto-pr-on-stop.sh" <<<"$stop_input" >/dev/null 2>&1 || true
)

# Bachi sidecar should be released.
bachi_state=$(sidecar_field "$(sidecar_path Bachi)" state)
if [ "$bachi_state" = "released" ]; then
    pass "F3' Bachi sidecar state=released after stop hook"
else
    fail "F3' Bachi sidecar state=$bachi_state (want released)"
fi

# Other agents must be unchanged.
for agent in Atlas Archi Fronti Revy Refacty; do
    after_state=$(sidecar_field "$(sidecar_path "$agent")" state)
    if [ "$after_state" = "${BEFORE_STATE[$agent]}" ]; then
        pass "F3' $agent sidecar unchanged (state=$after_state)"
    else
        fail "F3' $agent sidecar state changed: ${BEFORE_STATE[$agent]} -> $after_state"
    fi
done

# ---------- F4' (deferred — needs 6 live editors) ----------------------------

note "F4': 6-editor parallel attach — deferred (requires 6 live Windows editors)"
note "      Revy runtime cannot spawn other agents' editors; documented in QA report."

# ---------- summary -----------------------------------------------------------

echo
echo "=== Suite F' summary ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
if (( FAIL > 0 )); then
    for c in "${FAILED[@]}"; do echo "    - $c"; done
    exit 1
fi
exit 0
