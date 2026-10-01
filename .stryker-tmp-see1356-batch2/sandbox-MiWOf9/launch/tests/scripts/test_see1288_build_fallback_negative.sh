#!/usr/bin/env bash
# test_see1288_build_fallback_negative.sh — SEE-1288 (AC-MCP-006) hardener:
# the launcher's fork-CLI build fallback must degrade through its NEGATIVE
# path without aborting, and its legacy-path registration downgrade must keep
# the SEE-1078 broken detection intact on every OTHER dangling path.
#
# Target 1 (launcher build-fallback negatives): with no server/dist and a mock
# `npm` on PATH whose `ci` fails, the launcher must log
#   WARNING: fork CLI build failed ... keeping upstream godot-mcp.
# and still fall through to exec the proxy (never `exit` on a missing/broken
# fork). Build-success and override-missing-path WARNING are asserted too, so
# the full branch matrix is covered without a real build/network/editor.
#
# Target 2 (doctor stale vs broken boundary): a registration whose command
# dangles under the SEE-1273-retired legacy path (/.dev/godot-mcp/launch/) →
# WARN (stale), never FAIL; a registration whose command dangles under ANY
# OTHER path → FAIL (broken, SEE-1078 detection NOT weakened).
#
# Pure local: mocks npm + sandboxed /tmp registration dir, no network, no editor.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LAUNCH="$REPO_ROOT/launch/godot-mcp-launcher.sh"
STATUS="$REPO_ROOT/launch/godot-status.sh"

PASS=0; FAIL=0; FAILS=()
ok() { PASS=$((PASS+1)); echo "  ok: $*"; }
ko() { FAIL=$((FAIL+1)); FAILS+=("$*"); echo "  FAIL: $*"; }

[[ -f "$LAUNCH" ]] || { echo "FATAL: $LAUNCH missing"; exit 2; }
[[ -x "$STATUS" ]] || { echo "FATAL: $STATUS missing"; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node required"; exit 2; }

SBOX="$(mktemp -d)"
trap 'rm -rf "$SBOX"' EXIT

# --- Target 1 helpers ---------------------------------------------------------

# Extract the fork-wiring block (FORK_CLI= ... fi) verbatim from the real
# launcher so the test tracks the product code, wrapped in a minimal frame that
# provides log()/log_stage() and then "exes the proxy".
make_wiring_harness() {
    local frame="$1/launch/godot-mcp-launcher-snippet.sh"
    cat > "$frame" <<'FRAME'
set -uo pipefail
SCRIPT_DIR="$STUB_SCRIPT_DIR"
log()  { printf 'LOG %s\n' "$*"; }
log_stage() { printf 'STAGE %s\n' "$*"; }
export KOL_DIRECT_GODOT_MCP=1
export GODOT_MCP_FORK_CLI="${GODOT_MCP_FORK_CLI:-}"
FRAME
    # Capture through the OUTER wiring `fi` (which closes the FORK_WIRED block),
    # not just the inner build-fallback `fi`. Anchor on the LAUNCHER_EXEC line
    # that immediately follows the wiring in the product launcher.
    awk '/^FORK_CLI=.*server\/dist\/cli.js/,/^log_stage "stage=LAUNCHER_EXEC/' "$LAUNCH" | sed '/stage=LAUNCHER_EXEC/d' >> "$frame"
    printf 'echo "PROBE-EXEC godot-mcp-proxy.mjs (continued past wiring)"\n' >> "$frame"
    chmod +x "$frame"
}

echo "== Target 1: build-fallback negative path (npm ci fails) =="
MOCK_TREE="$(mktemp -d)"
MOCK_LAUNCH="$MOCK_TREE/launch"; MOCK_SERVER="$MOCK_TREE/server"
mkdir -p "$MOCK_LAUNCH" "$MOCK_SERVER/src"
printf '{"name":"mock-server","scripts":{"build":"echo build"}}\n' > "$MOCK_SERVER/package.json"
printf '// source present\n' > "$MOCK_SERVER/src/cli.ts"
make_wiring_harness "$MOCK_TREE"
sed -i "s|^SCRIPT_DIR=\"\$STUB_SCRIPT_DIR\"|SCRIPT_DIR=\"$MOCK_LAUNCH\"|" "$MOCK_LAUNCH/godot-mcp-launcher-snippet.sh"

# Mock npm on PATH: `npm ci` always fails, `npm run build` would succeed.
MOCK_BIN="$SBOX/t1bin"; mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/npm" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "ci" ]]; then
    echo "mock npm ci FAILED" >&2
    exit 1
fi
exit 0
EOF
chmod +x "$MOCK_BIN/npm"

out="$SBOX/t1b.out"
T1_HOME="$SBOX/t1home"; mkdir -p "$T1_HOME"
# SEE-1292 §DECPL-001: the launcher snippet resolves GODOT_MCP_HOME from env
# (default $HOME/.config/godot-mcp); pin it to the sandbox so the build log
# lands in a known location instead of the neutral default.
PATH="$MOCK_BIN:$PATH" HOME="$T1_HOME" GODOT_MCP_HOME="$T1_HOME/.multica" KOL_RUNTIME_ID=see1288-t1 bash "$MOCK_LAUNCH/godot-mcp-launcher-snippet.sh" > "$out" 2>&1
rc=$?
# The product computes FORK_SERVER_DIR as SCRIPT_DIR/../server (=<launch>/../server);
# match the stable "fork CLI build failed" tail + server path, not the mock's
# literal MOCK_SERVER spelling. SEE-1288 MEDIUM-1: the WARNING must also point
# at an on-disk build log that actually contains the npm error output.
if grep -q "WARNING: fork CLI build failed in .*/server; full npm output saved to .*godot-mcp-fork-build-see1288-t1\.log; keeping upstream godot-mcp" "$out"; then
    ok "build-fail → WARNING names the on-disk build log (MEDIUM-1)"
else ko "WARNING does not name the build log (got: $(grep 'WARNING\|LOG\|PROBE' "$out" | head -3))"; fi
BUILD_LOG="$T1_HOME/.multica/godot-mcp-fork-build-see1288-t1.log"
[[ -f "$BUILD_LOG" ]] && ok "build log file exists under GODOT_MCP_HOME (runtime_id-tagged)" || ko "build log missing: $BUILD_LOG"
grep -q "mock npm ci FAILED" "$BUILD_LOG" && ok "build log contains the npm error output" || ko "build log missing npm error output"
grep -q "PROBE-EXEC godot-mcp-proxy.mjs" "$out" && ok "launcher continued to exec proxy after build fail" || ko "launcher did not continue after build fail"
[[ "$rc" == "0" ]] && ok "harness exit 0 (no abort on build fail)" || ko "harness rc=$rc (expected 0)"

echo "== Target 1b: build SUCCESS path (npm ci ok, produces dist) =="
cat > "$MOCK_BIN/npm" <<EOF
#!/usr/bin/env bash
if [[ "\$1" == "ci" ]]; then exit 0; fi
if [[ "\$1" == "run" && "\$2" == "build" ]]; then
    mkdir -p "$MOCK_SERVER/dist"
    printf '{"type":"module"}\n' > "$MOCK_SERVER/dist/cli.js"
    chmod +x "$MOCK_SERVER/dist/cli.js"
    exit 0
fi
exit 0
EOF
rm -rf "$MOCK_SERVER/dist"
out2="$SBOX/t1c.out"
PATH="$MOCK_BIN:$PATH" HOME="$T1_HOME" GODOT_MCP_HOME="$T1_HOME/.multica" bash "$MOCK_LAUNCH/godot-mcp-launcher-snippet.sh" > "$out2" 2>&1
grep -q "STAGE stage=FORK_WIRED" "$out2" && ok "build success → FORK_WIRED stage emitted" || ko "build success did not emit FORK_WIRED"
grep -q "quick_timeout_ms=90000" "$out2" && ok "FORK_WIRED carries 90s default" || ko "quick_timeout_ms=90000 missing"

echo "== Target 1c: explicit override missing → WARNING, no build =="
rm -rf "$MOCK_SERVER/dist"
out3="$SBOX/t1d.out"
PATH="$MOCK_BIN:$PATH" GODOT_MCP_FORK_CLI="/nonexistent/missing.js" bash "$MOCK_LAUNCH/godot-mcp-launcher-snippet.sh" > "$out3" 2>&1
grep -q "WARNING: fork CLI not found at /nonexistent/missing.js" "$out3" && ok "override missing → fallback WARNING retained" || ko "override WARNING missing (out: $(cat "$out3" | head -3 | tr '\n' ' '))"
grep -q "PROBE-EXEC godot-mcp-proxy.mjs" "$out3" && ok "override missing still execs proxy (no abort)" || ko "override missing aborted launcher"
# No build attempt on explicit override even when server source present.
grep -q "build failed\|build OK" "$out3" && ko "build was attempted despite explicit override" || ok "no build attempt on explicit override"

echo
echo "== Target 2: doctor stale vs broken boundary =="
export HOME="$SBOX/home"; mkdir -p "$HOME/.multica"
export KOL_PORT_REGISTRY_PATH_OVERRIDE="$HOME/.multica/reg.json"
WT="$SBOX/wt"; mkdir -p "$WT/.godot"
node -e 'require("fs").writeFileSync(process.env.KOL_PORT_REGISTRY_PATH_OVERRIDE,
  JSON.stringify({schema_version:1,entries:{}}));'
# Real /tmp configs are scanned; inject test dirs with controlled commands.
TF1="/tmp/multica-mcp-see1288-legacy"; TF2="/tmp/multica-mcp-see1288-other"
mkdir -p "$TF1" "$TF2"
printf '{"mcpServers":{"godot-mcp-a":{"args":["A"],"command":"/mnt/d/GodotProjects/king-of-likes/.dev/godot-mcp/launch/godot-mcp-launcher.sh"}}}\n' > "$TF1/mcp-config.json"
printf '{"mcpServers":{"godot-mcp-b":{"args":["B"],"command":"/some/deleted/launcher.sh"}}}\n' > "$TF2/mcp-config.json"
cleanup_tf() { rm -rf "$TF1" "$TF2"; }
trap 'cleanup_tf; rm -rf "$SBOX"' EXIT
run_doctor_j(){ KOL_AGENT_NAME=Bachi KOL_WORKTREE="$WT" bash "$STATUS" doctor --json 2>/dev/null; }
OUTJ="$(run_doctor_j)"
# Legacy path stale → WARN, not FAIL.
echo "$OUTJ" | python3 -c "
import json,sys
d=json.load(sys.stdin)
fails=[c for c in d['checks'] if c['level']=='FAIL' and c['check'].startswith('registration')]
legacy_warn=[c for c in d['checks'] if c['level']=='WARN' and c['check'].startswith('registration') and '/.dev/godot-mcp/launch/' in c['detail']]
other_fail=[c for c in d['checks'] if c['level']=='FAIL' and c['check'].startswith('registration') and 'some/deleted' in c['detail']]
assert not any('/.dev/godot-mcp/launch/' in c['detail'] for c in fails), f'legacy path became FAIL: {fails}'
assert legacy_warn, 'no legacy WARN stale'
assert other_fail, 'non-legacy dangling path did NOT FAIL (SEE-1078 weakened)'
print('OK')
" && ok "legacy path → WARN stale; non-legacy dangling → FAIL broken (SEE-1078 intact)" || { ko "doctor boundary assertion failed"; echo "$OUTJ" | python3 -m json.tool 2>/dev/null | grep -i registration | head; }
cleanup_tf

echo
echo "== summary: pass=$PASS fail=$FAIL =="
[[ ${#FAILS[@]} -gt 0 ]] && { echo "failures:"; printf '  - %s\n' "${FAILS[@]}"; }
(( FAIL == 0 ))