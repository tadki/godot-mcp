#!/bin/bash
# test_see1111_stop_hook_sanitizes_master.sh
#
# Rewritten under SEE-1117 Direction 3 — original asserted `[godot_mcp]` in
# project.godot; current asserts sidecar at `<worktree>/.godot/mcp-lease.json`.
# See Bachi's evidence report in issue SEE-1117 thread 643309c3.
#
# SEE-1111 §7.1 防线 1 — the stop hook must run sanitize_lease_sidecar on
# EVERY branch, INCLUDING master, even though the auto-commit/push/PR flow
# short-circuits at the master/main branch filter. Under Direction 3 the
# sanitize transitions the per-worktree sidecar (.godot/mcp-lease.json) to
# state=released; project.godot is NOT touched by the hook any more.
#
# SEE-1111 root cause, defense-1 side: the stop hook's old branch filter
# `[ "$CURRENT_BRANCH" = "master" ] || [ "$CURRENT_BRANCH" = "main" ] && exit 0`
# returned before sanitize ever ran. Under Direction 3 the sidecar sanitize is
# hoisted BEFORE the master/main branch filter (auto-pr-on-stop.sh runs
# sanitize_lease_sidecar unconditionally). The auto-commit/push/PR flow still
# skips master/main.
#
# Synthetic fixture note: master never has a sidecar under normal flow — the
# write-target guard inside configure-mcp-port.sh refuses to write a lease on
# a checkout whose HEAD is on branch master. To exercise the "agent crashed
# leaving a stale active sidecar on the master checkout" recovery case, this
# test writes the sidecar by hand (NOT via configure-mcp-port.sh), then runs
# the real stop hook and asserts the sidecar transitioned to state=released.
#
# Assertions:
#   M0  synthetic active sidecar present on master before hook
#   M1  stop hook runs clean on master (rc=0)
#   M2  sidecar state=released after hook on master
#   M3  project.godot working tree == HEAD on master (Direction 3: hook never
#       edits project.godot)
#   M4  master auto-commit flow still skipped (commit count unchanged)
#   F1  stop hook ran clean on feature branch
#   F2  sidecar state=released after hook on feature
#   F3  project.godot working tree == HEAD on feature (Direction 3 invariant)
#
# Methodology: run the REAL hook (auto-pr-on-stop.sh @ HEAD) against an isolated
# throwaway git repo with a master/feature branch and no origin remote, exactly
# like the test_see1070/test_see1091 baseline (Multica/gh env cleared, PATH
# restricted). The launch toolchain (launch/*) is mirrored into
# the throwaway repo so the hook can resolve restore-godot-original.sh via
# $PROJECT_ROOT. Since master short-circuits the auto-commit flow, we assert
# sidecar state + commit count instead of HEAD contents.
#
# Related Issues: SEE-1111, SEE-1070, SEE-1091, SEE-1062, SEE-919, SEE-1117
# Test Type: regression + defense-in-depth
# Author: Bachi (rewritten under SEE-1117 Direction 3)

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
AGENT_PORT=6553

ORIG_DIR="$(pwd)"
TEST_TMPDIR=""
cleanup_items=()

setup_tmpdir() {
    TEST_TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/test-see1111-stop-hook-master.XXXXXX")
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
run_stop_hook() {
    local repo_dir="$1"
    env PROJECT_ROOT="$repo_dir" \
        GH_TOKEN="fake-token" \
        GITHUB_PERSONAL_ACCESS_TOKEN="fake-token" \
        MULTICA_TASK_ID= \
        MULTICA_AGENT_ID= \
        MULTICA_TOKEN= \
        MULTICA_SERVER_URL= \
        MULTICA_WORKSPACE_ID= \
        PATH="/usr/bin:/bin" \
        bash -c "cd \"$repo_dir\" && PROJECT_ROOT=\"$repo_dir\" bash \"$HOOK\" <<< '{}'" > /dev/null 2>&1
}

# Mirror the launch toolchain into a fixture repo so the hook can resolve
# restore-godot-original.sh via $PROJECT_ROOT/launch/.
mirror_toolchain() {
    local repo_dir="$1"
    mkdir -p "$repo_dir/launch"
    cp "$LAUNCH_DIR"/*.sh "$LAUNCH_DIR"/*.lib.sh "$repo_dir/launch/" 2>/dev/null || true
    cp "$LAUNCH_DIR"/agent-ports.json "$repo_dir/launch/" 2>/dev/null || true
    chmod +x "$repo_dir/launch/"*.sh
}

# Drop a synthetic ACTIVE sidecar on a fixture repo. This is the recovery
# scenario: configure-mcp-port.sh would refuse to write here (master branch
# guard), but a crashed agent might leave an active sidecar behind. The hook's
# job is to transition state=active -> state=released on the next session end.
seed_active_sidecar() {
    local repo_dir="$1" port="$2"
    local sc_dir="$repo_dir/.godot"
    mkdir -p "$sc_dir"
    SEED_PORT="$port" SEED_WORKTREE="$repo_dir" node -e '
        const crypto = require("crypto");
        const out = {
            schema_version: 1,
            port: Number(process.env.SEED_PORT),
            agent: "Bachi",
            label: "bachi",
            state: "active",
            lease_id: crypto.randomUUID(),
            worktree: process.env.SEED_WORKTREE || "",
            configured_at: new Date().toISOString(),
            configured_by_pid: null,
            released_at: null,
            notes: "SEE-1111 synthetic stale lease on master"
        };
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    ' > "$sc_dir/mcp-lease.json"
}

# Assert sidecar state at a checkpoint. Label identifies the checkpoint; values
# are the EXPECTED state ("active" / "released").
check_sidecar_state() {
    local label="$1" repo_dir="$2" exp_state="$3"
    local sc="$repo_dir/.godot/mcp-lease.json"
    if [ ! -f "$sc" ]; then
        fail "$label: sidecar missing at $sc"
        return
    fi
    local st
    st="$(sidecar_field "$sc" state)"
    if [ "$st" = "$exp_state" ]; then
        pass "$label: sidecar state=${exp_state}"
    else
        fail "$label: expected sidecar state=${exp_state}, got state=${st:-<unset>}"
    fi
}

# Assert the sidecar port was preserved through the released transition
# (Direction 3: released records keep the last port so an operator can audit
# which port the dead lease held).
check_sidecar_port() {
    local label="$1" repo_dir="$2" exp_port="$3"
    local sc="$repo_dir/.godot/mcp-lease.json"
    if [ ! -f "$sc" ]; then
        fail "$label: sidecar missing"
        return
    fi
    local p
    p="$(sidecar_field "$sc" port)"
    if [ "$p" = "$exp_port" ]; then
        pass "$label: sidecar port=${exp_port} preserved through transition"
    else
        fail "$label: expected sidecar port=${exp_port}, got port=${p:-<unset>}"
    fi
}

# Assert released_at was populated (lease-end audit trail).
check_sidecar_released_at() {
    local label="$1" repo_dir="$2"
    local sc="$repo_dir/.godot/mcp-lease.json"
    if [ ! -f "$sc" ]; then
        fail "$label: sidecar missing"
        return
    fi
    local ra
    ra="$(sidecar_field "$sc" released_at)"
    if [ -n "$ra" ]; then
        pass "$label: sidecar released_at populated (${ra})"
    else
        fail "$label: sidecar released_at empty (audit trail missing)"
    fi
}

# Assert project.godot working-tree == HEAD (Direction 3 invariant: the hook
# never edits project.godot; under Direction 3 it only transitions the
# sidecar).
check_project_godot_clean() {
    local label="$1" repo_dir="$2"
    local diff_out
    diff_out="$(cd "$repo_dir" && git diff HEAD -- project.godot 2>/dev/null)"
    if [ -z "$diff_out" ]; then
        pass "$label: project.godot working tree matches HEAD (Direction 3 invariant)"
    else
        fail "$label: project.godot diverged from HEAD (first 200 chars): $(printf '%s' "$diff_out" | head -c 200)"
    fi
}

# ---- temp dir + preflight ----
setup_tmpdir
separator "Preflight"
preflight_ok=true
if [ -s "$HOOK" ]; then pass "preflight: stop hook found at $HOOK"; else fail "preflight: stop hook missing at $HOOK"; preflight_ok=false; fi
if grep -Fq 'sanitize_lease_sidecar' "$HOOK" 2>/dev/null; then
    pass "preflight: stop hook contains the sidecar sanitize (sanitize_lease_sidecar)"
else
    fail "preflight: stop hook lacks the sidecar sanitize block (sanitize_lease_sidecar)"
    preflight_ok=false
fi
if grep -qE 'restore-godot-original\.sh' "$HOOK" 2>/dev/null; then
    pass "preflight: stop hook delegates to restore-godot-original.sh (single source of truth)"
else
    fail "preflight: stop hook does not reference restore-godot-original.sh"
    preflight_ok=false
fi
if grep -qE '^\s*sanitize_lease_sidecar' "$HOOK" 2>/dev/null; then
    pass "preflight: sanitize is hoisted before the master/main branch filter"
else
    fail "preflight: sanitize_lease_sidecar() defined but not called unconditionally"
    preflight_ok=false
fi
if [ "$preflight_ok" != "true" ]; then
    echo -e "${RED}Preflight failed — aborting.${NC}"
    echo "PASS=$PASS FAIL=$FAIL"
    exit 2
fi

# ---- master-repo scenario ----
separator "Master checkout — sidecar sanitize must run despite the branch filter"
repo="$TEST_TMPDIR/master-repo"
mkdir -p "$repo"
cd "$repo"
git init -q
git config user.email "bachi@example.com"
git config user.name "Bachi"
git config commit.gpgsign false
git checkout -qb master
mirror_toolchain "$repo"
# Baseline clean project.godot committed on master.
printf 'config_version=5\n\n[application]\n\nconfig/name="see1111-master"\n' > project.godot
# .gitignore must cover .godot/ (Direction 3 invariant: the sidecar never
# enters git).
printf '.godot/\n' > .gitignore
git add project.godot .gitignore
git commit -qm "baseline: clean project.godot on master + .gitignore"
COMMITS_BEFORE=$(git rev-list --count HEAD)

# Seed a synthetic ACTIVE sidecar by hand (the recovery scenario: a crashed
# agent left a stale active lease on the shared master checkout). configure
# would refuse — that's why this test bypasses configure and writes the sidecar
# directly.
seed_active_sidecar "$repo" "$AGENT_PORT"

if [ "$(sidecar_field "$repo/.godot/mcp-lease.json" state)" = "active" ] \
    && [ "$(sidecar_field "$repo/.godot/mcp-lease.json" port)" = "$AGENT_PORT" ]; then
    pass "M0: fixture pollution seeded (state=active port=$AGENT_PORT on master)"
else
    fail "M0: fixture pollution NOT seeded"
fi

if run_stop_hook "$repo"; then
    pass "M1: stop hook ran clean on master (rc=0)"
else
    fail "M1: stop hook failed on master"
fi

check_sidecar_state "M2 after stop-hook on master" "$repo" "released"
check_sidecar_port "M3 after stop-hook on master (port preserved)" "$repo" "$AGENT_PORT"
check_sidecar_released_at "M4 after stop-hook on master (released_at audit trail)" "$repo"
check_project_godot_clean "M5 after stop-hook on master" "$repo"

COMMITS_AFTER=$(git rev-list --count HEAD)
if [ "$COMMITS_AFTER" = "$COMMITS_BEFORE" ]; then
    pass "M6: master auto-commit flow still skipped (commit count unchanged $COMMITS_BEFORE -> $COMMITS_AFTER)"
else
    fail "M6: master got a commit ($COMMITS_BEFORE -> $COMMITS_AFTER) — branch filter broken"
fi

# Defense-in-depth: the synthetic sidecar must NOT appear in `git status` (it's
# gitignored) and must NOT have entered the committed HEAD tree.
if git -C "$repo" status --porcelain | grep -q '\.godot/'; then
    fail "M7: git status shows .godot/ entries on master (sidecar leaked into git tracking)"
else
    pass "M7: git status clean for .godot/ on master (sidecar never tracked)"
fi
if git -C "$repo" ls-files | grep -qF '.godot/mcp-lease.json'; then
    fail "M8: HEAD tree on master contains the sidecar file (Direction 3 invariant broken)"
else
    pass "M8: HEAD tree on master does not track the sidecar"
fi

# ---- feature-branch scenario (regression: sanitize still works there) ----
separator "Feature branch — sanitize still works after the hoist"
repo2="$TEST_TMPDIR/feature-repo"
mkdir -p "$repo2"
cd "$repo2"
git init -q
git config user.email "bachi@example.com"
git config user.name "Bachi"
git config commit.gpgsign false
git checkout -qb feature/SEE-1111-sanitize
mirror_toolchain "$repo2"
printf 'config_version=5\n\n[application]\n\nconfig/name="see1111-feature"\n' > project.godot
printf '.godot/\n' > .gitignore
git add project.godot .gitignore
git commit -qm "baseline: clean project.godot on feature"
echo x > unrelated.txt   # seed a dirty file so the commit path is exercised

seed_active_sidecar "$repo2" "$AGENT_PORT"
if [ "$(sidecar_field "$repo2/.godot/mcp-lease.json" state)" = "active" ]; then
    pass "F0: fixture pollution seeded on feature (state=active port=$AGENT_PORT)"
else
    fail "F0: fixture pollution NOT seeded on feature"
fi

if run_stop_hook "$repo2"; then
    pass "F1: stop hook ran clean on feature (rc=0)"
else
    fail "F1: stop hook failed on feature"
fi

check_sidecar_state "F2 after stop-hook on feature" "$repo2" "released"
check_sidecar_port "F2b after stop-hook on feature (port preserved)" "$repo2" "$AGENT_PORT"
check_project_godot_clean "F3 after stop-hook on feature" "$repo2"
# HEAD on feature carries no port residue anywhere (Direction 3 invariant).
if git -C "$repo2" show HEAD:project.godot 2>/dev/null | grep -qE "port_override=|port_override_enabled="; then
    fail "F4: HEAD:project.godot on feature carries port_override residue"
else
    pass "F4: HEAD:project.godot on feature has no port_override residue"
fi

# ---- summary ----
separator "Summary"
echo -e "PASS=${GREEN}${PASS}${NC} FAIL=${RED}${FAIL}${NC}"
echo ""
if [ "$FAIL" -eq 0 ]; then
    echo -e "${GREEN}RESULT: MASTER GATE CLOSED.${NC} stop-hook sidecar sanitize runs on master; auto-commit flow still skips master; feature branch unaffected; project.godot never touched."
    exit 0
else
    echo -e "${RED}RESULT: MASTER GATE OPEN — see failures above.${NC}"
    exit 1
fi
