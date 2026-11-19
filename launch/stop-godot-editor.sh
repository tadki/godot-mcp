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
# shellcheck source=runtime.lib.sh
source "$SCRIPT_DIR/runtime.lib.sh"
MULTICA_DIR="${GODOT_MCP_HOME:-${HOME}/.config/godot-mcp}"

die() { echo "[stop-godot-editor] ERROR: $*" >&2; exit 2; }

print_usage() {
    cat <<'EOF'
Usage: stop-godot-editor.sh [agent-name] [--port <port>] [--label <label>]
                           [--project-godot <path>] [-h|--help]

Stop the Godot editor this agent started, release its lease sidecar, and clean
up pid/log/worktree files. Idempotent: a no-op when nothing is running.

Arguments:
  agent-name            Agent whose editor to stop (e.g. Bachi). Resolves the port
                        via agent-ports.json, then the label.
  --port <port>         Explicit port (overrides agent-name resolution).
  --label <label>       Explicit label (the godot-editor-<label>.* stem).
  --project-godot <path>
                        Release exactly THIS worktree's lease sidecar. SEE-1292
                        respawn fix: lifecycle files are per-LABEL and shared by
                        concurrent same-agent slots, so the label-derived
                        worktree sidecar can point at ANOTHER slot's checkout —
                        the evict path (proxy evictStaleHolder) MUST pass the
                        stale holder's own worktree here to avoid releasing a
                        live foreign slot's active lease (the respawn-round
                        editor would then read state=released and fall back to
                        the default port 6550).
  -h, --help            Show this help.

Environment:
  KOL_AGENT_NAME        Agent name (used when no positional arg).
  KOL_MCP_PORT          Port (used when no positional arg / --port).
EOF
}

AGENT_NAME=""
PORT=""
LABEL=""
EXPLICIT_WORKTREE=""
while (( $# > 0 )); do
    case "$1" in
        -h|--help) print_usage; exit 0 ;;
        --port) (( $# >= 2 )) || die "--port requires a value."; PORT="$2"; shift 2 ;;
        --port=*) PORT="${1#--port=}"; shift ;;
        --label) (( $# >= 2 )) || die "--label requires a value."; LABEL="$2"; shift 2 ;;
        --label=*) LABEL="${1#--label=}"; shift ;;
        --project-godot) (( $# >= 2 )) || die "--project-godot requires a value."; EXPLICIT_WORKTREE="$2"; shift 2 ;;
        --project-godot=*) EXPLICIT_WORKTREE="${1#--project-godot=}"; shift ;;
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

# Windows-aware probe semantics (SEE-1602 §SPEC-001): every verdict is
# tri-state. A probe that cannot execute must never collapse into "dead" or
# "free" — the 2026-11-19 A2 incident was exactly that collapse (interop
# iostream exception → "no live process" → exit 0 with the editor alive).

# win_tool <name> → absolute path of a Windows interop tool, or rc 1.
# PATH first, then the well-known System32 location: interop PATH entries
# vanish under stripped/non-interactive shells (observed live in the SEE-1602
# A2 rerun — bare `command -v tasklist.exe` missed and the unix kill branch
# then misread `kill -0` on a Windows pid as "dead"), so availability is
# judged on the RESOLVED tool, never on bare PATH. Fallback dir is env-
# overridable for hermetic tests (same pattern as GODOT_MCP_HOME).
win_tool() {
    local t="$1" fallback="${KOL_WIN_TOOL_FALLBACK_DIR:-/mnt/c/Windows/System32}"
    if command -v "$t" >/dev/null 2>&1; then
        command -v "$t"
        return 0
    fi
    if [[ -x "$fallback/$t" ]]; then
        echo "$fallback/$t"
        return 0
    fi
    return 1
}

# win_pid_state <pid> → alive | dead | unknown (echoed).
# tasklist first: its CSV output survived the interop exception that
# killed powershell stdout in the A2 incident. Only a row containing the pid
# proves alive; only an explicit no-match notice proves dead; anything else
# (empty output, garbage, non-zero) falls through to the powershell tier and
# finally to "unknown".
win_pid_state() {
    local pid="$1" out tasklist powershell
    tasklist="$(win_tool tasklist.exe)" || tasklist=""
    powershell="$(win_tool powershell.exe)" || powershell=""
    if [[ -n "$tasklist" ]]; then
        out="$("$tasklist" /FI "PID eq $pid" /FO CSV /NH 2>/dev/null)" || out=""
        if [[ -n "$out" ]]; then
            if grep -q "\"$pid\"" <<<"$out"; then
                echo alive; return 0
            fi
            if grep -qi "INFO:" <<<"$out"; then
                echo dead; return 0
            fi
        fi
    fi
    if [[ -n "$powershell" ]]; then
        # exit 0 with the pid = alive; exit 0 with empty output = dead
        # (SilentlyContinue swallows the miss); any other exit = probe broken.
        if out="$("$powershell" -NoProfile -Command "(Get-Process -Id $pid -ErrorAction SilentlyContinue).Id" 2>/dev/null)"; then
            if [[ -n "$out" ]]; then
                echo alive; return 0
            fi
            echo dead; return 0
        fi
    fi
    echo unknown; return 0
}

# win_pid_image <pid> → process image name, or "" when unresolvable. Used to
# gate the forced-kill channel: taskkill /F is only allowed on a pid we could
# confirm is a Godot editor image (never a blind force-kill by number).
win_pid_image() {
    local pid="$1" out tasklist
    tasklist="$(win_tool tasklist.exe)" || tasklist=""
    [[ -n "$tasklist" ]] || { echo ""; return 0; }
    out="$("$tasklist" /FI "PID eq $pid" /FO CSV /NH 2>/dev/null)" || out=""
    if [[ -n "$out" ]] && grep -q "\"$pid\"" <<<"$out"; then
        # CSV row: "image","pid",... — first field before the first comma.
        sed 's/^"//; s/".*//' <<<"$(grep "\"$pid\"" <<<"$out" | head -n1)"
        return 0
    fi
    echo ""
    return 0
}

# port_state <port> → listening | free | unknown (echoed).
# Tier order reused from start-godot-editor.sh port_in_use
# (Get-NetTCPConnection → netstat.exe → ss); tri-state so a tier that cannot
# execute is skipped, and "unknown" is reported instead of "free" when no
# tier could actually answer (Linux-side ss cannot see the Windows-side
# listener on the WSL gateway IP — the other half of the A2 false negative).
port_state() {
    local p="$1" out powershell netstat
    powershell="$(win_tool powershell.exe)" || powershell=""
    if [[ -n "$powershell" ]]; then
        if out="$("$powershell" -NoProfile -Command "if (Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue) { 'LISTEN' } else { 'FREE' }" 2>/dev/null)"; then
            if grep -q LISTEN <<<"$out"; then
                echo listening; return 0
            fi
            echo free; return 0
        fi
    fi
    netstat="$(win_tool netstat.exe)" || netstat=""
    if [[ -n "$netstat" ]]; then
        if out="$("$netstat" -ano -p tcp 2>/dev/null)"; then
            if grep -E "LISTENING" <<<"$out" | grep -qE ":${p}\\b"; then
                echo listening; return 0
            fi
            echo free; return 0
        fi
    fi
    if command -v ss >/dev/null 2>&1; then
        if out="$(ss -H -tln 2>/dev/null)"; then
            if grep -qE ":${p}\\b" <<<"$out"; then
                echo listening; return 0
            fi
            echo free; return 0
        fi
    fi
    echo unknown; return 0
}

# 1. Resolve the editor PID. The pidfile may be absent (never started) or stale.
EDITOR_PID=""
if [[ -f "$PID_FILE" ]]; then
    EDITOR_PID="$(tr -d '[:space:]' <"$PID_FILE" 2>/dev/null || echo "")"
fi
if [[ -z "$EDITOR_PID" || "$EDITOR_PID" == "pending" ]]; then
    # pidfile empty / pending / absent — try to resolve by port listener as a
    # fallback so a crashed-start residue still gets cleaned.
    if [[ -n "${PORT:-}" ]] && command -v ss >/dev/null 2>&1; then
        # probe may fail (broken interop / stubbed env) — a failed probe is
        # "no pid resolved", never a reason to abort the stop (set -e guard)
        EDITOR_PID="$(ss -tlnp 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p {match($0,/pid=([0-9]+)/,a); if(a[1])print a[1]}' | head -n1 || true)"
    fi
fi

# 2. Terminate the editor process if it is alive; every "stopped" verdict
#    comes from a re-probe, never from the kill channel's exit code
#    (SEE-1602 §SPEC-001). The PID recorded by start-godot-editor.sh is the
#    real Windows Godot PID (resolved via CIM), so on WSL a native kill on
#    the PID does nothing to the Windows process — and `kill -0` failing on
#    such a pid means NOTHING about its liveness, so the unix branch may only
#    run when no Windows interop tool is resolvable at all (PATH or System32
#    fallback via win_tool).
STOP_RC=0
if [[ -n "${EDITOR_PID:-}" ]] && [[ "$EDITOR_PID" =~ ^[0-9]+$ ]]; then
    STATE="$(win_pid_state "$EDITOR_PID")"
    if [[ "$STATE" == "dead" ]]; then
        echo "[stop-godot-editor] editor pid=$EDITOR_PID already dead per probe; nothing to terminate."
    elif win_tool tasklist.exe >/dev/null 2>&1 || win_tool powershell.exe >/dev/null 2>&1; then
        # Windows-editor path (WSL interop). Channel 1: Stop-Process
        # (idempotent on a gone pid via SilentlyContinue). Channel 2:
        # taskkill.exe /F, gated on a probe-confirmed Godot image so a
        # recycled pid can never be force-killed blindly (owner rule: only
        # the exact pid this task started may be cleaned up).
        POWERSHELL="$(win_tool powershell.exe)" || POWERSHELL=""
        TASKKILL="$(win_tool taskkill.exe)" || TASKKILL=""
        if [[ -n "$POWERSHELL" ]]; then
            "$POWERSHELL" -NoProfile -Command "Stop-Process -Id $EDITOR_PID -ErrorAction SilentlyContinue" >/dev/null 2>&1 \
                && echo "[stop-godot-editor] sent Stop-Process for pid=$EDITOR_PID."
        fi
        if [[ "$(win_pid_state "$EDITOR_PID")" != "dead" ]]; then
            IMAGE="$(win_pid_image "$EDITOR_PID")"
            if [[ -n "$TASKKILL" ]] && grep -qi godot <<<"$IMAGE"; then
                "$TASKKILL" /F /PID "$EDITOR_PID" >/dev/null 2>&1 \
                    && echo "[stop-godot-editor] sent taskkill /F for pid=$EDITOR_PID (image=$IMAGE)."
            fi
        fi
        # kill delivery is asynchronous on Windows (taskkill /F returns before
        # the process finishes terminating): confirm death with a bounded
        # predicate poll, never a single immediate probe (SEE-1602 live A2:
        # single-shot re-probe raced the teardown and misreported FAILURE).
        STATE="unknown"
        for _ in 1 2 3 4 5 6 7 8 9 10; do
            STATE="$(win_pid_state "$EDITOR_PID")"
            [[ "$STATE" == "dead" ]] && break
            sleep 1
        done
        if [[ "$STATE" == "dead" ]]; then
            echo "[stop-godot-editor] terminated editor pid=$EDITOR_PID (probe confirms dead)."
        else
            echo "[stop-godot-editor] ERROR: editor pid=$EDITOR_PID not confirmed dead (probe=$STATE)." >&2
            echo "[stop-godot-editor] retry hint: verify with tasklist.exe /FI \"PID eq $EDITOR_PID\" /FO CSV /NH, then taskkill.exe /F /PID $EDITOR_PID, then re-run this script." >&2
            STOP_RC=1
        fi
    else
        # Native-Linux editor: no Windows interop resolvable anywhere — unix
        # kill is the right channel; kill -0 is the verification probe.
        if kill "$EDITOR_PID" 2>/dev/null; then
            echo "[stop-godot-editor] terminated editor pid=$EDITOR_PID via kill."
        fi
        if kill -0 "$EDITOR_PID" 2>/dev/null; then
            echo "[stop-godot-editor] ERROR: editor pid=$EDITOR_PID still alive after kill." >&2
            echo "[stop-godot-editor] retry hint: kill -9 $EDITOR_PID, then re-run this script." >&2
            STOP_RC=1
        else
            echo "[stop-godot-editor] editor pid=$EDITOR_PID confirmed dead (kill -0)."
        fi
    fi
else
    echo "[stop-godot-editor] no pid on file (absent or non-numeric: ${EDITOR_PID:-none}); relying on port probe."
fi

# 3. Release the per-worktree lease sidecar. The worktree sidecar file records
#    which worktree the editor opened; release THAT worktree's lease. Fall back
#    to CWD's project.godot when the worktree file is absent (matches
#    restore-godot-original.sh's own anchor resolution).
#    SEE-1292 respawn fix: an explicit --project-godot (evict path) wins over
#    the label-derived file — the label lifecycle files are shared by
#    concurrent same-agent slots, so trusting them here can release a LIVE
#    foreign slot's active lease and break that slot's next editor boot.
RESTORE_SH="$SCRIPT_DIR/restore-godot-original.sh"
[[ -x "$RESTORE_SH" ]] || die "restore-godot-original.sh not found/executable at $RESTORE_SH"
WORKTREE_FOR_RELEASE=""
if [[ -n "$EXPLICIT_WORKTREE" ]]; then
    WORKTREE_FOR_RELEASE="$EXPLICIT_WORKTREE"
    echo "[stop-godot-editor] release target pinned by --project-godot: $WORKTREE_FOR_RELEASE"
elif [[ -f "$WORKTREE_FILE" ]]; then
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

# 4. Confirm the port is free under the same tri-state contract: a real
#    "free" verdict is required for success; "listening" after the grace
#    recheck and "unknown" (no usable probe answered) are both failures.
#    Linux-side ss cannot see the Windows-side listener on the WSL gateway
#    IP — the other half of the A2 false negative.
PORT_RC=0
if [[ -n "${PORT:-}" ]]; then
    PSTATE="$(port_state "$PORT")"
    if [[ "$PSTATE" == "listening" ]]; then
        # listener teardown trails process death by a moment: bounded poll
        # (short sleeps inside the loop = lint-exempt predicate form)
        for _ in 1 2 3 4 5; do
            sleep 1
            PSTATE="$(port_state "$PORT")"
            [[ "$PSTATE" != "listening" ]] && break
        done
    fi
    case "$PSTATE" in
        free)
            echo "[stop-godot-editor] port ${PORT} free."
            ;;
        listening)
            NETSTAT_HOLDER="$(win_tool netstat.exe 2>/dev/null || echo netstat.exe)"
            HOLDER="$("$NETSTAT_HOLDER" -ano -p tcp 2>/dev/null | grep "LISTENING" | grep -E ":${PORT}\\b" | head -n1 || true)"
            echo "[stop-godot-editor] ERROR: port ${PORT} still listening after cleanup${HOLDER:+ (holder: $HOLDER)}." >&2
            echo "[stop-godot-editor] retry hint: netstat.exe -ano -p tcp | findstr :${PORT} — find the owning pid, taskkill.exe /F /PID <pid>, then re-run this script." >&2
            PORT_RC=1
            ;;
        unknown)
            echo "[stop-godot-editor] ERROR: port ${PORT} state unknown — no usable probe (powershell.exe/netstat.exe/ss all unavailable or failing)." >&2
            echo "[stop-godot-editor] retry hint: verify manually with netstat.exe -ano -p tcp, or re-run where Windows interop or ss is available." >&2
            PORT_RC=1
            ;;
    esac
fi

# 5. Clean up this label's lifecycle files — only on a fully verified stop.
#    On failure the pid sidecar is retained: it is the retryable diagnostic
#    (SEE-1602 §SPEC-001); removing it would orphan the retry.
if [[ "${STOP_RC:-0}" -eq 0 && "${PORT_RC:-0}" -eq 0 ]]; then
    rm -f "$PID_FILE" "$WORKTREE_FILE" 2>/dev/null || true
    echo "[stop-godot-editor] removed pid + worktree sidecar (log retained at $LOG_FILE)."
    echo "[stop-godot-editor] done."
    exit 0
fi
echo "[stop-godot-editor] FAILED: stop incomplete (process_rc=${STOP_RC:-0}, port_rc=${PORT_RC:-0}); pid/worktree sidecars retained for retry (pid=${EDITOR_PID:-none}, file=$PID_FILE)." >&2
exit 1
