#!/usr/bin/env bash
# test_see1085_t11_takeover_timeout.sh
#
# SEE-1085 B1 usability — T11 wait/retry takeover (timeout path), with SEE-1111
# hold-to-warm.
#
# Scenario: the editor is WARM (port listening) and a concurrent same-agent
# session holds the addon's single WebSocket slot and NEVER releases it within
# the takeover deadline. The proxy must keep retrying on a backoff and, once the
# deadline passes, return a clear retryable editor_busy diagnostic that tells the
# agent the failure is transient (waiting for takeover) — NOT a permanent dead
# editor.
#
# Mock: always returns the editor_busy competition error for every tools/call
# (BUSY_UNTIL very high). The proxy should retry several times before giving up.
#
# SEE-1111 hold-to-warm adaptation: the FIRST tools/call (id=2) triggers the
# hot-reuse path and is HELD in the FIFO until WARM, then flushed to npx — where
# it hits the always-busy mock and runs the takeover wait/retry until the
# deadline fails all waiters. So id=2 itself carries the editor_busy timeout
# diagnostic. No warmup hint is emitted.
#
# Timing: KOL_TAKEOVER_TIMEOUT_MS=600, KOL_TAKEOVER_RETRY_MS=150. Probes fire at
# ~150ms, ~300ms, ~450ms; deadline at ~600ms fails all waiters.
#
# Assertions:
#   T11.0  the first tools/call id=2 is HELD while warming, then flushed to npx
#          after WARM — no warmup-hint text anywhere.
#   T11.1  after the deadline, an editor_busy error envelope arrives for id=2 —
#          the takeover gave up (did not hang forever).
#   T11.2  the diagnostic hint contains "waiting for takeover" — so the agent
#          knows it is a transient competition, not a dead editor.
#   T11.3  warmupDiagnostic.retryable=true (and state='editor_busy').
#   T11.4  npx saw >= 2 attempts for id=2 (initial + >=1 retry) — proves the
#          wait/retry actually ran before the timeout diagnostic fired.
#   T11.5  the response arrived AFTER the deadline window — the proxy waited,
#          it did not fail immediately (no sub-100ms failure).
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1085_t11_takeover_timeout.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)

# Always-busy mock: every tools/call returns the competition error. initialize
# answers normally so the warmup handshake completes and the warm path forwards
# the call (where the takeover machinery lives).
cat > "$TMPDIR/mock-npx-stable.mjs" <<'EOF'
import * as readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const LOG = process.env.MOCK_NPX_LOG || '';
const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
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
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                error: { code: -32000,
                    message: 'Not connected to Godot: Another client is already connected (WS close 4001)' } }) + '\n');
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

sep "T11: wait/retry takeover — holder never releases → timeout diagnostic"
start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "GODOT_EDITOR_LOG_FILE=$EDITOR_LOG" \
    "KOL_PORT_ARBITER=off" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=15000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "KOL_TAKEOVER_TIMEOUT_MS=600" \
    "KOL_TAKEOVER_RETRY_MS=150" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "T11.pre: initialize not answered"

# T11.0 — the first tools/call id=2 is HELD while the hot-reuse path warms
# (hold-to-warm, SEE-1111 目标1), then flushed to npx after WARM — where it hits
# the always-busy mock and runs the takeover wait/retry until the deadline.
send_line "$(call_line 2)"
wait_for "$PROXY_ERR" 'warm detected' 6000 || ko "T11.pre: proxy never reached WARM"
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "T11.0b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "T11.0b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if wait_for "$TMPDIR/npx.log" '"id":2' 4000; then
    ok "T11.0c: id=2 forwarded to npx after WARM (flushed from the hold FIFO)"
else
    ko "T11.0c: id=2 never reached npx (hold broke the flush)"
fi

START_MS=$(($(date +%s%N) / 1000000))

# T11.1: editor_busy error envelope for id=2 arrives within a budget that
# comfortably exceeds the 600ms deadline (3000ms) — the takeover must give up,
# not hang forever.
if wait_for "$PROXY_OUT" '"id":2.*"error"' 3000; then
    ok "T11.1: editor_busy error returned for id=2 after takeover timeout"
else
    ko "T11.1: no editor_busy error for id=2 within 3s (takeover hung)"
fi
END_MS=$(($(date +%s%N) / 1000000))
ELAPSED=$((END_MS - START_MS))

sleep 0.1 # let the diagnostic body flush
SNAP="$TMPDIR/t11_snap.out"; cp "$PROXY_OUT" "$SNAP"

# T11.2: hint contains "waiting for takeover".
if grep -q 'waiting for takeover' "$SNAP"; then
    ok "T11.2: diagnostic hint says 'waiting for takeover' (transient, not dead)"
else
    ko "T11.2: 'waiting for takeover' missing from hint"
fi

# T11.3: retryable=true and state='editor_busy'.
if grep -q '"state": *"editor_busy"' "$SNAP" && grep -q '"retryable": *true' "$SNAP"; then
    ok "T11.3: warmupDiagnostic state=editor_busy retryable=true"
else
    ko "T11.3: state/retryable missing or wrong"
fi

# T11.4: npx saw >= 2 attempts for id=2 (initial + >=1 retry before timeout).
ATTEMPTS=$(grep -c '"id":2.*"tools/call"' "$TMPDIR/npx.log" || echo 0)
if (( ATTEMPTS >= 2 )); then
    ok "T11.4: npx received $ATTEMPTS tools/call attempts for id=2 (initial + retries)"
else
    ko "T11.4: npx saw only $ATTEMPTS attempts for id=2 (expected >=2)"
fi

# T11.5: the response came AFTER the retry window had time to run — i.e. the
# proxy waited and retried, it did not fail immediately. With RETRY=150ms, a
# real wait takes >= ~150ms; an immediate fail would be sub-100ms.
if (( ELAPSED >= 150 )); then
    ok "T11.5: response took ${ELAPSED}ms (proxy waited/retried, not immediate fail)"
else
    ko "T11.5: response took only ${ELAPSED}ms (no wait/retry happened)"
fi

stop_proxy
summary