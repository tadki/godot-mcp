#!/usr/bin/env bash
# test_see1085_t4_lease_respawn.sh
#
# SEE-1085 B1 lazy-load — T4 lease self-exit then respawn, with SEE-1111
# hold-to-warm.
#
# Precondition: a live editor on GODOT_PORT. The proxy reaches WARM, the
# client detaches (no MCP consumer → addon lease canceler would normally run
# for 120s QUIT_DELAY before self-exit; in the test we short-circuit that by
# appending the exact LEASE_EXITING line to GODOT_EDITOR_LOG_FILE, which is
# what the SEE-1077 lease monitor tails for). The proxy fast-fails via the
# existing T4 FAILED_EXIT path (rejectQueue + warmupDiagnostic('failed_exit')
# + process.exit(1)). A fresh proxy started afterward (simulating a Claude
# restart) must walk COLD_EMPTY → spawn → warm and answer its first
# tools/call.
#
# With hold-to-warm (SEE-1111 目标1): each proxy's first tools/call is HELD in
# the FIFO while the editor warms, then flushed to npx after WARM and answered —
# no warmup hint is emitted.
#
# Note: the design (see §5) is that npx occupies the WS single-client slot
# and cancels the lease; this test does not retest that long-running
# guarantee. It proves the B1 invariant: lease exit ⇒ proxy exits ⇒ next
# proxy lazily respawns. Port can differ between the two proxies (the
# important assertion is that proxy 2's spawn fires, not that it reuses the
# old port).
#
# Assertions (design §10 T4, adapted to hold-to-warm):
#   T4.1  proxy 1 reaches WARM.
#   T4.2  after LEASE_EXITING is appended, proxy 1 exits via FAILED_EXIT
#         (rejectQueue diagnostic on stdout carries state=failed_exit).
#   T4.3  proxy 2 (fresh process, empty port) triggers configure+start once
#         on its first tools/call and reaches WARM.
#   T4.4  proxy 2's first tools/call id=2 is HELD while warming, then flushed
#         to npx after WARM and answered — no warmup-hint text anywhere.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1085_t4_lease_respawn.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

LEASE_EXITING='Lease: no MCP client for the grace window; exiting editor to release the port.'

# --- proxy 1: live editor, lease exits ---------------------------------------
PORT1=$(find_free_port)
EDITOR_LOG="$TMPDIR/editor1.log"; : > "$EDITOR_LOG"   # empty → renderStable flips in ~4s
CFG1="$TMPDIR/cfg1.count"; START1="$TMPDIR/start1.count"
: > "$CFG1"; : > "$START1"
CFG1_SH=$(make_configure_mock "$CFG1" 0)
START1_SH=$(make_start_mock "$START1" 0 1)             # spawn=1 → listener on GODOT_PORT

sep "T4: proxy 1 — warm, lease line, expect fast-fail"
# We bring the listener up via the start mock (spawn=1) so the SAME counter
# path is exercised as T1 — proving the lease exit path works on top of the
# B1 spawn path. GODOT_EDITOR_LOG_FILE IS set here so the lease monitor runs.
start_proxy \
    "GODOT_PORT=$PORT1" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG1_SH" \
    "KOL_START_SH=$START1_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG1" \
    "KOL_START_COUNTER=$START1" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=8000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "KOL_GIVEUP_REARM=0" \
    "GODOT_EDITOR_LOG_FILE=$EDITOR_LOG" \
    "MOCK_NPX_LOG=$TMPDIR/npx1.log"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "T4.pre: initialize not answered"

send_line "$(call_line 2)"
# The first tools/call is HELD in the FIFO while the mock editor boots
# (hold-to-warm, SEE-1111 目标1); once the WARM gate opens it is flushed to npx
# and answered. The answer comes after WARM, so the T4.1 WARM wait below also
# proves the hold didn't deadlock the flush.
# The mock editor "binds" its WS server once the listener is up. Emit the
# milestone lines the proxy's WARM gate (SEE-1111 缺陷 A + 缺陷 #10) waits for —
# otherwise WARM is held forever because the log is readable but `Server
# listening` (缺陷 A) and `WebSocket handshake complete` (缺陷 #10) are never
# observed (the gate only falls back to TCP when the log is unreadable).
echo "[godot-mcp] Server listening on 127.0.0.1:$PORT1 [test]" >> "$EDITOR_LOG"
echo "[godot-mcp] WebSocket handshake complete" >> "$EDITOR_LOG"
# Listener binds right after start mock runs; renderStable flips ~4s after
# monitor start (empty log → swap_chain_resize count stable). Wait up to 12s
# for warm; HOT timeout is 8s, so a 12s window catches both paths.
if wait_for "$PROXY_ERR" 'warm detected' 12000; then
    ok "T4.1: proxy 1 reached WARM (lease tail active)"
else
    ko "T4.1: proxy 1 never reached WARM with editor log + listener"
fi
# The held first call id=2 is flushed to npx on WARM and answered — no hint.
if wait_for "$PROXY_OUT" '"id":2' 4000; then
    ok "T4.1.pre: held id=2 flushed and answered after WARM (hold-to-warm)"
else
    ko "T4.1.pre: id=2 not answered after WARM (hold broke the flush)"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "T4.1.pre.b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "T4.1.pre.b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi

# Lease exits: append the exact line the SEE-1077 monitor matches.
echo "$LEASE_EXITING" >> "$EDITOR_LOG"

if wait_for_death 8000; then
    ok "T4.2a: proxy 1 exited within 8s of LEASE_EXITING (T4 fast-fail path)"
else
    ko "T4.2a: proxy 1 still alive 8s after LEASE_EXITING"
fi

# Validate the lease monitor fired and took the FAILED_EXIT code path. At WARM
# the buffered-call list is empty, so rejectQueue is a no-op (correct: there is
# no agent call waiting to receive a diagnostic — the proxy just exits and the
# platform restarts the MCP server). The always-emitted stderr log line is the
# proof the SEE-1077 monitor matched LEASE_EXITING and ran process.exit(1).
SNAP1="$TMPDIR/p1_snap.out"; cp "$PROXY_OUT" "$SNAP1"
if grep -q 'lease death detected' "$PROXY_ERR"; then
    ok "T4.2b: lease monitor matched LEASE_EXITING and ran the FAILED_EXIT path"
else
    ko "T4.2b: no lease-death log line on proxy 1 stderr (monitor did not fire)"
fi

stop_proxy
# Kill the still-listening TCP listener from proxy 1's start mock.
pkill -f "$LISTENER_SCRIPT" 2>/dev/null || true
wait_for_stable "$CFG1" 2000   # SEE-1342 D4: counter writes settle

# --- proxy 2: fresh, must walk COLD_EMPTY → spawn → warm ---------------------
PORT2=$(find_free_port)
CFG2="$TMPDIR/cfg2.count"; START2="$TMPDIR/start2.count"
: > "$CFG2"; : > "$START2"
CFG2_SH=$(make_configure_mock "$CFG2" 0)
START2_SH=$(make_start_mock "$START2" 0 1)

sep "T4: proxy 2 — fresh process, empty port, first tools/call spawns editor"
# Intentionally do NOT set GODOT_EDITOR_LOG_FILE for proxy 2 — no lease tail,
# renderStable=true immediately. This is the production scenario for a clean
# restart (a real editor log would be re-created by the new editor run).
start_proxy \
    "GODOT_PORT=$PORT2" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG2_SH" \
    "KOL_START_SH=$START2_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG2" \
    "KOL_START_COUNTER=$START2" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=5000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "MOCK_NPX_LOG=$TMPDIR/npx2.log"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "T4.post.pre: proxy 2 initialize not answered"

send_line "$(call_line 2)"
if wait_for "$PROXY_ERR" 'editor spawn launched' 3000; then
    ok "T4.3a: proxy 2 spawned editor after lease exit (B1 respawn path works)"
else
    ko "T4.3a: proxy 2 never ran configure+start (COLD_EMPTY path broken)"
fi
wait_for_stable "$CFG2" 2000   # SEE-1342 D4
CFG2_COUNT=$(count_lines "$CFG2")
START2_COUNT=$(count_lines "$START2")
if [[ "$CFG2_COUNT" == "1" && "$START2_COUNT" == "1" ]]; then
    ok "T4.3b: configure+start invoked exactly once each (cfg=$CFG2_COUNT start=$START2_COUNT)"
else
    ko "T4.3b: counters wrong (cfg=$CFG2_COUNT start=$START2_COUNT)"
fi
if wait_for "$PROXY_ERR" 'warm detected' 8000; then
    ok "T4.3c: proxy 2 reached WARM"
else
    ko "T4.3c: proxy 2 never reached WARM"
fi
# T4.4 — proxy 2's first tools/call id=2 was HELD while the editor was cold
# (hold-to-warm), then flushed to npx after WARM and answered — no hint text.
if wait_for "$PROXY_OUT" '"id":2' 6000; then
    ok "T4.4a: proxy 2's first tools/call id=2 answered after WARM (held then flushed)"
else
    ko "T4.4a: no id=2 response after WARM (hold broke the flush)"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "T4.4b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "T4.4b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if wait_for "$TMPDIR/npx2.log" '"id":2' 4000; then
    ok "T4.4c: id=2 forwarded to npx after WARM (flushed from the hold FIFO)"
else
    ko "T4.4c: id=2 never reached npx (hold broke the flush)"
fi
send_line "$(call_line 3)"
if wait_for "$PROXY_OUT" '"id":3' 5000; then
    ok "T4.4d: post-warm retry id=3 answered (forwarded path, not a hint)"
else
    ko "T4.4d: no id=3 response after warm"
fi
if wait_for "$TMPDIR/npx2.log" '"id":3' 4000; then
    ok "T4.4e: id=3 forwarded to npx after warm"
else
    ko "T4.4e: id=3 never reached npx after warm"
fi

stop_proxy
summary
