#!/bin/bash
# env.sh — centralized deployment-variable layer (SEE-1268 §4.5.3 T2 +
# SEE-1292 §DECPL: state-dir + full control-plane env neutralization).
#
# Sourcing order / override precedence (highest wins):
#   1. process environment (caller may export BEFORE sourcing this file —
#      canonical GODOT_MCP_* first, then legacy KOL_*/MULTICA_* aliases)
#   2. defaults below (probe-failure fallbacks, never wrong KOL values)
#
# K5 / SEE-1292 §DECPL-002 rule: every control-plane variable has a canonical
# name GODOT_MCP_*. The KOL_* / MULTICA_* legacy names are deprecated one round
# (backcompat) and alias onto the canonical name via the precedence chain:
#   explicit GODOT_MCP_* > legacy KOL_*/MULTICA_* alias > in-repo default.
# An explicit canonical value is NEVER overwritten by a stale legacy alias.

# --- SEE-1292 §DECPL-001: configurable state directory -----------------------
# ALL runtime state (port registry, lifecycle files, held dirs, logs, tools
# cache) resolves under GODOT_MCP_HOME. Default = a NEUTRAL path, not the KOL
# name. The Multica deployment injects GODOT_MCP_HOME="$HOME/.multica" from the
# caller's env file to keep live production state byte-continuous — this fork
# never hardcodes either path.
export GODOT_MCP_HOME="${GODOT_MCP_HOME:-${HOME}/.config/godot-mcp}"

# --- Shared D-drive master checkout (was SHARED_MASTER_WORKTREE in launcher /
# proxy / configure / prepare-worktree). Default = unset; K5 probe-failure
# semantics downstream. KOL_SHARED_MASTER legacy alias fills it only when the
# canonical is empty. KOL_SHARED_MASTER read must tolerate `set -u`.
GODOT_MCP_SHARED_MASTER="${GODOT_MCP_SHARED_MASTER:-}"
if [ -z "${GODOT_MCP_SHARED_MASTER:-}" ] && [ -n "${KOL_SHARED_MASTER:-}" ]; then
  GODOT_MCP_SHARED_MASTER="$KOL_SHARED_MASTER"
fi
export GODOT_MCP_SHARED_MASTER

# Workdir checkout dirname under multica workspaces (was literal
# KingOfLikes-Godot in launcher). Precedence: explicit canonical > KOL alias >
# repo-agnostic default.
GODOT_MCP_REPO_DIRNAME="${GODOT_MCP_REPO_DIRNAME:-}"
if [ -z "${GODOT_MCP_REPO_DIRNAME:-}" ] && [ -n "${KOL_REPO_DIRNAME:-}" ]; then
  GODOT_MCP_REPO_DIRNAME="$KOL_REPO_DIRNAME"
fi
export GODOT_MCP_REPO_DIRNAME="${GODOT_MCP_REPO_DIRNAME:-KingOfLikes-Godot}"

# multica workspaces base (was literal ~/multica_workspaces in launcher /
# runtime.lib slot-hash parsing).
GODOT_MCP_WORKSPACES_BASE="${GODOT_MCP_WORKSPACES_BASE:-}"
if [ -z "${GODOT_MCP_WORKSPACES_BASE:-}" ] && [ -n "${KOL_WORKSPACES_BASE:-}" ]; then
  GODOT_MCP_WORKSPACES_BASE="$KOL_WORKSPACES_BASE"
fi
export GODOT_MCP_WORKSPACES_BASE="${GODOT_MCP_WORKSPACES_BASE:-${HOME}/multica_workspaces}"

# Fork's own node CLI (was FORK_CLI in launcher / proxy — an absolute machine
# path; default derives from this library's own location). Explicit
# GODOT_MCP_FORK_CLI is the single override seam (SEE-1292 §DECPL-003).
GODOT_MCP_FORK_CLI="${GODOT_MCP_FORK_CLI:-}"
if [ -z "${GODOT_MCP_FORK_CLI:-}" ] && [ -n "${KOL_FORK_CLI:-}" ]; then
  GODOT_MCP_FORK_CLI="$KOL_FORK_CLI"
fi
export GODOT_MCP_FORK_CLI

# --- SEE-1292 §DECPL-002: full control-plane env neutralization --------------
# Every remaining KOL_*/MULTICA_* control-plane variable consumed by the
# launcher/proxy/shim resolved the same way: explicit canonical wins, else the
# legacy alias (only when canonical is unset), else the consumer's own
# default. Rounding K5 aliases onto canonical names:
#   KOL_*      → GODOT_MCP_*   (e.g. KOL_WORKTREE → GODOT_MCP_WORKTREE)
#   MULTICA_*  → GODOT_MCP_*   (e.g. MULTICA_AGENT_NAME → GODOT_MCP_AGENT_NAME)
# A helper maps legacy env into the canonical export when the canonical is unset.
_kol_alias_export() { # <canonical> <legacy...>
  local canon="$1"; shift
  if [ -z "${!canon:-}" ]; then
    local a
    for a in "$@"; do
      if [ -n "${!a:-}" ]; then
        export "$canon=${!a}"
        return
      fi
    done
  fi
}
_kol_alias_export GODOT_MCP_AGENT_NAME      KOL_AGENT_NAME      MULTICA_AGENT_NAME   CLAUDE_AGENT_NAME
_kol_alias_export GODOT_MCP_RUNTIME_ID      KOL_RUNTIME_ID
_kol_alias_export GODOT_MCP_WORKTREE        KOL_WORKTREE
_kol_alias_export GODOT_MCP_PROJECT_GODOT   KOL_PROJECT_GODOT
_kol_alias_export GODOT_MCP_MCP_PORT        KOL_MCP_PORT
_kol_alias_export GODOT_MCP_PORT            KOL_MCP_PORT
_kol_alias_export GODOT_MCP_GODOT_MCP_CMD   KOL_GODOT_MCP_CMD
_kol_alias_export GODOT_MCP_DIRECT_GODOT_MCP KOL_DIRECT_GODOT_MCP
_kol_alias_export GODOT_MCP_CONFIGURE_SH    KOL_CONFIGURE_SH
_kol_alias_export GODOT_MCP_START_SH        KOL_START_SH
_kol_alias_export GODOT_MCP_STOP_SH         KOL_STOP_SH
_kol_alias_export GODOT_MCP_REAP_SH         KOL_REAP_SH
_kol_alias_export GODOT_MCP_PREPARE_SH      KOL_PREPARE_SH
_kol_alias_export GODOT_MCP_PORT_REGISTRY_PATH GODOT_MCP_PORT_REGISTRY_PATH_OVERRIDE KOL_PORT_REGISTRY_PATH_OVERRIDE
_kol_alias_export GODOT_MCP_PORT_REGISTRY_PATH_OVERRIDE KOL_PORT_REGISTRY_PATH_OVERRIDE
_kol_alias_export GODOT_MCP_WORKSPACE_ID    MULTICA_WORKSPACE_ID
_kol_alias_export GODOT_MCP_AGENT_ID        MULTICA_AGENT_ID
_kol_alias_export GODOT_MCP_WORKSPACES_BASE_OVERRIDE KOL_WORKSPACES_BASE
_kol_alias_export GODOT_MCP_WORKTREE_WAIT_S KOL_WORKTREE_WAIT_S
_kol_alias_export GODOT_MCP_PROGRESS_PROTOCOL KOL_PROGRESS_PROTOCOL
_kol_alias_export GODOT_MCP_STAGE_LOG       KOL_STAGE_LOG
_kol_alias_export GODOT_MCP_FROM_SHIM       KOL_FROM_SHIM
_kol_alias_export GODOT_MCP_SHIM_RECHAIN_MAX KOL_SHIM_RECHAIN_MAX
_kol_alias_export GODOT_MCP_SHIM_REFRESH_MS KOL_SHIM_REFRESH_MS
_kol_alias_export GODOT_MCP_TASK_ID         KOL_TASK_ID
_kol_alias_export GODOT_MCP_HEARTBEAT_INTERVAL_MS KOL_HEARTBEAT_INTERVAL_MS
_kol_alias_export GODOT_MCP_PROBE_INTERVAL_MS KOL_PROBE_INTERVAL_MS
_kol_alias_export GODOT_MCP_PROGRESS_INTERVAL_MS KOL_PROGRESS_INTERVAL_MS

# T2-M1 (Revy QA): every resolved GODOT_MCP_* var MUST be exported. The
# launcher `exec`s the proxy as a child process, and an alias-derived assignment
# (KOL_* → GODOT_MCP_*) creates only a SHELL variable — invisible to the child,
# silently emptying the proxy's guards (§7.1 防线 3 fail-open). export is
# idempotent for caller-exported values, so this changes nothing for the
# canonical path while fixing the legacy-alias path.
export GODOT_MCP_SHARED_MASTER GODOT_MCP_REPO_DIRNAME GODOT_MCP_WORKSPACES_BASE GODOT_MCP_FORK_CLI