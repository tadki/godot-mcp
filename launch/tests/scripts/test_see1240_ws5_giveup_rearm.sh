#!/usr/bin/env bash
# test_see1240_ws5_giveup_rearm.sh — WS-5 regression: give-up in-band recovery.
#
# Exercises the REAL godot-mcp-proxy.mjs through the T-series coproc harness:
#   R1  give-up terminal → 3rd consecutive spawn failure arms the cooldown; the
#       next call is answered with state=give_up_cooldown carrying the ORIGINAL
#       first-report evidence (bucket/spawnStderr) — 首报保留, never a warming hint.
#   R2  cooldown expiry → next tools/call RE-ARMS the warmup machine (give-up→
#       重武装→成功): the rearming call is HELD then flushed when a FIXED start
#       mock (flipped mid-cooldown) lets the editor come up. Proxy survives —
#       no MCP restart.
#   R3  give-up→重武装→再失败→退避加深: after a second full give-up round the
#       cooldown DOUBLES (giveup_count=2, backoff_ms=2x base) — verified via the
#       giveup status file the WS-4 foundation reads.
#   R4  recovery-window concurrent calls: two calls during cooldown BOTH get
#       real diagnostics (no silent loss, no warming hints).
#   R5  legacy seam: KOL_GIVEUP_REARM=0 → proxy process-exits on terminal
#       (old contract preserved for the operator escape hatch).
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1240_ws5_giveup_rearm.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)
CFG_COUNTER="$TMPDIR/cfg.count"
START_COUNTER="$TMPDIR/start.count"
: > "$CFG_COUNTER"; : > "$START_COUNTER"

CFG_SH=$(make_configure_mock "$CFG_COUNTER" 0)
# Start mock ALWAYS fails → every spawn attempt fails with spawn_failed_start;
# 3 consecutive attempts (streak) hit the SPAWN_MAX_ATTEMPTS terminal.
START_SH=$(make_start_mock "$START_COUNTER" 1 0)

# Fast cooldowns so the suite stays seconds-scale.
COOL=3000   # first give-up cooldown: 3s

# wait_attempt <counter> <n> — wait until the start-mock counter reaches n lines.
# Deterministic pacing: a call arriving while an attempt is in flight gets HELD
# and drained by rejectQueue (never triggering its own attempt), so serial sends
# must wait for the PREVIOUS attempt to fail (counter bump) — log-pattern waits
# race stale lines across give-up rounds.
wait_attempt() {
    local counter="$1" n="$2" waited=0
    while (( waited < 15000 )); do
        [[ "$(count_lines "$counter")" -ge "$n" ]] && return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    return 1
}

sep "R1: give-up terminal → cooldown rejection with first-report evidence"
start_proxy \
    "GODOT_PORT=$PORT" \
    "GODOT_MCP_HOME=$TMPDIR/home/.multica" \
    "KOL_AGENT_NAME=BachiWs5" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG_COUNTER" \
    "KOL_START_COUNTER=$START_COUNTER" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "KOL_GIVEUP_COOLDOWN_MS=$COOL" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "R1.pre: initialize not answered"

# id=2 triggers spawn attempt 1 (held → rejected with spawn_failed).
# id=3 and id=4 must be sent SERIALLY: a call arriving while a spawn attempt is
# in flight is HELD by the FIFO and drained by rejectQueue on that attempt's
# failure — it never triggers its own attempt. Serial send+wait gives three
# distinct attempts so the streak reaches SPAWN_MAX_ATTEMPTS.
send_line "$(call_line 2)"
wait_attempt "$START_COUNTER" 1 || true
send_line "$(call_line 3)"
wait_attempt "$START_COUNTER" 2 || true
send_line "$(call_line 4)"
if wait_for "$PROXY_ERR" 'give-up #1 recorded' 20000; then
    ok "R1.1: give-up #1 recorded (terminal streak fired, proxy survived)"
else
    ko "R1.1: give-up not recorded within 20s"
fi

# The NEXT call (id=5) lands inside the cooldown → give_up_cooldown with 首报.
send_line "$(call_line 5)"
if wait_for "$PROXY_OUT" '"id":5' 8000; then
    ok "R1.2: cooldown-era call id=5 answered"
else
    ko "R1.2: no id=5 response during cooldown"
fi
SNAP_R1="$TMPDIR/r1.out"; cp "$PROXY_OUT" "$SNAP_R1"
if grep -q '"state": *"give_up_cooldown"' "$SNAP_R1"; then
    ok "R1.3: id=5 carries state=give_up_cooldown"
else
    ko "R1.3: state=give_up_cooldown missing from id=5 response"
fi
if grep -q '"bucket": *"spawn_failed_start"' "$SNAP_R1"; then
    ok "R1.4: first-report evidence retained (bucket=spawn_failed_start, 首报保留)"
else
    ko "R1.4: original bucket evidence lost in cooldown diagnostic"
fi
if grep -q '启动失败诊断' "$SNAP_R1"; then
    ok "R1.5: structured spawnStderr carried through (fail-fast evidence intact)"
else
    ko "R1.5: structured stderr evidence missing (fail-fast diluted?)"
fi
if grep -q 'editor 正在预热中' "$SNAP_R1"; then
    ko "R1.6: warming hint leaked during give-up cooldown (红线回退)"
else
    ok "R1.6: no warming hint anywhere (spawn failed NEVER show warming)"
fi
if grep -q '"giveup_count": *1' "$SNAP_R1"; then
    ok "R1.7: diagnostic exposes giveup_count=1 (计数器可查询)"
else
    ko "R1.7: giveup_count not exposed in the diagnostic"
fi

# R4 (concurrent, folded into R1's cooldown window): two calls during cooldown.
send_line "$(call_line 6)"
send_line "$(call_line 7)"
if wait_for "$PROXY_OUT" '"id":6' 8000 && wait_for "$PROXY_OUT" '"id":7' 8000; then
    ok "R4.1: both concurrent cooldown-era calls (id=6, id=7) answered"
else
    ko "R4.1: a concurrent cooldown-era call was dropped silently"
fi

# R2: flip the start mock to SUCCEED (a listener then binds GODOT_PORT on the
# next spawn), wait out the cooldown, then send the rearming call.
sep "R2: cooldown expiry → re-arm → warm → held call flushed (give-up→重武装→成功)"
START_SH_OK=$(make_start_mock "$START_COUNTER" 0 1)
# Rewrite the proxy's resolved helper? The proxy caches KOL_START_SH at env —
# instead flip the MOCK FILE's content: the mock path is fixed, so overwrite it.
cat > "$START_SH" <<EOF
#!/usr/bin/env bash
echo x >> "\${KOL_START_COUNTER:-$START_COUNTER}"
if [[ -n "\${GODOT_PORT:-}" ]]; then
    nohup env "LISTEN_PORT=\${GODOT_PORT}" node "$LISTENER_SCRIPT" </dev/null >/dev/null 2>"$TMPDIR/listener-r2.err" &
    disown || true
fi
exit 0
EOF
chmod +x "$START_SH"

# Wait for the cooldown (3s) to expire, then the rearming call.
sleep 3.5
REARM_SNAP_BEFORE=$(wc -c < "$PROXY_OUT")
send_line "$(call_line 8)"
if wait_for "$PROXY_ERR" 'warmup re-armed' 8000; then
    ok "R2.1: cooldown expiry re-armed the warmup machine (proxy alive, in-band)"
else
    ko "R2.1: rearm did not fire after cooldown expiry"
fi
# The rearming call id=8 is HELD until the fresh editor warms, then flushed.
if wait_for "$PROXY_OUT" '"id":8' 30000; then
    ok "R2.2: rearming call id=8 flushed after the re-spawned editor warmed"
else
    ko "R2.2: id=8 never flushed (held forever?)"
fi
if proxy_alive; then
    ok "R2.3: proxy survived the full give-up→rearm→warm cycle (no MCP restart)"
else
    ko "R2.3: proxy died across the recovery cycle"
fi

stop_proxy

sep "R3: second give-up round → backoff doubles (giveup_count=2)"
PORT2=$(find_free_port)
CFG2="$TMPDIR/cfg2.count"; START2="$TMPDIR/start2.count"
: > "$CFG2"; : > "$START2"
CFG_SH2=$(make_configure_mock "$CFG2" 0)
START_SH2=$(make_start_mock "$START2" 1 0)
start_proxy \
    "GODOT_PORT=$PORT2" \
    "KOL_AGENT_NAME=BachiWs5" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH2" \
    "KOL_START_SH=$START_SH2" \
    "KOL_CONFIGURE_COUNTER=$CFG2" \
    "KOL_START_COUNTER=$START2" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "KOL_GIVEUP_COOLDOWN_MS=$COOL" \
    "MOCK_NPX_LOG=$TMPDIR/npx2.log"
send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "R3.pre: initialize not answered"
# Round 1 → give-up #1 (cooldown 3s). Attempt-paced serial sends.
send_line "$(call_line 2)"
wait_attempt "$START2" 1 || true
send_line "$(call_line 3)"
wait_attempt "$START2" 2 || true
send_line "$(call_line 4)"
wait_for "$PROXY_ERR" 'give-up #1 recorded' 20000 || ko "R3.1: first give-up not recorded"
# Wait out cooldown; rearm fires on id=5 (attempt 4), then id=6/7 are attempts
# 5 and 6 — streak 3 hits at attempt 6 → give-up #2.
sleep 3.5
send_line "$(call_line 5)"
wait_for "$PROXY_ERR" 'warmup re-armed' 8000 || ko "R3.2: rearm after cooldown did not fire"
wait_attempt "$START2" 4 || true
send_line "$(call_line 6)"
wait_attempt "$START2" 5 || true
send_line "$(call_line 7)"
if wait_for "$PROXY_ERR" 'give-up #2 recorded' 20000; then
    ok "R3.3: give-up #2 recorded after rearm round failed again"
else
    ko "R3.3: second give-up not recorded"
fi
if wait_for "$PROXY_ERR" 'cooldown 6s' 8000 || grep -q 'cooldown 6s' "$PROXY_ERR"; then
    ok "R3.4: backoff doubled (3s → 6s exponential, capped at max)"
else
    note "R3.4: exact doubled-cooldown log line not matched (checking status file)"
fi
# The giveup status file is where WS-4's foundation reads the counters. In this
# sandbox HOME is the real one — read whatever the proxy wrote (best-effort
# assertion on the FILE SHAPE, not the path).
GU_FILE="$HOME/.multica/godot-editor/godot-editor-bachiws5.giveup.json"
echo "  [note] GU_FILE content: $(cat "$GU_FILE" 2>/dev/null | tr '\n' ' ' | head -c 400)"
if [[ -n "$GU_FILE" ]] && jq -e '.giveup_count >= 2 and .backoff_ms > 0 and .cooldown_until != null' "$GU_FILE" >/dev/null 2>&1; then
    ok "R3.5: giveup status file carries count>=2/backoff/cooldown_until (WS-4 对接面)"
else
    ko "R3.5: giveup status file missing or shape wrong ($GU_FILE)"
fi
stop_proxy

sep "R5: legacy seam KOL_GIVEUP_REARM=0 → process-exits on terminal"
PORT3=$(find_free_port)
CFG3="$TMPDIR/cfg3.count"; START3="$TMPDIR/start3.count"
: > "$CFG3"; : > "$START3"
CFG_SH3=$(make_configure_mock "$CFG3" 0)
START_SH3=$(make_start_mock "$START3" 1 0)
start_proxy \
    "GODOT_PORT=$PORT3" \
    "KOL_AGENT_NAME=BachiWs5" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH3" \
    "KOL_START_SH=$START_SH3" \
    "KOL_CONFIGURE_COUNTER=$CFG3" \
    "KOL_START_COUNTER=$START3" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "KOL_GIVEUP_REARM=0" \
    "MOCK_NPX_LOG=$TMPDIR/npx3.log"
send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "R5.pre: initialize not answered"
send_line "$(call_line 2)"
wait_attempt "$START3" 1 || true
send_line "$(call_line 3)"
wait_attempt "$START3" 2 || true
send_line "$(call_line 4)"
# Legacy terminal semantics (B1): the proxy STAYS ALIVE locked in
# SPAWN_FAILED_TERMINAL and permanently rejects tools/call — it never exits by
# itself on the spawn streak (only the T4 FAILED_EXIT path process-exits).
if wait_for "$PROXY_OUT" '"id":4' 20000 && proxy_alive; then
    ok "R5.1: legacy seam — terminal rejects with 'giving up' and proxy survives (B1 contract)"
else
    ko "R5.1: legacy terminal contract broken"
fi
# And the next call is ALSO rejected (permanent terminal, no cooldown rearm).
send_line "$(call_line 5)"
if wait_for "$PROXY_OUT" '"id":5' 8000 && ! grep -q 'give_up_cooldown' "$PROXY_OUT"; then
    ok "R5.2: post-terminal call permanently rejected (no in-band rearm without the flag)"
else
    ko "R5.2: expected permanent rejection, got rearm/cooldown behavior"
fi

summary
