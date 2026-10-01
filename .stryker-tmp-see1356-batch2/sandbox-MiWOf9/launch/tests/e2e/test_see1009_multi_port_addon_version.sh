#!/usr/bin/env bash
# SEE-1009 multi-port addon-version readiness check.
#
# Verifies that each agent's dedicated port is running a Godot editor whose
# addon reports the expected version (4.1.0). A mismatch to the npx package
# (which sends server_version=4.1.0) causes npx to print "Version mismatch"
# and disconnect, so tools will never appear.
#
# Run: bash .dev/godot-mcp/tests/e2e/test_see1009_multi_port_addon_version.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$SCRIPT_DIR/_see1009_addon_version_probe.py"

HOST="172.17.192.1"
EXPECTED_VERSION="4.1.0"
PASS=0; FAIL=0; SKIP=0; FAILS=()
ok() { echo "  [PASS] $*"; PASS=$((PASS+1)); }
ko() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }

# Port allocation table (see configure-mcp-port.sh / start-godot-editor.sh)
declare -A PORTS=(
    [6551]="Atlas"
    [6552]="Archi"
    [6553]="Bachi"
    [6554]="Fronti"
    [6555]="Revy"
    [6556]="Refacty"
)

echo "===== SEE-1009 multi-port addon version check ====="
echo "Host: $HOST"
echo "Expected addon_version: $EXPECTED_VERSION"
echo

for port in $(echo "${!PORTS[@]}" | tr ' ' '\n' | sort -n); do
    agent="${PORTS[$port]}"
    result=$(timeout 20 python3 "$PROBE" "$HOST" "$port" 2>/dev/null | head -1)
    if [[ -z "$result" ]]; then
        ko "$agent:$port - not reachable (editor down or port blocked)"
    elif [[ "$result" == ADDON\ version="$EXPECTED_VERSION"* ]]; then
        ok "$agent:$port - $result"
    elif [[ "$result" == ADDON* ]]; then
        ko "$agent:$port - $result"
    elif [[ "$result" == ADDON_FAIL\ close_code=4001* ]]; then
        ko "$agent:$port - single-client slot occupied (another WS client connected)"
    elif [[ "$result" == ADDON_FAIL* ]]; then
        ko "$agent:$port - $result"
    else
        ko "$agent:$port - unexpected output: $result"
    fi
done

echo
echo "============================================================"
echo "SUMMARY: PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
if [[ ${#FAILS[@]} -gt 0 ]]; then
    echo "FAILURES:"
    for f in "${FAILS[@]}"; do echo "  - $f"; done
fi
echo "============================================================"

[[ $FAIL -eq 0 ]]
