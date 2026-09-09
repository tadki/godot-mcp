#!/usr/bin/env bash
# =============================================================================
# DEPRECATED (SEE-1117 Direction 3) — retained ONE release for rollback only.
#
# Phase 1 wrote per-agent ports into project.godot's [MCP-AGENT-CONFIG-BEGIN/END]
# marker block. That scheme is abandoned: addon _ensure_bind_settings() called
# ProjectSettings.save() on every plugin load, and Godot's serializer drops
# intra-section `#` comments, destroying the marker (L2.1 MARKER_MISSING) — the
# P0 root cause of the runtime-editor spawn failures. Direction 3 replaces it
# with the per-worktree sidecar lease <worktree>/.godot/mcp-lease.json (see
# mcp-sidecar.lib.sh). configure-mcp-port.sh / restore-godot-original.sh /
# verify-godot-written-back.sh no longer edit project.godot.
#
# ONLY mcp_find_project_godot() below is still used — as the worktree anchor
# resolver. The marker read/write primitives (mcp_read_marker / mcp_write_marker)
# are dead code and MUST NOT be called by new code. This whole file is scheduled
# for deletion in the NEXT release after Direction 3 is live; it is kept here
# solely so a Phase 1 rollback remains possible during the transition window.
# Do not extend it.
# =============================================================================
#
# Helpers for reading / writing the [MCP-AGENT-CONFIG-BEGIN/END] marker section
# in project.godot.
#
# SEE-1117: project.godot is now git-tracked. The only runtime-mutated region
# is the marker block between the BEGIN and END sentinel comments inside the
# [godot_mcp] section. configure-mcp-port.sh rewrites it to per-agent values at
# lease start; restore-godot-original.sh reverts it to original defaults at
# lease end; verify-godot-written-back.sh checks the restored state for the
# push guard. This file holds the shared sentinel constants and the read/write
# primitives so all three scripts agree on the exact format.
#
# Sourced (not executed) by the three scripts above. Caller must define die().
#
# Marker section layout (exact lines, in order):
#   # [MCP-AGENT-CONFIG-BEGIN]
#   # <comment>
#   # <comment>
#   port_override_enabled=<true|false>
#   port_override=<port>
#   # [MCP-AGENT-CONFIG-END]
#
# The two comment lines under BEGIN are descriptive prose and are left
# untouched by all writers — only the two `port_*` lines change.

MCP_MARKER_BEGIN="# [MCP-AGENT-CONFIG-BEGIN]"
MCP_MARKER_END="# [MCP-AGENT-CONFIG-END]"

# Restored ("original") defaults — the invariant the push guard enforces.
MCP_MARKER_ORIG_ENABLED="false"
MCP_MARKER_ORIG_PORT="6550"

# Locate project.godot the same way the rest of the launch toolchain does:
# explicit override (KOL_PROJECT_GODOT / --project-godot already folded in by
# caller), else walk up from CWD. Echoes the absolute path; dies on failure.
mcp_find_project_godot() {
    local start_dir="${KOL_PROJECT_GODOT:-}"
    if [[ -n "$start_dir" ]]; then
        if [[ -d "$start_dir" ]]; then
            start_dir="$start_dir/project.godot"
        fi
        [[ -f "$start_dir" ]] || die "project.godot not found at: $start_dir"
        echo "$start_dir"
        return
    fi
    local dir
    dir="$(pwd)"
    while [[ "$dir" != "/" ]]; do
        if [[ -f "$dir/project.godot" ]]; then
            echo "$dir/project.godot"
            return
        fi
        dir="$(dirname "$dir")"
    done
    die "project.godot not found in any parent of the current directory (set KOL_PROJECT_GODOT)."
}

# Read the current marker-section values. Echoes "<enabled> <port>" on success.
# Returns 1 (no output) if the marker section is absent, leaving the caller to
# decide whether that is an error (configure appends it; verify treats absence
# as "restored / not per-agent").
mcp_read_marker() {
    local file="$1"
    [[ -f "$file" ]] || return 1
    local enabled="" port="" in_block=0 line key val
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" == "$MCP_MARKER_BEGIN" ]]; then
            in_block=1
            continue
        fi
        if [[ "$line" == "$MCP_MARKER_END" ]]; then
            in_block=0
            continue
        fi
        if (( in_block )); then
            key="${line%%=*}"
            val="${line#*=}"
            case "$key" in
                port_override_enabled) enabled="$val" ;;
                port_override) port="$val" ;;
            esac
        fi
    done < "$file"
    [[ -n "$enabled" || -n "$port" ]] || return 1
    echo "$enabled $port"
}

# Rewrite the marker section in place via a temp file. Preserves every other
# line. Sets port_override_enabled=<enabled> and port_override=<port>. If the
# marker section does not exist yet, appends it (inside the existing
# [godot_mcp] section when present, else creates both).
mcp_write_marker() {
    local file="$1" enabled="$2" port="$3"
    [[ -f "$file" ]] || die "project.godot not found: $file"
    local tmp
    tmp="$(mktemp)"
    trap 'rm -f "$tmp"' RETURN

    local has_marker=0
    grep -qF -- "$MCP_MARKER_BEGIN" "$file" && has_marker=1

    if (( has_marker )); then
        # Stream line by line; inside the block, replace the two port_* lines
        # and pass everything else (including the comment lines and the
        # sentinels) through verbatim.
        local in_block=0 line key
        while IFS= read -r line || [[ -n "$line" ]]; do
            if [[ "$line" == "$MCP_MARKER_BEGIN" ]]; then
                in_block=1
                printf '%s\n' "$line"
                continue
            fi
            if [[ "$line" == "$MCP_MARKER_END" ]]; then
                in_block=0
                printf '%s\n' "$line"
                continue
            fi
            if (( in_block )); then
                key="${line%%=*}"
                case "$key" in
                    port_override_enabled) printf 'port_override_enabled=%s\n' "$enabled"; continue ;;
                    port_override) printf 'port_override=%s\n' "$port"; continue ;;
                esac
            fi
            printf '%s\n' "$line"
        done < "$file" > "$tmp"
    else
        # No marker block yet. Append one under [godot_mcp] when that section
        # exists, else synthesize a fresh [godot_mcp] section first.
        cp "$file" "$tmp"
        if grep -qE '^[[:space:]]*\[godot_mcp\][[:space:]]*$' "$file"; then
            {
                printf '\n%s\n' "$MCP_MARKER_BEGIN"
                printf '# 这段由 godot-mcp launcher 自动维护，请勿手动编辑\n'
                printf '# lease 开始时会覆盖为 per-agent 值，lease 结束时恢复为原始值\n'
                printf 'port_override_enabled=%s\n' "$enabled"
                printf 'port_override=%s\n' "$port"
                printf '%s\n' "$MCP_MARKER_END"
            } >> "$tmp"
        else
            {
                printf '\n[godot_mcp]\n\n'
                printf 'bind_mode=1\n'
                printf 'custom_bind_ip=""\n\n'
                printf '%s\n' "$MCP_MARKER_BEGIN"
                printf '# 这段由 godot-mcp launcher 自动维护，请勿手动编辑\n'
                printf '# lease 开始时会覆盖为 per-agent 值，lease 结束时恢复为原始值\n'
                printf 'port_override_enabled=%s\n' "$enabled"
                printf 'port_override=%s\n' "$port"
                printf '%s\n' "$MCP_MARKER_END"
            } >> "$tmp"
        fi
    fi

    # Sanity-check the rewrite landed the expected lines.
    grep -qE "^[[:space:]]*port_override_enabled[[:space:]]*=[[:space:]]*${enabled}[[:space:]]*$" "$tmp" \
        || die "internal error: port_override_enabled=${enabled} not written."
    grep -qE "^[[:space:]]*port_override[[:space:]]*=[[:space:]]*${port}([[:space:]]*)\$" "$tmp" \
        || die "internal error: port_override=${port} not written."

    cat "$tmp" > "$file"
}
