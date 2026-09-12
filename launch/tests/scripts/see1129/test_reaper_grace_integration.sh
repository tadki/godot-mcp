#!/usr/bin/env bash
# SEE-1134 integration check for the reap-stale-leases.sh grace guard.
#
# Runs the REAL reaper against a fake workspace root holding two sidecars:
#   - Bachi: active lease written 5s ago (fresh, must be KEPT by the grace guard)
#   - Fronti: active lease written 600s ago (stale, must still be REAPED)
# Both have a configured_by_pid that is definitely dead (a huge synthetic PID
# no real process holds) and no editor pidfile, so without the guard BOTH would
# match the owner_pid_dead verdict and be reaped — reproducing the
# release-after-start race.
#
# Asserts the reaper's own stdout reports Bachi as ACTIVE-fresh (kept) and
# Fronti as STALE. Dry-run so nothing is actually written/killed.
#
# Exit 0 = pass, 1 = fail.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
REAPER="$REPO/launch/reap-stale-leases.sh"

command -v node >/dev/null 2>&1 || { echo "node required"; exit 1; }
[[ -r "$REAPER" ]] || { echo "reaper not found at $REAPER"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Fake workspace root layout the reaper walks: <root>/<hash>/workdir/KingOfLikes-Godot/.godot/mcp-lease.json
# Use the worktree path the reaper computes: dirname(dirname(lease)) = .../KingOfLikes-Godot
FAKE_ROOT="$TMP/ws"
BACHI_WT="$FAKE_ROOT/aa111111/workdir/KingOfLikes-Godot"
FRONTI_WT="$FAKE_ROOT/bb222222/workdir/KingOfLikes-Godot"
mkdir -p "$BACHI_WT/.godot" "$FRONTI_WT/.godot"

# project.godot must exist for the release path; we only dry-run, but the file
# presence keeps the code path honest.
touch "$BACHI_WT/project.godot" "$FRONTI_WT/project.godot"

write_lease() {
    local path="$1" agent="$2" port="$3" age_s="$4"
    local iso
    iso="$(date -u -d "@$(( $(date -u +%s) - age_s ))" +%Y-%m-%dT%H:%M:%SZ)"
    cat >"$path" <<EOF
{
  "schema_version": 1,
  "lease_id": "L-$agent",
  "port": $port,
  "agent": "$agent",
  "label": "$(echo "$agent" | tr '[:upper:]' '[:lower:]')",
  "state": "active",
  "worktree": "$(dirname "$path")",
  "configured_by_pid": 7777777,
  "configured_at": "$iso",
  "released_at": null
}
EOF
}

# Bachi: fresh (5s old). Fronti: stale (600s old). Both PIDs dead (7777777).
write_lease "$BACHI_WT/.godot/mcp-lease.json"   Bachi  6553 5
write_lease "$FRONTI_WT/.godot/mcp-lease.json"  Fronti 6551 600

# Run the real reaper in dry-run so it reports verdicts without writing.
# Suppress the powershell probe by hiding it from PATH — pid_alive then falls
# back to kill -0 on the synthetic PID, which correctly returns dead (the
# intended "looks dead" signal that the grace guard must override).
# SEE-1291 H2: KOL_REAP_DISABLE_PWSH=1 must ride env -i (the /mnt/c
# absolute fallback survives PATH stripping — SEE-1242 A-2 precedent).
OUT="$(env -i PATH="/usr/bin:/bin" HOME="$TMP" KOL_REAP_GRACE_S=120 KOL_REAP_DISABLE_PWSH=1 \
    bash "$REAPER" --root "$FAKE_ROOT" --dry-run 2>&1 || true)"

echo "----- reaper output -----"
echo "$OUT"
echo "-------------------------"

fail=0
if echo "$OUT" | grep -q "ACTIVE-fresh.*Bachi"; then
    echo "ok   - Bachi fresh lease KEPT (grace guard fired)"
else
    echo "FAIL - Bachi fresh lease was NOT kept by grace guard"
    fail=1
fi
if echo "$OUT" | grep -q "STALE.*Fronti"; then
    echo "ok   - Fronti stale (600s) lease still REAPED (cleanup preserved)"
else
    echo "FAIL - Fronti stale lease was NOT reaped"
    fail=1
fi
# Sanity: Bachi must NOT appear in any STALE line.
if echo "$OUT" | grep -q "STALE.*Bachi"; then
    echo "FAIL - Bachi appeared in STALE line (race NOT closed)"
    fail=1
else
    echo "ok   - Bachi never appears as STALE (race closed)"
fi

if (( fail == 0 )); then
    echo "M_reaper_grace_integration OK"
    exit 0
else
    echo "M_reaper_grace_integration FAIL"
    exit 1
fi
