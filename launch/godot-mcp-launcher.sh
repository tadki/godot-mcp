#!/usr/bin/env bash
# Unified MCP server entry point for a per-agent Godot editor.
#
# SEE-976: this wrapper makes godot-mcp "just work" for each agent. When the
# Multica platform starts an agent's MCP server it runs this script; we resolve
# the agent's port + worktree and immediately exec the warmup-aware proxy.
#
# SEE-1085 (B1 lazy-load): the launcher NO LONGER spawns the editor itself.
# Previously it ran configure-mcp-port.sh + start-godot-editor.sh before exec
# (see SEE-1001 orphan-gate history), but that required the worktree to exist
# at launch time. The multica daemon's timing bug (worktree created 5-6s after
# claude starts; SEE-1082) made the launcher fail before the MCP handshake
# ever ran, silently dropping mcp__godot-mcp-<agent>__* tools from the agent.
#
# B1 fix: the launcher resolves port + worktree, exports them as env vars, and
# ALWAYS execs the proxy (never dies on a missing worktree). The proxy
# spawns configure + start lazily on the first tools/call, so the MCP
# initialize / tools/list handshake completes successfully even when the
# worktree does not yet exist, and the editor is only booted when actually
# needed. See .dev/godot-mcp/docs/b1-lazy-load-design.md for the full design.
#
# Usage:
#   godot-mcp-launcher.sh <agent-name>
#   godot-mcp-launcher.sh --port <port>
#   godot-mcp-launcher.sh              # read KOL_AGENT_NAME / KOL_MCP_PORT
#
# All preparation progress is written to stderr AND mirrored to
# $GODOT_MCP_HOME/godot-mcp-launcher-<label>.log (same directory + naming
# family as the editor log, SEE-1091). stdout is kept clean so that the MCP
# JSON-RPC handshake is not corrupted before exec.

set -euo pipefail

# SEE-1045: preserve the original stdin (the MCP JSON-RPC pipe) before the rest of
# the script runs. Intermediate commands, command substitutions, or child processes
# might otherwise read stdin and consume the initialize handshake. After this
# point the script's stdin is /dev/null; the original pipe is restored only when
# we exec the proxy below.
exec {ORIG_STDIN}<&0
exec 0</dev/null

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# SEE-1292 §DECPL-003: the launcher NO LONGER reverse-probes the caller's
# private env file (previously walked up 5 dirs from SCRIPT_DIR to source
# <repo_root>/.dev/env/kol-mcp.env). Calling convention is now explicit env:
# the caller (KOL repo-checkout hook / daemon chain) exports GODOT_MCP_* and
# the legacy aliases it wants the chain to see; the launcher simply consumes
# whatever env the caller provided. A KOL/GODOT_MCP env file lives entirely on
# the caller's side (its own injected values), source it there, not here.

# shellcheck source=env.sh
. "${SCRIPT_DIR}/env.sh"
# SEE-1292 §DECPL-002: platform workspace/agent identity. The daemon injects
# MULTICA_WORKSPACE_ID / MULTICA_AGENT_ID; the canonical GODOT_MCP_WORKSPACE_ID
# / GODOT_MCP_AGENT_ID alias onto them (explicit canonical > platform legacy).
: "${GODOT_MCP_WORKSPACE_ID:=${MULTICA_WORKSPACE_ID:-}}"
: "${GODOT_MCP_AGENT_ID:=${GODOT_MCP_AGENT_ID:-}}"
export GODOT_MCP_WORKSPACE_ID GODOT_MCP_AGENT_ID

MCP_TIMEOUT_SEC=60

# Per-agent port allocation — single source of truth is agent-ports.json
# (loaded via agent-ports.lib.sh); shared with configure-mcp-port.sh and
# start-godot-editor.sh. See mcp-multi-port-usage.md §2/§8.
# shellcheck source=agent-ports.lib.sh
source "$SCRIPT_DIR/agent-ports.lib.sh"

# Resolve powershell.exe: prefer PATH, else the well-known System32 location.
POWERSHELL=""
if command -v powershell.exe >/dev/null 2>&1; then
    POWERSHELL="powershell.exe"
elif [[ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]]; then
    POWERSHELL="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
fi

# SEE-1091 observability: every launcher boot decision is mirrored to
# $GODOT_MCP_HOME/godot-mcp-launcher-<label>.log so a failed auto-spawn is traceable
# after the fact (stderr alone is swallowed by the multica daemon). ISO8601
# timestamp matches the editor log, and the [godot-mcp-launcher] prefix stays on
# stderr for grep compatibility with existing test harnesses. The label is
# resolved AFTER port parsing (agent_label_for_port), so pre-label messages
# (arg errors, unknown agent, invalid port) cannot be mirrored — they still go
# to stderr; that is fine, they abort before any spawn decision.
log() {
    local ts line
    ts="$(date +%Y-%m-%dT%H:%M:%S%z 2>/dev/null || date +%Y-%m-%dT%H:%M:%S)"
    line="[godot-mcp-launcher] $*"
    printf '%s %s\n' "$ts" "$line" >&2
    if [[ -n "${LAUNCHER_LOG_FILE:-}" && -d "$(dirname "$LAUNCHER_LOG_FILE")" ]]; then
        printf '%s %s\n' "$ts" "$line" >>"$LAUNCHER_LOG_FILE" 2>/dev/null || true
    fi
}

# SEE-1110 R1: emit SSOT §6.2 structured stage lines for the proxy's tier-2
# warmup parser. Unlike log(), no timestamp prefix — the line must START with
# the machine-readable `[godot-mcp-launcher] stage=` token so the proxy can
# match `stage=<ENUM>` reliably. Format: `[godot-mcp-launcher] stage=<ENUM>
# msg="..." key=value ...` (SSOT .dev/godot-mcp/docs/warmup-progress-protocol.md).
log_stage() {
    local line="[godot-mcp-launcher] $*"
    printf '%s\n' "$line" >&2
    if [[ -n "${LAUNCHER_LOG_FILE:-}" && -d "$(dirname "$LAUNCHER_LOG_FILE")" ]]; then
        printf '%s\n' "$line" >>"$LAUNCHER_LOG_FILE" 2>/dev/null || true
    fi
}

die() {
    log "ERROR: $*"
    exit 1
}

print_usage() {
    cat <<EOF
Usage: godot-mcp-launcher.sh [agent-name] [--port <port>] [-h|--help]

Unified MCP server entry point for a per-agent Godot editor.

SEE-1085 (B1 lazy-load): this launcher resolves the agent's port + worktree,
exports them as env vars, and immediately execs the warmup-aware proxy. It no
longer spawns the editor itself — the proxy lazily spawns configure +
start-godot-editor on the first tools/call, so the launcher must never die even
when the worktree does not yet exist (daemon timing bug from SEE-1082).

Arguments:
  agent-name       Agent whose port to use (case-sensitive). Resolved via the
                   built-in allocation table. Chekky is intentionally not in
                   the table.
  --port <port>    Use an explicit port (\${PORT_MIN}-\${PORT_MAX}) instead of
                   the table.
  -h, --help       Show this help and exit.

Environment:
  KOL_AGENT_NAME   Used when no agent-name argument is given.
  CLAUDE_AGENT_NAME
  MULTICA_AGENT_NAME
                   Fallback agent-name sources when KOL_AGENT_NAME is unset.
  KOL_MCP_PORT     Used when no --port / agent-name is given. Takes priority
                   over agent-name env variables.
  KOL_WORKTREE     Override the auto-resolved worktree path (used by the
                   proxy to spawn configure + start).
  KOL_PROJECT_GODOT
                   Override the auto-resolved project.godot path (ditto).

Agent -> port table:
  Atlas=6551  Archi=6552  Bachi=6553  Fronti=6554  Revy=6555  Refacty=6556
  (Chekky does not participate in MCP debugging.)

Examples:
  godot-mcp-launcher.sh Bachi
  godot-mcp-launcher.sh --port 6551
  KOL_AGENT_NAME=Atlas godot-mcp-launcher.sh
EOF
}

# Is the TCP port already bound? informational only post-SEE-1085 (the proxy
# owns spawn + reuse decisions). Kept so the launcher can log boot state for
# the operator + Atlas QA scripts.
port_in_use() {
    local p="$1"
    if [[ -n "${POWERSHELL:-}" ]]; then
        if "$POWERSHELL" -NoProfile -Command "if (Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" 2>/dev/null; then
            return 0
        fi
        return 1
    fi
    if command -v netstat.exe >/dev/null 2>&1; then
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
    log "WARNING: cannot find PowerShell/netstat.exe/ss; assuming port ${p} is free."
    return 1
}

# Resolve the host the godot-mcp WebSocket is reachable on. The editor is a
# Windows process that binds the WSL vEthernet IP; the npx client reaches it via
# the WSL default gateway. Mirror mcp_client.mjs detectWindowsHost() so we probe
# the exact endpoint the client will use.
resolve_mcp_host() {
    if [[ -n "${GODOT_HOST:-}" ]]; then
        printf '%s\n' "$GODOT_HOST"
        return
    fi
    if command -v ip >/dev/null 2>&1; then
        local gw
        gw=$(ip route show default 2>/dev/null | sed -n 's/^.*via[[:space:]]\{1,\}\([0-9.]\{1,\}\).*$/\1/p' | head -n 1)
        if [[ -n "$gw" ]]; then
            printf '%s\n' "$gw"
            return
        fi
    fi
    printf '127.0.0.1\n'
}

# Resolve the worktree root (the nearest ancestor containing project.godot) so
# the proxy can spawn the editor against it on first tools/call. SEE-1128 /
# Owner: resolution is now FATAL on failure — the launcher dies with an
# actionable hint rather than exporting an empty KOL_WORKTREE or ever falling
# back to the shared master (supersedes the former SEE-1085 `|| true` note).
#
# SEE-1111 (multi-agent worktree isolation): the MCP server process cwd is the
# agent's own task workdir root, which contains the checked-out repo ONE level
# down (`<workdir>/KingOfLikes-Godot/project.godot`). The platform spawns this
# script via an absolute D-drive path, so walking up from $(pwd) finds no
# project.godot AND walking up from $SCRIPT_DIR lands on the SHARED D-drive
# master checkout (/mnt/d/GodotProjects/king-of-likes) — the root cause of
# SEE-1111: every agent's configure rewrote the same shared project.godot
# (last-writer-wins) and collided on the addon's single WS slot. To restore the
# §3.7 invariant "一个 agent ⇄ 一个私有 worktree ⇄ 一个专属端口", resolve DOWN
# from the cwd into the per-agent worktree (the checkout inside the agent's own
# workdir) BEFORE falling back to walking up from $SCRIPT_DIR.
#
# SEE-1128 (cwd-untrusted resolution): the CC process that spawns this launcher
# does NOT run from the workdir — its cwd is hostile (e.g. $HOME; verified via
# /proc/<claude.exe>/environ PWD=/home/jerry). So $(pwd) can point nowhere near
# the worktree, the down-search misses, and the old SCRIPT_DIR up-walk silently
# returned the SHARED D-drive master when .mcp.json resolved to the D-drive
# copy — tripping §7.1 防线 3 (editor spawn failed: worktree_shared_master).
#
# Per Owner direction the SILENT shared-master fallback is REMOVED: a
# wrong-but-silent resolution is worse than a loud unresolved one. Resolution
# now trusts exactly TWO tiers, in order:
#   1. reliable runtime identifier — the Multica runtime registry, cwd-
#      independent: scan ~/multica_workspaces/$GODOT_MCP_WORKSPACE_ID/*/
#      .managed_env.json for entries matching this $GODOT_MCP_AGENT_ID, and pin
#      the exact THIS-task workdir by re-encoding each candidate against the
#      per-task TMPDIR `.cc-aligned-*` marker; a freshest-runtime mtime
#      heuristic is the fallback within this tier.
#   2. cwd ($(pwd)) up-walk + one-level down-search.
# If BOTH fail the launcher ERRORS OUT (die) with an actionable hint — it never
# falls back to the shared master, $SCRIPT_DIR, or any implicit D-drive path.
# The shared-master path appears ONLY in the §7.1 防线 3 rejection list
# (proxy spawn-time guard), never as a launcher resolution candidate.
# §4.5.3 T2: env-overridable; empty default = probe-failure fallback (K5 rule)
SHARED_MASTER_WORKTREE="${GODOT_MCP_SHARED_MASTER:-}"

_is_shared_master() {
    local p="${1%/}"
    # T2-M1 follow-up: empty SHARED_MASTER_WORKTREE (K5 默认) must guard NOTHING
    # — the unanchored '$m'/* pattern with m='' becomes /* and matches every
    # absolute path, fail-closing all resolutions (T4 wait test failure).
    [[ -n "$SHARED_MASTER_WORKTREE" ]] || return 1
    [[ "$p" == "$SHARED_MASTER_WORKTREE" || "$p" == "$SHARED_MASTER_WORKTREE"/* ]]
}

# SEE-1273 T3 / K3: shell 版三落点 worktree 判定（与 proxy isGodotWorktree
# 同语义）——repo 根 launch/（T4 后 submodule 挂载形态）、legacy
# .dev/godot-mcp/launch（过渡窗 KOL checkout）、addons/godot_mcp/launch。
# registry 解析的有效性过滤必须认全部三种布局，否则切换窗解析全落空。
_has_launch_toolchain() {
    local wt="${1%/}"
    [[ -d "$wt/launch" || -d "$wt/.dev/godot-mcp/launch" || -d "$wt/addons/godot_mcp/launch" ]]
}

# Search a candidate root: up-walk for project.godot, then one-level
# down-search for a KingOfLikes-Godot checkout (toolchain dir proves it is the
# agent's checkout regardless of project.godot's gitignored state). Prints the
# resolved dir on success, returns 1 otherwise. Does NOT consult SCRIPT_DIR.
_search_root_for_worktree() {
    local base="$1" dir subdir
    dir="$base"
    while [[ "$dir" != "/" ]]; do
        if [[ -f "$dir/project.godot" ]]; then
            printf '%s\n' "$dir"
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    for subdir in "$base"/*/; do
        [[ -d "$subdir" ]] || continue
        if _has_launch_toolchain "$subdir"; then
            printf '%s\n' "${subdir%/}"
            return 0
        fi
    done
    return 1
}

# SEE-1128 tier 1: resolve the worktree via the Multica runtime registry,
# independent of cwd. Each runtime hash dir carries .managed_env.json
# ({workspace_id, issue_id, agent_id}) one level above workdir/. Three
# strategies, most specific first:
#   (a) EXACT task match via TMPDIR marker filename: the daemon spawns this
#       launcher with a per-task TMPDIR (/tmp/multica-task-<N>) containing a
#       `.cc-aligned-<encoded>` marker whose filename encodes the workdir
#       path (path '/' -> '_'). We re-encode each candidate workdir and
#       compare — a byte-exact filename match uniquely identifies THIS
#       task's workdir. Requires .managed_env.json to exist (daemon may lag
#       by several seconds — SEE-1082 timing).
#   (a2) TMPDIR marker direct decode: when (a) misses because the daemon
#       has not yet written .managed_env.json (or the worktree checkout is
#       still in flight), extract the runtime hash straight out of the
#       marker filename — it always has the form
#       `.cc-aligned-_home_jerry_multica_workspaces_<wsid>_<hash>_workdir_KingOfLikes-Godot`.
#       The workspace id is a known UUID (contains '-', never '_'), and the
#       runtime hash is an 8-char hex prefix (no '_'), so the split is
#       unambiguous. The candidate is accepted when the runtime hash dir
#       itself exists, AND either its .managed_env.json is missing (daemon
#       has not caught up yet — trust the per-task marker) or its agent_id
#       matches $GODOT_MCP_AGENT_ID (sanity check against a stale marker
#       leaking across agents via TMPDIR reuse). The worktree directory
#       itself is NOT required to exist — per B1 lazy-load (SEE-1085) the
#       proxy spawns configure + start lazily on first tools/call.
#   (b) freshest-runtime fallback: when no TMPDIR marker is present at all
#       (older CC, non-CC spawner), pick the most-recently-activated
#       runtime whose agent_id matches. Heuristic — correct for the
#       synchronous launch, but only a fallback.
# Prints the worktree path, returns 1 otherwise.
_encode_workdir_marker() {
    # Mirror the daemon's `.cc-aligned-<enc>` encoding: strip leading '/', then
    # '/' -> '_'. Used only for comparison, never decoded.
    local p="$1"
    printf '.cc-aligned-_%s\n' "${p#/}" | tr '/' '_'
}

# SEE-1129: extract the runtime hash from a `.cc-aligned-*` marker filename
# by stripping the known prefix/suffix around the workspace id. The marker
# is `.cc-aligned-_<ws_base_underscored>_<hash>_workdir_KingOfLikes-Godot`
# where <ws_base_underscored> is $ws_base with '/'->'_'. Prints the hash on
# success, returns 1 when the marker does not match the expected shape.
_decode_marker_hash() {
    local marker="$1" ws_base="$2" ws_enc prefix suffix rest hash
    # Re-encode $ws_base the same way the hook encodes pwd: '/'->'_'.
    ws_enc="${ws_base#/}"
    ws_enc="${ws_enc////_}"
    prefix=".cc-aligned-_${ws_enc}_"
    suffix="_workdir_${GODOT_MCP_REPO_DIRNAME}"
    [[ "$marker" == "$prefix"*"$suffix" ]] || return 1
    rest="${marker#"$prefix"}"
    hash="${rest%"$suffix"}"
    # Hash must be non-empty and free of '_' (a real hash is 8 hex chars).
    [[ -n "$hash" && "$hash" != *_* ]] || return 1
    printf '%s\n' "$hash"
}

# SEE-1244 改动 A: ws_base candidates. The daemon may materialize workdirs
# under the FULL workspace-UUID directory OR a `seed-<id12>` alias directory
# (observed: ~/multica_workspaces/seed-478690824e46/...). The UUID candidate
# keeps legacy behavior untouched; the alias candidate is discovered by
# reverse lookup — any directory under ~/multica_workspaces whose runtime
# .managed_env.json carries OUR workspace_id. Cross-agent gates are applied
# per-candidate exactly as before, so the alias form gains no authority.
# Prints each candidate dir; nothing printed when no alias exists.
_ws_base_candidates() {
    local d meta wsid
    printf '%s\n' "${GODOT_MCP_WORKSPACES_BASE}/${GODOT_MCP_WORKSPACE_ID}"
    for d in "${GODOT_MCP_WORKSPACES_BASE}"/*/; do
        [[ -d "$d" ]] || continue
        # Alias dirs are sibling containers (seed-*), not the UUID one itself.
        [[ "$(basename "$d")" == "$GODOT_MCP_WORKSPACE_ID" ]] && continue
        # Probe the alias's runtime-level managed_env (depth ≤2): the daemon
        # writes it at the container root when the alias form is in use.
        meta=""
        if [[ -f "${d}.managed_env.json" ]]; then
            meta="${d}.managed_env.json"
        else
            meta="$(find "$d" -maxdepth 2 -name .managed_env.json 2>/dev/null | head -n 1)"
        fi
        [[ -n "$meta" && -f "$meta" ]] || continue
        wsid="$(grep -o '"workspace_id":[[:space:]]*"[^"]*"' "$meta" 2>/dev/null | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')"
        [[ "$wsid" == "$GODOT_MCP_WORKSPACE_ID" ]] && printf '%s\n' "${d%/}"
    done
}

_resolve_via_runtime_registry() {
    local ws_base hash meta worktree marker best_hash best_mtime mtime
    [[ -n "${GODOT_MCP_WORKSPACE_ID:-}" && -n "${GODOT_MCP_AGENT_ID:-}" ]] || return 1

    local -a ws_bases=()
    local cand
    while IFS= read -r cand; do
        [[ -d "$cand" ]] && ws_bases+=("$cand")
    done < <(_ws_base_candidates)
    (( ${#ws_bases[@]} > 0 )) || return 1

    # (a) exact task match via the TMPDIR .cc-aligned marker.
    if [[ -n "${TMPDIR:-}" ]]; then
        for marker in "$TMPDIR"/.cc-aligned-*; do
            [[ -e "$marker" ]] || continue
            marker="$(basename "$marker")"
            for ws_base in "${ws_bases[@]}"; do
                for meta in "$ws_base"/*/.managed_env.json; do
                    [[ -f "$meta" ]] || continue
                    grep -q "\"agent_id\":[[:space:]]*\"${GODOT_MCP_AGENT_ID}\"" "$meta" || continue
                    hash="$(basename "$(dirname "$meta")")"
                    worktree="$ws_base/$hash/workdir/${GODOT_MCP_REPO_DIRNAME}"
                    _has_launch_toolchain "$worktree" || continue
                    if [[ "$(_encode_workdir_marker "$worktree")" == "$marker" ]]; then
                        printf '%s\n' "$worktree"
                        return 0
                    fi
                done
            done
        done

        # (a2) marker direct decode — per-task authoritative. The
        # .cc-aligned-* marker is written by the repo-checkout SessionStart
        # hook for THIS task's cwd, so a correctly-named marker uniquely
        # identifies the current task's worktree. Per B1 lazy-load we do
        # NOT require the worktree to exist on disk yet (the proxy spawns
        # configure + start lazily on first tools/call) — and we extend
        # the same trust to the runtime hash dir (SEE-1129 second-round
        # diagnosis: the daemon may provision the hash dir lazily too).
        #
        # Cross-agent safety: when .managed_env.json is already present
        # (the common case once the daemon has had a few ms to write it),
        # we REQUIRE its agent_id to match $GODOT_MCP_AGENT_ID — a stale
        # marker from another agent's task (TMPDIR reuse) cannot misroute
        # us. When the managed_env is NOT yet on disk, we trust the
        # marker because it is per-task and written for THIS Claude
        # session's cwd; there is no other source of authority. The
        # freshest-mtime fallback (b) below is also agent_id-filtered, so
        # even if (a2) lands on a partial match the worktree ends up under
        # the right agent.
        #
        # Note (Revy QA failure, 2026-08-11): the previous version of this
        # branch also REQUIRED the runtime hash dir to exist on disk
        # (`[[ -d "$ws_base/$hash" ]]`). That check was a relic of the
        # pre-B1 assumption that the launcher needs an on-disk worktree;
        # when the daemon had not yet provisioned the runtime hash dir,
        # (a2) silently skipped and (b)'s freshest-mtime picked whichever
        # other runtime of the same agent had the newest .managed_env.json
        # mtime — pinning the launcher to that older runtime for the
        # rest of the session. Dropping that check closes the gap.
        for marker in "$TMPDIR"/.cc-aligned-*; do
            [[ -e "$marker" ]] || continue
            marker="$(basename "$marker")"
            # (a2) is tried against EVERY ws_base candidate — the seed-* alias
            # form encodes the alias path in the marker, so only the matching
            # candidate decodes (SEE-1244 改动 A).
            for ws_base in "${ws_bases[@]}"; do
                hash="$(_decode_marker_hash "$marker" "$ws_base")" || continue
                meta="$ws_base/$hash/.managed_env.json"
                if [[ -f "$meta" ]]; then
                    # Authoritative cross-agent gate: when the managed_env is
                    # on disk its agent_id MUST match. A stale marker for
                    # another agent's runtime (TMPDIR reuse) is rejected here
                    # so we do not leak into (b) and get pinned to a stale
                    # freshest-mtime winner.
                    grep -q "\"agent_id\":[[:space:]]*\"${GODOT_MCP_AGENT_ID}\"" "$meta" || continue
                fi
                worktree="$ws_base/$hash/workdir/${GODOT_MCP_REPO_DIRNAME}"
                printf '%s\n' "$worktree"
                return 0
            done
        done
    fi

    # (b) freshest-runtime fallback.
    #
    # SEE-1129 v7 cwd-anchor (sub-step dcacbb66 v7): when the marker layer
    # (a)/(a2) missed because the per-task .cc-aligned marker had not been
    # written yet (daemon lag — observed 6s on the real machine: proxy launch
    # 21:08:27 vs marker mtime 21:08:33), the freshest-mtime loop below would
    # pin the launcher to whichever OTHER runtime of the same agent had the
    # newest leftover .managed_env.json mtime. On 2026-08-11 that was 17219eb2
    # (issue 02f45f9d, managed_env mtime 18:37) instead of this task's actual
    # slot 41115b3c (issue 683b665c, managed_env mtime 16:21 — the daemon
    # reused the hash dir without refreshing mtime). The proxy then exported
    # KOL_WORKTREE=17219eb2 and served the wrong project for the whole session.
    #
    # Fix: cwd is the authoritative per-task anchor — Multica launches this
    # proxy with cwd set to the task's runtime workdir. If pwd is under
    # ws_base/<hash>/workdir, prefer <hash> over any freshest-mtime winner,
    # gated by the same cross-agent rule (managed_env agent_id must match when
    # present). This closes the marker-daemon-lag gap that c8c703b0's Revy note
    # predicted but (a2)-requires-marker left open.
    local cwd cwd_rest cwd_hash cwd_meta
    cwd="$(pwd)"
    # cwd-anchor runs against every candidate (seed-* alias first wins by
    # being the actual layout; UUID candidate is a no-op when cwd isn't there).
    for ws_base in "${ws_bases[@]}"; do
        case "$cwd/" in
            "$ws_base/"*"/workdir"/*|"$ws_base/"*"/workdir/")
                cwd_rest="${cwd#"$ws_base/"}"
                cwd_hash="${cwd_rest%%/*}"
                if [[ -n "$cwd_hash" && "$cwd_hash" != *_* ]]; then
                    cwd_meta="$ws_base/$cwd_hash/.managed_env.json"
                    if [[ -f "$cwd_meta" ]]; then
                        # Cross-agent gate: cwd slot must belong to this agent.
                        if grep -q "\"agent_id\":[[:space:]]*\"${GODOT_MCP_AGENT_ID}\"" "$cwd_meta"; then
                            printf '%s\n' "$ws_base/$cwd_hash/workdir/${GODOT_MCP_REPO_DIRNAME}"
                            return 0
                        fi
                        # cwd slot is a different agent's — fall through to freshest-mtime
                        # rather than trust a foreign runtime (cross-agent safety #5).
                    else
                        # managed_env not yet written (daemon lag): trust cwd, same B1
                        # lazy-load trust (a2) extends to the runtime hash dir.
                        printf '%s\n' "$ws_base/$cwd_hash/workdir/${GODOT_MCP_REPO_DIRNAME}"
                        return 0
                    fi
                fi
                ;;
        esac
    done

    # (b) freshest-mtime fallback — also per-candidate.
    for ws_base in "${ws_bases[@]}"; do
        best_hash=""
        best_mtime=0
        for meta in "$ws_base"/*/.managed_env.json; do
            [[ -f "$meta" ]] || continue
            grep -q "\"agent_id\":[[:space:]]*\"${GODOT_MCP_AGENT_ID}\"" "$meta" || continue
            hash="$(basename "$(dirname "$meta")")"
            worktree="$ws_base/$hash/workdir/${GODOT_MCP_REPO_DIRNAME}"
            _has_launch_toolchain "$worktree" || continue
            mtime="$(stat -c %Y "$meta" 2>/dev/null || echo 0)"
            if (( mtime > best_mtime )); then
                best_mtime="$mtime"
                best_hash="$hash"
            fi
        done
        if [[ -n "$best_hash" ]]; then
            printf '%s\n' "$ws_base/$best_hash/workdir/${GODOT_MCP_REPO_DIRNAME}"
            return 0
        fi
    done
    return 1
}

# Two-tier resolution (SEE-1128 / Owner): runtime registry first (cwd-
# independent), then cwd inference. On success prints the worktree path and
# returns 0. Any shared-master hit is rejected (treated as unresolved). On
# total failure returns 1 — the CALLER dies with an actionable hint rather
# than ever falling back to the shared master.
resolve_worktree_root() {
    local result
    # Tier 1: reliable runtime identifier (cwd-independent).
    if result="$(_resolve_via_runtime_registry)"; then
        if _is_shared_master "$result"; then
            log "WARNING: runtime-registry resolution landed on shared master ($result); refusing to export it as KOL_WORKTREE."
        else
            printf '%s\n' "$result"
            return 0
        fi
    fi
    # Tier 2: cwd inference (up-walk + one-level down-search).
    if result="$(_search_root_for_worktree "$(pwd)")"; then
        if _is_shared_master "$result"; then
            log "WARNING: cwd resolution landed on shared master ($result); refusing to export it as KOL_WORKTREE."
        else
            printf '%s\n' "$result"
            return 0
        fi
    fi
    # Both tiers failed — NO silent SCRIPT_DIR / shared-master / D-drive
    # fallback (SEE-1128, Owner directive). The caller dies loudly.
    return 1
}

# --- Parse CLI ---------------------------------------------------------------
AGENT_NAME=""
EXPLICIT_PORT=""

while (( $# > 0 )); do
    case "$1" in
        -h|--help)
            print_usage >&2
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
NAME=""
if [[ -n "$EXPLICIT_PORT" ]]; then
    PORT="$EXPLICIT_PORT"
elif [[ -n "${GODOT_MCP_PORT:-}" ]]; then
    PORT="$GODOT_MCP_PORT"
elif [[ -n "${KOL_MCP_PORT:-}" ]]; then
    PORT="$KOL_MCP_PORT"
else
    NAME="${AGENT_NAME:-${KOL_AGENT_NAME:-${CLAUDE_AGENT_NAME:-${MULTICA_AGENT_NAME:-}}}}"
    if [[ -z "$NAME" ]]; then
        print_usage >&2
        die "No agent name or port provided. Pass an agent name, --port <port>, or set KOL_AGENT_NAME / CLAUDE_AGENT_NAME / MULTICA_AGENT_NAME / KOL_MCP_PORT."
    fi
    PORT="$(resolve_port_for_agent "$NAME")"
fi

# Propagate the resolved agent name so the proxy (and the configure/start
# children it spawns) resolve the same port when this launcher was driven by
# CLAUDE_AGENT_NAME / MULTICA_AGENT_NAME from the platform (.mcp.json path).
export KOL_AGENT_NAME="${KOL_AGENT_NAME:-$NAME}"
is_valid_port "$PORT" || die "Invalid port '$PORT': must be an integer in [${PORT_MIN}, ${PORT_MAX}]."

# --- Resolve worktree (informational + exported for the proxy) ---------------
# SEE-1128 / Owner hard constraint: if NEITHER the runtime identifier NOR cwd
# inference resolves a private worktree, ERROR OUT with an actionable hint —
# never fall back to the shared master, $SCRIPT_DIR, or any implicit D-drive
# path, and never continue with an empty KOL_WORKTREE.
#
# SEE-1244 改动 B (plan-debate 决策报告): the die above kills the whole chain
# 56ms in when the fresh workdir checkout has not landed yet (first-run race
# from SEE-1250). Replace the immediate die with a bounded wait-retry: re-run
# BOTH tiers every 2s until the checkout lands, up to KOL_WORKTREE_WAIT_S
# (default 120s; checkout distribution is seconds-to-minutes per SEE-1250).
# The wait sits BEFORE the held lock mkdir (line ~606) so no lock contention
# is introduced; no trap is registered inside the loop (a SIGTERM hitting a
# mid-wait launcher takes the default terminate-with-nothing-held path).
# Timeout keeps the red-line semantics: die with the actionable hint, NEVER
# fall back to the shared master.
if [[ -n "${KOL_PROJECT_GODOT:-}" ]]; then
    CURRENT_WORKTREE="$(dirname "$KOL_PROJECT_GODOT")"
else
    _WORKTREE_WAIT_MAX_S="${KOL_WORKTREE_WAIT_S:-120}"
    _WORKTREE_WAIT_INTERVAL_S=2
    _WAITED_S=0
    _RETRY_N=0
    while ! CURRENT_WORKTREE="$(resolve_worktree_root)"; do
        if (( _WAITED_S >= _WORKTREE_WAIT_MAX_S )); then
            die "could not resolve a private Godot worktree after waiting ${_WAITED_S}s (${_RETRY_N} retries, KOL_WORKTREE_WAIT_S=${_WORKTREE_WAIT_MAX_S}); the workdir checkout may never have landed. Re-launch the launcher from your Godot workdir (e.g. ~/multica_workspaces/<workspace>/<hash>/workdir/${GODOT_MCP_REPO_DIRNAME}), or set KOL_WORKTREE / KOL_PROJECT_GODOT explicitly. Refusing to fall back to the shared master checkout."
        fi
        _RETRY_N=$(( _RETRY_N + 1 ))
        _WAITED_S=$(( _WAITED_S + _WORKTREE_WAIT_INTERVAL_S ))
        # stderr + log mirror: the shim's [chain] pipe carries this to its own
        # stderr AND its log (SEE-1244 LOW4), so QA can attribute the wait.
        printf '[godot-mcp-launcher] stage=WORKTREE_WAIT msg="private worktree not on disk yet; waiting" retry=%s waited_s=%s max_s=%s\n' \
            "$_RETRY_N" "$_WAITED_S" "$_WORKTREE_WAIT_MAX_S" >&2
        if [[ -n "${LAUNCHER_LOG_FILE:-}" && -d "$(dirname "$LAUNCHER_LOG_FILE")" ]]; then
            printf '[godot-mcp-launcher] stage=WORKTREE_WAIT retry=%s waited_s=%s max_s=%s\n' \
                "$_RETRY_N" "$_WAITED_S" "$_WORKTREE_WAIT_MAX_S" >>"$LAUNCHER_LOG_FILE" 2>/dev/null || true
        fi
        sleep "$_WORKTREE_WAIT_INTERVAL_S"
    done
    if (( _RETRY_N > 0 )); then
        printf '[godot-mcp-launcher] stage=WORKTREE_READY msg="private worktree resolved after wait" waited_s=%s retries=%s\n' "$_WAITED_S" "$_RETRY_N" >&2
        if [[ -n "${LAUNCHER_LOG_FILE:-}" && -d "$(dirname "$LAUNCHER_LOG_FILE")" ]]; then
            printf '[godot-mcp-launcher] stage=WORKTREE_READY waited_s=%s retries=%s\n' "$_WAITED_S" "$_RETRY_N" >>"$LAUNCHER_LOG_FILE" 2>/dev/null || true
        fi
    fi
fi

LABEL="$(agent_label_for_port "$PORT")"

# SEE-1148 P1: derive the per-slot runtime_id = "<agent>-<hash8>" from the
# multica worktree path (or "<agent>-solo" outside a slot). Propagated as
# KOL_RUNTIME_ID so the proxy, helper scripts, and editor cmdline all share
# one identity for the SAME task slot — even when the same agent owns several
# concurrent slots (which today collide on a shared per-agent log path).
# shellcheck source=runtime.lib.sh
source "${SCRIPT_DIR}/runtime.lib.sh"
if [[ -z "${KOL_RUNTIME_ID:-}" ]]; then
    KOL_RUNTIME_ID="$(kol_derive_runtime_id "${KOL_AGENT_NAME:-${LABEL}}" "$CURRENT_WORKTREE")"
fi
export KOL_RUNTIME_ID

# SEE-1091: persist launcher boot decisions next to the editor log. Mirroring
# starts after the label resolves, so the file is created (via mkdir -p) only
# on the normal boot path — never on a parse/usage error.
export LAUNCHER_LOG_FILE="${GODOT_MCP_HOME}/godot-mcp-launcher-${LABEL}.log"
mkdir -p "$(dirname "$LAUNCHER_LOG_FILE")"
export GODOT_PORT="$PORT"
export GODOT_HOST="$(resolve_mcp_host)"
# SEE-1148 P1: editor log moves under $GODOT_MCP_HOME/godot-editor/<runtime_id>.log
# so same-agent concurrent slots do not clobber one shared per-agent log.
GODOT_STATE_DIR="$(kol_state_dir)"
mkdir -p "$GODOT_STATE_DIR"
export GODOT_EDITOR_LOG_FILE="${GODOT_STATE_DIR}/${KOL_RUNTIME_ID}.log"

# B1 lazy-load (SEE-1085): export the resolved worktree so the proxy can spawn
# configure + start on first tools/call WITHOUT re-resolving it. Per SEE-1128 /
# Owner, a worktree that cannot be resolved to a private checkout is FATAL —
# the launcher died above with an actionable hint rather than exporting an
# empty KOL_WORKTREE or falling back to the shared master.
export KOL_WORKTREE="${KOL_WORKTREE:-$CURRENT_WORKTREE}"
if [[ -n "$CURRENT_WORKTREE" ]]; then
    export KOL_PROJECT_GODOT="${KOL_PROJECT_GODOT:-$CURRENT_WORKTREE/project.godot}"
fi

# SEE-1148 P1 (registry landing): register this runtime in
# $GODOT_MCP_HOME/godot-port-registry.json (write-only this phase — no dynamic
# allocation). P2's allocator will read the same file. Failures are
# non-fatal: the registry is an observability layer, not a gate.
# shellcheck source=port-registry.lib.sh
source "${SCRIPT_DIR}/port-registry.lib.sh"

# SEE-1148 P1 (B-6 fast-fail via mkdir lock): two runs of the SAME runtime_id
# must not both become live proxies. The earlier registry-PID check had a
# warm-window hole (Revy P1 review §3): this launcher writes proxy_pid=$$
# (the shell PID) and execs node — that shell PID dies on exec, so during
# the warm window the registry holds a dead PID, and a 2nd launcher in the
# same slot would see _pid_alive=0 and silently overwrite the entry.
#
# Fix (Revy proposal a, shared primitive with P2 port allocation): use a
# per-runtime exclusive directory as the lock. mkdir is atomic on the same
# filesystem; the second arrival fails with EEXIST and reads the holder's
# pidfile to decide fast-fail vs stale-recovery. trap releases the lock on
# any launcher exit (incl. exec, which never returns here).
HELD_DIR="${SCRIPT_DIR}/held"
mkdir -p "$HELD_DIR" 2>/dev/null || die "fast-fail: cannot create held lock dir (${HELD_DIR})."
RUNTIME_HELD="${HELD_DIR}/${KOL_RUNTIME_ID}"
# SEE-1244 验收轮次自愈缺口修复（探针 #3 SEE-1255 FAIL 复盘）: a same-
# runtime_id live holder on this slot means the PREVIOUS round's launcher/
# proxy is still in its lease grace window (acceptance probes land ~3min
# apart, inside the 120s+ grace). fast-fail on a live holder kills this run
# 56ms in and the claude-side server permanently vanishes — exactly the
# shape this issue exists to kill. Wait-retry the mkdir like the worktree
# wait above: re-attempt every 2s up to KOL_RUNTIME_HELD_WAIT_S (default
# 180s — bounded above the observed 120s+ lease grace), with stage lines the
# shim subscribes to for its runtime_wait state. Timeout keeps the original
# fast-fail verdict verbatim (not worse than before; the liveness decision
# itself is unchanged — verified correct from first-hand logs: pid 98202 was
# alive at 09:19:26 and dead by 09:44, the fast-fail at 09:19 was right).
_HELD_WAIT_MAX_S="${KOL_RUNTIME_HELD_WAIT_S:-180}"
_HELD_WAITED_S=0
_HELD_RETRY_N=0
if ! mkdir "$RUNTIME_HELD" 2>/dev/null; then
    while true; do
        # Lock contended — read the holder's pid and decide.
        _owner_pid=""
        [[ -f "${RUNTIME_HELD}/pid" ]] && _owner_pid="$(tr -d '[:space:]' < "${RUNTIME_HELD}/pid" 2>/dev/null || true)"
        _owner_alive=0
        if [[ "$_owner_pid" =~ ^[0-9]+$ ]]; then
            # SEE-1242 B-2: /proc probe FIRST (millisecond-scale). The held pid is
            # ALWAYS a WSL shell→node PID ($$ written below, then exec node) — the
            # powershell.exe Get-Process branch cannot see WSL PIDs at all (A-2
            # evidence), yet costs a 6s-level interop round-trip when the pid is
            # fresh-dead. pwsh stays ONLY as the fallback for the exotic case where
            # /proc is unavailable (non-Linux caller), preserving the old verdict.
            if [[ -e "/proc/${_owner_pid}" ]]; then
                # Zombie guard: an exited-but-unreaped holder (parent died
                # without waitpid — e.g. the claude session was SIGKILLed)
                # keeps /proc/<pid> but readlink /proc/<pid>/exe fails (ENOENT).
                # A zombie does NOT own the slot; treat it as dead. kill -0 on
                # a real zombie would wrongly report alive.
                if readlink "/proc/${_owner_pid}/exe" >/dev/null 2>&1; then
                    kill -0 "$_owner_pid" 2>/dev/null && _owner_alive=1
                fi
            elif command -v powershell.exe >/dev/null 2>&1; then
                _n="$(powershell.exe -NoProfile -Command "(Get-Process -Id ${_owner_pid} -ErrorAction SilentlyContinue | Measure-Object).Count" 2>/dev/null | tr -d '\r\n ')"
                [[ "$_n" == "1" ]] && _owner_alive=1
            else
                kill -0 "$_owner_pid" 2>/dev/null && _owner_alive=1
            fi
            # Atlas Final Review MEDIUM-2: a live-but-FOREIGN PID (reused by an
            # unrelated process after the real holder died) must not permanent-
            # block this slot. Align with the arbiter's anti-PID-reuse check:
            # when /proc/<pid>/exe exists, require it to resolve to a node binary
            # (the proxy is a WSL node process). Without /proc we cannot prove
            # identity — keep the liveness verdict (conservative: better to
            # fast-fail than to double-hold a slot).
            if (( _owner_alive == 1 )) && [[ -e "/proc/${_owner_pid}/exe" ]]; then
                _exe="$(readlink "/proc/${_owner_pid}/exe" 2>/dev/null || echo "")"
                [[ "$_exe" == *node* ]] || _owner_alive=0
            fi
        fi
        if (( _owner_alive == 0 )); then
            # Stale held dir (holder died without cleanup, e.g. SIGKILL of an
            # earlier launcher before its trap ran — or the previous round's
            # proxy exited during our wait). Remove and retry once.
            if (( _HELD_RETRY_N > 0 )); then
                printf '[godot-mcp-launcher] stage=RUNTIME_READY msg="runtime lock released after wait" waited_s=%s retries=%s\n' "$_HELD_WAITED_S" "$_HELD_RETRY_N" >&2
                [[ -n "${LAUNCHER_LOG_FILE:-}" && -d "$(dirname "$LAUNCHER_LOG_FILE")" ]] && \
                    printf '[godot-mcp-launcher] stage=RUNTIME_READY waited_s=%s retries=%s\n' "$_HELD_WAITED_S" "$_HELD_RETRY_N" >>"$LAUNCHER_LOG_FILE" 2>/dev/null || true
            fi
            log "fast-fail recovery: held lock for ${KOL_RUNTIME_ID} is stale (pid=${_owner_pid:-<unknown>} dead); clearing and retrying."
            rm -rf "$RUNTIME_HELD"
            mkdir "$RUNTIME_HELD" 2>/dev/null || { sleep 1; continue; } # lost mkdir race: re-enter the wait
            break
        fi
        # Live holder: wait-retry instead of the 56ms die (the holder is in its
        # lease grace window and will exit shortly).
        if (( _HELD_WAITED_S >= _HELD_WAIT_MAX_S )); then
            die "fast-fail: another proxy holds runtime_id=${KOL_RUNTIME_ID} (holder pid=${_owner_pid}) after waiting ${_HELD_WAITED_S}s (${_HELD_RETRY_N} retries, KOL_RUNTIME_HELD_WAIT_S=${_HELD_WAIT_MAX_S}); this run is a duplicate of the same task slot. Stop the older run first, or check for a leaked proxy."
        fi
        _HELD_RETRY_N=$(( _HELD_RETRY_N + 1 ))
        _HELD_WAITED_S=$(( _HELD_WAITED_S + 2 ))
        printf '[godot-mcp-launcher] stage=RUNTIME_WAIT msg="another live proxy holds this runtime; waiting for its lease to lapse" retry=%s waited_s=%s max_s=%s holder_pid=%s\n' \
            "$_HELD_RETRY_N" "$_HELD_WAITED_S" "$_HELD_WAIT_MAX_S" "$_owner_pid" >&2
        [[ -n "${LAUNCHER_LOG_FILE:-}" && -d "$(dirname "$LAUNCHER_LOG_FILE")" ]] && \
            printf '[godot-mcp-launcher] stage=RUNTIME_WAIT retry=%s waited_s=%s max_s=%s holder_pid=%s\n' \
                "$_HELD_RETRY_N" "$_HELD_WAITED_S" "$_HELD_WAIT_MAX_S" "$_owner_pid" >>"$LAUNCHER_LOG_FILE" 2>/dev/null || true
        sleep 2
    done
fi
# Write our pid so the next contender can probe us. trap releases the lock
# on any launcher exit — exec never returns so the lock persists until the
# spawned node proxy or operator reaps it (P2 cleanup path picks it up).
printf '%s\n' "$$" > "${RUNTIME_HELD}/pid"
cleanup_held() { rm -rf "$RUNTIME_HELD" 2>/dev/null || true; }
trap cleanup_held EXIT

# SEE-1148 P2 (§2.2 dynamic port allocation): when the operator/platform did
# NOT pin an explicit port (--port / KOL_MCP_PORT unset → PORT came from the
# legacy per-agent table), this runtime instead allocates a port from the
# dynamic pool 6560-6609 via the arbiter. The arbiter grant is keyed by
# runtime_id, so two concurrent slots of the SAME agent get DISTINCT dynamic
# ports (T1/T3) and never collide on the legacy per-agent port (which is
# shared by name and would make slot B hijack slot A's editor).
#
# Gating: KOL_PORT_ARBITER=off disables the arbiter entirely (operator escape
# hatch / legacy behavior). An explicit --port / KOL_MCP_PORT also bypasses it
# (the caller owns the port choice). The legacy table value is the FALLBACK
# when the pool is exhausted, keeping single-slot legacy behavior intact.
# shellcheck source=port-arbiter.lib.sh
source "${SCRIPT_DIR}/port-arbiter.lib.sh"
ARBITER_ON="$([ "${KOL_PORT_ARBITER:-on}" != "off" ] && echo 1 || echo 0)"
EXPLICIT_PORT_GIVEN=0
[[ -n "$EXPLICIT_PORT" || -n "${KOL_MCP_PORT:-}" ]] && EXPLICIT_PORT_GIVEN=1
if (( ARBITER_ON == 1 && EXPLICIT_PORT_GIVEN == 0 )); then
    # Reuse an existing live grant for THIS runtime first (a warm restart of
    # the same slot must not burn a second port); else allocate fresh.
    _arb_port=""
    _arb_port="$(port_arbiter_ensure "$KOL_RUNTIME_ID" "$$" 2>/dev/null || true)"
    if [[ "$_arb_port" =~ ^[0-9]+$ ]]; then
        log "dynamic port allocated: runtime_id=${KOL_RUNTIME_ID} port=${_arb_port} (was table port ${PORT})."
        PORT="$_arb_port"
        LABEL="$(agent_label_for_port "$PORT")"
        export GODOT_PORT="$PORT"
        export LAUNCHER_LOG_FILE="${GODOT_MCP_HOME}/godot-mcp-launcher-${LABEL}.log"
    else
        # Atlas Final Review MEDIUM-1: pool exhaustion MUST die, not silently
        # fall back to the legacy table port. Two slots of the same agent
        # would then BOTH pin the same legacy port and resurrect the exact
        # mutual-kick this PR exists to kill. `|| true` swallowed arbiter
        # crashes as "exhausted" too — the die message names both failure
        # modes so the operator can distinguish.
        die "dynamic port pool (6560-6609) exhausted or arbiter failed for runtime_id=${KOL_RUNTIME_ID}; refusing to fall back to shared legacy port ${PORT} (would resurrect same-agent mutual-kick). Free a held port (reap-stale-leases.sh) or pass --port explicitly."
    fi
    # Record the granted port in the launcher env so the proxy + helper
    # children (configure/start) all bind the SAME dynamic port. §4.5.3 T2:
    # set BOTH canonical (GODOT_MCP_PORT) and the KOL_ legacy alias so
    # pre-T2 addon builds that still read KOL_MCP_PORT keep working.
    export GODOT_MCP_PORT="$PORT"
    export KOL_MCP_PORT="$PORT"
fi

# SEE-1148 P2 (item 4, same-worktree multi-runtime): concurrency granularity
# is the WORKTREE. Two concurrent runtimes of the same agent are normally in
# DISTINCT per-slot worktrees already (multica repo checkout gives each slot
# its own workdir), so the same-worktree case only arises when worktree
# RESOLUTION mis-pins two slots onto one checkout. Detect that here: scan the
# registry for a LIVE (heartbeat-fresh) DIFFERENT runtime already holding THIS
# worktree. When found, this slot must not collide on the shared project.godot
# / sidecar — fall to a distinct worktree.
#
# Red lines respected: we NEVER `git worktree add` from the launcher (that is
# the platform's checkout job, and touching the shared repo risks the
# master-branch invariant). The toolchain-feasible form of "auto-fall to a new
# worktree" is: refuse to serve the contended worktree and surface a loud,
# actionable diagnostic so the platform/operator re-points this slot at its
# own checkout. No queueing, no addon exception — the editor for the contended
# worktree is simply not spawned twice.
if [[ -f "$PORT_REGISTRY_PATH" && -n "${KOL_WORKTREE:-}" ]]; then
    _wt_holder=""
    _wt_holder="$(
        REG_PATH="$PORT_REGISTRY_PATH" REG_RID="$KOL_RUNTIME_ID" REG_WT="$KOL_WORKTREE" \
        node -e '
            const fs = require("fs");
            let out = "";
            try {
                const cur = JSON.parse(fs.readFileSync(process.env.REG_PATH, "utf8"));
                const entries = (cur && cur.entries) || {};
                const now = Date.now();
                for (const [rid, e] of Object.entries(entries)) {
                    if (rid === process.env.REG_RID) continue;          // skip self
                    if (!e || e.worktree !== process.env.REG_WT) continue; // same worktree only
                    const hb = e.heartbeat_at ? Date.parse(e.heartbeat_at) : 0;
                    if (hb && (now - hb) < 60000) { out = rid; break; }  // live holder
                }
            } catch (err) {}
            process.stdout.write(out);
        ' 2>/dev/null || true
    )"
    if [[ -n "$_wt_holder" ]]; then
        die "same-worktree contention: worktree ${KOL_WORKTREE} is already served by a LIVE runtime (${_wt_holder}). Concurrency granularity is the worktree — this slot must use its OWN per-slot worktree (multica repo checkout). Re-launch this launcher from this slot's own workdir (~/multica_workspaces/<ws>/<this-slot-hash>/workdir/${GODOT_MCP_REPO_DIRNAME}), or set KOL_WORKTREE/KOL_PROJECT_GODOT to a distinct checkout. Refusing to spawn a second editor on one worktree (no queueing, no addon exception)."
    fi
fi

# Atlas Final Review D8 (HIGH): an outer `exec 9>"$REG_LOCK"; flock 9` here was
# an ILLUSION — port_registry_upsert's own `exec 9>"$lock_path"` first CLOSES
# fd 9 (releasing the outer lock) then re-flocks it, so the claimed
# mkdir-check → upsert TOCTOU window was never covered. The upsert's inner
# BLOCKING flock IS the real critical section (concurrent writers serialize
# naturally). Remove the dead outer lock rather than pretend it protects.

port_registry_upsert "$KOL_RUNTIME_ID" \
    "port=${PORT}" "agent=${KOL_AGENT_NAME:-unknown}" "label=${LABEL}" \
    "worktree=${KOL_WORKTREE}" "proxy_pid=$$" \
    "heartbeat_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" 2>/dev/null || \
    log "WARNING: port-registry upsert failed (non-fatal)."

# --- Informational port status (no action; the proxy owns spawn/reuse) -------
# Replaces the former idempotent setup block (configure + start, with orphan
# kill). The proxy now decides whether to spawn on first tools/call, so the
# launcher just logs the boot state for the operator / QA harness.
if port_in_use "$PORT"; then
    log "port ${PORT} already listening; proxy will reuse if the holder is healthy."
    log_stage "stage=PORT_BUSY msg=\"proxy will reuse if holder healthy\" port=${PORT}"
else
    log "port ${PORT} free; proxy will lazy-spawn the editor on first tools/call."
    log_stage "stage=PORT_FREE msg=\"proxy will lazy-spawn on first tools/call\" port=${PORT}"
fi

# --- Hand stdio to the warmup-aware MCP proxy --------------------------------
# The editor is NOT booted yet (B1); the proxy answers initialize/tools/list
# immediately (npx is up + handles them) and spawns the editor on first
# tools/call. Render-stable and TCP readiness monitoring live inside the
# proxy and are unchanged from SEE-1070/1077.
#
# Restore the original MCP stdio pipe before exec; until now the script's
# stdin was detached from /dev/null so no intermediate launcher command
# could consume the JSON-RPC handshake. SEE-1045.
exec 0<&${ORIG_STDIN}
exec {ORIG_STDIN}<&-
# SEE-1085 usability: opt the proxy into the direct-node godot-mcp launch path.
# The resolver then spawns `node <bin>` when the package is already in the npx
# cache, skipping npx's ~2.9s cold-start overhead (measured) and cutting the
# cold MCP handshake from ~6s toward ~0.6s. First run on a fresh machine (empty
# cache) transparently falls back to `npx -y` and populates the cache for next
# time. Opt-in via env so test harnesses that mock npx on PATH are unaffected.
export GODOT_MCP_DIRECT_GODOT_MCP="${GODOT_MCP_DIRECT_GODOT_MCP:-${KOL_DIRECT_GODOT_MCP:-1}}"
# SEE-1111 (fork wiring): serve godot-mcp from the OWNER's fork
# (tadki/godot-mcp) instead of the upstream @satelliteoflove/godot-mcp package.
# The fork fixes the cold-start 'Not connected' failure by making the server's
# QUICK_TIMEOUT_MS configurable (GODOT_MCP_QUICK_TIMEOUT_MS, default stays 30s
# upstream). The resolver (godot-mcp-resolve.mjs, the SINGLE server locator)
# treats any non-'npx' OVERRIDE_CMD as a path to the bin entry and spawns
# `node <path>`, so this one export switches the toolchain to the fork. Both
# exports are DEFAULT-ONLY (${VAR:-...}): an external override (a test harness
# that mocks npx, or an operator pointing elsewhere) wins, keeping the seam.
FORK_CLI="${GODOT_MCP_FORK_CLI:-${SCRIPT_DIR}/../server/dist/cli.js}"
FORK_SERVER_DIR="${SCRIPT_DIR}/../server"
# SEE-1288 (build fallback): server/dist/ is gitignored, so a fresh submodule
# checkout has no fork CLI and the wiring above silently degraded to upstream
# npx (30s QUICK_TIMEOUT → first-call timeout). When the default path is
# missing but the submodule ships the server source, build it once; dist +
# node_modules stay gitignored, nothing build-shaped is committed. Explicit
# GODOT_MCP_FORK_CLI overrides pointing at a missing path do NOT trigger the
# build (the operator said where the CLI lives — respect it, keep WARNING).
if [[ ! -x "$FORK_CLI" && -z "${GODOT_MCP_FORK_CLI:-}" && -f "${FORK_SERVER_DIR}/package.json" && -d "${FORK_SERVER_DIR}/src" ]]; then
    log "fork CLI missing at ${FORK_CLI}; building from ${FORK_SERVER_DIR} (one-time, gitignored output)..."
    # SEE-1288 MEDIUM-1: keep the full npm output on disk so a failed build is
    # diagnosable — the WARNING below must point at a file that actually holds
    # the npm ci/build errors (runtime_id-tagged, same $GODOT_MCP_HOME family as the
    # other launcher logs).
    FORK_BUILD_LOG="${GODOT_MCP_HOME}/godot-mcp-fork-build-${KOL_RUNTIME_ID:-<unknown>}.log"
    mkdir -p "$(dirname "$FORK_BUILD_LOG")"
    if (cd "${FORK_SERVER_DIR}" && { npm ci --no-audit --no-fund && npm run build && chmod +x "${FORK_SERVER_DIR}/dist/cli.js"; } ) >"$FORK_BUILD_LOG" 2>&1; then
        log "fork CLI build OK: ${FORK_SERVER_DIR}/dist/cli.js"
    else
        log "WARNING: fork CLI build failed in ${FORK_SERVER_DIR}; full npm output saved to ${FORK_BUILD_LOG}; keeping upstream godot-mcp."
    fi
fi
if [[ -x "$FORK_CLI" ]]; then
    export GODOT_MCP_GODOT_MCP_CMD="${GODOT_MCP_GODOT_MCP_CMD:-${KOL_GODOT_MCP_CMD:-$FORK_CLI}}"
    export GODOT_MCP_QUICK_TIMEOUT_MS="${GODOT_MCP_QUICK_TIMEOUT_MS:-90000}"
    log_stage "stage=FORK_WIRED msg=\"godot-mcp served from owner fork\" cli=${GODOT_MCP_GODOT_MCP_CMD} quick_timeout_ms=${GODOT_MCP_QUICK_TIMEOUT_MS}"
else
    log "WARNING: fork CLI not found at ${FORK_CLI}; keeping upstream godot-mcp (${GODOT_MCP_QUICK_TIMEOUT_MS:-default 30s} timeout)."
fi
log_stage "stage=LAUNCHER_EXEC msg=\"exec godot-mcp-proxy.mjs\" port=${PORT}"
log "exec ${SCRIPT_DIR}/godot-mcp-proxy.mjs (GODOT_PORT=${GODOT_PORT} KOL_WORKTREE=${KOL_WORKTREE:-<unset>} KOL_RUNTIME_ID=${KOL_RUNTIME_ID}${KOL_FROM_SHIM:+ from=shim})."
exec node "$SCRIPT_DIR/godot-mcp-proxy.mjs"