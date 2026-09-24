#!/usr/bin/env bash
# test_see1110_e5_multi_agent_channelA.sh
#
# SEE-1110 §8 E5 — 6-agent compatibility regression, asserted on CHANNEL A,
# with SEE-1111 预热提示.
#
# SSOT §8 E5: "6 个 agent 各自端口; when: 各跑首个 tools/call; then:
#   (a) 全部成功;
#   (b) 仅首个 call 含 warmup 时间线行;
#   (c) 现有工具返回结构不被破坏。"
#
# The shipped 6-port live sweep (test_see990_live_gate_6port_sweep.sh) requires
# real Windows-side godot editors on 6551-6556; in this environment it runs with
# SEE990_SKIP_LIVE=1. This test drives the SAME assertion surface through the
# mock-seam: 6 independent proxies, each on its OWN throwaway free port, each
# cold-spawning via mock helpers and warming via its own listener. Per agent we
# issue three tools/call and assert (a)/(b)/(c) on the response bodies.
#
# Proxies are isolated processes with no shared state; the one-shot warmup gate
# is per-port/per-proxy, so running the 6 ports sequentially is a deterministic
# equivalent of the concurrent sweep for every §8 E5 assertion (and much less
# flaky than 6 parallel coprocs). Each port is genuinely distinct — a port
# conflict or leak between agents fails loudly.
#
# SEE-1111 hold-to-warm adaptation: the FIRST tools/call (id=2) triggers the
# spawn and is HELD in the FIFO until WARM (目标1) — no immediate hint, never
# forwarded while cold. On WARM it is flushed to npx, answered mock-ok, and as
# the FIRST post-warm response carries the `[godot-mcp warmup …]` timeline echo
# (one-shot B5 gate). The SECOND post-warm call (id=3) must be clean —
# preserving SSOT (a)/(b)/(c).
#
# Assertions (per agent):
#   E5.<i>.0  initialize answered.
#   E5.<i>.1  first call id=2 is HELD while the editor is cold (no early answer).
#   E5.<i>.1h no warmup-hint text anywhere (hold-to-warm, no default hint).
#   E5.<i>.1c id=2 NOT forwarded to npx while cold (held in the FIFO).
#   E5.<i>.2  proxy reached WARM (spawn completed).
#   E5.<i>.3  held id=2 flushed after WARM → success result, content contains
#             'mock-ok'.
#   E5.<i>.4  id=2 content末尾含 [godot-mcp warmup ...] timeline (first post-warm
#             response carries the one-shot echo).
#   E5.<i>.5  second post-warm call id=3 → success result, content contains 'mock-ok'.
#   E5.<i>.6  id=3 content does NOT contain the warmup timeline line (one-shot gate).
#   E5.<i>.7  timeline appears exactly once across id=2+id=3 (one-shot gate).
#   E5.6      all 6 agents: calls succeeded (aggregate (a)).
#   E5.7      all 6 agents: structure preserved — every content item is
#             {type:'text', text} (aggregate (c)).
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1110_e5_multi_agent_channelA.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

N_AGENTS=6
AGG_OK=0; AGG_STRUCT=0

sep "E5: $N_AGENTS-agent Channel A regression (6 independent ports)"

for i in $(seq 1 "$N_AGENTS"); do
    PORT=$(find_free_port)
    CFG_COUNTER="$TMPDIR/cfg${i}.count"
    START_COUNTER="$TMPDIR/start${i}.count"
    : > "$CFG_COUNTER"; : > "$START_COUNTER"
    CFG_SH=$(make_configure_mock "$CFG_COUNTER" 0 "$MOCK_WORKTREE")
    START_SH=$(make_start_mock "$START_COUNTER" 0 1)   # spawn=1 → listener on GODOT_PORT

    start_proxy \
        "GODOT_PORT=$PORT" \
        "KOL_AGENT_NAME=agent$i" \
        "KOL_WORKTREE=$MOCK_WORKTREE" \
        "KOL_CONFIGURE_SH=$CFG_SH" \
        "KOL_START_SH=$START_SH" \
        "KOL_CONFIGURE_COUNTER=$CFG_COUNTER" \
        "KOL_START_COUNTER=$START_COUNTER" \
        "KOL_WARMUP_TIMEOUT_MS=15000" \
        "KOL_HOT_WARMUP_TIMEOUT_MS=5000" \
        "KOL_PROBE_INTERVAL_MS=200" \
        "MOCK_NPX_LOG=$TMPDIR/e5_${i}_npx.log"

    send_line "$INIT_LINE"
    if wait_for "$PROXY_OUT" '"id":1' 3000; then
        ok "E5.$i.0: agent$i initialize answered"
    else
        ko "E5.$i.0: agent$i initialize not answered"
    fi

    # First tools/call triggers the spawn AND is HELD in the FIFO (SEE-1111
    # hold-to-warm 目标1) — no immediate hint, never answered by a friendly
    # warmup message. WARM flips fast here (no editor log → renderStable
    # instant; listener up from the start mock), so the held call is flushed
    # almost immediately; the assertions below are the deterministic end-state
    # (no hint text, flushed to npx, answered with the timeline).
    send_line "$(call_line 2)"
    if wait_for "$PROXY_ERR" 'editor spawn launched' 5000; then
        ok "E5.$i.1a: agent$i spawn launched after first tools/call"
    else
        ko "E5.$i.1a: agent$i spawn never launched"
    fi
    if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
        ko "E5.$i.1h: agent$i warmup-hint text appeared (default hint must be gone under 90s timeout)"
    else
        ok "E5.$i.1h: agent$i no warmup-hint text anywhere (hold-to-warm, no default hint)"
    fi

    # Wait for WARM — the held id=2 is flushed to npx on WARM and answered. Being
    # the FIRST post-warm response, it carries the one-shot timeline echo.
    if wait_for "$PROXY_ERR" 'warm detected' 12000; then
        ok "E5.$i.2: agent$i proxy reached WARM (spawn completed)"
    else
        ko "E5.$i.2: agent$i proxy never reached WARM"
    fi

    # Held id=2: flushed after WARM, forwarded to npx, answered mock-ok, and
    # carries the one-shot [godot-mcp warmup] timeline echo.
    if wait_for "$PROXY_OUT" '"id":2' 8000; then
        ok "E5.$i.3: agent$i held id=2 flushed and answered after WARM"
    else
        ko "E5.$i.3: agent$i no response id=2 within 8s after WARM"
    fi
    SNAP3="$TMPDIR/e5_${i}_snap3.out"; cp "$PROXY_OUT" "$SNAP3"
    ID3_LINE=$(grep '"id":2' "$SNAP3" | tail -1)
    if echo "$ID3_LINE" | grep -q '"result"' && echo "$ID3_LINE" | grep -q 'mock-ok'; then
        ok "E5.$i.3h: agent$i id=2 success (mock-ok preserved)"
        AGG_OK=$((AGG_OK+1))
    else
        ko "E5.$i.3h: agent$i id=2 missing success/mock-ok"
    fi
    if echo "$ID3_LINE" | grep -q '\[godot-mcp warmup'; then
        ok "E5.$i.4: agent$i first post-warm response carries the [godot-mcp warmup] timeline"
    else
        ko "E5.$i.4: agent$i id=2 missing the warmup timeline (per-port B5 gate failed)"
    fi

    # Second post-warm call id=3: must succeed WITHOUT the timeline (one-shot).
    send_line "$(call_line 3)"
    if wait_for "$PROXY_OUT" '"id":3' 6000; then
        ok "E5.$i.5: agent$i second post-warm call id=3 responded"
    else
        ko "E5.$i.5: agent$i no response id=3 within 6s"
    fi
    SNAP4="$TMPDIR/e5_${i}_snap4.out"; cp "$PROXY_OUT" "$SNAP4"
    ID4_LINE=$(grep '"id":3' "$SNAP4" | tail -1)
    if echo "$ID4_LINE" | grep -q '"result"' && echo "$ID4_LINE" | grep -q 'mock-ok'; then
        ok "E5.$i.5h: agent$i id=3 success (mock-ok preserved)"
        AGG_OK=$((AGG_OK+1))
    else
        ko "E5.$i.5h: agent$i id=3 missing success/mock-ok"
    fi
    if echo "$ID4_LINE" | grep -q '\[godot-mcp warmup'; then
        ko "E5.$i.6: agent$i second post-warm call LEAKS the warmup timeline (gate not one-shot)"
    else
        ok "E5.$i.6: agent$i id=3 clean (no warmup timeline leak)"
    fi

    # E5.7: exactly one timeline across id=2+id=3 per agent.
    TOTAL_TL=$(grep -c '\[godot-mcp warmup' "$SNAP4" || true)
    if [[ "$TOTAL_TL" == "1" ]]; then
        ok "E5.$i.7: agent$i timeline appears exactly once across id=2+id=3"
    else
        ko "E5.$i.7: agent$i timeline count=$TOTAL_TL (expected exactly 1)"
    fi

    # E5.8 structure: content must be an array of {type:'text',text} items.
    STRUCT=$(node -e '
        const fs = require("fs");
        const txt = fs.readFileSync(process.argv[1], "utf8");
        const lines = txt.split("\n").filter(l => l.includes("\"id\":3") && l.includes("\"result\""));
        if (!lines.length) { console.log("missing"); process.exit(0); }
        const msg = JSON.parse(lines[lines.length - 1]);
        const content = msg.result && msg.result.content;
        if (!Array.isArray(content) || content.length === 0) { console.log("bad-array"); process.exit(0); }
        const okItems = content.every(c => c && typeof c === "object" && c.type === "text" && typeof c.text === "string");
        console.log(okItems ? "ok" : "bad-item");
    ' "$SNAP4")
    if [[ "$STRUCT" == "ok" ]]; then
        ok "E5.$i.8: agent$i id=3 result.content is [{type:'text',text},...] (structure preserved)"
        AGG_STRUCT=$((AGG_STRUCT+1))
    else
        ko "E5.$i.8: agent$i result.content structure malformed ($STRUCT)"
    fi

    stop_proxy
done

# Aggregate (a) and (c): all 6 agents succeeded and preserved structure.
# Two forwarded tools/call successes per agent: the held first call (id=2,
# flushed after WARM) and the second post-warm call (id=3).
if [[ "$AGG_OK" == "$((N_AGENTS*2))" ]]; then
    ok "E5.6: all $N_AGENTS agents x 2 tools/call succeeded (aggregate (a))"
else
    ko "E5.6: only $AGG_OK/$((N_AGENTS*2)) calls succeeded (expected all)"
fi
if [[ "$AGG_STRUCT" == "$N_AGENTS" ]]; then
    ok "E5.7: all $N_AGENTS agents preserved result.content structure (aggregate (c))"
else
    ko "E5.7: only $AGG_STRUCT/$N_AGENTS agents preserved structure"
fi

summary
