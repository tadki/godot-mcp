#!/usr/bin/env bash
# test_see1111_cold_start_gate.sh
#
# SEE-1111 缺陷 A (CRITICAL) regression — combined with hold-to-warm (SEE-1111
# 目标1) and the timeout fallback (目标2).
#
# 缺陷 A: the pre-fix proxy flushed the first tools/call on `tcpOk &&
# renderStable`: the TCP listener bound instantly, renderStable flipped ~4s
# later, and the call was forwarded to npx while the real addon was still
# initializing (~22s cold boot). The npx godot-mcp CLI's ws connect chain then
# failed against the unbound port and a bogus "Not connected" passed through.
# 缺陷 #10 raised the flush gate to `WebSocket handshake complete`.
#
# SEE-1111 目标1 (hold-to-warm): the first tools/call that lands while the
# editor is warming is HELD in the FIFO until the gate opens — no warmup hint,
# no premature flush. On WARM the held call is flushed to npx and answered
# with the real result; the first post-warm response carries the one-shot
# timeline echo.
#
# This test asserts:
#   A.0  first tools/call triggers the lazy spawn.
#   A.1  id=2 is HELD while the editor is cold — not forwarded to npx
#        (pre-fix premature-flush bug), and NO warmup-hint text anywhere.
#   A.2  appending the WS milestones warms the proxy; the HELD id=2 is then
#        flushed to npx and answered with a real result (the gate opened for
#        real calls).
#   A.3  the first post-warm response carries the one-shot timeline echo.
#   A.4  MCP_INITIALIZED backfilled at warm — the post-warm timeline echo
#        carries `init→Ns`.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1111_cold_start_gate.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)
EDITOR_LOG="$TMPDIR/editor.log"; : > "$EDITOR_LOG"   # readable, empty → renderStable flips in ~4s
CFG="$TMPDIR/cfg.count"; START="$TMPDIR/start.count"
: > "$CFG"; : > "$START"
CFG_SH=$(make_configure_mock "$CFG" 0 "$MOCK_WORKTREE")
START_SH=$(make_start_mock "$START" 0 1)             # spawn=1 → listener on GODOT_PORT

sep "SEE-1111 缺陷 A/#10 + hold-to-warm: first call held until the gate opens (WS handshake)"

start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG" \
    "KOL_START_COUNTER=$START" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=8000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "GODOT_EDITOR_LOG_FILE=$EDITOR_LOG" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "A.pre: initialize not answered"

# A.1 — the first tools/call while the editor is warming (spawn launched, not
# yet WARM) is HELD in the FIFO (hold-to-warm 目标1). Pre-fix it was buffered
# then forwarded to npx while the addon was still initializing — the
# premature-flush bug (缺陷 A). While cold it must NOT be forwarded and must
# NOT be answered with a warmup hint.
send_line "$(call_line 2)"
if wait_for "$PROXY_ERR" 'editor spawn launched' 3000; then
    ok "A.0: spawn triggered by first tools/call"
else
    ko "A.0: editor spawn never launched"
fi
sleep 1.5   # 竞态窗口语义（CLAUDE.md 边界）：负向断言"id=2 冷窗内绝不提前应答"，须窗已过；窗长 = hold-to-warm 触发窗，即被测行为
if grep -q '"id":2' "$PROXY_OUT"; then
    ko "A.1a: id=2 answered BEFORE warm (premature — must be held until the gate opens)"
else
    ok "A.1a: id=2 held while the editor is cold (no early answer, no hint)"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "A.1b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "A.1b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
# And it must NOT be forwarded to npx — a forwarding is the pre-fix
# premature-flush bug.
if grep -q '"id":2' "$TMPDIR/npx.log" 2>/dev/null; then
    ko "A.1d: id=2 was forwarded to npx while the editor is cold (缺陷 A: premature flush)"
else
    ok "A.1d: id=2 NOT forwarded to npx while cold — held in the FIFO"
fi

# A.2 — append the milestones the WARM gate (缺陷 A + 缺陷 #10) waits for: the
# editor binds its WS server, then completes the handshake. The proxy reaches
# WARM; the HELD id=2 is then flushed to npx and answered (the gate opened for
# real calls).
echo "[godot-mcp] Server listening on 127.0.0.1:$PORT [test]" >> "$EDITOR_LOG"
echo "[godot-mcp] WebSocket handshake complete" >> "$EDITOR_LOG"
# renderStable needs ~4s (2 × RENDER_SAMPLE_MS) to flip, so wait for the WARM
# transition rather than grep immediately.
if wait_for "$PROXY_ERR" 'warm detected' 12000; then
    ok "A.2a: proxy reached WARM after the milestones"
else
    ko "A.2a: proxy never logged warm detected"
fi

# The held id=2 is flushed to npx after WARM and answered with a real result.
if wait_for "$PROXY_OUT" '"id":2' 8000; then
    ok "A.2b: held id=2 answered after warm (forwarded path, not a hint)"
else
    ko "A.2b: no id=2 response after warm (hold broke the flush)"
fi
if wait_for "$TMPDIR/npx.log" '"id":2' 4000; then
    ok "A.2c: id=2 forwarded to npx after WARM (real call, flushed from the FIFO)"
else
    ko "A.2c: id=2 never reached npx (hold broke the flush)"
fi

# A.3 — MCP_INITIALIZED proof: with WS_HANDSHAKE observed, §2.2 backfills
# MCP_INITIALIZED at warm, so the first post-warm response's timeline echo
# (which rides id=2's result) shows `init→Ns` (a real number, not `?`).
wait_for_stable "$TMPDIR/cfg.count" 2000   # SEE-1342 D4
TL=$(grep -o '\[godot-mcp warmup [^]]*\]' "$PROXY_OUT" | tail -1)
if [[ -n "$TL" ]]; then
    note "timeline: $TL"
    INIT=$(echo "$TL" | grep -o 'init→[^ ]*s')
    if [[ "$INIT" =~ init→[0-9]+(\.[0-9])?s ]]; then
        ok "A.3: MCP_INITIALIZED populated at warm ($INIT) — init derived from observed WS handshake"
    else
        ko "A.3: MCP_INITIALIZED not populated at warm (got '$INIT' — expected 'init→Ns')"
    fi
else
    ko "A.3: no warmup timeline echo in the post-warm response — cannot assert MCP_INITIALIZED"
fi

stop_proxy
summary
