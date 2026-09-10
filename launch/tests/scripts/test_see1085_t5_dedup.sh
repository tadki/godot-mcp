#!/usr/bin/env bash
# test_see1085_t5_dedup.sh
#
# SEE-1085 B1 lazy-load — T5 concurrent dedup, with SEE-1111 hold-to-warm.
#
# Precondition: empty port. Five tools/call are dispatched in rapid succession
# (each <50ms apart, ids 2..6). The proxy must spawn the editor exactly once
# (in-flight promise dedup in triggerEnsureEditor + the warmupLoop's outer loop
# already idling once spawnTriggered is true). With hold-to-warm (SEE-1111
# 目标1), every call that lands while the editor is warming is HELD in the FIFO
# until WARM, then all are flushed to npx in order and answered mock-ok — no
# warmup hint, no stall, and the spawn dedup still guarantees configure+start
# run exactly once.
#
# Assertions (design §10 T5, adapted to hold-to-warm):
#   T5.1  configure invoked exactly once AND start invoked exactly once.
#   T5.2  every warming call (ids 2..6) is HELD, then flushed to npx after WARM
#         and answered — no warmup-hint text anywhere.
#   T5.3  after WARM the retry call id=7 is forwarded to npx and answered.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1085_t5_dedup.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)
CFG_COUNTER="$TMPDIR/cfg.count"
START_COUNTER="$TMPDIR/start.count"
: > "$CFG_COUNTER"; : > "$START_COUNTER"

CFG_SH=$(make_configure_mock "$CFG_COUNTER" 0)
START_SH=$(make_start_mock "$START_COUNTER" 0 1)

sep "T5: dedup — 5 concurrent tools/call ⇒ configure+start exactly once"
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
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "T5.pre: initialize not answered"

# Fire 5 calls in <50ms each. The first flips spawnTriggered; the rest land
# while spawnInFlight is non-null. Each is HELD in the FIFO (hold-to-warm); the
# spawn dedup still runs configure+start exactly once.
for id in 2 3 4 5 6; do
    send_line "$(call_line "$id")"
done

if wait_for "$PROXY_ERR" 'editor spawn launched' 3000; then
    ok "T5.1a: spawn launched (at least once)"
else
    ko "T5.1a: proxy never ran configure+start"
fi

# Every warming call is HELD in the FIFO (hold-to-warm, SEE-1111 目标1), then
# all are flushed to npx after WARM and answered mock-ok. None is answered with
# a warmup hint; the spawn dedup still runs configure+start exactly once.
wait_for "$PROXY_ERR" 'warm detected' 8000 || ko "T5.pre2: proxy never reached WARM"
ANSWERED=0
for id in 2 3 4 5 6; do
    if wait_for "$PROXY_OUT" "\"id\":$id" 3000; then
        ANSWERED=$((ANSWERED+1))
    fi
done
if (( ANSWERED == 5 )); then
    ok "T5.2a: all 5 held calls answered after WARM (flushed from the FIFO)"
else
    ko "T5.2a: only $ANSWERED/5 held calls answered"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "T5.2b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "T5.2b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
FORWARDED=0
for id in 2 3 4 5 6; do
    if grep -q "\"id\":$id" "$TMPDIR/npx.log" 2>/dev/null; then
        FORWARDED=$((FORWARDED+1))
    fi
done
if (( FORWARDED == 5 )); then
    ok "T5.2c: all 5 held calls flushed to npx after WARM (FIFO flush intact)"
else
    ko "T5.2c: only $FORWARDED/5 held calls reached npx (flush broken)"
fi

# Wait long enough that a buggy per-call spawn would have produced extra
# counter writes (each mock call appends a line). WARM was already awaited above.
sleep 0.3

CFG_COUNT=$(count_lines "$CFG_COUNTER")
START_COUNT=$(count_lines "$START_COUNTER")
if [[ "$CFG_COUNT" == "1" ]]; then
    ok "T5.1b: configure invoked exactly once (count=$CFG_COUNT)"
else
    ko "T5.1b: configure count=$CFG_COUNT (expected 1 — dedup broken)"
fi
if [[ "$START_COUNT" == "1" ]]; then
    ok "T5.1c: start invoked exactly once (count=$START_COUNT)"
else
    ko "T5.1c: start count=$START_COUNT (expected 1 — dedup broken)"
fi

# T5.3 — after WARM the retry call id=7 is forwarded to npx and answered.
send_line "$(call_line 7)"
if wait_for "$PROXY_OUT" '"id":7' 5000; then
    ok "T5.3a: post-warm retry id=7 answered (forwarded path, not a hint)"
else
    ko "T5.3a: no id=7 response after warm"
fi
if wait_for "$TMPDIR/npx.log" '"id":7' 4000; then
    ok "T5.3b: id=7 forwarded to npx after warm (real call)"
else
    ko "T5.3b: id=7 never reached npx after warm"
fi

stop_proxy
summary
