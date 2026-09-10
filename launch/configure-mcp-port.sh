#!/usr/bin/env bash
# Configure the godot-mcp WebSocket port for the current worktree.
#
# SEE-976: each agent gets a dedicated Godot editor MCP port so multiple
# agents can run their own editor instance in parallel without colliding on
# the default port 6550. After `multica repo checkout` drops an agent into a
# fresh worktree, run this script once to pin that worktree's MCP port.
#
# SEE-1117 Direction 3: project.godot NEVER holds runtime lease state. This
# script now writes a per-worktree sidecar lease file at
# <worktree>/.godot/mcp-lease.json (state=active, port=<agent port>). The
# addon reads that sidecar at editor startup via _load_lease_sidecar() and
# binds the recorded port. The sidecar lives under .godot/ (gitignored line 1)
# so it can never enter git — the push guard treats an active lease as a soft
# warning, never a hard block. The write-target guard is preserved so the
# shared D-drive master checkout is never written.
#
# This is the lease-START half of the sidecar lifecycle:
#   * lease start  — THIS script writes sidecar state=active.
#   * lease end    — restore-godot-original.sh sets state=released.
#   * verify       — verify-godot-written-back.sh checks state=released/absent.
#
# Usage:
#   configure-mcp-port.sh <agent-name>          # resolve port from the table
#   configure-mcp-port.sh --port <port>         # use an explicit port
#   configure-mcp-port.sh                       # read KOL_AGENT_NAME / KOL_MCP_PORT
#   configure-mcp-port.sh --help
#
# Args precedence (highest first):
#   1. explicit flags (--port / positional agent name)
#   2. KOL_MCP_PORT env var
#   3. KOL_AGENT_NAME env var (resolved via the table)
#
# Examples:
#   configure-mcp-port.sh Bachi          # -> port 6553
#   configure-mcp-port.sh --port 6551    # -> explicit port
#   KOL_AGENT_NAME=Atlas configure-mcp-port.sh
#
# The addon reads the sidecar at editor startup, so once this script has run
# the next editor launch listens on the recorded port.

set -euo pipefail

# Resolve script dir to locate the shared port-allocation source.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Per-agent port allocation — single source of truth is agent-ports.json
# (loaded via agent-ports.lib.sh); shared with godot-mcp-launcher.sh and
# start-godot-editor.sh. Chekky does not participate in MCP debugging.
# See mcp-multi-port-usage.md §2/§8.
# shellcheck source=agent-ports.lib.sh
source "$SCRIPT_DIR/agent-ports.lib.sh"

# SEE-1117: sidecar lease read/write helpers. configure writes the per-worktree
# .godot/mcp-lease.json sidecar (NOT project.godot).
# shellcheck source=mcp-sidecar.lib.sh
source "$SCRIPT_DIR/mcp-sidecar.lib.sh"

# SEE-1148 P1: derive the per-slot runtime_id so sidecar_write_active can
# stamp runtime_id / task_id (schema v2). Derives from the sidecar's own
# worktree anchor once that is resolved below; falls back to KOL_WORKTREE/PWD.
# shellcheck source=runtime.lib.sh
source "$SCRIPT_DIR/runtime.lib.sh"

# project.godot path resolution (shared with the marker lib) — still used as
# the anchor for locating the worktree root (sidecar lives in its .godot/ dir).
# shellcheck source=mcp-marker-section.lib.sh
source "$SCRIPT_DIR/mcp-marker-section.lib.sh"

print_usage() {
    cat <<'EOF'
Usage: configure-mcp-port.sh [agent-name] [--port <port>] [--project-godot <path>] [-h|--help]

Configure the godot-mcp WebSocket port for the current worktree by writing the
per-worktree sidecar lease file <worktree>/.godot/mcp-lease.json
(state=active, port=<port>). The sidecar is gitignored, so it never enters git.

Arguments:
  agent-name            Agent whose port to apply (case-sensitive). Resolved via
                        the built-in allocation table below. Chekky is
                        intentionally not in the table.
  --port <port>         Use an explicit port (6000-65535) instead of the table.
  --project-godot <path>
                        Path to project.godot (anchors the worktree root). May
                        be a file or a directory containing it. Defaults to the
                        nearest project.godot walking up from the current
                        directory. Equivalent to setting KOL_PROJECT_GODOT; the
                        flag wins.
  -h, --help            Show this help and exit.

Environment:
  KOL_AGENT_NAME   Used when no agent-name argument is given.
  KOL_MCP_PORT     Used when no --port / agent-name is given. Takes priority
                   over KOL_AGENT_NAME.
  KOL_PROJECT_GODOT
                   Path to project.godot. Overridden by --project-godot.

Agent -> port table:
  Atlas   = 6551
  Archi   = 6552
  Bachi   = 6553
  Fronti  = 6554
  Revy    = 6555
  Refacty = 6556
  (Chekky does not participate in MCP debugging.)

Examples:
  configure-mcp-port.sh Bachi
  configure-mcp-port.sh --port 6551
  configure-mcp-port.sh Bachi --project-godot /path/to/project.godot
  KOL_AGENT_NAME=Atlas configure-mcp-port.sh
EOF
}

die() {
    echo "[configure-mcp-port] ERROR: $*" >&2
    exit 1
}

# SEE-1152: stage timing helper. Emits one stderr line per call with an
# ISO-8601 wall-clock timestamp AND ms-since-script-start. Default ON; silence
# with KOL_STAGE_LOG=off. Format is machine-greppable (stage=<NAME> token).
_CFG_T0_MS="$(date +%s%3N)"
_cfg_stage_log() {
    [[ "${KOL_STAGE_LOG:-on}" == "off" ]] && return 0
    local stage="$1" extra="${2:-}"
    local now_ms rel_ms iso
    now_ms="$(date +%s%3N)"
    rel_ms=$(( now_ms - _CFG_T0_MS ))
    iso="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
    echo "[configure-mcp-port] [stage=${stage}] [t=+${rel_ms}ms] [ts=${iso}]${extra:+ $extra}" >&2
}

# project.godot location is resolved by mcp-marker-section.lib.sh's
# mcp_find_project_godot() (honors KOL_PROJECT_GODOT, else walks up from CWD).
# We reuse it as the worktree anchor; configure no longer edits project.godot.

# Parse CLI.
AGENT_NAME=""
EXPLICIT_PORT=""
EXPLICIT_PROJECT_GODOT=""
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
        --project-godot)
            (( $# >= 2 )) || die "--project-godot requires a value."
            EXPLICIT_PROJECT_GODOT="$2"
            shift 2
            ;;
        --project-godot=*)
            EXPLICIT_PROJECT_GODOT="${1#--project-godot=}"
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

# Resolve final port. Precedence: --port flag > env port (GODOT_MCP_PORT, then
# KOL_MCP_PORT legacy alias) > agent name (arg or KOL_AGENT_NAME) via the table.
PORT=""
if [[ -n "$EXPLICIT_PORT" ]]; then
    PORT="$EXPLICIT_PORT"
elif [[ -n "${GODOT_MCP_PORT:-}" ]]; then
    PORT="$GODOT_MCP_PORT"
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

# Set the project.godot target so find_project_godot() is deterministic even when
# spawned from a non-project cwd (e.g. the workdir root). CLI flag wins over env.
# configure uses project.godot only as a worktree anchor; it does NOT edit it.
if [[ -n "$EXPLICIT_PROJECT_GODOT" ]]; then
    KOL_PROJECT_GODOT="$EXPLICIT_PROJECT_GODOT"
    export KOL_PROJECT_GODOT
fi

PROJECT_GODOT="$(mcp_find_project_godot)"
LEASE_FILE="$(sidecar_path_for "$PROJECT_GODOT")"

echo "[configure-mcp-port] project.godot  : $PROJECT_GODOT"
echo "[configure-mcp-port] sidecar lease : $LEASE_FILE"
echo "[configure-mcp-port] target port   : $PORT"

# --- SEE-1111 §7.1 防线 3: write-target guard ---
# configure MUST only ever write the agent's PRIVATE worktree sidecar. If
# resolution falls on the shared D-drive master checkout (or any checkout on
# branch master), fail fast instead of writing a lease there. SEE-1111 root
# cause was exactly this kind of cross-worktree write; this guard makes it
# impossible from the write side even if worktree resolution still lands on
# the shared checkout.
guard_write_target() {
    local target="$1"
    # Fail-fast on the known shared D-drive master checkout (absolute path).
    # §4.5.3 T2 / K5: guard only engages when the env provides the shared path.
    local known_shared="${GODOT_MCP_SHARED_MASTER:-}"
    local target_dir
    target_dir="$(dirname "$target")"
    if [[ "$target_dir" == "$known_shared" || "$target_dir" == "$known_shared/"* ]]; then
        die "write-target guard: '$target' is the SHARED master checkout. Refusing to write a lease there — each agent must configure its PRIVATE worktree (see mcp-multi-port-usage.md §3.7/§7.1)."
    fi
    # Fail-fast when the target checkout is on branch master (covers any other
    # master checkout, e.g. a differently-mounted path to the same repo).
    if command -v git >/dev/null 2>&1 && [[ -d "$target_dir/.git" ]]; then
        local branch
        branch="$(git -C "$target_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
        if [[ "$branch" == "master" ]]; then
            die "write-target guard: '$target' is a checkout on branch 'master'. Refusing to write a lease in a master checkout — agents must configure their PRIVATE worktree (mcp-multi-port-usage.md §3.7/§7.1)."
        fi
    fi
}

guard_write_target "$PROJECT_GODOT"

# SEE-1129 boundary case #2/#9: reap stale leases from prior abnormal exits
# (SIGKILL / OOM / crash / daemon kill -9) BEFORE writing this run's lease. A
# stale state=active sidecar whose owner PID is dead would otherwise leave the
# port notionally "in use" and confuse the proxy's reuse path. The reaper is
# idempotent + safe (only releases sidecars whose owner is provably gone), so
# calling it on every configure is cheap insurance. Failures are non-fatal —
# configure proceeds even if the reaper cannot run (e.g. node missing).
#
# SEE-1152: default ASYNC. The reaper costs 15–45s per invocation on a busy
# box (three pwsh Get-CimInstance sweeps) and was being paid TWICE per cold
# start — once via prepare-worktree.sh's internal configure call, once via
# the proxy's explicit configure call — totalling ~154s of the 300s window.
# Because EVERY configure across ALL runtimes still invokes the reaper (just
# without blocking), a stale lease is still picked up by the next configure
# anywhere in the workspace; on a busy multi-agent box that is far more
# frequent than the (undeployed) 5-min resident-reaper timer. We therefore
# trade "this configure waits for a clean slate" for "some configure soon
# after cleans the slate", and keep the stale-lease invariant eventual.
# Rollback / debug: KOL_CONFIGURE_SYNC_REAPER=1 restores the old sync wait.
REAPER="$SCRIPT_DIR/reap-stale-leases.sh"
if [[ -x "$REAPER" ]]; then
    # SEE-1240 D1: converge the configure-triggered sweep from the whole
    # multica_workspaces tree to the worktrees the port registry actually
    # knows. A full-tree find races every concurrent runtime's sidecar
    # mktemp+mv publish (find enumerates a path, the writer renames it, the
    # reaper's read hits a transient failure — the window behind D1's
    # mis-quarantine, now also non-destructive after the corrupt-branch
    # accounting). Registry-known worktrees are exactly the runtimes that can
    # own a live lease on this machine; worktrees absent from the registry
    # still get swept by the resident reaper / explicit wide-root runs.
    _reaper_args=()
    if [[ -f "${KOL_PORT_REGISTRY_PATH_OVERRIDE:-${HOME}/.multica/godot-port-registry.json}" ]]; then
        while IFS= read -r _rr; do
            [[ -n "$_rr" && -d "$_rr" ]] && _reaper_args+=("--root" "$_rr")
        done < <(node -e '
const fs = require("fs");
try {
    const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const seen = new Set();
    for (const e of Object.values(o.entries || {})) {
        if (e && typeof e.worktree === "string" && e.worktree && !seen.has(e.worktree)) {
            seen.add(e.worktree);
            process.stdout.write(e.worktree + "\n");
        }
    }
} catch (err) { /* registry unreadable → no scoped roots; fall back below */ }
' "${KOL_PORT_REGISTRY_PATH_OVERRIDE:-${HOME}/.multica/godot-port-registry.json}" 2>/dev/null || true)
    fi
    if [[ ${#_reaper_args[@]} -eq 0 ]]; then
        # Registry absent/unreadable → no scoped roots; run wide (availability
        # over scope — the corrupt-branch accounting makes a residual race
        # non-destructive).
        _reaper_args=()
    fi
    if [[ "${KOL_CONFIGURE_SYNC_REAPER:-0}" == "1" ]]; then
        _cfg_stage_log REAPER_SYNC_BEGIN
        _reap_t0="$(date +%s%3N)"
        "$REAPER" "${_reaper_args[@]}" >/dev/null 2>&1 || true
        _reap_t1="$(date +%s%3N)"
        _cfg_stage_log REAPER_SYNC_END "dt_ms=$(( _reap_t1 - _reap_t0 ))"
    else
        _cfg_stage_log REAPER_ASYNC_BEGIN
        # Detach fully: setsid moves the reaper into its own session so the
        # parent bash does NOT wait for it at exit (non-interactive bash waits
        # for ALL children, disowned or not, before reaping its own exit —
        # SEE-1152 measured a bare `( ... ) & disown` still blocking ~75s).
        # stdin/stdout/stderr all redirected so the reaper holds no pipe the
        # caller might be reading.
        if command -v setsid >/dev/null 2>&1; then
            setsid "$REAPER" "${_reaper_args[@]}" </dev/null >/dev/null 2>&1 &
        else
            # Fallback: nohup + subshell; still better than sync.
            nohup "$REAPER" "${_reaper_args[@]}" </dev/null >/dev/null 2>&1 &
        fi
        disown
        _cfg_stage_log REAPER_ASYNC_END "pid=$!"
    fi
    unset _reaper_args _rr
fi

# Fast path: if the sidecar is already state=active with the same port AND
# carries no stale release traces, no write is needed. lease_id is left
# untouched (a no-op must NOT regenerate it — Archi Suite A2 oracle).
#
# SEE-1152 目标4 hotfix: a *stale-traces* check is mandatory. A proxy that
# timed out on the previous attempt writes state=released + released_at (and
# may set intentional_release=true) moments before the next cold start's
# prepare-worktree invokes us. If we then blindly flip state back to active
# WITHOUT clearing released_at / intentional_release, the addon's
# _load_lease_sidecar() reads a lease that LOOKS active but is timestamped
# "released 25s ago" — its grace logic rejects it and the editor falls back
# to binding the default port 6550 (observed live: replay at 03:03, editor
# bound 6550 while proxy probed 6553 → 300s warmup timeout). Clearing the
# traces here (same lease_id, refreshed configured_at) makes the lease
# unambiguously fresh again.
cur_state=""
cur_port=""
cur_released_at=""
cur_intentional=""
cur_lease_id=""
if [[ -f "$LEASE_FILE" ]]; then
    cur_state="$(sidecar_get "$LEASE_FILE" state)"
    cur_port="$(sidecar_get "$LEASE_FILE" port)"
    cur_released_at="$(sidecar_get "$LEASE_FILE" released_at)"
    cur_intentional="$(sidecar_get "$LEASE_FILE" intentional_release)"
    cur_lease_id="$(sidecar_get "$LEASE_FILE" lease_id)"
fi
if [[ "$cur_state" == "$SIDECAR_STATE_ACTIVE" && "$cur_port" == "$PORT" \
      && ( -z "$cur_released_at" || "$cur_released_at" == "null" ) \
      && "$cur_intentional" != "true" ]]; then
    echo "[configure-mcp-port] Fast path: sidecar already active on port=${PORT}, no stale release traces (lease_id unchanged)."
    exit 0
fi
if [[ "$cur_state" == "$SIDECAR_STATE_ACTIVE" && "$cur_port" == "$PORT" ]]; then
    _cfg_stage_log LEASE_TRACES_CLEARED "released_at=${cur_released_at:-none} intentional=${cur_intentional:-none}"
    echo "[configure-mcp-port] Sidecar state=active port=${PORT} but carries stale release traces (released_at=${cur_released_at:-none}, intentional_release=${cur_intentional:-none}); rewriting to clear them (lease_id preserved)."
fi

# Write the sidecar lease (state=active). Atomic: mktemp + chmod + mv.
# SEE-1148 P1: stamp the per-slot runtime_id (schema v2) so the sidecar
# carries the identity the port layer uses to tell same-agent slots apart.
if [[ -z "${KOL_RUNTIME_ID:-}" ]]; then
    _CFG_WT="$(dirname "$(sidecar_path_for "$PROJECT_GODOT")")"
    KOL_RUNTIME_ID="$(kol_derive_runtime_id "${AGENT_NAME:-${KOL_AGENT_NAME:-}}" "${_CFG_WT%/\.godot}")"
    export KOL_RUNTIME_ID
fi
# SEE-1152 hotfix: when we are rewriting an already-active lease solely to
# clear stale release traces, preserve the existing lease_id (identity must
# survive a cleanup rewrite — Archi Suite A2 oracle). A fresh lease write
# leaves KOL_KEEP_LEASE_ID unset → new uuid, historical behavior.
if [[ "$cur_state" == "$SIDECAR_STATE_ACTIVE" && "$cur_port" == "$PORT" && -n "$cur_lease_id" ]]; then
    export KOL_KEEP_LEASE_ID="$cur_lease_id"
fi
sidecar_write_active "$PROJECT_GODOT" "$PORT" "${AGENT_NAME:-${KOL_AGENT_NAME:-}}" >/dev/null
unset KOL_KEEP_LEASE_ID
echo "[configure-mcp-port] runtime_id: ${KOL_RUNTIME_ID}"

# SEE-1240 WS-8: machine-level bind settings (bind_mode / custom_bind_ip) live
# in project.godot's static [godot_mcp] section — deployment-topology
# constants committed once, not per-agent runtime state. The WS-1 override.cfg
# channel is retired: Godot 4.6.2's ProjectSettings loader does not read
# override.cfg on a WSL UNC project path (Fronti WS-3 实锤, SEE-1070 NO-GO
# same source), so it never bound WSL in this deployment. Nothing to write
# here anymore — configure remains sidecar-lease-only.

echo "[configure-mcp-port] Done. sidecar active on port=${PORT}."
echo "[configure-mcp-port] Launch the Godot editor next; the addon will read the sidecar and listen on this port."
