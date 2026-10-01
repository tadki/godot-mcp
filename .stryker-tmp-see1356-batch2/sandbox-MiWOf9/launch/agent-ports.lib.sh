#!/usr/bin/env bash
# Loader for the per-agent godot-mcp port allocation.
# Single source of truth is agent-ports.json (see Archi §8 of
# .dev/godot-mcp/docs/mcp-multi-port-usage.md). This helper is SOURCED (not
# executed) by godot-mcp-launcher.sh, configure-mcp-port.sh, and
# start-godot-editor.sh. It requires the caller to set SCRIPT_DIR and have
# `jq` on PATH; populates the AGENT_PORTS associative array. Fails fast
# (exit 1) if the JSON is missing, unreadable, or has no .agents table.
AGENT_PORTS_FILE="${SCRIPT_DIR}/agent-ports.json"
if [ ! -f "$AGENT_PORTS_FILE" ] || ! jq -e '.agents | length > 0' "$AGENT_PORTS_FILE" >/dev/null 2>&1; then
    echo "[agent-ports] ERROR: ${AGENT_PORTS_FILE} missing, unreadable, or has no .agents table" >&2
    exit 1
fi
declare -gA AGENT_PORTS=()
while IFS=$'\t' read -r _ap_name _ap_port; do
    [ -n "$_ap_name" ] || continue
    AGENT_PORTS["$_ap_name"]="$_ap_port"
done < <(jq -r '.agents | to_entries[] | "\(.key)\t\(.value)"' "$AGENT_PORTS_FILE")
unset _ap_name _ap_port

# Port range + agent->port resolution helpers shared by the three launcher
# scripts. die() is provided by each caller (defined after this lib is
# sourced, but before any of these are called), so resolve_port_for_agent's
# die-on-unknown-agent works without a local definition here.
PORT_MIN=6000
PORT_MAX=65535

is_valid_port() {
    local p="$1"
    [[ "$p" =~ ^[0-9]+$ ]] || return 1
    (( p >= PORT_MIN && p <= PORT_MAX ))
}

resolve_port_for_agent() {
    local name="$1"
    if [[ -z "${AGENT_PORTS[$name]+x}" ]]; then
        die "Unknown agent name '$name'. Known agents: ${!AGENT_PORTS[*]}"
    fi
    echo "${AGENT_PORTS[$name]}"
}

# Reverse-lookup: agent label (lowercase) from a port. Returns "port-<n>" if
# the port is not one of the built-in allocations. Shared by
# godot-mcp-launcher.sh and start-godot-editor.sh.
agent_label_for_port() {
    local p="$1"
    local name
    for name in "${!AGENT_PORTS[@]}"; do
        if [[ "${AGENT_PORTS[$name]}" == "$p" ]]; then
            tr '[:upper:]' '[:lower:]' <<<"$name"
            return
        fi
    done
    echo "port-${p}"
}
