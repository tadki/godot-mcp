#!/usr/bin/env bash
# Launch a per-agent Godot editor instance wired to the agent's dedicated
# godot-mcp port.
#
# SEE-976: each agent gets its own editor + MCP port so they can debug in
# parallel. The standard flow after `multica repo checkout` is:
#   1. configure-mcp-port.sh <agent>      # pin the port in project.godot
#   2. start-godot-editor.sh   <agent>    # launch this script (port-checked)
#
# This script resolves the agent's port (same table as configure-mcp-port.sh),
# refuses to start if that port is already bound (avoids two editors fighting
# over one port), converts the worktree path to a Windows path when the editor
# is a Windows .exe launched from WSL, then backgrounds the editor with logs
# redirected to ~/.multica/godot-editor-<agent>.log.
#
# Usage:
#   start-godot-editor.sh <agent-name> [--worktree <path>] [-h|--help]
#   start-godot-editor.sh --port <port>  [--worktree <path>]
#   start-godot-editor.sh                # read KOL_AGENT_NAME / KOL_MCP_PORT
#
# Examples:
#   start-godot-editor.sh Bachi
#   start-godot-editor.sh --port 6551 --worktree /mnt/d/GodotProjects/x
#   GODOT_EDITOR=/mnt/d/Godot/Godot_v4.6.2-stable_win64.exe start-godot-editor.sh Atlas
#
# Args precedence (highest first):
#   1. explicit flags (--port / positional agent name / --worktree)
#   2. KOL_MCP_PORT / KOL_AGENT_NAME / KOL_WORKTREE env vars

set -euo pipefail

DEFAULT_GODOT_EDITOR="/mnt/d/Godot/Godot_v4.6.2-stable_win64.exe"
MULTICA_DIR="${GODOT_MCP_HOME:-${HOME}/.config/godot-mcp}"

# Resolve powershell.exe: prefer PATH, else the well-known System32 location.
POWERSHELL=""
if command -v powershell.exe >/dev/null 2>&1; then
    POWERSHELL="powershell.exe"
elif [[ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]]; then
    POWERSHELL="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
fi

# Resolve script dir to locate the shared port-allocation source.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Per-agent port allocation — single source of truth is agent-ports.json
# (loaded via agent-ports.lib.sh); shared with godot-mcp-launcher.sh and
# configure-mcp-port.sh. See mcp-multi-port-usage.md §2/§8.
# shellcheck source=agent-ports.lib.sh
source "$SCRIPT_DIR/agent-ports.lib.sh"
# SEE-1148 P1: runtime_id derivation + directory-form lifecycle paths.
# shellcheck source=runtime.lib.sh
source "$SCRIPT_DIR/runtime.lib.sh"

print_usage() {
    cat <<EOF
Usage: start-godot-editor.sh [agent-name] [--port <port>] [--worktree <path>] [--editor <exe>] [--foreground] [-h|--help]

Launch a per-agent Godot editor instance bound to the agent's dedicated
godot-mcp port. Refuses to start if the port is already in use.

Arguments:
  agent-name           Agent whose port to use (case-sensitive). Resolved via
                       the built-in allocation table.
  --port <port>        Use an explicit port (${PORT_MIN}-${PORT_MAX}) instead of the table.
  --worktree <path>    Worktree to open (default: current directory). Must
                       contain project.godot.
  --editor <exe>       Godot editor binary (default: \$GODOT_EDITOR or
                       ${DEFAULT_GODOT_EDITOR}).
  --foreground         Run in the foreground (do not background / redirect logs).
  -h, --help           Show this help and exit.

Environment:
  KOL_AGENT_NAME       Used when no agent-name argument is given.
  KOL_MCP_PORT         Used when no --port / agent-name is given. Priority over KOL_AGENT_NAME.
  KOL_WORKTREE         Default worktree when --worktree is not passed.
  GODOT_EDITOR         Default editor binary (overridden by --editor).

Agent -> port table:
  Atlas=6551  Archi=6552  Bachi=6553  Fronti=6554  Revy=6555  Refacty=6556
  (Chekky does not participate in MCP debugging.)

Logs:
  Background mode writes to ${MULTICA_DIR}/godot-editor-<agent>.log and a
  matching .pid file. Use --foreground to run attached.

Examples:
  start-godot-editor.sh Bachi
  start-godot-editor.sh --port 6551 --worktree /path/to/project
EOF
}

die() {
    echo "[start-godot-editor] ERROR: $*" >&2
    exit 1
}

# SEE-1152: stage timing helper. One stderr line per call with ISO wall-clock
# and ms-since-script-start. Default ON; KOL_STAGE_LOG=off silences.
_SGE_T0_MS="$(date +%s%3N)"
_sge_stage_log() {
    [[ "${KOL_STAGE_LOG:-on}" == "off" ]] && return 0
    local stage="$1" extra="${2:-}"
    local now_ms rel_ms iso
    now_ms="$(date +%s%3N)"
    rel_ms=$(( now_ms - _SGE_T0_MS ))
    iso="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
    echo "[start-godot-editor] [stage=${stage}] [t=+${rel_ms}ms] [ts=${iso}]${extra:+ $extra}" >&2
}

# Is the TCP port already bound? The editor is a Windows process, so we ask
# Windows first. Get-NetTCPConnection is more reliable than netstat.exe under
# WSL interop (netstat -ano frequently returns an empty connection list). We
# fall back to netstat.exe or Linux `ss` if PowerShell is unavailable.
port_in_use() {
    local p="$1"
    if [[ -n "${POWERSHELL:-}" ]]; then
        if "$POWERSHELL" -NoProfile -Command "if (Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" 2>/dev/null; then
            return 0
        fi
        return 1
    fi
    # Fall back to netstat.exe (WSL interop) for native-Linux/no-powershell.
    if command -v netstat.exe >/dev/null 2>&1; then
        # netstat.exe lines: TCP  <local>  <foreign>  LISTENING  <pid>
        local pattern=":${p}\\b"
        if netstat.exe -ano -p tcp 2>/dev/null | grep -E "LISTENING" | grep -qE "$pattern"; then
            return 0
        fi
        return 1
    fi
    if command -v ss >/dev/null 2>&1; then
        ss -H -tln 2>/dev/null | grep -qE ":${p}\\b"
        return $?
    fi
    # No tool available to check — assume free rather than block startup.
    echo "[start-godot-editor] WARNING: cannot find PowerShell/netstat.exe/ss; skipping port-conflict check." >&2
    return 1
}

# Convert a WSL path to a Windows path. Falls back to the original path when
# wslpath is unavailable (e.g. not running under WSL).
to_win_path() {
    local path="$1"
    if command -v wslpath >/dev/null 2>&1; then
        wslpath -w "$path"
    else
        echo "$path"
    fi
}

# Convert a WSL path to a Windows path when the editor is a Windows .exe.
# Mirrors the logic in .dev/tests/run_tests.sh.
to_editor_path() {
    local editor="$1" path="$2"
    case "$editor" in
        *.exe)
            to_win_path "$path"
            ;;
        *)
            echo "$path"
            ;;
    esac
}

# Launch the Godot editor into the interactive Windows session via Task
# Scheduler. WSL interop launches .exe into Session 0 (where the multica daemon
# runs), which has no desktop; Godot's D3D12 swap chain then fails repeatedly
# (ERR_CANT_CREATE) and the editor is unstable. A task with LogonType=
# InteractiveToken runs in the logged-in user's interactive session (e.g.
# Session 9), where the GPU is available and swap_chain errors are zero.
# Returns 0 on success, 1 if schtasks is unavailable or the run fails (caller
# falls back to the legacy nohup launch).
launch_via_schtasks() {
    local editor_wsl="$1" path_win="$2" log_win="$3" task_name="$4" runtime_id="${5:-${KOL_RUNTIME_ID:-solo}}"
    [[ -n "${POWERSHELL:-}" ]] || return 1

    local editor_win
    editor_win="$(wslpath -w "$editor_wsl" 2>/dev/null || echo "$editor_wsl")"

    # Transport the four dynamic values (UNC paths + task name) to PowerShell
    # via a values file, NOT environment variables. WSL interop does not forward
    # custom env vars to powershell.exe on this host (verified: prefix
    # assignment, `export`, and WSLENV all leave $env:VAR empty inside PS), so
    # the previous env-var design left /TN empty and schtasks /Create failed,
    # silently falling back to the Session-0 interop launch. Passing the values
    # on a -Command line is no better, because the backslashes in UNC paths get
    # re-parsed by PowerShell. A values file plus -File sidesteps both: bash
    # writes the paths verbatim, and PS reads them without shell re-parsing.
    # Each value goes on its own line; none of our paths contain newlines.
    local values_file ps_script
    values_file="$(mktemp /tmp/kol-schtasks-values.XXXXXX)" || return 1
    ps_script="$(mktemp /tmp/kol-schtasks.XXXXXX.ps1)" || { rm -f "$values_file"; return 1; }
    {
        printf '%s\n' "$editor_win"
        printf '%s\n' "$path_win"
        printf '%s\n' "$log_win"
        printf '%s\n' "$task_name"
        printf '%s\n' "$runtime_id"
    } >"$values_file"

    cat >"$ps_script" <<'PSEOF'
param([string]$ValuesFile)
$ErrorActionPreference = "Stop"
$v = Get-Content -LiteralPath $ValuesFile
if (-not $v -or $v.Count -lt 5) { exit 1 }
$editorWin = $v[0]
$pathWin   = $v[1]
$logWin    = $v[2]
$taskName  = $v[3]
$runtimeId = $v[4]

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if (-not $user) { exit 1 }
$userNode = "<UserId>" + [System.Security.SecurityElement]::Escape($user) + "</UserId>"
# cmd /c wraps the editor so its stdout/stderr redirect to the log file
# (Task Scheduler does not capture child output itself). The whole command
# is wrapped in one quoted block; the worktree/editor/log paths in this
# environment contain no spaces, so per-path quoting is unnecessary.
$rawArgs = "/c `"" + $editorWin + " --editor --path " + $pathWin + " --kol-mcp-lease --kol-mcp-runtime " + $runtimeId + " > " + $logWin + " 2>&1`""
$argsXml = [System.Security.SecurityElement]::Escape($rawArgs)
$xml = "<?xml version=`"1.0`" encoding=`"UTF-16`"?>" +
    "<Task xmlns=`"http://schemas.microsoft.com/windows/2004/02/mit/task`">" +
    "<Triggers />" +
    "<Principals><Principal>" + $userNode +
    "<LogonType>InteractiveToken</LogonType>" +
    "<RunLevel>LeastPrivilege</RunLevel></Principal></Principals>" +
    "<Settings><Enabled>true</Enabled>" +
    "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>" +
    "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>" +
    "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries></Settings>" +
    "<Actions><Exec><Command>cmd.exe</Command><Arguments>" + $argsXml +
    "</Arguments></Exec></Actions></Task>"
$tmp = [System.IO.Path]::GetTempFileName() + ".xml"
[System.IO.File]::WriteAllText($tmp, $xml, [System.Text.Encoding]::Unicode)
$null = schtasks /Create /TN $taskName /XML $tmp /F
if ($LASTEXITCODE -ne 0) { Remove-Item $tmp -ErrorAction SilentlyContinue; exit 2 }
$null = schtasks /Run /TN $taskName
$runOk = ($LASTEXITCODE -eq 0)

# The task definition is no longer needed once the editor process is
# running; /Delete does not terminate the already-running instance.
$null = schtasks /Delete /TN $taskName /F
Remove-Item $tmp -ErrorAction SilentlyContinue
if (-not $runOk) { exit 3 }
exit 0
PSEOF

    local values_win ps_win rc
    values_win="$(wslpath -w "$values_file" 2>/dev/null || echo "$values_file")"
    ps_win="$(wslpath -w "$ps_script" 2>/dev/null || echo "$ps_script")"
    "$POWERSHELL" -NoProfile -ExecutionPolicy Bypass -File "$ps_win" "$values_win" 1>&2
    rc=$?
    rm -f "$values_file" "$ps_script"
    return $rc
}

# SEE-1070 #5: structured diagnostic when the schtasks launch path fails,
# classifying the failure into the buckets documented in
# mcp-multi-port-usage.md §5 排错指南:
#   (B2) schtasks 启动失败   — /Create (rc 2) or /Run (rc 3) returned non-zero
#   (B1) 无 Windows 桌面会话 — schtasks unavailable / no interactive desktop
# The "editor 起了但渲染不稳" (A) case is NOT diagnosed here: it is detected
# post-launch by the proxy render-stable monitor (godot-mcp-proxy.mjs), which
# owns render stability. This function only classifies launch-time failures
# (editor never came up via the interactive session). It must never abort the
# script — the caller still falls back to the nohup interop launch — so every
# probe is default-guarded and the function always returns 0.
diagnose_launch_failure() {
    local rc="$1"
    local have_pwsh="no" have_desktop="unknown"
    if [[ -n "${POWERSHELL:-}" ]]; then
        have_pwsh="yes"
        # explorer.exe is the shell of a logged-in interactive desktop session;
        # absent => headless / Session-0 only (no GPU swap chain).
        local probe=""
        probe="$("$POWERSHELL" -NoProfile -Command \
            "if (Get-Process -Name explorer -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }" \
            2>/dev/null | tr -d '\r' | tail -n1)" || probe=""
        case "$probe" in
            yes) have_desktop="yes" ;;
            no)  have_desktop="no" ;;
            *)   have_desktop="unknown" ;;
        esac
    fi

    local bucket=""
    case "$rc" in
        2) bucket="schtasks 启动失败：/Create 非零（任务定义注册失败，多为 values 文件或当前用户身份问题）" ;;
        3) bucket="schtasks 启动失败：/Run 非零（任务已建但未运行，检查任务计划程序服务状态）" ;;
        1)
            if [[ "$have_pwsh" == "no" ]]; then
                bucket="schtasks 不可用：未找到 powershell.exe（无法进入交互 Windows 会话）"
            elif [[ "$have_desktop" == "no" ]]; then
                bucket="无 Windows 桌面会话：explorer.exe 缺失，当前无登录的交互桌面（编辑器将无 GPU / D3D12 swap chain）"
            else
                bucket="schtasks 启动失败：PowerShell 内部错误（rc=1，常见为用户身份或 values 文件读取异常）"
            fi
            ;;
        *) bucket="schtasks 启动失败：未知退出码 rc=${rc}" ;;
    esac

    {
        echo "[start-godot-editor] === 启动失败诊断（结构化） ==="
        echo "[start-godot-editor] powershell.exe    : ${have_pwsh}"
        echo "[start-godot-editor] windows 桌面会话  : ${have_desktop}  (explorer.exe 是否在交互会话)"
        echo "[start-godot-editor] schtasks 退出码   : ${rc}"
        echo "[start-godot-editor] 诊断结论          : ${bucket}"
        echo "[start-godot-editor] 渲染稳定性        : 由 proxy render-stable 监控负责（godot-mcp-proxy.mjs），本脚本不重复判定"
        echo "[start-godot-editor] 下一步            : 本次将退回 nohup interop（Session 0，可能渲染不稳）；持续失败见 mcp-multi-port-usage.md §5"
        echo "[start-godot-editor] ============================================"
    } >&2
    return 0
}

# --- Parse CLI ---------------------------------------------------------------
AGENT_NAME=""
EXPLICIT_PORT=""
WORKTREE_ARG=""
EDITOR_ARG=""
FOREGROUND=0

while (( $# > 0 )); do
    case "$1" in
        -h|--help)
            print_usage
            exit 0
            ;;
        --port)
            (( $# >= 2 )) || die "--port requires a value."
            EXPLICIT_PORT="$2"
            shift 2
            ;;
        --port=*)
            EXPLICIT_PORT="${1#--port=}"
            shift
            ;;
        --worktree)
            (( $# >= 2 )) || die "--worktree requires a value."
            WORKTREE_ARG="$2"
            shift 2
            ;;
        --worktree=*)
            WORKTREE_ARG="${1#--worktree=}"
            shift
            ;;
        --editor)
            (( $# >= 2 )) || die "--editor requires a value."
            EDITOR_ARG="$2"
            shift 2
            ;;
        --editor=*)
            EDITOR_ARG="${1#--editor=}"
            shift
            ;;
        --foreground)
            FOREGROUND=1
            shift
            ;;
        --)
            shift
            (( $# == 0 )) || die "Unexpected positional argument after '--': $1"
            ;;
        -*)
            die "Unknown option: $1 (run with --help)"
            ;;
        *)
            if [[ -z "$AGENT_NAME" ]]; then
                AGENT_NAME="$1"
            else
                die "Multiple agent names given ('$AGENT_NAME' and '$1'). Pass only one."
            fi
            shift
            ;;
    esac
done

# --- Resolve port (same precedence as configure-mcp-port.sh) -----------------
PORT=""
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

# --- Resolve worktree --------------------------------------------------------
WORKTREE="${WORKTREE_ARG:-${KOL_WORKTREE:-$(pwd)}}"
[[ -d "$WORKTREE" ]] || die "Worktree directory does not exist: $WORKTREE"
[[ -f "$WORKTREE/project.godot" ]] || die "No project.godot found in worktree: $WORKTREE (is it a Godot project root?)"

# --- Resolve editor binary ---------------------------------------------------
GODOT_EDITOR="${EDITOR_ARG:-${GODOT_EDITOR:-$DEFAULT_GODOT_EDITOR}}"
# drvfs mounts can report odd permission bits for .exe; test existence with -e.
{ [[ -e "$GODOT_EDITOR" ]] || command -v "$GODOT_EDITOR" >/dev/null 2>&1; } \
    || die "Godot editor binary not found: $GODOT_EDITOR (override with GODOT_EDITOR or --editor)."

# --- Resolve agent label (for log/pid filenames) -----------------------------
LABEL="$(agent_label_for_port "$PORT")"

# SEE-1148 P1: runtime_id = "<agent>-<hash8>" from the worktree path. Passed
# through KOL_RUNTIME_ID by the launcher/proxy; derived locally when this
# script is invoked standalone (manual start, tests). Empty slot hash outside
# a multica worktree degrades to "<agent>-solo".
if [[ -z "${KOL_RUNTIME_ID:-}" ]]; then
    KOL_RUNTIME_ID="$(kol_derive_runtime_id "${KOL_AGENT_NAME:-${LABEL}}" "${WORKTREE:-${KOL_WORKTREE:-$PWD}}")"
fi
export KOL_RUNTIME_ID

# SEE-1148 P1: lifecycle files move to ~/.multica/godot-editor/<runtime_id>.*
# so same-agent concurrent slots no longer clobber one shared per-agent set.
# F4 (Atlas P1 FAIL 修订决策): route ALL three lifecycle paths through the
# kol_lifecycle_path lib so writers and readers share ONE resolution rule
# (prefer directory form for non-solo runtime_ids, legacy flat for solo /
# pre-migration), instead of two divergent inline copies.
mkdir -p "$MULTICA_DIR/godot-editor"
LOG_FILE="$(kol_lifecycle_path ".log" "$LABEL" "$KOL_RUNTIME_ID")"
PID_FILE="$(kol_lifecycle_path ".pid" "$LABEL" "$KOL_RUNTIME_ID")"

# --- Port conflict check -----------------------------------------------------
_sge_stage_log PORT_PROBE_BEGIN "port=${PORT}"
_port_probe_t0="$(date +%s%3N)"
if port_in_use "$PORT"; then
    # SEE-1164 改进 2: enrich the die with the Windows-side owner of the bound
    # port so post-mortem analysis can distinguish "another live runtime holds
    # the port" from "orphan Listen socket left over from a Windows reboot"
    # (OwningProcess is 0 or refers to a long-dead PID). PowerShell is the
    # primary source (matches port_in_use above); if PowerShell is unavailable
    # or returns nothing, fall back to "unknown" rather than failing — this is
    # forensics for the die message, NOT a second gate.
    _port_owner_info="(owner: unknown — PowerShell unavailable or returned no rows)"
    if [[ -n "${POWERSHELL:-}" ]]; then
        _ps_out="$("$POWERSHELL" -NoProfile -Command "
\$conn = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (\$conn) {
    \$pidNum = \$conn.OwningProcess
    \$proc = Get-Process -Id \$pidNum -ErrorAction SilentlyContinue
    if (\$proc) {
        \$start = try { \$proc.StartTime.ToString('yyyy-MM-ddTHH:mm:sszzz') } catch { 'unknown' }
        Write-Output (\"pid=\$pidNum name=\$(\$proc.ProcessName) start=\$start\")
    } else {
        Write-Output (\"pid=\$pidNum name=<no-live-process> start=unknown\")
    }
}
" 2>/dev/null | tr -d '\r' | head -n 1)"
        if [[ -n "$_ps_out" ]]; then
            _port_owner_info="(owner: ${_ps_out})"
        fi
    fi
    die "Port ${PORT} is already in use. ${_port_owner_info} Another Godot editor or process is likely bound to it. \
Stop it first, or pick a different port. (log: ${LOG_FILE})"
fi
_port_probe_t1="$(date +%s%3N)"
_sge_stage_log PORT_PROBE_END "port=${PORT} free=true dt_ms=$(( _port_probe_t1 - _port_probe_t0 ))"

EDITOR_PATH="$(to_editor_path "$GODOT_EDITOR" "$WORKTREE")"

echo "[start-godot-editor] agent label : $LABEL"
echo "[start-godot-editor] runtime_id  : $KOL_RUNTIME_ID"
echo "[start-godot-editor] port        : $PORT"
echo "[start-godot-editor] worktree    : $WORKTREE"
echo "[start-godot-editor] editor path : $EDITOR_PATH"
echo "[start-godot-editor] editor bin  : $GODOT_EDITOR"
echo "[start-godot-editor] log file    : $LOG_FILE"

if (( FOREGROUND )); then
    echo "[start-godot-editor] Starting in foreground (Ctrl+C to stop)..."
    exec "$GODOT_EDITOR" --editor --path "$EDITOR_PATH" --kol-mcp-lease --kol-mcp-runtime "$KOL_RUNTIME_ID"
fi

# --- Background launch -------------------------------------------------------
echo "[start-godot-editor] Starting in background..."

rm -f "$LOG_FILE"
PID_KIND=""

if [[ "$GODOT_EDITOR" == *.exe ]] && [[ -n "$POWERSHELL" ]]; then
    # The schtasks cmd.exe runs in the interactive Windows session, which
    # CANNOT write to a WSL path (e.g. /home/jerry/.multica/...). Convert
    # the log path to a Windows path so cmd.exe's stdout redirect succeeds.
    LOG_WIN="$(wslpath -w "$LOG_FILE" 2>/dev/null || echo "$LOG_FILE")"
    _sge_stage_log SCHTASKS_BEGIN "task=kol-editor-${KOL_RUNTIME_ID}"
    _schtasks_t0="$(date +%s%3N)"
    if launch_via_schtasks "$GODOT_EDITOR" "$EDITOR_PATH" "$LOG_WIN" "kol-editor-${KOL_RUNTIME_ID}" "$KOL_RUNTIME_ID"; then
        _schtasks_t1="$(date +%s%3N)"
        _sge_stage_log SCHTASKS_END "ok=true dt_ms=$(( _schtasks_t1 - _schtasks_t0 ))"
        echo "[start-godot-editor] launched via Task Scheduler interactive session."
        # Resolve the real Windows PID ASYNCHRONOUSLY so this script does not
        # block the launcher exec (and thus the MCP initialize handshake). The
        # proxy answers initialize immediately; the Godot process keeps warming
        # up in parallel. A background subshell writes the PID to the pidfile
        # once CIM sees it; cleanup resolves by port if the file is still empty.
        EDITOR_BASENAME="$(basename "$GODOT_EDITOR")"
        (
            for _ in $(seq 1 30); do
                pid="$("$POWERSHELL" -NoProfile -Command \
                    "Get-CimInstance Win32_Process -Filter \"Name='${EDITOR_BASENAME}'\" -ErrorAction SilentlyContinue | Where-Object { \$_.CommandLine -like '*${EDITOR_PATH}*' } | Select-Object -First 1 -ExpandProperty ProcessId" \
                    2>/dev/null | tr -d '\r' | tail -n 1)"
                if [[ -n "$pid" ]]; then
                    echo "$pid" >"$PID_FILE"
                    exit 0
                fi
                sleep 1
            done
        ) >/dev/null 2>&1 &
        disown 2>/dev/null || true
        EDITOR_PID="pending"
        PID_KIND="schtasks"
        _sge_stage_log EDITOR_LAUNCH_TRIGGERED "pid_kind=schtasks pid=pending"
    else
        SCHTASKS_RC=$?
        _schtasks_t1="$(date +%s%3N)"
        _sge_stage_log SCHTASKS_END "ok=false rc=${SCHTASKS_RC} dt_ms=$(( _schtasks_t1 - _schtasks_t0 ))"
        diagnose_launch_failure "$SCHTASKS_RC"
        echo "[start-godot-editor] schtasks not available or failed (rc=${SCHTASKS_RC}); falling back to nohup interop." >&2
    fi
fi

if [[ "$PID_KIND" == "interop" || "$PID_KIND" == "" ]]; then
    # Fallback: nohup + WSL interop. This launches the Windows .exe into Session 0,
    # which has no desktop and can cause D3D12 swap_chain errors; use only when
    # schtasks is unavailable.
    rm -f "$LOG_FILE"
    nohup "$GODOT_EDITOR" --editor --path "$EDITOR_PATH" --kol-mcp-lease --kol-mcp-runtime "$KOL_RUNTIME_ID" >"$LOG_FILE" 2>&1 &
    INTEROP_PID=$!
    disown "$INTEROP_PID" 2>/dev/null || true
    EDITOR_PID="$INTEROP_PID"
    PID_KIND="interop"
    _sge_stage_log EDITOR_LAUNCH_TRIGGERED "pid_kind=interop pid=${INTEROP_PID}"
fi

# For the Windows .exe interop fallback, resolve the real Windows PID so the
# launcher can stop the actual editor process (killing the /init wrapper does
# not kill the Windows process). Done asynchronously to avoid blocking exec.
if [[ "$GODOT_EDITOR" == *.exe ]] && [[ -n "$POWERSHELL" ]] && [[ "$PID_KIND" == "interop" ]]; then
    EDITOR_BASENAME="$(basename "$GODOT_EDITOR")"
    (
        for _ in $(seq 1 30); do
            pid="$("$POWERSHELL" -NoProfile -Command \
                "Get-CimInstance Win32_Process -Filter \"Name='${EDITOR_BASENAME}'\" -ErrorAction SilentlyContinue | Where-Object { \$_.CommandLine -like '*${EDITOR_PATH}*' } | Select-Object -First 1 -ExpandProperty ProcessId" \
                2>/dev/null | tr -d '\r' | tail -n 1)"
            if [[ -n "$pid" ]]; then
                echo "$pid" >"$PID_FILE"
                exit 0
            fi
            sleep 1
        done
    ) >/dev/null 2>&1 &
    disown 2>/dev/null || true
fi

# Write an initial marker so callers see the pidfile exists; the background
# resolver overwrites it with the real Windows PID once CIM reports it.
[[ -f "$PID_FILE" ]] || echo "$EDITOR_PID" >"$PID_FILE"

# SEE-1129 (instance selection layer): record WHICH task slot's worktree the
# editor holding this agent port actually opened. Ports are allocated per agent
# NAME (agent-ports.json), so a same-agent concurrent session slot resolves to
# the SAME port+LABEL — and the proxy's reuse path would otherwise adopt the
# holder's Godot instance (which has the holder's project open) and serve the
# wrong worktree. This sidecar lets the proxy detect a foreign holder before
# reusing. Atomic (temp+rename) so a reader never sees a half-written value.
WORKTREE_FILE="$(kol_lifecycle_path ".worktree" "$LABEL" "$KOL_RUNTIME_ID")"
_tmp_wt="$(mktemp "${WORKTREE_FILE}.XXXXXX" 2>/dev/null)"
if [[ -n "$_tmp_wt" ]]; then
    printf '%s\n' "$WORKTREE" >"$_tmp_wt"
    mv -f "$_tmp_wt" "$WORKTREE_FILE"
else
    printf '%s\n' "$WORKTREE" >"$WORKTREE_FILE"
fi

echo "[start-godot-editor] Launched (${PID_KIND}). Tail logs with:"
echo "    tail -f \"$LOG_FILE\""

echo "[start-godot-editor] NOTE: run configure-mcp-port.sh first if this worktree's project.godot"
echo "           does not yet point port_override at ${PORT}."
