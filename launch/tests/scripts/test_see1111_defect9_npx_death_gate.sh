#!/usr/bin/env bash
# test_see1111_defect9_npx_death_gate.sh
#
# SEE-1111 缺陷 #9 + 预热提示 — a tools/call that arrives while npx's transport is
# DOWN must be HELD (and flushed after npx restarts), never forwarded into a dead
# pipe. Forwarding to a dead npx silently drops the call (forwardToNpx →
# "dropping message" → the client's id never gets an answer → the MCP client's
# tools/call timeout fires — Revy hard acceptance: "第一次mcp调用就他妈超时显示
# not connected").
#
# Why a transport-death window: the proxy's npx stdin pipe becomes writable the
# instant spawn() returns, so there is no meaningful "transport not ready" window
# at proxy start. The gate's REAL protective slice is the npx DEATH/RESTART
# window: npx exits (crash, npx cache lock, OOM) → the proxy hot-restarts it
# after NPX_RESTART_BACKOFF_MS → npxTransportReady is false throughout → a warm
# tools/call in that window must be held in pendingCalls, not dropped.
#
# This test drives that deterministically through the REAL proxy, including the
# hold-to-warm semantics (SEE-1111 目标1) for the cold-start phase:
#   F1  warm — first tools/call (id=2) triggers the spawn and is HELD until WARM,
#       then flushed to npx and answered (no warmup hint, no premature flush);
#       the follow-up id=3 is forwarded and answered (the proxy is warm, npx
#       transport up — the flush gate opened).
#   F2  npx death — kill the proxy's npx child (SIGTERM → 'exit'). The proxy
#       detects it and schedules a hot-restart (npxTransportReady=false now).
#   F3  gate hold — send id=4 inside the restart window: WITHOUT the 缺陷 #9
#       gate it is forwarded to the dead child's destroyed stdin and DROPPED
#       (never answered → client timeout). WITH the gate it is held.
#   F4  flush after restart — the fresh npx comes up, markNpxTransportReady()
#       flushes the held call; id=4 is forwarded to the new npx and answered.
#   F5  no-drop sanity — the restart was a hot restart (npxTransportReady was
#       latched false by the exit handler; the gate is what held id=4). A
#       follow-up call id=5 is also forwarded+answered on the fresh transport.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1111_defect9_npx_death_gate.sh

set -uo pipefail
trap '' PIPE   # writes into a closed coproc reader deliver SIGPIPE; ignore.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)
CFG_COUNTER="$TMPDIR/cfg.count"
START_COUNTER="$TMPDIR/start.count"
: > "$CFG_COUNTER"; : > "$START_COUNTER"

CFG_SH=$(make_configure_mock "$CFG_COUNTER" 0)
START_SH=$(make_start_mock "$START_COUNTER" 0 1)   # spawn=1 → listener on GODOT_PORT

sep "SEE-1111 缺陷 #9: warm call during npx-death window held + flushed after restart (port=$PORT)"
start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG_COUNTER" \
    "KOL_START_COUNTER=$START_COUNTER" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=5000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "KOL_NPX_RESTART_BACKOFF_MS=1200" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log" \
    "MOCK_EDITOR_PORT=$PORT"

# F0 — initialize answered immediately (MCP handshake never blocked).
send_line "$INIT_LINE"
if wait_for "$PROXY_OUT" '"id":1' 1500; then
    ok "F0: initialize answered immediately (MCP handshake live)"
else
    ko "F0: initialize not answered — proxy/mock chain dead"
fi

# F1 — warm the proxy. id=2 (the trigger call) is HELD in the FIFO until the
# gate opens (SEE-1111 hold-to-warm 目标1), then flushed to npx and answered —
# no warmup hint, no premature flush; id=3 establishes the warm forwarded path
# (the flush gate opened).
send_line "$(call_line 2)"
if wait_for "$PROXY_ERR" 'editor spawn launched' 3000; then
    ok "F1.0: spawn launched after first tools/call"
else
    ko "F1.0: proxy never spawned the editor after tools/call"
fi
if wait_for "$PROXY_ERR" 'warm detected' 10000; then
    ok "F1.4: proxy reached WARM (held first call about to be flushed)"
else
    ko "F1.4: proxy never reached WARM"
fi
if wait_for "$PROXY_OUT" '"id":2' 8000; then
    ok "F1.1: first tools/call id=2 answered after WARM (held → flushed, no first-call stall)"
else
    ko "F1.1: no id=2 response — proxy never flushed the held call"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "F1.1b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "F1.1b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if wait_for "$TMPDIR/npx.log" '"id":2' 4000; then
    ok "F1.2: held id=2 flushed to npx after WARM (hold → flush, not a hint)"
else
    ko "F1.2: id=2 never reached npx (hold broke the flush)"
fi
wait_for_stable "$START_COUNTER" 2000   # SEE-1342 D4
SC1=$(count_lines "$START_COUNTER")
if [[ "$SC1" == "1" ]]; then
    ok "F1.3: start invoked exactly once for the cold spawn (count=$SC1)"
else
    ko "F1.3: start count=$SC1 (expected 1)"
fi
send_line "$(call_line 3)"
if wait_for "$PROXY_OUT" '"id":3' 8000; then
    ok "F1.5: follow-up call id=3 answered (forwarded warm path)"
else
    ko "F1.5: no id=3 response after warm"
fi
if wait_for "$TMPDIR/npx.log" '"id":3' 4000; then
    ok "F1.6: id=3 forwarded to npx (real call after warm)"
else
    ko "F1.6: id=3 never reached npx"
fi

# F2 — kill the proxy's npx child. The exit handler sees warm && !shutdown and
# schedules a hot-restart; npxTransportReady is latched false for the window.
NPX_PID=$(pgrep -f "$TMPDIR/mock-npx-stable.mjs" | head -1)
if [[ -n "$NPX_PID" ]]; then
    kill "$NPX_PID" 2>/dev/null || true
    ok "F2.1: proxy npx child killed (pid=$NPX_PID) — transport window opened"
else
    ko "F2.1: no mock-npx child found to kill — cannot open the transport window"
fi
if wait_for "$PROXY_ERR" 'hot-restarting' 4000; then
    ok "F2.2: proxy detected npx death and scheduled a hot-restart"
else
    ko "F2.2: 'hot-restarting' never logged — npx death not handled"
fi

# F3 — send id=4 inside the restart window. The gate must HOLD it: it must NOT
# appear in npx.log now (a forward would be dropped by the dead child — and a
# drop is precisely the "first call timeout" defect).
send_line "$(call_line 4)"
sleep 0.5   # 竞态窗口语义（CLAUDE.md 边界）：断言"重启窗内 id=4 绝不前转"，负向断言须窗已过，窗本身即缺陷 #9 的被测行为
if grep -q '"id":4' "$TMPDIR/npx.log" 2>/dev/null; then
    ko "F3: id=4 forwarded to a dead npx transport (缺陷 #9: drop → client timeout)"
else
    ok "F3: id=4 held in pendingCalls while npx transport down (缺陷 #9 gate)"
fi

# F4 — after the hot-restart, the held call is flushed to the fresh npx + answered.
if wait_for "$PROXY_OUT" '"id":4' 8000; then
    ok "F4.1: held id=4 answered after npx hot-restart (no timeout)"
else
    ko "F4.1: no id=4 response — held call was dropped or never flushed"
fi
if wait_for "$TMPDIR/npx.log" '"id":4' 4000; then
    ok "F4.2: id=4 forwarded to the FRESH npx after restart (flushed, not rejected)"
else
    ko "F4.2: id=4 never reached the fresh npx — call lost"
fi

# F5 — the fresh npx is a NEW process (the restart actually happened), and a
# follow-up call id=5 is also forwarded+answered on the fresh transport.
NPX2=$(pgrep -f "$TMPDIR/mock-npx-stable.mjs" | head -1)
if [[ -n "$NPX2" && "$NPX2" != "$NPX_PID" ]]; then
    ok "F5.1: fresh npx pid=$NPX2 (restart replaced the dead child)"
else
    ko "F5.1: no fresh npx process (pid=$NPX2)"
fi
send_line "$(call_line 5)"
if wait_for "$PROXY_OUT" '"id":5' 8000; then
    ok "F5.2: follow-up call id=5 answered on the fresh transport"
else
    ko "F5.2: no id=5 response after the npx restart"
fi
if wait_for "$TMPDIR/npx.log" '"id":5' 4000; then
    ok "F5.3: id=5 forwarded to the fresh npx"
else
    ko "F5.3: id=5 never reached the fresh npx"
fi

stop_proxy
summary
