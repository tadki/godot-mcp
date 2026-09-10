#!/usr/bin/env bash
# SEE-1148 P1 (identity landing): runtime_id derivation + lifecycle-file paths.
#
# runtime_id = "<agent>-<slot_hash8>" where slot_hash8 is the 8-hex runtime
# hash directory component of the multica worktree path
# (~/multica_workspaces/<workspace>/<hash8>/workdir/KingOfLikes-Godot). The
# hash is stable across turns of the same task slot and distinct between
# concurrent same-agent slots — exactly the identity the port layer needs to
# tell two concurrent Bachi runs apart. When no hash can be extracted (a
# manually-launched editor outside a slot), the id degrades to
# "<agent>-solo" so single-runtime operation keeps working.
#
# Lifecycle files migrate from the flat
#   ~/.multica/godot-editor-<agent>.{pid,worktree,log}
# to the directory form
#   ~/.multica/godot-editor/<runtime_id>.{pid,worktree,log}
# During the migration window readers check BOTH locations: new (directory)
# first, then legacy flat. Writers with a KOL_RUNTIME_ID always write the new
# location; without one they keep the legacy name so old callers are inert.

KOL_SLOT_FALLBACK="solo"

# mcp_runtime_id_regex: the canonical regex matching a real slot runtime_id
# "<agent>-<hex>". The agent name accepts letters/digits/underscore/hyphen
# (leading char must be a letter — covers both `Bachi-` and `bachi-` case
# variance); the slot hash is lowercase hex (8 chars in the legacy bare-dir
# layout, up to 12 in the see-<issue>-<hex> layout — both now derive per-slot
# identities). `-solo` and any non-hex id deliberately do NOT match — they
# must never qualify for the legacy-flat lifecycle cleanup (F3). Single source
# of truth: the reaper and the T15/T16 tests all reference this instead of
# hardcoding the pattern.
mcp_runtime_id_regex() {
    printf '%s\n' '^[A-Za-z][A-Za-z0-9_-]*-[0-9a-f]{8,}$'
}

# mcp_slot_hash_for <worktree>: print the hex slot hash or nothing.
# The multica slot dir is "<prefix>-<hex>" (SEE-1244 并发隔离修复): the current
# platform names task slots `<workspace>/see-<issue>-<12hex>/…` (e.g.
# `see-1259-aa4de5376e75`), and the legacy layout used a bare `<8hex>` dir
# (`5d621003`). Both must resolve to a distinct per-slot hash so concurrent
# same-agent issues get DIFFERENT runtime_ids (previously the see-* names
# produced no hash → every concurrent Revy probe collapsed to `Revy-solo`,
# sharing one held lock/lease and mutually evicting inside the handshake
# window — the concurrency-suite FAIL root cause). Rule: the last
# `-separated` component of the slot dir must be hex; if it is, use it as the
# hash (any length, 8+ hex stable). A slot dir with no trailing hex (not a
# real slot) still returns nothing → `<agent>-solo`.
mcp_slot_hash_for() {
    local wt="${1:-}" rest h tail
    [[ -n "$wt" ]] || return 1
    local base="${GODOT_MCP_WORKSPACES_BASE:-${HOME}/multica_workspaces}"
    rest="${wt#*"${base}"/*/}"   # drop <base>/<ws>/ (base env-overridable, §4.5.3 T2)
    h="${rest%%/*}"                         # first component = the slot dir
    tail="${h##*-}"                         # last -segmented component
    if [[ "$tail" =~ ^[0-9a-f]{8,}$ ]]; then
        printf '%s\n' "$tail"
        return 0
    fi
    return 1
}

# mcp_derive_runtime_id <agent_name> [worktree]: print "<agent>-<hash8>" or
# "<agent>-solo". Degrades gracefully — never fails.
mcp_derive_runtime_id() {
    local agent="${1:-}" wt="${2:-${KOL_WORKTREE:-}}"
    local h
    h="$(mcp_slot_hash_for "$wt" || true)"
    if [[ -z "$agent" ]]; then
        # No agent name either (should not happen on the real paths) — hash alone.
        printf '%s\n' "${h:-$KOL_SLOT_FALLBACK}"
        return 0
    fi
    printf '%s\n' "${agent}-${h:-$KOL_SLOT_FALLBACK}"
}

# mcp_state_dir: the directory-form lifecycle home.
mcp_state_dir() {
    printf '%s\n' "${HOME}/.multica/godot-editor"
}

# kol_lifecycle_path <suffix> <label> <runtime_id>: resolve a lifecycle file
# (.pid/.worktree/.log). Prefers the new directory form; falls back to the
# legacy flat name when the new file does not exist yet (migration window).
#
# A `-solo` runtime_id (manual launch outside a slot) ALWAYS resolves to the
# legacy flat name — it predates the directory migration and shares the
# per-label name with pre-P1 tooling. Non-solo runtime_ids resolve to the
# directory form. This keeps writers and readers on ONE rule (F4).
#
# LOW-7 (Atlas Final Review): the `-e "$new"` existence check below is a
# TOCTOU window — a concurrent same-slot writer could create the new file
# between the check and the caller's own write. This is safe ONLY because
# every caller holds the B-6 mkdir held-lock for its runtime_id before
# touching lifecycle files (see godot-mcp-launcher.sh "fast-fail via mkdir
# lock"); the lock serializes all same-slot lifecycle resolution. Do NOT call
# this function outside a B-6-held critical section (or accept that the
# resolution is advisory, not exclusive).
kol_lifecycle_path() {
    local suffix="$1" label="$2" runtime_id="${3:-${KOL_RUNTIME_ID:-}}"
    local new="${HOME}/.multica/godot-editor/${runtime_id}${suffix}"
    local legacy="${HOME}/.multica/godot-editor-${label}${suffix}"
    if [[ "$runtime_id" == *-solo ]]; then
        printf '%s\n' "$legacy"
    elif [[ -n "$runtime_id" && -e "$new" ]]; then
        printf '%s\n' "$new"
    elif [[ -n "$runtime_id" && ! -e "$legacy" ]]; then
        # Neither exists: caller is about to WRITE — point it at the new home.
        printf '%s\n' "$new"
    else
        printf '%s\n' "$legacy"
    fi
}


# --- legacy KOL_* aliases (SEE-1268 §4.5.3 T2): 存量调用零破坏 ---
kol_slot_hash_for() { mcp_slot_hash_for "$@"; }
kol_runtime_id_regex() { mcp_runtime_id_regex "$@"; }
kol_derive_runtime_id() { mcp_derive_runtime_id "$@"; }
kol_state_dir() { mcp_state_dir "$@"; }
