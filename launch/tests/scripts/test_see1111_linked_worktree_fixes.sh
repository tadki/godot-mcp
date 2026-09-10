#!/usr/bin/env bash
# test_see1111_linked_worktree_fixes.sh
#
# Rewritten under SEE-1117 Direction 3 — original asserted project.godot
# [godot_mcp] section; current asserts sidecar at <worktree>/.godot/mcp-lease.json.
# See Bachi's evidence report in issue SEE-1117 thread 643309c3.
#
# SEE-1111 regression for Revy 缺陷2 + 缺陷3 (both still present on master before
# this test):
#
#   缺陷2 (HIGH): prepare-worktree.sh's repo-root walk-up used
#     `[[ -d "$local_dir/.git" ... ]]`. In a LINKED worktree `.git` is a FILE
#     (a gitdir pointer), not a directory, so the walk-up skipped the repo root
#     and self-location failed with "Could not locate a Godot worktree" whenever
#     no --worktree / KOL_WORKTREE was passed.
#   缺陷3 (MEDIUM): repo-checkout.sh called prepare-worktree.sh with NO
#     --worktree and WITHOUT exporting KOL_AGENT_NAME, and `|| true` swallowed
#     any failure — so on a fresh agent checkout the sidecar lease was never
#     written.
#
# Direction 3 change: project.godot is git-tracked (restored by `git reset
# --hard`); prepare-worktree.sh no longer copies a clean project.godot from
# D-drive / a historical blob — it just writes the per-worktree sidecar lease
# <wt>/.godot/mcp-lease.json (state=active, port=<agent port>). The 缺陷2
# walk-up regression assertions (B block, `-e` not `-d` for .git) are
# INDEPENDENT of the project.godot source mechanism and remain valid as-is.
#
# Fixture: a throwaway git repo with a `master` branch carrying the tracked
# project.godot (Direction 3 reality), plus a real LINKED worktree on a
# feature branch. No D-drive / network required.
#
# Assertions:
#   A. linked worktree: `.git` is a FILE (fixture validity)
#   B. 缺陷2 — `prepare-worktree.sh --port <p>` run from INSIDE the linked
#      worktree WITHOUT --worktree self-locates via the walk-up (rc=0)
#   C. 缺陷2 — the resulting sidecar pins the agent's port correctly
#      (state=active, port=<p>) at <wt>/.godot/mcp-lease.json
#   D. 缺陷3 — `prepare-worktree.sh --worktree <dir>` (the repo-checkout
#      invocation shape) on a fresh linked worktree writes the sidecar
#      (state=active, port=<p>) — Direction 3 replaces "copy clean project.godot"
#      with "write sidecar"; project.godot comes from `git reset --hard`.
#   E. 缺陷3 — KOL_AGENT_NAME env is honored without a positional agent name
#      (env resolves Bachi=6553 from the SSOT table; sidecar port matches)
#   F. idempotent: re-run with the same invocation is a fast-path no-op (rc=0,
#      lease_id UNCHANGED)
#   G. regression: the write-target guard still refuses a master checkout
#   H. regression: a NON-repo directory still fails self-location (rc=2)
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1111_linked_worktree_fixes.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PREPARE="$REPO_ROOT/launch/prepare-worktree.sh"
PORTS_JSON="$REPO_ROOT/launch/agent-ports.json"
KNOWN_SHARED="/mnt/d/GodotProjects/king-of-likes"

# Bachi = 6553 from the SSOT (the same table launcher/configure/prepare read).
BACHI_PORT="$(jq -r '.agents["Bachi"]' "$PORTS_JSON")"

# Read a sidecar field via node (no jq dependency — matches the toolchain and the
# SEE-1117 Suite A reference). Returns '' on missing file/field/malformed JSON.
sidecar_field() {
    local sc="$1" f="$2"
    [ -f "$sc" ] || { echo ''; return; }
    SIDE_FIELD="$f" node -e '
        let raw = "";
        process.stdin.on("data", c => raw += c);
        process.stdin.on("end", () => {
            try {
                const o = JSON.parse(raw);
                const v = o[process.env.SIDE_FIELD];
                process.stdout.write(v === null || v === undefined ? "" : String(v));
            } catch (e) { process.stdout.write(""); }
        });
    ' < "$sc" 2>/dev/null
}

sep "SEE-1111 缺陷2+缺陷3 Direction 3: linked-worktree self-location + repo-checkout invocation"

# ---- Fixture: real git repo + linked worktree (no D-drive, no network) ----
# Seed the object store from the shared Multica mirror (clone --shared). Direction
# 3 reality: master tracks project.godot (the current HEAD does), and linked
# worktrees inherit the tracked file from `git reset --hard`. The mirror is
# read-only here; nothing in this fixture writes back to it.
GIT_MIRROR="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null)"
if [[ -z "$GIT_MIRROR" || ! -d "$GIT_MIRROR/objects" ]]; then
    echo "[test] FATAL: cannot locate shared git object store for $REPO_ROOT" >&2
    exit 1
fi
GITROOT="$TMPDIR/repo"
LINKED="$TMPDIR/linked"
FRESH="$TMPDIR/fresh"
git clone -q --shared "$GIT_MIRROR" "$GITROOT" 2>/dev/null \
    || { echo "[test] FATAL: cannot seed fixture repo" >&2; exit 1; }
mkdir -p "$GITROOT/launch"
touch "$GITROOT/launch/.marker"
git -C "$GITROOT" config user.email "test@example.com" >/dev/null 2>&1
git -C "$GITROOT" config user.name "Test" >/dev/null 2>&1
# master -> the CURRENT repo HEAD (Direction 3 reality: project.godot tracked).
# Linked worktrees created from master therefore carry project.godot on disk —
# the production shape after `git reset --hard origin/<wb>`.
REPO_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
git -C "$GITROOT" update-ref refs/heads/master "$REPO_HEAD" 2>/dev/null
git -C "$GITROOT" update-ref refs/remotes/origin/master "$REPO_HEAD" 2>/dev/null
git -C "$GITROOT" checkout -q master 2>/dev/null || true
# Real LINKED worktree on its own feature branch: .git becomes a FILE.
git -C "$GITROOT" worktree add -q -b feature/Linked "$LINKED" master 2>/dev/null \
    || git -C "$GITROOT" worktree add -q -b feature/Linked "$LINKED" 2>/dev/null
# FRESH linked worktree (second agent scenario). Direction 3: project.godot is
# tracked, so the fresh linked worktree inherits it from master on disk. We do
# NOT rm it — production keeps the tracked file present.
git -C "$GITROOT" worktree add -q -b feature/Fresh "$FRESH" master 2>/dev/null \
    || git -C "$GITROOT" worktree add -q -b feature/Fresh "$FRESH" 2>/dev/null
# Sanity: the fresh linked worktree really has project.godot on disk.
[[ -f "$FRESH/project.godot" ]] || { echo "[test] FATAL: fresh linked worktree missing project.godot (Direction 3 keeps it tracked)" >&2; exit 1; }

# ---- A. fixture validity: linked worktree .git is a FILE ----
sep "A. linked-worktree fixture (.git is a file)"
if [[ -e "$LINKED/.git" && ! -d "$LINKED/.git" ]]; then
    ok "A1: linked worktree .git is a file (gitdir pointer)"
else
    ko "A1: expected linked worktree .git to be a FILE, got $(ls -ld "$LINKED/.git" 2>/dev/null)"
fi

# ---- B/C. 缺陷2: no-arg walk-up self-locates from inside the linked worktree ----
sep "B/C. 缺陷2: prepare-worktree self-locates from inside the linked worktree"
PREP_OUT="$(cd "$LINKED" && bash "$PREPARE" --port "$BACHI_PORT" 2>&1)"
PREP_RC=$?
if [[ $PREP_RC -eq 0 ]]; then
    ok "B1: no-arg self-location rc=0 (walk-up found the linked worktree)"
else
    ko "B1: expected rc=0, got rc=$PREP_RC (out: $PREP_OUT)"
fi
if echo "$PREP_OUT" | grep -q "worktree     : $LINKED\$"; then
    ok "B2: walk-up resolved the linked worktree root ($LINKED)"
else
    ko "B2: expected worktree root $LINKED, got: $PREP_OUT"
fi
# Direction 3: port now lives in the sidecar, not in project.godot.
LINKED_SC="$LINKED/.godot/mcp-lease.json"
LINKED_STATE="$(sidecar_field "$LINKED_SC" state)"
LINKED_PORT="$(sidecar_field "$LINKED_SC" port)"
LINKED_LID="$(sidecar_field "$LINKED_SC" lease_id)"
if [[ "$LINKED_STATE" == "active" && "$LINKED_PORT" == "$BACHI_PORT" && -n "$LINKED_LID" ]]; then
    ok "C1: sidecar state=active port=$BACHI_PORT in the linked worktree"
else
    ko "C1: sidecar wrong (state=${LINKED_STATE:-<empty>} port=${LINKED_PORT:-<empty>} lease_id=${LINKED_LID:-<empty>})"
fi

# ---- D. 缺陷3: --worktree invocation on a FRESH linked worktree (Direction 3:
#         project.godot is tracked/inherited; prepare-worktree just writes the
#         sidecar lease, replacing the old copy-clean-from-D-drive step) ----
sep "D. 缺陷3: --worktree invocation writes the sidecar on a fresh linked worktree"
FRESH_OUT="$(bash "$PREPARE" --worktree "$FRESH" --port "$BACHI_PORT" 2>&1)"
FRESH_RC=$?
if [[ $FRESH_RC -eq 0 ]]; then
    ok "D1: --worktree invocation rc=0 on fresh linked worktree"
else
    ko "D1: expected rc=0, got rc=$FRESH_RC (out: $FRESH_OUT)"
fi
if echo "$FRESH_OUT" | grep -q "writing sidecar lease for port ${BACHI_PORT}"; then
    ok "D2: fresh worktree sidecar-write path fired (configure from prepare-worktree)"
else
    ko "D2: expected sidecar-write path, got: $FRESH_OUT"
fi
FRESH_SC="$FRESH/.godot/mcp-lease.json"
FRESH_STATE="$(sidecar_field "$FRESH_SC" state)"
FRESH_PORT="$(sidecar_field "$FRESH_SC" port)"
FRESH_LID="$(sidecar_field "$FRESH_SC" lease_id)"
if [[ -f "$FRESH_SC" ]]; then
    ok "D3: sidecar exists at <fresh-wt>/.godot/mcp-lease.json"
else
    ko "D3: sidecar missing at $FRESH_SC"
fi
if [[ "$FRESH_STATE" == "active" && "$FRESH_PORT" == "$BACHI_PORT" && -n "$FRESH_LID" ]]; then
    ok "D4: sidecar state=active port=$BACHI_PORT (lease_id present)"
else
    ko "D4: sidecar wrong (state=${FRESH_STATE:-<empty>} port=${FRESH_PORT:-<empty>} lease_id=${FRESH_LID:-<empty>})"
fi

# ---- E. 缺陷3: KOL_AGENT_NAME env is honored (repo-checkout exports it) ----
sep "E. 缺陷3: KOL_AGENT_NAME env resolves the agent port (no positional name)"
FRESH2="$TMPDIR/fresh2"
git -C "$GITROOT" worktree add -q -b feature/Fresh2 "$FRESH2" master
ENV_OUT="$(KOL_AGENT_NAME=Bachi bash "$PREPARE" --worktree "$FRESH2" 2>&1)"
ENV_RC=$?
FRESH2_SC="$FRESH2/.godot/mcp-lease.json"
FRESH2_PORT="$(sidecar_field "$FRESH2_SC" port)"
if [[ $ENV_RC -eq 0 ]] && [[ "$FRESH2_PORT" == "$BACHI_PORT" ]]; then
    ok "E1: KOL_AGENT_NAME=Bachi resolved sidecar port $BACHI_PORT (rc=0)"
else
    ko "E1: expected rc=0 + sidecar port $BACHI_PORT, got rc=$ENV_RC port=${FRESH2_PORT:-<empty>} (out: $ENV_OUT)"
fi

# ---- F. idempotent: re-run is a fast-path no-op, lease_id UNCHANGED ----
sep "F. idempotent re-run (fast-path no-op, lease_id stable)"
FRESH_LID_BEFORE="$(sidecar_field "$FRESH_SC" lease_id)"
PREP_OUT2="$(bash "$PREPARE" --worktree "$FRESH" --port "$BACHI_PORT" 2>&1)"
PREP_RC2=$?
FRESH_LID_AFTER="$(sidecar_field "$FRESH_SC" lease_id)"
if [[ $PREP_RC2 -eq 0 ]] && echo "$PREP_OUT2" | grep -q "Fast path"; then
    ok "F1: re-run is a configure fast-path no-op (rc=0)"
else
    ko "F1: re-run not a fast-path no-op (rc=$PREP_RC2 out: $PREP_OUT2)"
fi
if [[ -n "$FRESH_LID_BEFORE" && "$FRESH_LID_BEFORE" == "$FRESH_LID_AFTER" ]]; then
    ok "F2: re-run leaves lease_id unchanged (fast path is a real no-op)"
else
    ko "F2: lease_id regenerated on fast-path (before=${FRESH_LID_BEFORE:-<empty>} after=${FRESH_LID_AFTER:-<empty>})"
fi

# ---- G. regression: write-target guard still refuses a master checkout ----
sep "G. regression: write-target guard (master checkout refused)"
GUARD_OUT="$(bash "$PREPARE" --worktree "$GITROOT" --port "$BACHI_PORT" 2>&1)"
GUARD_RC=$?
if [[ $GUARD_RC -eq 2 ]] && echo "$GUARD_OUT" | grep -qi "write-target guard"; then
    ok "G1: prepare-worktree refuses a master checkout (rc=2)"
else
    ko "G1: expected rc=2 + write-target guard, got rc=$GUARD_RC ($GUARD_OUT)"
fi
if [[ -n "$KNOWN_SHARED" ]]; then
    GUARD2_OUT="$(bash "$PREPARE" --worktree "$KNOWN_SHARED" --port "$BACHI_PORT" 2>&1)"
    GUARD2_RC=$?
    if [[ $GUARD2_RC -eq 2 ]] && echo "$GUARD2_OUT" | grep -qi "write-target guard"; then
        ok "G2: prepare-worktree refuses the shared D-drive master checkout (rc=2)"
    else
        ko "G2: expected rc=2 + write-target guard, got rc=$GUARD2_RC ($GUARD2_OUT)"
    fi
fi

# ---- H. regression: non-repo dir still fails self-location ----
sep "H. regression: non-repo dir does not self-locate"
NONREPO_OUT="$(cd "$TMPDIR" && bash "$PREPARE" --port "$BACHI_PORT" 2>&1)"
NONREPO_RC=$?
if [[ $NONREPO_RC -eq 2 ]] && echo "$NONREPO_OUT" | grep -q "Could not locate a Godot worktree"; then
    ok "H1: non-repo dir self-location fails cleanly (rc=2)"
else
    ko "H1: expected rc=2 + could-not-locate, got rc=$NONREPO_RC ($NONREPO_OUT)"
fi

summary
