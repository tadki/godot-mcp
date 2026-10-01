#!/usr/bin/env bash
# test_see1085_t10_takeover_success.sh
#
# SEE-1085 B1 usability — T10 wait/retry takeover (success path), with SEE-1111
# hold-to-warm.
#
# Scenario: the editor is WARM (port listening) and a concurrent same-agent
# session is holding the addon's single WebSocket slot for the first few
# probes. After the holder releases, the proxy's wait/retry takeover MUST
# automatically re-dispatch the withheld tools/call and forward the SUCCESS
# result to Claude — i.e. the agent's tools/call succeeds despite the temporary
# competition. npx holds the WS once it connects, so one winning probe is all
# it takes.
#
# Mock: a stateful mock-npx counts tools/call attempts per id and returns the
# editor_busy competition error for the first BUSY_UNTIL attempts, then a
# success result. BUSY_UNTIL=2 → attempts 1 & 2 busy, attempt 3 success.
#
# SEE-1111 hold-to-warm adaptation: the FIRST tools/call (id=2) triggers the
# hot-reuse path and is HELD in the FIFO until WARM, then flushed to npx. Its
# per-id count starts at attempt 1 (BUSY_UNTIL=2 applies), so id=2 itself
# exercises the takeover: busy attempts are withheld, the call is re-dispatched,
# and attempt 3 wins the slot and succeeds. No warmup hint is emitted.
#
# Timing: KOL_TAKEOVER_TIMEOUT_MS=8000, KOL_TAKEOVER_RETRY_MS=150. Probes fire
# at ~150ms, ~300ms; success arrives on attempt 3 around ~450ms.
#
# Assertions:
#   T10.0  the first tools/call id=2 is HELD while the hot-reuse path warms,
#          then flushed to npx after WARM — no warmup-hint text anywhere.
#   T10.1  id=2 gets a success (result, not error) within budget — the agent's
#          call ultimately succeeds (takeover won).
#   T10.2  the forwarded result carries the mock success text — the real probe
#          response (not the original busy) reaches Claude.
#   T10.3  npx saw >= 3 tools/call attempts for id=2 (initial + >=2 retries) —
#          proves the takeover actually re-dispatch rather than giving up.
#   T10.4  NO editor_busy diagnostic leaked to Claude — busy responses were
#          withheld until the slot was won, so Claude only sees the success.
#   T10.5  no takeover-timeout diagnostic leaked (hint does NOT contain
#          "waiting for takeover — timed out") — the takeover did NOT fail.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1085_t10_takeover_success.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)

# Stateful mock: BUSY_UNTIL controls how many tools/call attempts per id return
# the competition error before flipping to success. All other methods answer
# normally (so initialize flips warm and the warmup handshake completes).
cat > "$TMPDIR/mock-npx-stable.mjs" <<'EOF'
import * as readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const LOG = process.env.MOCK_NPX_LOG || '';
const BUSY_UNTIL = parseInt(process.env.MOCK_BUSY_UNTIL || '2', 10);
const SUCCESS_TEXT = process.env.MOCK_SUCCESS_TEXT || 'takeover-success-payload';
const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
const counts = new Map();
rl.on('line', (line) => {
    if (!line.trim()) return;
    if (LOG) { try { appendFileSync(LOG, line + '\n'); } catch (e) {} }
    try {
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { name: 'mock-godot-mcp', protocolVersion: '2024-11-05', capabilities: {} } }) + '\n');
        } else if (msg.method === 'tools/call') {
            const prev = counts.get(msg.id) || 0;
            const attempt = prev + 1;
            counts.set(msg.id, attempt);
            if (attempt <= BUSY_UNTIL) {
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                    error: { code: -32000,
                        message: 'Not connected to Godot: Another client is already connected (WS close 4001)' } }) + '\n');
            } else {
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                    result: { content: [{ type: 'text', text: SUCCESS_TEXT }] } }) + '\n');
            }
        } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: 'mock-ok' }] } }) + '\n');
        }
    } catch (e) {}
});
EOF

# SEE-1148 P2 sandbox semantics (same seam as T2/T6): opt out of the port
# arbiter and prove the holder with the .worktree sidecar, else the bare
# pre-bound listener reads as a cross-runtime holder → evict → no warm.
start_listener "$PORT" >/dev/null
EDITOR_LOG="$TMPDIR/godot-editor-Bachi.log"
printf '%s' "$MOCK_WORKTREE" > "${EDITOR_LOG%.log}.worktree"

sep "T10: wait/retry takeover — busy for 2 attempts, slot freed on 3rd (success)"
start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "GODOT_EDITOR_LOG_FILE=$EDITOR_LOG" \
    "KOL_PORT_ARBITER=off" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=15000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "KOL_TAKEOVER_TIMEOUT_MS=8000" \
    "KOL_TAKEOVER_RETRY_MS=150" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log" \
    "MOCK_BUSY_UNTIL=2" \
    "MOCK_SUCCESS_TEXT=takeover-success-payload"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "T10.pre: initialize not answered"

# T10.0 — the first tools/call id=2 is HELD while the hot-reuse path warms
# (hold-to-warm, SEE-1111 目标1), then flushed to npx after WARM. Its per-id
# count in the stateful mock starts at attempt 1 (BUSY_UNTIL=2 applies), so
# id=2 itself exercises the takeover: busy attempts are withheld and attempt 3
# wins the slot.
send_line "$(call_line 2)"
wait_for "$PROXY_ERR" 'warm detected' 6000 || ko "T10.pre: proxy never reached WARM"
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "T10.0b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "T10.0b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if wait_for "$TMPDIR/npx.log" '"id":2' 4000; then
    ok "T10.0c: id=2 forwarded to npx after WARM (flushed from the hold FIFO)"
else
    ko "T10.0c: id=2 never reached npx (hold broke the flush)"
fi

# T10.1: success (not error) for id=2 within budget. With retry 150ms × 2 +
# forwarding slack, 3000ms is generous.
if wait_for "$PROXY_OUT" '"id":2.*"result"' 3000; then
    ok "T10.1: first tools/call id=2 produced a SUCCESS result (takeover won)"
else
    ko "T10.1: no success for id=2 within 3s (takeover failed to win)"
fi

# Snapshot once for all later assertions.
sleep 0.2 # let any trailing busy-withholding settle
SNAP="$TMPDIR/t10_snap.out"; cp "$PROXY_OUT" "$SNAP"

# T10.2: forwarded result carries the mock success payload.
if grep -q 'takeover-success-payload' "$SNAP"; then
    ok "T10.2: forwarded result carries the mock success text"
else
    ko "T10.2: forwarded result missing the success payload"
fi

# T10.3: npx saw >= 3 tools/call attempts (initial + 2 retries).
# mock-npx-stable.mjs logs every inbound line; count lines containing id":2
# and "tools/call".
ATTEMPTS=$(grep -c '"id":2.*"tools/call"' "$TMPDIR/npx.log" || echo 0)
if (( ATTEMPTS >= 3 )); then
    ok "T10.3: npx received $ATTEMPTS tools/call attempts for id=2 (initial + retries)"
else
    ko "T10.3: npx saw only $ATTEMPTS attempts for id=2 (expected >=3)"
fi

# T10.4: no editor_busy diagnostic leaked to Claude — busy responses were
# withheld until the slot was won. If any leaked, an error envelope with the
# "retryable" suffix would appear in proxy.out.
if grep -q '"id":2.*"error"' "$SNAP"; then
    ko "T10.4: editor_busy error envelope leaked to Claude for id=2 (busy was not withheld)"
else
    ok "T10.4: no editor_busy error leaked for id=2 (busy responses withheld)"
fi

# T10.5: no takeover-timeout diagnostic leaked — the takeover did NOT fail.
if grep -q 'waiting for takeover — timed out' "$SNAP"; then
    ko "T10.5: takeover-timeout diagnostic leaked (takeover wrongly failed)"
else
    ok "T10.5: no takeover-timeout diagnostic leaked (takeover succeeded)"
fi

stop_proxy
summary