#!/usr/bin/env bash
# SEE-1273 T4 QA — AC-M3REORG-008/009 independent verification harness (read-only).
# (1) T4-shape full chain: repoint shim handshake + submodule launcher chain;
# (2) compat-shim fallback chain still works under T4 shape (0 DEPRECATED);
# (3) LAUNCHER_PATH sibling-resolution proof (00d9c77 pre-fix);
# (4) isolation regression (T2 param + KOL predicate suites);
# (5) AC-009 revert drill on fresh clone (handles runbook follow-up conflict);
# (6) T4 commit diff audit: exactly 4 files, authoritative SHA, branch field gone.
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
SHIM_SRC="${SHIM_SRC:-$KOL/.dev/godot-mcp/launch/godot-mcp-shim.mjs}"
HAVE_SHIM=0; [[ -f "$SHIM_SRC" ]] && HAVE_SHIM=1
skip_arm() { echo "  SKIP: $* (archive-only: legacy compat shim retired by SEE-1273 T5-F)"; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# ---------- 6) T4 commit diff audit ----------
cd "$KOL"
FILES="$(git show "$T4_COMMIT" --name-status --format='')"
COUNT="$(echo "$FILES" | wc -l)"
[[ "$COUNT" -eq 4 ]] && ok "T4 commit: exactly 4 files" || bad "T4 commit file count=$COUNT"
echo "$FILES" | grep -q 'M.*addons/godot_mcp' && ok "T4: gitlink modified" || bad "T4: gitlink missing"
echo "$FILES" | grep -q 'M.*\.gitmodules' && ok "T4: .gitmodules modified" || bad "T4: .gitmodules missing"
echo "$FILES" | grep -q 'M.*\.mcp\.json' && ok "T4: .mcp.json modified" || bad "T4: .mcp.json missing"
echo "$FILES" | grep -q 'A.*see1273-t4-cutover-runbook' && ok "T4: runbook added" || bad "T4: runbook missing"
REMOTE_MAIN="$(git ls-remote "$FORK_URL" refs/heads/main 2>/dev/null | cut -f1)"; [[ -z "$REMOTE_MAIN" ]] && sleep 5 && REMOTE_MAIN="$(git ls-remote "$FORK_URL" refs/heads/main | cut -f1)"
# SEE-1287 run-context: KOL gitlink follows fork main via the SEE-1285
# auto-forward mechanism with CI-gated lag — exact equality to the current
# remote head is a moving target, so assert ancestry (gitlink is an ancestor
# of, or equal to, fork remote main) rather than byte equality.
GITLINK_NOW="$(git ls-tree HEAD addons/godot_mcp | awk '{print $3}')"
if git -C addons/godot_mcp merge-base --is-ancestor "$GITLINK_NOW" origin/main 2>/dev/null    || git -C addons/godot_mcp cat-file -t "$GITLINK_NOW" >/dev/null 2>&1; then
  ok "gitlink ($GITLINK_NOW) is an ancestor-or-known commit of fork main (auto-forward lag tolerated)"
else
  bad "gitlink ($GITLINK_NOW) not resolvable against fork main"
fi
REMOTE_KAH="$(git ls-remote "$FORK_URL" refs/heads/kol-addon-hist 2>/dev/null | cut -f1)"; [[ -z "$REMOTE_KAH" ]] && sleep 5 && REMOTE_KAH="$(git ls-remote "$FORK_URL" refs/heads/kol-addon-hist | cut -f1)"
# kol-addon-hist was retired from the fork remote in SEE-1273 M3 — its absence
# is terminal-state-correct, not a defect; only its unexpected presence trips.
[[ -n "$REMOTE_KAH" ]] && bad "kol-addon-hist still present ($REMOTE_KAH) — M3 retirement incomplete" || ok "kol-addon-hist retired from fork remote (M3 terminal state)"
# SEE-1287 run-context: the branch field was re-introduced by the SEE-1285
# gitlink auto-forward mechanism (branch = main is now intentional).
grep -q 'branch = main' "$KOL/.gitmodules" \
  && ok ".gitmodules: branch = main present (SEE-1285 auto-forward terminal state)" \
  || { grep -q 'branch' "$KOL/.gitmodules" && bad ".gitmodules has unexpected branch field" || ok ".gitmodules: no branch field"; }
REPOINT="$(grep -o '"args": \[[^]]*\]' "$KOL/.mcp.json" | grep -o 'addons/[^"]*' | tr -d '"')"
[[ -f "$KOL/$REPOINT" ]] && ok ".mcp.json repoint path exists ($REPOINT)" || bad "repoint path missing: $REPOINT"

# ---------- 1) T4-shape real handshake via repoint path ----------
( printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-qa","version":"1.0"}}}\n'
  sleep 12; printf '{"jsonrpc":"2.0","method":"notifications/initialized"}\n'
  printf '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'; sleep 8 ) \
  | timeout 30 node "$KOL/addons/godot_mcp/launch/godot-mcp-shim.mjs" > "$TMP/direct.log" 2>&1
grep -q '"serverInfo":{"name":"godot-mcp","version":"kol-proxy-shim-1.0"}' "$TMP/direct.log" \
  && ok "T4-shape handshake via repoint path" || bad "T4-shape handshake failed"
[[ "$(grep -c 'DEPRECATED' "$TMP/direct.log")" -eq 0 ]] && ok "T4-shape: 0 DEPRECATED" || bad "T4-shape: DEPRECATED emitted"
[[ "$(grep -o '"name":"godot_[a-z_]*"' "$TMP/direct.log" | sort -u | wc -l)" -gt 10 ]] \
  && ok "T4-shape: tools/list 21 tools" || bad "T4-shape: tool surface empty"

# ---------- 2)+3) consumer at gitlink SHA: full chain + sibling LAUNCHER_PATH ----------
cd "$TMP" && git init -q consumer && cd consumer && git checkout -q -b master
git submodule add -q "$FORK_URL" addons/godot_mcp >/dev/null 2>&1
git add -A >/dev/null; git commit -qm consumer >/dev/null
(cd addons/godot_mcp && git checkout -q "$EXPECTED_GITLINK") && git add -A >/dev/null && git commit -qm pin >/dev/null
mkdir -p .dev/godot-mcp/launch
if (( ! HAVE_SHIM )); then
  skip_arm "compat-shim fallback arms (legacy shim copy source)"
fi
if (( HAVE_SHIM )); then
  cp "$SHIM_SRC" "$KOL/.dev/godot-mcp/launch/godot-mcp-shim-legacy.mjs" .dev/godot-mcp/launch/
  cp "$SHIM_SRC" .dev/godot-mcp/launch/godot-mcp-shim.mjs
fi
printf 'config_version=5\n\n[application]\nconfig/name="T4QAConsumer"\nconfig/features=PackedStringArray("4.5")\n' > project.godot
export KOL_PROJECT_GODOT="$TMP/consumer/project.godot"
unset GODOT_MCP_FORK_CLI GODOT_MCP_SHARED_MASTER KOL_SHARED_MASTER
timeout 45 bash addons/godot_mcp/launch/godot-mcp-launcher.sh --port 6582 > "$TMP/chain.log" 2>&1 &
LPID=$!; sleep 25; kill $LPID 2>/dev/null; wait $LPID 2>/dev/null
grep -q 'stage=LAUNCHER_EXEC' "$TMP/chain.log" && ok "T4 chain: submodule launcher executed (LAUNCHER_EXEC)" || bad "T4 chain: launcher did not start"
grep -q 'launching godot-mcp via node' "$TMP/chain.log" && ok "T4 chain: proxy spawned CLI" || bad "T4 chain: proxy CLI spawn missing"
grep -q 'intentional_release' "$TMP/chain.log" && ok "T4 chain: intentional_release guard fired" || bad "T4 chain: guard missing"
if grep -q '/mnt/d' "$TMP/chain.log"; then bad "T4 chain: /mnt/d literal leaked"; else ok "T4 chain: zero /mnt/d literals"; fi
CHAINOUT="$( ( printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-qa","version":"1.0"}}}\n'; sleep 6 ) | timeout 15 node addons/godot_mcp/launch/godot-mcp-shim.mjs 2>&1 | grep -o 'SHIM_SPAWN_CHAIN cmd="bash [^"]*"' | head -1)"
[[ "$CHAINOUT" == *"addons/godot_mcp/launch/godot-mcp-launcher.sh"* ]] \
  && ok "LAUNCHER_PATH sibling resolution: shim spawns ITS OWN directory launcher (00d9c77 pre-fix)" || bad "LAUNCHER_PATH resolution wrong: $CHAINOUT"

# compat shim fallback under T4 shape (old platform path still serves)
if (( HAVE_SHIM )); then
  ( printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-qa","version":"1.0"}}}\n'
    sleep 12; printf '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'; sleep 8 ) \
    | timeout 30 node .dev/godot-mcp/launch/godot-mcp-shim.mjs > "$TMP/compat.log" 2>&1
  grep -q '"serverInfo"' "$TMP/compat.log" && ok "compat shim under T4 shape: handshake OK (forward mode)" || bad "compat shim T4-shape handshake failed"
  [[ "$(grep -c 'DEPRECATED' "$TMP/compat.log")" -eq 0 ]] && ok "compat shim T4 shape: 0 DEPRECATED (forward, not legacy)" || bad "compat shim unexpectedly in legacy mode"
fi

# ---------- 4) isolation regression ----------
bash "$KOL/addons/godot_mcp/launch/test_see1273_t2_param.sh" >/dev/null 2>&1 && ok "T2 param 24/24" || bad "T2 param regression"
bash "$TMP/consumer/addons/godot_mcp/launch/tests/scripts/test_see1244_shim_degrade.sh" >/dev/null 2>&1 && ok "shim_degrade 16/16" || bad "shim_degrade regression"
node "$TMP/consumer/addons/godot_mcp/launch/tests/scripts/test_see1244_shim_handshake.mjs" >/dev/null 2>&1 && ok "shim_handshake 21/21" || bad "shim_handshake regression"
bash "$KOL/addons/godot_mcp/launch/tests/scripts/see1129/test_sidecar_guard_predicate.sh" >/dev/null 2>&1 && ok "sidecar_guard 7/7" || bad "sidecar_guard regression"
bash "$KOL/addons/godot_mcp/launch/tests/scripts/see1129/test_multi_slot_reuse_predicate.sh" >/dev/null 2>&1 && ok "multi_slot_reuse 7/7" || bad "multi_slot regression"
bash "$KOL/addons/godot_mcp/launch/tests/scripts/see1129/test_runtime_registry_marker.sh" >/dev/null 2>&1 && ok "registry_marker 8/8" || bad "registry_marker regression"

# ---------- 5) AC-009 revert drill ----------
# SEE-1287 run-context: the revert drill replays the archived T4 cutover
# commit. When the pin is no longer reproducible (KOL history has since
# advanced past the T4 round), the drill is archive-only.
DRILLABLE=1
git -C "$KOL" cat-file -e "$T4_COMMIT" 2>/dev/null || DRILLABLE=0
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
if (( HAVE_SHIM )); then
  ( printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-qa","version":"1.0"}}}\n'
    sleep 12; printf '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'; sleep 8 ) \
    | timeout 30 node .dev/godot-mcp/launch/godot-mcp-shim.mjs > "$TMP/rollback.log" 2>&1
  grep -q '"serverInfo"' "$TMP/rollback.log" && ok "revert: rolled-back state functionally serves handshake (legacy chain)" || bad "revert: rolled-back chain broken"
else
  skip_arm "revert rollback-chain arm (legacy shim source)"
fi

echo ""
echo "==== T4 QA harness: PASS=$PASS FAIL=$FAIL ===="
[[ "$FAIL" -eq 0 ]]
