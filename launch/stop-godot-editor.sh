#!/usr/bin/env bash
# SEE-1129 Owner principle #3 — "没有人使用的 editor 主动退出":
# the deterministic task-exit cleanup companion to start-godot-editor.sh.
#
# What it does (in order, all idempotent):
#   1. Read the editor PID from ${MULTICA_DIR}/godot-editor-<label>.pid.
#   2. If that PID is a live Godot editor process, terminate it (Windows PID via
#      powershell.exe Stop-Process when on WSL+exe; native kill otherwise).
#   3. Release the per-worktree lease sidecar via restore-godot-original.sh
#      (state=active -> released).
#   4. Confirm the port is free (best-effort; report remaining listener).
#   5. Clean up the pid/log/worktree sidecar files for this label.
#
# Layer contract: this script touches ONLY release/lifecycle artifacts — the
# addon, the proxy's upstream WS protocol, and the launcher worktree marker
# layer (PR #496/#497/#498) are NOT modified. It reuses restore-godot-original.sh
# as the single source of truth for "released".
#
# Usage:
#   stop-godot-editor.sh <agent-name>
#   stop-godot-editor.sh --port <port>
#   stop-godot-editor.sh                       # read KOL_AGENT_NAME / KOL_MCP_PORT
#   stop-godot-editor.sh --label <label>       # explicit label (advanced)
#
# Exit codes: 0 ok / no-op (nothing to clean); 2 fatal misuse.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=agent-ports.lib.sh
source "$SCRIPT_DIR/agent-ports.lib.sh"
# SEE-1148 P1: lifecycle files migrate to ~/.multica/godot-editor/<runtime_id>.*
# SEE-1148 P1: runtime_id + lifecycle paths.
# shellcheck source=kol-runtime.lib.sh
source "$SCRIPT_DIR/kol-runtime.lib.sh"
MULTICA_DIR="${HOME}/.multica"

die() { echo "[stop-godot-editor] ERROR: $*" >&2; exit 2; }

print_usage() {
    cat <<'EOF'
Usage: stop-godot-editor.sh [agent-name] [--port <port>] [--label <label>] [-h|--help]

Stop the Godot editor this agent started, release its lease sidecar, and clean
up pid/log/worktree files. Idempotent: a no-op when nothing is running.

Arguments:
  agent-name            Agent whose editor to stop (e.g. Bachi). Resolves the port
                        via agent-ports.json, then the label.
  --port <port>         Explicit port (overrides agent-name resolution).
  --label <label>       Explicit label (the godot-editor-<label>.* stem).
  -h, --help            Show this help.

Environment:
  KOL_AGENT_NAME        Agent name (used when no positional arg).
  KOL_MCP_PORT          Port (used when no positional arg / --port).
EOF
}

AGENT_NAME=""
PORT=""
LABEL=""
while (( $# > 0 )); do
    case "$1" in
        -h|--help) print_usage; exit 0 ;;
        --port) (( $# >= 2 )) || die "--port requires a value."; PORT="$2"; shift 2 ;;
        --port=*) PORT="${1#--port=}"; shift ;;
        --label) (( $# >= 2 )) || die "--label requires a value."; LABEL="$2"; shift 2 ;;
        --label=*) LABEL="${1#--label=}"; shift ;;
        -*) die "Unknown option: $1 (run with --help)" ;;
        *) [[ -z "$AGENT_NAME" ]] || die "unexpected second positional arg: $1"; AGENT_NAME="$1"; shift ;;
    esac
done

[[ -n "$AGENT_NAME" ]] || AGENT_NAME="${KOL_AGENT_NAME:-}"
[[ -n "$PORT" ]]       || PORT="${KOL_MCP_PORT:-}"
if [[ -z "$PORT" && -n "$AGENT_NAME" ]]; then
    PORT="$(resolve_port_for_agent "$AGENT_NAME" 2>/dev/null || echo "")"
fi
if [[ -z "$LABEL" ]]; then
    if [[ -n "$PORT" ]]; then
        LABEL="$(agent_label_for_port "$PORT" 2>/dev/null || echo "")"
    elif [[ -n "$AGENT_NAME" ]]; then
        LABEL="$(echo "$AGENT_NAME" | tr '[:upper:]' '[:lower:]')"
    fi
fi
[[ -n "$LABEL" ]] || die "could not resolve label (pass --label, --port, or agent-name; or set KOL_AGENT_NAME/KOL_MCP_PORT)."

# SEE-1148 P1: prefer the directory-form lifecycle files keyed by
# KOL_RUNTIME_ID; fall back to the legacy flat label-only files when the new
# set has not been written yet (migration window for same-agent slots that
# launched before P1 landed). LOW-5 (Atlas Final Review): all three lifecycle
# files resolve via kol_lifecycle_path (the single source for the
# directory-form ↔ legacy-flat migration rule, F4/F13) — the previous
# hand-rolled if-block could mix a NEW-form pid file with LEGACY log/worktree
# files (mixed triple), which only shows up as "log found but pid missing"
# during post-mortem.
PID_FILE="$(kol_lifecycle_path ".pid" "$LABEL")"
LOG_FILE="$(kol_lifecycle_path ".log" "$LABEL")"
WORKTREE_FILE="$(kol_lifecycle_path ".worktree" "$LABEL")"

echo "[stop-godot-editor] label        : $LABEL"
echo "[stop-godot-editor] port         : ${PORT:-(unset)}"
echo "[stop-godot-editor] pid file     : $PID_FILE"

# 1. Resolve the editor PID. The pidfile may be absent (never started) or stale.
EDITOR_PID=""
if [[ -f "$PID_FILE" ]]; then
    EDITOR_PID="$(tr -d '[:space:]' <"$PID_FILE" 2>/dev/null || echo "")"
fi
if [[ -z "$EDITOR_PID" || "$EDITOR_PID" == "pending" ]]; then
    # pidfile empty / pending / absent — try to resolve by port listener as a
    # fallback so a crashed-start residue still gets cleaned.
    if [[ -n "${PORT:-}" ]] && command -v ss >/dev/null 2>&1; then
        EDITOR_PID="$(ss -tlnp 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p {match($0,/pid=([0-9]+)/,a); if(a[1])print a[1]}' | head -n1)"
    fi
fi

# 2. Terminate the editor process if it is alive. The PID recorded by
#    start-godot-editor.sh is the real Windows Godot PID (resolved via CIM), so
#    on WSL we must use powershell.exe Stop-Process — a native kill on the PID
#    does nothing to the Windows process.
STOPPED=""
if [[ -n "${EDITOR_PID:-}" ]] && [[ "$EDITOR_PID" =~ ^[0-9]+$ ]]; then
    if command -v powershell.exe >/dev/null 2>&1; then
        # Stop-Process is idempotent: a non-existent Id is a non-terminating error
        # (suppressed by -ErrorAction SilentlyContinue), so this is safe to call
        # unconditionally on the recorded PID.
        if powershell.exe -NoProfile -Command "Stop-Process -Id $EDITOR_PID -ErrorAction SilentlyContinue" >/dev/null 2>&1; then
            STOPPED="stopped-windows-pid-${EDITOR_PID}"
            echo "[stop-godot-editor] terminated Windows editor pid=$EDITOR_PID via Stop-Process."
        fi
    else
        if kill "$EDITOR_PID" 2>/dev/null; then
            STOPPED="stopped-unix-pid-${EDITOR_PID}"
            echo "[stop-godot-editor] terminated editor pid=$EDITOR_PID via kill."
        fi
    fi
fi
[[ -n "$STOPPED" ]] || echo "[stop-godot-editor] no live editor process found for pid=${EDITOR_PID:-none}; nothing to terminate."

# 3. Release the per-worktree lease sidecar. The worktree sidecar file records
#    which worktree the editor opened; release THAT worktree's lease. Fall back
#    to CWD's project.godot when the worktree file is absent (matches
#    restore-godot-original.sh's own anchor resolution).
RESTORE_SH="$SCRIPT_DIR/restore-godot-original.sh"
[[ -x "$RESTORE_SH" ]] || die "restore-godot-original.sh not found/executable at $RESTORE_SH"
WORKTREE_FOR_RELEASE=""
if [[ -f "$WORKTREE_FILE" ]]; then
    WORKTREE_FOR_RELEASE="$(tr -d '[:space:]' <"$WORKTREE_FILE" 2>/dev/null || echo "")"
fi
if [[ -n "$WORKTREE_FOR_RELEASE" ]] && [[ -f "$WORKTREE_FOR_RELEASE/project.godot" ]]; then
    echo "[stop-godot-editor] releasing lease for worktree: $WORKTREE_FOR_RELEASE"
    KOL_PROJECT_GODOT="$WORKTREE_FOR_RELEASE/project.godot" "$RESTORE_SH" --project-godot "$WORKTREE_FOR_RELEASE/project.godot" >/dev/null 2>&1 || true
else
    # Fall back to walking up from CWD (restore-godot-original.sh does this).
    "$RESTORE_SH" >/dev/null 2>&1 || true
    echo "[stop-godot-editor] lease release fell back to CWD-anchored restore (worktree sidecar absent or project.godot missing)."
fi

# 4. Confirm the port is free (best-effort, informational — never fatal).
if [[ -n "${PORT:-}" ]]; then
    if command -v ss >/dev/null 2>&1; then
        if ss -tln 2>/dev/null | awk '$4 ~ ":'"$PORT"'$" {found=1} END{exit !found}'; then
            # Still listening — give Stop-Process a brief moment, then recheck once.
            sleep 1
            if ss -tln 2>/dev/null | awk '$4 ~ ":'"$PORT"'$" {found=1} END{exit !found}'; then
                HOLDER="$(ss -tlnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {print $0}' | head -n1)"
                echo "[stop-godot-editor] WARNING: port ${PORT} still listening after cleanup: $HOLDER"
            else
                echo "[stop-godot-editor] port ${PORT} freed."
            fi
        else
            echo "[stop-godot-editor] port ${PORT} free."
        fi
    fi
fi

# 5. Clean up this label's lifecycle files. They are stale the moment the editor
#    is gone; leaving them would mislead the next start into thinking a holder
#    exists. Logs are kept (debugging); pid + worktree sidecars are removed.
rm -f "$PID_FILE" "$WORKTREE_FILE" 2>/dev/null || true
echo "[stop-godot-editor] removed pid + worktree sidecar (log retained at $LOG_FILE)."
echo "[stop-godot-editor] done."
exit 0
