#!/usr/bin/env bash
# test_see1077_lease_fast_fail.sh
#
# SEE-1077 lease-aware fast-fail — RED tests.
#
# Goal: extend `launch/godot-mcp-proxy.mjs` with an independent editor-log
# tail that watches for the exact "Lease: no MCP client for the grace window;
# exiting editor to release the port." line and, on match, takes the existing
# T4 FAILED_EXIT path (rejectQueue + warmupDiagnostic('failed_exit') +
# process.exit(1)), bypassing the 360s RECOVERING window.
#
# Trigger context (Atlas → Bachi sub-step):
#   - New logic must be a SEPARATE monitor from the render-stable monitor
#     (which clears at WARM).
#   - Track file offset, only scan NEW bytes (pre-existing "exiting editor"
#     lines from a prior editor run must NOT fast-fail a fresh proxy).
#   - Only the "no MCP client... exiting editor" line triggers; the
#     "self-exit scheduled" and "self-exit cancelled" variants must NOT.
#   - When GODOT_EDITOR_LOG_FILE is unset/empty the new logic is fully no-op
#     (so the existing SEE-1070 tests, which never pass this env, stay GREEN
#     without modification).
#
# Methodology: same as test_see1070_warmup_self_heal.sh — drive the proxy
# directly with a controllable mock-npx on PATH and a controllable TCP
# listener on GODOT_PORT; additionally pipe a fake editor log via
# GODOT_EDITOR_LOG_FILE=$TMPDIR/fake-editor.log and append lease lines on
# demand. Black-box assertions on proxy stdout/stderr.
#
# Anchors (issue body §测试方案), adapted to SEE-1111 hold-to-warm (目标1) and
# the timeout fallback (目标2):
#   L1  WARMING + "scheduled" line only  → no fast-fail, proxy alive; id=2 is
#       HELD in the FIFO while the window is active, then drained at window
#       expiry (T2) with the retryable recovering diagnostic — never answered
#       with a hint, never rejected on the 'scheduled' line.
#   L2  WARMING + "scheduled" then "exiting editor"  → fast-fail: proxy
#       exits(1) promptly, well before the 360s RECOVERING window would
#       expire. With hold-to-warm the warming call is still buffered, so the
#       FAILED_EXIT-path proof is the lease-death stderr log reporting
#       rejection of exactly 1 buffered call carrying the failed_exit diagnostic.
#   L3  WARMING + "scheduled" then "cancelled"  → no fast-fail, warmup
#       continues (TCP probe can still bring it WARM).
#   L4  log already contains "exiting editor" BEFORE proxy starts → fresh
#       proxy does NOT fast-fail (offset mechanism); id=2 still gets the T2
#       recovering drain, not a lease failed_exit.
#   L5  proxy reaches WARM first, then "exiting editor" is appended →
#       fast-fail (independent monitor keeps tailing after WARM).
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1077_lease_fast_fail.sh

set -uo pipefail
# See test_see1070_warmup_self_heal.sh: writes into a coproc whose reader has
# already exited deliver SIGPIPE; ignore so wait_for/proxy_alive handle it.
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
    pkill -f "$TMPDIR/ws-mock-listener.mjs" 2>/dev/null || true
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

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

# Mock npx (stable): answers initialize, logs every stdin line, stays alive.
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
        }
    } catch (e) {}
});
EOF

MOCK_NPX_DIR="$TMPDIR/mock_npx_bin"
mkdir -p "$MOCK_NPX_DIR"
cat > "$MOCK_NPX_DIR/npx" <<'EOF'
#!/usr/bin/env bash
exec node "${MOCK_NPX_SCRIPT_DIR}/mock-npx-stable.mjs" "$@"
EOF
chmod +x "$MOCK_NPX_DIR/npx"

LISTENER_SCRIPT="$TMPDIR/ws-mock-listener.mjs"
cp "$SCRIPT_DIR/ws-mock-listener.mjs" "$LISTENER_SCRIPT"

start_listener() {
    LISTEN_PORT="$1" node "$LISTENER_SCRIPT" </dev/null >/dev/null 2>"$TMPDIR/listener.err" &
    echo $!
}

# B1 lazy-load (SEE-1085): the proxy's spawn path triggers on the first
# tools/call (the L1-L4 CALL_LINE). Without a seam it falls through to the
# REAL configure/start scripts and pulls a live Godot editor into a
# deterministic mock test (writing project.godot, launching editors). Redirect
# both to no-op mocks — the lease monitor is what these tests exercise, and the
# test's own listener / log control drive warmup. Exported so the coproc's
# `env` inherits them. start_proxy (below) inherits via env.
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
# SEE-1242 A-4 (decisive seam): the cold spawn chain runs prepare-worktree.sh
# BEFORE configure/start, and without this seam the REAL prepare runs the REAL
# configure-mcp-port.sh, whose REAPER_ASYNC spawns a live reap-stale-leases.sh
# in the background. That reaper's residue-editor sweep scans ports 6551-6609,
# finds the suite's own ws-mock-listener bound on the L5-class port, and
# kill_editor_pid()s it (~2-4s after spawn). With the listener dead the proxy's
# wsProbe can never succeed, 'warm detected' never prints, and L5.pre fails on
# any wait budget (the 17/1 flake; master identical). Mock the prepare seam so
# no live reaper is ever started — the suite drives warmup via its own listener.
cat > "$TMPDIR/mock-prepare.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMPDIR/mock-prepare.sh"
export KOL_PREPARE_SH="$TMPDIR/mock-prepare.sh"
# SEE-1242 A-4: the evict path (proxy sees a busy port whose arbiter runtime id
# mismatches — every L5-class fresh-proxy case) runs reap-stale-leases.sh via
# resolveHelper('reap-stale-leases.sh', KOL_REAP_SH). The real reaper's orphan
# sweeps take 20-80s on a loaded machine regardless of KOL_REAP_DISABLE_PWSH
# (the /proc headless sweep alone scans every godot cmdline), so the L5.pre
# 8s 'warm detected' window could never be met deterministically. Point the
# seam at a no-op mock — the lease monitor under test is the proxy's log tail,
# not the reaper — same mock-seam pattern as KOL_CONFIGURE_SH/KOL_START_SH.
cat > "$TMPDIR/mock-reap.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMPDIR/mock-reap.sh"
export KOL_REAP_SH="$TMPDIR/mock-reap.sh"
# SEE-1242 A-4 (decisive seam 2/3): the evict path also runs the REAL
# stop-godot-editor.sh via resolveHelper('stop-godot-editor.sh', KOL_STOP_SH).
# With a stale godot-editor-port-<p>.pid in $HOME/.multica from an unrelated
# run, stop-sh resolves the lifecycle pidfile, reads the freshly recycled PID
# that now belongs to the suite's own ws-mock-listener, and kills it (verified:
# `stop-sh --port <p>` terminated the listener via a stale pidfile in 34ms).
# The suite's assertions cover the proxy's lease monitor (log tail), not the
# stop script — mock the stop seam so evict never touches a real process.
cat > "$TMPDIR/mock-stop.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$TMPDIR/mock-stop.sh"
export KOL_STOP_SH="$TMPDIR/mock-stop.sh"
# SEE-1242 A-4 (root cause of the deterministic L5.pre kill): the evict path
# also runs the REAL stop-godot-editor.sh, which resolves its lifecycle pidfile
# under $HOME/.multica. Stale port-named pidfiles from unrelated runs collide
# with freshly recycled PIDs, so evict killed the suite's own ws-mock-listener
# (verified: stop-sh --port <p> terminated the listener via a stale
# godot-editor-port-<p>.pid). Isolate MULTICA_DIR per suite run — the proxy and
# every helper child (configure/start/stop/reap) read $HOME/.multica, and no
# assertion in this suite depends on the real HOME.
export HOME="$TMPDIR/home"
mkdir -p "$HOME/.multica"
_LEASE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_LEASE_REPO_ROOT="$(cd "$_LEASE_SCRIPT_DIR/../../.." && pwd)"
export KOL_WORKTREE="${KOL_WORKTREE:-$_LEASE_REPO_ROOT}"

PROXY_OUT=""
PROXY_ERR=""
PX_PID=""
# SEE-1111 isolation: the proxy's configure path resolves the worktree and
# rewrites its project.godot. With cwd at the repo checkout and no KOL_WORKTREE,
# resolveWorktreeForSpawn() walks up from the proxy scriptDir and lands on THIS
# checkout — rewriting the real project.godot (SEE-1111 Goal 3 violation). Point
# every proxy under test at an isolated scratch Godot project.
SCRATCH_WT="$TMPDIR/scratch-worktree"
mkdir -p "$SCRATCH_WT/launch"
printf 'config_version=5\n\n[godot_mcp]\n\nport_override_enabled=false\nport_override=6550\n' > "$SCRATCH_WT/project.godot"
# SEE-1240 WS-5: this suite pins the SEE-1070 lease fast-fail EXIT contract; the
# WS-5 in-band rearm default is covered by test_see1240_ws5_giveup_rearm.sh.
start_proxy() {
    PROXY_OUT="$TMPDIR/proxy.out"; : > "$PROXY_OUT"
    PROXY_ERR="$TMPDIR/proxy.err"; : > "$PROXY_ERR"
    # SEE-1242 A-4: the mock seams (configure/start/prepare/reap/stop) and the
    # isolated HOME must flow into the coproc — `export` on the suite shell
    # does not propagate into an `env ...` invocation's environment. The evict
    # path runs the REAL stop-godot-editor.sh / reap-stale-leases.sh via
    # resolveHelper(name, envVar): a blank envVar makes it fall back to the
    # real script, which has been verified to kill the suite's ws-mock-listener
    # (stale port pidfile + pid reuse) or spawn a 20-80s live reaper.
    coproc PX {
        env \
            "GODOT_HOST=127.0.0.1" \
            "PATH=$MOCK_NPX_DIR:$PATH" \
            "KOL_GODOT_MCP_CMD=npx" \
            "MOCK_NPX_SCRIPT_DIR=$TMPDIR" \
            "KOL_WORKTREE=$SCRATCH_WT" \
            "KOL_PROJECT_GODOT=$SCRATCH_WT/project.godot" \
            "KOL_CONFIGURE_SH=$KOL_CONFIGURE_SH" \
            "KOL_START_SH=$KOL_START_SH" \
            "KOL_PREPARE_SH=$KOL_PREPARE_SH" \
            "KOL_REAP_SH=$KOL_REAP_SH" \
            "KOL_STOP_SH=$KOL_STOP_SH" \
            "HOME=$HOME" \
            "KOL_GIVEUP_REARM=0" \
            "$@" \
            node "$PROXY" >"$PROXY_OUT" 2>"$PROXY_ERR"
    }
    PX_PID=$PX_PID
}

send_line() {
    [[ -n "${PX[1]:-}" ]] || return 0
    printf '%s\n' "$1" >&"${PX[1]}" 2>/dev/null || true
}

proxy_alive() {
    [[ -n "${PX_PID:-}" ]] && kill -0 "$PX_PID" 2>/dev/null
}

stop_proxy() {
    [[ -n "${PX[1]:-}" ]] && { eval "exec ${PX[1]}>&-" 2>/dev/null || true; }
    [[ -n "${PX[0]:-}" ]] && { eval "exec ${PX[0]}<&-" 2>/dev/null || true; }
    if [[ -n "${PX_PID:-}" ]]; then
        kill -9 "$PX_PID" 2>/dev/null || true
        wait "$PX_PID" 2>/dev/null || true
    fi
}

INIT_LINE='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test"}}}'
CALL_LINE='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_project_info","arguments":{}}}'

# Lease log line variants (addons/godot_mcp/plugin.gd:401-416).
LEASE_SCHEDULED='Lease: editor self-exit scheduled in 30s.'
LEASE_CANCELLED='Lease: editor self-exit cancelled.'
LEASE_EXITING='Lease: no MCP client for the grace window; exiting editor to release the port.'

wait_for() {
    local file="$1" pat="$2" budget="$3" waited=0
    while (( waited < budget )); do
        grep -q "$pat" "$file" 2>/dev/null && return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    return 1
}

# Wait for proxy to die, up to N ms. Returns 0 on death.
wait_for_death() {
    local budget="$1" waited=0
    while (( waited < budget )); do
        proxy_alive || return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    return 1
}

# ---------------------------------------------------------------------------
# L1: WARMING + scheduled-only → no fast-fail.
# ---------------------------------------------------------------------------
sep "L1: 'scheduled' line only → no fast-fail (proxy stays in WARMING)"
L1_PORT=$(find_free_port)
L1_LOG="$TMPDIR/l1-editor.log"; : > "$L1_LOG"
# Use a long warmup window so a "no fast-fail" observation window is meaningful
# (well beyond any sane lease-tail debounce, well under T2).
start_proxy "GODOT_PORT=$L1_PORT" "KOL_WARMUP_TIMEOUT_MS=8000" "KOL_FAILED_EXIT_MS=30000" \
            "GODOT_EDITOR_LOG_FILE=$L1_LOG" "MOCK_NPX_LOG=$TMPDIR/l1_npx.log"
send_line "$INIT_LINE"
send_line "$CALL_LINE"
wait_for "$PROXY_OUT" '"id":1' 3000 || ko "L1.pre: initialize not answered"
# Write ONLY the 'scheduled' variant (grace window start, may still cancel).
echo "$LEASE_SCHEDULED" >> "$L1_LOG"
# Observe for 3s — the proxy must NOT exit on this line.
sleep 3   # 竞态窗口语义（CLAUDE.md 边界）：scheduled 线不触发 fast-fail 的存活窗，窗长 = proxy 快败判定窗，即被测行为
if proxy_alive; then
    ok "L1.1: proxy alive 3s after 'scheduled' line (did not fast-fail)"
else
    ko "L1.1: proxy exited after 'scheduled' line (must NOT fast-fail; scheduled != exiting)"
fi
# SEE-1111 hold-to-warm (目标1): id=2 is HELD in the FIFO while the window is
# active, then drained at T2 (window expiry) with the retryable recovering
# diagnostic (目标2 fallback) — never a hint, never rejected on the
# 'scheduled' line. No listener here, so the drain happens at window expiry.
if wait_for "$PROXY_OUT" '"id":2' 15000; then
    ok "L1.2: held id=2 answered at T2 window expiry (recovering drain, no silent hang)"
else
    ko "L1.2: no id=2 response — proxy silent (hold + no drain)"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "L1.2h: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "L1.2h: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if grep -q '"id":2.*"state":"recovering"' "$PROXY_OUT" 2>/dev/null; then
    ok "L1.2b: id=2 carries the retryable recovering diagnostic (T2 drain, not an error)"
else
    ko "L1.2b: id=2 lacks the recovering diagnostic (wrong drain path)"
fi
if ! grep -q '"id":2.*"state":"failed_exit"' "$PROXY_OUT" 2>/dev/null; then
    ok "L1.2e: id=2 NOT answered with the lease failed_exit diagnostic (scheduled != exiting)"
else
    ko "L1.2e: id=2 got the failed_exit diagnostic — 'scheduled' triggered a lease fast-fail"
fi
stop_proxy

# ---------------------------------------------------------------------------
# L2: WARMING + scheduled then exiting → fast-fail (skip RECOVERING window).
# ---------------------------------------------------------------------------
sep "L2: 'scheduled' then 'exiting editor' → fast-fail via T4 path"
L2_PORT=$(find_free_port)
L2_LOG="$TMPDIR/l2-editor.log"; : > "$L2_LOG"
# Warmup window is 30s and FAILED_EXIT is 60s. If lease fast-fail works, the
# proxy must die in *far less* than the 30s warmup window — i.e. the lease
# signal short-circuits long before the natural RECOVERING/FAILED_EXIT path.
start_proxy "GODOT_PORT=$L2_PORT" "KOL_WARMUP_TIMEOUT_MS=30000" "KOL_FAILED_EXIT_MS=60000" \
            "GODOT_EDITOR_LOG_FILE=$L2_LOG" "MOCK_NPX_LOG=$TMPDIR/l2_npx.log"
send_line "$INIT_LINE"
send_line "$CALL_LINE"
wait_for "$PROXY_OUT" '"id":1' 3000 || ko "L2.pre: initialize not answered"
echo "$LEASE_SCHEDULED" >> "$L2_LOG"
sleep 0.5   # 竞态窗口语义（CLAUDE.md 边界）：scheduled→exiting 间隔是 dt 度量的被测量
T_SEND=$(date +%s%3N)
echo "$LEASE_EXITING" >> "$L2_LOG"
if wait_for_death 5000; then
    T_DEAD=$(date +%s%3N)
    LAT=$(( T_DEAD - T_SEND ))
    ok "L2.1: proxy fast-failed ~${LAT}ms after 'exiting editor' (well under 30s warmup)"
else
    ko "L2.1: proxy still alive 5s after 'exiting editor' (should fast-fail via T4 path)"
fi
# SEE-1111 hold-to-warm (目标1): the warming call id=2 is HELD in the FIFO, so
# when the lease fast-fail fires it has exactly 1 buffered call to reject — the
# id=2 answer IS the lease fast-fail rejection carrying the failed_exit
# diagnostic. The FAILED_EXIT-path proof is the stderr log reporting rejection
# of exactly 1 buffered call (no silent drop, no double-reject), plus the
# failed_exit state in the id=2 response.
SNAP_L2="$TMPDIR/l2_snapshot.out"; cp "$PROXY_OUT" "$SNAP_L2"
if grep -q '"id":2' "$SNAP_L2"; then
    ok "L2.2: id=2 was answered (lease fast-fail rejection of the held call)"
else
    ko "L2.2: id=2 never answered (held call dropped on lease fast-fail)"
fi
if grep -q 'lease death detected' "$PROXY_ERR"; then
    ok "L2.2b: lease monitor matched LEASE_EXITING and ran the FAILED_EXIT path"
else
    ko "L2.2b: no lease-death log line (monitor did not fire)"
fi
if grep -q 'rejecting 1 buffered call(s) and exiting' "$PROXY_ERR"; then
    ok "L2.3: lease fast-fail rejected exactly 1 buffered call (held id=2, no double-reject)"
else
    ko "L2.3: lease fast-fail did not report exactly 1 buffered call: $(grep 'buffered call' "$PROXY_ERR" | head -1)"
fi
if grep -q '"id":2.*"state":"failed_exit"' "$SNAP_L2"; then
    ok "L2.4: id=2 carries the failed_exit diagnostic (lease fast-fail path, not recovering)"
else
    ko "L2.4: id=2 lacks the failed_exit diagnostic (wrong reject path)"
fi
stop_proxy

# ---------------------------------------------------------------------------
# L3: scheduled then cancelled → no fast-fail, warmup can still complete.
# ---------------------------------------------------------------------------
sep "L3: 'scheduled' then 'cancelled' → no fast-fail; TCP probe can still WARM"
L3_PORT=$(find_free_port)
L3_LOG="$TMPDIR/l3-editor.log"; : > "$L3_LOG"
start_proxy "GODOT_PORT=$L3_PORT" "KOL_WARMUP_TIMEOUT_MS=8000" "KOL_FAILED_EXIT_MS=30000" \
            "GODOT_EDITOR_LOG_FILE=$L3_LOG" "MOCK_NPX_LOG=$TMPDIR/l3_npx.log"
send_line "$INIT_LINE"
send_line "$CALL_LINE"
wait_for "$PROXY_OUT" '"id":1' 3000 || ko "L3.pre: initialize not answered"
echo "$LEASE_SCHEDULED" >> "$L3_LOG"
sleep 0.4   # 竞态窗口语义（CLAUDE.md 边界）：cancel 须落在 scheduled 判定窗内，窗时序即被测行为
echo "$LEASE_CANCELLED" >> "$L3_LOG"
sleep 2   # 竞态窗口语义（CLAUDE.md 边界）：断言 cancel 制胜后 proxy 存活
if proxy_alive; then
    ok "L3.1: proxy alive after scheduled+cancelled (cancel beats scheduled; no fast-fail)"
else
    ko "L3.1: proxy exited on scheduled+cancelled (cancel must veto the fast-fail)"
fi
# Warmup is still in progress. Bring the editor up via TCP and verify the
# proxy reaches WARM (i.e. the lease monitor did not wedge the state machine).
LIS_PID=$(start_listener "$L3_PORT")
note "started editor-listener on $L3_PORT (after cancelled)"
# The proxy's WARM gate (SEE-1111 缺陷 A + 缺陷 #10) waits for `Server listening`
# AND `WebSocket handshake complete` when the log is readable — emit both
# milestones so WARM is not held.
echo "[godot-mcp] Server listening on 127.0.0.1:$L3_PORT [test]" >> "$L3_LOG"
echo "[godot-mcp] WebSocket handshake complete" >> "$L3_LOG"
if wait_for "$PROXY_ERR" 'warm detected' 5000; then
    ok "L3.2: proxy reached WARM after cancelled + listener (state machine intact)"
else
    ko "L3.2: proxy never reached WARM (cancelled path wedged the state machine)"
fi
stop_proxy
kill "$LIS_PID" 2>/dev/null || true

# ---------------------------------------------------------------------------
# L4: pre-existing "exiting editor" in log → fresh proxy does NOT fast-fail.
# ---------------------------------------------------------------------------
sep "L4: stale 'exiting editor' line before proxy start → no fast-fail (offset)"
L4_PORT=$(find_free_port)
L4_LOG="$TMPDIR/l4-editor.log"
# Simulate a previous editor run's final lease line — this MUST NOT kill a new proxy.
echo "$LEASE_EXITING" > "$L4_LOG"
start_proxy "GODOT_PORT=$L4_PORT" "KOL_WARMUP_TIMEOUT_MS=8000" "KOL_FAILED_EXIT_MS=30000" \
            "GODOT_EDITOR_LOG_FILE=$L4_LOG" "MOCK_NPX_LOG=$TMPDIR/l4_npx.log"
send_line "$INIT_LINE"
send_line "$CALL_LINE"
wait_for "$PROXY_OUT" '"id":1' 3000 || ko "L4.pre: initialize not answered"
sleep 3   # 竞态窗口语义（CLAUDE.md 边界）：offset 机制存活窗，即被测行为
if proxy_alive; then
    ok "L4.1: proxy alive despite pre-existing 'exiting editor' line (offset mechanism)"
else
    ko "L4.1: proxy fast-failed on stale 'exiting editor' (offset tail broken — false positive)"
fi
# SEE-1111 hold-to-warm (目标1): the warming call id=2 is HELD in the FIFO;
# since the stale 'exiting editor' line never triggers the lease fast-fail
# (offset mechanism), id=2 is drained at T2 (window expiry) with the retryable
# recovering diagnostic — never answered with a lease failed_exit.
if wait_for "$PROXY_OUT" '"id":2' 15000; then
    ok "L4.2: held id=2 answered at T2 window expiry (recovering drain, stale line ignored)"
else
    ko "L4.2: no id=2 response — proxy silent (hold + no drain)"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "L4.2h: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "L4.2h: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if ! grep -q '"id":2.*"state":"failed_exit"' "$PROXY_OUT" 2>/dev/null; then
    ok "L4.2b: id=2 NOT answered with the lease failed_exit diagnostic (offset mechanism works)"
else
    ko "L4.2b: id=2 got failed_exit on the STALE line (offset mechanism broken — false positive)"
fi
stop_proxy

# ---------------------------------------------------------------------------
# L5: WARM, then "exiting editor" appended → fast-fail (monitor keeps tailing).
# ---------------------------------------------------------------------------
sep "L5: WARM first, then 'exiting editor' → fast-fail (monitor survives WARM)"
L5_PORT=$(find_free_port)
L5_LOG="$TMPDIR/l5-editor.log"; : > "$L5_LOG"
# Start the editor listener FIRST so the proxy reaches WARM almost immediately.
LIS_PID=$(start_listener "$L5_PORT")
start_proxy "GODOT_PORT=$L5_PORT" "KOL_WARMUP_TIMEOUT_MS=30000" "KOL_FAILED_EXIT_MS=60000" \
            "GODOT_EDITOR_LOG_FILE=$L5_LOG" "MOCK_NPX_LOG=$TMPDIR/l5_npx.log"
send_line "$INIT_LINE"
# B1 (SEE-1085): the first tools/call triggers lazy spawn. The listener is
# already up, so the probe short-circuits and the proxy reaches WARM. Inert id=999.
send_line '{"jsonrpc":"2.0","id":999,"method":"tools/call","params":{"name":"get_project_info","arguments":{}}}'
# The proxy's WARM gate (SEE-1111 缺陷 A + 缺陷 #10) waits for `Server listening`
# AND `WebSocket handshake complete` when the log is readable — emit both
# milestones so WARM is not held.
# SEE-1242 A-4 (deterministic race): the proxy seeds leaseOffset = file size at
# start, asynchronously. Writing the milestones before that seed completes means
# the offset points past them — the slice scan never sees either line, gateOpen
# never opens, and 'warm detected' never prints (17/1 flake; master identical).
# Give the seed a deterministic completion window before emitting the
# milestones: the seed is one async stat() (sub-100ms even under load), so 1s
# is a safe floor, and it is a TEST timing requirement, not an assertion change.
sleep 1   # 竞态窗口语义（CLAUDE.md 边界）：proxy 内部 async stat() seed 无外部完成信号可订阅（L5_LOG 为空文件，mtime 不反映 seed 状态），1s = 原判定的安全下限，保留
echo "[godot-mcp] Server listening on 127.0.0.1:$L5_PORT [test]" >> "$L5_LOG"
echo "[godot-mcp] WebSocket handshake complete" >> "$L5_LOG"
wait_for "$PROXY_ERR" 'warm detected' 20000 || ko "L5.pre: proxy did not reach WARM with listener up"
# Now simulate the editor lease-suiciding *after* WARM. The render-stable
# monitor has already clearInterval'd at this point; the lease monitor must
# still be alive to catch this.
echo "$LEASE_EXITING" >> "$L5_LOG"
if wait_for_death 5000; then
    ok "L5.1: proxy fast-failed after WARM when 'exiting editor' appended"
else
    ko "L5.1: proxy still alive 5s after post-WARM 'exiting editor' (monitor must outlive WARM)"
fi
stop_proxy
kill "$LIS_PID" 2>/dev/null || true

# ---------------------------------------------------------------------------
sep "Summary"
echo -e "PASS=${GREEN}${PASS}${NC} FAIL=${RED}${FAIL}${NC}"
echo
if (( FAIL == 0 )); then
    echo -e "${GREEN}RESULT: ALL GREEN.${NC} lease-aware fast-fail behaves per spec."
    exit 0
else
    echo -e "${RED}RESULT: RED (expected pre-impl).${NC} ${FAIL} assertion(s) failing — lease fast-fail is not yet implemented."
    echo "FAILURES:"
    for f in "${FAILS[@]}"; do echo "  - $f"; done
    exit 1
fi
