#!/usr/bin/env bash
# SEE-1356 L7 (§SPEC-L7-01/02) — Tier-1 seed-* layout regression hardening.
#
# Fixes the three assertion groups onto mock double-layout fixtures
# (seed-<id12>/<hash>/workdir/ + .managed_env.json):
#   G1  seed-* TIER1 hit — (a) exact match on the full fixture, (a2) marker
#       decode on the daemon-lag fixture (managed_env not yet written)
#   G2  cross-agent gate — a foreign agent's .managed_env.json rejects both
#       the exact match and the (a2) decode (alias form gains no authority)
#   G3  (a2) priority — the marker decode must WIN over (b)'s freshest-mtime
#       even when a stale older runtime carries a NEWER managed_env mtime
#       (SEE-1244 incident shape counterexample)
#   G4  hex hardening — non-hex hash segments miss AND emit the structured
#       marker_decode_failed stage line (uppercase / g-z / underscore forms)
#   G5  candidate discovery stage lines — ws_base_scan summary + registry_hit
#       strategy attribution are greppable
#
# Run: bash launch/tests/scripts/test_see1356_l7_seed_layout.sh

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../" && pwd)"
WSID="ws-see1356-test"
AGENT="agent-see1356"
CONTAINER="seed-1356test12"

PASS=0; FAIL=0
ok() { if [[ "$2" == "1" ]]; then PASS=$((PASS+1)); echo "  [PASS] $1"; else FAIL=$((FAIL+1)); echo "  [FAIL] $1${3:+ — $3}"; fi; }
section() { echo; echo "== $1 =="; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Build a runtime slot under a seed-<id12> alias container:
#   <home>/multica_workspaces/seed-<id12>/<hash>/workdir/KingOfLikes-Godot
# With managed_env="" the .managed_env.json is NOT written (daemon-lag shape).
# Prints the worktree path.
make_slot() {
    local home="$1" hash="$2" agent_id="$3" managed_env="yes"
    # $4="" must mean "daemon-lag: no managed_env" — ${4:-yes} would treat the
    # empty string as null and silently create the file.
    if (( $# >= 4 )); then managed_env="$4"; fi
    local hdir="$home/multica_workspaces/$CONTAINER/$hash"
    mkdir -p "$hdir/workdir/KingOfLikes-Godot/launch"
    if [[ "$managed_env" != "" ]]; then
        printf '{"workspace_id": "%s", "agent_id": "%s"}' "$WSID" "$agent_id" > "$hdir/.managed_env.json"
    fi
    printf '%s\n' "$hdir/workdir/KingOfLikes-Godot"
}

# Bump a slot's managed_env mtime relative to now (e.g. "+6 hours").
age_managed_env() {
    local home="$1" hash="$2" age="$3"
    touch -d "$age" "$home/multica_workspaces/$CONTAINER/$hash/.managed_env.json"
}

# Marker encoding mirroring the SessionStart hook: leading '/' stripped, '/'->'_'.
marker_for() { printf '.cc-aligned-_%s' "${1#/}" | tr '/' '_'; }

# Run Tier-1 resolution in isolation by extracting the function block from
# the launcher (single source of truth; no duplicated logic in the test).
# stdout: "HIT <worktree>" / "MISS"; stderr of the run lands in "$3".
resolve_in_env() {
    local home="$1" tmpdir="$2" out_err="$3"
    python3 - "$REPO/launch/godot-mcp-launcher.sh" "$home" "$tmpdir" "$WSID" "$AGENT" "$out_err" <<'PYEOF'
import subprocess, sys
launcher, home, tmpdir, wsid, agent, errfile = sys.argv[1:7]
repo = launcher.rsplit('/launch/', 1)[0]
src = open(launcher).read()
start = src.find('_has_launch_toolchain()')
end = src.find('_resolve_via_runtime_registry()')
end = src.find('\n}\n', src.find('\n}\n', end) + 3) + 3
block = src[start:end]
test = f'''
export HOME={home}
export MULTICA_WORKSPACE_ID={wsid}
export MULTICA_AGENT_ID={agent}
export TMPDIR={tmpdir}
. {repo}/launch/env.sh
{block}
out="$(_resolve_via_runtime_registry)" && echo "HIT $out" || echo MISS
'''
with open(errfile, 'w') as f:
    r = subprocess.run(['bash', '-c', test], capture_output=True, text=True)
    f.write(r.stderr)
print(r.stdout.strip().split('\n')[-1] if r.stdout else 'NOOUT')
PYEOF
}

section "G1: seed-* alias layout — TIER1 hit"
{
    H="$TMP/g1-home"; TD="$TMP/g1-tmp"; mkdir -p "$H" "$TD"
    # Full fixture (managed_env on disk): the (a) exact-match tier resolves.
    WT="$(make_slot "$H" "see-l7case-aaaa11112222" "$AGENT")"
    MKR="$(marker_for "$WT")"; printf x > "$TD/$MKR"
    R="$(resolve_in_env "$H" "$TD" "$TMP/g1a.err")"
    ok "G1a seed-* fixture hits via (a) exact match" "$([[ "$R" == "HIT $WT" ]] && echo 1 || echo 0)" "$R"
    grep -q 'strategy=a_exact' "$TMP/g1a.err" \
        && ok "G1b hit carries strategy=a_exact stage line" 1 \
        || ok "G1b hit carries strategy=a_exact stage line" 0 "$(tr '\n' ' ' < "$TMP/g1a.err" | tail -c 200)"

    # Daemon-lag fixture: the CURRENT slot's managed_env is not yet written,
    # but the container is discoverable through a sibling slot's managed_env.
    # (a) finds no exact match (sibling encodes a different path), so the
    # (a2) marker decode must hit trusting the per-task marker (B1 lazy-load).
    H2="$TMP/g1b-home"; TD2="$TMP/g1b-tmp"; mkdir -p "$H2" "$TD2"
    make_slot "$H2" "see-l7case-siba12123333" "$AGENT" >/dev/null   # container discoverer
    WT2="$(make_slot "$H2" "see-l7case-bbbb33334444" "$AGENT" "")"  # marker slot, daemon-lag
    MKR2="$(marker_for "$WT2")"; printf x > "$TD2/$MKR2"
    R="$(resolve_in_env "$H2" "$TD2" "$TMP/g1c.err")"
    ok "G1c daemon-lag fixture hits via (a2) decode" "$([[ "$R" == "HIT $WT2" ]] && echo 1 || echo 0)" "$R"
    grep -q 'strategy=a2_marker_decode' "$TMP/g1c.err" \
        && ok "G1d hit carries strategy=a2_marker_decode stage line" 1 \
        || ok "G1d hit carries strategy=a2_marker_decode stage line" 0

    # G5 (candidate discovery observability) rides the same run's stderr.
    grep -q 'msg=ws_base_scan' "$TMP/g1a.err" \
        && ok "G5a ws_base_scan stage line present" 1 \
        || ok "G5a ws_base_scan stage line present" 0
    grep -q "containers=$CONTAINER" "$TMP/g1a.err" \
        && ok "G5b scan names the seed-* container" 1 \
        || ok "G5b scan names the seed-* container" 0
    grep -q 'markers=1' "$TMP/g1a.err" \
        && ok "G5c scan counts the TMPDIR markers" 1 \
        || ok "G5c scan counts the TMPDIR markers" 0
}

section "G2: cross-agent gate — foreign marker rejected (alias form)"
{
    H="$TMP/g2-home"; TD="$TMP/g2-tmp"; mkdir -p "$H" "$TD"
    WT_F="$(make_slot "$H" "see-l7case-cccc55556666" "other-agent-0000")"
    MKR_F="$(marker_for "$WT_F")"; printf x > "$TD/$MKR_F"
    R="$(resolve_in_env "$H" "$TD" "$TMP/g2.err")"
    ok "G2a foreign-agent slot rejected via (a) gate" "$([[ "$R" == "MISS" ]] && echo 1 || echo 0)" "$R"
    grep -q 'strategy=a_exact' "$TMP/g2.err" \
        && ok "G2b no a_exact hit line leaked for foreign slot" 0 \
        || ok "G2b no a_exact hit line leaked for foreign slot" 1
}

section "G3: (a2) priority — stale high-mtime runtime must NOT win"
{
    H="$TMP/g3-home"; TD="$TMP/g3-tmp"; mkdir -p "$H" "$TD"
    # Current task's slot: marker present, managed_env NOT yet written (the
    # daemon-lag window where (a2) is the authoritative per-task anchor).
    WT_CUR="$(make_slot "$H" "see-l7case-dddd77778888" "$AGENT" "")"
    # A STALE older runtime of the same agent whose managed_env carries a
    # NEWER mtime (the SEE-1244 17219eb2 shape: mtime hours in the future).
    WT_OLD="$(make_slot "$H" "see-l7case-oldd9999aaaa" "$AGENT")"
    age_managed_env "$H" "see-l7case-oldd9999aaaa" "+6 hours"
    MKR="$(marker_for "$WT_CUR")"; printf x > "$TD/$MKR"
    R="$(resolve_in_env "$H" "$TD" "$TMP/g3.err")"
    ok "G3a marker slot wins over the high-mtime stale runtime" "$([[ "$R" == "HIT $WT_CUR" ]] && echo 1 || echo 0)" "$R"
    ok "G3b freshest-mtime did NOT fire (no b_freshest_mtime hit)" \
        "$([[ -s "$TMP/g3.err" ]] && ! grep -q 'strategy=b_freshest_mtime' "$TMP/g3.err" && echo 1 || echo 0)"
    grep -q 'strategy=a2_marker_decode' "$TMP/g3.err" \
        && ok "G3c resolution attributed to a2_marker_decode" 1 \
        || ok "G3c resolution attributed to a2_marker_decode" 0
    # No-marker variant: WITHOUT any marker, (b) is the remaining tier and
    # MUST still pick the newest mtime (documents the (b) heuristic).
    TD3="$TMP/g3b-tmp"; mkdir -p "$TD3"
    R="$(resolve_in_env "$H" "$TD3" "$TMP/g3b.err")"
    ok "G3d no-marker fallback still resolves via (b) freshest" "$([[ "$R" == "HIT $WT_OLD" ]] && echo 1 || echo 0)" "$R"
}

section "G4: hex hardening — malformed hash misses with structured failure"
{
    H="$TMP/g4-home"; TD="$TMP/g4-tmp"; mkdir -p "$H" "$TD"
    WT="$(make_slot "$H" "see-l7case-eeee0000bbbb" "$AGENT")"
    # ws_base as the hook encodes it: '.cc-aligned-_' + path minus leading '/',
    # '/'->'_' (the trailing '_' before the hash segment is part of the prefix).
    base="${H#/}/multica_workspaces/$CONTAINER"
    enc="$(printf '%s' "$base" | tr '/' '_')"
    for bad in "ZZ12" "abcg" "a_b" "xzzz"; do
        printf x > "$TD/.cc-aligned-_${enc}_${bad}_workdir_KingOfLikes-Godot"
        R="$(resolve_in_env "$H" "$TD" "$TMP/g4-$bad.err")"
        # The malformed marker must NOT be the resolution authority: no (a2)
        # hit may carry the malformed hash (a valid same-agent slot falls
        # through to (b) freshest-mtime, which is the documented heuristic).
        ok "G4 non-hex hash '$bad' is not the resolution authority" \
            "$(grep -q "strategy=a2_marker_decode.*hash=$bad" "$TMP/g4-$bad.err" && echo 0 || echo 1)" "$R"
        grep -q 'marker_decode_failed' "$TMP/g4-$bad.err" \
            && ok "G4 marker_decode_failed stage line for '$bad'" 1 \
            || ok "G4 marker_decode_failed stage line for '$bad'" 0
        rm -f "$TD"/.cc-aligned-*"_${bad}_workdir"*
    done
    # Control: a VALID hex hash marker in the same environment still hits —
    # the hardening must not over-reject legitimate 12-hex slot hashes.
    MKR="$(marker_for "$WT")"; printf x > "$TD/$MKR"
    R="$(resolve_in_env "$H" "$TD" "$TMP/g4-ok.err")"
    ok "G4 control: valid hex hash still hits" "$([[ "$R" == "HIT $WT" ]] && echo 1 || echo 0)" "$R"
}

section "G6: hex hardening boundary shapes (SEE-1356 hardener)"
{
    # Each case names the MUTANT CLASS its assertion kills. Fixture: a real
    # same-agent slot (managed_env on) so the (a2) marker-decode tier is
    # actually REACHED for every malformed marker (G4 pattern), plus the
    # daemon-lag slot for the G6d positive decode case (G1c pattern).
    H="$TMP/g6-home"; TD="$TMP/g6-tmp"; mkdir -p "$H" "$TD"
    make_slot "$H" "see-g6-disc-aaaa11112222" "$AGENT" >/dev/null
    base="${H#/}/multica_workspaces/$CONTAINER"
    enc="$(printf '%s' "$base" | tr '/' '_')"
    bad_marker() { # $1=hash-segment $2=case-tag → resolve with the marker present
        printf x > "$TD/.cc-aligned-_${enc}_${1}_workdir_KingOfLikes-Godot"
        R="$(resolve_in_env "$H" "$TD" "$TMP/g6-$2.err")"
        rm -f "$TD"/.cc-aligned-*"_workdir"*
    }
    failed_n() { grep -c 'marker_decode_failed' "$TMP/g6-$1.err" 2>/dev/null || true; }
    # G6a EMPTY hash segment → decode fails. Kills: the `[[ -z "$hash" ]]`
    # guard removal (empty segment would decode to an empty hit hash).
    bad_marker "" "empty"
    ok "G6a empty hash segment → marker_decode_failed" \
        "$([[ "$(failed_n empty)" -ge 1 ]] && echo 1 || echo 0)" "failed=$(failed_n empty)"
    # G6b hash with EMPTY tail ("abc-") → decode fails. Kills: `+`→`*` in the
    # tail regex (empty last-dash segment would decode).
    bad_marker "abc-" "emptytail"
    ok "G6b empty last-dash tail → marker_decode_failed" \
        "$([[ "$(failed_n emptytail)" -ge 1 ]] && echo 1 || echo 0)" "failed=$(failed_n emptytail)"
    # G6c UPPERCASE hex tail → decode fails. Kills: `[0-9a-f]`→`[0-9a-fA-F]`
    # case-loosening (uppercase never names a real slot dir).
    bad_marker "AAAA11112222" "upper"
    ok "G6c uppercase hex tail → marker_decode_failed" \
        "$([[ "$(failed_n upper)" -ge 1 ]] && echo 1 || echo 0)" "failed=$(failed_n upper)"
    # G6d MULTI-DASH valid hash → FULL hash decodes and its slot hits (a2).
    # Kills: tail-extraction removal (`${hash##*-}` → `$hash` would demand a
    # bare-hex segment and reject the canonical see-<issue>-<hex> form).
    WT6="$(make_slot "$H" "see-g6-ffff33334444" "$AGENT" "")"   # daemon-lag marker slot
    printf x > "$TD/.cc-aligned-_${enc}_see-g6-ffff33334444_workdir_KingOfLikes-Godot"
    R="$(resolve_in_env "$H" "$TD" "$TMP/g6-multi.err")"
    ok "G6d multi-dash hash decodes whole and hits (a2)" \
        "$([[ "$R" == "HIT $WT6" ]] && grep -q 'strategy=a2_marker_decode' "$TMP/g6-multi.err" && echo 1 || echo 0)" "$R"
    rm -f "$TD"/.cc-aligned-*"_workdir"*
    # G6e 13-hex tail STILL decodes (shape-only contract, no length cap).
    # Kills: `{8,12}`-style cap insertion into the DECODE regex (the decode
    # contract is `^[0-9a-f]+$`; slot-length caps belong to runtime-id gates).
    printf x > "$TD/.cc-aligned-_${enc}_abc123def4567_workdir_KingOfLikes-Godot"
    R="$(resolve_in_env "$H" "$TD" "$TMP/g6-long.err")"
    ok "G6e 13-hex tail: no marker_decode_failed, (b) still resolves" \
        "$([[ "$(failed_n long)" -eq 0 && "$R" == HIT* ]] && echo 1 || echo 0)" "R=$R failed=$(failed_n long)"
    rm -f "$TD"/.cc-aligned-*"_workdir"*
    # G6f FOREIGN-prefix marker (not our workspace shape) → rejected WITHOUT
    # the structured failure line. Kills: unconditional-emit mutants (the
    # stage line must separate "malformed decode" from "not our marker").
    printf x > "$TD/.cc-aligned-_some_other_workspace_root_see-x-111122223333_workdir_KingOfLikes-Godot"
    R="$(resolve_in_env "$H" "$TD" "$TMP/g6-foreign.err")"
    ok "G6f foreign-prefix marker: no decode hit AND no marker_decode_failed" \
        "$([[ "$(failed_n foreign)" -eq 0 ]] && echo 1 || echo 0)" "R=$R failed=$(failed_n foreign)"
    rm -f "$TD"/.cc-aligned-*"_workdir"*
}

echo
echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
if [[ $FAIL -gt 0 ]]; then exit 1; fi
