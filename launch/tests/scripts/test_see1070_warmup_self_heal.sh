#!/usr/bin/env bash
# test_see1070_warmup_self_heal.sh
#
# SEE-1070 #2 warmup state machine + SEE-1111 hold-to-warm adaptation.
#
# Archi spec `189be0a2`: COLD → WARMING → WARM / RECOVERING → FAILED_EXIT.
# The proxy's warmup state machine was implemented (SEE-1070); SEE-1111 目标1
# (hold-to-warm) then changed what happens to a tools/call that lands while the
# editor is COLD-WARMING: it is HELD in the FIFO (never answered with a hint,
# never forwarded). At the warmup-window expiry (SEE-1111 目标2) the held call
# is answered with a retryable recovering diagnostic instead of hanging. This
# adaptation preserves the state-machine anchors while asserting the
# hold-to-warm + timeout-fallback semantics:
#
#   T2  KOL_WARMUP_TIMEOUT_MS=2000, no listener → after timeout proxy does NOT
#       exit, enters RECOVERING; the held first call is answered with the
#       recovering diagnostic (not a hint, not a hang).
#   T3  during RECOVERING start a real listener → proxy goes WARM; the warm
#       flush gate releases zero queued calls (the timeout already drained the
#       held call) — the warm detection log + a post-warm forwarded call prove
#       the recovery.
#   T4  KOL_WARMUP_TIMEOUT_MS=2000 + KOL_FAILED_EXIT_MS=4000, no listener ever →
#       ~4s after entering RECOVERING proxy exits(1) after rejectQueue.
#   #4  npx death during RECOVERING still cold-respawns (counter continues, no
#       reset; proxy survives) — respawn dimension independent of warmup reset.
#   #5  in RECOVERING a NEW tools/call is immediately rejected with a diagnostic
#       error carrying data.state="recovering" (not enqueued, not hung).
#
# Methodology: drive the proxy directly (not via the launcher) with a
# controllable mock-npx on PATH and a controllable TCP listener on GODOT_PORT,
# so we can present/remove the "editor is listening" signal mid-run. Behavioral
# black-box assertions on the proxy's stdout (JSON-RPC) + stderr (logs).
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1070_warmup_self_heal.sh

set -uo pipefail
# A write to a coproc pipe whose reader (the proxy) already exited would deliver
# SIGPIPE and kill the test harness mid-suite. Ignore it so such a write fails
# gracefully (caught by wait_for / proxy_alive) instead of aborting the run.
trap '' PIPE

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
FAILS=()

ok()   { echo -e "  ${GREEN}[PASS]${NC} $*"; PASS=$((PASS+1)); }
ko()   { echo -e "  ${RED}[FAIL]${NC} $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }
sep()  { echo; echo -e "${CYAN}--- $* ---${NC}"; }
note() { echo -e "  ${YELLOW}[note]${NC} $*"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PROXY="$REPO_ROOT/launch/godot-mcp-proxy.mjs"

[[ -f "$PROXY" ]] || { echo "FATAL: $PROXY not found" >&2; exit 2; }

TMPDIR="$(mktemp -d)"
cleanup() {
    # Best-effort kill of any stray listeners/proxies we spawned.
    pkill -f "$TMPDIR/ws-mock-listener.mjs" 2>/dev/null || true
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

# The proxy validates GODOT_PORT against 6000-65535 (isValidPort) and
# process.exit(1)s otherwise. The OS ephemeral range (typically 32768-60999) is
# almost entirely OUTSIDE that window, so a bare bind-to-0 port would make the
# proxy exit at startup and turn every downstream probe into a silent no-op.
# Scan the valid window only.
find_free_port() {
    python3 - <<'PY'
import socket, random
ports = list(range(6000, 65536))
random.shuffle(ports)
for p in ports:
    try:
        s = socket.socket()
        s.bind(('127.0.0.1', p))
        s.close()
        print(p)
        break
    except OSError:
        continue
else:
    raise SystemExit('no free port in 6000-65535')
PY
}

# ---------------------------------------------------------------------------
# Mock npx (stable): answers initialize, logs every stdin line to MOCK_NPX_LOG,
# stays alive. Used for T2/T3/T4/#5.
# ---------------------------------------------------------------------------
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
        if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { name: 'mock-godot-mcp', protocolVersion: '2024-11-05', capabilities: {} } }) + '\n');
        } else {
            // Answer any other id'd request (incl. tools/call) so a post-warm
            // forwarded call gets a response (T3.3a — the recovery forward path).
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: 'mock-ok' }] } }) + '\n');
        }
    } catch (e) {}
});
EOF

# Mock npx (die-on-signal): like stable, but exits when MOCK_NPX_DIE_FILE
# exists. Used for anchor #4 (induce npx death on demand).
cat > "$TMPDIR/mock-npx-die.mjs" <<'EOF'
import * as readline from 'node:readline';
import { appendFileSync, existsSync } from 'node:fs';
const LOG = process.env.MOCK_NPX_LOG || '';
const DIE = process.env.MOCK_NPX_DIE_FILE || '';
const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    if (LOG) { try { appendFileSync(LOG, line + '\n'); } catch (e) {} }
    try {
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { name: 'mock-godot-mcp', protocolVersion: '2024-11-05', capabilities: {} } }) + '\n');
        } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: 'mock-ok' }] } }) + '\n');
        }
    } catch (e) {}
});
setInterval(() => { if (DIE && existsSync(DIE)) process.exit(7); }, 150);
EOF

MOCK_NPX_DIR="$TMPDIR/mock_npx_bin"
mkdir -p "$MOCK_NPX_DIR"
# npx wrapper selects stable vs die variant via MOCK_NPX_KIND env (proxy spreads
# its env to npx, so setting it on the proxy chooses the variant).
cat > "$MOCK_NPX_DIR/npx" <<'EOF'
#!/usr/bin/env bash
if [ "${MOCK_NPX_KIND:-stable}" = "die" ]; then
    exec node "${MOCK_NPX_SCRIPT_DIR}/mock-npx-die.mjs" "$@"
else
    exec node "${MOCK_NPX_SCRIPT_DIR}/mock-npx-stable.mjs" "$@"
fi
EOF
chmod +x "$MOCK_NPX_DIR/npx"

# Controllable TCP listener on GODOT_PORT (the "editor is up" signal).
LISTENER_SCRIPT="$TMPDIR/ws-mock-listener.mjs"
cp "$SCRIPT_DIR/ws-mock-listener.mjs" "$LISTENER_SCRIPT"

# B1 lazy-load (SEE-1085) — the proxy's spawn path triggers on the first
# tools/call. The original test was written for eager-warmup (no spawn), so
# KOL_CONFIGURE_SH / KOL_START_SH were unused. Under B1 a tools/call invokes
# the spawn helpers; without a seam they fall through to the REAL
# configure/start scripts and pull a live Godot editor into a deterministic
# mock test. Redirect both to no-op mocks (the test's own listener control
# drives the TCP warmup signal) and export KOL_WORKTREE so ensureEditor can
# resolve a worktree root. start_proxy inherits these via `env` in the coproc.
cat > "$TMPDIR/mock-configure.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMPDIR/mock-configure.sh"
cat > "$TMPDIR/mock-start.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMPDIR/mock-start.sh"
export KOL_CONFIGURE_SH="$TMPDIR/mock-configure.sh"
export KOL_START_SH="$TMPDIR/mock-start.sh"
# Resolve repo root from this script's location (.dev/godot-mcp/tests/scripts/).
_TEST_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_TEST_REPO_ROOT="$(cd "$_TEST_SCRIPT_DIR/../../.." && pwd)"
export KOL_WORKTREE="${KOL_WORKTREE:-$_TEST_REPO_ROOT}"

start_listener() { # $1=port -> echo pid
    # Redirect stdout+stdin too: this runs inside $(...), and a backgrounded
    # long-running server that inherits the capture pipe's write-end would keep
    # the command substitution open forever (silent hang). /dev/null detaches it.
    LISTEN_PORT="$1" node "$LISTENER_SCRIPT" </dev/null >/dev/null 2>"$TMPDIR/listener.err" &
    echo $!
}

# Per-case proxy process. Uses `coproc` (a managed bidirectional pipe) instead
# of a hand-rolled FIFO: bash sets up the pipe pair before exec'ing node, so the
# proxy's stdin always has a ready reader and an early proxy exit (e.g. invalid
# port) can never block the harness on a FIFO open-for-write. The parent holds
# PX[1] (stdin write end) for on-demand, timed JSON-RPC sends; node's own stdout
# and stderr are redirected inside the coproc block to snapshot files.
PROXY_OUT=""
PROXY_ERR=""
PX_PID=""
start_proxy() { # args passed through as env KEY=VAL ...
    PROXY_OUT="$TMPDIR/proxy.out"; : > "$PROXY_OUT"
    PROXY_ERR="$TMPDIR/proxy.err"; : > "$PROXY_ERR"
    coproc PX {
        env \
            "GODOT_HOST=127.0.0.1" \
            "PATH=$MOCK_NPX_DIR:$PATH" \
            "KOL_GODOT_MCP_CMD=npx" \
            "MOCK_NPX_SCRIPT_DIR=$TMPDIR" \
            "$@" \
            node "$PROXY" >"$PROXY_OUT" 2>"$PROXY_ERR"
    }
    PX_PID=$PX_PID
}

send_line() { # $1 = JSON-RPC line
    [[ -n "${PX[1]:-}" ]] || return 0
    printf '%s\n' "$1" >&"${PX[1]}" 2>/dev/null || true
}

proxy_alive() {
    [[ -n "${PX_PID:-}" ]] && kill -0 "$PX_PID" 2>/dev/null
}

stop_proxy() {
    # Close both ends of the coproc pipe the parent holds, then reap the proxy.
    [[ -n "${PX[1]:-}" ]] && { eval "exec ${PX[1]}>&-" 2>/dev/null || true; }
    [[ -n "${PX[0]:-}" ]] && { eval "exec ${PX[0]}<&-" 2>/dev/null || true; }
    if [[ -n "${PX_PID:-}" ]]; then
        kill -9 "$PX_PID" 2>/dev/null || true
        wait "$PX_PID" 2>/dev/null || true
    fi
}

INIT_LINE='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test"}}}'
CALL_LINE='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_project_info","arguments":{}}}'
CALL_LINE_2='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_scene_info","arguments":{}}}'

# Wait until a pattern appears in a file, up to N ms. Returns 0 on match.
wait_for() { # $1=file $2=pattern $3=timeout_ms
    local file="$1" pat="$2" budget="$3" waited=0
    while (( waited < budget )); do
        grep -q "$pat" "$file" 2>/dev/null && return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    return 1
}

# ---------------------------------------------------------------------------
# T2: WARMING → RECOVERING on warmup timeout (proxy alive; held call drained).
# ---------------------------------------------------------------------------
sep "T2: warmup timeout → RECOVERING (proxy alive; held call answered with recovering diag)"
T2_PORT=$(find_free_port)
start_proxy "GODOT_PORT=$T2_PORT" "KOL_WARMUP_TIMEOUT_MS=2000" "KOL_FAILED_EXIT_MS=30000" "MOCK_NPX_LOG=$TMPDIR/t2_npx.log"
send_line "$INIT_LINE"
send_line "$CALL_LINE"
# Sanity: mock-npx answered initialize (proves chain alive + stdout flushing works).
if wait_for "$PROXY_OUT" '"id":1' 3000; then
    ok "T2.pre: initialize (id=1) answered by mock-npx (chain alive, stdout flushes)"
else
    ko "T2.pre: no initialize response on stdout — stdout buffering broken or chain dead"
fi
# T2.2 (hold-to-warm 目标1 + 目标2) — the warming tools/call id=2 is HELD in the
# FIFO (never answered with a warmup hint, never forwarded). When the 2s warmup
# window expires the proxy enters RECOVERING and rejectQueue answers the held
# call with a retryable recovering diagnostic (the 90s-window fallback).
if wait_for "$PROXY_OUT" '"id":2' 6000; then
    ok "T2.2a: held tools/call id=2 answered when the window expired (RECOVERING drain, not a hang)"
else
    ko "T2.2a: no id=2 response after the warmup window expired (held call hung)"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "T2.2b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "T2.2b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if grep -q '"state":"recovering"' "$PROXY_OUT" || grep -q '"state": *"recovering"' "$PROXY_OUT"; then
    ok "T2.2c: id=2 answered with the retryable recovering diagnostic (目标2 timeout fallback)"
else
    ko "T2.2c: id=2 lacks state=recovering (expected the timeout-fallback diagnostic)"
fi
if grep -q '"id":2' "$TMPDIR/t2_npx.log" 2>/dev/null; then
    ko "T2.2d: held id=2 was forwarded to npx while the editor never warmed (premature flush)"
else
    ok "T2.2d: id=2 was NOT forwarded to npx (held → drained with the diagnostic)"
fi
# Wait past the 2s warmup timeout into the RECOVERING window (but before T4's 30s FAILED_EXIT).
sleep 3
SNAP_T2="$TMPDIR/t2_snapshot.out"; cp "$PROXY_OUT" "$SNAP_T2"
if proxy_alive; then
    ok "T2.1: proxy still alive 1s after warmup timeout (did not exit)"
else
    ko "T2.1: proxy exited after warmup timeout (should enter RECOVERING, not exit)"
fi
# Spec log: entering RECOVERING (Refacty will emit a state-transition log).
if grep -qiE 'recover' "$PROXY_ERR"; then
    ok "T2.3: proxy logged RECOVERING transition"
else
    ko "T2.3: no RECOVERING transition logged on stderr (current proxy has no RECOVERING state)"
fi
stop_proxy

# ---------------------------------------------------------------------------
# T3: RECOVERING → WARM — warm detected, no queued flush, post-warm call forwarded.
# ---------------------------------------------------------------------------
sep "T3: recovery → WARM (timeout drained the held call; post-warm call forwarded)"
T3_PORT=$(find_free_port)
start_proxy "GODOT_PORT=$T3_PORT" "KOL_WARMUP_TIMEOUT_MS=2000" "KOL_FAILED_EXIT_MS=30000" "MOCK_NPX_LOG=$TMPDIR/t3_npx.log"
send_line "$INIT_LINE"
send_line "$CALL_LINE"
wait_for "$PROXY_OUT" '"id":1' 3000 || ko "T3.pre: initialize not answered"
# T3.2a (hold-to-warm 目标1/目标2) — the warming first call id=2 is HELD in the
# FIFO, then drained with the recovering diagnostic when the 2s window expires:
# never answered with a warmup hint, never forwarded to npx. There is no
# buffered call left for the WARM flush to replay/drop on recovery.
if wait_for "$PROXY_OUT" '"id":2' 6000; then
    ok "T3.2a: held first call id=2 answered when the window expired (recovering drain)"
else
    ko "T3.2a: no id=2 response while warming / after window expiry"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "T3.2b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "T3.2b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if grep -q '"id":2' "$TMPDIR/t3_npx.log" 2>/dev/null; then
    ko "T3.2c: warming call id=2 was forwarded to npx while the editor was cold (premature flush)"
else
    ok "T3.2c: warming call id=2 was NOT forwarded to npx (held → drained with the diagnostic)"
fi
# Let warmup time out → RECOVERING (spec). Then the editor "comes back".
sleep 3
LIS_PID=$(start_listener "$T3_PORT")
note "started editor-listener on $T3_PORT mid-RECOVERING (pid=$LIS_PID)"
# Give the probe loop time to notice and transition RECOVERING → WARM.
sleep 3
SNAP_T3="$TMPDIR/t3_snapshot.out"; cp "$PROXY_OUT" "$SNAP_T3"
# T3.1 — the warm detection log proves the RECOVERING → WARM transition. (With
# hold-to-warm + timeout-drain, the held call was already answered with the
# recovering diagnostic at window expiry, so there is no buffered call for the
# WARM flush to replay or drop.)
if grep -q 'warm detected' "$PROXY_ERR"; then
    ok "T3.1: proxy logged 'warm detected' — RECOVERING → WARM transition fired"
else
    ko "T3.1: no 'warm detected' log after the listener appeared (recovery broken)"
fi
# T3.3 — a NEW post-warm call is forwarded to npx and answered (the real
# recovery proof: the flush gate opened on the fresh warm state).
send_line "$CALL_LINE_2"
if wait_for "$PROXY_OUT" '"id":3' 5000; then
    ok "T3.3a: post-warm call id=3 answered (forwarded path after recovery)"
else
    ko "T3.3a: no id=3 response after recovery to WARM"
fi
if wait_for "$TMPDIR/t3_npx.log" '"id":3' 4000; then
    ok "T3.3b: post-warm call id=3 forwarded to npx (recovery reached the forward path)"
else
    ko "T3.3b: id=3 never reached npx after recovery"
fi
# Proxy should report reaching WARM.
if grep -qiE 'warm detected|warm\b' "$PROXY_ERR"; then
    ok "T3.3c: proxy reached WARM after editor listener appeared"
else
    ko "T3.3c: proxy never reached WARM (current proxy stops probing after timeout)"
fi
stop_proxy
kill "$LIS_PID" 2>/dev/null || true

# ---------------------------------------------------------------------------
# T4: RECOVERING → FAILED_EXIT after KOL_FAILED_EXIT_MS of sustained probe failure.
# ---------------------------------------------------------------------------
sep "T4: sustained probe failure → process.exit(1) after rejectQueue"
T4_PORT=$(find_free_port)
# SEE-1240 WS-5: the DEFAULT T4 path is now in-band rearm (proxy survives).
# This suite pins the LEGACY exit contract, so opt out explicitly here; the
# rearm default is covered by test_see1240_ws5_giveup_rearm.sh.
start_proxy "GODOT_PORT=$T4_PORT" "KOL_WARMUP_TIMEOUT_MS=2000" "KOL_FAILED_EXIT_MS=4000" "KOL_GIVEUP_REARM=0" "MOCK_NPX_LOG=$TMPDIR/t4_npx.log"
send_line "$INIT_LINE"
send_line "$CALL_LINE"
wait_for "$PROXY_OUT" '"id":1' 3000 || ko "T4.pre: initialize not answered"
# T4.2 (hold-to-warm 目标1/目标2) — the warming first call id=2 is HELD, then
# drained with the recovering diagnostic at the 2s window expiry — never a
# warmup hint, never a premature flush. By FAILED_EXIT (2s + 4s) the queue is
# already empty; the FAILED_EXIT proof is the stderr log + the exit.
if wait_for "$PROXY_OUT" '"id":2' 6000; then
    ok "T4.2a: held first call id=2 answered when the window expired (recovering drain)"
else
    ko "T4.2a: no id=2 response while warming / after window expiry"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "T4.2b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "T4.2b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if grep -q '"id":2' "$TMPDIR/t4_npx.log" 2>/dev/null; then
    ko "T4.2c: held id=2 was forwarded to npx while the editor never warmed (premature flush)"
else
    ok "T4.2c: held id=2 was NOT forwarded to npx (drained with the diagnostic)"
fi
# Warmup times out at ~2s; FAILED_EXIT should fire ~4s after entering RECOVERING → ~6s.
# Watch for process death within a 10s window.
EXITED=0
for _ in $(seq 1 100); do
    if ! proxy_alive; then EXITED=1; break; fi
    sleep 0.1
done
SNAP_T4="$TMPDIR/t4_snapshot.out"; cp "$PROXY_OUT" "$SNAP_T4"
if (( EXITED == 1 )); then
    ok "T4.1: proxy exited after sustained warmup failure (FAILED_EXIT)"
else
    ko "T4.1: proxy still alive after 10s (should exit(1) once tcpProbe fails for KOL_FAILED_EXIT_MS=4000)"
fi
# A failed_exit state should appear in the diagnostic (Refacty adds data.state).
if grep -qiE 'failed_exit|timed out|exit' "$PROXY_ERR"; then
    ok "T4.3: proxy logged a failure/exit diagnostic"
else
    ko "T4.3: no failure/exit diagnostic on stderr"
fi
stop_proxy

# ---------------------------------------------------------------------------
# #4: npx death during RECOVERING still cold-respawns (counter continues; proxy survives).
# ---------------------------------------------------------------------------
sep "#4: npx death during RECOVERING → cold-respawn continues (no reset; respawn independent)"
N4_PORT=$(find_free_port)
N4_DIE="$TMPDIR/n4_die.signal"; rm -f "$N4_DIE"
start_proxy "GODOT_PORT=$N4_PORT" "KOL_WARMUP_TIMEOUT_MS=2000" "KOL_FAILED_EXIT_MS=30000" \
            "MOCK_NPX_KIND=die" "MOCK_NPX_DIE_FILE=$N4_DIE" "MOCK_NPX_LOG=$TMPDIR/n4_npx.log"
send_line "$INIT_LINE"
send_line "$CALL_LINE"
wait_for "$PROXY_OUT" '"id":1' 3000 || ko "#4.pre: initialize not answered"
# The warming first call id=2 is HELD until the window expires and drained with
# the recovering diagnostic (this also proves the spawn/warmup clock started on
# the first tools/call). KOL_WARMUP_TIMEOUT_MS=2000 here, so the drain lands ~2s
# after the call — the deterministic end-state is "answered + no hint + no
# premature flush".
if wait_for "$PROXY_OUT" '"id":2' 6000; then
    ok "#4.pre: warming first call id=2 answered when the window expired (recovering drain)"
else
    ko "#4.pre: no id=2 response while warming"
fi
# Kill npx once during cold warmup → coldNpxRestarts=1 ("cold attempt 1").
touch "$N4_DIE"; sleep 0.6; rm -f "$N4_DIE"
if wait_for "$PROXY_ERR" 'cold attempt 1' 3000; then
    ok "#4.pre2: npx death during cold warmup respawned (cold attempt 1 logged)"
else
    ko "#4.pre2: npx death did not trigger cold-respawn during cold warmup"
fi
# Now warmup times out → RECOVERING (spec). Kill npx AGAIN in RECOVERING.
sleep 2   # reach/just past the 2s warmup timeout (RECOVERING window; FAILED_EXIT is 30s away)
touch "$N4_DIE"; sleep 0.6; rm -f "$N4_DIE"
# Spec: RECOVERING-state npx death still cold-respawns and continues the counter → "cold attempt 2".
sleep 2
SNAP_N4_ERR="$TMPDIR/n4_snapshot.err"; cp "$PROXY_ERR" "$SNAP_N4_ERR"
if proxy_alive; then
    ok "#4.1: proxy survived an npx death during RECOVERING (did not exit)"
else
    ko "#4.1: proxy exited on npx death during RECOVERING (current code hits warmupTimedOut → rejectQueue+exit)"
fi
if grep -q 'cold attempt 2' "$SNAP_N4_ERR"; then
    ok "#4.2: coldNpxRestarts continued (cold attempt 2) — counter NOT reset by warmup reset"
else
    ko "#4.2: no 'cold attempt 2' (counter reset or no RECOVERING respawn — respawn should be independent of warmup state)"
fi
stop_proxy

# ---------------------------------------------------------------------------
# #5: NEW tools/call during RECOVERING is immediately rejected with data.state=recovering.
# ---------------------------------------------------------------------------
sep "#5: NEW tools/call during RECOVERING → immediate diagnostic error (data.state=recovering)"
N5_PORT=$(find_free_port)
start_proxy "GODOT_PORT=$N5_PORT" "KOL_WARMUP_TIMEOUT_MS=2000" "KOL_FAILED_EXIT_MS=30000" "MOCK_NPX_LOG=$TMPDIR/n5_npx.log"
send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 3000 || ko "#5.pre: initialize not answered"
# B1 (SEE-1085): the warmup clock starts at the first tools/call, not at proxy
# start. Send a call (id=2) to trigger spawn + start the clock, THEN sleep past
# the 2s timeout so the proxy is in RECOVERING when the new call (id=3) lands.
send_line "$CALL_LINE"
# The warming first call id=2 is HELD until the window expires and drained with
# the recovering diagnostic (hold-to-warm 目标1 + 目标2 fallback).
if wait_for "$PROXY_OUT" '"id":2' 6000; then
    ok "#5.pre: warming first call id=2 answered when the window expired (recovering drain)"
else
    ko "#5.pre: no id=2 response while warming"
fi
# Enter RECOVERING (past 2s timeout), then send a NEW tools/call (id=3).
sleep 3
T_SEND=$(date +%s%3N)
send_line "$CALL_LINE_2"
# Spec: immediate (well under the probe interval) diagnostic error.
if wait_for "$PROXY_OUT" '"id":3' 1500; then
    T_RECV=$(date +%s%3N)
    LAT=$(( T_RECV - T_SEND ))
    ok "#5.1: new tools/call id=3 rejected promptly in RECOVERING (~${LAT}ms, not hung)"
else
    ko "#5.1: new tools/call id=3 not rejected promptly in RECOVERING (hung or buffered)"
fi
SNAP_N5="$TMPDIR/n5_snapshot.out"; cp "$PROXY_OUT" "$SNAP_N5"
# Diagnostic must carry the structured state marker (Archi §五: data.state).
if grep -q '"state":"recovering"' "$SNAP_N5"; then
    ok "#5.2: rejection carries structured diagnostic data.state=\"recovering\""
else
    ko "#5.2: rejection lacks data.state=\"recovering\" (current makeErrorResponse has no data field)"
fi
# And it must NOT be silently buffered into pendingCalls (forwarded later / hung).
if grep -q '"id":3' "$TMPDIR/n5_npx.log" 2>/dev/null; then
    ko "#5.3: new RECOVERING call id=3 was forwarded to npx (should be immediately rejected)"
else
    ok "#5.3: new RECOVERING call id=3 was NOT forwarded to npx (immediate reject honored)"
fi
stop_proxy

# ---------------------------------------------------------------------------
sep "Summary"
echo -e "PASS=${GREEN}${PASS}${NC} FAIL=${RED}${FAIL}${NC}"
echo
if (( FAIL == 0 )); then
    echo -e "${GREEN}RESULT: ALL GREEN.${NC} warmup self-heal state machine behaves per Archi 189be0a2."
    exit 0
else
    echo -e "${RED}RESULT: RED (expected pre-impl).${NC} ${FAIL} assertion(s) failing — the state machine is not yet implemented."
    echo "FAILURES:"
    for f in "${FAILS[@]}"; do echo "  - $f"; done
    # Exit non-zero so the RED is visible; commit is marked expected-RED.
    exit 1
fi
