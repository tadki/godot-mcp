#!/bin/bash
# test_see1070_stop_hook_projectgodot_isolation.sh
#
# A/B isolation test for SEE-1070 #3-B (Refacty's stop-hook sanitize),
# semantics updated by SEE-1240 QA D2.
#
# Proves that [godot_mcp] runtime port keys written by an agent's editor
# session (port_override_enabled=true / port_override=6555) are DELETED
# outright (not zeroed) BEFORE the auto-pr-on-stop hook commits them — the
# clean tracked [godot_mcp] section carries only the static machine bind
# lines (bind_mode / custom_bind_ip, WS-8). A legitimate change in a
# DIFFERENT section ([autoload]) is preserved (segment-level sanitize, not
# whole-file exclude).
#
# Methodology: extract the hook at two revisions and run each against an
# identically-polluted throwaway repo (no origin remote, so the hook exits
# cleanly right after its commit at the NEW_COMMITS short-circuit).
#
#   BEFORE (e922cf7^,  pre-sanitize):       polluted port LEAKS into commit -> RED
#   AFTER  (D2_REV,    delete-key sanitize): runtime keys DELETED from commit -> GREEN
#
# Related Issues: SEE-1070, SEE-1062, SEE-1240 QA D2
# Test Type: A/B isolation + regression
# Author: Revy; semantics updated by Refacty (D2)

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

PROJECT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BEFORE_REV="e922cf7^"   # parent of the original sanitize commit (pre-sanitize)
# D2 (SEE-1240): resolve the delete-key sanitize revision — the first commit
# that carries `=|/d` (delete) semantics in the sanitize sed. Pinning by
# content keeps this test honest across future semantic updates: it always
# exercises the LIVE delete-key contract, not a frozen historical sha.
D2_REV="$(git -C "$PROJECT_ROOT" log --all -S '/^\(port_override_enabled\|port_override\)=/d' --format='%h' -- .claude/hooks/auto-pr-on-stop.sh 2>/dev/null | tail -1)"
AFTER_REV="${D2_REV:-0b18cef6}"  # QA D2 delete-key sanitize commit
HOOK_REL=".claude/hooks/auto-pr-on-stop.sh"

ORIG_DIR="$(pwd)"
TEST_TMPDIR=""
cleanup_items=()

setup_tmpdir() {
    TEST_TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/test-see1070-isolation.XXXXXX")
    cleanup_items+=("$TEST_TMPDIR")
}

cleanup() {
    for item in "${cleanup_items[@]}"; do
        rm -rf "$item" 2>/dev/null || true
    done
    cd "$ORIG_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Extract the hook at a given revision into an isolated file OUTSIDE any test
# repo (so the test repo's `git add -A` never stages it).
extract_hook_at_rev() {
    local rev="$1"
    local out="$2"
    git -C "$PROJECT_ROOT" show "${rev}:${HOOK_REL}" > "$out" 2>/dev/null
    chmod +x "$out"
}

# project.godot fixture reflecting a POLLUTED working tree:
# - [godot_mcp] port_override_enabled=true / port_override=6555  (agent runtime override — the pollution)
# - [autoload] SomeRealAutoload added                             (a legit change that MUST survive sanitize)
POLLUTED_PROJECT_GODOT='config_version=5

[application]

config/name="see1070-isolation"
config/icon="res://icon.svg"

[autoload]

MCPGameBridge="*res://addons/godot_mcp/game_bridge/mcp_game_bridge.gd"
SomeRealAutoload="*res://src/new_autoload.gd"

[editor_plugins]

enabled=PackedStringArray("res://addons/godot_mcp/plugin.cfg")

[godot_mcp]

bind_mode=1
custom_bind_ip=""
port_override_enabled=true
port_override=6555
'

# Clean baseline project.godot (committed history): no SomeRealAutoload, clean
# [godot_mcp] section = static machine bind lines ONLY (QA D2: the runtime
# port_override keys are deleted outright — the tracked clean state never
# carries them).
CLEAN_PROJECT_GODOT='config_version=5

[application]

config/name="see1070-isolation"
config/icon="res://icon.svg"

[autoload]

MCPGameBridge="*res://addons/godot_mcp/game_bridge/mcp_game_bridge.gd"

[editor_plugins]

enabled=PackedStringArray("res://addons/godot_mcp/plugin.cfg")

[godot_mcp]

bind_mode=1
custom_bind_ip=""
'

create_test_repo() {
    local repo="$1"
    mkdir -p "$repo"
    cd "$repo"
    git init -q
    git config user.email "revy-qa@example.com"
    git config user.name "Revy QA"
    printf '%s' "$CLEAN_PROJECT_GODOT" > project.godot
    git add project.godot
    git commit -qm "baseline: clean project.godot"
    # non-master, non-revy/test-* branch so the hook's branch filter passes
    git checkout -qb feature/SEE-1070-isolation
}

# Run the hook (at a given extracted path) against a repo whose working tree
# has already been polluted. Prints the COMMITTED project.godot (HEAD) to stdout.
run_hook_and_get_committed() {
    local hook_path="$1"
    local repo="$2"
    local committed

    cd "$repo"
    # Write the polluted working tree (simulating an agent's editor session).
    printf '%s' "$POLLUTED_PROJECT_GODOT" > project.godot

    # SAFETY: PROJECT_ROOT (if inherited) would make the hook `cd` back to the
    # real repo and pollute IT. Force it unset so the hook operates in-repo.
    env -u PROJECT_ROOT \
        GH_TOKEN="fake-token" \
        GITHUB_PERSONAL_ACCESS_TOKEN="fake-token" \
        MULTICA_TASK_ID= \
        MULTICA_AGENT_ID= \
        MULTICA_TOKEN= \
        MULTICA_SERVER_URL= \
        MULTICA_WORKSPACE_ID= \
        PATH="/usr/bin:/bin" \
        bash "$hook_path" <<< '{}' > /dev/null 2>&1

    committed=$(git show HEAD:project.godot 2>/dev/null)
    printf '%s' "$committed"
}

# ---- temp dir (must exist before any extraction) ----
setup_tmpdir

# ---- preflight: both revisions extractable ----
separator "Preflight"
preflight_ok=true
hook_before="$TEST_TMPDIR/hook-before.sh"
hook_after="$TEST_TMPDIR/hook-after.sh"
extract_hook_at_rev "$BEFORE_REV" "$hook_before"
extract_hook_at_rev "$AFTER_REV" "$hook_after"

if [ ! -s "$hook_before" ]; then
    fail "preflight: could not extract hook @ ${BEFORE_REV}"
    preflight_ok=false
fi
if [ ! -s "$hook_after" ]; then
    fail "preflight: could not extract hook @ ${AFTER_REV}"
    preflight_ok=false
fi
# Confirm the After revision actually contains the sanitize sed block.
# Use fixed-string (-F) match: '[' is a regex metachar in BRE.
if ! grep -Fq '[godot_mcp]' "$hook_after" 2>/dev/null \
   || ! grep -Fq 'port_override_enabled' "$hook_after" 2>/dev/null; then
    fail "preflight: After hook @ ${AFTER_REV} lacks the [godot_mcp] sanitize block"
    preflight_ok=false
else
    pass "preflight: After hook @ ${AFTER_REV} contains [godot_mcp] sanitize block"
fi
# Confirm the Before revision LACKS the sanitize sed block.
if grep -Fq '[godot_mcp]' "$hook_before" 2>/dev/null; then
    fail "preflight: Before hook @ ${BEFORE_REV} unexpectedly contains sanitize block"
else
    pass "preflight: Before hook @ ${BEFORE_REV} lacks sanitize block (expected)"
fi

if [ "$preflight_ok" != "true" ]; then
    echo -e "${RED}Preflight failed — aborting A/B run.${NC}"
    echo "PASS=$PASS FAIL=$FAIL"
    exit 2
fi

# ---- BEFORE: pre-sanitize hook → pollution LEAKS (expect RED) ----
separator "BEFORE (${BEFORE_REV}, pre-sanitize) — expect LEAK (RED)"
repo_before="$TEST_TMPDIR/repo-before"
create_test_repo "$repo_before"
committed_before=$(run_hook_and_get_committed "$hook_before" "$repo_before")

if echo "$committed_before" | grep -q '^port_override=6555$'; then
    pass "B.T1: pre-sanitize committed port_override=6555 (leak confirmed — this is the RED)"
else
    fail "B.T1: pre-sanitize commit did NOT retain port_override=6555; expected leak. committed=[ $(echo "$committed_before" | tr '\n' '|') ]"
fi
if echo "$committed_before" | grep -q '^port_override_enabled=true$'; then
    pass "B.T2: pre-sanitize committed port_override_enabled=true (leak confirmed)"
else
    fail "B.T2: pre-sanitize commit did NOT retain port_override_enabled=true"
fi
# WT contrast: pre-sanitize leaves the working tree polluted too (hook commits
# the file as-is, so WT == HEAD == polluted).
wt_before="$(cat "$repo_before/project.godot" 2>/dev/null)"
if echo "$wt_before" | grep -q '^port_override=6555$'; then
    pass "B.T3: pre-sanitize working-tree retains port_override=6555 (WT leak — the RED contrast)"
else
    fail "B.T3: pre-sanitize working-tree lacks port_override=6555 (unexpected). wt=[ $(echo "$wt_before" | tr '\n' '|') ]"
fi

# ---- AFTER: sanitize hook → pollution sanitized (expect GREEN) ----
separator "AFTER (${AFTER_REV}, sanitize) — expect sanitized (GREEN)"
repo_after="$TEST_TMPDIR/repo-after"
create_test_repo "$repo_after"
committed_after=$(run_hook_and_get_committed "$hook_after" "$repo_after")

if echo "$committed_after" | grep -q '^port_override='; then
    fail "A.T1: REGRESSION — sanitized commit still carries a port_override line (zeroed or not; D2 deletes the key outright). committed=[ $(echo "$committed_after" | tr '\n' '|') ]"
else
    pass "A.T1: sanitized commit carries NO port_override line (delete-key semantics, QA D2)"
fi
if echo "$committed_after" | grep -q '^port_override_enabled='; then
    fail "A.T2: REGRESSION — sanitized commit still carries a port_override_enabled line (zeroed or not)"
else
    pass "A.T2: sanitized commit carries NO port_override_enabled line"
fi
if echo "$committed_after" | grep -q '^port_override=6555$'; then
    fail "A.T3: REGRESSION — sanitized commit STILL contains port_override=6555 (leak survived)"
else
    pass "A.T3: sanitized commit does NOT contain port_override=6555 (no leak)"
fi
if echo "$committed_after" | grep -q '^bind_mode=1$' && echo "$committed_after" | grep -q '^custom_bind_ip=""$'; then
    pass "A.T2b: static machine bind lines (bind_mode/custom_bind_ip) preserved (WS-8 contract)"
else
    fail "A.T2b: static bind lines lost — sanitize is deleting static content too"
fi

# Segment-level proof: legit change in [autoload] preserved (not a whole-file exclude).
if echo "$committed_after" | grep -q 'SomeRealAutoload'; then
    pass "A.T4: legit [autoload] change (SomeRealAutoload) preserved — segment-level sanitize confirmed"
else
    fail "A.T4: legit [autoload] change was dropped — sanitize is too broad (whole-file exclude?)"
fi

# WT segment-level proof (Atlas 3ad2c6d5 #3): the hook sanitizes the file
# in-place before re-staging, so the WORKING TREE — not only the commit —
# must reflect clean [godot_mcp] defaults. And because the hook commits the
# sanitized WT, `git status` must NOT leave a stray `M project.godot`
# (WT == HEAD for that file). This is the segment-level contract: NOT a
# whole-file `git reset`/checkout that would also discard legit sections.
wt_after="$(cat "$repo_after/project.godot" 2>/dev/null)"
if echo "$wt_after" | grep -q '^port_override=' || echo "$wt_after" | grep -q '^port_override_enabled='; then
    fail "A.T6: working-tree [godot_mcp] still carries runtime keys (delete-key sanitize not applied). wt=[ $(echo "$wt_after" | tr '\n' '|') ]"
else
    pass "A.T6: working-tree [godot_mcp] runtime keys deleted (WT clean, not only the commit)"
fi
if echo "$wt_after" | grep -q '^port_override=6555$'; then
    fail "A.T7: REGRESSION — working-tree still contains port_override=6555 (WT leak survived sanitize)"
else
    pass "A.T7: working-tree does NOT contain port_override=6555"
fi
status_after="$(git -C "$repo_after" status --porcelain 2>/dev/null)"
if echo "$status_after" | grep -q 'project.godot'; then
    fail "A.T8: git status leaves project.godot modified after hook (WT != HEAD — not a clean segment sanitize). status=[ $(echo "$status_after" | tr '\n' '|') ]"
else
    pass "A.T8: git status clean for project.godot (hook committed the sanitized WT; no stray modification)"
fi

# ---- idempotence: clean working tree stays clean after hook ----
separator "AFTER (idempotence) — clean input stays clean"
repo_idem="$TEST_TMPDIR/repo-idem"
create_test_repo "$repo_idem"
cd "$repo_idem"
# Working tree already matches committed clean baseline; only touch an unrelated
# file so DIRTY is non-empty and the hook enters scenario 1.
echo "x" > unrelated.txt
env -u PROJECT_ROOT \
    GH_TOKEN="fake-token" \
    GITHUB_PERSONAL_ACCESS_TOKEN="fake-token" \
    MULTICA_TASK_ID= \
    MULTICA_AGENT_ID= \
    MULTICA_TOKEN= \
    MULTICA_SERVER_URL= \
    MULTICA_WORKSPACE_ID= \
    PATH="/usr/bin:/bin" \
    bash "$hook_after" <<< '{}' > /dev/null 2>&1
committed_idem=$(git show HEAD:project.godot 2>/dev/null)
if ! echo "$committed_idem" | grep -qE '^port_override(_enabled)?=' && echo "$committed_idem" | grep -q '^bind_mode=1$'; then
    pass "A.T5: idempotent — clean [godot_mcp] stays key-free with static bind lines intact after hook"
else
    fail "A.T5: idempotence broken — clean input altered. committed=[ $(echo "$committed_idem" | tr '\n' '|') ]"
fi

# ---- summary ----
separator "Summary"
echo -e "PASS=${GREEN}${PASS}${NC} FAIL=${RED}${FAIL}${NC}"
echo ""
if [ "$FAIL" -eq 0 ]; then
    echo -e "${GREEN}RESULT: A/B CONFIRMED.${NC} Before leaks (RED), After sanitized (GREEN), legit change preserved, idempotent."
    exit 0
else
    echo -e "${RED}RESULT: A/B FAILED — see failures above.${NC}"
    exit 1
fi
