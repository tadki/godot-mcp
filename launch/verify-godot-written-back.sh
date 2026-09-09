#!/usr/bin/env bash
# Verify the per-worktree MCP lease sidecar is NOT in the active state.
#
# SEE-1117 Direction 3: the push guard (and auto-pr-on-stop.sh's push path)
# call this before pushing to master / shared/*. A sidecar still in
# state=active means the lease never ended cleanly. Because the sidecar lives
# under .godot/ (gitignored), an active lease cannot leak into git history —
# so the push guard treats a failure here as a soft warning, not a hard block.
# This script only reports the state; the guard decides the severity.
#
# Exit codes:
#   0  sidecar is absent or state=released — clean
#   1  sidecar state=active — lease not released (soft warning for push)
#   2  fatal (project.godot anchor missing)
#
# Usage:
#   verify-godot-written-back.sh                          # walk up from CWD
#   verify-godot-written-back.sh --project-godot <path>   # explicit file
#   verify-godot-written-back.sh --help
#
# Output: one short status line on stdout (for hook logs), detail on stderr.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=mcp-sidecar.lib.sh
source "$SCRIPT_DIR/mcp-sidecar.lib.sh"
# Reuse the project.godot path resolver (anchors the worktree root).
# shellcheck source=mcp-marker-section.lib.sh
source "$SCRIPT_DIR/mcp-marker-section.lib.sh"

die() { echo "[verify-godot-written-back] ERROR: $*" >&2; exit 2; }

print_usage() {
    cat <<'EOF'
Usage: verify-godot-written-back.sh [--project-godot <path>] [-h|--help]

Verify the per-worktree MCP lease sidecar (.godot/mcp-lease.json) is not in the
active state. Used by the push guard and auto-pr-on-stop.sh before push.

Exit codes:
  0  sidecar absent or state=released — clean
  1  sidecar state=active — lease not released
  2  fatal

Arguments:
  --project-godot <path>  project.godot anchoring the worktree whose sidecar to
                          verify. Defaults to the nearest project.godot walking
                          up from the current directory.

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

if [[ ! -f "$LEASE_FILE" ]]; then
    echo "[verify-godot-written-back] sidecar absent — treated as clean."
    exit 0
fi

state="$(sidecar_get "$LEASE_FILE" state)"
if [[ "$state" == "$SIDECAR_STATE_ACTIVE" ]]; then
    echo "[verify-godot-written-back] FAIL: sidecar state=active (lease not released): $LEASE_FILE" >&2
    echo "[verify-godot-written-back] Run: $SCRIPT_DIR/restore-godot-original.sh --project-godot \"$PROJECT_GODOT\"" >&2
    exit 1
fi

if [[ "$state" == "$SIDECAR_STATE_RELEASED" ]]; then
    echo "[verify-godot-written-back] sidecar state=released — ok."
    exit 0
fi

# Unknown / empty state (malformed sidecar). Treat as clean — the guard's job
# is to stop an active lease; a malformed sidecar cannot keep one alive, and
# the next configure overwrites it.
echo "[verify-godot-written-back] sidecar state='${state:-<empty>}' (malformed) — treated as clean."
exit 0
