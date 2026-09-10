#!/usr/bin/env bash
# test_see1085_t8_direct_node.sh
#
# SEE-1085 B1 usability — T8 direct-node launch integration, with SEE-1111
# hold-to-warm.
#
# The resolver (T7 unit-tested) can pick `node <bin>` to skip npx's ~2.9s cold
# overhead. This test exercises the proxy INTEGRATION: with KOL_GODOT_MCP_CMD
# pointed at a mock bin, the proxy spawns `node <mock-bin>` (NOT npx), the
# godot-mcp child answers initialize/tools-call normally, and the proxy logs
# the direct-node provenance. Overrides the helper's default KOL_GODOT_MCP_CMD=npx
# (later env assignment wins in `env`).
#
# SEE-1111 hold-to-warm adaptation: the FIRST tools/call (id=2) triggers the
# hot-reuse path and is HELD in the FIFO until WARM, then flushed to the direct
# node child and answered (direct-node-ok). No warmup hint is emitted — the
# call waits out the warm and succeeds directly. id=3 is a clean post-warm call.
#
# Assertions:
#   T8.1  proxy stderr logs the direct-node source (not npx-fallback).
#   T8.2  the mock bin was exec'd as `node <path>` (argv marker), proving npx
#         was bypassed entirely.
#   T8.3  initialize is answered (id=1 result).
#   T8.0  the first tools/call id=2 is HELD while warming, then flushed to the
#         child after WARM and answered (direct-node-ok) — no warmup-hint text.
#   T8.4  a subsequent post-warm tools/call id=3 is answered — full handshake
#         over direct node.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1085_t8_direct_node.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)
MARKER="$TMPDIR/argv.marker"; : > "$MARKER"

# Mock bin: writes its argv to MARKER (so we can prove it ran as node, not npx),
# answers initialize + tools/call. Standalone — does not rely on the helper's
# mock-npx-stable.mjs (which the npx wrapper would exec; we bypass npx here).
MOCK_BIN="$TMPDIR/mock-bin.js"
cat > "$MOCK_BIN" <<EOF
import * as readline from 'node:readline';
import { appendFileSync } from 'node:fs';
appendFileSync('$MARKER', process.argv.join('\\n') + '\\n---\\n');
const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { name: 'mock-direct-node', protocolVersion: '2024-11-05', capabilities: {} } }) + '\\n');
        } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: 'direct-node-ok' }] } }) + '\\n');
        }
    } catch (e) {}
});
EOF

# Port listening → warm reuse, so tools/call is forwarded to the godot-mcp child
# (the mock bin) and answered immediately.
start_listener "$PORT" >/dev/null

sep "T8: KOL_GODOT_MCP_CMD=<bin> → proxy spawns node <bin>, bypassing npx"
# NOTE: KOL_GODOT_MCP_CMD here OVERRIDES the helper's default '=npx' (later wins).
start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_GODOT_MCP_CMD=$MOCK_BIN" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=5000" \
    "KOL_PROBE_INTERVAL_MS=200"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 3000 || ko "T8.pre: initialize not answered"

# T8.0 — the first tools/call id=2 is HELD while the hot-reuse path warms
# (hold-to-warm, SEE-1111 目标1), then flushed to the direct-node child after
# WARM and answered — no warmup-hint text anywhere.
send_line "$(call_line 2)"
wait_for "$PROXY_ERR" 'warm detected' 8000 || ko "T8.pre: proxy never reached WARM"
if wait_for "$PROXY_OUT" '"id":2' 8000; then
    ok "T8.0a: first tools/call id=2 answered after WARM (held then flushed to the child)"
else
    ko "T8.0a: no id=2 response after WARM (hold broke the flush)"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "T8.0b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "T8.0b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if grep -q '"id":2' "$PROXY_OUT" && grep -q 'direct-node-ok' "$PROXY_OUT"; then
    ok "T8.0c: id=2 answered by the child after WARM (flushed from the hold FIFO)"
else
    ko "T8.0c: id=2 never reached the child (hold broke the flush)"
fi

# T8.1: proxy logged the direct-node provenance.
if grep -q "launching godot-mcp via node $MOCK_BIN" "$PROXY_ERR"; then
    ok "T8.1: proxy stderr logs direct-node source (node $MOCK_BIN)"
else
    ko "T8.1: proxy did not log direct-node source (got: $(grep 'launching godot-mcp' "$PROXY_ERR" | head -1))"
fi

# T8.2: mock bin was exec'd as `node <path>` (MOCK_BIN appears in argv, as
# argv[1]), proving npx was bypassed. argv[0] is the node binary itself.
if [[ -s "$MARKER" ]] && grep -q "$MOCK_BIN" "$MARKER"; then
    ok "T8.2: child exec'd as node <mock-bin> ($MOCK_BIN in argv) — npx bypassed"
else
    ko "T8.2: child argv marker missing MOCK_BIN (marker: $(cat "$MARKER" 2>/dev/null))"
fi
if grep -q 'npx' "$MARKER"; then
    ko "T8.2b: npx appeared in child argv (direct node did NOT bypass npx)"
else
    ok "T8.2b: no 'npx' in child argv"
fi

# T8.3: initialize answered with a result.
if grep -q '"id":1' "$PROXY_OUT" && grep -q 'mock-direct-node' "$PROXY_OUT"; then
    ok "T8.3: initialize answered (serverInfo=mock-direct-node)"
else
    ko "T8.3: initialize not answered over direct-node child"
fi

# T8.4: a subsequent post-warm tools/call id=3 is forwarded to the direct-node
# child and answered with a result — full handshake over direct node.
send_line "$(call_line 3)"
if wait_for "$PROXY_OUT" '"id":3' 8000; then
    ok "T8.4a: post-warm tools/call id=3 answered"
else
    ko "T8.4a: no id=3 response after warm"
fi
if grep -q '"id":3' "$PROXY_OUT" && grep -q 'direct-node-ok' "$PROXY_OUT"; then
    ok "T8.4b: id=3 answered (direct-node-ok) — full handshake over direct node"
else
    ko "T8.4b: id=3 not answered over direct-node child"
fi

stop_proxy
summary
