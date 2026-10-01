#!/usr/bin/env bash
# SEE-1117 live e2e — verifies the full chain:
#   configure-mcp-port.sh pins marker -> start-godot-editor.sh launches the
#   editor -> godot_mcp addon reads marker -> WebSocket listens on the
#   per-agent port.
#
# This test exists because script-layer QA (test_see1117_phase1_marker_lifecycle.sh)
# cannot catch one whole class of failure: the addon/plugin.gd side reading
# ProjectSettings and discovering the marker block has been corrupted by
# ProjectSettings.save() on editor startup. This e2e does catch it.
#
# Oracle: Windows-side netstat (via powershell.exe) — concrete port number
# the editor is bound to. NOT "editor looks healthy".
#
# Precondition: editor not yet running for the agent (port 655x free).
# The script kills any editor it spawns before exit.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Run context: the KOL worktree under test (see header note). Default = the
# enclosing KOL checkout; set KOL_ROOT explicitly when running from the fork
# checkout (launch/tests/) to point at the KOL worktree being exercised.
KOL_ROOT="${KOL_ROOT:-$REPO_ROOT}"
LAUNCH_DIR="${KOL_ROOT}/addons/godot_mcp/launch"
POWERSHELL="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
AGENT="${KOL_AGENT_NAME:-Revy}"
PORT="${KOL_MCP_PORT:-6555}"

PASS=0
FAIL=0
declare -a FAILED=()

note() { printf '[live-e2e] %s\n' "$*"; }
pass() { PASS=$((PASS+1)); printf '  [PASS] %s\n' "$*"; }
fail() { FAIL=$((FAIL+1)); FAILED+=("$1"); printf '  [FAIL] %s\n' "$*"; }

# listening_port <godot-pid> -> prints the port the editor is listening on
# in the 6550..6560 range, or empty if none.
listening_port() {
    "$POWERSHELL" -Command "
        Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue \
          | Where-Object { \$_.LocalPort -ge 6550 -and \$_.LocalPort -le 6560 } \
          | Select-Object -ExpandProperty LocalPort
    " 2>/dev/null | tr -d '\r' | head -1
}

# editor_pid -> prints the PID of any running Godot editor, or empty.
editor_pid() {
    "$POWERSHELL" -Command "
        Get-Process -Name 'Godot*' -ErrorAction SilentlyContinue \
          | Select-Object -ExpandProperty Id
    " 2>/dev/null | tr -d '\r' | head -1
}

kill_editor() {
    local pid="$1"
    [ -n "$pid" ] || return 0
    "$POWERSHELL" -Command "Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue" >/dev/null 2>&1 || true
    sleep 2
}

# === pre-check: no stale editor ==============================================

pre_pid="$(editor_pid)"
if [ -n "$pre_pid" ]; then
    note "killing stale editor pid=$pre_pid"
    kill_editor "$pre_pid"
fi

# === L1: pin marker, launch editor, verify listen port =======================

note "L1: configure $AGENT -> marker pin $PORT, launch editor, expect listen $PORT"

# Pin the marker in the worktree.
( cd "$KOL_ROOT" && bash "$LAUNCH_DIR/configure-mcp-port.sh" --port "$PORT" ) >/dev/null 2>&1 \
    || { fail "L1 configure"; exit 1; }

# Sanity: marker must read back true/$PORT from the worktree project.godot.
got=$(python3 - "$KOL_ROOT/project.godot" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'# \[MCP-AGENT-CONFIG-BEGIN\](.*?)# \[MCP-AGENT-CONFIG-END\]', src, re.S)
block = m.group(1) if m else ''
en = re.search(r'^port_override_enabled=(.*)$', block, re.M)
po = re.search(r'^port_override=(.*)$', block, re.M)
print((en.group(1).strip() if en else '?') + '/' + (po.group(1).strip() if po else '?'))
PY
)
if [ "$got" = "true/$PORT" ]; then
    pass "L1.1 marker pinned to true/$PORT before editor launch"
else
    fail "L1.1 marker reads $got, want true/$PORT"
fi

# Launch the editor.
KOL_WORKTREE="$KOL_ROOT" bash "$LAUNCH_DIR/start-godot-editor.sh" "$AGENT" >/dev/null 2>&1 \
    || { fail "L1 start-godot-editor launch"; exit 1; }

# Wait for the editor to bind a port (up to 60s).
listen_port=""
for i in $(seq 1 30); do
    listen_port="$(listening_port)"
    [ -n "$listen_port" ] && break
    sleep 2
done

if [ -z "$listen_port" ]; then
    fail "L1.2 editor did not listen on any 655x port within 60s"
elif [ "$listen_port" = "$PORT" ]; then
    pass "L1.2 editor listening on per-agent port $PORT"
else
    fail "L1.2 editor listening on $listen_port, want $PORT (marker ignored?)"
fi

# === L2: marker block survives editor ProjectSettings.save() =================

note "L2: marker block in project.godot must survive editor save cycle"
post=$(python3 - "$KOL_ROOT/project.godot" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
m = re.search(r'# \[MCP-AGENT-CONFIG-BEGIN\](.*?)# \[MCP-AGENT-CONFIG-END\]', src, re.S)
if not m:
    print('MARKER_MISSING')
    sys.exit(0)
block = m.group(1)
en = re.search(r'^port_override_enabled=(.*)$', block, re.M)
po = re.search(r'^port_override=(.*)$', block, re.M)
print((en.group(1).strip() if en else '?') + '/' + (po.group(1).strip() if po else '?'))
PY
)
if [ "$post" = "true/$PORT" ]; then
    pass "L2.1 marker block intact after editor save (true/$PORT)"
elif [ "$post" = "MARKER_MISSING" ]; then
    fail "L2.1 marker block DESTROYED by ProjectSettings.save() — SEE-1117 P0"
else
    fail "L2.1 marker reads $post after editor save, want true/$PORT"
fi

# Verify [gui] section header not absorbed into a bogus key.
if grep -q '^\[gui\]$' "$KOL_ROOT/project.godot"; then
    pass "L2.2 [gui] section header intact"
else
    fail "L2.2 [gui] section header corrupted (merged into marker key)"
fi

# === teardown ================================================================

note "teardown: restore marker + kill editor"
bash "$LAUNCH_DIR/restore-godot-original.sh" --project-godot "$KOL_ROOT/project.godot" >/dev/null 2>&1 || true
post_pid="$(editor_pid)"
[ -n "$post_pid" ] && kill_editor "$post_pid"

# === summary =================================================================

echo
echo "=== SEE-1117 live e2e summary ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
if (( FAIL > 0 )); then
    for c in "${FAILED[@]}"; do echo "    - $c"; done
    exit 1
fi
exit 0
