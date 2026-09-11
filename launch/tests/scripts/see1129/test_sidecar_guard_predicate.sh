#!/usr/bin/env bash
# SEE-1129 sidecar-guard real-machine fix mock (sub-step e43cdc73).
#
# The reuse short-circuit must NOT silently adopt a holder whose .worktree
# sidecar is absent OR whose recorded worktree differs from this slot's. That
# was the design error Archi reproduced on the real machine: a pre-#499 holder
# (no sidecar) was silently reused via the M3 back-compat branch, so
# godot_project get_info returned the holder's path (c508560b) instead of this
# slot's (7a634b21).
#
# This mock exercises the WORKTREE-scoped sidecar-guard predicate directly:
#   'reuse' — holder sidecar present AND matches this slot's worktree
#   'evict' — sidecar absent (pre-#499/manual), OR worktree mismatch (foreign slot)
#
# It complements test_multi_slot_reuse_predicate.sh (which is AGENT-scoped and
# runs FIRST — a cross-agent holder is refused before this guard is consulted).
#
# The success criterion this mock encodes (verbatim from Atlas's e43cdc73):
#   "Archi runtime 7a634b21 下重测，godot_project get_info 返回的 path 末尾段 =
#    7a634b21（而非 c508560b），无论旧 holder 是否残留"
# A residual holder on c508560b MUST be evicted (sidecar absent or mismatch) →
# spawn fresh for 7a634b21 → get_info returns 7a634b21.

set -u
cd "$(dirname "$0")/../../../.." || exit 1

PREDICATE="./launch/see1129-sidecar-guard-predicate.mjs"

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok   - $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL - $*"; }

# run_guard <holderWorktree|''> <ourWorktree|''>
# '' maps to null (sidecar absent / worktree unresolved).
run_guard() {
    node --input-type=module -e "
import { decideSidecarGuard } from '${PREDICATE}';
const hw = process.argv[1] === '' ? null : process.argv[1];
const ow = process.argv[2] === '' ? null : process.argv[2];
process.stdout.write(decideSidecarGuard(hw, ow));
" "$1" "$2"
}

WS="11111111-2222-3333-4444-555555555555"
ARCHI_OLD="/home/jerry/multica_workspaces/${WS}/c508560b/workdir/KingOfLikes-Godot"
ARCHI_NEW="/home/jerry/multica_workspaces/${WS}/7a634b21/workdir/KingOfLikes-Godot"
BACHI_SLOT="/home/jerry/multica_workspaces/${WS}/41115b3c/workdir/KingOfLikes-Godot"

# ---------- M3'a: holder sidecar ABSENT (pre-#499 residual holder) → EVICT ----
# This is the exact Archi regression: port busy, holder has NO sidecar (pre-#499
# spawn), this slot is 7a634b21. Old M3 back-compat branch would silently reuse
# → get_info returns the holder's path. Fix: EVICT → spawn fresh.
got="$(run_guard "" "$ARCHI_NEW")"
[[ "$got" == "evict" ]] && ok "M3'a pre-#499 holder (no sidecar): EVICT not silent reuse (Archi regression)" \
                         || bad "M3'a: got=$got want=evict"

# ---------- M3'b: holder worktree MISMATCH (residual holder = c508560b) → EVICT
# Residual holder from a prior task still has c508560b open; this slot is
# 7a634b21. Sidecar present but points elsewhere → untrusted → EVICT.
got="$(run_guard "$ARCHI_OLD" "$ARCHI_NEW")"
[[ "$got" == "evict" ]] && ok "M3'b residual holder wrong worktree (c508560b vs 7a634b21): EVICT" \
                         || bad "M3'b: got=$got want=evict"

# ---------- M3'c: holder sidecar MATCHES this slot → REUSE (principle #1/#2) ---
# Same slot resuming its own editor; sidecar confirms it. Safe reuse — never
# spawn a 2nd editor for the same agent (principle #1).
got="$(run_guard "$ARCHI_NEW" "$ARCHI_NEW")"
[[ "$got" == "reuse" ]] && ok "M3'c same-slot holder confirmed (7a634b21=7a634b21): REUSE" \
                         || bad "M3'c: got=$got want=reuse"

# ---------- M3'd: our worktree unresolved → EVICT (no basis to prove match) ----
got="$(run_guard "$ARCHI_OLD" "")"
[[ "$got" == "evict" ]] && ok "M3'd our worktree unresolved: EVICT (cannot prove match)" \
                         || bad "M3'd: got=$got want=evict"

# ---------- M3'e: Bachi slot vs residual Archi-logged worktree → EVICT --------
# Cross-check: even if a holder sidecar happened to record a Bachi path, a
# mismatch against this slot's worktree still evicts. (Cross-agent is already
# refused by the agent-scoped predicate; this guard only adds worktree rigor.)
got="$(run_guard "$BACHI_SLOT" "$ARCHI_NEW")"
[[ "$got" == "evict" ]] && ok "M3'e holder worktree != our slot (Bachi vs Archi slot): EVICT" \
                         || bad "M3'e: got=$got want=evict"

# ---------- M3'f: both absent (cold edge) → EVICT (spawn fresh) ---------------
got="$(run_guard "" "")"
[[ "$got" == "evict" ]] && ok "M3'f both absent: EVICT (fall through to spawn)" \
                         || bad "M3'f: got=$got want=evict"

# ---------- M3'g: Bachi resuming own slot → REUSE (no path drift) -------------
got="$(run_guard "$BACHI_SLOT" "$BACHI_SLOT")"
[[ "$got" == "reuse" ]] && ok "M3'g Bachi same-slot resume: REUSE (principle #1/#2)" \
                         || bad "M3'g: got=$got want=reuse"

echo
echo "pass=$PASS fail=$FAIL"
[[ "$FAIL" -eq 0 ]]
