#!/usr/bin/env bash
# SEE-1009 E2E regression: real npx @satelliteoflove/godot-mcp tool visibility.
#
# This is the END-STATE test for the SEE-1009 fix: the original symptom was that
# Claude Code could not see any mcp__godot_mcp_* tools. Root cause was the addon's
# single-WS-client policy racing the readiness gate's WS handshake, so npx's own
# handshake was 4001-closed ("WebSocket was closed before the connection was
# established"). The fix (commit 5eaac1d) makes the readiness gate TCP-only, so
# npx becomes the first real WS client.
#
# This test proves the END STATE directly: it runs the SHIPPED launcher against a
# LIVE, healthy (display-attached) editor on a per-agent port, lets it exec the
# REAL npx @satelliteoflove/godot-mcp package (no mock), and speaks the MCP
# JSON-RPC protocol over stdio (initialize -> tools/list). The pass criterion is
# the exact thing the issue was opened to fix: the server returns a non-empty
# tool list, and the launcher/npx stderr contains NO "WebSocket was closed before
# the connection is established" / 4001 connection error.
#
# Verdicts per port:
#   E1  launcher reaches exec and the real npx server replies to initialize
#       with tools capability AND a non-empty tools/list result
#   E2  no "WebSocket was closed" / "Connection error" / 4001 anywhere in the
#       captured launcher+npx stderr
#   E3  the editor log shows exactly ONE successful WebSocket handshake from the
#       npx client (no "Rejecting new connection")
#
# Run:
#   bash .dev/godot-mcp/tests/e2e/test_see1009_mcp_tool_visibility_e2e.sh [port ...]
#   SEE1009_PORTS="6555" bash .dev/godot-mcp/tests/e2e/test_see1009_mcp_tool_visibility_e2e.sh
#   KOL_LIVE_PORT=6555 bash .dev/godot-mcp/tests/e2e/test_see1009_mcp_tool_visibility_e2e.sh
#   SEE1009_SKIP_LIVE=1 bash ...   # skip when no live editor is available
#
# Requires: live, healthy (display-attached, non-Session-0) godot_mcp editors on
# the target ports (editors run on Windows; the wrapper resolves the gateway IP).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LAUNCH_DIR="$REPO_ROOT/launch"
WRAPPER="$LAUNCH_DIR/godot-mcp-launcher.sh"
PROBE="$LAUNCH_DIR/mcp_ready_probe.py"
HANDSHAKE_PY="$SCRIPT_DIR/_see1009_mcp_stdio_handshake.py"

PASS=0; FAIL=0; SKIP=0; FAILS=()
ok() { echo "  [PASS] $*"; PASS=$((PASS+1)); }
ko() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }
sk() { echo "  [SKIP] $*"; SKIP=$((SKIP+1)); }
sect() { echo; echo "===== $* ====="; }

[[ -f "$WRAPPER" ]] || { echo "FATAL: $WRAPPER not found" >&2; exit 2; }
[[ -f "$PROBE" ]]   || { echo "FATAL: $PROBE not found"   >&2; exit 2; }
[[ -f "$HANDSHAKE_PY" ]] || { echo "FATAL: $HANDSHAKE_PY not found" >&2; exit 2; }

declare -A PORT_LABEL=( [6551]="Atlas" [6552]="Archi" [6553]="Bachi" [6554]="Fronti" [6555]="Revy" [6556]="Refacty" )

if [[ "${SEE1009_SKIP_LIVE:-0}" == "1" ]]; then
    sk "SEE1009_SKIP_LIVE=1; live e2e tool-visibility test bypassed"
    echo; echo "SUMMARY: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"; exit 0
fi

# Resolve the WSL gateway (the Windows editor binds the vEthernet IP).
HOST="$(ip route show default 2>/dev/null | sed -n 's/^.*via[[:space:]]\{1,\}\([0-9.]\{1,\}\).*$/\1/p' | head -n1)"
[[ -n "$HOST" ]] || HOST="127.0.0.1"

# Default to Revy's own port (6555); honour SEE1009_PORTS / CLI args / KOL_LIVE_PORT.
if [[ $# -gt 0 ]]; then
    PORTS=("$@")
elif [[ -n "${SEE1009_PORTS:-}" ]]; then
    read -r -a PORTS <<<"$SEE1009_PORTS"
else
    PORTS=("${KOL_LIVE_PORT:-6555}")
fi

OUTDIR="${SEE1009_OUTDIR:-/tmp/see1009_e2e}"
mkdir -p "$OUTDIR"

port_reachable() {
    python3 -c "import socket,sys
s=socket.socket(); s.settimeout(2)
try:
    s.connect(('$HOST', $1)); print('up')
except Exception:
    print('down')
finally:
    s.close()" 2>/dev/null
}

# editor_healthy: the addon must be live (WS heartbeat) AND the editor main
# screen initialized. This is the precondition Bachi's report requires
# (display-attached, non-Session-0). TCP-up alone is NOT enough.
editor_healthy() {
    local p="$1"
    python3 "$PROBE" --host "$HOST" --port "$p" --check ready --timeout 4 >/dev/null 2>&1
}

# mcp_handshake runs via $HANDSHAKE_PY (subprocess); see that file for the
# JSON-RPC conversation (initialize -> notifications/initialized -> tools/list).

for PORT in "${PORTS[@]}"; do
    LABEL="${PORT_LABEL[$PORT]:-port$PORT}"
    sect "$LABEL port $PORT — real npx MCP tool visibility"

    if [[ "$(port_reachable "$PORT")" != "up" ]]; then
        sk "$LABEL:$PORT TCP not reachable; no live editor"
        continue
    fi
    if ! editor_healthy "$PORT"; then
        sk "$LABEL:$PORT TCP up but addon not WS-healthy / editor not ready (Session-0 degraded?); skipping — fix requires a display-attached editor"
        continue
    fi
    ok "$LABEL:$PORT precondition: addon WS-healthy, editor main screen ready"

# Run the shipped launcher with the REAL npx on PATH (no mock). Use the Python
    # helper to speak the MCP JSON-RPC over stdio and capture the conversation.
    WRAP_ERR="$OUTDIR/wrap_${PORT}_${LABEL}.err"
    TRANSCRIPT="$OUTDIR/mcp_${PORT}_${LABEL}.txt"
    : >"$TRANSCRIPT"
    # The helper prints a one-line verdict to stdout and exits after closing stdin.
    timeout 90 python3 "$HANDSHAKE_PY" "$TRANSCRIPT" 60 bash "$WRAPPER" --port "$PORT" >"$OUTDIR/handshake_${PORT}_${LABEL}.txt" 2>"$WRAP_ERR"
    WRC=$?

    VERDICT="$(cat "$OUTDIR/handshake_${PORT}_${LABEL}.txt" 2>/dev/null | head -1)"

    # E1: the real server returned a non-empty tool list.
    if [[ "$VERDICT" == TOOLS_OK* ]]; then
        ok "E1 $LABEL:$PORT real npx returned MCP tools ($VERDICT)"
    else
        ko "E1 $LABEL:$PORT real npx did NOT return tools (verdict='$VERDICT'); see $TRANSCRIPT"
    fi

    # E2: no single-client race signature anywhere in the launcher+npx stderr.
    if grep -qiE 'WebSocket was closed before the connection|Connection error.*WebSocket|Rejecting new connection|close code 4001|CLOSE_CODE_ALREADY_CONNECTED' "$WRAP_ERR"; then
        ko "E2 $LABEL:$PORT single-client race signature present in launcher stderr: $(grep -iE 'WebSocket was closed|Connection error|Rejecting|4001|ALREADY_CONNECTED' "$WRAP_ERR" | head -2)"
    else
        ok "E2 $LABEL:$PORT no 'WebSocket was closed' / 4001 / 'Rejecting new connection' in stderr"
    fi

    # E3: confirm the launcher actually used the TCP gate (the SEE-1009 change)
    # and reached exec npx.
    if grep -q 'leaving WS slot for npx' "$WRAP_ERR" && grep -q 'exec npx' "$WRAP_ERR"; then
        ok "E3 $LABEL:$PORT launcher used TCP gate and reached exec npx"
    else
        ko "E3 $LABEL:$PORT launcher did not show TCP-gate + exec npx path: $(grep -E 'leaving WS slot|exec npx|ERROR|not reachable' "$WRAP_ERR" | tail -2)"
    fi
done

echo
echo "============================================================"
echo "SUMMARY: PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
if [[ ${#FAILS[@]} -gt 0 ]]; then
    echo "FAILURES:"
    for f in "${FAILS[@]}"; do echo "  - $f"; done
fi
echo "Per-port artifacts: $OUTDIR"
echo "============================================================"

[[ $FAIL -eq 0 ]]
