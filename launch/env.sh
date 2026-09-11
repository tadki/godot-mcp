#!/bin/bash
# env.sh — centralized deployment-variable layer (SEE-1268 §4.5.3 T2).
#
# Sourcing order / override precedence (highest wins):
#   1. process environment (caller may export before launching)
#   2. KOL_* legacy aliases (backward compat for existing KOL callers)
#   3. GODOT_MCP_* canonical defaults below
#
# K5 rule: defaults must be "probe-failure fallbacks", never wrong KOL values —
# the KOL repo injects its own values via .dev/env/kol-mcp.env (T3).

# Shared D-drive master checkout (was SHARED_MASTER_WORKTREE in launcher :224 /
# proxy :2218 / configure :227 / prepare-worktree :142). Default = unset:
# consumers that need it must provide it; probe-failure semantics downstream.
: "${GODOT_MCP_SHARED_MASTER:=}"
# KOL_SHARED_MASTER read must tolerate `set -u` in the sourcing launcher — use
# default-only expansion, not a bare read.
: "${KOL_SHARED_MASTER:-}"
if [ -z "${GODOT_MCP_SHARED_MASTER:-}" ] && [ -n "${KOL_SHARED_MASTER:-}" ]; then
  GODOT_MCP_SHARED_MASTER="$KOL_SHARED_MASTER"
fi

# Workdir checkout dirname under multica workspaces (was literal
# KingOfLikes-Godot in launcher :303,362,418,458,466,482,491).
# Precedence (K5): explicit canonical > KOL legacy alias > repo-agnostic default.
: "${GODOT_MCP_REPO_DIRNAME:=${KOL_REPO_DIRNAME:-KingOfLikes-Godot}}"

# multica workspaces base (was literal ~/multica_workspaces in launcher :322-323
# and runtime.lib slot-hash parsing).
: "${GODOT_MCP_WORKSPACES_BASE:=${HOME}/multica_workspaces}"

# Fork's own node CLI (was FORK_CLI in launcher :920 / proxy :836 — an absolute
# machine path; default derives from this library's own location).
: "${GODOT_MCP_FORK_CLI:=}"

# T2-M1 (Revy QA): every resolved GODOT_MCP_* var MUST be exported. The
# launcher `exec`s the proxy as a child process, and an alias-derived assignment
# (KOL_* → GODOT_MCP_*) creates only a SHELL variable — invisible to the child,
# silently emptying the proxy's isSharedMasterWorktree guard (§7.1 防线 3
# fail-open). export is idempotent for caller-exported values, so this changes
# nothing for the canonical path while fixing the legacy-alias path.
export GODOT_MCP_SHARED_MASTER GODOT_MCP_REPO_DIRNAME GODOT_MCP_WORKSPACES_BASE GODOT_MCP_FORK_CLI
