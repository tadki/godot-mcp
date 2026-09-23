#!/usr/bin/env bash
# test_see1152_configure_async_reaper.sh
#
# SEE-1152 goal A regression: configure-mcp-port.sh's stale-lease reaper must
# default to ASYNC (non-blocking) and must honor the KOL_CONFIGURE_SYNC_REAPER=1
# rollback switch. Covers:
#   T1: default invocation returns quickly (reaper runs in background) and
#       still writes the sidecar lease (reaper does not block the write).
#   T2: KOL_CONFIGURE_SYNC_REAPER=1 restores the old blocking behavior
#       (elapsed time now includes the reaper's own runtime).
#   T3: stage-log emits REAPER_ASYNC_BEGIN/END on default path,
#       REAPER_SYNC_BEGIN/END on the sync rollback path.
#
# Strategy: stub reap-stale-leases.sh with a script that sleeps a fixed 3s so
# the async-vs-sync timing difference is observable in seconds, not tens of
# seconds. The stub records its invocations so we can also prove the reaper
# STILL ran (asynchronously) rather than being skipped.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LAUNCH_DIR="$REPO_ROOT/launch"
CONFIGURE="$LAUNCH_DIR/configure-mcp-port.sh"

PASS=0
FAIL=0
FAILS=()
ok()   { echo "  [PASS] $*"; PASS=$((PASS+1)); }
ko()   { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }
sect() { echo; echo "===== $* ====="; }

[[ -x "$CONFIGURE" ]] || { echo "FATAL: configure not executable: $CONFIGURE" >&2; exit 2; }

# Sandbox: a fake worktree (with .godot/), a fake reaper that sleeps 3s, and
# a fake launch dir containing a symlink farm to the real helpers EXCEPT the
# reaper (so configure sources the real libs but picks up our stub).
SBOX="$(mktemp -d)"
trap 'rm -rf "$SBOX"' EXIT

WT="$SBOX/worktree"
mkdir -p "$WT/.godot"
if [[ -f "$REPO_ROOT/project.godot" ]]; then
    cp "$REPO_ROOT/project.godot" "$WT/project.godot"
else
    # SEE-1291 H2: fork checkout has no root project.godot — the fixture only
    # anchors the sidecar path, so a minimal synthetic project.godot suffices.
    printf 'config_version=5\n\n[godot_mcp]\n\nbind_mode=1\ncustom_bind_ip=""\n' > "$WT/project.godot"
fi

FAKE_LAUNCH="$SBOX/launch"
mkdir -p "$FAKE_LAUNCH"
for f in agent-ports.json agent-ports.lib.sh mcp-sidecar.lib.sh runtime.lib.sh mcp-marker-section.lib.sh; do
    ln -s "$LAUNCH_DIR/$f" "$FAKE_LAUNCH/$f"
done
# Configure itself lives in the fake dir too so SCRIPT_DIR resolves there.
cp "$CONFIGURE" "$FAKE_LAUNCH/configure-mcp-port.sh"
chmod +x "$FAKE_LAUNCH/configure-mcp-port.sh"

REAPER_LOG="$SBOX/reaper.invocations"
cat > "$FAKE_LAUNCH/reap-stale-leases.sh" <<EOF
#!/usr/bin/env bash
echo "\$(date +%s%3N)" >> "$REAPER_LOG"
sleep 3
exit 0
EOF
chmod +x "$FAKE_LAUNCH/reap-stale-leases.sh"

run_configure() {
    local extra_env="$1"
    local t0 t1 rc
    t0="$(date +%s%3N)"
    rc=0
    env $extra_env KOL_STAGE_LOG=on bash -c \
        "cd '$WT' && '$FAKE_LAUNCH/configure-mcp-port.sh' --port 6553 --project-godot '$WT/project.godot'" \
        >"$SBOX/out.log" 2>"$SBOX/err.log" || rc=$?
    t1="$(date +%s%3N)"
    echo "$(( t1 - t0 )) $rc"
}

sect "T1: default async — configure returns well under the reaper's 3s sleep"
read -r DT1 RC1 <<<"$(run_configure "")"
if [[ "$RC1" == "0" && "$DT1" -lt 2500 ]]; then
    ok "T1.1: configure rc=0 in ${DT1}ms (< 2500ms, reaper not blocking)"
else
    ko "T1.1: configure rc=$RC1 took ${DT1}ms (expected < 2500ms)"
fi
# Sidecar must still be written even though the reaper is mid-flight.
if [[ -f "$WT/.godot/mcp-lease.json" ]] && grep -q '"state": "active"' "$WT/.godot/mcp-lease.json"; then
    ok "T1.2: sidecar lease written while reaper runs in background"
else
    ko "T1.2: sidecar lease missing or not active"
fi
# Wait for the background reaper to land, then prove it still ran.
for _ in $(seq 1 40); do [[ -s "$REAPER_LOG" ]] && break; sleep 0.1; done   # SEE-1342 D4: evented — wait for the log line itself (≤4s, same ceiling)
if [[ -s "$REAPER_LOG" ]]; then
    ok "T1.3: reaper still invoked asynchronously (log non-empty after wait)"
else
    ko "T1.3: reaper never ran (log empty after 4s)"
fi
if grep -q "REAPER_ASYNC_BEGIN" "$SBOX/err.log" && grep -q "REAPER_ASYNC_END" "$SBOX/err.log"; then
    ok "T1.4: stage log shows REAPER_ASYNC_BEGIN/END"
else
    ko "T1.4: stage log missing REAPER_ASYNC markers: $(grep stage= "$SBOX/err.log" || echo none)"
fi

sect "T2: KOL_CONFIGURE_SYNC_REAPER=1 — configure blocks for the full 3s"
rm -f "$REAPER_LOG"
read -r DT2 RC2 <<<"$(run_configure "KOL_CONFIGURE_SYNC_REAPER=1")"
if [[ "$RC2" == "0" && "$DT2" -ge 2800 ]]; then
    ok "T2.1: configure rc=0 in ${DT2}ms (>= 2800ms, sync rollback engaged)"
else
    ko "T2.1: configure rc=$RC2 took ${DT2}ms (expected >= 2800ms)"
fi
if grep -q "REAPER_SYNC_BEGIN" "$SBOX/err.log" && grep -q "REAPER_SYNC_END" "$SBOX/err.log"; then
    ok "T2.2: stage log shows REAPER_SYNC_BEGIN/END"
else
    ko "T2.2: stage log missing REAPER_SYNC markers: $(grep stage= "$SBOX/err.log" || echo none)"
fi

# T3 (SEE-1152 目标4 hotfix): a sidecar that is already state=active + same
# port BUT carries stale release traces (released_at set / intentional_release=true)
# must be REWRITTEN to clear those traces, with lease_id preserved. Observed
# live: prior proxy timeout wrote released_at 25s before the next cold start;
# configure's old fast-path trusted state+port and exited, leaving the traces
# in place; the addon then rejected the lease and bound default 6550 while the
# proxy probed the leased 6553 → 300s warmup timeout.
sect "T3: stale release traces on an active lease are cleared (lease_id preserved)"
# Seed an active lease WITH stale traces (as a previous proxy timeout would leave).
PREV_LEASE_ID="11111111-2222-4333-8444-555555555555"
cat > "$WT/.godot/mcp-lease.json" <<EOF
{
  "schema_version": 2,
  "runtime_id": "testrt",
  "task_id": "",
  "port": 6553,
  "agent": "Bachi",
  "label": "bachi",
  "state": "active",
  "lease_id": "$PREV_LEASE_ID",
  "worktree": "$WT",
  "configured_at": "2026-08-20T03:00:00.000Z",
  "configured_by_pid": 999999,
  "released_at": "2026-08-20T03:03:20.009Z",
  "intentional_release": true,
  "notes": "SEE-1117 sidecar lease"
}
EOF
read -r DT3 RC3 <<<"$(run_configure "")"
NEW_STATE="$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify({state:o.state,released_at:o.released_at,intentional:o.intentional_release===true,lease_id:o.lease_id,port:o.port}))' "$WT/.godot/mcp-lease.json" 2>/dev/null || echo '{}')"
if [[ "$RC3" == "0" ]]; then ok "T3.1: configure rc=0"; else ko "T3.1: configure rc=$RC3"; fi
if grep -q "LEASE_TRACES_CLEARED" "$SBOX/err.log"; then
    ok "T3.2: stage log shows LEASE_TRACES_CLEARED"
else
    ko "T3.2: stage log missing LEASE_TRACES_CLEARED: $(grep stage= "$SBOX/err.log" || echo none)"
fi
if echo "$NEW_STATE" | grep -q '"released_at":null' && echo "$NEW_STATE" | grep -q '"intentional":false'; then
    ok "T3.3: released_at/intentional_release traces cleared"
else
    ko "T3.3: stale traces survived rewrite: $NEW_STATE"
fi
if echo "$NEW_STATE" | grep -q "\"lease_id\":\"$PREV_LEASE_ID\""; then
    ok "T3.4: lease_id preserved across trace-clearing rewrite"
else
    ko "T3.4: lease_id changed (expected $PREV_LEASE_ID): $NEW_STATE"
fi
if echo "$NEW_STATE" | grep -q '"port":6553' && echo "$NEW_STATE" | grep -q '"state":"active"'; then
    ok "T3.5: port+state unchanged (6553, active)"
else
    ko "T3.5: port or state drifted: $NEW_STATE"
fi

# T4: clean active lease (no traces) still takes the fast path — must NOT
# rewrite, must NOT regenerate lease_id, must NOT emit LEASE_TRACES_CLEARED.
sect "T4: clean active lease keeps fast path (no rewrite, no LEASE_TRACES_CLEARED)"
CLEAN_LEASE_ID="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
cat > "$WT/.godot/mcp-lease.json" <<EOF
{
  "schema_version": 2, "runtime_id": "testrt", "task_id": "",
  "port": 6553, "agent": "Bachi", "label": "bachi",
  "state": "active", "lease_id": "$CLEAN_LEASE_ID",
  "worktree": "$WT",
  "configured_at": "2026-08-20T03:00:00.000Z",
  "configured_by_pid": 999999, "released_at": null,
  "notes": "SEE-1117 sidecar lease"
}
EOF
read -r DT4 RC4 <<<"$(run_configure "")"
CLEAN_STATE="$(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(JSON.stringify({lease_id:o.lease_id,configured_at:o.configured_at}))' "$WT/.godot/mcp-lease.json" 2>/dev/null || echo '{}')"
if [[ "$RC4" == "0" ]]; then ok "T4.1: configure rc=0"; else ko "T4.1: configure rc=$RC4"; fi
if grep -q "Fast path: sidecar already active" "$SBOX/out.log" && ! grep -q "LEASE_TRACES_CLEARED" "$SBOX/err.log"; then
    ok "T4.2: fast path taken, no trace-clearing rewrite"
else
    ko "T4.2: expected fast path: out=$(grep -i 'fast path' "$SBOX/out.log" || echo none) err=$(grep stage= "$SBOX/err.log" || echo none)"
fi
if echo "$CLEAN_STATE" | grep -q "\"lease_id\":\"$CLEAN_LEASE_ID\"" && echo "$CLEAN_STATE" | grep -q '"configured_at":"2026-08-20T03:00:00.000Z"'; then
    ok "T4.3: clean lease fully untouched (lease_id + configured_at preserved)"
else
    ko "T4.3: clean lease was rewritten: $CLEAN_STATE"
fi

echo
echo "===== summary: pass=$PASS fail=$FAIL ====="
if (( FAIL > 0 )); then
    for f in "${FAILS[@]}"; do echo "  - $f"; done
    exit 1
fi
exit 0
