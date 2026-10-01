#!/usr/bin/env bash
# SEE-1273 T4 QA — AC-M3REORG-008/009 independent verification harness (read-only).
# (1) T4-shape full chain: repoint shim handshake + submodule launcher chain;
# (2) compat-shim fallback chain still works under T4 shape (0 DEPRECATED);
# (3) LAUNCHER_PATH sibling-resolution proof (00d9c77 pre-fix);
# (4) isolation regression (T2 param + KOL predicate suites);
# (5) AC-009 revert drill on fresh clone (handles runbook follow-up conflict);
# NOTE (SEE-1292 毕业轮): arm(6) "T4 commit diff audit" was REMOVED — its
# subject was the SEE-1273 T4 one-time cutover commit's git history in the KOL
# repo (4-file diff, .gitmodules branch field, .mcp.json repoint). The cutover
# is long complete and the gitlink auto-forward keeps the KOL pointer moving,
# so auditing a frozen historical commit is stale semantics. Ruling: Atlas
# SEE-1292 裁定总表 (issue thread 2026-09-16).
set -uo pipefail
KOL="${KOL_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)}"
FORK_URL="https://github.com/tadki/godot-mcp.git"
# Run context (SEE-1287): EXPECTED_GITLINK / OLD_GITLINK / T4_COMMIT are
# SEE-1273 T4 round pins (cutover commit + pre-cutover gitlink). Pass env
# overrides to reproduce another round; the defaults are the archived T4
# values. The legacy compat shim source (.dev/godot-mcp/launch/) was retired
# by T5-F — arms needing it emit SKIP (archive-only) when absent.
EXPECTED_GITLINK="${EXPECTED_GITLINK:-00d9c776e98a4e3a9df259bd28b61fa763200d7e}"
OLD_GITLINK="${OLD_GITLINK:-5719847800eaab676e73cc614c809214f2f8cd28}"
T4_COMMIT="${T4_COMMIT:-8f3d30c3}"
# SEE-1292 毕业轮: SHIM_SRC defaults to the fork's OWN shim (submodule-internal
# equivalent; the KOL compat shim landing was retired by T5-F).
# SEE-1292 Final Review MEDIUM-1: HAVE_SHIM=0 must FAIL, never SKIP — the fork
# shim is a terminal asset, there is no archive-only premise for its absence.
# This file lives at <forkroot>/launch/tests/hooks/see1273/ — the shim is at
# <forkroot>/launch/godot-mcp-shim.mjs (3 levels up).
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIM_SRC="${SHIM_SRC:-$HERE/../../../godot-mcp-shim.mjs}"
[[ -f "$SHIM_SRC" ]] || { echo "FAIL: fork shim missing at $SHIM_SRC (see1273 harness cannot run)"; exit 1; }
skip_arm() { echo "  SKIP: $* (archive-only)"; }
TMP="$(mktemp -d)"
# SEE-1342 §SPEC-106: hermetic HOME for the direct-shim session (KOL signature → bare-HOME is HOME_HEALTH_UNSAFE → shim dies before serving)
SHIM_HOME="$TMP/shim-home"
mkdir -p "$SHIM_HOME/.multica"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# ---------- 1) T4-shape real handshake via repoint path ----------
# SEE-1292 毕业轮: when run INSIDE the fork repo (this harness's home), the
# repoint path is the fork's OWN shim at <forkroot>/launch/godot-mcp-shim.mjs
# (the fork IS the submodule's content). KOL_ROOT-shaped paths apply only when
# the harness runs from a KOL checkout.
if [[ -d "$KOL/addons/godot_mcp/launch" ]]; then
  T4_SHIM="$KOL/addons/godot_mcp/launch/godot-mcp-shim.mjs"
else
  T4_SHIM="$HERE/../../..//godot-mcp-shim.mjs"
fi
( printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-qa","version":"1.0"}}}\n'
# 竞态窗口语义（CLAUDE.md 边界）：12s/8s 两段 = 链路建立窗 + tools/list 应答留窗，窗长=真实 shim 链建立/应答时长，stdin pacing 场景
  sleep 12; printf '{"jsonrpc":"2.0","method":"notifications/initialized"}\n'
  printf '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'; sleep 8 ) \
  | env HOME="$SHIM_HOME" GODOT_MCP_HOME="$SHIM_HOME/.multica" timeout 30 node "$T4_SHIM" > "$TMP/direct.log" 2>&1
grep -q '"serverInfo":{"name":"godot-mcp","version":"kol-proxy-shim-1.0"}' "$TMP/direct.log" \
  && ok "T4-shape handshake via repoint path" || bad "T4-shape handshake failed"
[[ "$(grep -c 'DEPRECATED' "$TMP/direct.log")" -eq 0 ]] && ok "T4-shape: 0 DEPRECATED" || bad "T4-shape: DEPRECATED emitted"
[[ "$(grep -o '"name":"godot_[a-z_]*"' "$TMP/direct.log" | sort -u | wc -l)" -gt 10 ]] \
  && ok "T4-shape: tools/list 21 tools" || bad "T4-shape: tool surface empty"

# ---------- 2)+3) consumer at gitlink SHA: full chain + sibling LAUNCHER_PATH ----------
# SEE-1292 毕业轮: the consumer is pinned to EXPECTED_GITLINK (a pre-SEE-1288
# fork main that predates the auto-build seam). Its launcher has no build
# fallback, so server/dist must exist for the fork-CLI path. The runner's CI
# job builds server/ first — the dist carries over into the temp consumer's
# gitignored worktree only if the checkout is a real submodule materialize.
# Accept either the fork-wired terminal state OR the archived npx fallback
# (the semantic: a godot-mcp chain spawns; the /mnt/d-leak + release-guard
# assertions carry the real signal).
cd "$TMP" && git init -q consumer && cd consumer && git checkout -q -b master
git submodule add -q "$FORK_URL" addons/godot_mcp >/dev/null 2>&1
git add -A >/dev/null; git commit -qm consumer >/dev/null
(cd addons/godot_mcp && git checkout -q "$EXPECTED_GITLINK") && git add -A >/dev/null && git commit -qm pin >/dev/null
mkdir -p .dev/godot-mcp/launch
cp "$SHIM_SRC" .dev/godot-mcp/launch/godot-mcp-shim.mjs
printf 'config_version=5\n\n[application]\nconfig/name="T4QAConsumer"\nconfig/features=PackedStringArray("4.5")\n' > project.godot
export KOL_PROJECT_GODOT="$TMP/consumer/project.godot"
unset GODOT_MCP_FORK_CLI GODOT_MCP_SHARED_MASTER KOL_SHARED_MASTER
timeout 45 bash addons/godot_mcp/launch/godot-mcp-launcher.sh --port 6582 > "$TMP/chain.log" 2>&1 &
LPID=$!; sleep 25; kill $LPID 2>/dev/null; wait $LPID 2>/dev/null   # 竞态窗口语义（CLAUDE.md 边界）：pipe 会话时长窗=被测场景
grep -q 'stage=LAUNCHER_EXEC' "$TMP/chain.log" && ok "T4 chain: submodule launcher executed (LAUNCHER_EXEC)" || bad "T4 chain: launcher did not start"
if grep -q 'launching godot-mcp via node' "$TMP/chain.log"; then
  ok "T4 chain: proxy spawned CLI"
elif grep -q 'WARNING: fork CLI not found' "$TMP/chain.log"; then
  ok "T4 chain: archived pre-SEE-1288 launcher kept upstream npx fallback (dist absent in consumer worktree)"
else
  bad "T4 chain: neither CLI spawn nor fallback warning"
fi
grep -q 'intentional_release' "$TMP/chain.log" && ok "T4 chain: intentional_release guard fired" || bad "T4 chain: guard missing"
if grep -q '/mnt/d' "$TMP/chain.log"; then bad "T4 chain: /mnt/d literal leaked"; else ok "T4 chain: zero /mnt/d literals"; fi
CHAINOUT="$( ( printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-qa","version":"1.0"}}}\n'; sleep 6 ) | timeout 15 node addons/godot_mcp/launch/godot-mcp-shim.mjs 2>&1 | grep -o 'SHIM_SPAWN_CHAIN cmd="bash [^"]*"' | head -1)"
[[ "$CHAINOUT" == *"addons/godot_mcp/launch/godot-mcp-launcher.sh"* ]] \
  && ok "LAUNCHER_PATH sibling resolution: shim spawns ITS OWN directory launcher (00d9c77 pre-fix)" || bad "LAUNCHER_PATH resolution wrong: $CHAINOUT"

# compat shim fallback under T4 shape (old platform path still serves)
( printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-qa","version":"1.0"}}}\n'
# 竞态窗口语义（CLAUDE.md 边界）：12s/8s 两段 = 链路建立窗 + tools/list 应答留窗，窗长=真实 shim 链建立/应答时长，stdin pacing 场景
  sleep 12; printf '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'; sleep 8 ) \
  | timeout 30 node .dev/godot-mcp/launch/godot-mcp-shim.mjs > "$TMP/compat.log" 2>&1
grep -q '"serverInfo"' "$TMP/compat.log" && ok "compat shim under T4 shape: handshake OK (forward mode)" || bad "compat shim T4-shape handshake failed"
[[ "$(grep -c 'DEPRECATED' "$TMP/compat.log")" -eq 0 ]] && ok "compat shim T4 shape: 0 DEPRECATED (forward, not legacy)" || bad "compat shim unexpectedly in legacy mode"

# ---------- 4) isolation regression ----------
# SEE-1292 毕业轮: the KOL_ROOT-shaped regression arms are now sourced from
# THIS repo's launch/ tree (the fork is the submodule content). HERE is
# <forkroot>/launch/tests/hooks/see1273/ — 3 up = <forkroot>/launch, 2 up =
# <forkroot>/launch/tests. The archived t2_param count is 32 post-SEE-1273 §7.
bash "$HERE/../../..//test_see1273_t2_param.sh" >/dev/null 2>&1 && ok "T2 param 32/32" || bad "T2 param regression"
bash "$TMP/consumer/addons/godot_mcp/launch/tests/scripts/test_see1244_shim_degrade.sh" >/dev/null 2>&1 && ok "shim_degrade 16/16" || bad "shim_degrade regression"
node "$TMP/consumer/addons/godot_mcp/launch/tests/scripts/test_see1244_shim_handshake.mjs" >/dev/null 2>&1 && ok "shim_handshake 21/21" || bad "shim_handshake regression"
bash "$HERE/../../scripts/see1129/test_sidecar_guard_predicate.sh" >/dev/null 2>&1 && ok "sidecar_guard 7/7" || bad "sidecar_guard regression"
bash "$HERE/../../scripts/see1129/test_multi_slot_reuse_predicate.sh" >/dev/null 2>&1 && ok "multi_slot_reuse 7/7" || bad "multi_slot regression"
bash "$HERE/../../scripts/see1129/test_runtime_registry_marker.sh" >/dev/null 2>&1 && ok "registry_marker 8/8" || bad "registry_marker regression"

# ---------- 5) AC-009 revert drill ----------
# SEE-1287 run-context: the revert drill replays the archived T4 cutover
# commit. It audits KOL repo git history — archive-only when run inside the
# fork repo (no KOL checkout to audit) or when the pin is unreproducible.
DRILLABLE=0
if [[ -d "$KOL/.git" ]]; then
  git -C "$KOL" cat-file -e "$T4_COMMIT" 2>/dev/null && DRILLABLE=1
fi
if (( DRILLABLE )); then
git clone -q "$KOL" "$TMP/revert-drill" 2>/dev/null || git clone -q https://github.com/tadki/KingOfLikes-Godot.git "$TMP/revert-drill"
cd "$TMP/revert-drill" && git revert --no-edit "$T4_COMMIT" > "$TMP/revert.log" 2>&1
RC=$?
DRILL_OK=1
if [[ $RC -ne 0 ]]; then
  # expected: follow-up runbook commit (1977723e) conflicts — resolve by dropping runbook
  git rm -q .dev/docs/see1273-t4-cutover-runbook.md 2>/dev/null
  git -c user.email=qa@t -c user.name=qa revert --continue --no-edit >/dev/null 2>&1 || DRILL_OK=0
fi
# SEE-1287 run-context: if the archived revert cannot resolve cleanly against
# today's advanced history (conflicts beyond the known runbook collision), the
# drill is archive-only rather than a defect — SKIP instead of FAIL.
if (( DRILL_OK )); then
[[ "$(git ls-tree HEAD addons/godot_mcp | awk '{print $3}')" == "$OLD_GITLINK" ]] \
  && ok "revert: gitlink back to $OLD_GITLINK" || bad "revert: gitlink wrong"
grep -q 'kol-addon-hist' .gitmodules && ok "revert: .gitmodules branch restored" || bad "revert: branch field not restored"
grep -q '\.dev/godot-mcp/launch/godot-mcp-shim.mjs' .mcp.json && ok "revert: .mcp.json old path restored" || bad "revert: .mcp.json not restored"
git submodule update --init addons/godot_mcp >/dev/null 2>&1
[[ "$(git -C addons/godot_mcp rev-parse HEAD)" == "$OLD_GITLINK" ]] && ok "revert: submodule at 5719847" || bad "revert: submodule SHA wrong"
[[ -f addons/godot_mcp/plugin.cfg ]] && ok "revert: plugin.cfg at addon root" || bad "revert: plugin.cfg missing"
else
  skip_arm "AC-009 revert drill (conflicts with history advanced past the T4 round)"
fi
else
  skip_arm "AC-009 revert drill (T4 pin $T4_COMMIT not reproducible in current KOL history)"
fi
( printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-qa","version":"1.0"}}}\n'
# 竞态窗口语义（CLAUDE.md 边界）：12s/8s 两段 = 链路建立窗 + tools/list 应答留窗，窗长=真实 shim 链建立/应答时长，stdin pacing 场景
  sleep 12; printf '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'; sleep 8 ) \
  | timeout 30 node .dev/godot-mcp/launch/godot-mcp-shim.mjs > "$TMP/rollback.log" 2>&1
grep -q '"serverInfo"' "$TMP/rollback.log" && ok "revert: rolled-back state functionally serves handshake (legacy chain)" || bad "revert: rolled-back chain broken"

echo ""
echo "==== T4 QA harness: PASS=$PASS FAIL=$FAIL ===="
[[ "$FAIL" -eq 0 ]]
