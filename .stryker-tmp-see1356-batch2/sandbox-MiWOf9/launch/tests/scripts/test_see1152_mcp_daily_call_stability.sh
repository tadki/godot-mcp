#!/usr/bin/env bash
# SEE-1152: godot-mcp daily-call stability probe (offline oracle harness).
# The real oracle is the live MCP call sequence driven by the QA agent (Revy)
# via the godot-mcp-revy MCP server; this script verifies the environmental
# preconditions and post-conditions around each call round:
#   - port registry entry exists for the current runtime (dynamic segment)
#   - proxy PID is alive (kill -0)
#   - editor lifecycle files exist under ~/.multica/godot-editor/<runtime_id>.*
#   - no "editor spawn fail"-class lines in the runtime editor log
# Usage: test_see1152_mcp_daily_call_stability.sh <runtime_id> [rounds_log_file]
set -u
RUNTIME_ID="${1:-}"
[ -z "$RUNTIME_ID" ] && { echo "usage: $0 <runtime_id> [rounds_log_file]"; exit 2; }

REGISTRY="$HOME/.multica/godot-port-registry.json"
EDITOR_DIR="$HOME/.multica/godot-editor"
FAIL=0

check() { # name, condition-exit-code
  if [ "$2" -eq 0 ]; then echo "PASS $1"; else echo "FAIL $1"; FAIL=1; fi
}

# 1. registry entry exists for runtime, port in dynamic segment 6560-6609
PORT=$(jq -r --arg r "$RUNTIME_ID" '.entries[$r].port // 0' "$REGISTRY" 2>/dev/null)
[ -n "$PORT" ] && [ "$PORT" -ge 6560 ] && [ "$PORT" -le 6609 ]
check "registry port in dynamic segment (got ${PORT:-none})" $?

# 2. proxy pid alive
PPID_R=$(jq -r --arg r "$RUNTIME_ID" '.entries[$r].proxy_pid // 0' "$REGISTRY" 2>/dev/null)
[ "$PPID_R" != "0" ] && kill -0 "$PPID_R" 2>/dev/null
check "proxy pid ${PPID_R} alive" $?

# 3. editor lifecycle files
[ -f "$EDITOR_DIR/$RUNTIME_ID.pid" ] && [ -f "$EDITOR_DIR/$RUNTIME_ID.log" ]
check "editor lifecycle files present" $?

# 4. no spawn-fail class lines in the editor log (editor self-exit lease lines
#    are EXPECTED idle behavior, not spawn failures)
if grep -qiE 'spawn.*fail|failed to launch|could not start' "$EDITOR_DIR/$RUNTIME_ID.log" 2>/dev/null; then
  check "no spawn-fail lines in editor log" 1
else
  check "no spawn-fail lines in editor log" 0
fi

exit $FAIL
