#!/usr/bin/env bash
# test_see1111_timeline_negative_degradation.sh
#
# SEE-1111 缺陷 B (MEDIUM) + 预热提示 误报防护 regression — buildWarmupTimeline()
# degrades NEGATIVE stage intervals to `?`, and a spawn failure surfaces as the
# real spawn_failed diagnostic (never a "warming" hint).
#
# Setup: the editor log exists and is polled (lease monitor) BEFORE any spawn
# trigger, and already carries the warmup milestone lines (Plugin initialized /
# Server listening / TCP connection / WS handshake) — as in a real deployment
# where the editor log is left over from a previous session. The lease monitor
# tails the log and records those stage timestamps during the proxy's initial
# idle (COLD_EMPTY) phase, BEFORE the first tools/call flips spawnTriggered and
# sets spawnStartedAt. The recorded timestamps therefore PREDATE the spawn-round
# start.
#
# On the first tools/call the spawn fails (configure rc=1, a transient failure).
# With SEE-1111 hold-to-warm (目标1) the trigger call id=2 is HELD in the FIFO;
# when the async failure lands, handleSpawnFailure's rejectQueue drains it with
# the REAL spawn_failed diagnostic (目标3 — 真实错误非预热提示), never a hint.
# On the SECOND tools/call the one-shot spawn_failed diagnostic (configure_failed
# bucket) is delivered again AND the spawn retries; this attempt succeeds
# (configure rc=0, listener up), the editor reaches WARM, and the first post-warm
# success response (a THIRD call) carries the §7 one-line timeline echo. Because
# the idle-phase stage timestamps precede spawnStartedAt, the pre-fix sec()
# rendered them as NEGATIVES (e.g. `tcp→-70.5s`); the fix must degrade them to `?`.
#
# Assertions:
#   B.1  id=2 (the trigger call) is held, then drained by the async spawn failure
#        with the real spawn_failed diagnostic (not a hint, not an error before
#        the failure exists).
#   B.2  id=3 gets the one-shot spawn_failed diagnostic (configure_failed bucket)
#        and re-triggers the spawn (configure called again).
#   B.3  id=4 (post-warm) is forwarded, reaches WARM, and the success response
#        carries the timeline echo.
#   B.4  the echoed timeline shows NO negative stage intervals: every `x→y.s`
#        segment is either a non-negative number or `?` (this is the 缺陷 B
#        regression assertion — pre-fix it printed negatives).
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1111_timeline_negative_degradation.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)
EDITOR_LOG="$TMPDIR/editor.log"
# Empty at proxy start: the lease monitor binds and seeds its offset to size 0,
# so lines appended AFTER boot are scanned (pre-populated lines are skipped by
# the offset seed — that is the SEE-1077 stale-line guard).
: > "$EDITOR_LOG"

CFG="$TMPDIR/cfg.count"; START="$TMPDIR/start.count"
: > "$CFG"; : > "$START"
START_SH=$(make_start_mock "$START" 0 1)             # spawn=1 → listener on GODOT_PORT

# Fail-once configure mock: first invocation exits rc=1 (transient spawn
# failure), subsequent invocations exit rc=0.
CFG_SH="$TMPDIR/mock-configure.sh"
cat > "$CFG_SH" <<EOF
#!/usr/bin/env bash
echo x >> "\${KOL_CONFIGURE_COUNTER:-$CFG}"
if [[ ! -f "$TMPDIR/cfg_ok" ]]; then
    touch "$TMPDIR/cfg_ok"
    echo "=== 配置失败诊断（结构化） ===" >&2
    exit 1
fi
exit 0
EOF
chmod +x "$CFG_SH"

sep "SEE-1111 缺陷 B + 预热提示: hint → one-shot spawn_failed → warm → degraded timeline"

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
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "B.pre: initialize not answered"

# The editor log now receives the full warmup milestone sequence — as if a
# previous editor session left it behind. The lease monitor (polled from proxy
# start) tails these lines during the proxy's IDLE (COLD_EMPTY) phase, BEFORE
# any tools/call flips spawnTriggered and sets spawnStartedAt. The recorded
# stage timestamps therefore PREDATE the spawn-round start — the pre-fix
# buildWarmupTimeline sec() rendered them as NEGATIVES; the fix degrades them
# to `?`. (The offset seed already happened at proxy boot, so these appended
# lines ARE scanned — but before any spawn trigger.)
wait_for_stable "$EDITOR_LOG" 2000   # SEE-1342 D4
cat >> "$EDITOR_LOG" <<EOF
[godot-mcp] Plugin initialized
[godot-mcp] Server listening on 127.0.0.1:$PORT
[godot-mcp] TCP connection received from 127.0.0.1 awaiting WebSocket handshake
[godot-mcp] WebSocket handshake complete
EOF
sleep 0.5   # 竞态窗口语义（CLAUDE.md 边界）：给 lease monitor 的 tail 轮询留消费余量（必须在 spawn 触发前行被扫入），mtime 稳定不证明已消费

# --- round 1: configure fails (async) → id=2 held, then real spawn_failed -------
sep "Round 1 — transient configure failure, real spawn_failed diagnostic"
send_line "$(call_line 2)"
# SEE-1111 hold-to-warm (目标1): the trigger call is HELD in the FIFO. When the
# async spawn failure lands, handleSpawnFailure's rejectQueue drains it with the
# REAL spawn_failed diagnostic (目标3: 真实错误非预热提示) — never a "warming"
# hint, never a silent hang, never a premature error before the failure exists.
if wait_for "$PROXY_OUT" '"id":2' 4000; then
    ok "B.1a: first call id=2 answered (held call drained by the spawn failure)"
else
    ko "B.1a: no id=2 response (out: $(tail -3 "$PROXY_OUT" | tr '\n' ' '))"
fi
if grep -q 'spawn_failed' "$PROXY_OUT"; then
    ok "B.1b: id=2 carries the real spawn_failed diagnostic (目标3 — not a warmup hint)"
else
    ko "B.1b: id=2 lacks the spawn_failed diagnostic (spawn failure must surface a real error)"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "B.1h: warmup-hint text appeared (spawn failure must surface the real error, not a hint)"
else
    ok "B.1h: no warmup-hint text (real spawn_failed diagnostic, not a hint)"
fi
if wait_for "$PROXY_ERR" 'editor spawn failed' 6000; then
    ok "B.1c: spawn failure latched (editor spawn failed logged)"
else
    ko "B.1c: spawn failure never logged (configure rc=1 not surfaced)"
fi
CFG1_COUNT=$(count_lines "$CFG")
if [[ "$CFG1_COUNT" == "1" ]]; then
    ok "B.1d: configure ran exactly once in round 1"
else
    ko "B.1d: configure count after round 1 = $CFG1_COUNT"
fi

# --- round 2: id=3 one-shot spawn_failed + re-trigger --------------------------
sep "Round 2 — one-shot spawn_failed diagnostic on the retry"
send_line "$(call_line 3)"
# id=3 (a NEW call) must ALSO be answered with the spawn_failed diagnostic
# (the one-shot latch re-arms on the failed attempt). Round 1 already emitted a
# spawn_failed for id=2, so the id=3 response is the per-call delivery proof.
if wait_for "$PROXY_OUT" '"id":3' 4000; then
    ok "B.2a: id=3 answered (one-shot spawn_failed on the retry)"
else
    ko "B.2a: no id=3 response (out: $(tail -3 "$PROXY_OUT" | tr '\n' ' '))"
fi
if grep -q '"id":3.*spawn_failed' "$PROXY_OUT"; then
    ok "B.2a2: id=3 carries the spawn_failed diagnostic (one-shot re-delivery)"
else
    ko "B.2a2: id=3 lacks spawn_failed (one-shot latch broken)"
fi
if grep -q 'configure_failed' "$PROXY_OUT"; then
    ok "B.2b: diagnostic bucket is configure_failed"
else
    ko "B.2b: expected configure_failed bucket"
fi

# --- round 3: configure succeeds → spawn → warm → timeline echo ----------------
sep "Round 3 — success, warm, timeline echo"
send_line "$(call_line 4)"
# renderStable needs ~4s (2 × RENDER_SAMPLE_MS) to flip; id=4 is HELD until
# WARM, then flushed and answered. Wait for the WARM transition, then send a
# follow-up call to observe the forwarded path + timeline echo.
if wait_for "$PROXY_ERR" 'warm detected' 15000; then
    ok "B.3a: proxy reached WARM (retried spawn succeeded)"
else
    ko "B.3a: proxy never reached WARM"
fi
send_line "$(call_line 5)"
if wait_for "$PROXY_OUT" '"id":5' 6000; then
    ok "B.3b: post-warm call id=5 answered (forwarded path, not a hint)"
else
    ko "B.3b: no id=5 response after warm"
fi
if wait_for "$TMPDIR/npx.log" '"id":5' 4000; then
    ok "B.3c: id=5 forwarded to npx (real call after warm)"
else
    ko "B.3c: id=5 never reached npx"
fi
wait_for_stable "$CFG" 2000   # SEE-1342 D4
CFG3_COUNT=$(count_lines "$CFG")
if (( CFG3_COUNT >= 2 )); then
    ok "B.3d: configure ran again for the retried spawn (count=$CFG3_COUNT ≥ 2)"
else
    ko "B.3d: configure count after round 3 = $CFG3_COUNT (expected ≥ 2)"
fi
# The post-warm success response carries the §7 one-line warmup timeline echo.
if wait_for "$PROXY_OUT" 'godot-mcp warmup' 3000; then
    ok "B.3e: post-warm success response carries the warmup timeline echo"
else
    ko "B.3e: no warmup timeline echo in the success response"
fi

# B.4 — the regression assertion: extract every `stage→Xs` segment from the
# echoed timeline and require each value to be either a non-negative number or
# `?`. The pre-fix sec() printed NEGATIVES for the idle-phase stage timestamps
# (they predate spawnStartedAt); the fix degrades those to `?`.
TIMELINE_LINE="$(grep -o '\[godot-mcp warmup [^]]*\]' "$PROXY_OUT" | tail -1)"
if [[ -n "$TIMELINE_LINE" ]]; then
    note "timeline: $TIMELINE_LINE"
    BAD=""
    while read -r seg; do
        [[ -z "$seg" ]] && continue
        val="${seg#*→}"; val="${val%s}"
        if [[ "$val" == "?" ]]; then
            continue
        fi
        if [[ ! "$val" =~ ^[0-9]+(\.[0-9])?$ ]]; then
            BAD="$BAD $seg"
        fi
    done < <(echo "$TIMELINE_LINE" | grep -o '\(spawn\|plugin\|listen\|tcp\|ws\|init\)→[^ ]*s')
    if [[ -z "$BAD" ]]; then
        ok "B.4: no negative or malformed stage intervals in the timeline (negatives degrade to ?)"
    else
        ko "B.4: malformed/negative intervals found:$BAD (缺陷 B: should be '?')"
    fi
    if echo "$TIMELINE_LINE" | grep -q 'tcp→?s'; then
        ok "B.4b: pre-spawn tcp interval degraded to '?' (was a negative pre-fix)"
    else
        ko "B.4b: expected tcp→?s for the pre-spawn tcp timestamp (got: $(echo "$TIMELINE_LINE" | grep -o 'tcp→[^ ]*s'))"
    fi
else
    ko "B.4: could not locate the timeline echo line"
fi

stop_proxy
summary
