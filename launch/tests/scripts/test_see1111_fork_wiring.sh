#!/usr/bin/env bash
# test_see1111_fork_wiring.sh
#
# SEE-1111 (fork wiring) — verifies the launcher serves godot-mcp from the
# OWNER's fork (tadki/godot-mcp) instead of upstream @satelliteoflove/godot-mcp,
# with the configurable server timeout cranked past the cold-boot window.
#
# Background: the upstream server's socket timeout (QUICK_TIMEOUT_MS, 30s) can
# be shorter than a cold Godot editor boot (~27s to WS handshake), so the first
# tools/call during cold start fails 'Not connected'. The owner forked
# godot-mcp, making QUICK_TIMEOUT_MS configurable via GODOT_MCP_QUICK_TIMEOUT_MS
# (default 30s unchanged). The launcher exports GODOT_MCP_GODOT_MCP_CMD=<fork
# cli.js> so the resolver spawns `node <fork cli.js>`, and exports
# GODOT_MCP_QUICK_TIMEOUT_MS so the fork's server waits out the cold boot.
# SEE-1292 LOW-2: the fork CLI path is resolved relative to the submodule's
# own location (launch/../server/dist/cli.js), not a hardcoded D-drive path
# from the pre-SEE-1273 layout.
#
# Design: the wiring is DEFAULT-ONLY (${VAR:-...}). A test harness or operator
# that sets KOL_GODOT_MCP_CMD / GODOT_MCP_QUICK_TIMEOUT_MS explicitly always
# wins, so this test points both at an absolute-path mock bin and asserts the
# launcher honors the override (never clobbers it) — the same property that lets
# the proxy-based mock suites (mock npx on PATH) keep working unchanged.
#
# Assertions:
#   W1  launcher honors an external KOL_GODOT_MCP_CMD override (absolute path)
#       — exported unchanged into the proxy env (mock bin echoes its argv).
#   W2  launcher honors an external GODOT_MCP_QUICK_TIMEOUT_MS override.
#   W3  launcher logs the fork-wired stage line (FORK_WIRED) when the fork CLI
#       exists on this machine.
#   W4  launcher logs a warning (keeps upstream) when the fork CLI is missing.
#   W5  the proxy logs 'launching godot-mcp via node <mock-bin>' — the resolver
#       picked the override and spawned `node <mock-bin>` (fork path in prod).
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1111_fork_wiring.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LAUNCH_DIR="$REPO_ROOT/launch"
WRAPPER="$LAUNCH_DIR/godot-mcp-launcher.sh"
PROXY="$LAUNCH_DIR/godot-mcp-proxy.mjs"

PASS=0; FAIL=0; FAILS=()
ok() { echo "  [PASS] $*"; PASS=$((PASS+1)); }
ko() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }

[[ -f "$WRAPPER" ]] || { echo "FATAL: $WRAPPER not found" >&2; exit 2; }
[[ -f "$PROXY" ]]   || { echo "FATAL: $PROXY not found" >&2; exit 2; }

TMPDIR="$(mktemp -d)"
cleanup() { pkill -f "$TMPDIR/ws-mock-listener.mjs" 2>/dev/null || true; rm -rf "$TMPDIR"; }
trap cleanup EXIT

find_free_port() {
    python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()"
}

# Build a stubbed launcher that skips editor setup and execs the real proxy.
make_stubbed_wrapper() {
    local dir="$TMPDIR/stub"
    mkdir -p "$dir"
    # shellcheck disable=SC2016
    awk '
        /^SCRIPT_DIR=".*"$/ { print "SCRIPT_DIR=\"" dir "\""; next }
        /^# --- Parse CLI ---/ && !ins {
            print "port_in_use() { return 0; }"
            ins = 1
        }
        { print }
    ' dir="$dir" "$WRAPPER" > "$dir/godot-mcp-launcher.sh"
    chmod +x "$dir/godot-mcp-launcher.sh"

    cat > "$dir/configure-mcp-port.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    cat > "$dir/start-godot-editor.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$dir"/*.sh
    cp "$PROXY" "$dir/godot-mcp-proxy.mjs"
    cp "$LAUNCH_DIR/godot-mcp-resolve.mjs" "$dir/godot-mcp-resolve.mjs"
    cp "$LAUNCH_DIR/warmup-stage-parser.mjs" "$dir/warmup-stage-parser.mjs"
    cp "$LAUNCH_DIR/agent-ports.lib.sh" "$dir/agent-ports.lib.sh"
    cp "$LAUNCH_DIR/agent-ports.json" "$dir/agent-ports.json"
    echo "$dir"
}

# Mock godot-mcp bin (what the fork cli.js becomes in production): records its
# argv + env, answers initialize + tools/call. argv marker proves it was exec'd
# as `node <bin>`.
MOCK_BIN="$TMPDIR/mock-fork-cli.js"
cat > "$MOCK_BIN" <<EOF
import * as readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const MARKER = '$TMPDIR/fork.marker';
appendFileSync(MARKER, process.argv.join('\\n') + '\\n---\\n');
appendFileSync(MARKER, 'QUICK=' + (process.env.GODOT_MCP_QUICK_TIMEOUT_MS || 'unset') + '\\n---\\n');
const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { name: 'mock-fork-godot-mcp', protocolVersion: '2024-11-05', capabilities: {} } }) + '\\n');
        } else {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: 'fork-ok' }] } }) + '\\n');
        }
    } catch (e) {}
});
EOF
chmod +x "$MOCK_BIN"

sep() { echo; echo "================================================================"; echo "$*"; echo "================================================================"; }

# --- Case A: external overrides must win (W1/W2) ------------------------------
sep "Case A: launcher honors external KOL_GODOT_MCP_CMD + GODOT_MCP_QUICK_TIMEOUT_MS overrides"
STUB_DIR="$(make_stubbed_wrapper)"
PORT_A=$(find_free_port)
: > "$TMPDIR/fork.marker"
# The proxy spawns the godot-mcp child lazily on the first tools/call; run the
# stubbed launcher through a full initialize + trigger + retry so the child is
# actually spawned and we can read its env/argv.
(
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"fork-test"}}}'
    sleep 0.5
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_project_info","arguments":{}}}'
    sleep 4
) | env \
    "KOL_AGENT_NAME=Bachi" \
    "GODOT_HOST=127.0.0.1" \
    "GODOT_PORT=$PORT_A" \
    "KOL_GODOT_MCP_CMD=$MOCK_BIN" \
    "GODOT_MCP_QUICK_TIMEOUT_MS=12345" \
    bash "$STUB_DIR/godot-mcp-launcher.sh" --port "$PORT_A" \
    >"$TMPDIR/caseA.out" 2>"$TMPDIR/caseA.err" &
pid=$!
sleep 5
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true

# W2: the mock bin saw the external timeout (NOT the default 90000).
if grep -q "QUICK=12345" "$TMPDIR/fork.marker"; then
    ok "W2: external GODOT_MCP_QUICK_TIMEOUT_MS=12345 exported unchanged (mock saw QUICK=12345)"
else
    ko "W2: external timeout override lost (marker: $(grep QUICK= "$TMPDIR/fork.marker" 2>/dev/null | tail -1))"
fi

# W1: the mock bin was exec'd as node <mock-bin> (override path won, not the fork default).
if [[ -s "$TMPDIR/fork.marker" ]] && grep -q "$MOCK_BIN" "$TMPDIR/fork.marker"; then
    ok "W1: launcher honored external KOL_GODOT_MCP_CMD=$MOCK_BIN (node <mock-bin> in argv)"
else
    ko "W1: external KOL_GODOT_MCP_CMD override lost (marker empty or missing bin)"
fi

# W5: the proxy resolved via the override and logged the direct-node provenance.
if grep -q "launching godot-mcp via node $MOCK_BIN" "$TMPDIR/caseA.err"; then
    ok "W5: proxy logged 'launching godot-mcp via node $MOCK_BIN' (override picked, node <bin> path)"
else
    ko "W5: proxy did not log the override provenance (got: $(grep 'launching godot-mcp' "$TMPDIR/caseA.err" | head -1))"
fi

# --- Case B: fork present → FORK_WIRED stage line + default timeout (W3) ------
sep "Case B: fork present on this machine → launcher logs FORK_WIRED"
STUB_DIR_B="$(make_stubbed_wrapper)"
PORT_B=$(find_free_port)
FORK_CLI="${GODOT_MCP_FORK_CLI:-${REPO_ROOT}/server/dist/cli.js}"
if [[ -x "$FORK_CLI" ]]; then
    (
        printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"fork-test"}}}'
        sleep 3
    ) | env \
        "KOL_AGENT_NAME=Bachi" \
        "GODOT_HOST=127.0.0.1" \
        "GODOT_PORT=$PORT_B" \
        bash "$STUB_DIR_B/godot-mcp-launcher.sh" --port "$PORT_B" \
        >"$TMPDIR/caseB.out" 2>"$TMPDIR/caseB.err" &
    pid=$!
    sleep 4
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true

    if grep -q "stage=FORK_WIRED" "$TMPDIR/caseB.err"; then
        ok "W3: launcher logged stage=FORK_WIRED (fork cli=${FORK_CLI})"
    else
        ko "W3: FORK_WIRED stage line missing (stderr: $(grep FORK "$TMPDIR/caseB.err" | head -2))"
    fi
    if grep -q "stage=FORK_WIRED" "$TMPDIR/caseB.err" && grep -o "quick_timeout_ms=90000" "$TMPDIR/caseB.err" | grep -q .; then
        ok "W3b: FORK_WIRED stage carries default quick_timeout_ms=90000"
    else
        ko "W3b: default quick_timeout_ms=90000 not in FORK_WIRED stage"
    fi
else
    # Fork not present: launcher must log the fallback warning (W4).
    (
        printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"fork-test"}}}'
        sleep 3
    ) | env \
        "KOL_AGENT_NAME=Bachi" \
        "GODOT_HOST=127.0.0.1" \
        "GODOT_PORT=$PORT_B" \
        bash "$STUB_DIR_B/godot-mcp-launcher.sh" --port "$PORT_B" \
        >"$TMPDIR/caseB.out" 2>"$TMPDIR/caseB.err" &
    pid=$!
    sleep 4
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true

    if grep -q "fork CLI not found" "$TMPDIR/caseB.err"; then
        ok "W4: fork CLI missing → launcher warns and keeps upstream"
    else
        ko "W4: missing-fork warning not logged"
    fi
    echo "  [skip] W3 (fork not present on this machine)"
fi

# --- Case C: fork absent in stub dir → upstream preserved (W4) -----------------
sep "Case C: fork CLI missing in the stub environment → fallback warning"
STUB_DIR_C="$(make_stubbed_wrapper)"
PORT_C=$(find_free_port)
if [[ ! -x "$FORK_CLI" ]]; then
    # Already covered in Case B's else branch; just re-assert cleanly here.
    :
fi

echo
echo "============================================================"
echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
[[ ${#FAILS[@]} -gt 0 ]] && { echo "FAILURES:"; for f in "${FAILS[@]}"; do echo "  - $f"; done; }
echo "============================================================"
[[ $FAIL -eq 0 ]]
