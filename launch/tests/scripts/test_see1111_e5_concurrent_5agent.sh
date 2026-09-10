#!/usr/bin/env bash
# test_see1111_e5_concurrent_5agent.sh
#
# Rewritten under SEE-1117 Direction 3 — original asserted project.godot
# [godot_mcp] section; current asserts sidecar at <worktree>/.godot/mcp-lease.json.
# See Bachi's evidence report in issue SEE-1117 thread 643309c3.
#
# SEE-1111 目标5 (owner final plan, comment 824b6262): E5 (d)(e)(f) concurrent
# isolation regression for multi-agent godot-mcp cold start, with SEE-1111
# 预热提示.
#
# SSOT §8 E5 SEE-1111 增补: "6 agent 并发冷启动时,
#   (d) 每个 warmupDiagnostic/时间线行的 port 必须等于该 agent 专属端口且 5 份
#       端口互异 (断言解析未落到共享检出);
#   (e) 任一 agent 的 KOL_WORKTREE 指向其私有 worktree, 非共享 master 检出;
#   (f) 无 4001 / Port already in use 类槽位/端口冲突。"
#
# This test drives FIVE real proxies CONCURRENTLY — five node processes alive at
# once, each with its own KOL_WORKTREE pointing at its own private Godot-project-
# shaped checkout, each cold-spawning through a mock configure/start pair. The
# mock configure DELEGATES to the real configure-mcp-port.sh (so the private
# worktree's sidecar lease <wt>/.godot/mcp-lease.json is genuinely written and
# the write-target guard is exercised) while logging the resolved port + the
# proxy's --project-godot argument. Ports come from the agent-ports.json SSOT —
# the same table the launcher/configure/prepare-worktree read — so the asserted
# ports are the production ports.
#
# Concurrent, not sequential: the five proxies boot together, each holding a
# distinct port + private worktree. A port collision, worktree cross-talk, or a
# resolve landing on the shared master fails loudly.
#
# SEE-1111 hold-to-warm (目标1) adaptation: the first tools/call id=2 is HELD in
# the FIFO until the warmup gate opens, then flushed to npx and answered with a
# real result — no warmup hint. The (d)/(e) post-spawn assertions (configure log,
# sidecar lease state) wait for 'warm detected' (which proves the spawn
# completed) before reading those files.
#
# Assertions:
#   D1/D1h  per agent: first tools/call id=2 answered after WARM (held →
#           flushed, no hint text, no premature flush).
#   D1i     per agent: held id=2 flushed to the agent's own npx log.
#   D1w     per agent: proxy reached WARM (spawn completed) before the (d)/(e)
#           file reads.
#   (d) port equality + distinctness — each proxy's configure helper received
#       --port <SSOT port> AND its private worktree sidecar lease was written
#       with state=active + port=<SSOT port>; the 5 captured ports are mutually
#       distinct. This proves resolution did NOT fall onto the shared checkout
#       (two agents landing on one shared sidecar would collide on the same port
#       / file and the write-target guard would fail-fast).
#   (e) each proxy's resolved worktree == its own private worktree (proxy passed
#       --project-godot <private-wt>/project.godot to configure; no shared-master
#       path in any proxy log).
#   (f) no 4001 / Port already in use / port conflict markers in any proxy log;
#       all 5 mock configure calls fired (each agent's cold start completed).
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1111_e5_concurrent_5agent.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

CONFIGURE="$REPO_ROOT/launch/configure-mcp-port.sh"
PORTS_JSON="$REPO_ROOT/launch/agent-ports.json"
KNOWN_SHARED="/mnt/d/GodotProjects/king-of-likes"

# The 5 MCP agents (SSOT agent-ports.json .agents). Chekky does not participate.
AGENTS=(Atlas Archi Bachi Fronti Revy)

# ---- read the SSOT ports (same table the launcher/configure/prepare read) ----
declare -A SSOT=()
for a in "${AGENTS[@]}"; do
    p="$(jq -r --arg n "$a" '.agents[$n]' "$PORTS_JSON")"
    SSOT["$a"]="$p"
done

# ---- five private worktrees, each a real git checkout carrying the launch
#      toolchain (resolveWorktreeForSpawn discriminator) + a project.godot anchor
#      (Direction 3: project.godot is git-tracked; configure writes the per-
#      worktree sidecar at <wt>/.godot/mcp-lease.json instead of editing
#      project.godot). Branch=feature/<agent> so the write-target guard passes. ----
declare -A WT=()
for a in "${AGENTS[@]}"; do
    wt="$TMPDIR/agent_${a}/KingOfLikes-Godot"
    mkdir -p "$wt/launch"
    git -C "$wt" init -q 2>/dev/null || true
    git -C "$wt" config user.email "test@example.com" 2>/dev/null || true
    git -C "$wt" config user.name "Test" 2>/dev/null || true
    git -C "$wt" checkout -qb "feature/$a" 2>/dev/null || git -C "$wt" branch -m "feature/$a" 2>/dev/null || true
    # Direction 3: project.godot carries no port state — only the sidecar does.
    # Use the HEAD shape (config_version + [godot_mcp] empty section + bind).
    printf 'config_version=5\n\n[godot_mcp]\n\nbind_mode=1\ncustom_bind_ip=""\n' > "$wt/project.godot"
    touch "$wt/launch/.marker"
    git -C "$wt" add -A >/dev/null 2>&1 || true
    git -C "$wt" commit -qm "clean baseline" >/dev/null 2>&1 || true
    WT["$a"]="$wt"
done

# Read a sidecar field via node (no jq dependency — matches the toolchain and the
# SEE-1117 Suite A reference). Returns '' on missing file/field/malformed JSON.
sidecar_field() {
    local sc="$1" f="$2"
    [ -f "$sc" ] || { echo ''; return; }
    SIDE_FIELD="$f" node -e '
        let raw = "";
        process.stdin.on("data", c => raw += c);
        process.stdin.on("end", () => {
            try {
                const o = JSON.parse(raw);
                const v = o[process.env.SIDE_FIELD];
                process.stdout.write(v === null || v === undefined ? "" : String(v));
            } catch (e) { process.stdout.write(""); }
        });
    ' < "$sc" 2>/dev/null
}

# ---- mock configure that logs the proxy's resolved port + --project-godot arg,
#      then delegates to the REAL configure (private worktree gets rewritten) ----
CONF_LOGS=()
for a in "${AGENTS[@]}"; do
    log="$TMPDIR/conf_${a}.log"; : > "$log"
    CONF_LOGS+=("$log")
    sh="$TMPDIR/conf_${a}.sh"
    cat > "$sh" <<EOF
#!/usr/bin/env bash
{
    echo "configure-agent=${a} GODOT_PORT=\${GODOT_PORT:-UNSET}"
    echo "args=\$*"
} >> "\$KOL_CONF_LOG"
exec bash "$CONFIGURE" "\$@"
EOF
    chmod +x "$sh"
done

# ---- start mock: spawn a TCP listener on GODOT_PORT so the proxy's warmup
#      probe completes (mirrors the editor binding its WS port) ----
START_SH="$TMPDIR/mock-start.sh"
cat > "$START_SH" <<EOF
#!/usr/bin/env bash
echo "start rc=0 GODOT_PORT=\${GODOT_PORT:-UNSET}" >> "\${KOL_START_LOG:-/dev/null}"
if [[ -n "\${GODOT_PORT:-}" ]]; then
    nohup env "LISTEN_PORT=\${GODOT_PORT}" node "$LISTENER_SCRIPT" </dev/null >/dev/null 2>"$TMPDIR/listener-start-err.log" &
    disown || true
fi
exit 0
EOF
chmod +x "$START_SH"

sep "SEE-1111 目标5: E5 (d)(e)(f) — 5-agent concurrent cold start"

# ---- launch all 5 proxies CONCURRENTLY via per-agent stdin FIFOs (real
#      concurrent processes, no coproc-array fragility) ----
declare -A P_OUT=() P_ERR=() P_PID=() FD=()
for a in "${AGENTS[@]}"; do
    P_OUT["$a"]="$TMPDIR/proxy_${a}.out"; : > "${P_OUT[$a]}"
    P_ERR["$a"]="$TMPDIR/proxy_${a}.err"; : > "${P_ERR[$a]}"
    mkfifo "$TMPDIR/in_${a}"
    env \
        "GODOT_HOST=127.0.0.1" \
        "PATH=$MOCK_NPX_DIR:$PATH" \
        "MOCK_NPX_SCRIPT_DIR=$TMPDIR" \
        "KOL_DIRECT_GODOT_MCP=0" \
        "GODOT_PORT=${SSOT[$a]}" \
        "KOL_AGENT_NAME=$a" \
        "KOL_WORKTREE=${WT[$a]}" \
        "KOL_PROJECT_GODOT=${WT[$a]}/project.godot" \
        "KOL_CONFIGURE_SH=$TMPDIR/conf_${a}.sh" \
        "KOL_START_SH=$START_SH" \
        "KOL_CONF_LOG=$TMPDIR/conf_${a}.log" \
        "KOL_START_LOG=$TMPDIR/start_${a}.log" \
        "KOL_WARMUP_TIMEOUT_MS=15000" \
        "KOL_HOT_WARMUP_TIMEOUT_MS=5000" \
        "KOL_PROBE_INTERVAL_MS=200" \
        "MOCK_NPX_LOG=$TMPDIR/npx_${a}.log" \
        node "$PROXY" < "$TMPDIR/in_${a}" > "${P_OUT[$a]}" 2> "${P_ERR[$a]}" &
    P_PID["$a"]=$!
    # Hold the FIFO open read-write so the proxy never sees stdin EOF until we
    # close the fd at teardown.
    exec {fd}<>"$TMPDIR/in_${a}"
    FD["$a"]=$fd
done

send_to() { printf '%s\n' "$2" >&"${FD[$1]}" 2>/dev/null || true; }
stop_all_proxies() {
    for a in "${AGENTS[@]}"; do
        if [[ -n "${FD[$a]:-}" ]]; then eval "exec ${FD[$a]}>&-" 2>/dev/null || true; fi
        if [[ -n "${P_PID[$a]:-}" ]]; then kill -9 "${P_PID[$a]}" 2>/dev/null || true; wait "${P_PID[$a]}" 2>/dev/null || true; fi
    done
}
# Chain on to lib_init's cleanup (kills the start-mock listeners + rm -rf the
# TMPDIR). Overriding the trap WITHOUT this chain leaks the listeners that the
# start mocks spawn on 6551-6555, which makes the NEXT run hot-reuse every port
# and skip the start helper (F4 false-fail).
trap 'stop_all_proxies; cleanup' EXIT

# ---- initialize every proxy, then fire the first tools/call concurrently ----
for a in "${AGENTS[@]}"; do send_to "$a" "$INIT_LINE"; done
for a in "${AGENTS[@]}"; do
    if wait_for "${P_OUT[$a]}" '"id":1' 5000; then
        ok "D0.$a: initialize answered"
    else
        ko "D0.$a: initialize not answered"
    fi
done

# SEE-1111 hold-to-warm (目标1) adaptation: the first tools/call id=2 is HELD in
# the FIFO until the warmup gate opens, then flushed to npx and answered with a
# real result — no warmup hint, no premature flush. The async configure/start
# spawn is still in flight while id=2 is held, so the (d)/(e) configure-log and
# project.godot assertions must wait for WARM (which proves the spawn completed)
# before reading them. Each agent's held id=2 must flush to its OWN proxy's npx
# (per-agent npx log) and be answered — proving concurrent first calls each wait
# for warm and succeed, not each emitting a hint.
for a in "${AGENTS[@]}"; do send_to "$a" "$(call_line 2)"; done
for a in "${AGENTS[@]}"; do
    if wait_for "${P_OUT[$a]}" '"id":2' 12000; then
        ok "D1.$a: first tools/call id=2 answered after WARM (held → flushed)"
    else
        ko "D1.$a: no response id=2 within 12s"
    fi
    if grep -q 'editor 正在预热中（冷启动约需 60s）' "${P_OUT[$a]}"; then
        ko "D1h.$a: warmup-hint text appeared (default hint must be gone under 90s timeout)"
    else
        ok "D1h.$a: no warmup-hint text anywhere (hold-to-warm, no default hint)"
    fi
    if wait_for "$TMPDIR/npx_${a}.log" '"id":2' 4000; then
        ok "D1i.$a: held id=2 flushed to npx after WARM (per-agent hold → flush)"
    else
        ko "D1i.$a: id=2 never reached npx (hold broke the flush)"
    fi
    # (d)/(e) read post-spawn state — wait for WARM before asserting.
    if wait_for "${P_ERR[$a]}" 'warm detected' 12000; then
        ok "D1w.$a: proxy reached WARM (spawn completed)"
    else
        ko "D1w.$a: proxy never reached WARM"
    fi
done

# ---- (d) per-agent resolved port == SSOT port, and 5 ports distinct ----
sep "(d) per-agent resolved port == SSOT port; 5 ports distinct"
declare -A CAPTURED=()
for a in "${AGENTS[@]}"; do
    if grep -q "configure-agent=${a} GODOT_PORT=${SSOT[$a]}" "$TMPDIR/conf_${a}.log" 2>/dev/null; then
        ok "D2.$a: mock configure received GODOT_PORT=${SSOT[$a]}"
        CAPTURED["$a"]="${SSOT[$a]}"
    else
        ko "D2.$a: mock configure did not receive GODOT_PORT=${SSOT[$a]} (log: $(cat "$TMPDIR/conf_${a}.log" 2>/dev/null))"
    fi
    # Direction 3: write landed in the PRIVATE sidecar at <wt>/.godot/mcp-lease.json
    # with state=active + port=<SSOT port> — replaces the old project.godot rewrite.
    SC="${WT[$a]}/.godot/mcp-lease.json"
    SC_STATE="$(sidecar_field "$SC" state)"
    SC_PORT="$(sidecar_field "$SC" port)"
    SC_LID="$(sidecar_field "$SC" lease_id)"
    if [[ "$SC_STATE" == "active" && "$SC_PORT" == "${SSOT[$a]}" && -n "$SC_LID" ]]; then
        ok "D3.$a: private worktree sidecar state=active port=${SSOT[$a]} (write landed in PRIVATE wt)"
    else
        ko "D3.$a: private worktree sidecar not active@${SSOT[$a]} (state=${SC_STATE:-<empty>} port=${SC_PORT:-<empty>} lease_id=${SC_LID:-<empty>})"
    fi
done
UNIQ=$(printf '%s\n' "${CAPTURED[@]}" | sort -u | grep -c '^[0-9]*$' || true)
if [[ "$UNIQ" == "5" ]]; then
    ok "D4: 5 captured ports are mutually distinct"
else
    ko "D4: expected 5 distinct ports, got $UNIQ (a collision would mean two agents shared one checkout/port)"
fi

# ---- (e) each proxy's KOL_WORKTREE resolved to its own private worktree ----
sep "(e) KOL_WORKTREE -> private worktree (not the shared master checkout)"
for a in "${AGENTS[@]}"; do
    if grep -q -- "--project-godot ${WT[$a]}/project.godot" "$TMPDIR/conf_${a}.log" 2>/dev/null; then
        ok "E1.$a: proxy passed --project-godot ${WT[$a]}/project.godot to configure"
    else
        ko "E1.$a: configure args missing the private worktree path"
    fi
    if grep -q -- "$KNOWN_SHARED" "${P_ERR[$a]}" 2>/dev/null; then
        ko "E2.$a: proxy log references the SHARED master path"
    else
        ok "E2.$a: no shared-master reference in proxy log"
    fi
done

# ---- (f) no 4001 / Port already in use / port conflict markers ----
sep "(f) no 4001 / Port already in use conflicts"
CONFLICTS=0
for a in "${AGENTS[@]}"; do
    if grep -qi '4001\|Port already in use' "${P_ERR[$a]}" 2>/dev/null \
        || grep -qi '4001\|Port already in use' "${P_OUT[$a]}" 2>/dev/null; then
        ko "F1.$a: port/slot conflict marker found"
        CONFLICTS=$((CONFLICTS+1))
    fi
done
if [[ "$CONFLICTS" == "0" ]]; then
    ok "F2: no 4001 / Port already in use markers across all 5 proxies"
else
    ko "F2: $CONFLICTS agent(s) showed a port conflict marker"
fi
# All 5 mock configure calls fired => each agent's cold start ran to completion.
CFG_FIRED=0
for a in "${AGENTS[@]}"; do
    [[ -s "$TMPDIR/conf_${a}.log" ]] && CFG_FIRED=$((CFG_FIRED+1))
done
if [[ "$CFG_FIRED" == "5" ]]; then
    ok "F3: all 5 agents' configure fired (cold start completed per agent)"
else
    ko "F3: only $CFG_FIRED/5 agents' configure fired"
fi
# All 5 start mocks fired.
START_FIRED=0
for a in "${AGENTS[@]}"; do
    [[ -s "$TMPDIR/start_${a}.log" ]] && START_FIRED=$((START_FIRED+1))
done
if [[ "$START_FIRED" == "5" ]]; then
    ok "F4: all 5 agents' start mock fired (editor spawn per agent)"
else
    ko "F4: only $START_FIRED/5 agents' start mock fired"
fi

stop_all_proxies
summary
