#!/usr/bin/env bash
# test_see1085_t1_cold_spawn.sh
#
# SEE-1085 B1 lazy-load — T1 golden path (cold spawn), with SEE-1111 hold-to-warm.
#
# Precondition: port empty, no editor. The proxy must answer initialize
# immediately WITHOUT spawning the editor (the whole point of B1: the MCP
# handshake always succeeds, deferring the editor boot to the first
# tools/call). The first tools/call then triggers configure+start exactly
# once, the mock start listener brings the port up, warmupLoop classifies
# cold, and the first tools/call is HELD in the FIFO until WARM (SEE-1111
# hold-to-warm), then flushed to npx and answered. Once the editor is WARM a
# subsequent call is forwarded to npx and its response is forwarded back to
# the agent.
#
# Assertions (design §10 T1, adapted to the hold-to-warm semantics):
#   T1.1  initialize answered < 1.5s (npx up, no spawn yet).
#   T1.2  configure/start counters EMPTY right after initialize (spawn is NOT
#         triggered by initialize/tools-list — only by tools/call).
#   T1.3  first tools/call triggers configure AND start exactly once each.
#   T1.4  proxy reaches WARM within the cold window (tcpOk; renderStable is
#         instant because GODOT_EDITOR_LOG_FILE is unset).
#   T1.5  the first tools/call id=2 is HELD while warming, then flushed to npx
#         and answered after WARM — no warmup-hint text anywhere.
#   T1.6  after WARM the retry id=3 is forwarded to npx and its response
#         appears on proxy stdout.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1085_t1_cold_spawn.sh

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

CFG_SH=$(make_configure_mock "$CFG_COUNTER" 0 "$MOCK_WORKTREE")
START_SH=$(make_start_mock "$START_COUNTER" 0 1)   # spawn=1 → listener on GODOT_PORT

sep "T1: cold spawn — empty port + first tools/call launches editor once"
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
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
if wait_for "$PROXY_OUT" '"id":1' 1500; then
    ok "T1.1: initialize answered < 1.5s (MCP handshake works without the editor)"
else
    ko "T1.1: initialize not answered in 1.5s"
fi

# Spawn must NOT have fired yet (initialize never triggers it).
CFG_AFTER_INIT=$(count_lines "$CFG_COUNTER")
START_AFTER_INIT=$(count_lines "$START_COUNTER")
if [[ "$CFG_AFTER_INIT" == "0" && "$START_AFTER_INIT" == "0" ]]; then
    ok "T1.2: configure/start not invoked by initialize (lazy spawn intact)"
else
    ko "T1.2: initialize triggered spawn (cfg=$CFG_AFTER_INIT start=$START_AFTER_INIT) — lazy load broken"
fi

# First tools/call triggers the spawn.
send_line "$(call_line 2)"

if wait_for "$PROXY_ERR" 'editor spawn launched' 3000; then
    ok "T1.3a: spawn launched after first tools/call"
else
    ko "T1.3a: proxy never ran configure+start after tools/call"
fi
wait_for_stable "$CFG_COUNTER" 2000   # SEE-1342 D4: settle = mtime-stable, not a fixed 0.3s
CFG_COUNT=$(count_lines "$CFG_COUNTER")
START_COUNT=$(count_lines "$START_COUNTER")
if [[ "$CFG_COUNT" == "1" ]]; then
    ok "T1.3b: configure invoked exactly once (count=$CFG_COUNT)"
else
    ko "T1.3b: configure count=$CFG_COUNT (expected 1)"
fi
if [[ "$START_COUNT" == "1" ]]; then
    ok "T1.3c: start invoked exactly once (count=$START_COUNT)"
else
    ko "T1.3c: start count=$START_COUNT (expected 1)"
fi

# T1.5 — the first tools/call is HELD while the editor warms (hold-to-warm,
# SEE-1111 目标1), then flushed to npx and answered mock-ok after WARM. The
# default warmup hint is removed, so no hint text may appear anywhere.
if wait_for "$PROXY_OUT" '"id":2' 8000; then
    ok "T1.5a: first tools/call id=2 answered after WARM (held then flushed)"
else
    ko "T1.5a: no id=2 response — call neither held nor flushed"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "T1.5b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "T1.5b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if wait_for "$TMPDIR/npx.log" '"id":2' 4000; then
    ok "T1.5c: id=2 forwarded to npx after WARM (flushed from the hold FIFO)"
else
    ko "T1.5c: id=2 never reached npx (hold broke the flush)"
fi

# Warm = tcpOk && renderStable. renderStable is instant (no editor log), so
# warm follows the listener binding (the start mock nohup'd it).
if wait_for "$PROXY_ERR" 'warm detected' 8000; then
    ok "T1.4: proxy reached WARM (cold boot path + tcpOk)"
else
    ko "T1.4: proxy never reached WARM"
fi

# T1.6 — after WARM the retry call id=3 is forwarded to npx and answered.
send_line "$(call_line 3)"
if wait_for "$TMPDIR/npx.log" '"id":3' 4000; then
    ok "T1.6a: tools/call id=3 forwarded to npx after warm"
else
    ko "T1.6a: tools/call id=3 never reached npx"
fi
if wait_for "$PROXY_OUT" '"id":3' 4000; then
    ok "T1.6b: response id=3 forwarded back to the agent"
else
    ko "T1.6b: response id=3 missing on proxy stdout"
fi

stop_proxy
summary
