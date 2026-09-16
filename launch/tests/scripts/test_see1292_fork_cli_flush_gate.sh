#!/usr/bin/env bash
# test_see1292_fork_cli_flush_gate.sh
#
# SEE-1292 AC-DECPL-010 regression — first tools/call must NOT be flushed to the
# fork CLI before the CLI's WS connect to the editor completes ("Connected to
# Godot" on the CLI's stderr). The pre-fix proxy used a stale path probe
# (args.includes('forks/godot-mcp')) that broke when SEE-1273 T2 moved the fork
# CLI to <submodule>/server/dist/cli.js (no 'forks/' segment). With the probe
# broken, cliConnectSignalExpected() returned false on the production chain and
# the warm flush skipped the CLI-connected wait — the call reached the fork CLI
# while its WS connect was still racing the editor's cold boot, and the CLI
# answered "Not connected to Godot" (the ETIMEDOUT last-error surfaced in
# SEE-1288 R5 / SEE-1297 R5).
#
# This test drives the proxy with GODOT_MCP_FORK_CLI pointed at a MOCK fork CLI
# that (a) answers JSON-RPC on stdio like the real fork, and (b) emits
# "Connected to Godot" on stderr only AFTER the mock editor's WS port is up
# (simulating the real CLI's WS connect completing after the editor warms).
# The mock editor's WS listener completes real WebSocket handshakes (the
# proxy's wsProbe is a real handshake — SEE-1111 缺陷 #6).
#
# Asserts:
#   G1.0  cliConnectSignalExpected() sees the fork CLI (GODOT_MCP_FORK_CLI
#         override matches the resolved args) — the gate is ACTIVE.
#   G1.1  first tools/call HELD while the editor is warming (no early flush,
#         no warmup hint).
#   G1.2  editor warm (mock listener bound) BUT the CLI has NOT yet logged
#         "Connected to Godot" — the held call MUST still be held (the gate
#         requires the CLI's connect signal, not just editor warmth).
#   G1.3  after the CLI's "Connected to Godot" lands, the held call is flushed
#         and answered with the real result.
#   G1.4  the answer carries the one-shot warmup timeline echo (post-warm path).
#
# Run: bash launch/tests/scripts/test_see1292_fork_cli_flush_gate.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)
EDITOR_LOG="$TMPDIR/editor.log"; : > "$EDITOR_LOG"
CFG="$TMPDIR/cfg.count"; START="$TMPDIR/start.count"
: > "$CFG"; : > "$START"
CFG_SH=$(make_configure_mock "$CFG" 0)
START_SH=$(make_start_mock "$START" 0 1)             # spawn=1 → WS listener on GODOT_PORT

# Mock fork CLI: answers JSON-RPC on stdio (like mock-npx-stable.mjs) AND emits
# "Connected to Godot" on stderr after the editor's WS port is confirmed up
# (simulating the real fork CLI's WS connect completing against the warm
# editor). The delay is keyed on the editor log so the test controls the order:
# listener bound (proxy warm) BEFORE the CLI's connect signal lands.
MOCK_FORK_CLI="$TMPDIR/mock-fork-cli.mjs"
cat > "$MOCK_FORK_CLI" <<'EOF'
import * as readline from 'node:readline';
import { appendFileSync, readFileSync, watchFile } from 'node:fs';
const LOG = process.env.MOCK_NPX_LOG || '';
const EDITOR_LOG = process.env.MOCK_EDITOR_LOG || '';
// Simulate the real fork CLI: connect to the editor only after its WS port is
// confirmed up (editor log carries the listening line). Then emit the exact
// stderr line the proxy's flush gate waits for.
let announced = false;
function announce() {
    if (announced) return;
    announced = true;
    process.stderr.write('[godot-mcp] Connected to Godot\n');
}
if (EDITOR_LOG) {
    const check = () => {
        try {
            const content = readFileSync(EDITOR_LOG, 'utf8');
            if (content.includes('Server listening') && content.includes('WebSocket handshake complete')) {
                // Small delay so the proxy's warm detection lands BEFORE the
                // CLI's connect signal — the gate must hold the call in this gap.
                setTimeout(announce, 300);
            }
        } catch { /* not yet */ }
    };
    watchFile(EDITOR_LOG, { interval: 100 }, check);
    check();
} else {
    setTimeout(announce, 2000);
}
const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    if (LOG) { try { appendFileSync(LOG, line + '\n'); } catch (e) {} }
    try {
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { name: 'mock-fork-cli', protocolVersion: '2024-11-05', capabilities: {} } }) + '\n');
        } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: 'mock-fork-ok' }] } }) + '\n');
        }
    } catch (e) {}
});
EOF
chmod +x "$MOCK_FORK_CLI"

sep "SEE-1292 AC-DECPL-010: fork CLI flush gate waits for 'Connected to Godot'"

start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG" \
    "KOL_START_COUNTER=$START" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=8000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "GODOT_EDITOR_LOG_FILE=$EDITOR_LOG" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log" \
    "MOCK_EDITOR_LOG=$EDITOR_LOG" \
    `# SEE-1292: point the proxy at the MOCK fork CLI via the env override —` \
    `# the resolver treats this as the fork (spawns node <path>) and the` \
    `# proxy's cliConnectSignalExpected() must see it as the fork.` \
    "GODOT_MCP_FORK_CLI=$MOCK_FORK_CLI" \
    "GODOT_MCP_GODOT_MCP_CMD=$MOCK_FORK_CLI"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "G1.pre: initialize not answered"

# G1.0 — the proxy must resolve to the mock fork CLI and log the provenance.
# The resolver logs "launching godot-mcp via node <path> (GODOT_MCP_GODOT_MCP_CMD)"
# when the override is honored. If this is missing the gate detection is moot.
if wait_for "$PROXY_ERR" 'launching godot-mcp via' 3000; then
    ok "G1.0: proxy resolved the CLI (provenance logged)"
else
    ko "G1.0: proxy never logged CLI provenance"
fi

# G1.1 — first tools/call while the editor is warming: HELD, no hint, no
# early forward to the CLI.
send_line "$(call_line 2)"
if wait_for "$PROXY_ERR" 'editor spawn launched' 3000; then
    ok "G1.1a: spawn triggered by first tools/call"
else
    ko "G1.1a: editor spawn never launched"
fi
sleep 1.5
if grep -q '"id":2' "$PROXY_OUT"; then
    ko "G1.1b: id=2 answered BEFORE warm (premature — must be held until the gate opens)"
else
    ok "G1.1b: id=2 held while the editor is cold (no early answer)"
fi
if grep -q '"id":2' "$TMPDIR/npx.log" 2>/dev/null; then
    ko "G1.1c: id=2 was forwarded to the CLI while cold (premature flush)"
else
    ok "G1.1c: id=2 NOT forwarded to the CLI while cold — held in the FIFO"
fi

# G1.2 — editor warm (milestones appended) BUT the mock CLI's "Connected to
# Godot" is delayed by ~300ms past the handshake milestone. The held call MUST
# still be held in that gap (the gate requires the CLI connect signal, not just
# editor warmth). This is the regression window: pre-fix the flush fired at WARM
# and the call hit the CLI's not-yet-connected WS → "Not connected to Godot".
echo "[godot-mcp] Server listening on 127.0.0.1:$PORT [test]" >> "$EDITOR_LOG"
echo "[godot-mcp] WebSocket handshake complete" >> "$EDITOR_LOG"
if wait_for "$PROXY_ERR" 'warm detected' 12000; then
    ok "G1.2a: proxy reached WARM after the milestones"
else
    ko "G1.2a: proxy never logged warm detected"
fi
# The warm-detected line lands BEFORE the mock CLI's delayed "Connected to
# Godot". Assert the held call is still held at this point (no answer, no
# forward) — the pre-fix bug flushed here.
if grep -q '"id":2' "$PROXY_OUT"; then
    ko "G1.2b: id=2 answered at WARM before the CLI connected (premature flush — the SEE-1292 regression)"
else
    ok "G1.2b: id=2 still held at WARM (gate waits for the CLI connect signal)"
fi
if grep -q '"id":2' "$TMPDIR/npx.log" 2>/dev/null; then
    ko "G1.2c: id=2 forwarded to the CLI at WARM before the CLI connected (premature flush — the SEE-1292 regression)"
else
    ok "G1.2c: id=2 NOT forwarded at WARM (gate waits for the CLI connect signal)"
fi

# G1.3 — the mock CLI's "Connected to Godot" lands (~300ms after the handshake
# milestone). The gate opens; the held call is flushed and answered with the
# real result.
if wait_for "$PROXY_ERR" 'NPX_CLI_CONNECTED' 8000; then
    ok "G1.3a: proxy observed the CLI's 'Connected to Godot'"
else
    ko "G1.3a: proxy never observed the CLI connect"
fi
if wait_for "$PROXY_OUT" '"id":2' 8000; then
    ok "G1.3b: held id=2 answered after the CLI connected (real result, not a hint)"
else
    ko "G1.3b: no id=2 response after the CLI connected (flush broke)"
fi
if wait_for "$TMPDIR/npx.log" '"id":2' 4000; then
    ok "G1.3c: id=2 forwarded to the CLI after it connected (flushed from the FIFO)"
else
    ko "G1.3c: id=2 never reached the CLI (flush broke)"
fi

# G1.4 — the answer carries the one-shot warmup timeline echo.
sleep 0.3
TL=$(grep -o '\[godot-mcp warmup [^]]*\]' "$PROXY_OUT" | tail -1)
if [[ -n "$TL" ]]; then
    note "timeline: $TL"
    ok "G1.4: warmup timeline echo present on the first post-warm response"
else
    ko "G1.4: no warmup timeline echo in the post-warm response"
fi

stop_proxy
summary
