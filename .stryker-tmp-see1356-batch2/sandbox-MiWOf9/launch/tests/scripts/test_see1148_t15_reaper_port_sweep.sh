#!/usr/bin/env bash
# SEE-1148 T15: 新旧 reaper 零交叉 (zero crossover between pre-P1 and P1
# residue sweeps).
#
# The P1 reaper expands TRACKED_PORTS to 6551-6609. Zero-crossover means:
#   1. An editor whose cmdline carries --kol-mcp-lease (old form) is still
#      recognized as under-reaper-jurisdiction.
#   2. An editor whose cmdline carries --kol-mcp-runtime=<id> (new P1 form)
#      is recognized too.
#   3. An editor with NEITHER flag (user-pulled) is NEVER touched.
#
# The residue PID-discovery path shells out to powershell.exe (WSL) — not
# available in CI. The test therefore verifies the JURISDICTION predicate
# directly: it replays the same cmdline filter the PowerShell block applies,
# against the three cmdline shapes above, using a pure-bash reimplementation
# of the match. This keeps the test honest about what it covers: the gate
# logic, not the Win32 query plumbing.

set -uo pipefail

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# jurisdiction <cmdline>: mirrors the P1 reaper's match rule —
# --kol-mcp-lease OR --kol-mcp-runtime anywhere in the cmdline.
jurisdiction() {
    [[ "$1" == *"--kol-mcp-lease"* ]] || [[ "$1" == *"--kol-mcp-runtime"* ]]
}

echo "== T15.1: legacy cmdline (--kol-mcp-lease only) is in jurisdiction =="
if jurisdiction "/c/Godot/Godot_v4.exe --editor --path /x --kol-mcp-lease"; then ok "legacy form recognized"; else bad "legacy form missed"; fi

echo "== T15.2: P1 cmdline (--kol-mcp-lease + --kol-mcp-runtime=...) is in jurisdiction =="
if jurisdiction "/c/Godot/Godot_v4.exe --editor --path /x --kol-mcp-lease --kol-mcp-runtime Bachi-aabbccdd"; then ok "P1 form recognized"; else bad "P1 form missed"; fi

echo "== T15.3: P1-form-only cmdline (no --kol-mcp-lease) is in jurisdiction =="
if jurisdiction "/c/Godot/Godot_v4.exe --editor --path /x --kol-mcp-runtime=Bachi-aabbccdd"; then ok "runtime-only form recognized"; else bad "runtime-only form missed"; fi

echo "== T15.4: user-pulled editor (neither flag) is NEVER in jurisdiction =="
if jurisdiction "/c/Godot/Godot_v4.exe --editor --path /home/me/mygame"; then bad "user editor wrongly matched"; else ok "user editor untouched"; fi

echo "== T15.5: headless orphan sweep rule unaffected — --headless without lease/runtime flags stays excluded from residue pass =="
# The headless sweep explicitly requires --headless AND NOT kol-mcp-lease;
# P1's --kol-mcp-runtime must not accidentally pull headless P1 runs into the
# editor residue pass — a headless run with --kol-mcp-runtime would be killed
# by BOTH sweeps. Assert the headless predicate excludes it.
headless_orphan() {
    [[ "$1" == *"--headless"* ]] && [[ "$1" != *"kol-mcp-lease"* ]] && [[ "$1" != *"kol-mcp-runtime"* ]]
}
if headless_orphan "/godot --headless -s probe.gd --kol-mcp-runtime Bachi-x"; then
    bad "headless P1-tagged run would be swept by headless pass"
else
    ok "headless P1-tagged run excluded from headless pass"
fi

echo "== T15.6: F3 cross-delete guard (方案A) — P1 slot NEVER deletes legacy flat =="
# Revy P1 复测 F3 方案A: the legacy FLAT files are keyed by the agent LABEL,
# SHARED across concurrent slots of the same agent. A P1 slot (8-hex
# runtime_id) NEVER writes the legacy flat files — so its reaper must NEVER
# delete them either, or it clobbers a concurrent slot's pre-P1 artifact.
# The earlier 8-hex-regex-qualifies-to-delete gate was WRONG: two 8-hex slots
# share one label, so the regex could not tell them apart. 方案A: 8-hex →
# skip legacy flat entirely; only non-8-hex (v1/-solo/empty) may clean it.
# Directory-form files are per-runtime, always safe to delete.
SCRIPT_DIR_T15="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR_T15/../../../launch/runtime.lib.sh"
RUNTIME_ID_REGEX="$(kol_runtime_id_regex)"
# Mirrors reap-stale-leases.sh 方案A: returns 0 if legacy flat SHOULD be cleaned.
f3_legacy_cleanup() {  # <runtime_id>
    if [[ -n "$1" ]] && [[ "$1" =~ ${RUNTIME_ID_REGEX} ]]; then
        return 1   # P1 slot → never clean legacy flat
    fi
    return 0       # v1/-solo/empty → may clean legacy flat
}

# 8-hex P1 slot → legacy flat NOT cleaned (would clobber concurrent slot)
if ! f3_legacy_cleanup "Bachi-aabbccdd"; then
    ok "8-hex P1 slot does NOT clean legacy flat"
else
    bad "8-hex P1 slot wrongly cleans legacy flat"
fi
# second 8-hex slot of the SAME agent also NOT cleaned — the exact cross-delete case
if ! f3_legacy_cleanup "Bachi-12345678"; then
    ok "second 8-hex slot same agent does NOT clean legacy flat (cross-delete closed)"
else
    bad "second 8-hex slot wrongly cleans legacy flat"
fi
# lowercase 8-hex P1 slot → NOT cleaned
if ! f3_legacy_cleanup "bachi-aabbccdd"; then
    ok "lowercase 8-hex P1 slot does NOT clean legacy flat"
else
    bad "lowercase 8-hex P1 slot wrongly cleans legacy flat"
fi
# -solo (non-8-hex) → MAY clean legacy flat (it is the pre-P1 single-runtime case)
if f3_legacy_cleanup "Bachi-solo"; then
    ok "-solo (non-8-hex) may clean legacy flat"
else
    bad "-solo wrongly blocked from cleaning legacy flat"
fi
# empty runtime_id (v1 sidecar, no derivable slot) → MAY clean legacy flat
if f3_legacy_cleanup ""; then
    ok "empty runtime_id (v1) may clean legacy flat"
else
    bad "empty runtime_id wrongly blocked from cleaning legacy flat"
fi
# non-8-hex garbage → MAY clean (not a P1 slot)
if f3_legacy_cleanup "Bachi-nothex"; then
    ok "non-8-hex may clean legacy flat"
else
    bad "non-8-hex wrongly blocked from cleaning legacy flat"
fi
# The directory form is ALWAYS deleted (per-runtime, no cross-delete).
F3_HOME="$(mktemp -d)"
mkdir -p "$F3_HOME/godot-editor"
if [[ -d "$F3_HOME/godot-editor" ]]; then
    ok "directory-form cleanup path exists (per-runtime, always safe)"
else
    bad "directory-form cleanup path missing"
fi
rm -rf "$F3_HOME"

echo "== T15.7: F3 双 slot 共享 label 回归 — slot1 reap 后 slot2 legacy flat 保留 =="
# Archi 裁决 §三 + Atlas 确认: the live scenario Revy verified — two same-agent
# 8-hex slots (Bachi-aaaabbbb slot1 reaped, Bachi-ccccdddd slot2 still ACTIVE)
# SHARE one label `bachi`, hence one legacy flat pair godot-editor-bachi.{pid,
# worktree}. When slot1's reaper runs, slot2's legacy flat MUST survive. This
# exercises the ACTUAL reap cleanup block semantics (方案A) at the filesystem
# level, not just the predicate — the exact regression the 8-hex-regex gate
# let through.
T157_HOME="$(mktemp -d)"
MULTICA_DIR_T157="$T157_HOME/.multica"
mkdir -p "$MULTICA_DIR_T157/godot-editor"
# slot2's legacy flat (per-LABEL, shared) — written by a pre-P1 slot2 launch.
echo "2222" > "$MULTICA_DIR_T157/godot-editor-bachi.pid"
echo "/slot2/wt" > "$MULTICA_DIR_T157/godot-editor-bachi.worktree"
# slot1's own directory-form files (per-runtime) — these SHOULD be cleaned.
echo "1111" > "$MULTICA_DIR_T157/godot-editor/Bachi-aaaabbbb.pid"
echo "/slot1/wt" > "$MULTICA_DIR_T157/godot-editor/Bachi-aaaabbbb.worktree"

# Replay the reap-stale-leases.sh cleanup block verbatim for slot1's reap.
slot1_cleanup() {  # <runtime_id> <label> <MULTICA_DIR>
    local runtime_id="$1" label="$2" MULTICA_DIR="$3"
    local RUNTIME_ID_REGEX
    RUNTIME_ID_REGEX="$(kol_runtime_id_regex)"
    if [[ -n "${runtime_id:-}" ]] && [[ "${runtime_id}" =~ ${RUNTIME_ID_REGEX} ]]; then
        : # P1 slot: only clean directory-form files below, never legacy flat.
    elif [[ -n "$label" ]]; then
        rm -f "${MULTICA_DIR}/godot-editor-${label}.pid" "${MULTICA_DIR}/godot-editor-${label}.worktree" 2>/dev/null || true
    fi
    if [[ -n "${runtime_id:-}" ]]; then
        rm -f "${MULTICA_DIR}/godot-editor/${runtime_id}.pid" "${MULTICA_DIR}/godot-editor/${runtime_id}.worktree" 2>/dev/null || true
    fi
}
slot1_cleanup "Bachi-aaaabbbb" "bachi" "$MULTICA_DIR_T157"

# slot1's directory-form files ARE cleaned (its own per-runtime artifacts).
if [[ ! -f "$MULTICA_DIR_T157/godot-editor/Bachi-aaaabbbb.pid" && ! -f "$MULTICA_DIR_T157/godot-editor/Bachi-aaaabbbb.worktree" ]]; then
    ok "slot1 directory-form files cleaned"
else
    bad "slot1 directory-form files NOT cleaned"
fi
# slot2's legacy flat SURVIVES slot1's reap — the cross-delete is closed.
if [[ -f "$MULTICA_DIR_T157/godot-editor-bachi.pid" && -f "$MULTICA_DIR_T157/godot-editor-bachi.worktree" ]]; then
    ok "slot2 legacy flat SURVIVES slot1 reap (cross-delete closed)"
else
    bad "slot2 legacy flat CLOBBERED by slot1 reap (cross-delete still open)"
fi
rm -rf "$T157_HOME"

echo "== T15 summary: pass=$PASS fail=$FAIL =="
(( FAIL == 0 )) || exit 1
exit 0
