#!/usr/bin/env bash
# test_see1077_edge_cases.sh — Revy QA adversarial edge cases (not in issue spec).
#
# E1: GODOT_EDITOR_LOG_FILE points to a NONEXISTENT path
#     → proxy must still boot, warmup via TCP probe, no fast-fail.
#     (Spec §规避点#2: lease logic no-op when log file absent — must not break
#      editor normal startup path.)
#
# E2: Multiple consecutive 'exiting editor' lines appended in a burst
#     → proxy must fast-fail EXACTLY ONCE: one rejectQueue, one process.exit,
#      no double-reject of the same buffered id, no zombie interval.
#     (Spec §规避点#3: reuse T4 path — must be idempotent.)
#
# E3: GODOT_EDITOR_LOG_FILE is EMPTY string explicitly
#     → no-op behavior; proxy warms via TCP probe (covers the '' branch,
#      distinct from the unset case which SEE-1070 tests already exercise).
#
# Methodology: same coproc + mock-npx + TCP-listener harness as
# test_see1077_lease_fast_fail.sh. Read-only against launch/ — this
# script adds no production code and is QA-only.

set -uo pipefail
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
    raise SystemExit('no free port')
PY
}

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
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { name: 'mock-godot-mcp', protocolVersion: '2024-11-05', capabilities: {} } }) + '\n');
        } else {
            // Answer any other id'd request (incl. tools/call) so a held call
            // flushed to npx after WARM gets a response.
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: 'mock-ok' }] } }) + '\n');
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
start_proxy() {
    PROXY_OUT="$TMPDIR/proxy.out"; : > "$PROXY_OUT"
    PROXY_ERR="$TMPDIR/proxy.err"; : > "$PROXY_ERR"
        # SEE-1344: sandbox holder identity — opt out of the SEE-1338 arbiter
        # (pre-bound listeners here are bare mocks; assertions target warm/
        # hedge/lease semantics, not eviction). E2 pins the one-shot
        # FAILED_EXIT lane ("fast-fail fires exactly once"), so the
        # giveup-rearm default lane is explicitly off.
    coproc PX {
        env \
            "GODOT_HOST=127.0.0.1" \
            "PATH=$MOCK_NPX_DIR:$PATH" \
            "KOL_GODOT_MCP_CMD=npx" \
            "MOCK_NPX_SCRIPT_DIR=$TMPDIR" \
            "KOL_WORKTREE=$SCRATCH_WT" \
            "KOL_PROJECT_GODOT=$SCRATCH_WT/project.godot" \
            "KOL_PORT_ARBITER=off" \
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
CALL_LINE2='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_project_info","arguments":{}}}'

LEASE_EXITING='Lease: no MCP client for the grace window; exiting editor to release the port.'

wait_for() {
    local file="$1" pat="$2" budget="$3" waited=0
    while (( waited < budget )); do
        grep -q "$pat" "$file" 2>/dev/null && return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    return 1
}

wait_for_death() {
    local budget="$1" waited=0
    while (( waited < budget )); do
        proxy_alive || return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    return 1
}

# ---------------------------------------------------------------------------
# E1: GODOT_EDITOR_LOG_FILE → nonexistent path. Proxy must still warm up via
#     TCP probe; must not crash, must not fast-fail, must not stay silent.
# ---------------------------------------------------------------------------
sep "E1: GODOT_EDITOR_LOG_FILE points to nonexistent path → proxy warms via TCP probe"
E1_PORT=$(find_free_port)
E1_LOG="$TMPDIR/e1/does/not/exist.log"   # the LOG file itself never appears
# e43cdc73 sidecar-guard: the holder must prove it serves this slot's worktree
# or it is evicted by design. Pre-writing the .worktree sidecar is holder
# identity only — the asserted condition (missing editor log) is untouched.
mkdir -p "$(dirname "$E1_LOG")"
printf '%s' "$SCRATCH_WT" > "${E1_LOG%.log}.worktree"
E1_LPID=$(start_listener "$E1_PORT")
sleep 0.2

start_proxy "GODOT_PORT=$E1_PORT" "KOL_WARMUP_TIMEOUT_MS=8000" "KOL_FAILED_EXIT_MS=30000" \
            "GODOT_EDITOR_LOG_FILE=$E1_LOG" "MOCK_NPX_LOG=$TMPDIR/e1_npx.log"
send_line "$INIT_LINE"
send_line "$CALL_LINE"

# Proxy should reach WARM via TCP probe (render-stable or simple probe).
# NOTE: match the actual "editor warm detected" line — NOT the substring "warm"
# which would falsely match the very first "waiting for editor warmup" line.
if wait_for "$PROXY_ERR" "editor warm detected" 12000; then
    ok "E1.1: proxy reached WARM despite nonexistent editor log path"
else
    ko "E1.1: proxy did NOT reach WARM within 12s when editor log path missing"
fi

# SEE-1111 目标1 hold-to-warm: the first tools/call (id=2) is HELD in the FIFO
# until the warmup gate opens, then flushed to npx and answered with a real
# result — no warmup hint, no premature flush.
if wait_for "$PROXY_OUT" '"id":2' 8000; then
    ok "E1.2: first tools/call id=2 answered after WARM (held → flushed, no first-call stall)"
else
    ko "E1.2: no id=2 response — proxy never flushed the held call"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "E1.2c: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "E1.2c: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi
if wait_for "$TMPDIR/e1_npx.log" '"id":2' 4000; then
    ok "E1.2d: held id=2 flushed to npx after WARM (hold → flush, not a hint)"
else
    ko "E1.2d: id=2 never reached npx (hold broke the flush)"
fi

# And proxy must NOT have sent a lease-expired error to Claude stdout.
if ! grep -q 'lease expired' "$PROXY_OUT" 2>/dev/null; then
    ok "E1.2b: no lease-expired error response on Claude stdout"
else
    ko "E1.2b: lease false-fail: proxy emitted 'lease expired' even with missing log path"
fi

# And proxy must be alive at end (not silently exited).
if proxy_alive; then
    ok "E1.3: proxy still alive after 12s with nonexistent log path"
else
    ko "E1.3: proxy died unexpectedly when log path missing"
fi
stop_proxy
kill "$E1_LPID" 2>/dev/null || true
sleep 0.3

# ---------------------------------------------------------------------------
# E2: burst of consecutive 'exiting editor' lines → fast-fail EXACTLY ONCE.
#     Specifically: the buffered call gets exactly one rejectQueue error
#     (no duplicate id=2 response), and the process exits 1 promptly.
# ---------------------------------------------------------------------------
sep "E2: burst of multiple 'exiting editor' lines → fast-fail fires exactly once"
E2_PORT=$(find_free_port)
E2_LOG="$TMPDIR/e2-editor.log"; : > "$E2_LOG"

start_proxy "GODOT_PORT=$E2_PORT" "KOL_WARMUP_TIMEOUT_MS=30000" "KOL_FAILED_EXIT_MS=60000" \
            "GODOT_EDITOR_LOG_FILE=$E2_LOG" "MOCK_NPX_LOG=$TMPDIR/e2_npx.log"
send_line "$INIT_LINE"
send_line "$CALL_LINE"
send_line "$CALL_LINE2"
sleep 0.5   # let both calls buffer

# Burst: append 5 identical exiting lines in <100ms.
for _ in 1 2 3 4 5; do
    printf '%s\n' "$LEASE_EXITING" >> "$E2_LOG"
done

if wait_for_death 5000; then
    ok "E2.1: proxy fast-failed after burst of exiting lines"
else
    ko "E2.1: proxy still alive 5s after burst of exiting lines"
fi

# Count id=2 responses in stdout — must be exactly 1 (no double-reject).
ID2_COUNT=$(grep -c '"id":2' "$PROXY_OUT" 2>/dev/null || echo 0)
if [[ "$ID2_COUNT" -eq 1 ]]; then
    ok "E2.2: buffered id=2 received exactly one rejectQueue response (count=$ID2_COUNT)"
else
    ko "E2.2: buffered id=2 received $ID2_COUNT responses (expected exactly 1 — T3 double-reject)"
fi

# id=3 must also receive exactly 1 response.
ID3_COUNT=$(grep -c '"id":3' "$PROXY_OUT" 2>/dev/null || echo 0)
if [[ "$ID3_COUNT" -eq 1 ]]; then
    ok "E2.3: buffered id=3 received exactly one rejectQueue response (count=$ID3_COUNT)"
else
    ko "E2.3: buffered id=3 received $ID3_COUNT responses (expected exactly 1)"
fi

# Proxy log should mention lease death EXACTLY once (no multiple-interval race).
LEASE_LOG_COUNT=$(grep -c 'lease death detected' "$PROXY_ERR" 2>/dev/null || echo 0)
if [[ "$LEASE_LOG_COUNT" -eq 1 ]]; then
    ok "E2.4: lease death logged exactly once (no interval race; count=$LEASE_LOG_COUNT)"
else
    ko "E2.4: lease death logged $LEASE_LOG_COUNT times (expected 1)"
fi
stop_proxy
sleep 0.3

# ---------------------------------------------------------------------------
# E3: GODOT_EDITOR_LOG_FILE set to EMPTY string → no-op. Proxy must warm
#     via TCP probe (no lease false-fail), buffered call flushed.
# ---------------------------------------------------------------------------
sep "E3: GODOT_EDITOR_LOG_FILE='' (explicit empty) → lease monitor fully no-op"
E3_PORT=$(find_free_port)
# e43cdc73 sidecar-guard: with an empty log env the holder cannot prove its
# worktree, so a PRE-BOUND listener is evicted by design. Drive the editor up
# via the mock start script instead — the asserted behavior (warm + held-call
# flush under empty GODOT_EDITOR_LOG_FILE) is unchanged.
E3_CFG="$TMPDIR/e3-configure.sh"; printf '#!/usr/bin/env bash\nexit 0\n' > "$E3_CFG"; chmod +x "$E3_CFG"
E3_START="$TMPDIR/e3-start.sh"
{
    echo '#!/usr/bin/env bash'
    echo 'if [[ -n "${GODOT_PORT:-}" ]]; then'
    echo "    LISTEN_PORT=\"\$GODOT_PORT\" nohup node \"$LISTENER_SCRIPT\" </dev/null >/dev/null 2>\"$TMPDIR/e3-listener.err\" &"
    echo 'fi'
    echo 'exit 0'
} > "$E3_START"
chmod +x "$E3_START"

start_proxy "GODOT_PORT=$E3_PORT" "KOL_WARMUP_TIMEOUT_MS=8000" "KOL_FAILED_EXIT_MS=30000" \
            "KOL_CONFIGURE_SH=$E3_CFG" "KOL_START_SH=$E3_START" \
            "GODOT_EDITOR_LOG_FILE=" "MOCK_NPX_LOG=$TMPDIR/e3_npx.log"
send_line "$INIT_LINE"
send_line "$CALL_LINE"

if wait_for "$PROXY_ERR" "editor warm detected" 12000; then
    ok "E3.1: proxy reached WARM with empty GODOT_EDITOR_LOG_FILE"
else
    ko "E3.1: proxy did NOT warm with empty GODOT_EDITOR_LOG_FILE"
fi

# SEE-1111 目标1 hold-to-warm: same held → flushed semantics for id=2 (no hint).
if wait_for "$PROXY_OUT" '"id":2' 8000; then
    ok "E3.2: first tools/call id=2 answered after WARM (held → flushed, empty env)"
else
    ko "E3.2: no id=2 response (empty env — proxy never flushed the held call)"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "E3.2c: warmup-hint text appeared (empty env — default hint must be gone)"
else
    ok "E3.2c: no warmup-hint text anywhere (empty env — hold-to-warm)"
fi
if wait_for "$TMPDIR/e3_npx.log" '"id":2' 4000; then
    ok "E3.2d: held id=2 flushed to npx after WARM (empty env — hold → flush)"
else
    ko "E3.2d: id=2 never reached npx (empty env — hold broke the flush)"
fi

if ! grep -q 'lease expired' "$PROXY_OUT" 2>/dev/null; then
    ok "E3.2b: no lease-expired error response on Claude stdout"
else
    ko "E3.2b: lease false-fail with empty env"
fi
stop_proxy
# (E3 editor lifecycle is owned by the mock start script; nothing extra to kill)
sleep 0.3

# ---------------------------------------------------------------------------
sep "Summary"
echo -e "PASS=${GREEN}${PASS}${NC} FAIL=${RED}${FAIL}${NC}"
if (( FAIL > 0 )); then
    echo -e "${RED}FAILED ASSERTIONS:${NC}"
    for f in "${FAILS[@]}"; do echo "  - $f"; done
    exit 1
fi
echo -e "${GREEN}RESULT: ALL EDGE CASES GREEN.${NC} lease monitor robust against missing path, burst fire, empty env."
exit 0
