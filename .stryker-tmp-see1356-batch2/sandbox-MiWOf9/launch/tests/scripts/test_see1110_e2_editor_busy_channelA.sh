#!/usr/bin/env bash
# test_see1110_e2_editor_busy_channelA.sh
#
# SEE-1110 §8 E2 — slot contention (editor_busy / WS close 4001), asserted on
# CHANNEL A (response body), with SEE-1111 预热提示.
#
# Scenario: the port's WS single slot is occupied (TCP listener up → proxy
# classifies hot → warm); a concurrent client holds the addon slot, so npx
# godot-mcp returns a tools/call error: "Not connected to Godot: Another client
# is already connected (WS close 4001)". The proxy must wrap that bare error with
# a structured editor_busy diagnostic in error.data.warmupDiagnostic (Channel A).
# KOL_TAKEOVER_TIMEOUT_MS=0 disables the §1 wait/retry takeover so the immediate
# diagnostic path is exercised deterministically.
#
# SEE-1111 hold-to-warm adaptation: the FIRST tools/call (id=2) triggers the
# hot-reuse path and is HELD in the FIFO until WARM, then flushed to npx — where
# it hits the 4001 competition-error wrap path itself. So id=2 carries the
# editor_busy diagnostic. No warmup hint is emitted.
#
# E4 note: every assertion reads proxy stdout only (the response body).
#
# Assertions:
#   E2.0  the first tools/call id=2 is HELD while the hot-reuse path warms
#         (SEE-1111 目标1), then flushed to npx after WARM — no warmup hint.
#   E2.1  the held id=2 gets a response (warm path forwarded it).
#   E2.2  response is an error, code=-32000 (original preserved).
#   E2.3  error.message carries original 4001 text AND editor_busy suffix.
#   E2.4  data.warmupDiagnostic.state == "editor_busy".
#   E2.5  handshakeSubstate == "rejected_4001".
#   E2.6  retryable == true.
#   E2.7  hint names the contended port.
#   E2.8  stage ∈ {WS_HANDSHAKE, MCP_INITIALIZED} (slot held past handshake).
#   E2.9  [A3 adversarial] mock returns a NON-JSON line → forwarded verbatim,
#         proxy does not crash.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1110_e2_editor_busy_channelA.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)

# Custom mock-npx: initialize → server info; tools/call → competition error
# (4001); a second mock answers a NON-JSON line for the A3 adversarial probe.
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
            if (String(msg.id) === '99') {
                // A3 adversarial: non-JSON response line — proxy must forward
                // verbatim and stay alive (never swallow into a parse error).
                process.stdout.write('not-json-garbage-line\n');
            } else {
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                    error: { code: -32000,
                        message: 'Not connected to Godot: Another client is already connected (WS close 4001)' } }) + '\n');
            }
        } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: 'mock-ok' }] } }) + '\n');
        }
    } catch (e) {}
});
EOF

# Port already listening → hot reuse; warm flips on the first probe; the call is
# forwarded (not buffered) and the 4001 error path runs.
# SEE-1148 P2 sandbox semantics (same seam as T2/T6): opt out of the port
# arbiter and prove the holder with the .worktree sidecar, else the bare
# pre-bound listener reads as a cross-runtime holder → evict → no warm.
start_listener "$PORT" >/dev/null
EDITOR_LOG="$TMPDIR/godot-editor-Bachi.log"
printf '%s' "$MOCK_WORKTREE" > "${EDITOR_LOG%.log}.worktree"

sep "E2: slot contention 4001 → editor_busy diagnostic on Channel A"
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
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "E2.pre: initialize not answered"

# E2.0 — the first tools/call id=2 is HELD in the FIFO while the hot-reuse path
# warms (SEE-1111 hold-to-warm 目标1), then flushed to npx after WARM — where it
# hits the 4001 competition-error mock and exercises the editor_busy wrap path
# itself. No warmup hint is emitted.
send_line "$(call_line 2)"
wait_for "$PROXY_ERR" 'warm detected' 6000 || ko "E2.pre: proxy never reached WARM"
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "E2.0b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "E2.0b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if wait_for "$TMPDIR/npx.log" '"id":2' 4000; then
    ok "E2.0c: id=2 forwarded to npx after WARM (flushed from the hold FIFO)"
else
    ko "E2.0c: id=2 never reached npx (hold broke the flush)"
fi

# E2.1 + capture the competition-error response — the held id=2 is flushed on
# WARM, forwarded to npx, and hits the editor_busy wrap path.
if wait_for "$PROXY_OUT" '"id":2' 10000; then
    ok "E2.1: first tools/call id=2 produced a response (warm path forwarded it)"
else
    ko "E2.1: no response id=2 within 10s (call never forwarded)"
fi
SNAP="$TMPDIR/e2_snap.out"; cp "$PROXY_OUT" "$SNAP"

if grep -q '"code": *-32000' "$SNAP"; then
    ok "E2.2: error code=-32000 preserved"
else
    ko "E2.2: error code missing or != -32000"
fi

if grep -q 'editor_busy' "$SNAP" && grep -q 'retryable' "$SNAP" && grep -q 'Another client is already connected' "$SNAP"; then
    ok "E2.3: error.message preserves 4001 text AND carries editor_busy suffix"
else
    ko "E2.3: message lacks editor_busy suffix or swallowed 4001 text"
fi

if grep -q '"state": *"editor_busy"' "$SNAP"; then
    ok "E2.4: warmupDiagnostic.state='editor_busy'"
else
    ko "E2.4: warmupDiagnostic.state missing or != 'editor_busy'"
fi

if grep -q '"handshakeSubstate": *"rejected_4001"' "$SNAP"; then
    ok "E2.5: handshakeSubstate='rejected_4001'"
else
    ko "E2.5: handshakeSubstate missing or != 'rejected_4001'"
fi

if grep -q '"warmupDiagnostic"' "$SNAP" && grep -q '"retryable": *true' "$SNAP"; then
    ok "E2.6: warmupDiagnostic.retryable=true"
else
    ko "E2.6: retryable=true missing from warmupDiagnostic"
fi

if grep -q "hint" "$SNAP" && grep -q "port $PORT" "$SNAP"; then
    ok "E2.7: hint names the contended port $PORT"
else
    ko "E2.7: hint does not name port $PORT"
fi

# stage must reflect the occupied slot: the holder is past WS → WS_HANDSHAKE(5)
# or MCP_INITIALIZED(6). Any earlier stage would misreport the failure mode.
if grep -qE '"stage": *"(WS_HANDSHAKE|MCP_INITIALIZED)"' "$SNAP"; then
    ok "E2.8: stage ∈ {WS_HANDSHAKE, MCP_INITIALIZED}"
else
    ko "E2.8: stage not WS_HANDSHAKE/MCP_INITIALIZED"
fi

# A3 adversarial: a non-JSON response line must be forwarded verbatim, proxy alive.
send_line '{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"get_project_info","arguments":{}}}'
if wait_for "$PROXY_OUT" 'not-json-garbage-line' 4000; then
    ok "E2.9: non-JSON npx line forwarded verbatim (no swallow, no crash)"
else
    ko "E2.9: non-JSON line was swallowed or never forwarded"
fi
if proxy_alive; then
    ok "E2.10: proxy alive after non-JSON input (no crash)"
else
    ko "E2.10: proxy died after non-JSON input"
fi

stop_proxy
summary
