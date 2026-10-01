#!/usr/bin/env bash
# SEE-1273 T2 — launch/ decoupling parameterization regression suite.
#
# Verifies the §4.5.3 T2 contract:
#   AC-M3REORG-003 (params TDD): each parameterized variable has
#     (a) default-value case, (b) env-override case, (c) KOL_ legacy-alias case;
#   slot parsing: see-<issue>-<hash12> AND bare hash8 both resolve;
#   legacy function aliases (kol_slot_hash_for, kol_runtime_id_regex, ...) work;
#   isGodotWorktree dual-location probe (project.godot + root launch/ OR
#     legacy .dev/godot-mcp/launch) is exercised for both layouts.
#
# Pure-bash: forks a fresh subshell per source so exports from one case never
# leak into another. Exits non-zero on any failure.
set -uo pipefail

LAUNCH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd ../launch && pwd)"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# A helper that sources env.sh+runtime.lib.sh inside a fresh subshell with a
# given env preamble, prints a given command's output.
probe() { # <env-preamble> ; <command>
    local pre="$1"; shift
    if [[ -n "$pre" ]]; then
        bash -c "export $pre; . '$LAUNCH/env.sh'; . '$LAUNCH/runtime.lib.sh'; $*"
    else
        bash -c ". '$LAUNCH/env.sh'; . '$LAUNCH/runtime.lib.sh'; $*"
    fi
}

echo "== 1. GODOT_MCP_REPO_DIRNAME: default / env-override / KOL alias =="
# (a) default = KingOfLikes-Godot
r="$(probe '' 'printf "%s" "$GODOT_MCP_REPO_DIRNAME"')"
[[ "$r" == "KingOfLikes-Godot" ]] && ok "default repo dirname = KingOfLikes-Godot" || bad "default repo dirname = '$r'"
# (b) env override
r="$(probe "GODOT_MCP_REPO_DIRNAME=MyRepo" 'printf "%s" "$GODOT_MCP_REPO_DIRNAME"')"
[[ "$r" == "MyRepo" ]] && ok "env override repo dirname = MyRepo" || bad "env override repo dirname = '$r'"
# (c) KOL alias
r="$(probe "KOL_REPO_DIRNAME=AliasedRepo" 'printf "%s" "$GODOT_MCP_REPO_DIRNAME"')"
[[ "$r" == "AliasedRepo" ]] && ok "KOL_REPO_DIRNAME alias => AliasedRepo" || bad "KOL alias repo dirname = '$r'"
# env beats alias
r="$(probe "KOL_REPO_DIRNAME=Alias GODOT_MCP_REPO_DIRNAME=Canon" 'printf "%s" "$GODOT_MCP_REPO_DIRNAME"')"
[[ "$r" == "Canon" ]] && ok "direct env beats KOL alias" || bad "env-vs-alias precedence = '$r'"

echo "== 2. GODOT_MCP_SHARED_MASTER: default / env / KOL alias =="
# (a) default unset (K5 probe-failure fallback) — env.sh sets it to the empty
# string (consumers treat empty as "not provided").
r="$(probe '' 'printf "%s" "${GODOT_MCP_SHARED_MASTER-<unset>}"')"
[[ "$r" == "" ]] && ok "default shared master empty (K5 probe-failure)" || bad "default shared master = '$r'"
# (b) env override
r="$(probe 'GODOT_MCP_SHARED_MASTER=/custom/master' 'printf "%s" "$GODOT_MCP_SHARED_MASTER"')"
[[ "$r" == "/custom/master" ]] && ok "env override shared master" || bad "env shared master = '$r'"
# (c) KOL alias
r="$(probe 'KOL_SHARED_MASTER=/kol/master' 'printf "%s" "$GODOT_MCP_SHARED_MASTER"')"
[[ "$r" == "/kol/master" ]] && ok "KOL_SHARED_MASTER alias => /kol/master" || bad "KOL shared alias = '$r'"

echo "== 3. GODOT_MCP_WORKSPACES_BASE: default / env =="
# (a) default derives from $HOME
r="$(probe '' 'printf "%s" "$GODOT_MCP_WORKSPACES_BASE"')"
[[ "$r" == "$HOME/multica_workspaces" ]] && ok "default ws base = \$HOME/multica_workspaces" || bad "default ws base = '$r'"
# (b) env override
r="$(probe 'GODOT_MCP_WORKSPACES_BASE=/mnt/ws' 'printf "%s" "$GODOT_MCP_WORKSPACES_BASE"')"
[[ "$r" == "/mnt/ws" ]] && ok "env override ws base" || bad "env ws base = '$r'"

echo "== 4. mcp_slot_hash_for: see-<issue>-<hash12> AND bare hash8 =="
r="$(probe '' 'mcp_slot_hash_for "$HOME/multica_workspaces/seed-ws/see-1273-38dc1c167594/workdir/KingOfLikes-Godot"')"
[[ "$r" == "38dc1c167594" ]] && ok "see-<issue>-<hash12> -> 38dc1c167594" || bad "see-<hash12> = '$r'"
r="$(probe '' 'mcp_slot_hash_for "$HOME/multica_workspaces/seed-ws/5d621003/workdir/KingOfLikes-Godot"')"
[[ "$r" == "5d621003" ]] && ok "bare hash8 -> 5d621003" || bad "bare hash8 = '$r'"
# custom base + repo dirname via env
r="$(probe 'GODOT_MCP_WORKSPACES_BASE=/custom GODOT_MCP_REPO_DIRNAME=Other' 'mcp_slot_hash_for "/custom/ws/see-9-abcdef012345/workdir/Other"')"
[[ "$r" == "abcdef012345" ]] && ok "custom base + repo dirname parse" || bad "custom base parse = '$r'"

echo "== 5. legacy aliases still resolve =="
[[ "$(probe '' 'kol_slot_hash_for "$HOME/multica_workspaces/seed-ws/5d621003/workdir/KingOfLikes-Godot"')" == "5d621003" ]] && ok "kol_slot_hash_for alias" || bad "kol_slot_hash_for alias"
[[ "$(probe '' 'kol_runtime_id_regex')" == '^[A-Za-z][A-Za-z0-9_-]*-[0-9a-f]{8,}$' ]] && ok "kol_runtime_id_regex alias" || bad "kol_runtime_id_regex alias"
[[ "$(probe '' 'kol_derive_runtime_id Bachi "$HOME/multica_workspaces/seed-ws/5d621003/workdir/KingOfLikes-Godot"')" == "Bachi-5d621003" ]] && ok "kol_derive_runtime_id alias" || bad "kol_derive_runtime_id alias"

echo "== 6. isGodotWorktree multi-location probe (proxy helper, static re-implementation) =="
# Exercise the SAME predicate shape the proxy now uses: project.godot present,
# and ANY of root launch/ / legacy .dev/godot-mcp/launch / addons/godot_mcp/launch.
mkproj() { local d="$1"; mkdir -p "$d"; echo 'config_version=5' > "$d/project.godot"; }
probe_iswt() { # <dir> -> 1 if worktree
    local dir="$1"
    [[ -f "$dir/project.godot" ]] || return 1
    { [[ -d "$dir/launch" ]] || [[ -d "$dir/.dev/godot-mcp/launch" ]] || [[ -d "$dir/addons/godot_mcp/launch" ]]; }
}
tmp="$(mktemp -d)"
( cd "$tmp" && mkproj root-layout && mkdir -p root-layout/launch && probe_iswt "$tmp/root-layout" ) && ok "root launch/ layout recognized" || bad "root launch/ layout"
( cd "$tmp" && mkproj legacy-layout && mkdir -p legacy-layout/.dev/godot-mcp/launch && probe_iswt "$tmp/legacy-layout" ) && ok "legacy .dev/godot-mcp/launch layout recognized" || bad "legacy layout"
( cd "$tmp" && mkproj submod-layout && mkdir -p submod-layout/addons/godot_mcp/launch && probe_iswt "$tmp/submod-layout" ) && ok "post-T4 addons/godot_mcp/launch layout recognized" || bad "submod layout"
( cd "$tmp" && mkproj no-toolchain && probe_iswt "$tmp/no-toolchain" ) && bad "project.godot alone should NOT qualify" || ok "project.godot alone rejected"
( cd "$tmp" && mkdir -p unrelated && probe_iswt "$tmp/unrelated" ) && bad "no project.godot should NOT qualify" || ok "no project.godot rejected"
rm -rf "$tmp"

echo "== 7. cross-process visibility (T2-M1): resolved vars must survive exec =="
# The launcher `exec`s the proxy — any env.sh-resolved value that stays a bare
# shell variable vanishes in the child, fail-opening the proxy's
# isSharedMasterWorktree guard. These cases run the assertion in a CHILD bash
# (not the sourcing shell) so only truly exported values can pass.
# (a) KOL_ legacy injection → canonical visible in child
r="$(bash -c "export KOL_SHARED_MASTER=/x; . '$LAUNCH/env.sh'; bash -c 'printf %s \"\${GODOT_MCP_SHARED_MASTER-}\"'")"
[[ "$r" == "/x" ]] && ok "KOL_SHARED_MASTER alias survives exec → child" || bad "KOL alias cross-process = '$r'"
# (b) canonical injection → still visible in child
r="$(bash -c "export GODOT_MCP_SHARED_MASTER=/y; . '$LAUNCH/env.sh'; bash -c 'printf %s \"\${GODOT_MCP_SHARED_MASTER-}\"'")"
[[ "$r" == "/y" ]] && ok "GODOT_MCP_SHARED_MASTER survives exec → child" || bad "canonical cross-process = '$r'"
# (c) repo dirname alias same guarantee
r="$(bash -c "export KOL_REPO_DIRNAME=AliasRepo; . '$LAUNCH/env.sh'; bash -c 'printf %s \"\${GODOT_MCP_REPO_DIRNAME-}\"'")"
[[ "$r" == "AliasRepo" ]] && ok "KOL_REPO_DIRNAME alias survives exec → child" || bad "repo dirname cross-process = '$r'"
# (d) no injection: vars are set (empty) and exported — child must not die on set -u
r="$(bash -c "set -u; . '$LAUNCH/env.sh'; bash -c 'printf %s \"<\${GODOT_MCP_SHARED_MASTER-}><\${GODOT_MCP_WORKSPACES_BASE-}>\"'")" && [[ "$r" == "<></home/jerry/multica_workspaces>" || "$r" == "<><"* ]] && ok "unset-injection: exported-empty, set -u safe" || bad "unset-injection cross-process = '$r'"

echo "== 8. SEE-1292 §DECPL-001: GODOT_MCP_HOME default / override / legacy alias =="
# (a) default neutral path
r="$(probe '' 'printf "%s" "$GODOT_MCP_HOME"')"
[[ "$r" == "$HOME/.config/godot-mcp" ]] && ok "GODOT_MCP_HOME default = \$HOME/.config/godot-mcp (neutral)" || bad "GODOT_MCP_HOME default = '$r'"
# (b) explicit override
r="$(probe 'GODOT_MCP_HOME=/custom/state' 'printf "%s" "$GODOT_MCP_HOME"')"
[[ "$r" == "/custom/state" ]] && ok "GODOT_MCP_HOME override honored" || bad "GODOT_MCP_HOME override = '$r'"

echo "== 9. SEE-1292 §DECPL-002: new canonical env vars alias from legacy (K5 three-level) =="
# GODOT_MCP_WORKTREE from KOL_WORKTREE; explicit canonical wins
r="$(probe 'KOL_WORKTREE=/kol/wt' 'printf "%s" "$GODOT_MCP_WORKTREE"')"
[[ "$r" == "/kol/wt" ]] && ok "KOL_WORKTREE → GODOT_MCP_WORKTREE" || bad "GODOT_MCP_WORKTREE alias = '$r'"
r="$(probe 'KOL_WORKTREE=/kol GODOT_MCP_WORKTREE=/canon' 'printf "%s" "$GODOT_MCP_WORKTREE"')"
[[ "$r" == "/canon" ]] && ok "GODOT_MCP_WORKTREE canonical beats KOL alias" || bad "canonical-vs-alias = '$r'"
# GODOT_MCP_AGENT_NAME maps MULTICA_AGENT_NAME and KOL_AGENT_NAME + CLAUDE
r="$(probe 'MULTICA_AGENT_NAME=Ma' 'printf "%s" "$GODOT_MCP_AGENT_NAME"')"
[[ "$r" == "Ma" ]] && ok "MULTICA_AGENT_NAME → GODOT_MCP_AGENT_NAME" || bad "GODOT_MCP_AGENT_NAME alias = '$r'"
r="$(probe 'KOL_AGENT_NAME=Ka' 'printf "%s" "$GODOT_MCP_AGENT_NAME"')"
[[ "$r" == "Ka" ]] && ok "KOL_AGENT_NAME → GODOT_MCP_AGENT_NAME" || bad "GODOT_MCP_AGENT_NAME KOL alias = '$r'"
# GODOT_MCP_WORKSPACE_ID / AGENT_ID from MULTICA
r="$(probe 'MULTICA_WORKSPACE_ID=ws1' 'printf "%s" "$GODOT_MCP_WORKSPACE_ID"')"
[[ "$r" == "ws1" ]] && ok "MULTICA_WORKSPACE_ID → GODOT_MCP_WORKSPACE_ID" || bad "GODOT_MCP_WORKSPACE_ID alias = '$r'"
r="$(probe 'MULTICA_AGENT_ID=ag1' 'printf "%s" "$GODOT_MCP_AGENT_ID"')"
[[ "$r" == "ag1" ]] && ok "MULTICA_AGENT_ID → GODOT_MCP_AGENT_ID" || bad "GODOT_MCP_AGENT_ID alias = '$r'"

echo ""
echo "==== T2 regression: PASS=$PASS FAIL=$FAIL ===="
[[ "$FAIL" -eq 0 ]]