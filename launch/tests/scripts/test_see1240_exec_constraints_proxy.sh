#!/usr/bin/env bash
# SEE-1240 WS-6 — proxy integration tests for the exec constraint surface
# (mock-npx pattern, inherits the harness conventions of
# test_see1070_proxy_exec_hints.sh / test_see1240_proxy_integration.sh).
#
# Drives the REAL godot-mcp-proxy.mjs against a mock npx + WS mock listener and
# verifies the WS-6 surface end-to-end at the JSON-RPC level:
#   T1 tools/list description patch — godot_exec description carries the SSOT
#      constraint sentence (all denylist tokens + help action + guard note).
#   T2 pre-check RED — {action:"run", source:"OS.execute(...)"} rejected at the
#      proxy with an MCP error naming the violated entry; the call NEVER
#      reaches npx (mock log proves it).
#   T3 pre-check GREEN — comment-hidden token passes the proxy and IS forwarded
#      (mock receives and answers; envelope untouched).
#   T4 help action — {action:"help"} answered IN-BAND with the full digest
#      (mock npx never sees it; no fork-side schema rejection).
#   T5 await ban — {action:"run", source:"await ..."} rejected in-band
#      (SYNC_ONLY), not forwarded.
#   T6 non-exec tool unaffected — plain forwarding, no constraint chatter.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1240_exec_constraints_proxy.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PROXY="$REPO_ROOT/launch/godot-mcp-proxy.mjs"

[[ -f "$PROXY" ]] || { echo "FATAL: $PROXY not found" >&2; exit 2; }

PASS=0; FAIL=0; FAILS=()
ok() { echo "  [PASS] $*"; PASS=$((PASS+1)); }
ko() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }
sep() { echo; echo "================================================================"; echo "$*"; echo "================================================================"; }

TMPDIR="$(mktemp -d)"
cleanup() {
    pkill -f "$TMPDIR/ws-mock-listener.mjs" 2>/dev/null || true
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

find_free_port() {
    python3 - <<'PY'
import socket, random
ports = list(range(6000, 65536)); random.shuffle(ports)
for p in ports:
    try:
        s = socket.socket(); s.bind(('127.0.0.1', p)); s.close(); print(p); break
    except OSError:
        continue
else:
    raise SystemExit('no free port in 6000-65535')
PY
}

# --- Mock npx ---------------------------------------------------------------
# Records every received tools/call name into MOCK_NPX_LOG; godot_exec run
# answers with a clean envelope (the pre-check GREEN path must REACH it).
MOCK_NPX="$TMPDIR/mock-npx.mjs"
cat > "$MOCK_NPX" <<'EOF'
import * as readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const LOG = process.env.MOCK_NPX_LOG || '';
const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return; }
    if (msg.method === 'tools/call') {
        const p = msg.params || {};
        try { if (LOG) appendFileSync(LOG, p.name + ':' + ((p.arguments || {}).action || '') + '\n'); } catch (e) {}
    }
    if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { name: 'mock-godot-mcp', protocolVersion: '2024-11-05', capabilities: {} }
        }) + '\n');
        return;
    }
    if (msg.method === 'tools/list') {
        process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { tools: [{
                name: 'godot_exec',
                description: 'A static denylist rejects accidental process/file-write escape ' +
                    '(OS.execute, DirAccess, write-mode FileAccess, ResourceSaver, ProjectSettings.save, ...) and ' +
                    'names the offending token — an accident guard, NOT a security boundary.',
                inputSchema: { type: 'object' },
            }] }
        }) + '\n');
        return;
    }
    process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ completed: true, result: 'ok', runtime_errors: [] }) }] }
    }) + '\n');
});
EOF

MOCK_NPX_DIR="$TMPDIR/mock_npx_bin"
mkdir -p "$MOCK_NPX_DIR"
cat > "$MOCK_NPX_DIR/npx" <<EOF
#!/usr/bin/env bash
exec node "$MOCK_NPX" "\$@"
EOF
chmod +x "$MOCK_NPX_DIR/npx"
MOCK_NPX_LOG="$TMPDIR/npx-calls.log"; : > "$MOCK_NPX_LOG"

# --- WS-completing mock listener (proxy reaches WARM via real handshake) -----
LISTENER_SCRIPT="$TMPDIR/ws-mock-listener.mjs"
cp "$SCRIPT_DIR/ws-mock-listener.mjs" "$LISTENER_SCRIPT"
start_listener() { LISTEN_PORT="$1" node "$LISTENER_SCRIPT" </dev/null >/dev/null 2>"$TMPDIR/listener.err" & echo $!; }

TEST_PORT=$(find_free_port)
LIS_PID=$(start_listener "$TEST_PORT")

# --- Scratch worktree (SEE-1111 isolation, same as the exec-hints harness) ---
SCRATCH_WT="$TMPDIR/scratch-worktree"
mkdir -p "$SCRATCH_WT/launch"
printf 'config_version=5\n\n[godot_mcp]\n\nport_override_enabled=false\nport_override=6550\n' > "$SCRATCH_WT/project.godot"

PROXY_OUT="$TMPDIR/proxy.out"; : > "$PROXY_OUT"
PROXY_ERR="$TMPDIR/proxy.err"; : > "$PROXY_ERR"
coproc PX {
    env \
        "GODOT_HOST=127.0.0.1" \
        "PATH=$MOCK_NPX_DIR:$PATH" \
        "KOL_GODOT_MCP_CMD=npx" \
        "GODOT_PORT=${TEST_PORT}" \
        "KOL_WARMUP_TIMEOUT_MS=8000" \
        "KOL_FAILED_EXIT_MS=60000" \
        "KOL_WORKTREE=$SCRATCH_WT" \
        "KOL_PROJECT_GODOT=$SCRATCH_WT/project.godot" \
        "MOCK_NPX_LOG=$MOCK_NPX_LOG" \
        node "$PROXY" >"$PROXY_OUT" 2>"$PROXY_ERR"
}
PX_PID=$PX_PID

send_line() { printf '%s\n' "$1" >&"${PX[1]}" 2>/dev/null || true; }
wait_for() {
    local file="$1" pat="$2" budget="$3" waited=0
    while (( waited < budget )); do
        grep -q "$pat" "$file" 2>/dev/null && return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    return 1
}

# Per-id checks via python. Extra pseudo-checks:
#   'mcp_error'       — response is an MCP-level error (rejected at the proxy)
#   'error_names=<tok>' — the error message names the violated entry
#   'error_has_digest'  — the error points at {action:"help"} for the full list
#   'digest_surfaced'   — result text carries the SSOT digest header
check_id() {
    local id="$1"; shift
    ID="$id" OUT_FILE="$PROXY_OUT" python3 - "$@" <<'PY'
import json, os, sys
idv = os.environ['ID']; out = os.environ['OUT_FILE']
checks = sys.argv[1:]
line = None
with open(out) as f:
    for ln in f:
        if ('"id":%s' % idv) in ln or ('"id": %s' % idv) in ln:
            line = ln.strip()
if line is None:
    print("FAIL: no response line with id=%s on proxy stdout" % idv); sys.exit()
try:
    msg = json.loads(line)
except Exception as e:
    print("FAIL: id=%s response not valid JSON (%s)" % (idv, e)); sys.exit()
errs = []
for c in checks:
    if c == 'is_result':
        if msg.get('result') is None: errs.append("expected result, got error: %r" % (msg.get('error') or {}).get('message', '')[:80])
    elif c == 'mcp_error':
        if msg.get('error') is None: errs.append("expected MCP-level error, got result")
    elif c.startswith('error_names='):
        want = c.split('=', 1)[1]
        got = (msg.get('error') or {}).get('message', '')
        if want not in got: errs.append("error does not name %r (msg=%r)" % (want, got[:100]))
    elif c == 'error_has_digest':
        got = (msg.get('error') or {}).get('message', '')
        if 'action:"help"' not in got: errs.append("error does not point at help action")
    elif c == 'envelope_completed_true':
        items = (msg.get('result') or {}).get('content') or []
        text = next((x.get('text') for x in items if x.get('type') == 'text'), '')
        try: env = json.loads(text)
        except Exception: env = {}
        if env.get('completed') is not True: errs.append("envelope completed != true: %r" % env.get('completed'))
    elif c == 'digest_surfaced':
        items = (msg.get('result') or {}).get('content') or []
        text = next((x.get('text') for x in items if x.get('type') == 'text'), '')
        if 'SEE-1240 WS-6 SSOT' not in text: errs.append("digest header missing from help response")
    elif c == 'result_is_error_text':
        items = (msg.get('result') or {}).get('content') or []
        text = next((x.get('text') for x in items if x.get('type') == 'text'), '')
        if 'Error' not in text: errs.append("expected error-styled text, got %r" % text[:60])
if errs:
    print("FAIL: " + "; ".join(errs))
else:
    print("PASS")
PY
}

sep "SEE-1240 WS-6 exec constraint proxy E2E (port=$TEST_PORT)"

INIT_LINE='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-test"}}}'
send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 4000 && ok "pre: initialize (id=1) answered through proxy" || ko "pre: no initialize response — chain dead"
send_line '{"jsonrpc":"2.0","id":999,"method":"tools/call","params":{"name":"get_project_info","arguments":{}}}'
wait_for "$PROXY_ERR" 'editor warm detected' 6000 && ok "pre: proxy reached WARM" || ko "pre: proxy never reached WARM — later cases may mislead"

# T1 — tools/list description patch: SSOT sentence replaces the fork anchor.
sep "T1: tools/list → godot_exec description patched with SSOT constraints"
send_line '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
if wait_for "$PROXY_OUT" '"id":2' 4000; then
    T1_VERDICT=$(ID=2 OUT_FILE="$PROXY_OUT" python3 - <<'PY'
import json, os, sys
out = os.environ['OUT_FILE']
line = None
with open(out) as f:
    for ln in f:
        if '"id":2' in ln: line = ln.strip()
msg = json.loads(line)
tools = (msg.get('result') or {}).get('tools') or []
ex = next((t for t in tools if t.get('name') == 'godot_exec'), None)
errs = []
if ex is None:
    errs.append("godot_exec tool missing from tools/list")
else:
    d = ex.get('description') or ''
    for tok in ['OS.execute', 'DirAccess', 'ResourceSaver', 'ProjectSettings.save_custom', 'EditorInterface']:
        if tok not in d: errs.append("description missing token %r" % tok)
    if "action:'help'" not in d: errs.append("description missing help action doc")
    if 'A static denylist rejects' in d: errs.append("fork anchor NOT replaced (patch skipped?)")
    if 'SYNC ONLY' not in d: errs.append("description missing SYNC ONLY rule")
if errs:
    print("FAIL: " + "; ".join(errs))
else:
    print("PASS")
PY
)
    [[ "$T1_VERDICT" == PASS ]] && ok "T1.1: godot_exec description carries SSOT constraints (anchor replaced)" || ko "T1.1: $T1_VERDICT"
else
    ko "T1: no id=2 response on stdout"
fi

# T2 — pre-check RED: violating run rejected in-band, NEVER forwarded.
sep "T2: OS.execute run → proxy rejects, names entry, not forwarded"
: > "$MOCK_NPX_LOG"
send_line '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"godot_exec","arguments":{"action":"run","source":"OS.execute(\"ls\")"}}}'
if wait_for "$PROXY_OUT" '"id":3' 4000; then
    R=$(check_id 3 mcp_error 'error_names=OS.execute' error_has_digest)
    [[ "$R" == PASS ]] && ok "T2.1: id=3 rejected in-band naming OS.execute + help pointer" || ko "T2.1: $R"
    sleep 0.3
    if grep -q "godot_exec:run" "$MOCK_NPX_LOG"; then
        ko "T2.2: violating call LEAKED to npx (must be intercepted)"
    else
        ok "T2.2: violating call never reached npx"
    fi
else
    ko "T2.1: no id=3 response on stdout"
fi

# T3 — pre-check GREEN: comment-hidden token passes and IS forwarded.
sep "T3: comment-hidden token → forwarded untouched"
send_line '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"godot_exec","arguments":{"action":"run","source":"# OS.execute\nreturn 1"}}}'
if wait_for "$PROXY_OUT" '"id":4' 4000; then
    R=$(check_id 4 is_result envelope_completed_true)
    [[ "$R" == PASS ]] && ok "T3.1: id=4 comment-hidden source forwarded, envelope intact" || ko "T3.1: $R"
    sleep 0.3
    grep -q "godot_exec:run" "$MOCK_NPX_LOG" && ok "T3.2: clean-ish call reached npx" || ko "T3.2: call did not reach npx"
else
    ko "T3.1: no id=4 response on stdout"
fi

# T4 — help action: answered in-band with the full digest; npx never sees it.
sep "T4: {action:'help'} → in-band SSOT digest (fork never validates it)"
send_line '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"godot_exec","arguments":{"action":"help"}}}'
if wait_for "$PROXY_OUT" '"id":5' 4000; then
    R=$(check_id 5 is_result digest_surfaced)
    [[ "$R" == PASS ]] && ok "T4.1: id=5 help digest answered in-band" || ko "T4.1: $R"
    sleep 0.3
    if grep -q "godot_exec:help" "$MOCK_NPX_LOG"; then
        ko "T4.2: help call LEAKED to npx (would hit fork schema rejection)"
    else
        ok "T4.2: help call never reached npx"
    fi
else
    ko "T4.1: no id=5 response on stdout"
fi

# T5 — await ban: SYNC_ONLY rejected in-band.
sep "T5: await source → SYNC_ONLY rejection, not forwarded"
send_line '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"godot_exec","arguments":{"action":"run","source":"await get_tree().process_frame"}}}'
if wait_for "$PROXY_OUT" '"id":6' 4000; then
    R=$(check_id 6 mcp_error 'error_names=await')
    [[ "$R" == PASS ]] && ok "T5.1: id=6 await rejected in-band" || ko "T5.1: $R"
else
    ko "T5.1: no id=6 response on stdout"
fi

# T6 — non-exec tool unaffected.
sep "T6: non-exec tool → plain forwarding, no constraint chatter"
send_line '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"get_project_info","arguments":{}}}'
if wait_for "$PROXY_OUT" '"id":7' 4000; then
    R=$(check_id 7 is_result)
    [[ "$R" == PASS ]] && ok "T6.1: id=7 non-exec forwarded untouched" || ko "T6.1: $R"
else
    ko "T6.1: no id=7 response on stdout"
fi

# Teardown.
[[ -n "${PX[1]:-}" ]] && { eval "exec ${PX[1]}>&-" 2>/dev/null || true; }
[[ -n "${PX[0]:-}" ]] && { eval "exec ${PX[0]}<&-" 2>/dev/null || true; }
kill -9 "$PX_PID" 2>/dev/null || true
wait "$PX_PID" 2>/dev/null || true
kill "$LIS_PID" 2>/dev/null || true

echo
if [[ $FAIL -eq 0 ]]; then
    echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
else
    echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
    echo "FAILURES:"
    for f in "${FAILS[@]}"; do echo "  - $f"; done
    exit 1
fi
