#!/usr/bin/env bash
# SEE-1129 instance-selection-layer mock (agent-scoped reuse predicate).
#
# Owner's three principles (verbatim):
#   1. "一个 agent 一个 editor" — same agent reuses; never spawns a 2nd process.
#   2. "同 agent 二次用同一个 editor 不报'已被使用'" — same-agent hit = reuse,
#      NEVER an in-use error; only CROSS-agent contention errors.
#   5. cross-agent grabbing the same editor → error, not misconnect.
#
# The predicate is AGENT-scoped (ports are per-agent-name in agent-ports.json,
# so a holder on this port is the same agent by construction). It returns:
#   'reuse'   — holder is same agent (or unverifiable — back-compat)
#   'foreign' — holder is a DIFFERENT agent (duplicate/misconfigured port)
# The worktree args are diagnostic-only; a same-agent holder with a different
# worktree (a concurrent same-agent slot) still returns 'reuse'.
#
# Pure predicate — exercised directly via node without spawning the proxy or a
# live Godot/editor/port.

set -u
cd "$(dirname "$0")/../../../.." || exit 1

PREDICATE="./launch/see1129-reuse-predicate.mjs"

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok   - $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL - $*"; }

# run_decide <holderAgent|''> <ourAgent|''> <holderWorktree|''> <ourWorktree|''>
# '' maps to null/empty (unverifiable holder / unresolved worktree).
run_decide() {
    node --input-type=module -e "
import { decideReuse } from '${PREDICATE}';
const h = process.argv[1] === '' ? null : process.argv[1];
const o = process.argv[2] === '' ? '' : process.argv[2];
const hw = process.argv[3] === '' ? null : process.argv[3];
const ow = process.argv[4] === '' ? null : process.argv[4];
process.stdout.write(decideReuse(h, o, hw, ow));
" "$1" "$2" "$3" "$4"
}

WS="11111111-2222-3333-4444-555555555555"
SLOT_A="/home/jerry/multica_workspaces/${WS}/41115b3c/workdir/KingOfLikes-Godot"
SLOT_B="/home/jerry/multica_workspaces/${WS}/17219eb2/workdir/KingOfLikes-Godot"
ARCHI_OLD="/home/jerry/multica_workspaces/${WS}/7a634b21/workdir/KingOfLikes-Godot"
ARCHI_NEW="/home/jerry/multica_workspaces/${WS}/c508560b/workdir/KingOfLikes-Godot"

# ---------- M1: SAME agent, slot A holds, slot B boots -> REUSE (principle #1/#2)
got="$(run_decide "Bachi" "Bachi" "$SLOT_A" "$SLOT_B")"
[[ "$got" == "reuse" ]] && ok "M1 same-agent multi-slot: slot B reuses slot A's holder (principle #1/#2)" \
                         || bad "M1: got=$got want=reuse"

# ---------- M2: same slot resuming its own editor -> REUSE -------------------
got="$(run_decide "Bachi" "Bachi" "$SLOT_A" "$SLOT_A")"
[[ "$got" == "reuse" ]] && ok "M2 same-slot resume: own editor reused" \
                       || bad "M2: got=$got want=reuse"

# ---------- M3: holder sidecar absent agent (older holder/manual) -> REUSE ---
got="$(run_decide "" "Bachi" "$SLOT_B" "$SLOT_B")"
[[ "$got" == "reuse" ]] && ok "M3 unverifiable holder (no agent field): back-compat reuse" \
                       || bad "M3: got=$got want=reuse"

# ---------- M4: our agent unresolved -> REUSE (no basis to refuse) -----------
got="$(run_decide "Bachi" "" "$SLOT_A" "$SLOT_B")"
[[ "$got" == "reuse" ]] && ok "M4 our agent unresolved: reuse (no basis to refuse)" \
                       || bad "M4: got=$got want=reuse"

# ---------- M5: CROSS-agent holder (duplicate port mapping) -> FOREIGN ------
got="$(run_decide "Archi" "Bachi" "$ARCHI_OLD" "$SLOT_B")"
[[ "$got" == "foreign" ]] && ok "M5 cross-agent (Archi holds, Bachi boots): refused (principle #5)" \
                          || bad "M5: got=$got want=foreign"

# ---------- M6: Archi same-agent multi-slot -> REUSE ------------------------
got="$(run_decide "Archi" "Archi" "$ARCHI_OLD" "$ARCHI_NEW")"
[[ "$got" == "reuse" ]] && ok "M6 Archi same-agent multi-slot: reuse (principle #1/#2)" \
                       || bad "M6: got=$got want=reuse"

# ---------- M7: holder agent trimmed before compare -------------------------
holder_trimmed="$(printf '%s\n' "Bachi" | sed -e 's/[[:space:]]*$//')"
got="$(run_decide "$holder_trimmed" "Bachi" "$SLOT_A" "$SLOT_A")"
[[ "$got" == "reuse" ]] && ok "M7 trimmed holder agent matches -> reuse" \
                       || bad "M7: got=$got want=reuse"

echo
echo "pass=$PASS fail=$FAIL"
[[ "$FAIL" -eq 0 ]]
