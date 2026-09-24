#!/usr/bin/env bash
# test_see1134_restart_hold.sh
#
# SEE-1134 Q1 — proxy intercepts godot_editor_edit restart, holds the call, and
# answers {restarted:true} only when (a) the old editor's WS port goes cold,
# (b) the relaunched editor's WS port comes back, (c) the CLI reconnects.
# Anything else while the hold is in flight is HELD in the FIFO (no concurrent
# spawn, no flush through a dying port).
#
# The fork CLI consumes the addon's {restarting:true} ack into a fire-and-forget
# TEXT result, so the proxy cannot detect restart by the ack payload. Detection
# is by INBOUND call shape (params.name === 'godot_editor_edit' &&
# params.arguments.action === 'restart').
#
# F1  cold→warm: regular tools/call before any restart warms the editor
#     (npx-mock answers with a normal result, no restart involved).
# F2  restart detection — first restart call:
#       (a) the call id is NOT forwarded to npx-mock as a restart answer
#           (proxy holds it; mock-npx never sees id=10);
#       (b) the held call id=10 is NOT answered immediately (no {"id":10...} in
#           proxy stdout before the old editor's port goes cold + new binds);
#       (c) held restart ack: npx-mock logs id=10 (proxy forwarded to npx so
#           npx-mock can hand back the fire-and-forget text);
#       (d) other tools/call (id=11) arriving during the restart window is
#           HELD in the proxy FIFO (no forwarding to npx);
#       (e) once the relaunched editor is warm + npx-mock reports
#           'Connected to Godot' again, the held restart id=10 is answered with
#           {restarted:true} and the held id=11 is flushed.
# F3  restart fail (no respawn within deadline): restart call answered with
#     {restarted:false, reason:'timeout'} (smaller deadline via env).
# F4  held-call rejection on fail: any other tools/call held during the failed
#     restart is rejected with a retryable diagnostic, NOT silently swallowed.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1134_restart_hold.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

# Build a mock npx that:
#   - answers initialize
#   - answers ALL other id'd calls with a small "mock-ok" text AND logs the
#     'Connected to Godot' / 'Disconnected from Godot' lines so the proxy sets
#     npxCliConnected true/false (the mock npx has no real CLI reconnect — we
#     simulate it by emitting the line on demand, controlled by a side channel).
cat > "$TMPDIR/mock-npx-restart.mjs" <<'EOF'
import * as readline from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';
const LOG = process.env.MOCK_NPX_LOG || '';
const SIG_FILE = process.env.MOCK_NPX_CONNECT_SIG_FILE || '';
const DROP_FLAG = process.env.MOCK_DROP_FLAG || '';
const RESPAWN_FLAG = process.env.MOCK_RESPAWN_FLAG || '';
const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
// Pretend the CLI connected to a live editor right away (so the proxy's WARM
// gate opens and flushes the held tools/call). The "disconnect" branch is
// exercised on restart calls below.
process.stderr.write('Connected to Godot\n');
rl.on('line', (line) => {
    if (!line.trim()) return;
    if (LOG) { try { appendFileSync(LOG, '<<' + line + '\n'); } catch (e) {} }
    try {
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { name: 'mock-restart', protocolVersion: '2024-11-05', capabilities: {} } }) + '\n');
            return;
        }
        // For restart tools/call, mock-npx returns the fire-and-forget TEXT
        // the fork CLI would (the proxy consumes it without forwarding).
        const p = msg.params || {};
        if (p.name === 'godot_editor_edit' && p.arguments && p.arguments.action === 'restart') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: 'Editor is restarting (project saved first). The bridge reconnects automatically in a few seconds - retry your next command then.' }] } }) + '\n');
            // Simulate the editor's WS port dying briefly: pretend disconnected,
            // then re-emit Connected to Godot after the respawn.
            process.stderr.write('Disconnected from Godot\n');
            const reconnectMs = parseInt(process.env.MOCK_RECONNECT_MS || '800', 10);
            // NEVER_RECONNECT_FLAG (side-channel): if it exists at the moment of
            // the next restart call, the mock drops the port but never respawns
            // the CLI reconnect. Used by F3 to exercise the proxy's timeout path.
            const neverFlag = process.env.MOCK_NEVER_RECONNECT_FLAG || '';
            const never = neverFlag && existsSync(neverFlag);
            if (never) { try { appendFileSync(SIG_FILE, 'never-on\n'); } catch (e) {} }
            // Tell the test harness to drop the listener port (via SIGHUP) so
            // driveRestartRespawn sees the port go cold.
            if (DROP_FLAG) { try { appendFileSync(DROP_FLAG, 'd\n'); } catch (e) {} }
            // And re-spawn the listener after a slightly shorter delay so the
            // port comes back up before the CLI reconnect signal fires.
            setTimeout(() => {
                if (RESPAWN_FLAG) { try { appendFileSync(RESPAWN_FLAG, 'r\n'); } catch (e) {} }
            }, Math.max(50, reconnectMs - 100));
            if (!never) {
                setTimeout(() => {
                    process.stderr.write('Connected to Godot\n');
                    if (SIG_FILE) { try { appendFileSync(SIG_FILE, 'reconnected\n'); } catch (e) {} }
                }, reconnectMs);
            }
            return;
        }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: 'mock-ok' }] } }) + '\n');
    } catch (e) {
        if (LOG) { try { appendFileSync(LOG, 'PARSE_ERR ' + e.message + '\n'); } catch (e2) {} }
    }
});
EOF

# The KOL_GODOT_MCP_CMD resolver runs `node <path>` on this script. The path
# MUST be a JS file (the resolver would otherwise fail with "Unexpected
# string"). SEE-1292 AC-DECPL-010: cliConnectSignalExpected() now matches the
# resolved CLI path against GODOT_MCP_FORK_CLI (the fork identity), not the
# stale 'forks/godot-mcp' string — set GODOT_MCP_FORK_CLI to the mock so the
# gate activates (the mock DOES emit 'Connected to Godot', like the real fork).
KOL_GODOT_MCP_CMD_OVERRIDE="$TMPDIR/fork-cli-mock.mjs"
cp "$TMPDIR/mock-npx-restart.mjs" "$KOL_GODOT_MCP_CMD_OVERRIDE"

PORT=$(find_free_port)
EDITOR_LOG="$TMPDIR/editor.log"; : > "$EDITOR_LOG"   # empty → renderStable flips in ~4s
CFG="$TMPDIR/cfg.count"; START="$TMPDIR/start.count"
WS_COUNTER="$TMPDIR/ws.count"
: > "$CFG"; : > "$START"; : > "$WS_COUNTER"
CFG_SH=$(make_configure_mock "$CFG" 0 "$MOCK_WORKTREE")
MOCK_RECONNECT_MS=600

# Custom start mock: spawns the WS-completing mock listener (spawn=1) AND
# reacts to the restart signal by dropping + re-binding the port. The proxy's
# driveRestartRespawn polls the port; we need the port to actually go cold
# briefly so coldFailures counts up.
LISTENER_PID_FILE="$TMPDIR/listener.pid"
DROP_FLAG="$TMPDIR/drop-flag"
RESPAWN_FLAG="$TMPDIR/respawn-flag"
DAEMON_LOG="$TMPDIR/drop-watch.log"
# Initial check: drop-flag must NOT exist at startup so the listener serves
# warmup; the mock creates it during the restart call. Same for respawn-flag
# (otherwise the daemon would think a respawn is pending before one is).
: > "$LISTENER_PID_FILE"; rm -f "$DROP_FLAG" "$RESPAWN_FLAG"

# Background drop-watch daemon: simulates the editor's WS lifecycle across a
# restart. Two phases driven by side-channel flag files the mock-npx writes:
#   DROP_FLAG appears    → kill the live listener (port goes cold, mimicking
#                          the old editor releasing the port as it quits);
#   RESPAWN_FLAG appears → spawn a fresh listener (port rebinds, mimicking the
#                          relaunched editor's WS coming up).
# When $NEVER_FLAG is set, both phases are suppressed → port stays cold
# forever (F3 timeout-path coverage: driveRestartRespawn never sees warm).
#
# Coordination model: the listener ALSO self-drops on DROP_FLAG (its own
# DROP_ON_RESTART_FILE watch), so the daemon tracks liveness by whether the
# recorded PID is still alive, NOT by trusting its own kill ran first. The
# daemon clears LISTENER_PID_FILE whenever it observes the PID is dead (whether
# it killed the listener or the listener self-dropped), which unblocks the
# respawn branch. This avoids the race where the listener's 80ms self-poll
# exits the process before the daemon's kill -HUP lands.
NEVER_FLAG="$TMPDIR/never-flag"
listener_alive() {
    [[ -s "$LISTENER_PID_FILE" ]] || return 1
    local p; p="$(cat "$LISTENER_PID_FILE" 2>/dev/null)"
    [[ -n "$p" ]] || return 1
    kill -0 "$p" 2>/dev/null
}
(
    while true; do
        # Check the never-flag first; if set, suppress BOTH drop and respawn
        # so the proxy times out cleanly.
        if [[ -s "$NEVER_FLAG" ]]; then
            : > "$DROP_FLAG"
            : > "$RESPAWN_FLAG"
            sleep 0.05
            continue
        fi
        # Drop: signal the listener (its SIGHUP handler closes the socket and
        # exits). Either path — daemon kill or listener self-drop — ends with
        # the PID dead; the liveness check below clears the pid file.
        if [[ -s "$DROP_FLAG" ]] && listener_alive; then
            kill -HUP "$(cat "$LISTENER_PID_FILE")" 2>/dev/null || true
            : > "$DROP_FLAG"
        fi
        # Reap: if the recorded listener is gone (self-dropped or killed),
        # clear the pid file so the respawn branch can fire.
        if [[ -s "$LISTENER_PID_FILE" ]] && ! listener_alive; then
            : > "$LISTENER_PID_FILE"
        fi
        # Respawn: only when no listener is currently live.
        if [[ -s "$RESPAWN_FLAG" ]] && ! listener_alive; then
            : > "$RESPAWN_FLAG"
            nohup env "LISTEN_PORT=$PORT" "DROP_ON_RESTART_FILE=$DROP_FLAG" node "$LIB_LISTENER_SCRIPT" </dev/null >/dev/null 2>"$TMPDIR/listener-respawn.err" &
            disown || true
            echo $! > "$LISTENER_PID_FILE"
        fi
        sleep 0.05
    done
) </dev/null >/dev/null 2>&1 &
DROP_WATCH_PID=$!
disown $DROP_WATCH_PID 2>/dev/null || true

START_SH="$TMPDIR/mock-start.sh"
cat > "$START_SH" <<EOF
#!/usr/bin/env bash
echo x >> "\${KOL_START_COUNTER:-$START}"
if [[ -n "\${GODOT_PORT:-}" ]]; then
    nohup env "LISTEN_PORT=\${GODOT_PORT}" "DROP_ON_RESTART_FILE=$DROP_FLAG" node "$LIB_LISTENER_SCRIPT" </dev/null >/dev/null 2>"$TMPDIR/listener-start.err" &
    disown || true
    echo \$! > "$LISTENER_PID_FILE"
fi
exit 0
EOF
chmod +x "$START_SH"

sep "SEE-1134 Q1: restart proxy-hold (port=$PORT, mock-reconnect-ms=$MOCK_RECONNECT_MS)"

start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG" \
    "KOL_START_COUNTER=$START" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=5000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "KOL_WS_PROBE_DISABLE=1" \
    "GODOT_EDITOR_LOG_FILE=$EDITOR_LOG" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log" \
    "GODOT_MCP_FORK_CLI=$KOL_GODOT_MCP_CMD_OVERRIDE" \
    "KOL_GODOT_MCP_CMD=$KOL_GODOT_MCP_CMD_OVERRIDE" \
    "KOL_RESTART_HOLD_TIMEOUT_MS=4000" \
    "MOCK_DROP_FLAG=$DROP_FLAG" \
    "MOCK_RESPAWN_FLAG=$RESPAWN_FLAG" \
    "MOCK_NEVER_RECONNECT_FLAG=$NEVER_FLAG"

# F0 — handshake
send_line "$INIT_LINE"
if wait_for "$PROXY_OUT" '"id":1' 1500; then
    ok "F0: initialize answered immediately"
else
    ko "F0: initialize not answered — proxy/mock chain dead"
    summary
fi

# F1 — warm the editor with a regular tools/call
send_line "$(call_line 2)"
# Open the warmup gate by appending milestone lines to the editor log
# (matches test_see1111_ws_handshake_gate.sh: gateOpen requires
# stageTimestamps.SERVER_LISTENING and .WS_HANDSHAKE to be non-null when
# logTailAvailable=true).
sleep 0.1
echo "[godot-mcp] Server listening on 127.0.0.1:$PORT [test]" >> "$EDITOR_LOG"
echo "[godot-mcp] WebSocket handshake complete [test]" >> "$EDITOR_LOG"
if wait_for "$PROXY_OUT" '"id":2' 5000; then
    ok "F1: warm — regular tools/call id=2 answered (editor warmed via mock listener)"
else
    ko "F1: regular tools/call id=2 not answered in 5s — warm path broken"
    summary
fi

# F2 — restart: send godot_editor_edit restart (id=10)
RESTART_LINE='{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"godot_editor_edit","arguments":{"action":"restart"},"_meta":{"progressToken":"pk-10"}}}'
send_line "$RESTART_LINE"
# Held: the proxy must NOT answer id=10 immediately. Give the mock 200ms grace
# to dispatch the restart to npx and ack; the proxy intercepts the INBOUND
# call shape, forwards to npx (mock answers), then drives driveRestartRespawn.
sleep 0.4

# F2.a — held: id=10 not answered yet (proxy is in restart window)
if grep -q '"id":10' "$PROXY_OUT"; then
    ko "F2.a: held restart id=10 answered too early — proxy must hold until respawn complete"
else
    ok "F2.a: held restart id=10 not answered yet (driveRestartRespawn in flight)"
fi

# F2.b — held: a SECOND tools/call (id=11) arriving during the window is HELD
# in pendingCalls, NOT forwarded to npx. We send it now.
send_line "$(call_line 11)"
sleep 0.3
# id=11 must not appear in proxy stdout yet (still held).
if grep -q '"id":11' "$PROXY_OUT"; then
    ko "F2.b: held id=11 answered too early — proxy must hold all tools/call during restart window"
else
    ok "F2.b: held id=11 NOT forwarded during restart window (no concurrent spawn)"
fi

# F2.c — wait for the restart to complete (mock reconnects in 600ms; proxy
# then answers id=10 and flushes id=11). Budget 4s.
if wait_for "$PROXY_OUT" '"id":10' 4000; then
    ok "F2.c: held restart id=10 answered (restart respawn observed)"
else
    ko "F2.c: held restart id=10 not answered in 4s — driveRestartRespawn broken"
fi

# F2.d — answer payload: must contain {restarted:true} (escaped inside text content)
if grep '"id":10' "$PROXY_OUT" | grep -q '\\"restarted\\":true'; then
    ok "F2.d: restart answer carries {restarted:true}"
else
    ko "F2.d: restart answer did not carry {restarted:true}"
fi

# F2.e — held id=11 must have been flushed (proxy flushed queue after restart)
if wait_for "$PROXY_OUT" '"id":11' 2000; then
    ok "F2.e: held id=11 flushed after restart completed"
else
    ko "F2.e: held id=11 not flushed after restart"
fi

# F3 — restart timeout path: enable NEVER_RECONNECT and send a second restart.
# Mock drops the listener, never reconnects the CLI → proxy must answer
# {restarted:false, reason:'timeout'} after the deadline (4s) and reject
# any held calls with a retryable diagnostic.
touch "$NEVER_FLAG"
sleep 0.2
TIMEOUT_LINE='{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"godot_editor_edit","arguments":{"action":"restart"},"_meta":{"progressToken":"pk-20"}}}'
send_line "$TIMEOUT_LINE"
# Send a held call (id=21) during the never-reconnect window.
send_line "$(call_line 21)"
sleep 0.3

# F3.a — id=20 must NOT be answered yet (proxy is in the never-reconnects window)
if grep -q '"id":20' "$PROXY_OUT"; then
    ko "F3.a: never-reconnect restart id=20 answered too early — proxy must hold until deadline"
else
    ok "F3.a: never-reconnect restart id=20 not answered yet"
fi

# F3.b — wait for the timeout deadline. KOL_RESTART_HOLD_TIMEOUT_MS=4000ms; give
# it a 6s budget for slow CI.
if wait_for "$PROXY_OUT" '"id":20' 6000; then
    ok "F3.b: never-reconnect restart id=20 answered after timeout (deadline hit)"
else
    ko "F3.b: never-reconnect restart id=20 NOT answered in 6s — timeout path broken"
fi

# F3.c — answer payload must carry {restarted:false, reason:'timeout'}
if grep '"id":20' "$PROXY_OUT" | grep -q '\\"restarted\\":false'; then
    ok "F3.c: timeout answer carries {restarted:false}"
else
    ko "F3.c: timeout answer did NOT carry {restarted:false}"
fi
if grep '"id":20' "$PROXY_OUT" | grep -q '\\"reason\\":\\"timeout\\"'; then
    ok "F3.d: timeout answer carries reason:'timeout'"
else
    ko "F3.d: timeout answer did NOT carry reason:'timeout'"
fi

# F3.e — held id=21 must be REJECTED (retryable diagnostic), not silently swallowed
if grep -q '"id":21' "$PROXY_OUT"; then
    rej_line=$(grep '"id":21' "$PROXY_OUT")
    if echo "$rej_line" | grep -q '"error"'; then
        ok "F3.e: held id=21 rejected with error envelope (not silently swallowed)"
    else
        ko "F3.e: held id=21 answered without error envelope (silent swallow risk)"
    fi
else
    ko "F3.e: held id=21 not answered at all (silent swallow — should reject)"
fi

# F3.f — proxy log must record the timeout
if grep -q 'restart: answered held restart id=20 -> {"restarted":false' "$PROXY_ERR"; then
    ok "F3.f: proxy logged timeout answer"
else
    ko "F3.f: proxy did NOT log timeout answer"
fi

# Cleanup: clear the never-flag for any later scenarios
rm -f "$NEVER_FLAG"

cp "$PROXY_ERR" /tmp/see1134-restart.proxy.err 2>/dev/null || true
cp "$PROXY_OUT" /tmp/see1134-restart.proxy.out 2>/dev/null || true

# F4 — proxy logs the held-call rejection path. Verify F2 log shape:
#   - 'restart: intercepting godot_editor_edit restart id=10' appears
#   - 'restart: addon acknowledged restart id=10' appears
#   - 'restart: answered held restart id=10 -> {"restarted":true}' appears
if grep -q 'restart: intercepting godot_editor_edit restart id=10' "$PROXY_ERR"; then
    ok "F4.a: proxy logged inbound intercept for id=10"
else
    ko "F4.a: proxy did NOT log inbound intercept for id=10"
fi
if grep -q 'restart: addon acknowledged restart id=10' "$PROXY_ERR"; then
    ok "F4.b: proxy logged addon ack for id=10"
else
    ko "F4.b: proxy did NOT log addon ack for id=10"
fi
if grep -q '"restarted":true' "$PROXY_ERR"; then
    ok "F4.c: proxy logged final answer {restarted:true}"
else
    ko "F4.c: proxy did NOT log final answer {restarted:true}"
fi

summary