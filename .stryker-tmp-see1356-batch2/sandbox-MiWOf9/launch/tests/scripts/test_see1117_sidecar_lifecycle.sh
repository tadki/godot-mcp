#!/usr/bin/env bash
# SEE-1117 Direction 3 QA — sidecar lease lifecycle (Suite A, script-level).
#
# Verifies the per-worktree sidecar lease (.godot/mcp-lease.json) lifecycle:
# configure writes state=active, restore sets state=released, verify gates on
# the state, and the write-target guard refuses shared/master checkouts. These
# are the script-level oracles from Archi doc
# .dev/godot-mcp/docs/SEE-1117-direction-3-sidecar-architecture.md §8.2 Suite A
# (A1–A8). Oracle A9 (addon _load_lease_sidecar fallback to 6550 on malformed)
# requires a live editor and is Revy's live-QA scope, not this script.
#
# Cases:
#   A1  configure writes sidecar state=active, port, non-empty lease_id
#   A2  re-configure same port = no-op, lease_id UNCHANGED (fast path)
#   A3  configure different port = lease_id regenerates, port updates
#   A4  restore sets state=released, non-empty released_at
#   A5  verify exit 0 after restore
#   A6  verify exit 1 while active
#   A7  verify exit 0 when sidecar absent
#   A8  verify exit 0 after deleting an active sidecar
#   G1  configure refuses shared D-drive master target (write-target guard)
#   G2  configure refuses a committed master-branch checkout (guard)
#   P1  project.godot byte-identical before/after configure (addon never writes it)
#
# All assertions are grep / exit-code / JSON-field based — no "looks right".
#
# Run from repo root:
#   bash launch/tests/scripts/test_see1117_sidecar_lifecycle.sh
#
# Exit 0 on all-pass, non-zero with a printed FAIL list otherwise.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
# Run context (SEE-1291): works from both layouts. The fork's own launch/ is
# the toolchain under test; KOL_ROOT (explicit env, else the enclosing
# superproject when this is a submodule checkout) only matters for suites
# that drive KOL-side resources — this one is fully self-contained.
KOL_ROOT="${KOL_ROOT:-}"
if [[ -z "$KOL_ROOT" ]]; then
    KOL_ROOT="$(git -C "$REPO_ROOT" rev-parse --show-superproject-working-tree 2>/dev/null || true)"
fi
[[ -z "$KOL_ROOT" ]] && KOL_ROOT="$REPO_ROOT"
if [[ -d "$REPO_ROOT/launch" ]]; then
    LAUNCH_DIR="$REPO_ROOT/launch"
else
    LAUNCH_DIR="$KOL_ROOT/addons/godot_mcp/launch"
fi
CONFIGURE="$LAUNCH_DIR/configure-mcp-port.sh"
RESTORE="$LAUNCH_DIR/restore-godot-original.sh"
VERIFY="$LAUNCH_DIR/verify-godot-written-back.sh"

PASS_COUNT=0
FAIL_COUNT=0
declare -a FAILED_CASES=()

TMPROOT="$(mktemp -d -t see1117-sidecar-XXXXXXXX)"
trap 'rm -rf "$TMPROOT"' EXIT

# Read a sidecar field via node (no jq dependency — matches the toolchain).
sidecar_field() {
    local sidecar="$1" field="$2"
    [ -f "$sidecar" ] || return 0
    node -e "
        let raw = '';
        process.stdin.on('data', c => raw += c);
        process.stdin.on('end', () => {
            try {
                const o = JSON.parse(raw);
                const v = o[${field//$/\\$}];
                process.stdout.write(v === null || v === undefined ? '' : String(v));
            } catch (e) { process.stdout.write(''); }
        });
    " < "$sidecar" 2>/dev/null || true
}

# A node-safe field read: pass the field NAME; the helper JSON-stringifies it
# so no injection is possible and no shell-escape dance is needed.
read_field() {
    local sidecar="$1" field="$2"
    [ -f "$sidecar" ] || return 0
    SIDE_FIELD="$field" node -e '
        let raw = "";
        process.stdin.on("data", c => raw += c);
        process.stdin.on("end", () => {
            try {
                const o = JSON.parse(raw);
                const v = o[process.env.SIDE_FIELD];
                process.stdout.write(v === null || v === undefined ? "" : String(v));
            } catch (e) { process.stdout.write(""); }
        });
    ' < "$sidecar" 2>/dev/null || true
}

pass() { PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); FAILED_CASES+=("$1: $2"); echo "  FAIL: $1 — $2" >&2; }

# Make a fresh fake worktree dir with a project.godot anchor + .godot/ dir.
new_worktree() {
    local wt="$TMPROOT/wt-$(printf '%s' "$1" | tr '/ ' '__')"
    mkdir -p "$wt/.godot"
    printf '[godot_mcp]\n\nbind_mode=1\ncustom_bind_ip=""\nconfig_version=5\n' > "$wt/project.godot"
    echo "$wt"
}

echo "== SEE-1117 Direction 3 Suite A: sidecar lifecycle =="

# --- A1: configure writes sidecar state=active, port, non-empty lease_id ---
echo "A1: configure --port 6555"
WT="$(new_worktree A1)"
"$CONFIGURE" --port 6555 --project-godot "$WT/project.godot" >/dev/null 2>&1 \
  && SC="$WT/.godot/mcp-lease.json" \
  && [ -f "$SC" ] \
  && [ "$(read_field "$SC" state)" = "active" ] \
  && [ "$(read_field "$SC" port)" = "6555" ] \
  && [ -n "$(read_field "$SC" lease_id)" ] \
  && pass || fail "A1" "configure did not write active sidecar with port+lease_id"

# --- A2: re-configure same port = no-op, lease_id UNCHANGED ---
echo "A2: re-configure same port (fast path, lease_id stable)"
LID_BEFORE="$(read_field "$SC" lease_id)"
"$CONFIGURE" --port 6555 --project-godot "$WT/project.godot" >/dev/null 2>&1
LID_AFTER="$(read_field "$SC" lease_id)"
[ "$LID_BEFORE" = "$LID_AFTER" ] && pass || fail "A2" "fast path regenerated lease_id ($LID_BEFORE -> $LID_AFTER)"

# --- A3: configure different port = lease_id regenerates ---
echo "A3: configure different port (lease_id regenerates)"
"$CONFIGURE" --port 6551 --project-godot "$WT/project.godot" >/dev/null 2>&1
LID_NEW="$(read_field "$SC" lease_id)"
NEW_PORT="$(read_field "$SC" port)"
[ "$LID_BEFORE" != "$LID_NEW" ] && [ "$NEW_PORT" = "6551" ] \
  && pass || fail "A3" "port change did not regenerate lease_id or update port (port=$NEW_PORT)"

# --- A6: verify exit 1 while active ---
echo "A6: verify on active sidecar (expect exit 1)"
if "$VERIFY" --project-godot "$WT/project.godot" >/dev/null 2>&1; then
  fail "A6" "verify returned 0 on active sidecar"
else
  rc=$?
  [ "$rc" = "1" ] && pass || fail "A6" "verify exit $rc (expected 1)"
fi

# --- A4: restore sets state=released, non-empty released_at ---
echo "A4: restore"
"$RESTORE" --project-godot "$WT/project.godot" >/dev/null 2>&1
[ "$(read_field "$SC" state)" = "released" ] && [ -n "$(read_field "$SC" released_at)" ] \
  && pass || fail "A4" "restore did not set state=released with released_at"

# --- A5: verify exit 0 after restore ---
echo "A5: verify on released sidecar (expect exit 0)"
if "$VERIFY" --project-godot "$WT/project.godot" >/dev/null 2>&1; then
  pass
else
  fail "A5" "verify non-zero on released sidecar"
fi

# --- restore idempotent on already-released ---
echo "A4b: restore idempotent on already-released"
"$RESTORE" --project-godot "$WT/project.godot" >/dev/null 2>&1 && pass \
  || fail "A4b" "second restore exited non-zero"

# --- A7: verify exit 0 when sidecar absent ---
echo "A7: verify on absent sidecar (expect exit 0)"
WT7="$(new_worktree A7)"
if "$VERIFY" --project-godot "$WT7/project.godot" >/dev/null 2>&1; then
  pass
else
  fail "A7" "verify non-zero on absent sidecar"
fi

# --- A8: verify exit 0 after deleting an active sidecar ---
echo "A8: verify after deleting active sidecar (expect exit 0)"
WT8="$(new_worktree A8)"
"$CONFIGURE" --port 6555 --project-godot "$WT8/project.godot" >/dev/null 2>&1
rm -f "$WT8/.godot/mcp-lease.json"
if "$VERIFY" --project-godot "$WT8/project.godot" >/dev/null 2>&1; then
  pass
else
  fail "A8" "verify non-zero after sidecar deleted"
fi

# --- G1: configure refuses shared D-drive master target ---
echo "G1: configure refuses shared D-drive master (guard)"
if "$CONFIGURE" --port 6555 --project-godot "/mnt/d/GodotProjects/king-of-likes/project.godot" >/dev/null 2>&1; then
  fail "G1" "configure wrote to shared D-drive master"
else
  pass
fi

# --- G2: configure refuses a committed master-branch checkout ---
echo "G2: configure refuses committed master checkout (guard)"
WTG="$(new_worktree G2)"
( cd "$WTG" && git init -q && git config user.email t@t.t && git config user.name t \
  && git add -A && git commit -q --allow-empty -m init && git branch -m master 2>/dev/null || true ) >/dev/null 2>&1
if "$CONFIGURE" --port 6555 --project-godot "$WTG/project.godot" >/dev/null 2>&1; then
  fail "G2" "configure wrote to a committed master checkout"
else
  pass
fi

# --- P1: project.godot byte-identical before/after configure ---
echo "P1: project.godot unchanged after configure (addon never writes it)"
WTP="$(new_worktree P1)"
cp "$WTP/project.godot" "$TMPROOT/p1-snapshot"
"$CONFIGURE" --port 6557 --project-godot "$WTP/project.godot" >/dev/null 2>&1
if diff -q "$TMPROOT/p1-snapshot" "$WTP/project.godot" >/dev/null 2>&1; then
  pass
else
  fail "P1" "configure modified project.godot (Direction 3 forbids this)"
fi

echo
echo "------------------------------------------"
echo "PASS: $PASS_COUNT   FAIL: $FAIL_COUNT"
if [ "$FAIL_COUNT" -ne 0 ]; then
  echo "FAILED CASES:"
  for c in "${FAILED_CASES[@]}"; do echo "  - $c"; done
  exit 1
fi
echo "All SEE-1117 Direction 3 Suite A oracles passed."
exit 0
