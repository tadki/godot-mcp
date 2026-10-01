#!/usr/bin/env bash
# _see1085_helpers.sh — shared harness for the SEE-1085 (B1 lazy-load) cold-start
# test suite (test_see1085_t{1..5}_*.sh). Sourced, not run directly.
#
# What each test exercises:
#   T1 cold_spawn   — empty port + first tools/call spawns configure+start once
#   T2 hot_reuse    — port already listening → probe short-circuit, no spawn
#   T3 spawn_fail   — start helper fails → structured spawn_failed diagnostic, fast
#   T4 lease_respawn— warm, lease line kills proxy; a fresh proxy re-spawns
#   T5 dedup        — 5 concurrent tools/call → configure+start exactly once
#
# Test seam (proxy §resolveHelper): KOL_CONFIGURE_SH / KOL_START_SH redirect the
# spawn to counting mock scripts, so the suite never boots a real Godot editor
# (~60s cold boot, fragile in CI). The start mock optionally launches the
# WS-completing mock listener that simulates the editor's WS port (the proxy's
# warmup probe is a real WS handshake — SEE-1111 缺陷 #6 — so the mock editor
# must complete the HTTP Upgrade for wsProbe to observe `open`). renderStable
# flips instantly because we do NOT set GODOT_EDITOR_LOG_FILE (proxy
# §startRenderStableMonitor short-circuits to renderStable=true when the log is
# unset) — except in T4, which needs the lease monitor and sets it.

# Each test sets its own TMPDIR before sourcing cleanup, so this is safe to
# call at the top of every test after `lib_init`.
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
PASS=0; FAIL=0; FAILS=()
ok()   { echo -e "  ${GREEN}[PASS]${NC} $*"; PASS=$((PASS+1)); }
ko()   { echo -e "  ${RED}[FAIL]${NC} $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }
sep()  { echo; echo -e "${CYAN}--- $* ---${NC}"; }
note() { echo -e "  ${YELLOW}[note]${NC} $*"; }

# Resolve repo root + proxy path from this file's location (works regardless of
# the test's CWD, since `source` preserves BASH_SOURCE).
SEE1085_HELPERS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SEE1085_HELPERS_DIR/../../../" && pwd)"
PROXY="$REPO_ROOT/launch/godot-mcp-proxy.mjs"
# The mock editor WS listener lives in the scripts dir (SEE-1111 缺陷 #6): the
# proxy's warmup probe is a REAL WebSocket handshake (wsProbe), so the mock
# editor must complete an HTTP Upgrade — a raw TCP-destroy listener can no
# longer signal "warm". Every harness (helper + per-test copies) writes this
# same file into its TMPDIR as $LISTENER_SCRIPT, keeping one source of truth.
LIB_LISTENER_SCRIPT="$SEE1085_HELPERS_DIR/ws-mock-listener.mjs"

# Sets up TMPDIR, the common mock-npx (answers initialize + any id'd request,
# logs every stdin line), the TCP listener script, the mock-npx bin on PATH,
# and the cleanup trap. After calling this, tests call make_configure_mock /
# make_start_mock to get helper paths, then start_proxy.
lib_init() {
    [[ -f "$PROXY" ]] || { echo "FATAL: $PROXY not found" >&2; exit 2; }
    TMPDIR="$(mktemp -d)"
    cleanup() {
        # Kill the TCP listener(s) we spawned (match the per-test TMPDIR path).
        pkill -f "$TMPDIR/ws-mock-listener.mjs" 2>/dev/null || true
        # Best-effort: tear down the proxy coproc.
        _stop_proxy_inline
        rm -rf "$TMPDIR"
    }
    trap cleanup EXIT
    _SEE1085_LISTENERS=()

    # SEE-1091 isolation: throwaway worktree every test points KOL_WORKTREE at.
    # Tests that do NOT mock KOL_CONFIGURE_SH (T6/T8/T9/T10/T11) run the REAL
    # configure-mcp-port.sh, which rewrites [godot_mcp] port_override in
    # <worktree>/project.godot. Using a throwaway dir keeps those writes OUT of
    # this repo's project.godot (mirrors the B-track convergence test's
    # setup_tmpdir pattern). Tests that DO mock configure (T1-T5) are unaffected
    # but now also stop using the repo as a latent footgun.
    MOCK_WORKTREE="$TMPDIR/mock-worktree"
    mkdir -p "$MOCK_WORKTREE"

    # SEE-1344: the spawn chain now includes prepare-worktree.sh; the real
    # script fails rc=1 against fixture dirs and its spawn_failed drain
    # preempts the warmup-timeout contracts most of these suites pin.
    # Default-mock it (tests pinning prepare semantics override the env).
    printf '#!/usr/bin/env bash\nexit 0\n' > "$TMPDIR/mock-prepare.sh"
    chmod +x "$TMPDIR/mock-prepare.sh"
    _SEE1085_PREPARE_SH="$TMPDIR/mock-prepare.sh"
    cat > "$MOCK_WORKTREE/project.godot" <<'EOF'
config_version=5

[godot_mcp]

port_override_enabled=false
port_override=6550
EOF

    # Mock npx: answers initialize with server info, answers any other id'd
    # request with a generic result, and logs every inbound line (tests assert
    # forwarding by reading MOCK_NPX_LOG). Stays alive until stdin closes.
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
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { name: 'mock-godot-mcp', protocolVersion: '2024-11-05', capabilities: {} } }) + '\n');
        } else {
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

    # Mock editor WS listener: binds 127.0.0.1:LISTEN_PORT and completes a real
    # WebSocket HTTP-Upgrade handshake for inbound sockets (SEE-1111 缺陷 #6).
    # The proxy's warmup probe is wsProbe (a real handshake), so a raw TCP
    # listener that destroys sockets can no longer signal "editor warm".
    # One source of truth: the per-test copies under TMPDIR are all this file.
    LISTENER_SCRIPT="$TMPDIR/ws-mock-listener.mjs"
    cp "$LIB_LISTENER_SCRIPT" "$LISTENER_SCRIPT"
}

find_free_port() {
    python3 - <<'PY'
import socket, random
ports = list(range(6000, 65536))
random.shuffle(ports)
for p in ports:
    try:
        s = socket.socket(); s.bind(('127.0.0.1', p)); s.close(); print(p); break
    except OSError:
        continue
else:
    raise SystemExit('no free port in 6000-65535')
PY
}

# start_listener <port> — launch a TCP listener in the background; tracked for
# cleanup via _SEE1085_LISTENERS. Returns the PID on stdout.
start_listener() {
    local port="$1"
    LISTEN_PORT="$port" node "$LISTENER_SCRIPT" </dev/null >/dev/null 2>"$TMPDIR/listener-${port}.err" &
    local pid=$!
    _SEE1085_LISTENERS+=("$pid")
    echo "$pid"
}

# make_configure_mock <counter-file> <rc> [worktree] — writes a mock
# configure-mcp-port.sh that bumps the counter file and exits with <rc>. When a
# worktree is given, the mock also writes the lease sidecar
# (.godot/mcp-lease.json state=active port=$GODOT_PORT): SEE-1292's
# assert-then-reactivate loop re-runs configure until the sidecar reads
# active@GODOT_PORT, so a counter-only mock now counts 4 configure runs per
# spawn. Echoes the script path.
make_configure_mock() {
    local counter="$1" rc="$2" wt="$3"
    local sh="$TMPDIR/mock-configure.sh"
    cat > "$sh" <<EOF
#!/usr/bin/env bash
echo x >> "\${KOL_CONFIGURE_COUNTER:-$counter}"
if [[ -n "${wt}" ]]; then
    mkdir -p "${wt}/.godot"
    printf '{"state":"active","port":%s}' "\$GODOT_PORT" > "${wt}/.godot/mcp-lease.json"
fi
exit $rc
EOF
    chmod +x "$sh"
    echo "$sh"
}

# make_start_mock <counter-file> <rc> <spawn-listener:0|1> — writes a mock
# start-godot-editor.sh. When spawn-listener=1 it nohup's the WS-completing mock
# listener on GODOT_PORT (simulating the editor binding its WS port) before
# returning, so the proxy's warmupLoop wsProbe can complete a handshake and flip
# warm. Echoes the script path.
make_start_mock() {
    local counter="$1" rc="$2" spawn="${3:-0}"
    local sh="$TMPDIR/mock-start.sh"
    cat > "$sh" <<EOF
#!/usr/bin/env bash
echo x >> "\${KOL_START_COUNTER:-$counter}"
if [[ "$spawn" == "1" && -n "\${GODOT_PORT:-}" ]]; then
    nohup env "LISTEN_PORT=\${GODOT_PORT}" node "$LISTENER_SCRIPT" </dev/null >/dev/null 2>"$TMPDIR/listener-start.err" &
    disown || true
fi
if [[ $rc -ne 0 ]]; then
    echo "=== 启动失败诊断（结构化） ===" >&2
    echo "bucket=spawn_failed_start rc=$rc godot_editor=/nonexistent/Godot.exe" >&2
fi
exit $rc
EOF
    chmod +x "$sh"
    echo "$sh"
}

# start_proxy <env>...<env> — coproc the proxy with the given env assignments
# (each arg is a NAME=VAL token, applied via env). Proxy stdout/stderr land in
# $PROXY_OUT/$PROXY_ERR; PX_PID holds the pid for proxy_alive/stop_proxy.
start_proxy() {
    PROXY_OUT="$TMPDIR/proxy.out"; : > "$PROXY_OUT"
    PROXY_ERR="$TMPDIR/proxy.err"; : > "$PROXY_ERR"
    coproc PX {
        env \
            "GODOT_HOST=127.0.0.1" \
            "PATH=$MOCK_NPX_DIR:$PATH" \
            "MOCK_NPX_SCRIPT_DIR=$TMPDIR" \
            "GODOT_MCP_PREPARE_SH=${_SEE1085_PREPARE_SH}" \
            `# SEE-1111: opt the resolver OUT of the owner-fork preference so the` \
            `# proxy spawns THIS mock npx (on PATH), not the real fork — the mock` \
            `# only answers JSON-RPC; it never drives a real editor.` \
            "KOL_DIRECT_GODOT_MCP=0" \
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

stop_proxy() { _stop_proxy_inline; }
_stop_proxy_inline() {
    [[ -n "${PX[1]:-}" ]] && { eval "exec ${PX[1]}>&-" 2>/dev/null || true; }
    [[ -n "${PX[0]:-}" ]] && { eval "exec ${PX[0]}<&-" 2>/dev/null || true; }
    if [[ -n "${PX_PID:-}" ]]; then
        [[ -n "${PX_PID:-}" ]] && kill -9 "$PX_PID" 2>/dev/null || true
        [[ -n "${PX_PID:-}" ]] && wait "$PX_PID" 2>/dev/null || true
        PX_PID=""
    fi
}

# wait_for <file> <pattern> <budget_ms> — poll a file for a grep pattern.
wait_for() {
    local file="$1" pat="$2" budget="$3" waited=0
    while (( waited < budget )); do
        grep -q "$pat" "$file" 2>/dev/null && return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    return 1
}

# wait_for_death <budget_ms> — returns 0 if the proxy exits within budget.
wait_for_death() {
    local budget="$1" waited=0
    while (( waited < budget )); do
        proxy_alive || return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    return 1
}

# wait_count <file> <value> <budget_ms> — SEE-1342 §SPEC-105 (D4): bounded
# predicate poll for a counter file to REACH an exact line count. The evented
# replacement for "sleep N then read" when the target value is known: returns
# as soon as the event (count==value) lands, upper-bounded by budget.
wait_count() {
    local file="$1" want="$2" budget="${3:-5000}" waited=0 have
    while (( waited < budget )); do
        have=$(count_lines "$file")
        [[ "$have" == "$want" ]] && return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    return 1
}

# wait_for_stable <file> <budget_ms> — SEE-1342 §SPEC-105 (D4, event-driven
# rule): evented counterpart of "sleep N" settle windows. Returns 0 once the
# file's mtime has stayed unchanged for ~KOL_WAIT_STABLE_MS (default 400ms) —
# the writes the test is settling for have landed — or when the budget
# expires (same deadline behavior as the fixed sleep it replaces; bounded,
# never longer). Second-resolution mtimes, hence the 400ms stability floor.
wait_for_stable() {
    local path="$1" budget="${2:-2000}" waited=0 stable_ms="${KOL_WAIT_STABLE_MS:-400}"
    local last=0 now
    last=$(stat -c %Y "$path" 2>/dev/null || echo 0)
    while (( waited < budget )); do
        sleep 0.05; waited=$(( waited + 50 ))
        now=$(stat -c %Y "$path" 2>/dev/null || echo 0)
        if (( last > 0 && now == last )); then
            if (( waited >= stable_ms )); then return 0; fi
        else
            last="$now"
        fi
    done
    return 0
}

# count_lines <file> — number of lines in a counter file (0 if absent).
count_lines() {
    [[ -f "$1" ]] && wc -l < "$1" | tr -d ' ' || echo 0
}

# Common JSON-RPC request lines. tools/call carries a _meta.progressToken so
# notifyWarmupProgress has a token to emit (design §9 observability).
INIT_LINE='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"see1085"}}}'
call_line() {
    local id="$1"
    printf '{"jsonrpc":"2.0","id":%s,"method":"tools/call","params":{"name":"get_project_info","arguments":{},"_meta":{"progressToken":"pk-%s"}}}' "$id" "$id"
}

# summary — print PASS/FAIL tally and exit 0/1. Call at end of every test.
summary() {
    sep "Summary"
    echo -e "PASS=${GREEN}${PASS}${NC} FAIL=${RED}${FAIL}${NC}"
    echo
    if (( FAIL == 0 )); then
        echo -e "${GREEN}RESULT: ALL GREEN.${NC} SEE-1085 B1 lazy-load behaves per spec."
        exit 0
    else
        echo -e "${RED}RESULT: RED.${NC} ${FAIL} assertion(s) failing:"
        for f in "${FAILS[@]}"; do echo "  - $f"; done
        exit 1
    fi
}
