#!/usr/bin/env bash
# SEE-1117 Phase 1 QA — configure / restore / verify / push-guard /
# auto-pr-on-stop lifecycle in isolated temp worktrees.
#
# SEE-1291 drift adjudication (docs/SEE-1291-phase1-drift-adjudication.md):
# the Phase-1 project.godot marker channel is RETIRED (SEE-1117 Direction 3 +
# SEE-1240 WS-8 — mcp_write_marker has zero production call sites; per-agent
# lease state lives only in the gitignored sidecar .godot/mcp-lease.json).
# Arms re-scoped or retired accordingly; this suite now asserts the SIDECAR
# lifecycle and the push-guard sidecar invariants:
#
#   S-atlas / S-revy (ports 6551/6555) — the lease round-trip:
#     S-x.1 configure writes sidecar state=active, port=$port, project.godot untouched
#     S-x.2 verify exit 1 while sidecar active
#     S-x.3 restore sets sidecar state=released
#     S-x.4 verify exit 0 after restore
#     S-x.5 project.godot byte-identical vs HEAD after the round-trip
#   S7       configure refuses a master-branch checkout (write-target guard)
#   S8       push-guard Check A: HEAD tree carrying .godot/mcp-lease.json rejected (rc=2)
#            [KOL-coupled: needs $KOL_ROOT/.claude/hooks]
#   S9       push-guard Check B: worktree sidecar state=active → rc=0 + soft warn
#            [KOL-coupled]
#   S10      auto-pr-on-stop releases the sidecar (lease-end backstop)
#            [KOL-coupled]
#
# Retired arms (removed; rationale + replacement coverage in the adjudication
# doc): S11/S11b fallback-grep arms (the legacy grep no longer exists), S12
# marker-absent verify (duplicate of Suite A A7), S13 configure-appends-marker
# and S14 marker-at-EOF (the marker write path is dead code — zero call sites).
#
# All assertions are grep / exit-code / JSON-field / byte-diff based.
#
# Run context: works from BOTH layouts.
#   - fork checkout (this repo): KOL_ROOT unset → self-contained arms run
#     against this checkout's launch/; hook-driven arms (S8/S9/S10) need a
#     KOL worktree — they are reported as ENV-LIMITED (never silently PASSed)
#     when $KOL_ROOT/.claude/hooks is absent. CI: run the KOL-coupled tier
#     with KOL_ROOT pointing at a KOL checkout.
#   - KOL checkout (fork mounted as addons/godot_mcp): auto-resolves.
#
#   bash launch/tests/scripts/test_see1117_phase1_marker_lifecycle.sh
#
# Exit 0 on all-pass (ENV-LIMITED arms are tallied separately, never counted
# as pass), non-zero with a printed FAIL list otherwise.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# KOL_ROOT: the KingOfLikes-Godot worktree that owns project.godot +
# .claude/hooks. Resolution order: explicit env → enclosing superproject
# (submodule checkout) → this repo (fork; hook arms become ENV-LIMITED).
KOL_ROOT="${KOL_ROOT:-}"
if [[ -z "$KOL_ROOT" ]]; then
    KOL_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-superproject-working-tree 2>/dev/null || true)"
fi
[[ -z "$KOL_ROOT" ]] && KOL_ROOT="$REPO_ROOT"

# LAUNCH_DIR: the launch toolchain under test. The fork's own launch/ wins so
# the suite always exercises THIS checkout's scripts; fall back to the KOL
# submodule mount when running from a KOL-layout checkout.
if [[ -d "$REPO_ROOT/launch" ]]; then
    LAUNCH_DIR="$REPO_ROOT/launch"
else
    LAUNCH_DIR="$KOL_ROOT/addons/godot_mcp/launch"
fi
HOOKS_DIR="$KOL_ROOT/.claude/hooks"
CONFIGURE="$LAUNCH_DIR/configure-mcp-port.sh"
RESTORE="$LAUNCH_DIR/restore-godot-original.sh"
VERIFY="$LAUNCH_DIR/verify-godot-written-back.sh"
PUSH_GUARD="$HOOKS_DIR/push-guard.sh"
AUTO_PR_STOP="$HOOKS_DIR/auto-pr-on-stop.sh"

HOOKS_AVAILABLE=0
if [[ -f "$PUSH_GUARD" && -f "$AUTO_PR_STOP" ]]; then
    HOOKS_AVAILABLE=1
fi

PASS_COUNT=0
FAIL_COUNT=0
ENV_LIMITED_COUNT=0
declare -a FAILED_CASES=()
declare -a ENV_LIMITED_CASES=()

TMPROOT="$(mktemp -d -t see1117-qa-XXXXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

note()   { printf '[qa] %s\n' "$*"; }
pass()   { PASS_COUNT=$((PASS_COUNT+1)); printf '  [PASS] %s\n' "$*"; }
fail()   { FAIL_COUNT=$((FAIL_COUNT+1)); FAILED_CASES+=("$1"); printf '  [FAIL] %s\n' "$*"; }
limited(){ ENV_LIMITED_COUNT=$((ENV_LIMITED_COUNT+1)); ENV_LIMITED_CASES+=("$1"); printf '  [ENV-LIMITED] %s (needs KOL worktree: set KOL_ROOT)\n' "$1"; }

# Synthetic fixture project.godot — mirrors the tracked WS-8 endgame state:
# static machine-level bind constants only, no per-agent runtime keys, no
# marker block. Self-contained so the suite runs from a pure fork checkout.
write_fixture_project_godot() {
    cat > "$1/project.godot" <<'EOF'
; Engine configuration file.
config_version=5

[application]

config/name="see1117-qa-fixture"

[godot_mcp]

bind_mode=1
custom_bind_ip=""
EOF
}

# --- fixture helpers --------------------------------------------------------

make_worktree() {
    # Build an isolated git repo with a committed project.godot, so
    # configure/verify/restore operate on a private copy and we never touch
    # any shared working tree.
    local dir="$1"
    mkdir -p "$dir"
    (
        cd "$dir"
        git init -q -b test-branch
        git config user.email qa@example.com
        git config user.name qa
        git config commit.gpgsign false
        if [[ -f "$KOL_ROOT/project.godot" ]]; then
            # KOL worktree available: use its HEAD blob (repo-shape fidelity).
            git -C "$KOL_ROOT" show HEAD:project.godot > "$dir/project.godot"
        else
            write_fixture_project_godot "$dir"
        fi
        git add project.godot
        git commit -q -m "fixture: project.godot at HEAD"
    )
}

sidecar_field() {
    # sidecar_field <sidecar.json> <field> — empty string when absent/invalid.
    local sc="$1" f="$2"
    [ -f "$sc" ] || return 0
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

sidecar_path() { printf '%s/.godot/mcp-lease.json' "$(dirname "$1")"; }

assert_sidecar() {
    # assert_sidecar <project.godot> <expected_state> <expected_port> <case>
    local pg="$1" want_state="$2" want_port="$3" name="$4"
    local sc
    sc="$(sidecar_path "$pg")"
    local got_state got_port
    got_state="$(sidecar_field "$sc" state)"
    got_port="$(sidecar_field "$sc" port)"
    if [[ "$got_state" == "$want_state" && "$got_port" == "$want_port" ]]; then
        pass "$name (sidecar=$got_state/$got_port)"
    else
        fail "$name: sidecar=$got_state/$got_port, expected $want_state/$want_port ($sc)"
    fi
}

# --- S-atlas / S-revy: lease round-trip on ports 6551/6555 -------------------

test_happy_path() {
    local port="$1" tag="$2"
    note "S-$tag: lease round-trip on port $port (sidecar semantics)"
    local dir="$TMPROOT/happy-$port"
    make_worktree "$dir"

    ( cd "$dir" && KOL_PROJECT_GODOT="$dir/project.godot" bash "$CONFIGURE" --port "$port" ) \
        >"$dir/configure.log" 2>&1 \
        || { fail "S-$tag configure"; return; }
    assert_sidecar "$dir/project.godot" active "$port" "S-$tag.1 configure wrote active sidecar"

    ( cd "$dir" && bash "$VERIFY" --project-godot "$dir/project.godot" ) \
        >"$dir/verify-pinned.log" 2>&1
    local rc=$?
    if (( rc == 1 )); then
        pass "S-$tag.2 verify exit 1 on active lease"
    else
        fail "S-$tag.2 verify exit=$rc on active lease (want 1)"
    fi

    ( cd "$dir" && bash "$RESTORE" --project-godot "$dir/project.godot" ) \
        >"$dir/restore.log" 2>&1 \
        || { fail "S-$tag.3 restore"; return; }
    assert_sidecar "$dir/project.godot" released "$port" "S-$tag.3 restore released sidecar"

    ( cd "$dir" && bash "$VERIFY" --project-godot "$dir/project.godot" ) \
        >"$dir/verify-restored.log" 2>&1
    rc=$?
    if (( rc == 0 )); then
        pass "S-$tag.4 verify exit 0 after restore"
    else
        fail "S-$tag.4 verify exit=$rc after restore (want 0)"
    fi

    # S5: byte-identical vs HEAD — the addon never writes project.godot
    # (SEE-1117 Direction 3 P1 contract).
    if git -C "$dir" diff --quiet HEAD -- project.godot; then
        pass "S-$tag.5 byte-identical vs HEAD after configure+restore"
    else
        fail "S-$tag.5 project.godot differs from HEAD after lease round-trip"
        git -C "$dir" diff HEAD -- project.godot | head -30 >&2
    fi
}

test_happy_path 6551 atlas
test_happy_path 6555 revy

# --- S7: master write-target guard ------------------------------------------

note "S7: master write-target guard"
master_dir="$TMPROOT/master-checkout"
mkdir -p "$master_dir"
(
    cd "$master_dir"
    git init -q -b master
    git config user.email qa@example.com
    git config user.name qa
    git config commit.gpgsign false
    if [[ -f "$KOL_ROOT/project.godot" ]]; then
        git -C "$KOL_ROOT" show HEAD:project.godot > project.godot
    else
        write_fixture_project_godot "$master_dir"
    fi
    git add project.godot
    git commit -q -m "master fixture"
)
out="$(KOL_PROJECT_GODOT="$master_dir/project.godot" bash "$CONFIGURE" --port 6551 2>&1)"
rc=$?
if (( rc != 0 )) && printf '%s' "$out" | grep -q "write-target guard"; then
    pass "S7 master-branch write-target guard refuses"
else
    fail "S7 master-branch guard rc=$rc, output: $out"
fi

# --- hook-driven arms: S8/S9 (push-guard sidecar checks), S10 (stop hook) ----
# These exercise KOL-repo hooks (.claude/hooks). Without a KOL worktree they
# are reported ENV-LIMITED — an explicit, tallied non-pass state, never a
# silent skip. See the adjudication doc for the CI tier that owns them.

build_hook_input() {
    # build_hook_input <git-dir> <refspec> — PreToolUse JSON payload.
    python3 - "$1" "$2" <<'PY'
import json, sys
git_dir, refspec = sys.argv[1], sys.argv[2]
cmd = f"git -C {git_dir} push origin {refspec}"
print(json.dumps({"tool_input": {"command": cmd}}))
PY
}

# The guard's host-repo scoping (SEE-1268) keys on PROJECT_ROOT == the push's
# git root. Point PROJECT_ROOT at the fixture repo so the master-push path
# reaches run_sidecar_guard hermetically (no live multica metadata needed).
hook_env_base=(
    MULTICA_AGENT_NAME="Atlas"
    MULTICA_AGENT_ID="fac3e3a1-dcda-498d-8613-e8c2811f3ef5"
)

note "S8/S9: push-guard sidecar invariants"
if (( HOOKS_AVAILABLE )); then
    guard_repo="$TMPROOT/push-guard-repo"
    mkdir -p "$guard_repo"
    (
        cd "$guard_repo"
        git init -q -b shared/SEE-1117
        git config user.email qa@example.com
        git config user.name qa
        git config commit.gpgsign false
        if [[ -f "$KOL_ROOT/project.godot" ]]; then
            git -C "$KOL_ROOT" show HEAD:project.godot > project.godot
        else
            write_fixture_project_godot "$guard_repo"
        fi
        git add project.godot
        git commit -q -m "fixture"
        # Check A fixture: force-add the gitignored sidecar into HEAD — the
        # one way runtime lease state can pollute a push payload.
        mkdir -p .godot
        printf '{"schema_version":2,"state":"active","port":6551,"agent":"Atlas"}\n' > .godot/mcp-lease.json
        git add -f .godot/mcp-lease.json
        git commit -q -m "wip: force-added sidecar lease (should be rejected)"
        git update-ref refs/remotes/origin/master HEAD
        git update-ref refs/remotes/origin/shared/SEE-1117 HEAD
    )

    payload_guard="$(build_hook_input "$guard_repo" "HEAD:refs/heads/master")"
    (
        cd "$guard_repo"
        env "${hook_env_base[@]}" PROJECT_ROOT="$guard_repo" \
            bash "$PUSH_GUARD" <<<"$payload_guard" >/dev/null 2>"$guard_repo/guard-checkA.err"
    )
    rc=$?
    if (( rc == 2 )) && grep -q "sidecar" "$guard_repo/guard-checkA.err"; then
        pass "S8 push-guard Check A rejects HEAD carrying sidecar lease (rc=2)"
    else
        fail "S8 push-guard Check A rc=$rc, stderr: $(cat "$guard_repo/guard-checkA.err")"
    fi

    # Remove the leaked sidecar; Check A must let the push through.
    (
        cd "$guard_repo"
        git rm -q -f --cached .godot/mcp-lease.json
        git commit -q --amend --no-edit --allow-empty
        # Check B fixture: worktree sidecar state=active (untracked, so the
        # push payload is clean) → rc=0 + soft-warn notice.
        printf '{"schema_version":2,"state":"active","port":6551,"agent":"Atlas"}\n' > .godot/mcp-lease.json
    )
    (
        cd "$guard_repo"
        env "${hook_env_base[@]}" PROJECT_ROOT="$guard_repo" \
            bash "$PUSH_GUARD" <<<"$payload_guard" >/dev/null 2>"$guard_repo/guard-checkB.err"
    )
    rc=$?
    if (( rc == 0 )) && grep -q "sidecar" "$guard_repo/guard-checkB.err"; then
        pass "S9 push-guard Check B soft-warns active lease, push allowed (rc=0)"
    else
        fail "S9 push-guard Check B rc=$rc, stderr: $(cat "$guard_repo/guard-checkB.err")"
    fi
else
    limited "S8 push-guard Check A (sidecar leak hard block)"
    limited "S9 push-guard Check B (active lease soft warn)"
fi

note "S10: auto-pr-on-stop releases sidecar on session end"
if (( HOOKS_AVAILABLE )); then
    stop_repo="$TMPROOT/auto-pr-stop"
    mkdir -p "$stop_repo/addons/godot_mcp/launch"
    (
        cd "$stop_repo"
        git init -q -b feat/see-1117-test
        git config user.email qa@example.com
        git config user.name qa
        git config commit.gpgsign false
        if [[ -f "$KOL_ROOT/project.godot" ]]; then
            git -C "$KOL_ROOT" show HEAD:project.godot > project.godot
        else
            write_fixture_project_godot "$stop_repo"
        fi
        git add project.godot
        git commit -q -m "fixture"
    )
    # Seed an ACTIVE lease sidecar, as a crashed agent would leave it.
    mkdir -p "$stop_repo/.godot"
    printf '{"schema_version":2,"state":"active","port":6555,"agent":"Revy","lease_id":"11111111-2222-3333-4444-555555555555"}\n' \
        > "$stop_repo/.godot/mcp-lease.json"
    # Mirror the launch toolchain into the fixture so the hook's single
    # landing-point resolution ($PROJECT_ROOT/addons/godot_mcp/launch) finds
    # restore-godot-original.sh.
    cp "$LAUNCH_DIR"/*.sh "$LAUNCH_DIR"/*.lib.sh "$stop_repo/addons/godot_mcp/launch/" 2>/dev/null || true
    cp "$LAUNCH_DIR"/agent-ports.json "$stop_repo/addons/godot_mcp/launch/" 2>/dev/null || true
    chmod +x "$stop_repo/addons/godot_mcp/launch/"*.sh 2>/dev/null || true

    stop_input='{"stop_hook_active":false}'
    (
        cd "$stop_repo"
        PROJECT_ROOT="$stop_repo" \
        MULTICA_AGENT_NAME="Revy" \
        MULTICA_TASK_ID="" \
        GITHUB_PERSONAL_ACCESS_TOKEN="" \
        GH_TOKEN="" \
        KOL_REAP_DISABLE_PWSH=1 \
            bash "$AUTO_PR_STOP" <<<"$stop_input" >/dev/null 2>"$stop_repo/stop.err" || true
    )
    assert_sidecar "$stop_repo/project.godot" released 6555 "S10 auto-pr-on-stop released sidecar"
else
    limited "S10 auto-pr-on-stop sidecar release"
fi

# --- summary ----------------------------------------------------------------

echo
echo "=== SEE-1117 Phase 1 QA summary (sidecar era, SEE-1291) ==="
echo "  PASS: $PASS_COUNT"
echo "  FAIL: $FAIL_COUNT"
echo "  ENV-LIMITED: $ENV_LIMITED_COUNT (hook-driven arms; need KOL worktree via KOL_ROOT)"
if (( ENV_LIMITED_COUNT > 0 )); then
    echo "  env-limited cases (NOT covered by this run):"
    for c in "${ENV_LIMITED_CASES[@]}"; do echo "    - $c"; done
fi
if (( FAIL_COUNT > 0 )); then
    echo "  failed cases:"
    for c in "${FAILED_CASES[@]}"; do echo "    - $c"; done
    exit 1
fi
exit 0
