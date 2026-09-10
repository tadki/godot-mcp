#!/bin/bash
# test_see1091_reconfigure_after_stop_converges.sh
#
# Rewritten under SEE-1117 Direction 3 — original asserted `[godot_mcp]` in
# project.godot; current asserts sidecar at `<worktree>/.godot/mcp-lease.json`.
# See Bachi's evidence report in issue SEE-1117 thread 643309c3.
#
# Convergence test for the configure -> stop-sanitize -> configure cycle.
#
# SEE-1091 root cause: after an agent's Godot editor lease self-exits, the next
# MCP session's auto-spawn chain failed to re-launch an editor on the agent's
# port. Under Direction 3 the per-agent port lease is no longer pinned into
# project.godot; it lives in a gitignored sidecar file at
# <worktree>/.godot/mcp-lease.json. The lifecycle is:
#
#   * lease start  — configure-mcp-port.sh writes sidecar state=active.
#   * lease end    — auto-pr-on-stop.sh -> restore-godot-original.sh transitions
#                    the sidecar to state=released (idempotent).
#   * verify       — verify-godot-written-back.sh exits 0 on released/absent,
#                    1 on active.
#
# This test proves the cycle converges and project.godot is NEVER polluted:
#
#     configure (sidecar active/<AGENT_PORT>) -> stop-sanitize (sidecar
#     released) -> configure (sidecar active/<AGENT_PORT>)
#   * sidecar is active/<AGENT_PORT> after every configure (converges)
#   * sidecar is released after the stop-hook (sanitize intact)
#   * project.godot working-tree == HEAD at EVERY checkpoint (Direction 3
#     invariant: the hook and the launch toolchain never edit project.godot)
#   * HEAD contains no port_override residue anywhere
#   * the cycle is idempotent (fast path: re-configure on an already-active
#     sidecar is a no-op that leaves lease_id unchanged)
#
# Methodology: run the REAL hook (auto-pr-on-stop.sh @ HEAD) and the REAL
# configure-mcp-port.sh against an isolated throwaway repo (no origin remote,
# so the hook exits cleanly right after its commit at the NEW_COMMITS
# short-circuit). The launch toolchain (launch/*) is mirrored
# into the throwaway repo so the hook's sanitize_lease_sidecar can find
# restore-godot-original.sh under PROJECT_ROOT. The hook is invoked with
# Multica/gh env cleared and PATH restricted, exactly like the test_see1070
# baseline.
#
# Constraint: neither hook file nor configure-mcp-port.sh is modified; the
# existing test_see1070_stop_hook_projectgodot_isolation.sh baseline is left
# untouched. This test asserts against their CURRENT behavior.
#
# Related Issues: SEE-1091, SEE-1070, SEE-1062, SEE-919, SEE-1117
# Test Type: convergence + regression
# Author: Refacty (rewritten under SEE-1117 Direction 3)

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
RESULTS=()

pass() {
    echo -e "  ${GREEN}[PASS]${NC} $1"
    PASS=$((PASS + 1))
    RESULTS+=("PASS|$1")
}

fail() {
    echo -e "  ${RED}[FAIL]${NC} $1"
    FAIL=$((FAIL + 1))
    RESULTS+=("FAIL|$1")
}

separator() {
    echo ""
    echo -e "${CYAN}--- $1 ---${NC}"
}

PROJECT_ROOT="$(cd "$(dirname "$0")/../../../" && pwd)"
HOOK="$PROJECT_ROOT/.claude/hooks/auto-pr-on-stop.sh"
LAUNCH_DIR="$PROJECT_ROOT/launch"
CONFIGURE="$LAUNCH_DIR/configure-mcp-port.sh"
RESTORE="$LAUNCH_DIR/restore-godot-original.sh"
# Refacty's own allocated port (agent-ports.json); any valid agent port would do.
AGENT_PORT=6556

ORIG_DIR="$(pwd)"
TEST_TMPDIR=""
cleanup_items=()

setup_tmpdir() {
    TEST_TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/test-see1091-convergence.XXXXXX")
    cleanup_items+=("$TEST_TMPDIR")
}

cleanup() {
    for item in "${cleanup_items[@]}"; do
        rm -rf "$item" 2>/dev/null || true
    done
    cd "$ORIG_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Read a single field from the sidecar JSON via node (no jq dependency).
# Prints the value or "" when the file is absent / malformed / field missing.
sidecar_field() {
    local sc="$1" f="$2"
    [ -f "$sc" ] || { echo ''; return; }
    SIDE_FIELD="$f" node -e '
        let raw = "";
        process.stdin.on("data", c => raw += c);
        process.stdin.on("end", () => {
            try {
                const o = JSON.parse(raw);
                const v = o[process.env.SIDE_FIELD];
                process.stdout.write(v === null || v === undefined ? "" : String(v));
            } catch (e) { process.stdout.write(""); }
        });
    ' < "$sc" 2>/dev/null
}

# Run the real stop hook against the current repo with all Multica/gh secrets
# cleared and a restricted PATH, so it operates entirely in-repo. PROJECT_ROOT
# is set to the throwaway repo so the hook cd's there AND resolves
# restore-godot-original.sh from the mirrored launch/ tree.
# The hook commits dirty files and exits at the NEW_COMMITS short-circuit
# because the throwaway repo has no origin remote.
run_stop_hook() {
    env -u PROJECT_ROOT_OLD \
        PROJECT_ROOT="$repo" \
        GH_TOKEN="fake-token" \
        GITHUB_PERSONAL_ACCESS_TOKEN="fake-token" \
        MULTICA_TASK_ID= \
        MULTICA_AGENT_ID= \
        MULTICA_TOKEN= \
        MULTICA_SERVER_URL= \
        MULTICA_WORKSPACE_ID= \
        PATH="/usr/bin:/bin" \
        bash -c "cd \"$repo\" && PROJECT_ROOT=\"$repo\" bash \"$HOOK\" <<< '{}'" > /dev/null 2>&1
}

run_configure() {
    KOL_PROJECT_GODOT="$repo/project.godot" bash "$CONFIGURE" --port "$AGENT_PORT" --project-godot "$repo/project.godot" > /dev/null 2>&1
}

# Assert the sidecar state at a checkpoint. Label identifies the checkpoint;
# state_arg is the EXPECTED state ("active" / "released"); port_arg is the
# EXPECTED port (only meaningful when state_arg=active).
check_sidecar() {
    local label="$1" exp_state="$2" exp_port="${3:-}"
    local sc="$repo/.godot/mcp-lease.json"
    if [ ! -f "$sc" ]; then
        fail "$label: sidecar missing at $sc"
        return
    fi
    local st port
    st="$(sidecar_field "$sc" state)"
    port="$(sidecar_field "$sc" port)"
    if [ "$st" != "$exp_state" ]; then
        fail "$label: expected sidecar state=${exp_state}, got state=${st:-<unset>}"
        return
    fi
    if [ -n "$exp_port" ] && [ "$port" != "$exp_port" ]; then
        fail "$label: expected sidecar port=${exp_port}, got port=${port:-<unset>}"
        return
    fi
    if [ -n "$exp_port" ]; then
        pass "$label: sidecar state=${exp_state} port=${exp_port}"
    else
        pass "$label: sidecar state=${exp_state}"
    fi
}

# Assert project.godot working-tree == HEAD (Direction 3 invariant: neither
# configure nor the stop hook ever edits project.godot).
check_project_godot_clean() {
    local label="$1"
    local diff_out
    diff_out="$(cd "$repo" && git diff HEAD -- project.godot 2>/dev/null)"
    if [ -z "$diff_out" ]; then
        pass "$label: project.godot working tree matches HEAD (Direction 3 invariant)"
    else
        fail "$label: project.godot diverged from HEAD (first 200 chars): $(printf '%s' "$diff_out" | head -c 200)"
    fi
}

# Assert HEAD:project.godot carries no port_override residue anywhere. Under
# Direction 3 the lease never touches project.godot, so port_override and
# port_override_enabled strings should be absent from the committed file
# entirely.
check_head_no_port_residue() {
    local label="$1"
    local head_all
    head_all="$(cd "$repo" && git show HEAD:project.godot 2>/dev/null)"
    if printf '%s' "$head_all" | grep -qE "port_override=|port_override_enabled="; then
        fail "$label: HEAD:project.godot still carries port_override* residue"
    else
        pass "$label: HEAD:project.godot has no port_override residue"
    fi
}

# ---- temp dir ----
setup_tmpdir

# ---- preflight ----
separator "Preflight"
preflight_ok=true
if [ -s "$HOOK" ]; then pass "preflight: stop hook found at $HOOK"; else fail "preflight: stop hook missing at $HOOK"; preflight_ok=false; fi
if [ -s "$CONFIGURE" ]; then pass "preflight: configure script found at $CONFIGURE"; else fail "preflight: configure script missing at $CONFIGURE"; preflight_ok=false; fi
if [ -s "$RESTORE" ]; then pass "preflight: restore script found at $RESTORE"; else fail "preflight: restore script missing at $RESTORE"; preflight_ok=false; fi
if grep -Fq 'sanitize_lease_sidecar' "$HOOK" 2>/dev/null && grep -Fq 'restore-godot-original' "$HOOK" 2>/dev/null; then
    pass "preflight: stop hook contains the sidecar sanitize block"
else
    fail "preflight: stop hook lacks the sidecar sanitize block (sanitize_lease_sidecar / restore-godot-original)"
    preflight_ok=false
fi
if grep -Fq 'Fast path' "$CONFIGURE" 2>/dev/null; then
    pass "preflight: configure script has the idempotent fast path"
else
    fail "preflight: configure script lacks the fast path"
    preflight_ok=false
fi
if [ "$preflight_ok" != "true" ]; then
    echo -e "${RED}Preflight failed — aborting.${NC}"
    echo "PASS=$PASS FAIL=$FAIL"
    exit 2
fi

# ---- throwaway repo ----
separator "Setup (throwaway repo)"
repo="$TEST_TMPDIR/repo"
mkdir -p "$repo/launch"
cd "$repo"
git init -q
git config user.email "refacty@example.com"
git config user.name "Refacty"
git config commit.gpgsign false
# Non-master, non-revy/test-* branch so the hook's branch filter passes.
git checkout -qb feature/SEE-1091-convergence
# Mirror the launch toolchain so the hook's sanitize_lease_sidecar can find
# restore-godot-original.sh via $PROJECT_ROOT/launch/.
cp "$LAUNCH_DIR"/*.sh "$LAUNCH_DIR"/*.lib.sh "$repo/launch/" 2>/dev/null || true
cp "$LAUNCH_DIR"/agent-ports.json "$repo/launch/" 2>/dev/null || true
chmod +x "$repo/launch/"*.sh
# Baseline project.godot with no [godot_mcp] section. Under Direction 3
# configure does NOT append anything — project.godot is treated as a read-only
# worktree anchor. Keep this minimal so the byte-diff invariant is clean.
printf 'config_version=5\n\n[application]\n\nconfig/name="see1091-convergence"\n' > project.godot
# .gitignore must cover .godot/ so the sidecar never enters git (Direction 3
# invariant). Add it BEFORE the first commit so the rule is present at HEAD.
printf '.godot/\n' > .gitignore
git add project.godot .gitignore
git commit -qm "baseline: clean project.godot + .gitignore covering .godot/"
# The hook only commits when something is dirty; seed an unrelated file so the
# first cycle still exercises the commit path.
echo "x" > unrelated.txt
pass "throwaway repo created on feature/SEE-1091-convergence, no origin remote, launch toolchain mirrored"

# ---- cycle 1: configure -> stop-sanitize -> configure ----
separator "Cycle 1 — configure -> stop-sanitize -> configure"

if run_configure; then
    pass "C1.S1: configure-mcp-port.sh --port ${AGENT_PORT} rc=0"
else
    fail "C1.S1: configure-mcp-port.sh --port ${AGENT_PORT} failed"
fi
check_sidecar "C1.S2 after configure" "active" "$AGENT_PORT"
check_project_godot_clean "C1.S2b after configure"

if run_stop_hook; then
    pass "C1.S3: stop hook ran clean (rc=0)"
else
    fail "C1.S3: stop hook failed"
fi
check_sidecar "C1.S4 after stop-hook sanitize" "released"
check_project_godot_clean "C1.S4b after stop-hook"
check_head_no_port_residue "C1.S5 after stop-hook"

# After the stop hook the sidecar must be released — and since the sidecar is
# gitignored, `git status` must NOT show it as untracked/modified.
status_after_hook="$(cd "$repo" && git status --porcelain)"
if printf '%s' "$status_after_hook" | grep -q '\.godot/'; then
    fail "C1.S6: git status shows .godot/ entries (sidecar leaked into git tracking — Direction 3 broken)"
else
    pass "C1.S6: git status clean for .godot/ (sidecar is gitignored, never tracked)"
fi

# Capture the lease_id after cycle-1's stop, so we can prove the fast path
# does NOT regenerate it on the next configure.
LEASE_ID_CYCLE1="$(sidecar_field "$repo/.godot/mcp-lease.json" lease_id)"
[ -n "$LEASE_ID_CYCLE1" ] && pass "C1.S6b: cycle-1 sidecar has non-empty lease_id" \
    || fail "C1.S6b: cycle-1 sidecar missing lease_id"

if run_configure; then
    pass "C1.S7: re-configure after stop-hook rc=0"
else
    fail "C1.S7: re-configure after stop-hook failed"
fi
check_sidecar "C1.S8 after re-configure (converged)" "active" "$AGENT_PORT"
check_project_godot_clean "C1.S8b after re-configure"
check_head_no_port_residue "C1.S9 HEAD still clean after re-configure"

# The lease_id MUST regenerate across a stop->configure cycle (a fresh lease
# is a fresh lease). Assert the cycle-2 lease_id differs from cycle-1's.
LEASE_ID_CYCLE2="$(sidecar_field "$repo/.godot/mcp-lease.json" lease_id)"
if [ -n "$LEASE_ID_CYCLE2" ] && [ "$LEASE_ID_CYCLE2" != "$LEASE_ID_CYCLE1" ]; then
    pass "C1.S10: lease_id regenerated across stop->configure cycle (fresh lease, not a stale resurrection)"
else
    fail "C1.S10: lease_id NOT regenerated (before=${LEASE_ID_CYCLE1:-<unset>} after=${LEASE_ID_CYCLE2:-<unset>})"
fi

# ---- idempotence: second configure on already-active sidecar hits the fast path ----
separator "Idempotence (fast path)"
LEASE_ID_BEFORE_FASTPATH="$(sidecar_field "$repo/.godot/mcp-lease.json" lease_id)"
if run_configure; then
    pass "C2.F1: re-configure on already-active sidecar rc=0"
else
    fail "C2.F1: re-configure on already-active sidecar failed"
fi
check_sidecar "C2.F2 after fast-path re-configure" "active" "$AGENT_PORT"
LEASE_ID_AFTER_FASTPATH="$(sidecar_field "$repo/.godot/mcp-lease.json" lease_id)"
if [ "$LEASE_ID_AFTER_FASTPATH" = "$LEASE_ID_BEFORE_FASTPATH" ]; then
    pass "C2.F3: fast path leaves lease_id UNCHANGED (no regeneration on no-op)"
else
    fail "C2.F3: fast path regenerated lease_id ($LEASE_ID_BEFORE_FASTPATH -> $LEASE_ID_AFTER_FASTPATH)"
fi
check_project_godot_clean "C2.F4 project.godot still clean after fast-path"
check_head_no_port_residue "C2.F5 HEAD still clean after fast-path"

# ---- cycle 2: full repeat still converges ----
separator "Cycle 2 — full repeat converges"
if run_stop_hook; then
    pass "C3.S1: stop hook rc=0"
else
    fail "C3.S1: stop hook failed"
fi
check_sidecar "C3.S2 after stop-hook sanitize" "released"
check_project_godot_clean "C3.S2b after stop-hook"
check_head_no_port_residue "C3.S3 HEAD clean after stop-hook"
if run_configure; then
    pass "C3.S4: re-configure rc=0"
else
    fail "C3.S4: re-configure failed"
fi
check_sidecar "C3.S5 after re-configure (converged)" "active" "$AGENT_PORT"
check_project_godot_clean "C3.S5b after re-configure"
check_head_no_port_residue "C3.S6 HEAD still clean after re-configure"

# ---- summary ----
separator "Summary"
echo -e "PASS=${GREEN}${PASS}${NC} FAIL=${RED}${FAIL}${NC}"
echo ""
if [ "$FAIL" -eq 0 ]; then
    echo -e "${GREEN}RESULT: CONVERGENCE CONFIRMED.${NC} configure -> stop-sanitize -> configure converges; project.godot == HEAD throughout; fast path idempotent."
    exit 0
else
    echo -e "${RED}RESULT: CONVERGENCE FAILED — see failures above.${NC}"
    exit 1
fi
