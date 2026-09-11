#!/usr/bin/env bash
# SEE-1117 Phase 1 QA — verify configure / restore / verify / push-guard /
# auto-pr-on-stop lifecycle in isolated temp worktrees.
#
# Cases (mirroring Atlas's QA checklist in issue comment 88ba8d21):
#   S1..S5   lease happy path on Atlas port 6551
#   S6       same path on Revy port 6555
#   S7       configure refuses D-drive master target
#   S8, S9   push-guard rejects pinned marker commit; after restore it allows
#   S10      auto-pr-on-stop restores marker unconditionally
#   S11      toolchain-missing fallback in push-guard still blocks port_override=true
#   S12      verify exit 0 when marker section absent
#   S13      configure appends marker when [godot_mcp] section missing
#   S14      configure handles marker block at EOF (no trailing section)
#
# All assertions are grep / exit-code / byte-diff based — no "looks right".
#
# Run from repo root:
#   bash launch/tests/scripts/test_see1117_phase1_marker_lifecycle.sh
#
# Exit 0 on all-pass, non-zero with a printed FAIL list otherwise.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LAUNCH_DIR="$REPO_ROOT/addons/godot_mcp/launch"
HOOKS_DIR="$REPO_ROOT/.claude/hooks"
CONFIGURE="$LAUNCH_DIR/configure-mcp-port.sh"
RESTORE="$LAUNCH_DIR/restore-godot-original.sh"
VERIFY="$LAUNCH_DIR/verify-godot-written-back.sh"
PUSH_GUARD="$HOOKS_DIR/push-guard.sh"
AUTO_PR_STOP="$HOOKS_DIR/auto-pr-on-stop.sh"

PASS_COUNT=0
FAIL_COUNT=0
declare -a FAILED_CASES=()

TMPROOT="$(mktemp -d -t see1117-qa-XXXXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

note()  { printf '[qa] %s\n' "$*"; }
pass()  { PASS_COUNT=$((PASS_COUNT+1)); printf '  [PASS] %s\n' "$*"; }
fail()  { FAIL_COUNT=$((FAIL_COUNT+1)); FAILED_CASES+=("$1"); printf '  [FAIL] %s\n' "$*"; }

# --- fixture helpers --------------------------------------------------------

make_worktree() {
    # Build an isolated git repo with the current project.godot committed, so
    # configure/verify/restore operate on a private copy and we never touch the
    # shared working tree.
    local dir="$1"
    mkdir -p "$dir"
    (
        cd "$dir"
        git init -q -b test-branch
        git config user.email qa@example.com
        git config user.name qa
        git config commit.gpgsign false
        cp "$REPO_ROOT/project.godot" "$dir/project.godot"
        # Start the fixture from the HEAD blob, not the working tree — the
        # working tree may be mid-lease (per-agent pinned) which would poison
        # the "original" baseline.
        git -C "$REPO_ROOT" show HEAD:project.godot > "$dir/project.godot"
        git add project.godot
        git commit -q -m "fixture: project.godot at HEAD"
    )
}

set_marker() {
    # set_marker <file> <enabled> <port> — in-place edit of the two port_*
    # lines inside the marker block. Assumes the marker block exists.
    local file="$1" enabled="$2" port="$3"
    python3 - "$file" "$enabled" "$port" <<'PY'
import re, sys
path, enabled, port = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path, encoding='utf-8').read()
new, n1 = re.subn(r'^port_override_enabled=.*$',
                  f'port_override_enabled={enabled}', src,
                  count=1, flags=re.M)
new, n2 = re.subn(r'^port_override=.*$',
                  f'port_override={port}', new,
                  count=1, flags=re.M)
if n1 != 1 or n2 != 1:
    sys.exit('marker block missing in fixture')
open(path, 'w', encoding='utf-8').write(new)
PY
}

read_marker() {
    # read_marker <file> -> "enabled port"
    python3 - "$1" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
m = re.search(
    r'# \[MCP-AGENT-CONFIG-BEGIN\](.*?)# \[MCP-AGENT-CONFIG-END\]',
    src, re.S)
if not m:
    sys.exit(1)
block = m.group(1)
en = re.search(r'^port_override_enabled=(.*)$', block, re.M)
po = re.search(r'^port_override=(.*)$', block, re.M)
print((en.group(1).strip() if en else '') + ' ' + (po.group(1).strip() if po else ''))
PY
}

assert_marker() {
    # assert_marker <file> <expected_enabled> <expected_port> <case-name>
    local file="$1" want_en="$2" want_port="$3" name="$4"
    local got
    got="$(read_marker "$file")" || { fail "$name: read_marker failed on $file"; return 1; }
    local got_en="${got% *}" got_port="${got##* }"
    if [[ "$got_en" == "$want_en" && "$got_port" == "$want_port" ]]; then
        pass "$name (marker=$got_en/$got_port)"
    else
        fail "$name: marker=$got_en/$got_port, expected $want_en/$want_port"
    fi
}

# --- S1..S5: lease happy path on port 6551 ----------------------------------

test_happy_path() {
    local port="$1" tag="$2"
    note "S-$tag: lease happy path on port $port"
    local dir="$TMPROOT/happy-$port"
    make_worktree "$dir"

    ( cd "$dir" && KOL_PROJECT_GODOT="$dir/project.godot" bash "$CONFIGURE" --port "$port" ) \
        >"$dir/configure.log" 2>&1 \
        || { fail "S-$tag configure"; return; }
    assert_marker "$dir/project.godot" true "$port" "S-$tag.1 configure pinned marker"

    ( cd "$dir" && bash "$VERIFY" --project-godot "$dir/project.godot" ) \
        >"$dir/verify-pinned.log" 2>&1
    local rc=$?
    if (( rc == 1 )); then
        pass "S-$tag.2 verify exit 1 on pinned marker"
    else
        fail "S-$tag.2 verify exit=$rc on pinned marker (want 1)"
    fi

    ( cd "$dir" && bash "$RESTORE" --project-godot "$dir/project.godot" ) \
        >"$dir/restore.log" 2>&1 \
        || { fail "S-$tag.3 restore"; return; }
    assert_marker "$dir/project.godot" false 6550 "S-$tag.3 restore marker"

    ( cd "$dir" && bash "$VERIFY" --project-godot "$dir/project.godot" ) \
        >"$dir/verify-restored.log" 2>&1
    rc=$?
    if (( rc == 0 )); then
        pass "S-$tag.4 verify exit 0 after restore"
    else
        fail "S-$tag.4 verify exit=$rc after restore (want 0)"
    fi

    # S5: byte-identical vs HEAD (the fixture's HEAD, which mirrors the repo's
    # HEAD:project.godot blob).
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

note "S7: master write-target guard rejects D-drive master"
# Synthetic D-drive path — the guard uses string prefix matching, so any path
# beginning with /mnt/d/GodotProjects/king-of-likes must be refused.
fake_d="$TMPROOT/d-drive"
mkdir -p "$fake_d"
cp "$REPO_ROOT/project.godot" "$fake_d/project.godot"
# Simulate the known shared path by overriding KOL_PROJECT_GODOT with a path
# we then pass through the guard. configure-mcp-port.sh's guard matches the
# literal /mnt/d/GodotProjects/king-of-likes prefix; we reproduce that check
# by pointing at a path we symlink under that prefix when /mnt/d is writable,
# else we exercise the master-branch guard path via a master-branch fixture.

# Branch-based check: target checkout on branch master must be refused.
master_dir="$TMPROOT/master-checkout"
mkdir -p "$master_dir"
(
    cd "$master_dir"
    git init -q -b master
    git config user.email qa@example.com
    git config user.name qa
    git config commit.gpgsign false
    git -C "$REPO_ROOT" show HEAD:project.godot > project.godot
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

# Literal-path check: skip when /mnt/d is not writable in this WSL runtime.
if [[ -d /mnt/d ]] && touch /mnt/d/.see1117_qa_canary 2>/dev/null; then
    rm -f /mnt/d/.see1117_qa_canary
    # We cannot safely create /mnt/d/GodotProjects/king-of-likes here (it's the
    # real master checkout). The branch-based check above already covers the
    # guard's semantic; the literal-path arm is a string compare on the same
    # condition. Skip and note.
    note "S7 literal D-drive path test skipped (would touch real master checkout); branch-based arm covers the guard."
else
    note "S7 literal D-drive path test skipped (no /mnt/d access in this runtime)."
fi

# --- S8/S9: push-guard rejects pinned marker; passes after restore ----------

note "S8/S9: push-guard on pinned vs restored marker"
guard_repo="$TMPROOT/push-guard-repo"
mkdir -p "$guard_repo"
(
    cd "$guard_repo"
    git init -q -b shared/SEE-1117
    git config user.email qa@example.com
    git config user.name qa
    git config commit.gpgsign false
    git -C "$REPO_ROOT" show HEAD:project.godot > project.godot
    git add project.godot
    git commit -q -m "fixture: clean marker"
    # Create a fake origin/master ref pointing at HEAD so the push-guard's
    # master-ancestry check (git merge-base --is-ancestor origin/master HEAD)
    # passes without needing a real remote.
    git update-ref refs/remotes/origin/master HEAD
    git update-ref refs/remotes/origin/shared/SEE-1117 HEAD
    # Pin the marker to a per-agent value and commit.
    python3 - <<'PY'
import re
path = 'project.godot'
src = open(path, encoding='utf-8').read()
src = re.sub(r'^port_override_enabled=.*$', 'port_override_enabled=true', src, count=1, flags=re.M)
src = re.sub(r'^port_override=.*$', 'port_override=6551', src, count=1, flags=re.M)
open(path, 'w', encoding='utf-8').write(src)
PY
    git add project.godot
    git commit -q -m "wip: pin marker (should be rejected)"
)

# Build the JSON payload push-guard reads from stdin.
build_hook_input() {
    # build_hook_input <git-dir> <refspec>
    python3 - "$1" "$2" <<'PY'
import json, sys
git_dir, refspec = sys.argv[1], sys.argv[2]
cmd = f"git -C {git_dir} push origin {refspec}"
print(json.dumps({"tool_input": {"command": cmd}}))
PY
}

# Trigger the marker guard via the master-push path: Atlas/Archi are allowed
# to push to master, but the port-override guard still runs against
# HEAD:project.godot. We set MULTICA_AGENT_NAME=Atlas and push refspec
# HEAD:refs/heads/master. This exercises the same verify.sh code path as the
# shared-branch Check 6, without needing WORKING_BRANCH metadata (which would
# require a live `multica` CLI and MULTICA_TASK_ID).
hook_env=(
    PROJECT_ROOT="$REPO_ROOT"
    MULTICA_AGENT_NAME="Atlas"
    MULTICA_AGENT_ID="fac3e3a1-dcda-498d-8613-e8c2811f3ef5"
)

payload_pinned="$(build_hook_input "$guard_repo" "HEAD:refs/heads/master")"
(
    cd "$guard_repo"
    env "${hook_env[@]}" bash "$PUSH_GUARD" <<<"$payload_pinned" >/dev/null 2>"$guard_repo/guard-pinned.err"
)
rc=$?
if (( rc == 2 )) && grep -q "marker" "$guard_repo/guard-pinned.err"; then
    pass "S8 push-guard rejects commit with pinned marker (rc=2)"
else
    fail "S8 push-guard rc=$rc, stderr: $(cat "$guard_repo/guard-pinned.err")"
fi

# Restore + amend -> guard should allow the push through. The amend may be
# empty when restore brings the tree back to the pre-pin state (because we
# never edited anything else), so use --allow-empty to keep the commit.
(
    cd "$guard_repo"
    KOL_PROJECT_GODOT="$PWD/project.godot" bash "$RESTORE" --project-godot "$PWD/project.godot" >/dev/null 2>&1
    git add project.godot
    git commit -q --amend --no-edit --allow-empty
)

(
    cd "$guard_repo"
    env "${hook_env[@]}" bash "$PUSH_GUARD" <<<"$payload_pinned" >/dev/null 2>"$guard_repo/guard-restored.err"
)
rc=$?
if (( rc == 0 )); then
    pass "S9 push-guard allows push after restore (rc=0)"
else
    fail "S9 push-guard rc=$rc after restore, stderr: $(cat "$guard_repo/guard-restored.err")"
fi

# --- S10: auto-pr-on-stop restores marker on session end --------------------

note "S10: auto-pr-on-stop restores marker unconditionally"
stop_repo="$TMPROOT/auto-pr-stop"
mkdir -p "$stop_repo/.dev/godot-mcp/launch"
(
    cd "$stop_repo"
    git init -q -b feat/see-1117-test
    git config user.email qa@example.com
    git config user.name qa
    git config commit.gpgsign false
    git -C "$REPO_ROOT" show HEAD:project.godot > project.godot
    git add project.godot
    git commit -q -m "fixture"
    # Pin marker.
    python3 - <<'PY'
import re
path = 'project.godot'
src = open(path, encoding='utf-8').read()
src = re.sub(r'^port_override_enabled=.*$', 'port_override_enabled=true', src, count=1, flags=re.M)
src = re.sub(r'^port_override=.*$', 'port_override=6555', src, count=1, flags=re.M)
open(path, 'w', encoding='utf-8').write(src)
PY
    # Leave the pinned marker in the working tree but unstaged — the hook is
    # expected to restore it BEFORE the auto-commit step.
)
# The hook cd's into $PROJECT_ROOT when it has .git, and resolves
# restore-godot-original.sh as $PROJECT_ROOT/.dev/godot-mcp/launch/... — so
# mirror the launch toolchain into the fixture repo (copy, not symlink, so
# restore/verify see PROJECT_ROOT = fixture).
cp "$LAUNCH_DIR"/*.sh "$LAUNCH_DIR"/*.lib.sh "$stop_repo/.dev/godot-mcp/launch/" 2>/dev/null || true
cp "$LAUNCH_DIR"/agent-ports.json "$stop_repo/.dev/godot-mcp/launch/" 2>/dev/null || true
chmod +x "$stop_repo/.dev/godot-mcp/launch/"*.sh

# Stop hook payload: stop_hook_active=false so it proceeds.
stop_input='{"stop_hook_active":false}'
(
    cd "$stop_repo"
    PROJECT_ROOT="$stop_repo" \
    MULTICA_AGENT_NAME="Revy" \
    MULTICA_TASK_ID="" \
    GITHUB_PERSONAL_ACCESS_TOKEN="" \
    GH_TOKEN="" \
        bash "$AUTO_PR_STOP" <<<"$stop_input" >/dev/null 2>"$stop_repo/stop.err" || true
)
# After hook, marker in working tree must be false/6550.
assert_marker "$stop_repo/project.godot" false 6550 "S10 auto-pr-on-stop restored marker"

# --- S11: toolchain-missing fallback in push-guard --------------------------

note "S11: push-guard fallback when launch toolchain is missing"
# Reuse the push-guard-repo, pin the marker again, but this time point
# PROJECT_ROOT at a directory WITHOUT .dev/godot-mcp/launch/ so the guard
# falls back to its legacy grep.
(
    cd "$guard_repo"
    python3 - <<'PY'
import re
path = 'project.godot'
src = open(path, encoding='utf-8').read()
src = re.sub(r'^port_override_enabled=.*$', 'port_override_enabled=true', src, count=1, flags=re.M)
src = re.sub(r'^port_override=.*$', 'port_override=6551', src, count=1, flags=re.M)
open(path, 'w', encoding='utf-8').write(src)
PY
    git add project.godot
    git commit -q --amend --no-edit
)

empty_root="$TMPROOT/empty-root"
mkdir -p "$empty_root"
(
    cd "$guard_repo"
    PROJECT_ROOT="$empty_root" \
    MULTICA_AGENT_NAME="Atlas" \
    MULTICA_AGENT_ID="fac3e3a1-dcda-498d-8613-e8c2811f3ef5" \
        bash "$PUSH_GUARD" <<<"$payload_pinned" >/dev/null 2>"$guard_repo/guard-fallback.err"
)
rc=$?
if (( rc == 2 )) && grep -q "port_override_enabled=true" "$guard_repo/guard-fallback.err"; then
    pass "S11 fallback grep still rejects port_override_enabled=true"
else
    fail "S11 fallback rc=$rc, stderr: $(cat "$guard_repo/guard-fallback.err")"
fi

# --- S11b: behavior-divergence — verify path is authoritative, not grep -----
# SEE-1117 缺陷 1 修复回归基线。构造 marker 段已恢复（false/6550），但 marker
# 段外的 [godot_mcp] 区域仍留一个 stray `port_override_enabled=true` 的
# project.godot。verify.sh 只读 marker 段，会 exit 0；legacy fallback grep 扫
# 全文件，会 exit 2。push-guard 若走 verify 路径则 rc=0（allow），走 fallback
# 则 rc=2（block）。rc=0 即证明 verify 是权威判定，fallback 未触发。

note "S11b: push-guard with restored marker + stray port_override_enabled=true"
div_repo="$TMPROOT/divergence-repo"
mkdir -p "$div_repo"
(
    cd "$div_repo"
    git init -q -b shared/SEE-1117
    git config user.email qa@example.com
    git config user.name qa
    git config commit.gpgsign false
    git -C "$REPO_ROOT" show HEAD:project.godot > project.godot
    # Marker stays at original (false/6550), but inject a stray
    # port_override_enabled=true OUTSIDE the marker block — insert it right
    # after the [godot_mcp] section header.
    python3 - <<'PY'
path = 'project.godot'
src = open(path, encoding='utf-8').read()
marker_begin = '# [MCP-AGENT-CONFIG-BEGIN]'
idx = src.index(marker_begin)
head, tail = src[:idx], src[idx:]
# Insert stray override before the marker block, still inside [godot_mcp].
head = head.rstrip('\n') + '\nport_override_enabled=true\nport_override=9999\n\n'
open(path, 'w', encoding='utf-8').write(head + tail)
PY
    git add project.godot
    git commit -q -m "fixture: restored marker + stray override outside marker"
    git update-ref refs/remotes/origin/master HEAD
    git update-ref refs/remotes/origin/shared/SEE-1117 HEAD
)

payload_div="$(build_hook_input "$div_repo" "HEAD:refs/heads/master")"
(
    cd "$div_repo"
    env "${hook_env[@]}" bash "$PUSH_GUARD" <<<"$payload_div" >/dev/null 2>"$div_repo/guard-div.err"
)
rc=$?
if (( rc == 0 )); then
    pass "S11b push-guard rc=0 on stray-override-outside-marker (verify path authoritative)"
else
    fail "S11b push-guard rc=$rc — verify path NOT authoritative (fallback grep fired?). stderr: $(cat "$div_repo/guard-div.err")"
fi

# Sanity inverse: the same fixture repo, but with PROJECT_ROOT pointed at the
# empty toolchain root, MUST trip the fallback grep (rc=2). This proves the
# divergence is real: rc=0 above is verify's doing, rc=2 here is grep's.
(
    cd "$div_repo"
    PROJECT_ROOT="$empty_root" \
    MULTICA_AGENT_NAME="Atlas" \
    MULTICA_AGENT_ID="fac3e3a1-dcda-498d-8613-e8c2811f3ef5" \
        bash "$PUSH_GUARD" <<<"$payload_div" >/dev/null 2>"$div_repo/guard-div-fallback.err"
)
rc=$?
if (( rc == 2 )); then
    pass "S11b-inverse fallback grep correctly fires on stray override (rc=2)"
else
    fail "S11b-inverse fallback rc=$rc (want 2) — divergence fixture broken"
fi

# --- S12: verify exit 0 when marker section absent --------------------------

note "S12: verify exit 0 when marker section absent"
no_marker="$TMPROOT/no-marker"
mkdir -p "$no_marker"
# Build a project.godot without the marker block (strip it).
python3 - "$REPO_ROOT/project.godot" "$no_marker/project.godot" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
stripped = re.sub(
    r'\n?# \[MCP-AGENT-CONFIG-BEGIN\].*?# \[MCP-AGENT-CONFIG-END\]\n?',
    '\n', src, flags=re.S)
open(sys.argv[2], 'w', encoding='utf-8').write(stripped)
PY
bash "$VERIFY" --project-godot "$no_marker/project.godot" >"$no_marker/verify.log" 2>&1
rc=$?
if (( rc == 0 )); then
    pass "S12 verify exit 0 on missing marker"
else
    fail "S12 verify exit=$rc on missing marker (want 0): $(cat "$no_marker/verify.log")"
fi

# --- S13: configure appends marker when [godot_mcp] section missing ---------

note "S13: configure appends marker + [godot_mcp] when section absent"
no_section="$TMPROOT/no-section"
mkdir -p "$no_section"
(
    cd "$no_section"
    git init -q -b test-branch
    git config user.email qa@example.com
    git config user.name qa
    git config commit.gpgsign false
)
python3 - "$REPO_ROOT/project.godot" "$no_section/project.godot" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
# Strip the marker block AND the [godot_mcp] section header + its keys.
src = re.sub(
    r'\n?# \[MCP-AGENT-CONFIG-BEGIN\].*?# \[MCP-AGENT-CONFIG-END\]\n?',
    '\n', src, flags=re.S)
# Drop the whole [godot_mcp] section (header + keys until next [section]).
src = re.sub(
    r'\[godot_mcp\]\n(?:[^\[]*\n)*?(?=\[|\Z)',
    '', src)
open(sys.argv[2], 'w', encoding='utf-8').write(src)
PY
(
    cd "$no_section"
    git add project.godot
    git commit -q -m "no godot_mcp section"
    KOL_PROJECT_GODOT="$PWD/project.godot" bash "$CONFIGURE" --port 6551 >/dev/null 2>&1
)
rc=$?
if (( rc != 0 )); then
    fail "S13 configure rc=$rc on missing [godot_mcp]"
else
    if grep -q '^\[godot_mcp\]$' "$no_section/project.godot" \
        && grep -qF '# [MCP-AGENT-CONFIG-BEGIN]' "$no_section/project.godot"; then
        assert_marker "$no_section/project.godot" true 6551 "S13 configure appended marker + section"
    else
        fail "S13 configure did not append [godot_mcp]/marker"
    fi
fi

# --- S14: marker block at EOF -----------------------------------------------

note "S14: configure handles marker block at EOF"
eof_repo="$TMPROOT/marker-at-eof"
mkdir -p "$eof_repo"
(
    cd "$eof_repo"
    git init -q -b test-branch
    git config user.email qa@example.com
    git config user.name qa
    git config commit.gpgsign false
)
python3 - "$REPO_ROOT/project.godot" "$eof_repo/project.godot" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
# Extract the marker block.
m = re.search(
    r'# \[MCP-AGENT-CONFIG-BEGIN\].*?# \[MCP-AGENT-CONFIG-END\]\n?',
    src, re.S)
marker = m.group(0)
# Remove marker from its original spot, append it at the very end of the file
# with no trailing newline section after it.
src = src.replace(marker, '')
if not src.endswith('\n'):
    src += '\n'
src += '\n' + marker
open(sys.argv[2], 'w', encoding='utf-8').write(src)
PY
(
    cd "$eof_repo"
    git add project.godot
    git commit -q -m "marker at EOF"
    KOL_PROJECT_GODOT="$PWD/project.godot" bash "$CONFIGURE" --port 6551 >/dev/null 2>&1
)
rc=$?
if (( rc != 0 )); then
    fail "S14 configure rc=$rc on EOF marker"
else
    assert_marker "$eof_repo/project.godot" true 6551 "S14 configure pinned marker at EOF"
    # Restore must also work on EOF marker.
    (
        cd "$eof_repo"
        KOL_PROJECT_GODOT="$PWD/project.godot" bash "$RESTORE" --project-godot "$PWD/project.godot" >/dev/null 2>&1
    )
    assert_marker "$eof_repo/project.godot" false 6550 "S14 restore on EOF marker"
fi

# --- summary ----------------------------------------------------------------

echo
echo "=== SEE-1117 Phase 1 QA summary ==="
echo "  PASS: $PASS_COUNT"
echo "  FAIL: $FAIL_COUNT"
if (( FAIL_COUNT > 0 )); then
    echo "  failed cases:"
    for c in "${FAILED_CASES[@]}"; do echo "    - $c"; done
    exit 1
fi
exit 0
