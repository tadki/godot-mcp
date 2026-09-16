#!/usr/bin/env bash
# test_see1117_cold_reuse_cli_gate.sh
#
# SEE-1117 regression (Atlas code review, REQUEST CHANGES) — the hot-reuse
# flush leak on the `if (warm)` branch.
#
# Background: the line-1993 gateOpen-path flush was fixed to require
# `npxCliConnected` on the fork CLI path. But the NEXT loop iteration enters
# the `if (warm)` branch (line ~1886), whose flush condition still carried
# `lastSpawnReused` as a standalone trigger — bypassing the line-1993 hold.
# Fresh auto-checkout + `start-godot-editor.sh` running before the first
# tools/call reproduces exactly this: the port is already bound when the
# first call lands, `lastSpawnReused=true`, but the freshly-spawned npx fork
# CLI has NOT yet emitted 'Connected to Godot'. Pre-fix the call was flushed
# into the still-connecting npx and failed "Not connected to Godot".
#
# This test drives the fork CLI path (`cliConnectSignalExpected()` true via
# GODOT_MCP_FORK_CLI pointing at the mock) with a mock CLI that
# delays its 'Connected to Godot' stderr line, and asserts:
#
#   R.1  pre-warm: the first tools/call (id=2) is HELD, not forwarded to the
#        CLI before 'Connected to Godot'.
#   R.2  after the CLI emits 'Connected to Godot', id=2 is flushed and answered.
#   R.3  (negative) without the fix, the CLI receives id=2 while still
#        unconnected — detectable because the mock logs every inbound line to
#        its marker file as soon as it lands.
#   R.4  the gateOpen path (line 1993) ALSO holds (no early flush), and the
#        `if (warm)` path (line ~1886) holds until the CLI connects.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1117_cold_reuse_cli_gate.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)

# --- Mock fork CLI -----------------------------------------------------------
# Answers initialize + tools/call like the stable mock, but writes
# 'Connected to Godot' to stderr ONLY after a delay (simulating the CLI's
# WS-connect chain still racing the cold boot). Logs every inbound line to
# MOCK_CLI_INBOX so the test can detect premature forwarding.
# SEE-1292 LOW-2: the mock no longer lives under a 'forks/godot-mcp' path —
# cliConnectSignalExpected() now matches via GODOT_MCP_FORK_CLI (set below),
# not a path substring. The mock path is neutral.
MOCK_CLI="$TMPDIR/fork-cli-mock.js"
MOCK_CLI_INBOX="$TMPDIR/cli.inbox"
: > "$MOCK_CLI_INBOX"
# Delay (ms) before the mock emits 'Connected to Godot'. Long enough that the
# warmup loop reaches warm and the pre-fix bug would have flushed id=2.
CLI_CONNECT_DELAY_MS="${KOL_MOCK_CLI_CONNECT_DELAY_MS:-2500}"
cat > "$MOCK_CLI" <<EOF
import * as readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const INBOX = '$MOCK_CLI_INBOX';
const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
// Defer the WS-open signal so the proxy's warmup gate must hold the call.
setTimeout(() => { process.stderr.write('Connected to Godot\n'); }, $CLI_CONNECT_DELAY_MS);
rl.on('line', (line) => {
    if (!line.trim()) return;
    try { appendFileSync(INBOX, line + '\n'); } catch (e) {}
    try {
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { name: 'mock-fork-godot-mcp', protocolVersion: '2024-11-05', capabilities: {} } }) + '\n');
        } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: 'fork-ok' }] } }) + '\n');
        }
    } catch (e) {}
});
EOF
chmod +x "$MOCK_CLI"

CFG="$TMPDIR/cfg.count"; START="$TMPDIR/start.count"
: > "$CFG"; : > "$START"
CFG_SH=$(make_configure_mock "$CFG" 0)
# start mock does NOT spawn a listener — the listener is pre-bound below to
# simulate the fresh auto-checkout where start-godot-editor.sh ran BEFORE the
# first tools/call (so the port is already listening at ensureEditor's tcpProbe).
START_SH=$(make_start_mock "$START" 0 0)

sep "R: cold-reuse fork-CLI gate — held call must wait for CLI 'Connected to Godot'"

# Pre-bind a WS-completing listener on the port (the editor already up).
LIS_PID=$(start_listener "$PORT")
note "pre-bound WS listener on $PORT (pid=$LIS_PID)"

# SEE-1292 LOW-1 (tidy): the pre-bound listener must survive the proxy's
# port-arbiter eviction so the reuse path (not cold-spawn) runs. The arbiter
# sees a bound port with no held-dir record and returns `evict` (dead proxy,
# missing runtime id) — the listener is killed and the editor never warms.
# Fix: disable the arbiter (KOL_PORT_ARBITER=off) so the proxy falls through
# to the legacy SEE-1129 sidecar guard, and plant the sidecar + lease so the
# guard sees "holder is THIS slot's editor" → lastSpawnReused=true.
# The proxy resolves the sidecar from GODOT_EDITOR_LOG_FILE (replacing .log
# with .worktree); we point both at our mock worktree.
EDITOR_LOG="$TMPDIR/editor.log"; : > "$EDITOR_LOG"
echo "$MOCK_WORKTREE" > "${EDITOR_LOG%.log}.worktree"
mkdir -p "$MOCK_WORKTREE/.godot"
cat > "$MOCK_WORKTREE/.godot/mcp-lease.json" <<'EOF'
{"schema_version":2,"state":"active","agent":"Bachi","runtime_id":"see1117-test","port":0}
EOF

# start_proxy with KOL_GODOT_MCP_CMD pointing at the fork-path mock CLI so the
# resolver picks it and cliConnectSignalExpected() returns true. Override the
# helper's KOL_DIRECT_GODOT_MCP=0 default by passing KOL_GODOT_MCP_CMD last
# (later env tokens win in the env(1) list).
# SEE-1292 AC-DECPL-010: cliConnectSignalExpected() now matches the resolved CLI
# path against GODOT_MCP_FORK_CLI (the fork identity), not the stale
# 'forks/godot-mcp' string. The test sets GODOT_MCP_FORK_CLI to the mock so the
# gate activates (the mock DOES emit 'Connected to Godot', like the real fork).
start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG" \
    "KOL_START_COUNTER=$START" \
    "KOL_WARMUP_TIMEOUT_MS=20000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=20000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "KOL_PORT_ARBITER=off" \
    "GODOT_EDITOR_LOG_FILE=$EDITOR_LOG" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log" \
    "GODOT_MCP_FORK_CLI=$MOCK_CLI" \
    "KOL_GODOT_MCP_CMD=$MOCK_CLI"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "R.pre: initialize not answered"

# Confirm the resolver picked the fork-path mock so cliConnectSignalExpected()=true.
# The resolver logs the CANONICAL env name (GODOT_MCP_GODOT_MCP_CMD) even when the
# value arrived via the legacy alias (KOL_GODOT_MCP_CMD) — grep either.
if grep -qE 'GODOT_MCP_GODOT_MCP_CMD|KOL_GODOT_MCP_CMD' "$PROXY_ERR"; then
    ok "R.0: proxy resolved CLI via env override (fork-path mock, cliConnectSignalExpected=true)"
else
    ko "R.0: proxy did NOT log the env override source (cliConnectSignalExpected may be false)"
fi

# Fire the first tools/call. The port is pre-bound -> lastSpawnReused=true, but
# the mock CLI has not yet emitted 'Connected to Godot' (delayed ~2500ms).
send_line "$(call_line 2)"

# R.1/R.3: while the CLI is still unconnected, the call must NOT reach the CLI
# inbox. Wait past the point where the pre-fix bug would have flushed (the
# warm transition happens quickly on a pre-bound WS listener), then check the
# inbox is still empty at ~1.5s (< CLI_CONNECT_DELAY_MS).
sleep 1.5
if [[ -s "$MOCK_CLI_INBOX" ]] && grep -q '"id":2' "$MOCK_CLI_INBOX"; then
    ko "R.1: id=2 reached the CLI BEFORE 'Connected to Godot' (the if(warm) lastSpawnReused leak)"
else
    ok "R.1: id=2 NOT forwarded while CLI still unconnected (gate held)"
fi
if wait_for "$PROXY_OUT" '"id":2' 400; then
    ko "R.3: id=2 answered before the CLI connected (premature flush)"
else
    ok "R.3: id=2 still unanswered before 'Connected to Godot'"
fi

# R.2: after the CLI emits 'Connected to Godot' (~2.5s), the held call flushes
# and is answered with a real result.
if wait_for "$PROXY_OUT" '"id":2' 4000; then
    ok "R.2: id=2 answered after the CLI connected (held then flushed)"
else
    ko "R.2: id=2 never answered after the CLI connected (hold broke the flush)"
fi
if wait_for "$MOCK_CLI_INBOX" '"id":2' 2000; then
    ok "R.4: id=2 forwarded to the CLI only after 'Connected to Godot' (fork path)"
else
    ko "R.4: id=2 never reached the fork CLI after it connected"
fi

# Negative sanity: the fix must not hang a warm flush. The answer above proves
# the flush happened; the inbox proves it reached the CLI. Confirm the warm
# detection log carried the 'CLI connected' wording from the if(warm) branch.
if grep -q 'CLI connected' "$PROXY_ERR"; then
    ok "R.5: warm-flush log reports CLI connected (if(warm) branch honored the gate)"
else
    note "R.5: 'CLI connected' warm log not found (non-fatal; flush already proven by R.2/R.4)"
fi

stop_proxy
summary
