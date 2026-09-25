#!/usr/bin/env bash
# SEE-1348 WP4 gate test matrix (§SPEC-007/009, SEE-1326 §3-M4).
#
# Three probes × two FS faces × flock -n/-w modes, table output per probe:
#   P1 file-flock  — BLOCKING correctness: a held <sidecar>.lock must gate a
#                    concurrent sidecar_mutate writer (serialization, no lost
#                    update) on this filesystem.
#   P2 dir-flock   — INFORMATIONAL only (per §3-M4: dir-flock is a fallback
#                    carrier candidate; result is recorded, never gates).
#   P3 O_EXCL      — create-exclusive semantics + "residue recoverable":
#                    a lock left by a SIGKILLed holder must not wedge writers.
# Modes: flock -n (fail-fast) and flock -w (bounded wait) must both behave.
# Faces: ext4 (mktemp -d) and drvfs (/mnt/d scratch — real KOL-adjacent drive,
#        NEVER the shared master checkout itself; skipped when absent).
# Plus §SPEC-007's money case: 5 concurrent mixed-slot read-modify-writers on
# ONE sidecar — every writer's key must survive (the exact race the bare
# mktemp+mv writers lost).
#
# Failure discipline (scope-down): a FAIL on the drvfs face does not fail the
# whole run — it documents the race window and the run reports which faces
# are covered (decision §3-M4). A FAIL on ext4 (the in-use carrier for
# worktrees) DOES fail.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# shellcheck source=../../mcp-sidecar.lib.sh
source "$REPO/launch/mcp-sidecar.lib.sh"

PASS=0; FAIL=0; SKIP=0
declare -a ROWS
row() { ROWS+=("$1"); }

ok()   { PASS=$((PASS+1)); row "PASS  $*"; }
ko()   { FAIL=$((FAIL+1)); row "FAIL  $*"; }
skp()  { SKIP=$((SKIP+1)); row "SKIP  $*"; }

# Bounded predicate wait (repo wait discipline): poll every 100ms up to
# $1 seconds for $2 (a test condition); echo 1 when met, 0 on budget expiry.
wait_for() {
    local budget="$1" cond="$2" waited=0
    while (( waited < budget * 10 )); do
        if eval "$cond"; then echo 1; return 0; fi
        sleep 0.1
        waited=$((waited + 1))
    done
    echo 0
}

die() { echo "FATAL: $*" >&2; exit 1; }

# ---------------------------------------------------------------- faces ----
EXT4_DIR="$(mktemp -d)"
trap 'rm -rf "$EXT4_DIR" "$DRVFS_DIR" 2>/dev/null' EXIT

DRVFS_DIR=""
if [[ -d /mnt/d ]]; then
    DRVFS_DIR="$(mktemp -d /mnt/d/godot-mcp-gate.XXXXXX 2>/dev/null)" || DRVFS_DIR=""
fi

faces=( "ext4:$EXT4_DIR" )
[[ -n "$DRVFS_DIR" ]] && faces+=( "drvfs:$DRVFS_DIR" )
[[ -n "$DRVFS_DIR" ]] || skp "drvfs face: /mnt/d unavailable — coverage limited to ext4 (scope-down documented)"

# ----------------------------------------------------- per-face probes ----
for entry in "${faces[@]}"; do
    face="${entry%%:*}"; dir="${entry#*:}"
    lock="$dir/probe.lock"
    sidecar="$dir/.godot/mcp-lease.json"
    mkdir -p "$dir/.godot"
    : > "$dir/project.godot"

    # P1 — file-flock blocking serialization (bounded, event-driven markers)
    rm -f "$lock" "$sidecar" "$dir/a-holds" "$dir/b-attempted" "$dir/b-done" "$dir/a-released"
    sidecar_write_active "$dir/project.godot" 6500 Base >/dev/null
    writer_a() {
        sidecar_mutate "$sidecar" _gate_slow_writer_a
    }
    _gate_slow_writer_a() {
        : > "$dir/a-holds"
        # Hold the section until writer B records its attempt (bounded).
        [[ "$(wait_for 5 "[[ -f $dir/b-attempted ]]")" == "1" ]] || true
        node -e '
            const fs = require("fs");
            const o = JSON.parse(fs.readFileSync(process.env.SIDE, "utf8"));
            o.mixed = Object.assign({}, o.mixed, { a: 1 });
            fs.writeFileSync(process.env.SIDE + ".tmp.a", JSON.stringify(o, null, 2));
            fs.renameSync(process.env.SIDE + ".tmp.a", process.env.SIDE);
        '
        : > "$dir/a-released"
    }
    writer_b() {
        : > "$dir/b-attempted"
        sidecar_mutate "$sidecar" _gate_writer_b
        : > "$dir/b-done"
    }
    _gate_writer_b() {
        node -e '
            const fs = require("fs");
            const o = JSON.parse(fs.readFileSync(process.env.SIDE, "utf8"));
            o.mixed = Object.assign({}, o.mixed, { b: 1 });
            fs.writeFileSync(process.env.SIDE + ".tmp.b", JSON.stringify(o, null, 2));
            fs.renameSync(process.env.SIDE + ".tmp.b", process.env.SIDE);
        '
    }
    writer_a & A_PID=$!
    # Wait for A to hold the section before starting B (marker = inside lock).
    [[ "$(wait_for 5 "[[ -f $dir/a-holds ]]")" == "1" ]] || ko "P1[$face] writer A never entered the section"
    writer_b & B_PID=$!
    # B must block while A holds: b-attempted may appear, b-done must not.
    B_BLOCKED=1
    if [[ "$(wait_for 2 "[[ -f $dir/b-done ]]")" == "1" && ! -f "$dir/a-released" ]]; then
        B_BLOCKED=0   # B finished while A was inside → lock is not gating
    fi
    if (( B_BLOCKED )); then ok "P1[$face] file-flock blocks concurrent writer"; else ko "P1[$face] writer B entered while A held the lock"; fi
    wait "$A_PID" "$B_PID" 2>/dev/null || true
    # No lost update: BOTH keys survive.
    if node -e '
        const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        process.exit((o.mixed && o.mixed.a === 1 && o.mixed.b === 1) ? 0 : 1);
    ' "$sidecar"; then ok "P1[$face] no lost update (both writers' keys survive)"; else ko "P1[$face] lost update detected: $(cat "$sidecar" | tr -d '\n' | head -c 120)"; fi

    # P1n / P1w — flock mode capability probes on this FS
    if flock -n "$lock" true 2>/dev/null; then ok "P1n[$face] flock -n supported"; else ko "P1n[$face] flock -n failed"; fi
    if timeout 5 flock -w 3 "$lock" true 2>/dev/null; then ok "P1w[$face] flock -w supported"; else ko "P1w[$face] flock -w failed/timed out"; fi

    # P2 — dir-flock (informational; result recorded, never gates)
    if flock "$dir/.godot" true 2>/dev/null; then ok "P2[$face] dir-flock works (informational)"; else skp "P2[$face] dir-flock unsupported (informational only)"; fi

    # P3 — O_EXCL semantics: an existing file must make openSync(...,"wx")
    # fail with EEXIST (node exits 0 = honored).
    rm -f "$dir/excl"
    if (exec 3>"$dir/excl") 2>/dev/null && node -e '
        const fs = require("fs");
        try { fs.closeSync(fs.openSync(process.argv[1], "wx")); process.exit(1); }
        catch (e) { process.exit(e.code === "EEXIST" ? 0 : 1); }
    ' "$dir/excl"; then ok "P3[$face] O_EXCL create-exclusive honored"; else ko "P3[$face] O_EXCL create-exclusive broken"; fi

    # P3r — residue recoverable: SIGKILLed lock holder must not wedge writers
    rm -f "$lock" "$dir/killed" "$dir/after"
    (
        # $BASHPID, not $$ — $$ is the PARENT shell pid even in a subshell;
        # killing it would take the whole harness down with the lock.
        exec 9>"$lock"
        flock 9
        : > "$dir/killed"
        kill -9 "$BASHPID"
    ) >/dev/null 2>&1 &
    K_PID=$!
    [[ "$(wait_for 5 "[[ -f $dir/killed ]]")" == "1" ]] || ko "P3r[$face] holder never took the lock"
    wait "$K_PID" 2>/dev/null || true   # holder is SIGKILLed — lock kernel-released
    if timeout 5 flock -w 3 "$lock" true 2>/dev/null; then ok "P3r[$face] dead-holder lock residue recoverable"; else ko "P3r[$face] lock residue from SIGKILLed holder still blocks writers"; fi

    # §SPEC-007 money case — 5 concurrent mixed-slot writers on ONE sidecar
    rm -f "$sidecar"
    sidecar_write_active "$dir/project.godot" 6501 Seed >/dev/null
    mixed_writer() {
        local key="$1"
        sidecar_mutate "$sidecar" "_gate_mixed_writer_$key"
    }
    for w in 1 2 3 4 5; do
        eval "_gate_mixed_writer_$w() {
            node -e '
                const fs = require(\"fs\");
                const o = JSON.parse(fs.readFileSync(process.env.SIDE, \"utf8\"));
                o.mixed = Object.assign({}, o.mixed, { w$w: $w });
                const tmp = process.env.SIDE + \".tmp.w$w\";
                fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
                fs.renameSync(tmp, process.env.SIDE);
            '
        }"
    done
    for w in 1 2 3 4 5; do mixed_writer "$w" & done
    wait 2>/dev/null || true
    if node -e '
        const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        const m = o.mixed || {};
        process.exit([1,2,3,4,5].every((w) => m["w" + w] === w) ? 0 : 1);
    ' "$sidecar"; then ok "S7[$face] 5-writer mixed-slot: zero lost updates"; else ko "S7[$face] 5-writer mixed-slot LOST UPDATE: $(cat "$sidecar" | tr -d '\n' | head -c 160)"; fi
done

# ------------------------------------------------------------- report ----
echo "---- SEE-1348 WP4 gate matrix results ----"
for r in "${ROWS[@]}"; do echo "$r"; done
echo "PASS=$PASS FAIL=$FAIL SKIP=$SKIP"

if (( FAIL > 0 )); then
    if [[ "$FAIL" == "$(printf '%s\n' "${ROWS[@]}" | grep -c 'FAIL.*\[drvfs\]')" ]]; then
        echo "SCOPE-DOWN: all failures are on the drvfs face — the ext4 face (in-use worktree carrier) is fully covered;"
        echo "the drvfs race window must be documented in the WP4 acceptance note (decision §3-M4)."
        exit 0
    fi
    exit 1
fi
exit 0
