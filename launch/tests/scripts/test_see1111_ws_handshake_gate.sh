#!/usr/bin/env bash
# test_see1111_ws_handshake_gate.sh
#
# SEE-1111 缺陷 #10 + hold-to-warm — the first-call flush gate is raised from
# `Server listening` (缺陷 A) to `WS handshake complete + MCP_INITIALIZED`:
#
#   The npx godot-mcp CLI's ws-connect chain (QUICK_TIMEOUT_MS=30s, hardcoded)
#   starts ticking the moment the first tools/call reaches it. Flushing while the
#   editor has bound its WS port but has NOT yet completed a WS handshake can
#   still blow that 30s window. The proxy therefore does NOT flush any call to
#   npx until the `WS_HANDSHAKE` milestone is observed — and every tools/call
#   that lands while the editor is warming is HELD in the FIFO (SEE-1111 目标1
#   hold-to-warm), never hinted, never prematurely flushed.
#
# This test drives the REAL proxy deterministically:
#   F1  spawn — first tools/call triggers the editor spawn; id=2 is HELD in the
#       FIFO while the editor is cold (no hint, no answer, no forward).
#   F2  gate proof — appending `Server listening` ALONE must NOT flush the held
#       call to npx (pre-缺陷 #10 the proxy forwarded to npx exactly here,
#       defeating the hold).
#   F3  FLUSH gate — after `WebSocket handshake complete` the proxy warms; the
#       held id=2 is flushed to npx and answered, and a NEW retry call id=3 is
#       forwarded and answered (the gate opened for real calls).
#   F4  MCP_INITIALIZED proof — the post-warm timeline echo carries `init→Xs`
#       (non-'?'), i.e. MCP_INITIALIZED is populated once WS_HANDSHAKE is seen.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1111_ws_handshake_gate.sh

set -uo pipefail
trap '' PIPE   # writes into a closed coproc reader deliver SIGPIPE; ignore.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)
EDITOR_LOG="$TMPDIR/editor.log"; : > "$EDITOR_LOG"   # readable, empty → renderStable flips in ~4s
CFG="$TMPDIR/cfg.count"; START="$TMPDIR/start.count"
: > "$CFG"; : > "$START"
CFG_SH=$(make_configure_mock "$CFG" 0)
START_SH=$(make_start_mock "$START" 0 1)             # spawn=1 → listener on GODOT_PORT

sep "SEE-1111 缺陷 #10 + hold-to-warm: first call held until WS handshake; gate opens after WARM (port=$PORT)"

start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG" \
    "KOL_START_COUNTER=$START" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=5000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "GODOT_EDITOR_LOG_FILE=$EDITOR_LOG" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
if wait_for "$PROXY_OUT" '"id":1' 1500; then
    ok "F0: initialize answered immediately (MCP handshake live, npx transport up)"
else
    ko "F0: initialize not answered — proxy/mock chain dead"
fi

# F1 — the first tools/call spawns the editor; the mock listener binds the port.
# Under SEE-1111 hold-to-warm (目标1) the call id=2 is HELD in the FIFO while the
# editor is cold — no hint, no answer, no premature forward.
send_line "$(call_line 2)"
if wait_for "$PROXY_ERR" 'editor spawn launched' 3000; then
    ok "F1.1: spawn triggered by first tools/call"
else
    ko "F1.1: editor spawn never launched"
fi
# The editor log carries neither milestone yet (Server listening / WS handshake),
# so the WARM gate cannot open; id=2 must stay HELD — not answered early, not
# hinted. The 15s warmup timeout is far beyond this short window.
sleep 2
if grep -q '"id":2' "$PROXY_OUT"; then
    ko "F1.2: id=2 answered early while the editor is still cold (hold-to-warm must hold, no early answer)"
else
    ok "F1.2: id=2 HELD in the FIFO while cold (no hint, no early answer — 目标1 hold-to-warm)"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "F1.3: warmup-hint text appeared (default hint must be gone under the 90s timeout)"
else
    ok "F1.3: no warmup-hint text (held call, no hint — 目标1)"
fi
# id=2 must NOT reach npx — the pre-fix premature flush forwarded it here.
if grep -q '"id":2' "$TMPDIR/npx.log" 2>/dev/null; then
    ko "F1.4: id=2 forwarded to npx while the editor is cold (缺陷 A/#10: premature flush)"
else
    ok "F1.4: id=2 NOT forwarded to npx — held in the proxy FIFO"
fi

# F2 — 缺陷 #10 gate proof: `Server listening` ALONE must not open the gate; the
# HELD id=2 must stay in the FIFO (the raise of the gate to WS_HANDSHAKE is what
# protects the npx CLI's 30s window).
echo "[godot-mcp] Server listening on 127.0.0.1:$PORT [test]" >> "$EDITOR_LOG"
if grep -q '"id":2' "$TMPDIR/npx.log" 2>/dev/null; then
    ko "F2: id=2 reached npx after Server listening but before WS handshake (缺陷 #10: premature flush)"
else
    ok "F2: no flush to npx after Server listening alone (gate held — id=2 still in the FIFO)"
fi

# F3 — the editor completes the WS handshake and logs the milestone; the proxy
# reaches WARM and flushes the HELD id=2 to npx (the 目标1 acceptance). A NEW
# retry call id=3 is then also forwarded and answered.
echo "[godot-mcp] WebSocket handshake complete" >> "$EDITOR_LOG"
# renderStable needs ~4s (2 × RENDER_SAMPLE_MS) to flip, so wait for the WARM
# transition rather than grep immediately.
if wait_for "$PROXY_ERR" 'warm detected' 12000; then
    ok "F3.1: proxy reached WARM after the WS handshake milestone"
else
    ko "F3.1: proxy never logged warm detected"
fi
# 目标1 acceptance: the held id=2 is flushed at WARM and answered.
if wait_for "$TMPDIR/npx.log" '"id":2' 4000; then
    ok "F3.0: held id=2 flushed to npx at WARM (hold → flush — 目标1 acceptance)"
else
    ko "F3.0: held id=2 never reached npx after WARM"
fi
if wait_for "$PROXY_OUT" '"id":2' 4000; then
    ok "F3.0b: held id=2 answered after WARM (real mock-ok result, not a hint)"
else
    ko "F3.0b: held id=2 not answered after the flush"
fi
send_line "$(call_line 3)"
if wait_for "$PROXY_OUT" '"id":3' 6000; then
    ok "F3.2: retry call id=3 answered after warm (forwarded path, not hinted)"
else
    ko "F3.2: no id=3 response after warm"
fi
if wait_for "$TMPDIR/npx.log" '"id":3' 4000; then
    ok "F3.3: id=3 forwarded to npx (real call after warm)"
else
    ko "F3.3: id=3 never reached npx"
fi

# F4 — MCP_INITIALIZED proof: with WS_HANDSHAKE observed, §2.2 backfills
# MCP_INITIALIZED at warm, so the post-warm timeline echo shows `init→Ns`
# (a real number, not `?`).
sleep 0.3
TL=$(grep -o '\[godot-mcp warmup [^]]*\]' "$PROXY_OUT" | tail -1)
if [[ -n "$TL" ]]; then
    note "timeline: $TL"
    INIT=$(echo "$TL" | grep -o 'init→[^ ]*s')
    if [[ "$INIT" =~ init→[0-9]+(\.[0-9])?s ]]; then
        ok "F4: MCP_INITIALIZED populated at warm ($INIT) — init derived from observed WS handshake"
    else
        ko "F4: MCP_INITIALIZED not populated at warm (got '$INIT' — expected 'init→Ns')"
    fi
else
    ko "F4: no warmup timeline echo in the post-warm response — cannot assert MCP_INITIALIZED"
fi

stop_proxy
summary
