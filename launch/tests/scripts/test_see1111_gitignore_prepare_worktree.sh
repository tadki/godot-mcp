#!/usr/bin/env bash
# test_see1111_gitignore_prepare_worktree.sh
#
# Rewritten under SEE-1117 Direction 3 — original asserted project.godot
# [godot_mcp] section; current asserts sidecar at <worktree>/.godot/mcp-lease.json.
# See Bachi's evidence report in issue SEE-1117 thread 643309c3.
#
# SEE-1111 目标1 owner final plan (superseded) shipped project.godot as untracked
# + gitignored + prepare-worktree copied a clean file from D-drive. SEE-1117
# Direction 3 INTENTIONALLY removed that mechanism: project.godot is now
# git-tracked, the .gitignore line for it is commented out, and `git reset --hard
# origin/<wb>` restores the clean HEAD version on every session. The per-agent
# MCP port moved to the per-worktree sidecar lease <wt>/.godot/mcp-lease.json
# (state=active, port=<agent port>) which configure-mcp-port.sh writes and
# .godot/ (already gitignored) keeps out of git.
#
# Atlas 验收要求（comment 40c5f341 后置条件 4）re-cast for Direction 3:
#   * project.godot 跟踪断言 —— 在真实仓库 git 状态上验证 (now: TRACKED + NOT
#     gitignored, because Direction 3 keeps it in git)
#   * 检出后 sidecar 端口断言 —— 在 fresh worktree 上跑 prepare-worktree.sh,
#     断言 sidecar state=active port=<agent port>
#
# 断言:
#   A. 真实仓库: `git ls-files project.godot` 返回 project.godot（TRACKED）
#   B. 真实仓库: `git check-ignore project.godot` 失败（NOT gitignored — the
#      Direction 3 .gitignore has the project.godot line commented out）
#   C. fresh worktree（project.godot 由 git reset --hard 提供）: prepare-worktree.sh
#      写出 sidecar <wt>/.godot/mcp-lease.json (state=active, port=<agent port>)
#   D. sidecar 的 port == 该 agent 专属端口（对照 agent-ports.json），state=active
#      且 project.godot 保持干净（configure 不写它，Direction 3 P1 oracle）
#   E. 幂等: 二次运行走 configure 快路径为 no-op（rc=0，lease_id 不变）
#   F. 写目标守卫仍生效: prepare-worktree.sh 拒绝 shared D-drive master checkout
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1111_gitignore_prepare_worktree.sh

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

sep "SEE-1111 目标1 Direction 3: project.godot tracked + prepare-worktree writes sidecar"

# ---- A/B. 真实仓库: project.godot tracked + NOT gitignored ----
sep "A/B. project.godot TRACKED + NOT gitignored in the real checkout"
if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if [[ "$(git -C "$REPO_ROOT" ls-files project.godot)" == "project.godot" ]]; then
        ok "A1: git ls-files project.godot returns project.godot (tracked)"
    else
        ko "A1: project.godot is NOT git-tracked (Direction 3 requires tracked)"
    fi
    if git -C "$REPO_ROOT" check-ignore -q project.godot; then
        ko "B1: .gitignore STILL matches project.godot (Direction 3 comments it out)"
    else
        ok "B1: .gitignore does NOT match project.godot (check-ignore rc!=0)"
    fi
else
    note "A/B skipped: $REPO_ROOT is not a git checkout"
fi

# ---- Fresh-worktree fixture: a real agent checkout on a feature branch whose
#      project.godot comes from origin/master HEAD (Direction 3: tracked file,
#      restored by `git reset --hard`). The fixture does NOT rm project.godot —
#      production keeps the tracked file on disk; the sidecar carries the port. ----
die_in_test() { echo "[test] FATAL: $*" >&2; exit 1; }
WT="$TMPDIR/agent_Bachi/KingOfLikes-Godot"

# Seed the fixture from the shared Multica mirror object store (clone --shared),
# so the real post-Direction-3 master commit (project.godot tracked) is reachable
# WITHOUT D-drive / network. The mirror is read-only here; nothing in this
# fixture writes back to it.
GIT_MIRROR="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null)"
if [[ -z "$GIT_MIRROR" || ! -d "$GIT_MIRROR/objects" ]]; then
    die_in_test "cannot locate shared git object store for $REPO_ROOT"
fi
git clone -q --shared "$GIT_MIRROR" "$WT" 2>/dev/null \
    || die_in_test "cannot seed fixture: clone --shared of the mirror failed"
mkdir -p "$WT/launch"

# Repoint origin/master at the CURRENT repo HEAD (Direction 3 reality: project.
# godot is tracked there), and check out a feature branch from it — mirrors the
# production shape (a fresh agent worktree after `git reset --hard origin/<wb>`).
REPO_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"
git -C "$WT" update-ref refs/remotes/origin/master "$REPO_HEAD" 2>/dev/null \
    || die_in_test "cannot seed fixture: update-ref origin/master failed"
git -C "$WT" checkout -qb feature/Bachi origin/master 2>/dev/null \
    || git -C "$WT" branch -m feature/Bachi 2>/dev/null || true
touch "$WT/launch/.marker"

# Fixture sanity: this really IS the Direction 3 scenario — origin/master's tree
# CARRIES project.godot (tracked), and the worktree's on-disk project.godot is
# the clean HEAD version (restored by git reset --hard, NOT deleted).
if ! git -C "$WT" ls-tree origin/master -- project.godot | grep -q project.godot; then
    die_in_test "fixture broken: origin/master does NOT carry project.godot (Direction 3 requires tracked)"
fi
if [[ ! -f "$WT/project.godot" ]]; then
    die_in_test "fixture broken: project.godot missing on disk (Direction 3 keeps it tracked)"
fi

# Snapshot the project.godot BEFORE prepare-worktree to assert Direction 3 P1:
# configure must NOT touch project.godot (byte-identical before/after).
PROJ_SNAPSHOT="$TMPDIR/p1-snapshot"
cp "$WT/project.godot" "$PROJ_SNAPSHOT"

# ---- C/D. prepare-worktree on a fresh worktree: sidecar lease write ----
sep "C/D. prepare-worktree.sh writes sidecar lease for Bachi=$BACHI_PORT"
PREP_OUT="$(bash "$PREPARE" --worktree "$WT" --port "$BACHI_PORT" 2>&1)"
PREP_RC=$?
if [[ $PREP_RC -eq 0 ]]; then
    ok "C1: prepare-worktree.sh rc=0"
else
    ko "C1: prepare-worktree.sh rc=$PREP_RC (out: $PREP_OUT)"
fi
if echo "$PREP_OUT" | grep -q "writing sidecar lease for port ${BACHI_PORT}"; then
    ok "C2: fresh worktree sidecar-write path fired (configure from prepare-worktree)"
else
    ko "C2: expected sidecar-write path, got: $PREP_OUT"
fi
# The Direction 3 replacement for "copied clean project.godot + pinned port":
# the sidecar at <wt>/.godot/mcp-lease.json now carries state=active + port.
SC="$WT/.godot/mcp-lease.json"
SC_STATE="$(sidecar_field "$SC" state)"
SC_PORT="$(sidecar_field "$SC" port)"
SC_LID="$(sidecar_field "$SC" lease_id)"
SC_WORKTREE="$(sidecar_field "$SC" worktree)"
if [[ -f "$SC" ]]; then
    ok "C3: sidecar exists at <wt>/.godot/mcp-lease.json"
else
    ko "C3: sidecar missing at $SC"
fi
if [[ "$SC_STATE" == "active" && "$SC_PORT" == "$BACHI_PORT" && -n "$SC_LID" ]]; then
    ok "D1: sidecar state=active port=$BACHI_PORT (lease_id present)"
else
    ko "D1: sidecar wrong (state=${SC_STATE:-<empty>} port=${SC_PORT:-<empty>} lease_id=${SC_LID:-<empty>})"
fi
if [[ "$SC_WORKTREE" == "$WT" ]]; then
    ok "D2: sidecar worktree field matches the private worktree ($WT)"
else
    ko "D2: sidecar worktree mismatch (got: ${SC_WORKTREE:-<empty>})"
fi
# Direction 3 P1: project.godot must be byte-identical after configure (the
# addon never writes it). Strong oracle — byte-diff, not grep.
if diff -q "$PROJ_SNAPSHOT" "$WT/project.godot" >/dev/null 2>&1; then
    ok "D3: project.godot byte-identical after prepare-worktree (Direction 3 P1)"
else
    ko "D3: prepare-worktree modified project.godot (Direction 3 forbids this)"
fi
# And the on-disk project.godot still matches HEAD's clean version (no marker,
# no port_override anywhere — Direction 3 removed them from the tracked file).
if grep -qE 'port_override' "$WT/project.godot"; then
    ko "D4: project.godot still carries port_override lines (Direction 3 removed them)"
else
    ok "D4: project.godot has no port_override lines (Direction 3 invariant)"
fi

# ---- E. Idempotent: second run is a fast-path no-op, lease_id UNCHANGED ----
sep "E. idempotent re-run (fast-path no-op, lease_id stable)"
LID_BEFORE="$(sidecar_field "$SC" lease_id)"
PREP_OUT2="$(bash "$PREPARE" --worktree "$WT" --port "$BACHI_PORT" 2>&1)"
PREP_RC2=$?
LID_AFTER="$(sidecar_field "$SC" lease_id)"
if [[ $PREP_RC2 -eq 0 ]] && echo "$PREP_OUT2" | grep -q "Fast path"; then
    ok "E1: re-run is a configure fast-path no-op (rc=0)"
else
    ko "E1: re-run not a fast-path no-op (rc=$PREP_RC2 out: $PREP_OUT2)"
fi
if [[ -n "$LID_BEFORE" && "$LID_BEFORE" == "$LID_AFTER" ]]; then
    ok "E2: re-run leaves lease_id unchanged (fast path is a real no-op)"
else
    ko "E2: lease_id regenerated on fast-path (before=${LID_BEFORE:-<empty>} after=${LID_AFTER:-<empty>})"
fi

# ---- F. write-target guard: refuses the shared D-drive master checkout ----
sep "F. write-target guard (shared D-drive master refused)"
GUARD_OUT="$(bash "$PREPARE" --worktree "$KNOWN_SHARED" --port "$BACHI_PORT" 2>&1)"
GUARD_RC=$?
if [[ $GUARD_RC -eq 2 ]] && echo "$GUARD_OUT" | grep -qi "write-target guard"; then
    ok "F1: prepare-worktree refuses the shared D-drive master checkout (rc=2)"
else
    ko "F1: expected rc=2 + write-target guard, got rc=$GUARD_RC ($GUARD_OUT)"
fi

summary
