#!/usr/bin/env bash
# test_see1111_warmup_hint.sh
#
# SEE-1111 hold-to-warm (replaces the removed default warmup hint) — the first
# tools/call is HELD in the proxy's FIFO until the editor warms, then flushed to
# npx and answered; the warmup-hint text is only the 90s-window TIMEOUT fallback.
#
# Owner requirements (Atlas comment, SEE-1111):
#   目标1: under the fork's 90s QUICK_TIMEOUT the first tools/call is HELD in the
#          proxy's FIFO while the editor warms — NO warmup hint is emitted. The
#          agent sees its first call succeed directly (~27s cold boot).
#   目标2: if warmup EXCEEDS the 90s window (editor never warms), the held call is
#          answered with a retryable timeout diagnostic (recovering) — the hint
#          is the timeout fallback, NOT the default.
#   目标3: edge cases unchanged:
#          - the held call is NOT answered directly by the proxy; it is forwarded
#            to npx after WARM and answered there;
#          - the held call does NOT carry the warmup-hint text unless it timed out;
#          - no hint text EVER appears once WARM (editor 可用的时候秒连);
#          - the first POST-WARM response still carries the one-line
#            `[godot-mcp warmup …]` stage-timeline echo (B5, reserved for it).
#
# Scenario: cold port, mock configure+start (start spawns the WS-completing mock
# listener). id=2 triggers the spawn and is HELD; id=3 (sent immediately after)
# also lands while warming and is HELD behind id=2. After WARM, both are flushed
# in order to npx and answered mock-ok. A second proxy warms up only past the
# window (no listener) → the held call is answered with the retryable timeout.
#
# Assertions:
#   W1  initialize answered; spawn NOT triggered by initialize.
#   W2  first tools/call id=2 is HELD (no response while warming).
#   W3  [目标1] NO warmup-hint text (冷启动约需 60s) anywhere in the proxy output
#       during the hold — the default hint is gone.
#   W4  [目标2] id=2 is flushed to npx after WARM and answered mock-ok.
#   W5  [目标2] id=3 (second held call) is flushed AFTER id=2 and answered mock-ok.
#   W6  the held calls reached npx (npx.log contains both ids).
#   W7  the first POST-WARM response (id=2) carries the one-line
#       `[godot-mcp warmup …]` stage-timeline echo (B5 reserved form).
#   W8  误报防护: no 冷启动约需 60s text anywhere after WARM.
#   W9  [目标2 timeout fallback] a cold proxy with NO listener (warmup window
#       exhausted) answers the held call with a retryable recovering diagnostic.
#   W10 误报防护: a post-warm call is answered mock-ok, never a hint.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1111_warmup_hint.sh

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

CFG_SH=$(make_configure_mock "$CFG_COUNTER" 0)
# Slow-start mock: sleeps 2.5s before spawning the WS-completing listener, so
# the hold window is observable — id=2/id=3 land while the editor is genuinely
# warming and must be HELD (no answer, no hint) until WARM.
START_SH="$TMPDIR/slow-start.sh"
cat > "$START_SH" <<EOF
#!/usr/bin/env bash
echo x >> "\${KOL_START_COUNTER:-$START_COUNTER}"
sleep 2.5
nohup env "LISTEN_PORT=\${GODOT_PORT}" node "$LISTENER_SCRIPT" </dev/null >/dev/null 2>"$TMPDIR/listener-start.err" &
disown || true
exit 0
EOF
chmod +x "$START_SH"

sep "H: SEE-1111 hold-to-warm — first call held, flushed on WARM, no hint"
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
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

# W1 — initialize answers immediately, spawn NOT triggered by initialize.
send_line "$INIT_LINE"
if wait_for "$PROXY_OUT" '"id":1' 1500; then
    ok "W1a: initialize answered < 1.5s"
else
    ko "W1a: initialize not answered in 1.5s"
fi
CFG_AFTER_INIT=$(count_lines "$CFG_COUNTER")
START_AFTER_INIT=$(count_lines "$START_COUNTER")
if [[ "$CFG_AFTER_INIT" == "0" && "$START_AFTER_INIT" == "0" ]]; then
    ok "W1b: configure/start not invoked by initialize (lazy spawn intact)"
else
    ko "W1b: initialize triggered spawn (cfg=$CFG_AFTER_INIT start=$START_AFTER_INIT)"
fi

# Fire id=2 (spawn trigger) AND id=3 (second warming call) back-to-back so both
# land while the editor is still warming. Both must be HELD (no response yet).
send_line "$(call_line 2)"
send_line "$(call_line 3)"

# W2 — id=2 must NOT be answered while warming (held in the FIFO). The slow-start
# mock delays the listener by 2.5s, so a 1.5s window proves the hold: no early
# answer, no hint.
if wait_for "$PROXY_OUT" '"id":2' 1500; then
    ko "W2: id=2 answered while warming — should be HELD, not answered early"
else
    ok "W2: id=2 is HELD while warming (no early response — hold-to-warm)"
fi

# W3 [目标1] — NO warmup-hint text anywhere yet (the default hint is removed).
if grep -q '冷启动约需 60s' "$PROXY_OUT"; then
    ko "W3: warmup-hint text appeared while warming (default hint must be gone)"
else
    ok "W3: no warmup-hint text during the hold (default hint removed)"
fi

# W4 — proxy reaches WARM, then id=2 is flushed to npx and answered mock-ok.
if wait_for "$PROXY_ERR" 'warm detected' 8000; then
    ok "W4a: proxy reached WARM (spawn completed)"
else
    ko "W4a: proxy never reached WARM"
fi
if wait_for "$PROXY_OUT" '"id":2' 6000; then
    ok "W4b: held id=2 flushed and answered after WARM"
else
    ko "W4b: id=2 never answered after WARM (hold broken)"
fi
if grep -q '"id":2.*mock-ok' "$PROXY_OUT"; then
    ok "W4c: id=2 answered by npx (mock-ok) — the first call succeeded directly"
else
    ko "W4c: id=2 not answered by npx (mock-ok missing)"
fi

# W5 — id=3 (second held call) flushed after id=2 and answered mock-ok.
if wait_for "$PROXY_OUT" '"id":3' 4000; then
    ok "W5a: held id=3 flushed and answered after WARM"
else
    ko "W5a: id=3 never answered after WARM"
fi
if grep -q '"id":3.*mock-ok' "$PROXY_OUT"; then
    ok "W5b: id=3 answered by npx (mock-ok)"
else
    ko "W5b: id=3 not answered by npx (mock-ok missing)"
fi

# W6 — both held calls reached npx (they were flushed, not dropped).
if grep -q '"id":2' "$TMPDIR/npx.log" 2>/dev/null && grep -q '"id":3' "$TMPDIR/npx.log" 2>/dev/null; then
    ok "W6: both held calls forwarded to npx (FIFO flush intact)"
else
    ko "W6: held calls not forwarded to npx (id=2/id=3 missing from npx.log)"
fi

# W7 — the first POST-WARM response (id=2) carries the one-line stage-timeline
# echo (`[godot-mcp warmup …]` bracket form, reserved for that call).
if grep -q '\[godot-mcp warmup' "$PROXY_OUT"; then
    ok "W7: first post-warm response carries the reserved [godot-mcp warmup ...] echo"
else
    ko "W7: missing the [godot-mcp warmup ...] echo on the first post-warm response"
fi

# W8 — 误报防护: no hint text anywhere after WARM.
if grep -q '冷启动约需 60s' "$PROXY_OUT"; then
    ko "W8: warmup-hint text appeared after WARM (误报防护 violated)"
else
    ok "W8: no hint text after WARM (误报防护 honored)"
fi

# W10 — a fresh post-warm call is answered mock-ok, never a hint.
send_line "$(call_line 5)"
if wait_for "$PROXY_OUT" '"id":5' 4000; then
    ok "W10a: post-warm id=5 produced a response"
else
    ko "W10a: no response id=5 after warm"
fi
if grep -q '"id":5.*mock-ok' "$PROXY_OUT" && ! grep -q '"id":5.*冷启动约需 60s' "$PROXY_OUT"; then
    ok "W10b: id=5 answered by npx (mock-ok) — never a hint once WARM"
else
    ko "W10b: id=5 not answered mock-ok / got hint text"
fi

stop_proxy

# ---------------------------------------------------------------------------
# W9 [目标2] — timeout fallback: cold port, NO listener → warmup window exhausts.
# The held call is answered with a retryable recovering diagnostic (not hung).
# ---------------------------------------------------------------------------
sep "H9: [目标2] warmup window exhausted → held call answered with retryable timeout"
T2_PORT=$(find_free_port)
start_proxy \
    "GODOT_PORT=$T2_PORT" \
    "KOL_WARMUP_TIMEOUT_MS=3000" \
    "KOL_FAILED_EXIT_MS=30000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "MOCK_NPX_LOG=$TMPDIR/t2_npx.log"
send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 3000 || ko "W9.pre: initialize not answered"
send_line "$(call_line 7)"
# The call is held; within the 3s window it must NOT be answered with a hint.
if wait_for "$PROXY_OUT" '"id":7' 1500; then
    ko "W9a: id=7 answered within the warmup window (should be held until timeout)"
else
    ok "W9a: id=7 held during the warmup window (no early answer)"
fi
# After the 3s window, the held call is answered with a retryable diagnostic.
if wait_for "$PROXY_OUT" '"id":7' 5000; then
    ok "W9b: held id=7 answered after the warmup window (timeout fallback)"
else
    ko "W9b: id=7 never answered after the warmup window (hang)"
fi
if grep -q '"id":7.*"error"' "$PROXY_OUT" && grep -q '"state": *"recovering"' "$PROXY_OUT"; then
    ok "W9c: id=7 answered with a retryable recovering error (目标2 fallback)"
else
    ko "W9c: id=7 not a retryable recovering error"
fi
if grep -q '"id":7' "$TMPDIR/t2_npx.log" 2>/dev/null; then
    ko "W9d: id=7 forwarded to npx before warm (should never reach npx)"
else
    ok "W9d: id=7 never reached npx (rejected by the timeout fallback)"
fi
stop_proxy

summary
