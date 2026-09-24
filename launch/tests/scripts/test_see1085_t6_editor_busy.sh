#!/usr/bin/env bash
# test_see1085_t6_editor_busy.sh
#
# SEE-1085 B1 usability — T6 concurrent-competition diagnostics, with SEE-1111
# 预热提示.
#
# Scenario: the editor is WARM (port listening) but a concurrent client holds
# the addon's single WebSocket slot. npx godot-mcp cannot connect and returns a
# tools/call error: "Not connected to Godot: Another client is already connected"
# (the addon rejects the second WS with close code 4001 / ALREADY_CONNECTED).
# The proxy's npx-stdout forwarder must wrap that bare error with a structured
# editor_busy diagnostic so the agent sees retryable guidance instead of a hard
# failure.
#
# SEE-1111 预热提示 adaptation: with the warmup-hint design, the FIRST tools/call
# (id=2) triggers the hot-reuse path and is answered IMMEDIATELY with the friendly
# warmup hint (warm cannot be true the instant the spawn-trigger branch runs). The
# editor_busy diagnostic assertions move to the FIRST POST-WARM call (id=3), which
# is forwarded to npx and hits the competition-error wrap path.
#
# Test seam: a custom mock-npx (overwrites the helper's stable mock after
# lib_init) answers initialize normally and returns the competition error for
# every tools/call. A TCP listener on GODOT_PORT makes the proxy classify hot
# and flip warm, so the call is forwarded (not buffered) and the error path runs.
# KOL_TAKEOVER_TIMEOUT_MS=0 disables the §1 wait/retry takeover (which would
# otherwise withhold the busy response and race for the slot for 30s) so this
# test asserts the §2 immediate-diagnostic fallback directly.
#
# Assertions:
#   T6.0  the first tools/call id=2 is the IMMEDIATE warmup hint (预热提示 —
#         isError:false, NOT forwarded to npx while the proxy is not yet WARM).
#   T6.1  the first POST-WARM tools/call id=3 gets a response (warm path
#         forwarded it to npx).
#   T6.2  response is an error with code=-32000 (original error preserved).
#   T6.3  error.message carries both the original text AND an editor_busy suffix.
#   T6.4  error.data.warmupDiagnostic.state='editor_busy'.
#   T6.5  warmupDiagnostic.retryable=true.
#   T6.6  warmupDiagnostic.hint names port <PORT> (so the operator knows which
#         agent slot is contended).
#   T6.7  the original "Another client is already connected" text is preserved
#         (nothing swallowed).
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1085_t6_editor_busy.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)

# Custom mock-npx: initialize → server info; tools/call → competition error.
# Overwrites the helper's stable mock (lib_init already wired the npx wrapper to
# exec this path).
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
            // Mirror the real addon+npx surface: WS close 4001 (ALREADY_CONNECTED)
            // rendered as a tools/call error.
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

# Port already listening → ensureEditor probe short-circuits to reuse (no spawn);
# warmupLoop classifies hot and flips warm on the first probe, forwarding the
# buffered tools/call to npx, which returns the competition error.
#
# SEE-1148 P2 sandbox semantics: a bare pre-bound listener (no KOL_RUNTIME_ID,
# no held dir) reads as an unverifiable cross-runtime holder → arbiter 'evict'
# kills the mock before warm. T6 owns the editor_busy wrap contract, not the
# arbiter, so it opts out via KOL_PORT_ARBITER=off (same seam as T2) and proves
# the holder with the e43cdc73 .worktree sidecar pointing at MOCK_WORKTREE.
start_listener "$PORT" >/dev/null
EDITOR_LOG="$TMPDIR/godot-editor-Bachi.log"
printf '%s' "$MOCK_WORKTREE" > "${EDITOR_LOG%.log}.worktree"

sep "T6: concurrent-client competition error → editor_busy diagnostic"
start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "GODOT_EDITOR_LOG_FILE=$EDITOR_LOG" \
    "KOL_PORT_ARBITER=off" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=15000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "KOL_TAKEOVER_TIMEOUT_MS=0" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "T6.pre: initialize not answered"

# T6.0 — the first tools/call id=2 is HELD while the hot-reuse path warms
# (hold-to-warm, SEE-1111 目标1), then flushed to npx after WARM. It hits the
# competition-error wrap path (this test's mock-npx returns the busy error).
send_line "$(call_line 2)"
wait_for "$PROXY_ERR" 'warm detected' 6000 || ko "T6.pre: proxy never reached WARM"
if wait_for "$PROXY_OUT" '"id":2' 10000; then
    ok "T6.0a: held id=2 flushed to npx after WARM and answered (editor_busy path)"
else
    ko "T6.0a: no id=2 response after WARM (hold broke the flush)"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "T6.0b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "T6.0b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if wait_for "$TMPDIR/npx.log" '"id":2' 4000; then
    ok "T6.0c: id=2 forwarded to npx after WARM (flushed from the hold FIFO)"
else
    ko "T6.0c: id=2 never reached npx (hold broke the flush)"
fi

# T6.1 + capture the competition error response — the held id=2 (flushed after
# WARM) hits the editor_busy wrap path in the npx-stdout forwarder.
SNAP="$TMPDIR/t6_snap.out"; cp "$PROXY_OUT" "$SNAP"

# T6.2: original error envelope preserved (code=-32000).
if grep -q '"code": *-32000' "$SNAP"; then
    ok "T6.2: error code=-32000 preserved"
else
    ko "T6.2: error code missing or != -32000"
fi

# T6.3: editor_busy suffix appended to the message.
if grep -q 'editor_busy' "$SNAP" && grep -q 'retryable' "$SNAP"; then
    ok "T6.3: error.message carries editor_busy + retryable suffix"
else
    ko "T6.3: editor_busy/retryable suffix missing from message"
fi

# T6.4: structured warmupDiagnostic.state='editor_busy'.
if grep -q '"state": *"editor_busy"' "$SNAP"; then
    ok "T6.4: data.warmupDiagnostic.state='editor_busy'"
else
    ko "T6.4: warmupDiagnostic.state missing or != 'editor_busy'"
fi

# T6.5: retryable=true inside the diagnostic.
if grep -q '"warmupDiagnostic"' "$SNAP" && grep -q '"retryable": *true' "$SNAP"; then
    ok "T6.5: warmupDiagnostic.retryable=true"
else
    ko "T6.5: retryable=true missing from warmupDiagnostic"
fi

# T6.6: hint names the contended port.
if grep -q "hint" "$SNAP" && grep -q "port $PORT" "$SNAP"; then
    ok "T6.6: hint names the contended port $PORT"
else
    ko "T6.6: hint does not name port $PORT"
fi

# T6.7: original competition text preserved (nothing swallowed).
if grep -q 'Another client is already connected' "$SNAP"; then
    ok "T6.7: original 'Another client is already connected' text preserved"
else
    ko "T6.7: original competition text was swallowed"
fi

stop_proxy
summary
