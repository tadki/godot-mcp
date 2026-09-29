#!/usr/bin/env bash
# resolve-command.lib.sh — SEE-1356 L6 (§SPEC-L6-03): the launch-domain shared
# command resolver. status_registration_json (godot-status.lib.sh) and
# mcp-assert-registration.sh both consume THIS helper; the SEE-1240 inline
# resolution stays retired.
#
# Resolution rules (终裁语义):
#   absolute/relative (contains '/'): resolve directly — F_OK then X_OK.
#   bare name: resolved one PATH directory at a time (spawn-time PATH
#     semantics — accessSync on a bare name would probe cwd, SEE-1240).
#   retired path (/.dev/godot-mcp/launch/) with any resolution failure:
#     stale downgrade (SEE-1288 — /tmp mcp-config residue, hygiene WARN).
#   ENOENT/EACCES 分级 (对齐 SEE-1240 D1 语义 — a probe the helper cannot
#     PROVE must not FAIL the chain):
#     - bare name missed on every PATH dir  → degraded (this PATH cannot
#       prove the spawn-time PATH misses it too) → doctor WARN, never FAIL;
#     - EACCES / stat-probe errors          → degraded → WARN;
#     - an absolute/relative path with a clean ENOENT stays BROKEN (the
#       2026-08-01 incident shape: mcp_config pointing at a deleted file —
#       regression-pinned by test_see1240_ws4_status_doctor.sh T2).
#
# Usage: mcp_resolve_command "<command>" — sets on return:
#   RCV_VERDICT  ok | stale | broken | degraded
#   RCV_PATH     the resolved path ("" when unresolved)
#   RCV_REASON   machine key: ok | bare_path_hit | bare_path_miss |
#                eacces | dangling_path | not_executable | not_regular_file |
#                stale_retired_path | empty_command

# RETIRED_PATH_MARKER: the SEE-1273 T5-F retired legacy launch path.
RCV_RETIRED_MARKER="/.dev/godot-mcp/launch/"

mcp_resolve_command() {
    local cmd="${1:-}"
    RCV_VERDICT="broken" RCV_PATH="" RCV_REASON="empty_command"
    [[ -n "$cmd" ]] || return 0

    if [[ "$cmd" == */* ]]; then
        # Absolute or relative path: judge the path itself.
        if [[ -d "$cmd" ]]; then
            RCV_PATH="$cmd" RCV_VERDICT="degraded" RCV_REASON="not_regular_file"
        elif [[ -f "$cmd" ]]; then
            if [[ -x "$cmd" ]]; then
                RCV_PATH="$cmd" RCV_VERDICT="ok" RCV_REASON="ok"
            else
                RCV_PATH="$cmd" RCV_VERDICT="degraded" RCV_REASON="not_executable"
            fi
        elif [[ -e "$cmd" ]]; then
            # Exists but neither dir nor regular file (socket/fifo/...):
            # probe outcome is uncertain → WARN, not FAIL.
            RCV_PATH="$cmd" RCV_VERDICT="degraded" RCV_REASON="not_regular_file"
        else
            # Clean ENOENT on an explicit path — the provable dangling shape.
            RCV_PATH="$cmd" RCV_VERDICT="broken" RCV_REASON="dangling_path"
        fi
    else
        # Bare name: walk PATH like spawn-time resolution does. IFS-split on
        # ':' (quoted "${PATH//:/ }" would NOT word-split — one giant dir).
        local dir oldIFS="$IFS"
        IFS=":"
        for dir in $PATH; do
            [[ -n "$dir" ]] || continue
            if [[ -f "$dir/$cmd" && -x "$dir/$cmd" ]]; then
                RCV_PATH="$dir/$cmd" RCV_VERDICT="ok" RCV_REASON="bare_path_hit"
                break
            fi
        done
        IFS="$oldIFS"
        if [[ "$RCV_VERDICT" != "ok" ]]; then
            # Unresolved on THIS process's PATH — cannot prove the spawn-time
            # PATH misses it too (SEE-1240 D1) → degraded, never broken.
            RCV_PATH="" RCV_VERDICT="degraded" RCV_REASON="bare_path_miss"
        fi
    fi

    # Retired-path residue: any failure under the retired legacy launch tree
    # is stale /tmp mcp-config residue (SEE-1288), not a live-chain break.
    if [[ "$RCV_VERDICT" != "ok" && "$cmd" == *"$RCV_RETIRED_MARKER"* ]]; then
        RCV_VERDICT="stale"
        RCV_REASON="stale_retired_path"
    fi
    return 0
}
