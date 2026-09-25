#!/usr/bin/env bash
# test_see1111_defect6_wsprobe_first_call.sh
#
# SEE-1111 缺陷 #6 — real WS handshake probe + first cold-start call succeeds.
#
# Root cause (confirmed): the addon's _accept_connection() accepts ANY TCP
# connection as _ws_peer via WebSocketPeer.accept_stream() and _process_websocket
# has NO STATE_CONNECTING timeout. A raw TCP connect (the pre-fix proxy probe)
# during the editor cold-boot window gets accepted as a WS peer stuck awaiting
# the handshake, poisoning the single WS slot. When the real CLI connects,
# _ws_peer != null → not stale yet → newcomer REJECTED with 4001 → the first
# cold-start tools/call fails (Revy hard acceptance).
#
# Fix: the proxy's warmup probe is now wsProbe — a REAL WebSocket handshake
# (HTTP Upgrade). A completed handshake proves the addon's WS stack is past
# STATE_CONNECTING; the probe closes immediately on `open`, releasing the slot
# before the real CLI connects.
#
# This test proves the fix through the REAL proxy with a WS-counting mock
# listener (WS_COUNT_FILE):
#   F1  spawn — first tools/call spawns the editor; the call is HELD in the
#       FIFO (SEE-1111 hold-to-warm), never answered with a hint, never
#       forwarded while the editor is cold.
#   F2  PROBE IS REAL — the listener recorded at least one completed WebSocket
#       handshake (wsProbe). A raw TCP probe could never complete an HTTP
#       Upgrade, so a marker proves the 缺陷 #6 fix is actually exercised.
#   F3  hold semantics — the first cold-start tools/call (id=2) is held, NOT
#       forwarded to npx, and NO 4001 / "Never successfully connected" marker
#       appears anywhere.
#   F4  first real call — after WARM the HELD id=2 is flushed to npx and
#       answered (the probe's close released the slot) — no WS-rejection.
#   F5  slot released — a second post-warm call (id=3) is also forwarded and
#       answered (a stuck peer would block it).
#
# Test seam: make_start_mock(spawn=1) nohup's the WS-completing mock listener on
# GODOT_PORT (SEE-1111 缺陷 #6 requires a mock editor that completes an Upgrade).
# The listener gets WS_COUNT_FILE so the test can prove the probe was a handshake.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1111_defect6_wsprobe_first_call.sh

set -uo pipefail
trap '' PIPE   # writes into a closed coproc reader deliver SIGPIPE; ignore.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)
CFG_COUNTER="$TMPDIR/cfg.count"
START_COUNTER="$TMPDIR/start.count"
WS_COUNT="$TMPDIR/ws.count"
: > "$CFG_COUNTER"; : > "$START_COUNTER"; : > "$WS_COUNT"

CFG_SH=$(make_configure_mock "$CFG_COUNTER" 0 "$MOCK_WORKTREE")
# spawn=1 → the start mock nohup's the WS-completing mock listener on GODOT_PORT.
# The nohup `env "LISTEN_PORT=..." node ...` preserves the inherited environment,
# so WS_COUNT_FILE set in the proxy env reaches the listener; every completed
# WebSocket Upgrade appends a marker (proving the probe is a real handshake).
START_SH=$(make_start_mock "$START_COUNTER" 0 1)

sep "SEE-1111 缺陷 #6: WS-handshake probe + first cold-start call succeeds (port=$PORT)"
start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG_COUNTER" \
    "KOL_START_COUNTER=$START_COUNTER" \
    "WS_COUNT_FILE=$WS_COUNT" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=5000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
if wait_for "$PROXY_OUT" '"id":1' 1500; then
    ok "F1.pre: initialize answered (MCP handshake live)"
else
    ko "F1.pre: initialize not answered — proxy/mock chain dead"
fi

# F1 — the FIRST cold-start tools/call triggers spawn and is HELD in the FIFO
# (hold-to-warm 目标1) — no immediate hint, no premature flush. On WARM the held
# call is the first one that actually reaches npx.
send_line "$(call_line 2)"
if wait_for "$PROXY_ERR" 'editor spawn launched' 3000; then
    ok "F1.1: spawn launched after first tools/call"
else
    ko "F1.1: proxy never spawned the editor after tools/call"
fi

# F2 — the warmup probe was a REAL WebSocket handshake (marker appended).
wait_for "$WS_COUNT" 'ws' 3000 || true   # SEE-1342 D4: wait for the marker event itself (listener appends 'ws')
WS_N=$(count_lines "$WS_COUNT")
if [[ "$WS_N" -ge 1 ]]; then
    ok "F2.1: listener recorded $WS_N completed WS handshake(s) — probe is a real Upgrade (not raw TCP)"
else
    ko "F2.1: no WS handshake recorded — wsProbe may have degraded to raw TCP"
fi

# F3 — the FIRST cold-start call id=2 never gets a warmup hint and never hits a
# WS-rejection: no 4001 / "never successfully connected" marker appears
# anywhere. (WARM flips fast here — no editor log → renderStable instant, the
# wsProbe completes a handshake immediately — so the deterministic assertions
# are the hint-free path and the absence of rejection markers, not a timing
# race on "still held".)
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "F3.2: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "F3.2: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if grep -q '4001\|Never successfully connected\|never successfully connected' "$PROXY_OUT"; then
    ko "F3.4: proxy emitted a WS-rejection marker (4001 / 'never connected') — slot was poisoned"
else
    ok "F3.4: no WS-rejection marker (4001 / 'never successfully connected') on the first call"
fi

# F4 — after WARM, the HELD id=2 is flushed to npx and answered: the wsProbe's
# completed handshake released the slot, so the npx CLI's WS connect succeeds —
# no 4001 / "never connected".
if wait_for "$PROXY_ERR" 'warm detected' 8000; then
    ok "F4.1: proxy reached WARM"
else
    ko "F4.1: proxy never reached WARM"
fi
if wait_for "$PROXY_OUT" '"id":2' 8000; then
    ok "F4.2: held id=2 flushed and answered after WARM (the first real call succeeds)"
else
    ko "F4.2: no id=2 response after WARM"
fi
if wait_for "$TMPDIR/npx.log" '"id":2' 4000; then
    ok "F4.3: id=2 forwarded to npx after WARM (flushed on warm, not rejected)"
else
    ko "F4.3: id=2 never reached npx"
fi
if grep -q '4001\|Never successfully connected\|never successfully connected' "$PROXY_OUT"; then
    ko "F4.4: WS-rejection marker appeared after warm — slot poisoned"
else
    ok "F4.4: no WS-rejection marker on the post-warm call (slot released by the probe)"
fi

# F5 — a second post-warm call also succeeds (probe released the slot).
send_line "$(call_line 3)"
if wait_for "$PROXY_OUT" '"id":3' 8000; then
    ok "F5.1: second post-warm call id=3 answered (slot not blocked by a stuck peer)"
else
    ko "F5.1: no id=3 response"
fi
if wait_for "$TMPDIR/npx.log" '"id":3' 4000; then
    ok "F5.2: id=3 forwarded to npx"
else
    ko "F5.2: id=3 never reached npx"
fi

stop_proxy
summary
