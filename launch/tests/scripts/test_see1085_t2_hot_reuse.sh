#!/usr/bin/env bash
# test_see1085_t2_hot_reuse.sh
#
# SEE-1085 B1 lazy-load — T2 hot reuse, with SEE-1111 预热提示.
#
# Precondition: a TCP listener is already bound to GODOT_PORT before the proxy
# starts (simulates "an editor from a prior run / a concurrent proxy already
# holds this port"). The proxy must classify the call as HOT (port reachable
# at warmup-time probe), short-circuit ensureEditor at the tcpProbe check,
# and NEVER invoke start (the editor is already live). SEE-1091: configure is
# invoked EXACTLY ONCE on the reuse path too — the stop hook sanitizes
# project.godot back to defaults, so a new session MUST re-pin the agent
# port (configure has an idempotent fast path; non-fatal on failure).
#
# With hold-to-warm (SEE-1111 目标1): the first tools/call (id=2) triggers the
# (probe-short-circuited) reuse path and is HELD in the FIFO until the reuse
# path declares WARM, then flushed to npx and answered — no warmup hint. Once
# WARM, the retry id=3 is forwarded to npx and answered.
#
# Assertions (design §10 T2, updated for SEE-1091 + 预热提示):
#   T2.1  warm is reached within HOT_WARMUP_TIMEOUT_MS (15s here).
#   T2.2a configure is invoked EXACTLY ONCE (SEE-1091 hot-reuse port pin).
#   T2.2b start remains at 0 — the probe short-circuit still guarantees
#         zero spawn side effects.
#   T2.2c proxy logs 'skipping spawn (reuse)' (lastSpawnReused=true).
#   T2.3  the first tools/call id=2 is HELD while the proxy is not yet WARM,
#         then flushed to npx and answered — no warmup-hint text.
#   T2.4  after WARM the retry id=3 is forwarded to npx and answered.
#
# SEE-1148 P1/P2 alignment: the port-arbiter decision tree now owns every
# busy-port verdict, and a sandbox holder (no KOL_RUNTIME_ID, no held dir)
# reads as an unverifiable cross-runtime holder → 'evict' → the REAL
# stop-godot-editor.sh kills the mock listener. T2 owns the B1 lazy-load /
# SEE-1091 reuse semantics, so it opts out via the proxy's documented test
# seam KOL_PORT_ARBITER=off (proxy §PORT_ARBITER_ENABLED) and restores the
# legacy SEE-1129 path. The e43cdc73 sidecar-guard fix then requires the
# holder to PROVE it serves this slot's worktree: we pre-write the .worktree
# sidecar (derived from GODOT_EDITOR_LOG_FILE) pointing at MOCK_WORKTREE.
# Setting GODOT_EDITOR_LOG_FILE also enables the render-stable sampler
# (~4s to flip on an empty log), so the hot warmup budget is 15s.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1085_t2_hot_reuse.sh

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
START_SH=$(make_start_mock "$START_COUNTER" 0 1)   # present but unused in T2

sep "T2: hot reuse — port already listening ⇒ no spawn"
# Listener FIRST (simulates an editor already online on this port).
LIS_PID=$(start_listener "$PORT")
note "pre-bound TCP listener on $PORT (pid=$LIS_PID)"

# e43cdc73 sidecar-guard: the legacy reuse path reads the holder's .worktree
# sidecar (mirroring GODOT_EDITOR_LOG_FILE's basename) and reuses only when it
# names THIS slot's worktree. GODOT_EDITOR_LOG_FILE stays EMPTY — the file
# never appears — so renderStable's sampler just times out into its TCP-probe
# fallback (proxy §RENDER_STABLE_TIMEOUT_MS) and warm still follows the WS
# handshake; the lease monitor is a no-op on an unreadable log.
EDITOR_LOG="$TMPDIR/godot-editor-Bachi.log"
printf '%s' "$MOCK_WORKTREE" > "${EDITOR_LOG%.log}.worktree"

start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "GODOT_EDITOR_LOG_FILE=$EDITOR_LOG" \
    "KOL_PORT_ARBITER=off" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG_COUNTER" \
    "KOL_START_COUNTER=$START_COUNTER" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=15000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "T2.pre: initialize not answered"

send_line "$(call_line 2)"

# The trigger call is HELD while the reuse path flips WARM (hold-to-warm,
# SEE-1111 目标1), then flushed to npx and answered mock-ok. No hint text.
if wait_for "$PROXY_OUT" '"id":2' 6000; then
    ok "T2.3a: first tools/call id=2 answered after the reuse path warmed (held then flushed)"
else
    ko "T2.3a: no id=2 response on the reuse path"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "T2.3b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "T2.3b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if wait_for "$TMPDIR/npx.log" '"id":2' 4000; then
    ok "T2.3c: id=2 forwarded to npx after WARM (flushed from the hold FIFO)"
else
    ko "T2.3c: id=2 never reached npx (hold broke the flush)"
fi

if wait_for "$PROXY_ERR" 'warm detected' 6000; then
    ok "T2.1: proxy reached WARM within hot timeout (reused the pre-bound port)"
else
    ko "T2.1: proxy never reached WARM with port already listening"
fi

wait_for_stable "$CFG_COUNTER" 2000   # SEE-1342 D4
CFG_COUNT=$(count_lines "$CFG_COUNTER")
START_COUNT=$(count_lines "$START_COUNTER")
if [[ "$CFG_COUNT" == "1" ]]; then
    ok "T2.2a: configure invoked EXACTLY once on hot reuse (SEE-1091 port re-pin; cfg=$CFG_COUNT)"
else
    ko "T2.2a: expected configure invoked exactly once on hot reuse, got cfg=$CFG_COUNT"
fi
if [[ "$START_COUNT" == "0" ]]; then
    ok "T2.2b: start NOT invoked (probe short-circuit; start=$START_COUNT)"
else
    ko "T2.2b: start was invoked despite hot reuse (start=$START_COUNT)"
fi

# Also confirm lastSpawnReused was set + a hint WOULD appear in warmupDiagnostic
# if we got stuck (defensive — this is the §6.3 orphan hint path).
if grep -q 'skipping spawn (reuse)' "$PROXY_ERR"; then
    ok "T2.2c: proxy logged 'skipping spawn (reuse)' (lastSpawnReused=true)"
else
    ko "T2.2c: proxy did not log the reuse short-circuit"
fi

# T2.4 — after WARM the retry call id=3 is forwarded to npx and answered.
send_line "$(call_line 3)"
if wait_for "$PROXY_OUT" '"id":3' 5000; then
    ok "T2.4a: post-warm retry id=3 answered (forwarded path, not a hint)"
else
    ko "T2.4a: no id=3 response after warm"
fi
if wait_for "$TMPDIR/npx.log" '"id":3' 4000; then
    ok "T2.4b: id=3 forwarded to npx after warm (real call on the reused port)"
else
    ko "T2.4b: id=3 never reached npx after warm"
fi

stop_proxy
summary
