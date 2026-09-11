#!/usr/bin/env bash
# Smoke test for SEE-1129: _resolve_via_runtime_registry must pin THIS task's
# workdir even when two runtimes share the same agent_id.
#
# Path constraint: the marker encoding replaces '/' with '_' LOSSILY, so the
# fake HOME and paths used here must NOT contain any '_' — otherwise encode
# and decode would diverge. We use /home/t<digits>/ style paths (plain).

set -u

# Resolve the launcher path against THIS script's location (four levels up:
# launch/tests/scripts/see1129/ -> fork repo root), so the test is cwd-independent.
# The script overrides HOME mid-run; resolving here avoids any dependency on $HOME.
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_DIR/../../../.." && pwd)"
LAUNCHER="${REPO_ROOT}/launch/godot-mcp-launcher.sh"   # SEE-1273 T5-F: 单落点（旧 .dev/godot-mcp/launch 已退役）
AGENT_ID="a5c250e8-7257-466e-b45a-03f995c7206c"
OTHER_AGENT="809951ab-c70c-48c3-b0d6-7b16b49e1ce3"
WSID="11111111-2222-3333-4444-555555555555"

PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "ok   - $*"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL - $*"; }

FUNCS="$(awk '/^_is_shared_master\(\)/{flag=1} flag{print} /^# --- Parse CLI/{exit}' "$LAUNCHER")"   # SEE-1273 T5-F: 起点前移含 _is_shared_master/_has_launch_toolchain（_resolve 依赖）
[[ -n "$FUNCS" ]] || { echo "could not extract function block" >&2; exit 2; }

# Each scenario gets a fresh HOME-like tree under a base WITHOUT underscores.
# Use a per-run suffix to avoid colliding with other runs.
SUF="$(date +%s%N)"
BASE="${HOME}/t${SUF}"
mkdir -p "$BASE"

# make_runtime <hash> <agent_id|-> <issue_id> <with_launch_dir 0|1> <mtime_epoch>
make_runtime() {
    local hash="$1" agent="$2" issue="$3" with_launch="$4" mtime="$5"
    local rt="$BASE/multica_workspaces/$WSID/$hash"
    mkdir -p "$rt"
    [[ "$with_launch" == "1" ]] && mkdir -p "$rt/workdir/KingOfLikes-Godot/.dev/godot-mcp/launch"
    if [[ "$agent" != "-" ]]; then
        cat >"$rt/.managed_env.json" <<EOF
{"managed_by":"multica-daemon-managed-env","workspace_id":"$WSID","issue_id":"$issue","agent_id":"$agent"}
EOF
        touch -d "@$mtime" "$rt/.managed_env.json"
    fi
}

# Encode a path the same way the launcher's _encode_workdir_marker does:
# strip leading /, replace remaining / with _, and prefix with a literal _
# (that leading _ is part of the marker filename scheme).
enc() { local p="$1"; p="${p#/}"; p="${p////_}"; printf '_%s' "$p"; }

# run_resolver <fake_tmpdir>   (HOME is fixed to $BASE)
# Write the function block + call to a temp script, then bash it — passing
# the block via `bash -c` hits quoting issues on the literal apostrophes
# inside the launcher comments.
RESOLVER_SCRIPT="$BASE/.resolver.sh"
{
    printf '%s\n' "$FUNCS"
    printf '_resolve_via_runtime_registry\n'
} > "$RESOLVER_SCRIPT"

run_resolver() {
    HOME="$BASE" \
    TMPDIR="$1" \
    MULTICA_WORKSPACE_ID="$WSID" \
    MULTICA_AGENT_ID="$AGENT_ID" \
        bash -c ". ${REPO_ROOT}/launch/env.sh; . '$RESOLVER_SCRIPT'"   # SEE-1273 T5-F: env.sh 提供 GODOT_MCP_WORKSPACES_BASE
}

# ---------- S1: marker + managed_env both present → (a) exact match ----------
S1_TMP="$BASE/s1tmp"; mkdir -p "$S1_TMP"
make_runtime "aaaa0001" "$AGENT_ID" "issue-old" 1 100
make_runtime "bbbb0002" "$AGENT_ID" "issue-cur" 1 200
touch "$S1_TMP/.cc-aligned-$(enc "$BASE/multica_workspaces/$WSID/bbbb0002/workdir/KingOfLikes-Godot")"
got="$(run_resolver "$S1_TMP")"
want="$BASE/multica_workspaces/$WSID/bbbb0002/workdir/KingOfLikes-Godot"
[[ "$got" == "$want" ]] && ok "S1 (a) exact match" || bad "S1: got=[$got] want=[$want]"
rm -rf "$BASE/multica_workspaces" "$S1_TMP"

# ---------- S2: marker present, managed_env MISSING for current hash ----------
S2_TMP="$BASE/s2tmp"; mkdir -p "$S2_TMP"
make_runtime "aaaa0001" "$AGENT_ID" "issue-old" 1 100
mkdir -p "$BASE/multica_workspaces/$WSID/cccc0003/workdir/KingOfLikes-Godot/.dev/godot-mcp/launch"
touch "$S2_TMP/.cc-aligned-$(enc "$BASE/multica_workspaces/$WSID/cccc0003/workdir/KingOfLikes-Godot")"
got="$(run_resolver "$S2_TMP")"
want="$BASE/multica_workspaces/$WSID/cccc0003/workdir/KingOfLikes-Godot"
[[ "$got" == "$want" ]] && ok "S2 (a2) decode with missing managed_env" || bad "S2: got=[$got] want=[$want]"
rm -rf "$BASE/multica_workspaces" "$S2_TMP"

# ---------- S3: marker present, worktree checkout in flight (B1 contract) ----
S3_TMP="$BASE/s3tmp"; mkdir -p "$S3_TMP"
make_runtime "aaaa0001" "$AGENT_ID" "issue-old" 1 100
mkdir -p "$BASE/multica_workspaces/$WSID/dddd0004"
cat >"$BASE/multica_workspaces/$WSID/dddd0004/.managed_env.json" <<EOF
{"managed_by":"multica-daemon-managed-env","workspace_id":"$WSID","issue_id":"issue-cur","agent_id":"$AGENT_ID"}
EOF
touch "$S3_TMP/.cc-aligned-$(enc "$BASE/multica_workspaces/$WSID/dddd0004/workdir/KingOfLikes-Godot")"
got="$(run_resolver "$S3_TMP")"
want="$BASE/multica_workspaces/$WSID/dddd0004/workdir/KingOfLikes-Godot"
[[ "$got" == "$want" ]] && ok "S3 (a2) B1 lazy-load, worktree not yet on disk" || bad "S3: got=[$got] want=[$want]"
rm -rf "$BASE/multica_workspaces" "$S3_TMP"

# ---------- S4: no marker → (b) freshest-mtime fallback (unchanged) ----------
S4_TMP="$BASE/s4tmp"; mkdir -p "$S4_TMP"
make_runtime "aaaa0001" "$AGENT_ID" "issue-old" 1 100
make_runtime "bbbb0002" "$AGENT_ID" "issue-new" 1 200
got="$(run_resolver "$S4_TMP")"
want="$BASE/multica_workspaces/$WSID/bbbb0002/workdir/KingOfLikes-Godot"
[[ "$got" == "$want" ]] && ok "S4 (b) freshest-mtime fallback" || bad "S4: got=[$got] want=[$want]"
rm -rf "$BASE/multica_workspaces" "$S4_TMP"

# ---------- S5: marker for OTHER agent's runtime → must not match ------------
S5_TMP="$BASE/s5tmp"; mkdir -p "$S5_TMP"
make_runtime "aaaa0001" "$AGENT_ID"    "issue-ours"   1 100
make_runtime "eeee0005" "$OTHER_AGENT" "issue-theirs" 1 200
touch "$S5_TMP/.cc-aligned-$(enc "$BASE/multica_workspaces/$WSID/eeee0005/workdir/KingOfLikes-Godot")"
got="$(run_resolver "$S5_TMP")"
want="$BASE/multica_workspaces/$WSID/aaaa0001/workdir/KingOfLikes-Godot"
[[ "$got" == "$want" ]] && ok "S5 cross-agent marker rejected, fall back to our freshest" || bad "S5: got=[$got] want=[$want]"
rm -rf "$BASE/multica_workspaces" "$S5_TMP"

# ---------- S6: real-world regression — 41115b3c vs a26701db -----------------
S6_TMP="$BASE/s6tmp"; mkdir -p "$S6_TMP"
make_runtime "a26701db" "$AGENT_ID" "issue-other" 1 1786431402
make_runtime "41115b3c" "$AGENT_ID" "issue-self"  1 1786436494
touch "$S6_TMP/.cc-aligned-$(enc "$BASE/multica_workspaces/$WSID/41115b3c/workdir/KingOfLikes-Godot")"
got="$(run_resolver "$S6_TMP")"
want="$BASE/multica_workspaces/$WSID/41115b3c/workdir/KingOfLikes-Godot"
[[ "$got" == "$want" ]] && ok "S6 marker pins current task even when other runtime is fresher" || bad "S6: got=[$got] want=[$want]"
rm -rf "$BASE/multica_workspaces" "$S6_TMP"

# ---------- S7: Revy's actual failure scenario ------------------------------
# Two runtimes for the SAME agent_id (Revy: cf986876 old + 6519f8e8 new).
# TMPDIR carries ONLY the cf986876 marker (daemon still provisioning the
# 6519f8e8 hash dir) — the launcher must still pick cf986876 for THIS
# session, never fall back to (b) and land on a different runtime.
S7_TMP="$BASE/s7tmp"; mkdir -p "$S7_TMP"
make_runtime "cf986876" "$AGENT_ID" "issue-old" 1 1786415176
# Note: 6519f8e8 is NOT created — simulating daemon still provisioning.
touch "$S7_TMP/.cc-aligned-$(enc "$BASE/multica_workspaces/$WSID/cf986876/workdir/KingOfLikes-Godot")"
got="$(run_resolver "$S7_TMP")"
want="$BASE/multica_workspaces/$WSID/cf986876/workdir/KingOfLikes-Godot"
[[ "$got" == "$want" ]] && ok "S7 same-agent multi-runtime: TMPDIR marker wins even when hash dir absent for other runtime" || bad "S7: got=[$got] want=[$want]"
rm -rf "$BASE/multica_workspaces" "$S7_TMP"

# ---------- S8: another-agent stale marker must be rejected -----------------
# TMPDIR carries a marker for ANOTHER agent's runtime, even though that
# agent's hash dir exists. Without the agent_id cross-check the marker
# would be trusted and we would misroute to the wrong runtime.
S8_TMP="$BASE/s8tmp"; mkdir -p "$S8_TMP"
make_runtime "aaaa0001" "$AGENT_ID"    "issue-ours"   1 100
make_runtime "b2b2b2b2" "$OTHER_AGENT" "issue-theirs" 0 200
touch "$S8_TMP/.cc-aligned-$(enc "$BASE/multica_workspaces/$WSID/b2b2b2b2/workdir/KingOfLikes-Godot")"
got="$(run_resolver "$S8_TMP")"
want="$BASE/multica_workspaces/$WSID/aaaa0001/workdir/KingOfLikes-Godot"
[[ "$got" == "$want" ]] && ok "S8 stale cross-agent marker rejected, falls back to our freshest" || bad "S8: got=[$got] want=[$want]"
rm -rf "$BASE/multica_workspaces" "$S8_TMP"

# ---------- Cleanup + summary ------------------------------------------------
rm -rf "$BASE"

echo
echo "pass=$PASS fail=$FAIL"
[[ "$FAIL" -eq 0 ]]
