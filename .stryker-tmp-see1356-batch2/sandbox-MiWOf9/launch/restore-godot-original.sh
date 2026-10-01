#!/usr/bin/env bash
# Release the per-worktree MCP lease sidecar (state=active -> state=released).
#
# SEE-1117 Direction 3: this is the lease-END half of the sidecar lifecycle.
# It is the inverse of configure-mcp-port.sh:
#   * lease start  — configure-mcp-port.sh writes sidecar state=active.
#   * lease end    — THIS script sets state=released + released_at.
#   * verify       — verify-godot-written-back.sh checks state=released/absent.
#
# auto-pr-on-stop.sh calls this at session end as a backstop (a crashed agent
# would otherwise leave the sidecar state=active — harmless for git because
# the sidecar is gitignored, but it would leave the port notionally "in use").
# Idempotent: a no-op when the sidecar is already released or absent.
#
# project.godot is NOT touched — under Direction 3 it never carries lease
# state. The script name is retained for compatibility with the existing hook
# wiring (auto-pr-on-stop.sh, push-guard.sh) and operator runbooks.
#
# Usage:
#   restore-godot-original.sh                          # walk up from CWD
#   restore-godot-original.sh --project-godot <path>   # explicit file
#   restore-godot-original.sh --help
#
# Exit codes: 0 ok / no-op; 2 fatal (project.godot anchor missing).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=mcp-sidecar.lib.sh
source "$SCRIPT_DIR/mcp-sidecar.lib.sh"
# Reuse the project.godot path resolver (anchors the worktree root).
# shellcheck source=mcp-marker-section.lib.sh
source "$SCRIPT_DIR/mcp-marker-section.lib.sh"

die() { echo "[restore-godot-original] ERROR: $*" >&2; exit 2; }

print_usage() {
    cat <<'EOF'
Usage: restore-godot-original.sh [--project-godot <path>] [-h|--help]

Release the per-worktree MCP lease sidecar (.godot/mcp-lease.json) by setting
state=released + released_at. Inverse of configure-mcp-port.sh; idempotent.
project.godot is not modified.

Arguments:
  --project-godot <path>  project.godot anchoring the worktree whose sidecar to
                          release. Defaults to the nearest project.godot
                          walking up from the current directory.

Environment:
  KOL_PROJECT_GODOT       Path to project.godot (overridden by --project-godot).
EOF
}

EXPLICIT_PROJECT_GODOT=""
while (( $# > 0 )); do
    case "$1" in
        -h|--help) print_usage; exit 0 ;;
        --project-godot) (( $# >= 2 )) || die "--project-godot requires a value."; EXPLICIT_PROJECT_GODOT="$2"; shift 2 ;;
        --project-godot=*) EXPLICIT_PROJECT_GODOT="${1#--project-godot=}"; shift ;;
        -*) die "Unknown option: $1 (run with --help)" ;;
        *) die "Unexpected positional argument: $1 (run with --help)" ;;
    esac
done

if [[ -n "$EXPLICIT_PROJECT_GODOT" ]]; then
    KOL_PROJECT_GODOT="$EXPLICIT_PROJECT_GODOT"
    export KOL_PROJECT_GODOT
fi

PROJECT_GODOT="$(mcp_find_project_godot)"
LEASE_FILE="$(sidecar_path_for "$PROJECT_GODOT")"

echo "[restore-godot-original] project.godot  : $PROJECT_GODOT"
echo "[restore-godot-original] sidecar lease : $LEASE_FILE"

if [[ ! -f "$LEASE_FILE" ]]; then
    echo "[restore-godot-original] sidecar absent; nothing to release."
    exit 0
fi

cur_state="$(sidecar_get "$LEASE_FILE" state)"
if [[ "$cur_state" == "$SIDECAR_STATE_RELEASED" ]]; then
    echo "[restore-godot-original] Fast path: sidecar already released."
    exit 0
fi

echo "[restore-godot-original] sidecar was state=${cur_state}; releasing."
sidecar_write_released "$PROJECT_GODOT"

echo "[restore-godot-original] Done. sidecar state=released."
exit 0
