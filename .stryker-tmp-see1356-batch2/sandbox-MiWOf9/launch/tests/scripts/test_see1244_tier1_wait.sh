#!/usr/bin/env bash
# SEE-1244 改动 A/B (decision 01a08059) — launcher Tier-1 seed-* compatibility
# + bounded wait-retry tests.
#
# Cases:
#   T1  seed-* alias layout (marker encodes the alias path): Tier 1 (a2)
#       direct decode HITS the correct worktree
#   T2  legacy UUID layout: zero regression (unchanged first candidate)
#   T3  cross-agent gate: managed_env with a foreign agent_id rejects in the
#       alias form (authority unchanged)
#   T4  late worktree landing (checkout race): launcher WAITs (WORKTREE_WAIT
#       log stream) and succeeds once the checkout lands — connection does
#       not die
#   T5  wait timeout: die carries waited seconds + retries + red-line text
#   T6  (a)-exact match in the alias form
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1244_tier1_wait.sh

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../" && pwd)"
LAUNCHER="$REPO/launch/godot-mcp-launcher.sh"
WSID="ws-tier1-test"
AGENT="agent-tier1-test"

PASS=0; FAIL=0
ok() { if [[ "$2" == "1" ]]; then PASS=$((PASS+1)); echo "  [PASS] $1"; else FAIL=$((FAIL+1)); echo "  [FAIL] $1${3:+ — $3}"; fi; }
section() { echo; echo "== $1 =="; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Build a runtime slot: <home>/multica_workspaces/<container>/<hash>/workdir/KingOfLikes-Godot
make_slot() {
    local home="$1" container="$2" hash="$3" agent_id="$4"
    local hdir="$home/multica_workspaces/$container/$hash"
    mkdir -p "$hdir/workdir/KingOfLikes-Godot/launch"
    printf '{"workspace_id": "%s", "agent_id": "%s"}' "$WSID" "$agent_id" > "$hdir/.managed_env.json"
    printf '%s\n' "$hdir/workdir/KingOfLikes-Godot"
}

# Marker encoding mirroring the hook: leading / stripped, '/'->'_'
marker_for() { printf '.cc-aligned-_%s' "${1#/}" | tr '/' '_'; }

# Run Tier-1 resolution in isolation by extracting the function block.
resolve_in_env() {
    local home="$1" tmpdir="$2"
    # Extract marker→resolve function block from the launcher (single source
    # of truth; no duplicated logic in the test).
    python3 - "$REPO/launch/godot-mcp-launcher.sh" "$home" "$tmpdir" "$WSID" "$AGENT" <<'PYEOF'
import subprocess, sys
launcher, home, tmpdir, wsid, agent = sys.argv[1:6]
repo = launcher.rsplit('/launch/', 1)[0]
src = open(launcher).read()
start = src.find('_encode_workdir_marker()')
end = src.find('_resolve_via_runtime_registry()')
end = src.find('\n}\n', src.find('\n}\n', end) + 3) + 3
block = src[start:end]
test = f'''
export HOME={home}
export MULTICA_WORKSPACE_ID={wsid}
export MULTICA_AGENT_ID={agent}
export TMPDIR={tmpdir}
# SEE-1273 T3: the extracted block reads GODOT_MCP_* params (env.sh layer
# since T2) — source it so the isolated execution matches launcher semantics.
. {repo}/launch/env.sh
{block}
out="$(_resolve_via_runtime_registry)" && echo "HIT $out" || echo MISS
'''
r = subprocess.run(['bash', '-c', test], capture_output=True, text=True)
print(r.stdout.strip().split('\n')[-1] if r.stdout else 'NOOUT')
PYEOF
}

section "T1: seed-* alias layout — (a2) marker decode hits"
{
    H="$TMP/t1-home"; TD="$TMP/t1-tmp"; mkdir -p "$H" "$TD"
    WT="$(make_slot "$H" "seed-tier1test12" "see-case1-aaaa" "$AGENT")"
    MKR="$(marker_for "$WT")"; printf x > "$TD/$MKR"
    R="$(resolve_in_env "$H" "$TD")"
    ok "T1 alias decode hits correct worktree" "$([[ "$R" == "HIT $WT" ]] && echo 1 || echo 0)" "$R"
}

section "T2: legacy UUID layout — no regression"
{
    H="$TMP/t2-home"; TD="$TMP/t2-tmp"; mkdir -p "$H" "$TD"
    WT="$(make_slot "$H" "$WSID" "abcd1234" "$AGENT")"
    MKR="$(marker_for "$WT")"; printf x > "$TD/$MKR"
    R="$(resolve_in_env "$H" "$TD")"
    ok "T2 legacy UUID layout still hits" "$([[ "$R" == "HIT $WT" ]] && echo 1 || echo 0)" "$R"
}

section "T3: cross-agent gate in alias form"
{
    H="$TMP/t3-home"; TD="$TMP/t3-tmp"; mkdir -p "$H" "$TD"
    WT="$(make_slot "$H" "seed-tier1test12" "see-case3-cccc" "other-agent-0000")"
    MKR="$(marker_for "$WT")"; printf x > "$TD/$MKR"
    R="$(resolve_in_env "$H" "$TD")"
    ok "T3 foreign-agent slot rejected" "$([[ "$R" == "MISS" ]] && echo 1 || echo 0)" "$R"
}

section "T4: late worktree landing — wait succeeds, no connection death"
{
    # launcher runs against an empty home; the slot + marker land 3s later.
    # cwd is hostile ($HOME — a real fresh claude spawn has no worktree cwd),
    # so Tier 2 cannot rescue: only the Tier 1 wait can resolve.
    H="$TMP/t4-home"; TD="$TMP/t4-tmp"; mkdir -p "$H" "$TD"
    # The worktree is NOT pre-created: the freshest-mtime fallback requires
    # worktree/.dev/... on disk, so a pre-created worktree would resolve
    # instantly and skip the wait (defeating the scenario).
    HDIR="$H/multica_workspaces/seed-tier1test12/see-case4-dddd"
    mkdir -p "$HDIR"
    printf '{"workspace_id": "%s", "agent_id": "%s"}' "$WSID" "$AGENT" > "$HDIR/.managed_env.json"
    WT="$HDIR/workdir/KingOfLikes-Godot"
    MKR="$(marker_for "$WT")"
    ( sleep 3; mkdir -p "$WT/launch"; printf x > "$TD/$MKR" ) &   # 竞态窗口语义（CLAUDE.md 边界）：延迟落 marker 即场景本身（tier1 must WAIT），延迟时长=被测量
    BG=$!
    OUT="$TMP/t4.out"
    ( cd "$H" && env HOME="$H" MULTICA_WORKSPACE_ID="$WSID" MULTICA_AGENT_ID="$AGENT" TMPDIR="$TD" \
        KOL_WORKTREE_WAIT_S=20 timeout 40 bash "$LAUNCHER" Bachi </dev/null >"$OUT" 2>&1 )
    RC=$?
    wait $BG 2>/dev/null || true
    ok "T4 launcher survives the wait window (exit 0 = resolved)" "$([[ $RC -eq 0 ]] && echo 1 || echo 0)" "rc=$RC; $(tail -2 "$OUT" | tr '\n' ' ')"
    ok "T4 WORKTREE_WAIT log stream present" "$(grep -qc 'stage=WORKTREE_WAIT' "$OUT" && echo 1 || echo 0)"
    ok "T4 WORKTREE_READY logged with waited_s" "$(grep -q 'stage=WORKTREE_READY.*waited_s=' "$OUT" && echo 1 || echo 0)"
}

section "T5: wait timeout — die carries waited seconds + red-line text"
{
    H="$TMP/t5-home"; TD="$TMP/t5-tmp"; mkdir -p "$H" "$TD"   # nothing ever lands
    OUT="$TMP/t5.out"
    ( cd "$H" && env HOME="$H" MULTICA_WORKSPACE_ID="$WSID" MULTICA_AGENT_ID="$AGENT" TMPDIR="$TD" \
        KOL_WORKTREE_WAIT_S=4 timeout 30 bash "$LAUNCHER" Bachi </dev/null >"$OUT" 2>&1 )
    RC=$?
    ok "T5 launcher dies after timeout (nonzero exit)" "$([[ $RC -ne 0 ]] && echo 1 || echo 0)" "rc=$RC"
    ok "T5 die message carries waited seconds + retries" "$(grep -q 'after waiting 4s' "$OUT" && grep -q 'retries' "$OUT" && echo 1 || echo 0)"
    ok "T5 red line preserved (no shared-master fallback)" "$(grep -q 'Refusing to fall back to the shared master' "$OUT" && echo 1 || echo 0)"
    ok "T5 WORKTREE_WAIT log stream present" "$(grep -qc 'stage=WORKTREE_WAIT' "$OUT" && echo 1 || echo 0)"
}

section "T6: (a) exact-match in the alias form"
{
    H="$TMP/t6-home"; TD="$TMP/t6-tmp"; mkdir -p "$H" "$TD"
    # Two same-agent slots; only one matches the marker exactly.
    WT_A="$(make_slot "$H" "seed-tier1test12" "see-case6-aaaa" "$AGENT")"
    WT_B="$(make_slot "$H" "seed-tier1test12" "see-case6-bbbb" "$AGENT")"
    MKR="$(marker_for "$WT_B")"; printf x > "$TD/$MKR"
    R="$(resolve_in_env "$H" "$TD")"
    ok "T6 exact marker match picks WT_B (not the other same-agent slot)" "$([[ "$R" == "HIT $WT_B" ]] && echo 1 || echo 0)" "$R"
}

echo
echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
if [[ $FAIL -gt 0 ]]; then exit 1; fi
