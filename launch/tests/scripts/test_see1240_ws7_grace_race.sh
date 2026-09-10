#!/usr/bin/env bash
# test_see1240_ws7_grace_race.sh — WS-7 regression: grace-race guard (slow-bind
# editor eviction + warm-cache respawn).
#
# The vendored addon arms its 300s initial lease grace at plugin init — BEFORE
# the port is bound. On a first boot with a cold import cache the editor can
# burn most of that grace before the client's WS connect chain (30s) lands; a
# miss means editor self-exit and the slow-client loop. The proxy cannot touch
# the addon (vendored red line), so the Layer-2 guard measures the bind delay
# (SERVER_LISTENING − EDITOR_SPAWNED) at the WARM gate and, past
# KOL_GRACE_RACE_BIND_S, evicts the slow-bind editor and respawns against the
# now-warm import cache — the fresh editor binds fast and the held calls flush
# with full addon grace.
#
# Cases (mock start-godot-editor delays the listener to fake a slow import):
#   G1 (green)  bind delay > threshold → GRACE_RACE_GUARD stage log, evict +
#               respawn, second editor binds fast, held call flushed, proxy
#               survives. Editor spawn count == 2.
#   G2 (red)    KOL_GRACE_RACE_GUARD=0 → legacy behavior: the slow-bind editor
#               is accepted as-is (no guard log, exactly 1 spawn) — the seam
#               for operators and the red side of the contrast.
#   G3          one-shot within a round: a persistently slow mock does NOT
#               loop evictions (guard fires at most once per round; proxy
#               accepts the second editor regardless).
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1240_ws7_grace_race.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

CFG_COUNTER="$TMPDIR/cfg.count"
START_COUNTER="$TMPDIR/start.count"
: > "$CFG_COUNTER"; : > "$START_COUNTER"
CFG_SH=$(make_configure_mock "$CFG_COUNTER" 0)
# No-op reap mock: evictStaleHolder runs the REAL reap-stale-leases.sh, whose
# full-workspace pwsh sweeps take 15-45s on this machine and are irrelevant to
# the guard logic under test. KOL_REAP_SH is the proxy's own test seam.
REAP_SH=$(mktemp); cat > "$REAP_SH" <<'EOG'
#!/usr/bin/env bash
exit 0
EOG
chmod +x "$REAP_SH"

# make_slow_start_mock <counter> <delay_s> — start mock that binds the listener
# AFTER <delay_s> seconds (fake cold-import editor), rc=0.
make_slow_start_mock() {
    local counter="$1" delay="$2"
    local sh="$TMPDIR/mock-slow-start.sh"
    cat > "$sh" <<EOF
#!/usr/bin/env bash
echo x >> "\${KOL_START_COUNTER:-$counter}"
if [[ -n "\${GODOT_PORT:-}" ]]; then
    ( sleep "$delay"; nohup env "LISTEN_PORT=\${GODOT_PORT}" node "$LISTENER_SCRIPT" </dev/null >/dev/null 2>"$TMPDIR/listener-slow.err" & ) >/dev/null 2>&1
fi
exit 0
EOF
    chmod +x "$sh"
    echo "$sh"
}

wait_spawn_count() {
    local counter="$1" n="$2" waited=0
    while (( waited < 30000 )); do
        [[ "$(count_lines "$counter")" -ge "$n" ]] && return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    return 1
}

# ---- G1 (green): slow bind → guard evicts → warm-cache respawn → flush ----
sep "G1: slow-bind editor evicted, warm-cache respawn completes warm"
PORT=$(find_free_port)
: > "$START_COUNTER"
START_SH=$(make_slow_start_mock "$START_COUNTER" 3)   # 3s fake import; threshold 2s
start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG_COUNTER" \
    "KOL_START_COUNTER=$START_COUNTER" \
    "KOL_WARMUP_TIMEOUT_MS=60000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "KOL_GRACE_RACE_BIND_S=2" \
    "KOL_REAP_SH=$REAP_SH" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "G1.pre: initialize not answered"
send_line "$(call_line 2)"

if wait_for "$PROXY_ERR" 'GRACE_RACE_GUARD' 30000; then
    ok "G1.1: guard fired on slow bind (GRACE_RACE_GUARD stage log)"
else
    ko "G1.1: guard did not fire for a 3s bind with a 2s threshold"
fi
if wait_spawn_count "$START_COUNTER" 2; then
    ok "G1.2: editor respawned exactly once more (spawn count=2, warm-cache respawn)"
else
    ko "G1.2: editor not respawned (count=$(count_lines "$START_COUNTER"))"
fi
if wait_for "$PROXY_OUT" '"id":2' 45000; then
    ok "G1.3: held call flushed after the fast second editor warmed"
else
    ko "G1.3: held call id=2 never flushed"
fi
if proxy_alive; then
    ok "G1.4: proxy survived the evict+respawn cycle"
else
    ko "G1.4: proxy died during grace-race recovery"
fi
sleep 0.5
if [[ "$(count_lines "$START_COUNTER")" -le 3 ]]; then
    ok "G1.5: no eviction loop (spawn count stable at ≤3; one-shot guard held)"
else
    ko "G1.5: eviction loop suspected (spawn count=$(count_lines "$START_COUNTER"))"
fi
stop_proxy

# ---- G2 (red): guard disabled → legacy single-spawn, no guard log ----
sep "G2: KOL_GRACE_RACE_GUARD=0 → legacy red side (slow editor accepted)"
PORT2=$(find_free_port)
START2="$TMPDIR/start2.count"; : > "$START2"
START_SH2=$(make_slow_start_mock "$START2" 3)
start_proxy \
    "GODOT_PORT=$PORT2" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH2" \
    "KOL_CONFIGURE_COUNTER=$CFG_COUNTER" \
    "KOL_START_COUNTER=$START2" \
    "KOL_WARMUP_TIMEOUT_MS=60000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "KOL_GRACE_RACE_BIND_S=2" \
    "KOL_GRACE_RACE_GUARD=0" \
    "KOL_REAP_SH=$REAP_SH" \
    "MOCK_NPX_LOG=$TMPDIR/npx2.log"
send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "G2.pre: initialize not answered"
send_line "$(call_line 2)"
if wait_for "$PROXY_OUT" '"id":2' 45000; then
    ok "G2.1: legacy path still warms and flushes (slow editor accepted)"
else
    ko "G2.1: legacy path failed to warm"
fi
sleep 0.5
if [[ "$(count_lines "$START2")" -eq 1 ]] && ! grep -q 'GRACE_RACE_GUARD' "$PROXY_ERR"; then
    ok "G2.2: red side confirmed — exactly 1 spawn, no guard (修复前行为可复现)"
else
    ko "G2.2: red side broken (count=$(count_lines "$START2"))"
fi
stop_proxy

# ---- G3: persistent slowness does NOT loop the guard ----
sep "G3: persistently slow mock — guard fires once, no eviction loop"
PORT3=$(find_free_port)
START3="$TMPDIR/start3.count"; : > "$START3"
START_SH3=$(make_slow_start_mock "$START3" 3)   # ALWAYS slow
start_proxy \
    "GODOT_PORT=$PORT3" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH3" \
    "KOL_CONFIGURE_COUNTER=$CFG_COUNTER" \
    "KOL_START_COUNTER=$START3" \
    "KOL_WARMUP_TIMEOUT_MS=60000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "KOL_GRACE_RACE_BIND_S=2" \
    "KOL_REAP_SH=$REAP_SH" \
    "MOCK_NPX_LOG=$TMPDIR/npx3.log"
send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "G3.pre: initialize not answered"
send_line "$(call_line 2)"
wait_spawn_count "$START3" 2 || true
sleep 6   # give a would-be loop plenty of rope
if [[ "$(count_lines "$START3")" -eq 2 ]] && [[ "$(grep -c 'GRACE_RACE_GUARD' "$PROXY_ERR")" -eq 1 ]]; then
    ok "G3.1: guard fired exactly once across the persistently slow round (no loop)"
else
    ko "G3.1: guard looped or under-fired (spawns=$(count_lines "$START3"), logs=$(grep -c 'GRACE_RACE_GUARD' "$PROXY_ERR"))"
fi
stop_proxy

summary
