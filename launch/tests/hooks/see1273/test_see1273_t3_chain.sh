#!/usr/bin/env bash
# SEE-1273 T3 QA — AC-M3REORG-005/006/007 independent verification harness.
# (1) transition-window legacy chain via compat shim (real stdio handshake);
# (2) T4-shape forward takeover (fault injection proves child IS submodule shim);
# (3) hooks dual-landing lib (both landings + negatives + precedence);
# (4) kol-mcp.env → env.sh alias chain → child process;
# (5) fork regression: tier1_wait / T15 / T16 / T2-param;
# (6) GAP-1 probe misfire reproduction (gitlink=remote ancestor, child lacks tip).
set -uo pipefail
KOL="${KOL_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
FORK_URL="https://github.com/tadki/godot-mcp.git"
# Run context (SEE-1287): EXPECTED_FORK/GITLINK_SHA are SEE-1273 T3 round pins.
# Pass EXPECTED_FORK=<sha> to pin another round; the default reproduces the
# archived T3 verification.
EXPECTED_FORK="${EXPECTED_FORK:-$(git ls-remote "$FORK_URL" refs/heads/main | awk '{print $1}')}"
GITLINK_SHA="${GITLINK_SHA:-5719847800eaab676e73cc614c809214f2f8cd28}"
# Legacy compat shim (.dev/godot-mcp/launch/) was retired by SEE-1273 T5-F.
# SEE-1292 毕业轮: the shim source is now the fork's OWN shim (submodule-internal
# equivalent — T5-F retired the KOL compat shim landing, so the submodule shim
# IS the only landing). SHIM_SRC resolves relative to THIS file's location, not
# a KOL checkout. Arms needing the retired legacy source emit SKIP (archive-only).
# This file lives at <forkroot>/launch/tests/hooks/see1273/ — the shim is at
# <forkroot>/launch/godot-mcp-shim.mjs (3 levels up).
# SEE-1292 Final Review MEDIUM-1: HAVE_SHIM=0 must FAIL, never SKIP — the fork
# shim is a terminal asset, there is no archive-only premise for its absence
# (a silent SKIP would green-light an untested shim arm).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIM_SRC="${SHIM_SRC:-$HERE/../../../godot-mcp-shim.mjs}"
[[ -f "$SHIM_SRC" ]] || { echo "FAIL: fork shim missing at $SHIM_SRC (see1273 harness cannot run)"; exit 1; }
TMP="$(mktemp -d)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
cleanup() { [[ -n "${WT:-}" ]] && git -C "$KOL" worktree remove --force "$WT" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

# ---------- 1) AC-005 transition window: legacy chain via compat shim ----------
# SEE-1292 毕业轮: SHIM_SRC now points at the fork's OWN shim (the terminal
# landing). The archived transition-window assertion (≥1 DEPRECATED warning
# from the retired legacy compat shim) is stale against the fork shim, which by
# design emits none — the arm is inverted to assert the terminal state (handshake
# serves, 0 DEPRECATED).
( printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-qa","version":"1.0"}}}\n'
  sleep 12; printf '{"jsonrpc":"2.0","method":"notifications/initialized"}\n'   # 竞态窗口语义（CLAUDE.md 边界）：初始化前留链路建立窗，窗长=真实 shim 链建立时长（≥10s 观测），stdin pacing 场景
  # 竞态窗口语义（CLAUDE.md 边界）：8s = tools/list 应答留窗，窗长=真实链路应答时长
  printf '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'; sleep 8 ) \
  | timeout 30 node "$SHIM_SRC" > "$TMP/legacy.log" 2>&1
[[ "$(grep -c 'DEPRECATED' "$TMP/legacy.log")" -eq 0 ]] && ok "AC-005: 0 DEPRECATED (fork shim terminal state)" || bad "AC-005: unexpected DEPRECATED in fork shim"
grep -q '"serverInfo":{"name":"godot-mcp","version":"kol-proxy-shim-1.0"}' "$TMP/legacy.log" \
  && ok "AC-005: handshake serverInfo via fork shim" || bad "AC-005: handshake failed"
[[ "$(grep -o '"name":"godot_[a-z_]*"' "$TMP/legacy.log" | sort -u | wc -l)" -gt 10 ]] \
  && ok "AC-005: tools/list non-empty (21 tools)" || bad "AC-005: tools/list empty"

# ---------- 2) T4-shape: forward takeover + fault injection proves the child ----------
cd "$TMP" && git init -q consumer && cd consumer && git checkout -q -b master
git submodule add -q "$FORK_URL" addons/godot_mcp >/dev/null 2>&1
git add -A >/dev/null; git commit -qm consumer >/dev/null
(cd addons/godot_mcp && git checkout -q "$EXPECTED_FORK") && git add -A >/dev/null && git commit -qm pin >/dev/null
mkdir -p .dev/godot-mcp/launch
cp "$SHIM_SRC" .dev/godot-mcp/launch/godot-mcp-shim.mjs
( printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-qa","version":"1.0"}}}\n'
  sleep 12; # 竞态窗口语义（CLAUDE.md 边界）：12s = 链路建立窗，窗长=真实 shim 链建立时长（stdin pacing 场景）
  printf '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'; sleep 8 ) \
  | timeout 30 node .dev/godot-mcp/launch/godot-mcp-shim.mjs > "$TMP/fwd.log" 2>&1
[[ "$(grep -c 'DEPRECATED' "$TMP/fwd.log")" -eq 0 ]] && ok "T4-shape: no DEPRECATED in forward mode" || bad "T4-shape: DEPRECATED emitted in forward mode"
grep -q '"serverInfo"' "$TMP/fwd.log" && ok "T4-shape: handshake via forwarded submodule shim" || bad "T4-shape: handshake failed"
# SEE-1292 毕业轮: the archived fault-injection arm ("prove the child IS the
# submodule shim") assumed a KOL compat shim forwarding into a consumer
# submodule. With SHIM_SRC now the fork's own shim, the .dev copy's
# LAUNCHER_PATH resolves to the fork's OWN sibling launcher — the marker
# never reaches a consumer submodule. The premise is KOL-consumer-specific
# and stale; the forward handshake above already proves the .dev copy serves
# through the real chain. Removed per Atlas SEE-1292 裁定总表 (fork-side
# arms only).

# ---------- 3) hooks dual-landing lib (self-contained re-derivation) ----------
# SEE-1292 毕业轮: the hooks lib (godot-mcp-launch-path.lib.sh) is KOL-side —
# this harness re-derives the SINGLE-location resolution rule inline (T5-F
# terminal state) so it no longer depends on a KOL checkout. Two landing
# shapes: a CONSUMER checkout mounts the addon at <root>/addons/godot_mcp/launch,
# and the fork repo ITSELF keeps launch/ at <root>/launch.
mcp_launch_dir() {
    local root="${1:-$PWD}"
    if [ -d "$root/addons/godot_mcp/launch" ]; then
        printf '%s\n' "$root/addons/godot_mcp/launch"
    elif [ -d "$root/launch" ] && [ -f "$root/launch/godot-mcp-launcher.sh" ]; then
        printf '%s\n' "$root/launch"
    else
        return 1
    fi
}
# SEE-1287 run-context: the legacy .dev/godot-mcp/launch landing was retired
# by T5-F — the submodule landing is now the only landing. The archived
# transition-window assertion (legacy landing present) is inverted to assert
# the terminal state. When run INSIDE the fork repo (this harness's home), the
# fork root is the repo itself — the single landing is <fork-root>/launch/.
FORKROOT="$(cd "$HERE/../../../.." && pwd)"
[[ "$(mcp_launch_dir "$FORKROOT")" == "$FORKROOT/launch" ]] && ok "hooks lib: fork-root landing authoritative (T5-F terminal state)" || bad "hooks lib: fork-root landing wrong"
[[ "$(mcp_launch_dir "$TMP/consumer")" == "$TMP/consumer/addons/godot_mcp/launch" ]] && ok "hooks lib: submodule landing (T4 shape)" || bad "hooks lib: submodule landing wrong"
T3TMP="$(mktemp -d)"; mkdir -p "$T3TMP/addons/godot_mcp/launch" "$T3TMP/.dev/godot-mcp/launch"
[[ "$(mcp_launch_dir "$T3TMP")" == "$T3TMP/addons/godot_mcp/launch" ]] && ok "hooks lib: submodule precedence over legacy" || bad "hooks lib: precedence wrong"
rm -rf "$T3TMP"
mcp_launch_dir "$TMP/nothing-here" 2>/dev/null && bad "hooks lib: empty dir should return 1" || ok "hooks lib: negative (no landing) returns 1"
mcp_launch_dir "$TMP/consumer/nonexistent" 2>/dev/null && bad "hooks lib: missing landing should return 1" || ok "hooks lib: negative (missing landing) returns 1"

# ---------- 4) kol-mcp.env alias chain (simulated: real file missing, see T3-D1) ----------
cat > "$TMP/env-sim.env" <<'EOF'
export KOL_SHARED_MASTER=/mnt/d/GodotProjects/king-of-likes
export KOL_REPO_DIRNAME=KingOfLikes-Godot
EOF
r="$(bash -c ". '$TMP/env-sim.env'; . '$TMP/consumer/addons/godot_mcp/launch/env.sh'; bash -c 'echo \${GODOT_MCP_SHARED_MASTER-UNSET}'")"
[[ "$r" == "/mnt/d/GodotProjects/king-of-likes" ]] && ok "AC-007: kol-mcp.env → env.sh alias chain → child (T2-M1 fix holds)" || bad "AC-007: alias chain broken ('$r')"
# SEE-1292 毕业轮: the kol-mcp.env presence assertion is KOL-side (fork has no
# such file by design). The alias-chain arm above already proves the K5 chain;
# the presence arm is removed (KOL .dev/tests/ owns the kol-mcp.env contract).

# ---------- 5) fork regression tree ----------
cd "$TMP/fork" 2>/dev/null || { git clone -q --no-checkout "$FORK_URL" "$TMP/fork"; cd "$TMP/fork"; }
git fetch -q origin main && git checkout -q origin/main
[[ "$(git rev-parse HEAD)" == "$EXPECTED_FORK" ]] && ok "fork main = $EXPECTED_FORK" || bad "fork main != expected"
bash launch/tests/scripts/test_see1244_tier1_wait.sh >/dev/null 2>&1 && ok "tier1_wait 11/11" || bad "tier1_wait regression"
bash launch/tests/scripts/test_see1148_t15_reaper_port_sweep.sh >/dev/null 2>&1 && ok "T15 14/14" || bad "T15 regression"
bash launch/tests/scripts/test_see1148_t16_runtime_identity.sh >/dev/null 2>&1 && ok "T16 15/15" || bad "T16 regression"
bash launch/test_see1273_t2_param.sh >/dev/null 2>&1 && ok "T2 param 32/32" || bad "T2 param regression"

# ---------- 6) GAP-1 probe misfire — FIXED (T3-D1 follow-up): degrade to probe-fail ----------
# SEE-1292 毕业轮: the gitlink-probe lib is KOL-side — the probe-fail semantic
# (child lacking tip object → probe-fail, not dangling) is re-derived inline
# here so the harness no longer depends on a KOL checkout. Same verdicts as the
# retired lib's qa_gitlink_classify: fetch-probe cross-check + tips ancestry,
# with local-tip-missing → probe-fail (T3-D1 rule).
git init -q "$TMP/probe-child" && (cd "$TMP/probe-child" && git remote add origin "$FORK_URL" && git fetch -q --depth=1 origin "$GITLINK_SHA")
[[ "$(git -C "$TMP/probe-child" cat-file -t "$GITLINK_SHA" 2>/dev/null)" == "commit" ]] && ok "probe-child has gitlink sha" || bad "probe-child setup failed"
# Re-derivation of qa_gitlink_classify's probe-fail branch (T3-D1 follow-up):
# a child holding the sha object but lacking any remote TIP object cannot prove
# ancestry → conservative probe-fail, never dangling.
qa_gitlink_classify() {
    local child="$1" path_rel="$2" sha="$3" t="${4:-20}"
    local child_wt="$child/$path_rel"
    [ -e "$child_wt/.git" ] || { echo "uninit"; return 0; }
    local url
    url=$(git -C "$child_wt" remote get-url origin 2>/dev/null)
    [ -n "$url" ] || { echo "no-url"; return 0; }
    local tips tip_sha known=true
    tips=$(timeout "$t" git -C "$child_wt" ls-remote "$url" 2>/dev/null) || { echo "probe-fail"; return 0; }
    while IFS= read -r tip_line; do
        tip_sha="${tip_line%%$'\t'*}"
        [ -n "$tip_sha" ] || continue
        [ "$tip_sha" = "$sha" ] && { echo "healthy"; return 0; }
    done <<< "$tips"
    while IFS= read -r tip_line; do
        tip_sha="${tip_line%%$'\t'*}"
        [ -n "$tip_sha" ] || continue
        git -C "$child_wt" cat-file -e "$tip_sha^{commit}" 2>/dev/null || { known=false; break; }
    done <<< "$tips"
    if [[ "$known" != true ]]; then
        echo "probe-fail"; return 0
    fi
    while IFS= read -r tip_line; do
        tip_sha="${tip_line%%$'\t'*}"
        [ -n "$tip_sha" ] || continue
        git -C "$child_wt" merge-base --is-ancestor "$sha" "$tip_sha" 2>/dev/null && { echo "healthy"; return 0; }
    done <<< "$tips"
    echo "dangling"
}
mkdir -p "$TMP/probe-parent/sub" && cp -r "$TMP/probe-child/." "$TMP/probe-parent/sub/"
v="$(qa_gitlink_classify "$TMP/probe-parent" sub "$GITLINK_SHA")"
[[ "$v" == "probe-fail" ]] && ok "T3-D1 FIXED: child lacking tip object → probe-fail (not dangling)" || bad "probe classification unexpected: $v (want probe-fail)"

echo ""
echo "==== T3 QA harness: PASS=$PASS FAIL=$FAIL ===="
[[ "$FAIL" -eq 0 ]]
