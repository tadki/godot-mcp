#!/usr/bin/env bash
# test_see1111_defect8_respawn_probe.sh
#
# SEE-1111 缺陷 #8 + 预热提示 — a post-warm editor death that NEVER reaches npx
# (hard kill, WSL network reset, lease self-exit without a log line) must still
# trigger a respawn. The CLI's WS transport reports such deaths to Claude
# directly as "Connection to Godot was lost" — the npx JSON-RPC msg.error path
# (缺陷 #7's trigger) is never seen, so the proxy would stay warm with a dead
# editor and every retry keeps failing against a dead port (Revy hard
# acceptance: kill editor -> 3 retries all failed, CLI stuck in SYN-SENT).
#
# This test proves the warm-liveness probe fix end-to-end through the REAL proxy,
# including the hold-to-warm semantics (SEE-1111 目标1) for the cold round and
# the DISTINCT respawn hint for the respawn round:
#   R1  first cold spawn — first tools/call (id=2) triggers the spawn and is
#       HELD until WARM, then flushed to npx and answered (no warmup hint, no
#       premature flush); the mock listener binds GODOT_PORT and the proxy
#       reaches WARM; a follow-up call id=3 is forwarded and answered (start
#       counter=1).
#   R2  editor death — the listener dies (simulating the editor WS vanishing).
#   R3  probe-detected death — WITHOUT any tools/call, the proxy's resident
#       warm-liveness probe (wsProbe on the warm idle loop) fails
#       WARM_LIVENESS_FAILURES times and flips warmEditorDead. The mock-npx in
#       this test NEVER returns editor_gone (it always succeeds), so the ONLY
#       way warm can be cleared is the probe — the fix 缺陷 #7 could not cover.
#   R4  retry triggers respawn — a tools/call id=4 re-triggers the spawn (start
#       counter climbs 1→2) but is answered with the DISTINCT respawn hint
#       (editor 正在重启…, never a cold-boot hint and never an error). THIS is
#       the "kill editor -> retry triggers auto respawn" acceptance.
#   R5  no-flapping — the respawn round does not re-trigger on its own; start
#       counter stays 2.
#   R6  re-warm — the mock listener comes back with the second spawn; the proxy
#       re-probes WARM; a post-re-warm call id=6 is forwarded to npx and answered.
#
# The warm-liveness probe uses wsProbe (a real WS handshake — SEE-1111 缺陷 #6),
# so the mock editor must complete an HTTP Upgrade for the probe to observe
# `open` — the standard make_start_mock(spawn=1) seam does exactly that.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1111_defect8_respawn_probe.sh

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

# Custom mock-npx that ALWAYS answers any id'd request with success. It must
# NEVER return editor_gone: the test needs the death to be detected ONLY by the
# warm-liveness probe (缺陷 #8). If the probe never ran, the proxy would stay
# warm and id=4 would just be answered by npx with no respawn — start counter
# would stay 1 and R4.2 would fail.
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
            return;
        }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: 'mock-ok' }] } }) + '\n');
    } catch (e) {}
});
EOF

CFG_SH=$(make_configure_mock "$CFG_COUNTER" 0)
START_SH=$(make_start_mock "$START_COUNTER" 0 1)   # spawn=1 → listener on GODOT_PORT

sep "SEE-1111 缺陷 #8: post-warm editor death detected by probe triggers respawn (port=$PORT)"
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
    "KOL_WARM_LIVENESS_FAILURES=2" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log" \
    "MOCK_EDITOR_PORT=$PORT"

send_line "$INIT_LINE"
if wait_for "$PROXY_OUT" '"id":1' 1500; then
    ok "R1.pre: initialize answered (MCP handshake live)"
else
    ko "R1.pre: initialize not answered — proxy/mock chain dead"
fi

# R1 — first cold spawn → WARM. id=2 (the trigger call) is HELD in the FIFO
# until the gate opens (SEE-1111 hold-to-warm 目标1), then flushed to npx and
# answered — no warmup hint, no premature flush; the follow-up id=3 confirms the
# warm forwarded path.
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
send_line "$(call_line 3)"
if wait_for "$PROXY_OUT" '"id":3' 8000; then
    ok "R1.5: follow-up call id=3 answered (forwarded warm path)"
else
    ko "R1.5: no id=3 response after warm"
fi
if wait_for "$TMPDIR/npx.log" '"id":3' 4000; then
    ok "R1.6: id=3 forwarded to npx (real call after warm)"
else
    ko "R1.6: id=3 never reached npx"
fi

# R2 — kill the mock listener to simulate a post-warm editor death that does NOT
# go through npx (a hard kill the CLI transport reports directly).
LIS_PID=$(pgrep -f "$TMPDIR/ws-mock-listener.mjs" | head -1)
if [[ -n "$LIS_PID" ]]; then
    kill "$LIS_PID" 2>/dev/null || true
    ok "R2.1: mock editor listener killed (pid=$LIS_PID) — editor WS gone"
else
    ko "R2.1: no mock listener found to kill — test cannot simulate editor death"
fi
sleep 0.4   # 竞态窗口语义（CLAUDE.md 边界）：TCP 死亡可见前的窗口本身即被测行为

# R3 — the warm-liveness probe (no tools/call needed) must detect the death and
# flip the respawn flag. The mock-npx never returns editor_gone, so this log
# line can only come from the probe.
if wait_for "$PROXY_ERR" 'editor presumed dead' 8000; then
    ok "R3.1: proxy logged the liveness-probe death detection"
else
    ko "R3.1: 'editor presumed dead' not logged — probe did not detect the death"
fi

# R4 — a retry call must trigger a FRESH spawn (start count 1→2). The spawn
# trigger branch fires BEFORE the warmEditorDead branch, so id=4 re-spawns the
# editor — but its answer is the DISTINCT respawn hint (editor 正在重启), not a
# cold-boot hint and not an error. THIS is the "kill editor -> retry
# auto-respawns" acceptance.
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
# SEE-1192: same race as defect7 R4.2 — the synchronous respawn hint races the
# async spawn pipeline; wait deterministically for the counter to reach 2.
wait_count "$START_COUNTER" 2 5000   # SEE-1342 D4: wait for the respawn event itself
SC2=$(count_lines "$START_COUNTER")
if [[ "$SC2" == "2" ]]; then
    ok "R4.2: start invoked a SECOND time for the probe-triggered respawn (count=$SC2)"
else
    ko "R4.2: start count=$SC2 (expected 2 — probe respawn did not run)"
fi
if wait_for "$PROXY_ERR" 'respawn loop: re-entering warmup' 3000; then
    ok "R4.3: proxy logged the respawn re-entry"
else
    ko "R4.3: 'respawn loop: re-entering warmup' not logged"
fi

# R5 — no-flapping: the respawn round must NOT re-trigger on its own.
sleep 1.5   # 竞态窗口语义（CLAUDE.md 边界）：必须观察"禁触发窗内无自触发"，窗最小长度 = 代理单轮 cooldown，无法等价事件化
SC3=$(count_lines "$START_COUNTER")
if [[ "$SC3" == "2" ]]; then
    ok "R5.1: start count stayed 2 (no self-flapping respawn)"
else
    ko "R5.1: start count=$SC3 (expected 2 — respawn flapped)"
fi

# R6 — the mock listener came back with the second spawn; the proxy re-probes
# WARM, and a post-re-warm call is forwarded to npx and answered (respawn round
# completed, start counter still 2).
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
wait_for_stable "$START_COUNTER" 2000   # SEE-1342 D4
SC4=$(count_lines "$START_COUNTER")
if [[ "$SC4" == "2" ]]; then
    ok "R6.4: start counter provenance — one spawn per round (cold=1, respawn=2, count=$SC4)"
else
    ko "R6.4: start count=$SC4 (expected 2 — counter provenance broken)"
fi

stop_proxy
summary
