#!/usr/bin/env bash
# SEE-1070 Stage 2 #7 — proxy screenshot-hint integration (Revy real-machine E2E).
#
# Drives the REAL godot-mcp-proxy.mjs against a mock npx + a TCP listener that
# satisfies the editor-warmup probe, so the proxy reaches WARM and forwards
# tools/call requests. Verifies the proxy's ONLY side-effect exception
# (Archi ca665f75): when a screenshot tools/call comes back as an error from
# npx, the proxy appends a hint pointing at screenshot-fallback.sh — without
# swallowing the original error.
#
# Covers Atlas trigger 867d2704:
#   Goal 2 — screenshot error → hint appended (message + data.screenshotFallback),
#            original error FULLY preserved (message prefix + existing data spread).
#   Goal 4 — real-machine confirmation of Refacty's forwarding contract:
#            normal passthrough / screenshot error injects hint / non-screenshot
#            tools NOT falsely hit / non-JSON npx output forwarded verbatim.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1070_proxy_screenshot_hint.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PROXY="$REPO_ROOT/launch/godot-mcp-proxy.mjs"
# SEE-1344: align with the post-T4 real layout — the same constant the
# fast-tier gate (test_see1328_b_screenshot_link.mjs §SPEC-014) pins.
FALLBACK_SCRIPT='addons/godot_mcp/launch/screenshot-fallback.sh'
HINT_FRAGMENT='screenshot-fallback.sh'

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

# Proxy validates GODOT_PORT against 6000-65535; scan that window only.
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
# Answers initialize; for tools/call, returns an ERROR for screenshot-shaped
# names (mirroring the proxy's isScreenshotToolsCall matcher so all forms are
# exercised), a SUCCESS result for the benign non-screenshot name, and a raw
# non-JSON line for the garbage-emitter (verbatim-forwardward probe).
MOCK_NPX="$TMPDIR/mock-npx.mjs"
cat > "$MOCK_NPX" <<'EOF'
import * as readline from 'node:readline';
const isShot = (p) => {
    const n = p && p.name;
    if (typeof n !== 'string') return false;
    if (n === 'capture_game_screenshot' || n === 'capture_editor_screenshot' || n === 'screenshot') return true;
    if (n.startsWith('screenshot_')) return true;
    if (n === 'godot_editor_read') {
        const a = p.arguments && p.arguments.action;
        return typeof a === 'string' && a.startsWith('screenshot');
    }
    return false;
};
const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { return; }
    if (msg.method === 'initialize') {
        process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { name: 'mock-godot-mcp', protocolVersion: '2024-11-05', capabilities: {} }
        }) + '\n');
        return;
    }
    if (msg.method === 'tools/call') {
        const p = msg.params || {};
        if (p.name === 'emit_garbage') {
            // Deliberately invalid JSON line — proxy must forward verbatim, not drop.
            process.stdout.write('not-valid-json-{broken\n');
            return;
        }
        if (isShot(p)) {
            // Simulate the addon's screenshot path failing. Include original
            // message text + structured data so the test can prove the proxy
            // preserves them (appends hint, does not swallow).
            process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: msg.id,
                error: {
                    code: -32603,
                    message: 'addon capture failed: ENOSCREEN (CopyFromScreen returned all-zero)',
                    data: { errno: 42, winSession: 4, source: 'mock-npx' }
                }
            }) + '\n');
            return;
        }
        // Benign non-screenshot tool — plain success result.
        process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: 'project: KingOfLikes' }] }
        }) + '\n');
        return;
    }
});
EOF

MOCK_NPX_DIR="$TMPDIR/mock_npx_bin"
mkdir -p "$MOCK_NPX_DIR"
cat > "$MOCK_NPX_DIR/npx" <<EOF
#!/usr/bin/env bash
exec node "$MOCK_NPX" "\$@"
EOF
chmod +x "$MOCK_NPX_DIR/npx"

# --- WS-completing mock listener (the "editor is up" signal so proxy reaches
# WARM via wsProbe — SEE-1111 缺陷 #6; the warmup probe is a real handshake) ---
LISTENER_SCRIPT="$TMPDIR/ws-mock-listener.mjs"
cp "$SCRIPT_DIR/ws-mock-listener.mjs" "$LISTENER_SCRIPT"
start_listener() { # $1=port
    LISTEN_PORT="$1" node "$LISTENER_SCRIPT" </dev/null >/dev/null 2>"$TMPDIR/listener.err" &
    echo $!
}

# --- Allocate port + raise listener BEFORE the coproc (it reads TEST_PORT) --
TEST_PORT=$(find_free_port)
LIS_PID=$(start_listener "$TEST_PORT")

# --- Scratch worktree (SEE-1111 isolation) -----------------------------------
# The proxy's hot-reuse path re-pins the agent port in the resolved worktree's
# project.godot (SEE-1091) before the screenshot assertions run. With cwd at the
# repo checkout and no KOL_WORKTREE, resolveWorktreeForSpawn() walks up from the
# proxy scriptDir and lands on THIS checkout — rewriting the real project.godot
# (SEE-1111 Goal 3 violation). Point it at an isolated scratch Godot project so
# the re-pin touches only the scratch copy and the repo stays clean.
SCRATCH_WT="$TMPDIR/scratch-worktree"
mkdir -p "$SCRATCH_WT/launch"
printf 'config_version=5\n\n[godot_mcp]\n\nport_override_enabled=false\nport_override=6550\n' > "$SCRATCH_WT/project.godot"
# SEE-1148 P2 sandbox semantics (same seam as T2): opt the proxy out of the
# port arbiter and prove the pre-bound mock listener with the e43cdc73
# .worktree sidecar, else it reads as a cross-runtime holder → evict → no warm.
EDITOR_LOG="$TMPDIR/godot-editor-Bachi.log"
printf '%s' "$SCRATCH_WT" > "${EDITOR_LOG%.log}.worktree"

# --- Proxy under test (coproc bidirectional pipe) ---------------------------
PROXY_OUT="$TMPDIR/proxy.out"; : > "$PROXY_OUT"
PROXY_ERR="$TMPDIR/proxy.err"; : > "$PROXY_ERR"
PX_PID=""
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
        "KOL_PORT_ARBITER=off" \
        "GODOT_EDITOR_LOG_FILE=$EDITOR_LOG" \
        node "$PROXY" >"$PROXY_OUT" 2>"$PROXY_ERR"
}
PX_PID=$PX_PID

send_line() { printf '%s\n' "$1" >&"${PX[1]}" 2>/dev/null || true; }
proxy_alive() { [[ -n "${PX_PID:-}" ]] && kill -0 "$PX_PID" 2>/dev/null; }
wait_for() { # $1=file $2=pattern $3=timeout_ms
    local file="$1" pat="$2" budget="$3" waited=0
    while (( waited < budget )); do
        grep -q "$pat" "$file" 2>/dev/null && return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    return 1
}

# Precise per-id JSON field checks via python (message prefix/suffix, data keys).
# Args: id  Prints "PASS" or "FAIL: <reason>".
check_id() {
    local id="$1"; shift
    ID="$id" OUT_FILE="$PROXY_OUT" FALLBACK="$FALLBACK_SCRIPT" python3 - "$@" <<'PY'
import json, os, sys
idv = os.environ['ID']; out = os.environ['OUT_FILE']; fb = os.environ['FALLBACK']
checks = sys.argv[1:]           # remaining args are check names
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
    print("FAIL: id=%s response not valid JSON (%s) — line=%r" % (idv, e, line)); sys.exit()
errs = []
for c in checks:
    if c == 'is_error':
        if msg.get('error') is None: errs.append("expected error, got result")
    elif c == 'is_result':
        if msg.get('result') is None: errs.append("expected result, got error")
    elif c == 'hint_in_message':
        e = msg.get('error') or {}
        if 'screenshot-fallback.sh' not in (e.get('message') or ''):
            errs.append("message missing hint fragment: %r" % e.get('message'))
    elif c == 'message_prefix_intact':
        e = msg.get('error') or {}
        if not (e.get('message') or '').startswith('addon capture failed'):
            errs.append("original message prefix lost: %r" % e.get('message'))
    elif c == 'fallback_key':
        e = msg.get('error') or {}; d = e.get('data') or {}
        if d.get('screenshotFallback') != fb:
            errs.append("data.screenshotFallback != %s (got %r)" % (fb, d.get('screenshotFallback')))
    elif c == 'original_data_preserved':
        e = msg.get('error') or {}; d = e.get('data') or {}
        if d.get('errno') != 42 or d.get('winSession') != 4 or d.get('source') != 'mock-npx':
            errs.append("original data keys lost (errno/winSession/source): %r" % d)
    elif c == 'no_hint_in_result':
        # non-screenshot success must not carry the hint or fallback key anywhere
        blob = json.dumps(msg.get('result'))
        if 'screenshot-fallback.sh' in blob or 'screenshotFallback' in blob:
            errs.append("non-screenshot result wrongly carries hint/fallback")
if errs:
    print("FAIL: " + "; ".join(errs))
else:
    print("PASS")
PY
}

sep "SEE-1070 #7 proxy screenshot-hint E2E (port=$TEST_PORT)"

# --- Bring proxy to WARM, then drive the contract --------------------------
INIT_LINE='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-test"}}}'
send_line "$INIT_LINE"
if wait_for "$PROXY_OUT" '"id":1' 4000; then
    ok "pre: initialize (id=1) answered through proxy (chain alive)"
else
    ko "pre: no initialize response — proxy/mock chain dead; aborting remaining assertions"
fi
# B1 lazy-load (SEE-1085): warmup is deferred to the first tools/call. The
# listener is already up, so a trigger call makes ensureEditor's probe
# short-circuit (reuse) and the proxy reaches WARM. Inert id=999.
send_line '{"jsonrpc":"2.0","id":999,"method":"tools/call","params":{"name":"get_project_info","arguments":{}}}'
if wait_for "$PROXY_ERR" 'editor warm detected' 6000; then
    ok "pre: proxy reached WARM (listener satisfied tcpProbe)"
else
    ko "pre: proxy never reached WARM — tools/call will not forward; later cases may mislead"
fi

# T1 — Goal 4: non-screenshot tool passes through UNTOUCHED (no false hit).
sep "T1: non-screenshot (get_project_info) passes through, NO hint / NO fallback key"
send_line '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_project_info","arguments":{}}}'
if wait_for "$PROXY_OUT" '"id":2' 4000; then
    R=$(check_id 2 is_result no_hint_in_result)
    [[ "$R" == PASS ]] && ok "T1.1: id=2 result returned, no hint/fallback injected (non-screenshot not falsely hit)" || ko "T1.1: $R"
else
    ko "T1.1: no id=2 response on stdout (passthrough broken)"
fi

# T2 — Goal 2 + Goal 4 core: screenshot error → hint appended, original FULLY preserved.
sep "T2: capture_game_screenshot error → hint appended + original message & data preserved"
send_line '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"capture_game_screenshot","arguments":{}}}'
if wait_for "$PROXY_OUT" '"id":3' 4000; then
    R=$(check_id 3 is_error hint_in_message message_prefix_intact fallback_key original_data_preserved)
    [[ "$R" == PASS ]] && ok "T2.1: id=3 error: hint appended (message+data.screenshotFallback), original prefix + errno/winSession/source intact" || ko "T2.1: $R"
else
    ko "T2.1: no id=3 response on stdout (screenshot error not forwarded)"
fi

# T3 — matcher robustness: capture_editor_screenshot form.
sep "T3: capture_editor_screenshot form also triggers hint (matcher coverage)"
send_line '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"capture_editor_screenshot","arguments":{}}}'
if wait_for "$PROXY_OUT" '"id":4' 4000; then
    R=$(check_id 4 is_error hint_in_message fallback_key)
    [[ "$R" == PASS ]] && ok "T3.1: id=4 (capture_editor_screenshot) hint injected" || ko "T3.1: $R"
else
    ko "T3.1: no id=4 response on stdout"
fi

# T4 — matcher robustness: godot_editor_read action=screenshot_* form.
sep "T4: godot_editor_read action=screenshot_game form also triggers hint"
send_line '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"godot_editor_read","arguments":{"action":"screenshot_game"}}}'
if wait_for "$PROXY_OUT" '"id":5' 4000; then
    R=$(check_id 5 is_error hint_in_message fallback_key)
    [[ "$R" == PASS ]] && ok "T4.1: id=5 (godot_editor_read/screenshot_game) hint injected" || ko "T4.1: $R"
else
    ko "T4.1: no id=5 response on stdout"
fi

# T5 — Goal 4: non-JSON npx output forwarded VERBATIM (not dropped, proxy alive).
sep "T5: invalid-JSON npx line forwarded verbatim; proxy does not crash"
send_line '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"emit_garbage","arguments":{}}}'
if wait_for "$PROXY_OUT" 'not-valid-json-{broken' 4000; then
    ok "T5.1: garbage line forwarded verbatim to Claude stdout"
else
    ko "T5.1: garbage line dropped (not on proxy stdout)"
fi
if proxy_alive; then
    ok "T5.2: proxy still alive after non-JSON line (no crash)"
else
    ko "T5.2: proxy died after forwarding non-JSON line"
fi

# Sanity: the fallback script the hint points at actually exists on disk.
# Post-T4 layout: the path is KOL-consumer relative (addons/godot_mcp/...);
# in this standalone fork checkout the same file lives at launch/.
sep "Sanity: hinted fallback script exists"
FALLBACK_LOCAL="${FALLBACK_SCRIPT#addons/godot_mcp/}"
if [[ -f "$REPO_ROOT/$FALLBACK_SCRIPT" || -f "$REPO_ROOT/$FALLBACK_LOCAL" ]]; then
    ok "sanity: $FALLBACK_SCRIPT exists (hint target is real)"
else
    ko "sanity: $FALLBACK_SCRIPT missing — hint points at a non-existent script"
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
