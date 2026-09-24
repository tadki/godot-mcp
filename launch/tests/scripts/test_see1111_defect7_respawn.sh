#!/usr/bin/env bash
# test_see1111_defect7_respawn.sh
#
# SEE-1111 缺陷 #7 + 预热提示 — post-warm editor death must RE-SPAWN the editor.
#
# Pre-fix behavior: after the proxy reached WARM, an editor_gone error left the
# proxy warm with a dead editor — every subsequent tools/call got a retryable
# editor_gone and nothing ever re-spawned (the runWarmupLoop() resident gap:
# warmEditorDead was never set, so the loop returned immediately after WARM and
# was not alive when the editor later died).
#
# With SEE-1111 hold-to-warm (目标1): a tools/call that lands while the editor
# is COLD-WARMING is HELD in the FIFO until the gate opens, then flushed to npx
# and answered with a real result — no warmup hint. But a tools/call that lands
# while the editor is in the WARM-then-DIED respawn round gets the DISTINCT
# respawn hint (editor 正在重启…). This test proves the fix end-to-end through
# the REAL proxy:
#   R1  first cold spawn — first tools/call (id=2) triggers the spawn and is
#       HELD until WARM, then flushed to npx and answered (no warmup hint, no
#       premature flush); the mock listener binds GODOT_PORT and the proxy
#       reaches WARM (start counter=1).
#   R2  editor death — the listener dies (simulating the editor WS vanishing).
#   R3  editor_gone — a forwarded tools/call id=3 against the dead port comes
#       back with a retryable editor_gone diagnostic; the forwarder detects the
#       post-warm death (beginWarmEditorRespawn: warm→false, warmEditorDead=true).
#   R4  RESPAWN + respawn hint — a retry call id=4 re-triggers the spawn (the
#       spawn-trigger branch fires BEFORE the warmEditorDead branch, so start
#       counter climbs 1→2) but is answered with the DISTINCT respawn hint
#       (editor 正在重启…), never a cold-boot hint and never an error.
#   R5  no-flapping — a call sent while the respawn loop is in flight is also
#       answered with the respawn hint and does NOT trigger a third spawn
#       (spawnTriggered latches true); start counter stays 2.
#   R6  re-warm — the mock listener comes back; the proxy re-probes WARM; a
#       post-re-warm call id=6 is forwarded to npx and answered (respawn round
#       completed, start counter still 2).
#
# Test seam: make_start_mock(spawn=1) nohup's the WS-completing mock listener on
# GODOT_PORT so the proxy's wsProbe (a real WS handshake — SEE-1111 缺陷 #6) can
# complete and flip warm. The listener is killed to simulate editor death.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1111_defect7_respawn.sh

set -uo pipefail
trap '' PIPE   # writes into a closed coproc reader deliver SIGPIPE; ignore.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)
CFG_COUNTER="$TMPDIR/cfg.count"
START_COUNTER="$TMPDIR/start.count"
: > "$CFG_COUNTER"; : > "$START_COUNTER"

# Custom mock-npx that mirrors real npx behavior: for tools/call it TCP-probes
# the editor port; if the editor is reachable the call SUCCEEDS, otherwise it
# returns the bare "Not connected to Godot: WebSocket closed" error the real
# godot-mcp CLI surfaces (which the proxy wraps as editor_gone — SEE-1085 T9).
# This models the actual flow: warm path forwards to npx → npx tries to reach
# the editor → editor died → editor_gone → respawn → next call reaches the
# freshly-spawned editor.
cat > "$TMPDIR/mock-npx-stable.mjs" <<'EOF'
import * as readline from 'node:readline';
import { appendFileSync } from 'node:fs';
import net from 'node:net';
const LOG = process.env.MOCK_NPX_LOG || '';
const EDITOR_PORT = parseInt(process.env.MOCK_EDITOR_PORT || '0', 10);
function editorAlive() {
    return new Promise((resolve) => {
        if (!EDITOR_PORT) return resolve(true);
        const s = net.connect(EDITOR_PORT, '127.0.0.1');
        s.on('connect', () => { s.destroy(); resolve(true); });
        s.on('error', () => resolve(false));
        s.setTimeout(1000, () => { s.destroy(); resolve(false); });
    });
}
const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', async (line) => {
    if (!line.trim()) return;
    if (LOG) { try { appendFileSync(LOG, line + '\n'); } catch (e) {} }
    try {
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { name: 'mock-godot-mcp', protocolVersion: '2024-11-05', capabilities: {} } }) + '\n');
            return;
        }
        if (msg.method === 'tools/call') {
            const alive = await editorAlive();
            if (alive) {
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                    result: { content: [{ type: 'text', text: 'mock-ok' }] } }) + '\n');
            } else {
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                    error: { code: -32000, message: 'Not connected to Godot: WebSocket closed' } }) + '\n');
            }
            return;
        }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: 'mock-ok' }] } }) + '\n');
    } catch (e) {}
});
EOF

CFG_SH=$(make_configure_mock "$CFG_COUNTER" 0 "$MOCK_WORKTREE")
START_SH=$(make_start_mock "$START_COUNTER" 0 1)   # spawn=1 → listener on GODOT_PORT

sep "SEE-1111 缺陷 #7: post-warm editor death re-spawns (port=$PORT)"
start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG_COUNTER" \
    "KOL_START_COUNTER=$START_COUNTER" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=5000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log" \
    "MOCK_EDITOR_PORT=$PORT"

send_line "$INIT_LINE"
if wait_for "$PROXY_OUT" '"id":1' 1500; then
    ok "R1.pre: initialize answered (MCP handshake live)"
else
    ko "R1.pre: initialize not answered — proxy/mock chain dead"
fi

# R1 — first cold spawn → WARM; the first call is HELD in the FIFO until the
# warmup gate opens (SEE-1111 hold-to-warm 目标1), then flushed to npx and
# answered with a real result — no warmup hint, no premature flush.
send_line "$(call_line 2)"
if wait_for "$PROXY_ERR" 'editor spawn launched' 3000; then
    ok "R1.0: spawn launched after first tools/call"
else
    ko "R1.0: proxy never spawned the editor after tools/call"
fi
if wait_for "$PROXY_ERR" 'warm detected' 10000; then
    ok "R1.4: proxy reached WARM (held first call about to be flushed)"
else
    ko "R1.4: proxy never reached WARM"
fi
if wait_for "$PROXY_OUT" '"id":2' 8000; then
    ok "R1.1: first tools/call id=2 answered after WARM (held → flushed, no first-call stall)"
else
    ko "R1.1: no id=2 response — proxy never flushed the held call"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "R1.1b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "R1.1b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if wait_for "$TMPDIR/npx.log" '"id":2' 4000; then
    ok "R1.2: held id=2 flushed to npx after WARM (hold → flush, not a hint)"
else
    ko "R1.2: id=2 never reached npx (hold broke the flush)"
fi
wait_count "$START_COUNTER" 1 3000   # SEE-1342 D4: wait for the spawn event itself
SC1=$(count_lines "$START_COUNTER")
if [[ "$SC1" == "1" ]]; then
    ok "R1.3: start invoked exactly once for the cold spawn (count=$SC1)"
else
    ko "R1.3: start count=$SC1 (expected 1)"
fi

# R2 — kill the mock listener to simulate editor death after warmup.
LIS_PID=$(pgrep -f "$TMPDIR/ws-mock-listener.mjs" | head -1)
if [[ -n "$LIS_PID" ]]; then
    kill "$LIS_PID" 2>/dev/null || true
    ok "R2.1: mock editor listener killed (pid=$LIS_PID) — editor WS gone"
else
    ko "R2.1: no mock listener found to kill — test cannot simulate editor death"
fi
sleep 0.4   # 竞态窗口语义（CLAUDE.md 边界）：测 TCP 死亡对端侧可见前的转发路径，窗口本身即被测行为

# R3 — a call against the dead port → forwarded (warm path still) → npx returns
# the bare WebSocket-closed error → the forwarder wraps it as a retryable
# editor_gone AND detects the post-warm death (beginWarmEditorRespawn:
# warm→false, warmEditorDead=true — the 缺陷 #7 fix).
send_line "$(call_line 3)"
if wait_for "$PROXY_OUT" '"id":3' 8000; then
    ok "R3.1: id=3 got a response (forwarder still alive)"
else
    ko "R3.1: no id=3 response — proxy may have exited on editor death"
fi
if wait_for "$TMPDIR/npx.log" '"id":3' 4000; then
    ok "R3.2: id=3 forwarded to npx (warm path before the death was detected)"
else
    ko "R3.2: id=3 never reached npx"
fi
SNAP="$TMPDIR/r3_snap.out"; cp "$PROXY_OUT" "$SNAP"
if grep -q 'editor_gone' "$SNAP"; then
    ok "R3.3: id=3 carries editor_gone diagnostic (not silent retry)"
else
    ko "R3.3: editor_gone diagnostic missing — editor death not detected"
fi
if grep -q '"retryable": *true' "$SNAP"; then
    ok "R3.4: editor_gone is retryable (drop-with-retry semantics)"
else
    ko "R3.4: retryable=true missing"
fi
if wait_for "$PROXY_ERR" 'editor gone after warmup' 3000; then
    ok "R3.5: proxy detected the post-warm editor death (beginWarmEditorRespawn)"
else
    ko "R3.5: 'editor gone after warmup' not logged — respawn state never entered"
fi
if proxy_alive; then
    ok "R3.6: proxy still alive after editor death (did not fast-exit)"
else
    ko "R3.6: proxy died after editor death"
fi

# R4 — a retry call must trigger a FRESH spawn (start count 1→2). The spawn
# trigger branch fires BEFORE the warmEditorDead branch, so id=4 re-spawns the
# editor — but its answer is the DISTINCT respawn hint (editor 正在重启), not a
# cold-boot hint and not an error.
send_line "$(call_line 4)"
if wait_for "$PROXY_OUT" '"id":4' 8000; then
    ok "R4.1: retry id=4 answered (respawn-hint path)"
else
    ko "R4.1: no id=4 response — respawn never completed"
fi
if grep -q 'editor 正在重启（warm 后 editor 掉线，proxy 正在重新拉起）' "$PROXY_OUT"; then
    ok "R4.1b: id=4 is the DISTINCT respawn hint (editor 正在重启…), not a cold-boot hint"
else
    ko "R4.1b: respawn hint text missing from the id=4 response"
fi
# SEE-1192: the id=4 respawn hint is answered SYNCHRONOUSLY while the spawn
# pipeline (tcpProbe → prepare → configure → start counter write) still runs
# in the background — a fixed sleep races that pipeline (under load the real
# prepare-worktree.sh alone can exceed 300ms). Wait deterministically for the
# counter to reach 2 instead of guessing a delay.
wait_count "$START_COUNTER" 2 5000   # SEE-1342 D4: wait for the respawn event itself
SC2=$(count_lines "$START_COUNTER")
if [[ "$SC2" == "2" ]]; then
    ok "R4.2: start invoked a SECOND time for the respawn (count=$SC2)"
else
    ko "R4.2: start count=$SC2 (expected 2 — respawn did not run)"
fi
if wait_for "$PROXY_ERR" 'respawn loop: re-entering warmup' 3000; then
    ok "R4.3: proxy logged the respawn re-entry"
else
    ko "R4.3: 'respawn loop: re-entering warmup' not logged"
fi

# R5 — no-flapping: a call during the respawn window must not trigger a THIRD
# spawn (spawnTriggered latches true); it gets the respawn hint too.
send_line "$(call_line 5)"
if wait_for "$PROXY_OUT" '"id":5' 8000; then
    ok "R5.1: id=5 answered (respawn hint while the respawn is in flight)"
else
    ko "R5.1: no id=5 response"
fi
wait_for_stable "$START_COUNTER" 2000   # SEE-1342 D4: settle then prove no THIRD spawn event landed
SC3=$(count_lines "$START_COUNTER")
if [[ "$SC3" == "2" ]]; then
    ok "R5.2: start count stayed 2 (no double-respawn flapping)"
else
    ko "R5.2: start count=$SC3 (expected 2 — respawn flapped)"
fi

# R6 — the mock listener came back with the second spawn (make_start_mock
# spawn=1 re-binds it each invocation); the proxy re-probes WARM, and a
# post-re-warm call is forwarded to npx and answered (respawn round completed).
if wait_for "$PROXY_ERR" 'warm detected' 10000; then
    ok "R6.1: proxy re-reached WARM after the respawn (editor back up)"
else
    ko "R6.1: proxy never re-warmed after the respawn"
fi
send_line "$(call_line 6)"
if wait_for "$PROXY_OUT" '"id":6' 8000; then
    ok "R6.2: post-re-warm call id=6 answered (forwarded path, not a hint)"
else
    ko "R6.2: no id=6 response after re-warm"
fi
if wait_for "$TMPDIR/npx.log" '"id":6' 4000; then
    ok "R6.3: id=6 forwarded to npx after re-warm (respawn round fully completed)"
else
    ko "R6.3: id=6 never reached npx after re-warm"
fi
wait_for_stable "$START_COUNTER" 2000   # SEE-1342 §SPEC-107: settle = mtime-stable
SC4=$(count_lines "$START_COUNTER")
if [[ "$SC4" == "2" ]]; then
    ok "R6.4: start counter provenance — exactly one spawn per round (cold=1, respawn=2, count=$SC4)"
else
    ko "R6.4: start count=$SC4 (expected 2 — counter provenance broken)"
fi

stop_proxy
summary
