#!/usr/bin/env bash
# test_see1085_t9_editor_gone.sh
#
# SEE-1085 B1 usability — T9 post-warm editor-gone diagnostics, with SEE-1111
# hold-to-warm.
#
# Scenario: the editor was WARM (port listening, a call forwarded) but its
# WebSocket then became unreachable — it crashed, or its SEE-1070 lease
# self-exited without the lease monitor catching the exit line. npx surfaces a
# bare "Not connected to Godot" / "WebSocket closed" error with no "another
# client" marker, so the agent cannot tell it from a config fault and gives up
# instead of retrying. The proxy wraps it as a retryable editor_gone diagnostic.
#
# Test seam: custom mock-npx returns a plain "Not connected to Godot" error for
# tools/call (no competition text, so editor_busy must NOT fire). A TCP listener
# makes the proxy classify hot + flip warm, forwarding the call to npx.
#
# SEE-1111 hold-to-warm adaptation: the FIRST tools/call (id=2) triggers the
# hot-reuse path and is HELD in the FIFO until WARM, then flushed to npx — where
# it hits the editor_gone wrap path. So id=2 itself carries the editor_gone
# diagnostic. No warmup hint is emitted.
#
# Assertions:
#   T9.0  the first tools/call id=2 is HELD while warming, then flushed to npx
#         after WARM and answered with the editor_gone diagnostic — no warmup
#         hint text anywhere.
#   T9.1  the held id=2 produced a response (warm path flushed it to npx).
#   T9.2  error code=-32000 preserved.
#   T9.3  error.message carries an editor_gone + retryable suffix.
#   T9.4  data.warmupDiagnostic.state='editor_gone' (NOT editor_busy).
#   T9.5  retryable=true.
#   T9.6  hint names port <PORT>.
#   T9.7  original "Not connected to Godot" text preserved.
#   T9.8  NOT misclassified as editor_busy (no "another session holds" text).
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1085_t9_editor_gone.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)

# Custom mock-npx: initialize → server info; tools/call → plain unreachable
# error (NO "another client" text, so editor_busy must not fire; editor_gone
# should).
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
                error: { code: -32000, message: 'Not connected to Godot: WebSocket closed' } }) + '\n');
        } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: 'mock-ok' }] } }) + '\n');
        }
    } catch (e) {}
});
EOF

# SEE-1148 P2 sandbox semantics (same seam as T2/T6): the pre-bound bare
# listener needs the arbiter opt-out + .worktree sidecar, else the arbiter
# evicts it as a cross-runtime holder before warm.
start_listener "$PORT" >/dev/null
EDITOR_LOG="$TMPDIR/godot-editor-Bachi.log"
printf '%s' "$MOCK_WORKTREE" > "${EDITOR_LOG%.log}.worktree"

sep "T9: post-warm editor unreachable → editor_gone diagnostic (not editor_busy)"
start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "GODOT_EDITOR_LOG_FILE=$EDITOR_LOG" \
    "KOL_PORT_ARBITER=off" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=15000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "T9.pre: initialize not answered"

# T9.0 — the first tools/call id=2 is HELD while the hot-reuse path warms
# (hold-to-warm, SEE-1111 目标1), then flushed to npx after WARM — where it hits
# the editor_gone wrap path and returns the diagnostic.
send_line "$(call_line 2)"
wait_for "$PROXY_ERR" 'warm detected' 6000 || ko "T9.pre: proxy never reached WARM"
if wait_for "$PROXY_OUT" '"id":2' 10000; then
    ok "T9.0a: first tools/call id=2 answered after WARM (held then flushed to npx)"
else
    ko "T9.0a: no id=2 response after WARM (hold broke the flush)"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "T9.0b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "T9.0b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if wait_for "$TMPDIR/npx.log" '"id":2' 4000; then
    ok "T9.0c: id=2 forwarded to npx after WARM (flushed from the hold FIFO)"
else
    ko "T9.0c: id=2 never reached npx (hold broke the flush)"
fi

# T9.1 + capture the unreachable-error response — the held id=2 (flushed after
# WARM) hits the editor_gone wrap path in the npx-stdout forwarder.
SNAP="$TMPDIR/t9_snap.out"; cp "$PROXY_OUT" "$SNAP"

if grep -q '"code": *-32000' "$SNAP"; then
    ok "T9.2: error code=-32000 preserved"
else
    ko "T9.2: error code missing or != -32000"
fi

if grep -q 'editor_gone' "$SNAP" && grep -q 'retryable' "$SNAP"; then
    ok "T9.3: error.message carries editor_gone + retryable suffix"
else
    ko "T9.3: editor_gone/retryable suffix missing"
fi

if grep -q '"state": *"editor_gone"' "$SNAP"; then
    ok "T9.4: data.warmupDiagnostic.state='editor_gone'"
else
    ko "T9.4: warmupDiagnostic.state missing or != 'editor_gone'"
fi

if grep -q '"warmupDiagnostic"' "$SNAP" && grep -q '"retryable": *true' "$SNAP"; then
    ok "T9.5: warmupDiagnostic.retryable=true"
else
    ko "T9.5: retryable=true missing"
fi

if grep -q "hint" "$SNAP" && grep -q "port $PORT" "$SNAP"; then
    ok "T9.6: hint names the port $PORT"
else
    ko "T9.6: hint does not name port $PORT"
fi

if grep -q 'Not connected to Godot' "$SNAP"; then
    ok "T9.7: original 'Not connected to Godot' text preserved"
else
    ko "T9.7: original text swallowed"
fi

# T9.8: must NOT be misclassified as editor_busy.
if grep -q 'editor_busy' "$SNAP"; then
    ko "T9.8: misclassified as editor_busy (forwarder checked editor_gone before editor_busy, or patterns overlap)"
else
    ok "T9.8: not misclassified as editor_busy (editor_busy precedence is correct)"
fi

stop_proxy
summary
