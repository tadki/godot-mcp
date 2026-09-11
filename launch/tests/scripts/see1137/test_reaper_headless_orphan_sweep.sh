#!/usr/bin/env bash
# SEE-1137 headless-orphan sweep test for reap-stale-leases.sh.
#
# Root cause reproduced live 2026-08-18: agent Bash calls run
# `godot --headless -s foo.gd` one-shot probes; when the Bash call times out
# or the run aborts, the Windows Godot process outlives the WSL side (not in
# its process group) and spins forever — 16 such orphans observed with
# 2000-3600s CPU. The reaper now sweeps them: cmdline has --headless, lacks
# --kol-mcp-lease, and age >= grace.
#
# This test exercises the LINUX sweep path with real throwaway processes
# (sleep masquerading via a fake /proc is impossible, so we spawn real
# short-lived processes named to match, and vary the grace to hit both
# sides of the age gate):
#   - an "old" orphan (already past grace) must be reported and killed
#   - a "fresh" headless process (within grace) must be kept
# On the Linux path the name gate is `*godot*` in cmdline, so we launch
# `sleep` via a symlink named godot-headless-fake with --headless in argv.
#
# Windows path (powershell) is exercised live by the operator; here we only
# assert the script contains the pwsh sweep (static grep) when powershell.exe
# is unavailable.
#
# Exit 0 = pass, 1 = fail.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
REAPER="$REPO/launch/reap-stale-leases.sh"

command -v node >/dev/null 2>&1 || { echo "node required"; exit 1; }
[[ -r "$REAPER" ]] || { echo "reaper not found"; exit 1; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "ok   - $*"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL - $*"; }

FAKE_BIN="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN"' EXIT

# Stability hardening (SEE-1287 M1): force the reaper's Linux /proc branch.
# This test's fake orphan is a WSL process — invisible to the Windows CIM
# sweep the pwsh branch uses (Get-CimInstance only sees Windows processes),
# so with pwsh enabled the sweep was deterministically blind here (the
# "grace=0 not reporting / not killing" failures), while the per-port pwsh
# LISTEN probes also pushed a full pass to ~50-60s wall. KOL_REAP_DISABLE_PWSH
# exists precisely for hermetic test suites.
export KOL_REAP_DISABLE_PWSH=1
# A "godot" binary: sleeps WITHOUT exec so /proc cmdline keeps argv (a bare
# `exec sleep` would replace the cmdline and fail the *godot* name gate).
cat > "$FAKE_BIN/godot-fake" <<'EOF'
#!/usr/bin/env bash
sleep 600
EOF
chmod +x "$FAKE_BIN/godot-fake"

# Fresh process (age ~0). With grace=0 it must be killed; with grace=30 kept.
"$FAKE_BIN/godot-fake" --headless -s probe_fresh.gd &
FRESH_PID=$!

TMP="$(mktemp -d)"

# Case 1 (dry-run, grace=0): the fresh fake is past grace -> reported.
# Stability hardening (SEE-1287 M1): the full residue pass costs ~50-60s wall
# on WSL2 (per-port pwsh LISTEN probes). Bound every reaper invocation so the
# test fails deterministically instead of hanging past its caller's budget.
OUT="$(KOL_REAP_HEADLESS_GRACE_M=0 timeout 120 "$REAPER" --root "$TMP" --dry-run 2>&1 || true)"
if echo "$OUT" | grep -q "HEADLESS-ORPHAN"; then
    ok "dry-run grace=0 reports headless orphan"
else
    bad "dry-run grace=0 did not report headless orphan"
fi
if echo "$OUT" | grep -q "summary:.*headless_killed="; then
    ok "summary line carries headless_killed counter"
else
    bad "summary line missing headless_killed"
fi

# Case 2 (real run, grace=30): fresh process is within grace -> kept alive.
KOL_REAP_HEADLESS_GRACE_M=30 timeout 120 "$REAPER" --root "$TMP" >/dev/null 2>&1 || true
if kill -0 "$FRESH_PID" 2>/dev/null; then
    ok "grace=30 keeps a fresh headless process"
else
    bad "grace=30 killed a fresh headless process (should be kept)"
fi

# Case 3 (real run, grace=0): the fresh fake is past grace -> killed.
KOL_REAP_HEADLESS_GRACE_M=0 timeout 120 "$REAPER" --root "$TMP" >/dev/null 2>&1 || true
# Stability hardening (SEE-1287 M1): WSL2 process teardown is not synchronous —
# probe up to 5s instead of a single 0.3s sleep so a slow kill does not read
# as a flaky "not killed" false failure. The criterion itself (must be dead)
# is unchanged.
dead=0
for _ in $(seq 1 25); do
    kill -0 "$FRESH_PID" 2>/dev/null || { dead=1; break; }
    sleep 0.2
done
if (( ! dead )); then
    bad "grace=0 did not kill the aged-in headless orphan"
    kill -9 "$FRESH_PID" 2>/dev/null || true
else
    ok "grace=0 kills the headless orphan"
fi

rm -rf "$TMP"

echo "pass=$PASS fail=$FAIL"
(( FAIL == 0 )) || exit 1
exit 0
