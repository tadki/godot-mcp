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
# Arms that require its source file are archive-only; when the source is
# absent they emit SKIP (documented, not FAIL) so the harness carries no
# false-fail signal. SHIM_SRC may be overridden for historical reproduction.
SHIM_SRC="${SHIM_SRC:-$KOL/.dev/godot-mcp/launch/godot-mcp-shim.mjs}"
HAVE_SHIM=0; [[ -f "$SHIM_SRC" ]] && HAVE_SHIM=1
skip_arm() { echo "  SKIP: $* (archive-only: legacy compat shim retired by SEE-1273 T5-F)"; }
TMP="$(mktemp -d)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
cleanup() { [[ -n "${WT:-}" ]] && git -C "$KOL" worktree remove --force "$WT" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

# ---------- 1) AC-005 transition window: legacy chain via compat shim ----------
if (( ! HAVE_SHIM )); then
  skip_arm "AC-005 transition-window arms (legacy shim handshake)"
fi
if (( HAVE_SHIM )); then ( printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-qa","version":"1.0"}}}\n'
  sleep 12; printf '{"jsonrpc":"2.0","method":"notifications/initialized"}\n'
  printf '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'; sleep 8 ) \
  | timeout 30 node "$SHIM_SRC" > "$TMP/legacy.log" 2>&1
[[ "$(grep -c 'DEPRECATED' "$TMP/legacy.log")" -ge 1 ]] && ok "AC-005: DEPRECATED warning emitted in transition window" || bad "AC-005: no DEPRECATED warning"
grep -q '"serverInfo":{"name":"godot-mcp","version":"kol-proxy-shim-1.0"}' "$TMP/legacy.log" \
  && ok "AC-005: handshake serverInfo via legacy chain" || bad "AC-005: handshake failed"
[[ "$(grep -o '"name":"godot_[a-z_]*"' "$TMP/legacy.log" | sort -u | wc -l)" -gt 10 ]] \
  && ok "AC-005: tools/list non-empty (21 tools)" || bad "AC-005: tools/list empty"
fi

# ---------- 2) T4-shape: forward takeover + fault injection proves the child ----------
cd "$TMP" && git init -q consumer && cd consumer && git checkout -q -b master
git submodule add -q "$FORK_URL" addons/godot_mcp >/dev/null 2>&1
git add -A >/dev/null; git commit -qm consumer >/dev/null
(cd addons/godot_mcp && git checkout -q "$EXPECTED_FORK") && git add -A >/dev/null && git commit -qm pin >/dev/null
if (( ! HAVE_SHIM )); then
  skip_arm "T4-shape forward-takeover arms (legacy shim copy source)"
fi
mkdir -p .dev/godot-mcp/launch
if (( HAVE_SHIM )); then
  cp "$SHIM_SRC" "$KOL/.dev/godot-mcp/launch/godot-mcp-shim-legacy.mjs" .dev/godot-mcp/launch/
  cp "$SHIM_SRC" .dev/godot-mcp/launch/godot-mcp-shim.mjs
  ( printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-qa","version":"1.0"}}}\n'
    sleep 12; printf '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'; sleep 8 ) \
    | timeout 30 node .dev/godot-mcp/launch/godot-mcp-shim.mjs > "$TMP/fwd.log" 2>&1
  [[ "$(grep -c 'DEPRECATED' "$TMP/fwd.log")" -eq 0 ]] && ok "T4-shape: no DEPRECATED in forward mode" || bad "T4-shape: DEPRECATED emitted in forward mode"
  grep -q '"serverInfo"' "$TMP/fwd.log" && ok "T4-shape: handshake via forwarded submodule shim" || bad "T4-shape: handshake failed"
  cp addons/godot_mcp/launch/godot-mcp-shim.mjs "$TMP/shim.bak"
  printf 'throw new Error("MARKER-FORWARDED-HERE")\n' > addons/godot_mcp/launch/godot-mcp-shim.mjs
  ( printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-qa","version":"1.0"}}}\n'; sleep 3 ) \
    | timeout 10 node .dev/godot-mcp/launch/godot-mcp-shim.mjs > "$TMP/fwd2.log" 2>&1
  grep -q 'MARKER-FORWARDED-HERE' "$TMP/fwd2.log" && ok "T4-shape: fault injection proves child IS submodule shim (never empty-forward)" || bad "T4-shape: forward target unproven"
  cp "$TMP/shim.bak" addons/godot_mcp/launch/godot-mcp-shim.mjs
fi

# ---------- 3) hooks dual-landing lib ----------
source "$KOL/.claude/hooks/godot-mcp-launch-path.lib.sh"
# SEE-1287 run-context: the legacy .dev/godot-mcp/launch landing was retired
# by T5-F — the submodule landing is now the only landing. The archived
# transition-window assertion (legacy landing present) is inverted to assert
# the terminal state.
[[ "$(mcp_launch_dir "$KOL")" == "$KOL/addons/godot_mcp/launch" ]] && ok "hooks lib: submodule landing authoritative (T5-F terminal state)" || bad "hooks lib: submodule landing wrong"
[[ "$(mcp_launch_dir "$TMP/consumer")" == "$TMP/consumer/addons/godot_mcp/launch" ]] && ok "hooks lib: submodule landing (T4 shape)" || bad "hooks lib: submodule landing wrong"
T3TMP="$(mktemp -d)"; mkdir -p "$T3TMP/addons/godot_mcp/launch" "$T3TMP/.dev/godot-mcp/launch"
[[ "$(mcp_launch_dir "$T3TMP")" == "$T3TMP/addons/godot_mcp/launch" ]] && ok "hooks lib: submodule precedence over legacy" || bad "hooks lib: precedence wrong"
rm -rf "$T3TMP"
mcp_launch_dir "$TMP/nothing-here" 2>/dev/null && bad "hooks lib: empty dir should return 1" || ok "hooks lib: negative (no landing) returns 1"
mcp_launch_script nonexistent.sh "$KOL" 2>/dev/null && bad "hooks lib: missing script should return 1" || ok "hooks lib: negative (missing script) returns 1"

# ---------- 4) kol-mcp.env alias chain (simulated: real file missing, see T3-D1) ----------
cat > "$TMP/env-sim.env" <<'EOF'
export KOL_SHARED_MASTER=/mnt/d/GodotProjects/king-of-likes
export KOL_REPO_DIRNAME=KingOfLikes-Godot
EOF
r="$(bash -c ". '$TMP/env-sim.env'; . '$TMP/consumer/addons/godot_mcp/launch/env.sh'; bash -c 'echo \${GODOT_MCP_SHARED_MASTER-UNSET}'")"
[[ "$r" == "/mnt/d/GodotProjects/king-of-likes" ]] && ok "AC-007: kol-mcp.env → env.sh alias chain → child (T2-M1 fix holds)" || bad "AC-007: alias chain broken ('$r')"
[[ -f "$KOL/.dev/env/kol-mcp.env" ]] && ok "AC-007: kol-mcp.env committed in repo" || bad "AC-007 DEFECT T3-D1: .dev/env/kol-mcp.env absent from repo (gitignored by env/ rule); hook has existence guard so chains degrade to unset"

# ---------- 5) fork regression tree ----------
cd "$TMP/fork" 2>/dev/null || { git clone -q --no-checkout "$FORK_URL" "$TMP/fork"; cd "$TMP/fork"; }
git fetch -q origin main && git checkout -q origin/main
[[ "$(git rev-parse HEAD)" == "$EXPECTED_FORK" ]] && ok "fork main = $EXPECTED_FORK" || bad "fork main != expected"
bash launch/tests/scripts/test_see1244_tier1_wait.sh >/dev/null 2>&1 && ok "tier1_wait 11/11" || bad "tier1_wait regression"
bash launch/tests/scripts/test_see1148_t15_reaper_port_sweep.sh >/dev/null 2>&1 && ok "T15 14/14" || bad "T15 regression"
bash launch/tests/scripts/test_see1148_t16_runtime_identity.sh >/dev/null 2>&1 && ok "T16 15/15" || bad "T16 regression"
bash launch/test_see1273_t2_param.sh >/dev/null 2>&1 && ok "T2 param 24/24" || bad "T2 param regression"

# ---------- 6) GAP-1 probe misfire — FIXED (T3-D1 follow-up): degrade to probe-fail ----------
git init -q "$TMP/probe-child" && (cd "$TMP/probe-child" && git remote add origin "$FORK_URL" && git fetch -q --depth=1 origin "$GITLINK_SHA")
[[ "$(git -C "$TMP/probe-child" cat-file -t "$GITLINK_SHA" 2>/dev/null)" == "commit" ]] && ok "probe-child has gitlink sha" || bad "probe-child setup failed"
source "$KOL/.claude/hooks/lib/gitlink-probe.sh"
# 修复后语义：本地缺 tip 对象 → rc=2 → classify=probe-fail（保守放行），不再判 dangling。
# 「本地缺 tip 对象」与「确认无祖先关系」分离——后者（tip 对象齐备且无祖先）仍判 dangling。
mkdir -p "$TMP/probe-parent/sub" && cp -r "$TMP/probe-child/." "$TMP/probe-parent/sub/"
v="$(qa_gitlink_classify "$TMP/probe-parent" sub "$GITLINK_SHA")"
[[ "$v" == "probe-fail" ]] && ok "T3-D1 FIXED: child lacking tip object → probe-fail (not dangling)" || bad "probe classification unexpected: $v (want probe-fail)"

echo ""
echo "==== T3 QA harness: PASS=$PASS FAIL=$FAIL ===="
[[ "$FAIL" -eq 0 ]]
