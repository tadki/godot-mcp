#!/usr/bin/env bash
# Prepare an agent's PRIVATE worktree for godot-mcp after a fresh checkout.
#
# SEE-1111 / SEE-1117 Direction 3: multi-agent cold-start isolation.
#
# project.godot is git-tracked (kept from Phase 1 PR #492 — its real value was
# keeping autoload / input map / rendering config in sync across worktrees, not
# the per-agent port). The per-agent MCP port no longer lives in project.godot;
# it lives in the per-worktree sidecar lease <worktree>/.godot/mcp-lease.json,
# written by configure-mcp-port.sh at lease start and never entering git
# (.godot/ is gitignored). So after `git reset --hard origin/<wb>` project.godot
# is already the clean HEAD version — no copy/generate step is needed.
#
# This script now just:
#   1. Resolves the worktree root.
#   2. Runs the write-target guard (refuses the shared D-drive master checkout
#      and any master-branch checkout — SEE-1111 防线 3).
#   3. Calls configure-mcp-port.sh to write the sidecar lease (state=active,
#      port=<agent port>). configure is also lazy-invoked by the proxy on the
#      first tools/call, so this is an eager convenience, not a hard prerequisite.
#
# Composed with the EXISTING defenses (not replaced by this script):
#   * 防线 3 write-target guard (configure-mcp-port.sh + this script): the
#     shared D-drive master checkout is never a legal write target.
#   * 防线 1 stop-hook sanitize (auto-pr-on-stop.sh): unconditionally releases
#     the sidecar (state=released) on session end.
#   * push-guard: rejects any push whose HEAD tree carries .godot/mcp-lease.json
#     (defensive; .gitignore should already prevent it) and warns on an active
#     worktree lease.
#   * repo-checkout reset: every session resets to origin/<wb>.
#
# Idempotent: safe to re-run any number of times. configure's fast path is a
# no-op when the sidecar is already active on the same port.
#
# Usage:
#   prepare-worktree.sh <agent-name>            # resolve port from the table
#   prepare-worktree.sh --port <port>           # use an explicit port
#   prepare-worktree.sh                         # read KOL_AGENT_NAME / KOL_MCP_PORT
#   prepare-worktree.sh --help
#
# Exit codes: 0 ok / fast-path no-op; 2 fatal (guard violation, no name+port).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=agent-ports.lib.sh
source "$SCRIPT_DIR/agent-ports.lib.sh"

die() { echo "[prepare-worktree] ERROR: $*" >&2; exit 2; }

print_usage() {
    cat <<'EOF'
Usage: prepare-worktree.sh [agent-name] [--port <port>] [--worktree <dir>] [-h|--help]

Write the agent's per-worktree MCP lease sidecar (<worktree>/.godot/mcp-lease.json,
state=active, port=<agent port>) so the agent's editor binds its dedicated port
on next spawn. project.godot is restored by git reset (git-tracked); this script
does not touch it.

Arguments:
  agent-name       Agent whose port to pin (case-sensitive, via agent-ports.json).
  --port <port>    Use an explicit port (6000-65535) instead of the table.
  --worktree <dir> Worktree to prepare. Defaults to the nearest git checkout
                   with the godot-mcp launch toolchain walking up from the
                   current directory.
  -h, --help       Show this help and exit.

Environment:
  KOL_AGENT_NAME   Used when no agent-name argument is given.
  KOL_MCP_PORT     Used when no --port / agent-name is given.
  KOL_WORKTREE     Worktree root override.

Agent -> port table (SSOT .dev/godot-mcp/launch/agent-ports.json):
  Atlas=6551  Archi=6552  Bachi=6553  Fronti=6554  Revy=6555  Refacty=6556
EOF
}

# --- Parse CLI ---------------------------------------------------------------
AGENT_NAME=""
EXPLICIT_PORT=""
EXPLICIT_WORKTREE=""
while (( $# > 0 )); do
    case "$1" in
        -h|--help) print_usage; exit 0 ;;
        --port) (( $# >= 2 )) || die "--port requires a value."; EXPLICIT_PORT="$2"; shift 2 ;;
        --port=*) EXPLICIT_PORT="${1#--port=}"; shift ;;
        --worktree) (( $# >= 2 )) || die "--worktree requires a value."; EXPLICIT_WORKTREE="$2"; shift 2 ;;
        --worktree=*) EXPLICIT_WORKTREE="${1#--worktree=}"; shift ;;
        --) shift; (( $# == 0 )) || die "Unexpected positional argument after '--': $1" ;;
        -*) die "Unknown option: $1 (run with --help)" ;;
        *)
            if [[ -z "$AGENT_NAME" ]]; then AGENT_NAME="$1"; else die "Multiple agent names given ('$AGENT_NAME' and '$1')."; fi
            shift ;;
    esac
done

# --- Resolve port (same precedence as configure-mcp-port.sh) ------------------
PORT=""
NAME=""
if [[ -n "$EXPLICIT_PORT" ]]; then
    PORT="$EXPLICIT_PORT"
elif [[ -n "${KOL_MCP_PORT:-}" ]]; then
    PORT="$KOL_MCP_PORT"
else
    NAME="${AGENT_NAME:-${KOL_AGENT_NAME:-}}"
    if [[ -z "$NAME" ]]; then
        print_usage >&2
        die "No agent name or port provided. Pass an agent name, --port <port>, or set KOL_AGENT_NAME / KOL_MCP_PORT."
    fi
    PORT="$(resolve_port_for_agent "$NAME")"
fi
is_valid_port "$PORT" || die "Invalid port '$PORT': must be an integer in [${PORT_MIN}, ${PORT_MAX}]."

# --- Resolve worktree root ----------------------------------------------------
# Walk up for a git checkout with the godot-mcp launch toolchain.
WORKTREE=""
if [[ -n "$EXPLICIT_WORKTREE" ]]; then
    WORKTREE="$EXPLICIT_WORKTREE"
elif [[ -n "${KOL_WORKTREE:-}" ]]; then
    WORKTREE="${KOL_WORKTREE%/}"
else
    local_dir="$(pwd)"
    while [[ "$local_dir" != "/" ]]; do
        # -e (not -d): in a linked worktree .git is a FILE pointing at the real
        # git dir, so a directory test would skip the repo root.
        if [[ -e "$local_dir/.git" && -d "$local_dir/.dev/godot-mcp/launch" ]]; then
            WORKTREE="$local_dir"
            break
        fi
        local_dir="$(dirname "$local_dir")"
    done
fi

[[ -n "$WORKTREE" ]] || die "Could not locate a Godot worktree to prepare (set --worktree or KOL_WORKTREE, or run from inside an agent worktree)."
PROJECT_GODOT="$WORKTREE/project.godot"

echo "[prepare-worktree] worktree     : $WORKTREE"
echo "[prepare-worktree] project.godot: $PROJECT_GODOT"
echo "[prepare-worktree] target port  : $PORT"

# --- SEE-1111 §7.1 防线 3: write-target guard (same as configure-mcp-port.sh) --
# §4.5.3 T2 / K5: guard only engages when the env provides the shared path.
# AC-M3REORG-013: empty known_shared must guard NOTHING — '$x' == "$known_shared/"
# with known_shared='' degenerates to '/*' and matches every absolute path
# (shell twin of the JS guard fixed in 8d51b13; Revy 串行 3/3 caught this).
known_shared="${GODOT_MCP_SHARED_MASTER:-}"
if [[ -n "$known_shared" ]] && [[ "$WORKTREE" == "$known_shared" || "$WORKTREE" == "$known_shared/"* ]]; then
    die "write-target guard: '$WORKTREE' is the SHARED D-drive master checkout. Refusing to write a lease there — each agent must prepare its PRIVATE worktree (see mcp-multi-port-usage.md §3.7/§7.1)."
fi
if command -v git >/dev/null 2>&1 && [[ -e "$WORKTREE/.git" ]]; then
    branch="$(git -C "$WORKTREE" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [[ "$branch" == "master" ]]; then
        die "write-target guard: '$WORKTREE' is a checkout on branch 'master'. Refusing to write a lease in a master checkout (mcp-multi-port-usage.md §3.7/§7.1)."
    fi
fi

# --- Write the sidecar lease (configure's fast path makes re-runs a no-op) ----
# project.godot is git-tracked: a fresh checkout after `git reset --hard
# origin/<wb>` already has the clean HEAD version, so there is nothing to
# generate or copy here — only the sidecar lease needs writing.
echo "[prepare-worktree] writing sidecar lease for port ${PORT}."
( cd "$WORKTREE" && exec "$SCRIPT_DIR/configure-mcp-port.sh" --port "$PORT" --project-godot "$PROJECT_GODOT" )

echo "[prepare-worktree] Done."
exit 0
