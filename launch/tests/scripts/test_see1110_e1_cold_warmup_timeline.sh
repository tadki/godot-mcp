#!/usr/bin/env bash
# test_see1110_e1_cold_warmup_timeline.sh
#
# SEE-1110 §8 E1 — cold-start success timeline, asserted on CHANNEL A (response
# body), with E4 (client-swallows-notifications) baked in.
#
# Scenario: empty port, no editor, fake editor log (empty at proxy start so the
# lease-offset tail sees post-spawn lines). First tools/call triggers lazy
# spawn and is HELD in the FIFO (SEE-1111 hold-to-warm) — no warmup hint. We
# append the 4 milestone lines (Plugin initialized / Server listening / TCP
# received / WebSocket handshake complete) while the start-mock binds the
# listener. Warmup completes → the HELD call (id=2) is flushed to npx and its
# success response's result.content must carry the one-line
# `[godot-mcp warmup ... | spawn→...s plugin→...s ...]` timeline (§7 B5 gate).
#
# E4 verification (client swallows notifications): every assertion in this test
# reads ONLY proxy stdout (the response body). notifications/progress output —
# when present — is never consulted. If the client dropped Channel B, E1 still
# passes; that is the acceptance criterion.
#
# Assertions:
#   E1.1  initialize answered < 2s (MCP handshake works without the editor).
#   E1.2  first tools/call triggers spawn (proxy stderr 'editor spawn launched').
#   E1.4a-c id=2 is HELD while warming, then flushed to npx after WARM and
#        answered — no warmup-hint text anywhere.
#   E1.3  proxy reaches WARM (renderStable gate passes on the static fake log).
#   E1.4d-g the HELD id=2 (first post-warm response) is forwarded and its
#        response result.content末尾含 `[godot-mcp warmup` 时间线行（Channel A）。
#   E1.5 时间线 5 个 stage 段非 `?` 且单调：plugin≤listen≤tcp≤ws≤init。
#   E1.6 已知缺陷 L(EDITOR_SPAWNED)：spawn 段允许 `spawn→?s`（记录为 LOW，不 FAIL）。
#   E1.7 第二个 post-warm tools/call (id=3) 的 content 不含 warmup 行（一次性门控，§7/E5-b）。
#   E1.8 (旁证, 非断言) Channel B 通知含 handshakeSubstate:"complete"。
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1110_e1_cold_warmup_timeline.sh

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

# Fake editor log. MUST be empty when the proxy starts: startLeaseMonitor seeds
# leaseOffset to the startup file size, so any pre-existing milestone line would
# be skipped (and renderStable would still gate on a static file). We append the
# milestone lines AFTER the spawn is observed.
EDITOR_LOG="$TMPDIR/fake-editor.log"
: > "$EDITOR_LOG"

CFG_SH=$(make_configure_mock "$CFG_COUNTER" 0)
START_SH=$(make_start_mock "$START_COUNTER" 0 1)   # spawn=1 → listener on GODOT_PORT

sep "E1: cold-start success timeline on Channel A"
start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG_COUNTER" \
    "KOL_START_COUNTER=$START_COUNTER" \
    "KOL_WARMUP_TIMEOUT_MS=20000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=5000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "GODOT_EDITOR_LOG_FILE=$EDITOR_LOG" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
if wait_for "$PROXY_OUT" '"id":1' 2000; then
    ok "E1.1: initialize answered < 2s (MCP handshake without the editor)"
else
    ko "E1.1: initialize not answered in 2s"
fi

# First tools/call triggers the lazy spawn and is HELD in the FIFO (SEE-1111
# hold-to-warm): no immediate answer, no warmup hint. It stays held until the
# WARM gate opens (the 4 milestone lines below are appended AFTER spawn).
send_line "$(call_line 2)"
if wait_for "$PROXY_ERR" 'editor spawn launched' 5000; then
    ok "E1.2: spawn launched after first tools/call"
else
    ko "E1.2: proxy never ran configure+start after tools/call"
fi
# While the editor is cold the call is held — it must NOT be answered early and
# must NOT be forwarded. Sleep briefly to give a buggy hint-path time to fire.
sleep 1.5
if grep -q '"id":2' "$PROXY_OUT"; then
    ko "E1.4a: id=2 answered BEFORE warm (premature — must be held until WARM)"
else
    ok "E1.4a: id=2 held while the editor is cold (no early answer)"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "E1.4b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "E1.4b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if grep -q '"id":2' "$TMPDIR/npx.log" 2>/dev/null; then
    ko "E1.4c: id=2 forwarded to npx while the editor is cold (premature flush)"
else
    ok "E1.4c: id=2 NOT forwarded to npx while cold — held in the FIFO"
fi
if grep -q '\[godot-mcp warmup' "$PROXY_OUT"; then
    ko "E1.4d: timeline bracket appeared before warm (post-warm only)"
else
    ok "E1.4d: no timeline bracket while cold (bracket form is post-warm only)"
fi

# The fake editor boots: append the four §2.2 milestone lines. TCP_CONNECTED
# (4th pattern) doubles as the slot-acquisition record. Written after spawn so
# the offset-tail sees them.
cat >> "$EDITOR_LOG" <<'EOF'
[godot-mcp] Plugin initialized
[godot-mcp] Server listening on 127.0.0.1:6551 [localhost]
[godot-mcp] TCP connection received from 127.0.0.1:50123, awaiting WebSocket handshake...
[godot-mcp] WebSocket handshake complete
EOF

# WARM needs renderStable: with GODOT_EDITOR_LOG_FILE set, the render-stable
# monitor requires RENDER_STABLE_REQUIRED_MS=4000 of a stable swap_chain_resize
# count. The fake log has no swap_chain_resize lines at all → count stays 0 →
# stable → renderStable flips after ~4s. TCP (listener from the start mock) is
# already up, so WARM follows.
if wait_for "$PROXY_ERR" 'warm detected' 15000; then
    ok "E1.3: proxy reached WARM (tcpOk && renderStable over static fake log)"
else
    ko "E1.3: proxy never reached WARM within 15s"
fi

# The HELD call id=2 is flushed to npx on WARM and answered. Being the FIRST
# post-warm response, its result.content carries the one-line timeline
# (§7 B5 one-shot gate).
if wait_for "$PROXY_OUT" '"id":2' 8000; then
    ok "E1.4e: held id=2 flushed and answered after WARM (forwarded path, not a hint)"
else
    ko "E1.4e: no response id=2 within 8s after WARM (hold broke the flush)"
fi
if wait_for "$TMPDIR/npx.log" '"id":2' 4000; then
    ok "E1.4f: id=2 forwarded to npx after WARM (real call, flushed from the FIFO)"
else
    ko "E1.4f: id=2 never reached npx (hold broke the flush)"
fi
SNAP="$TMPDIR/e1_snap.out"; cp "$PROXY_OUT" "$SNAP"

if grep -q '\[godot-mcp warmup' "$SNAP"; then
    ok "E1.4g: first post-warm response carries the [godot-mcp warmup ...] timeline line"
else
    ko "E1.4g: timeline line missing from the post-warm response (B5 gate failed)"
fi

# E1.5/E1.6 — parse the timeline segments. Expected shape:
#   [godot-mcp warmup 5.2s | spawn→0.8s plugin→2.1s listen→2.3s tcp→2.5s ws→2.7s init→5.2s]
# spawn may be `?` (known LOW defect: stageTimestamps.EDITOR_SPAWNED never set).
TL=$(grep -o '\[godot-mcp warmup [^]]*\]' "$SNAP" | head -1)
if [[ -n "$TL" ]]; then
    note "captured timeline: $TL"
    # Extract per-stage seconds; '?' → empty so the numeric comparisons skip it.
    SPAWN=$(echo "$TL" | grep -o 'spawn→[0-9.]*s' | grep -o '[0-9.]*')
    PLUGIN=$(echo "$TL" | grep -o 'plugin→[0-9.]*s' | grep -o '[0-9.]*')
    LISTEN=$(echo "$TL" | grep -o 'listen→[0-9.]*s' | grep -o '[0-9.]*')
    TCP=$(echo "$TL" | grep -o 'tcp→[0-9.]*s' | grep -o '[0-9.]*')
    WS=$(echo "$TL" | grep -o 'ws→[0-9.]*s' | grep -o '[0-9.]*')
    INIT=$(echo "$TL" | grep -o 'init→[0-9.]*s' | grep -o '[0-9.]*')

    # The 5 log-derived stages must all be present (non-?). spawn is exempt.
    MISSING=0
    [[ -n "$PLUGIN" && -n "$LISTEN" && -n "$TCP" && -n "$WS" && -n "$INIT" ]] || MISSING=1
    if [[ "$MISSING" == "0" ]]; then
        ok "E1.5a: log-derived stages all present (plugin/listen/tcp/ws/init != '?')"
    else
        ko "E1.5a: one or more log-derived stages are '?' (plugin='$PLUGIN' listen='$LISTEN' tcp='$TCP' ws='$WS' init='$INIT')"
    fi

    # Monotonic non-decreasing: plugin≤listen≤tcp≤ws≤init.
    MONO=1
    for pair in "PLUGIN LISTEN" "LISTEN TCP" "TCP WS" "WS INIT"; do
        set -- $pair
        A=$(eval echo \$$1); B=$(eval echo \$$2)
        if [[ -n "$A" && -n "$B" ]]; then
            awk -v a="$A" -v b="$B" 'BEGIN{exit !(a <= b)}' || MONO=0
        fi
    done
    if [[ "$MONO" == "1" ]]; then
        ok "E1.5b: stage seconds monotonic non-decreasing (plugin≤listen≤tcp≤ws≤init)"
    else
        ko "E1.5b: stage seconds NOT monotonic (plugin=$PLUGIN listen=$LISTEN tcp=$TCP ws=$WS init=$INIT)"
    fi

    if [[ -z "$SPAWN" ]]; then
        note "E1.6: spawn→?s (known LOW defect: EDITOR_SPAWNED never set) — documented, not a failure"
    else
        ok "E1.6: spawn→${SPAWN}s present (no defect)"
    fi
else
    ko "E1.5/E1.6: could not extract timeline line for segment checks"
fi

# E1.7: one-shot gate — the FIRST post-warm response (held id=2) carries the
# timeline; a SECOND post-warm tools/call (id=3) must NOT (E5-b invariant at
# single-proxy level). Count across id=2 + id=3: exactly 1.
send_line "$(call_line 3)"
if wait_for "$PROXY_OUT" '"id":3' 5000; then
    ok "E1.7a: second post-warm tools/call id=3 responded"
else
    ko "E1.7a: no response id=3 within 5s"
fi
SNAP3="$TMPDIR/e1_snap3.out"; cp "$PROXY_OUT" "$SNAP3"
# Count occurrences of the timeline across BOTH post-warm responses: exactly 1.
TL_COUNT=$(grep -c '\[godot-mcp warmup' "$SNAP3" || true)
if [[ "$TL_COUNT" == "1" ]]; then
    ok "E1.7: timeline appears exactly once across id=2 + id=3 (one-shot gate)"
else
    ko "E1.7: timeline count=$TL_COUNT (expected exactly 1 — gate not one-shot)"
fi

# E1.8 (observational, Channel B, non-blocking): the progress notification
# schema carries handshakeSubstate:"complete". Recorded as a side-channel fact.
if grep -q '"method": *"notifications/progress"' "$PROXY_OUT"; then
    if grep -q '"handshakeSubstate": *"complete"' "$PROXY_OUT"; then
        note "E1.8: Channel B notifications carry handshakeSubstate=\"complete\" (side channel, not acceptance)"
    else
        note "E1.8: Channel B notifications present but handshakeSubstate not \"complete\""
    fi
else
    note "E1.8: no notifications/progress on stdout (client would swallow them; E1 still passes — E4 OK)"
fi

stop_proxy
summary
