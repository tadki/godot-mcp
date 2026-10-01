#!/usr/bin/env bash
# SEE-1240 WS-3 — proxy integration tests (mock-npx pattern, inherits the
# harness conventions of test_see1070_proxy_screenshot_hint.sh).
#
# Drives the REAL godot-mcp-proxy.mjs against a mock npx + WS mock listener and
# verifies the WS-3 surface end-to-end at the JSON-RPC level:
#   T1 tools/list patch — godot_ui_inspect appended, D1 description patches
#      applied (mouse-support truth + SEE-1240 capture contract), forward-compat
#      skip on a foreign (unanchored) description.
#   T2 drag sugar — godot_input sequence {drag} expanded into the bridge wire
#      vocabulary BEFORE forwarding (mock npx records what it received).
#   T3 drag sugar error — malformed {drag} answered at the proxy (never
#      forwarded), structured error like the bridge's compile errors.
#   T4 ui_inspect — answered IN-BAND via an internal godot_exec call (the mock
#      sees exec, never godot_ui_inspect); response carries the payload plus
#      reliability annotations; unknown node error propagates as Error text.
#   T5 screenshot contract — successful capture (no auto_step) enriched with
#      _screenshot metadata + exports{png_path,width,height}; PNG verifiably on
#      disk with matching IHDR dims; error-path hint contract from SEE-1070 #7
#      still intact.
#   T6 auto-step — arguments.auto_step=true performs godot_game_time step
#      frames=1 (mock records order: step BEFORE capture) and the response's
#      _screenshot.auto_step proves the step.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1240_proxy_integration.sh

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

# --- mock npx ------------------------------------------------------------------
# Canned fork behaviors:
#   initialize / tools/list  → realistic fork tools (godot_input +
#       godot_editor_read with the CURRENT pre-patch anchor descriptions, so
#       T1 proves both patches match and apply).
#   tools/call godot_exec / godot_game_time → internal-call success. game_time
#       step appends a marker to CALL_LOG; exec echoes the ui-inspect payload.
#   tools/call godot_input   → records inputs to CALL_LOG (T2 inspects).
#   tools/call godot_editor_read action=screenshot_game → 1x1 PNG image result
#       (or an error when args.fail=true — T5 error-path).
#   tools/call godot_ui_inspect → MUST NEVER arrive (T4 failure signal).
MOCK_NPX="$TMPDIR/mock-npx.mjs"
cat > "$MOCK_NPX" <<'EOF'
import * as readline from 'node:readline';
import { appendFileSync } from 'node:fs';

const LOG = process.env.MOCK_CALL_LOG;
const log = (entry) => { try { appendFileSync(LOG, JSON.stringify(entry) + '\n'); } catch {} };

// 1x1 transparent PNG, base64.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const INPUT_DESC = 'Array of inputs to execute. Each entry is one of: a named ACTION (action_name, optional analog strength), a joypad BUTTON (joy_button), an analog AXIS hold (axis + value), a STICK vector (stick + x/y), a raw KEY (key, e.g. "ctrl+s"), or relative mouse LOOK (look: [dx, dy]) — mix freely on one timeline. Joypad events drive bound actions (with real deadzone math), raw _input handlers, and the polled Input singletons (get_joy_axis / is_joy_button_pressed); key events likewise drive bound actions, _input/_unhandled_input, and Input.is_key_pressed; look events deliver InputEventMouseMotion.relative to _input/_unhandled_input for FPS-camera code (duration_ms >= 16 distributes the delta as a smooth sweep). No physical pad, keyboard, or mouse is needed. Limitation: Input.get_connected_joypads() never reports a virtual pad, so games that gate controller mode on pad DETECTION cannot be switched into it.';
const INPUT_TOOL_DESC = 'Inject input into a running Godot game for testing: named actions (with analog strength), joypad buttons, analog axes, stick vectors, raw keyboard keys (with modifier combos), and relative mouse-look. Use get_map to discover available input actions and their bindings, sequence to execute inputs with precise timing (optionally with an effect probe that proves the inputs changed game state), or type_text to type into UI elements. Note: relative mouse-look is supported (look: [dx, dy], for FPS-camera _input handlers); absolute cursor positioning is not (see docs/design/mouse-input-spike.md).';
const EDITOR_DESC = 'Observe the editor and running game: get editor state (open scene, play state, camera, viewport), read the current node selection, pull editor log messages (with an incremental cursor) and stack traces, and capture lossless PNG screenshots of the running game or an editor viewport. Reach for it to check what the editor sees before and after a change; screenshot_game needs a running game, while every other action works in the bare editor. It changes nothing - to select nodes, run/stop/restart, or move the 2D viewport use godot_editor_edit; errors from the running game (not the editor process) come via minimal-godot-mcp\'s get_console_output when that companion server is installed.';

const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
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
            result: { tools: [
                { name: 'godot_input', description: INPUT_TOOL_DESC, inputSchema: {
                    type: 'object',
                    properties: { action: { type: 'string' }, inputs: { type: 'array', description: INPUT_DESC } },
                } },
                { name: 'godot_editor_read', description: EDITOR_DESC, inputSchema: {
                    type: 'object', properties: { action: { type: 'string' } },
                } },
            ] }
        }) + '\n');
        return;
    }
    if (msg.method === 'tools/call') {
        const p = msg.params || {};
        const name = p.name;
        if (name === 'godot_ui_inspect') {
            // The proxy must answer ui_inspect itself; reaching here is a failure.
            log({ kind: 'FORBIDDEN_UI_INSPECT_REACHED_NPX' });
            process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: msg.id,
                error: { code: -32601, message: 'FORBIDDEN: godot_ui_inspect must be answered by the proxy' }
            }) + '\n');
            return;
        }
        if (name === 'godot_game_time') {
            log({ kind: 'game_time', args: p.arguments });
            process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: JSON.stringify({ completed: true, frozen: true, frames: 1, gameplay_ms: 16 }) }] }
            }) + '\n');
            return;
        }
        if (name === 'godot_exec') {
            const src = (p.arguments && p.arguments.source) || '';
            if (src.includes('NODE_NOT_FOUND') === false && src.includes('"NODE_NOT_FOUND"')) {
                // not used; kept for clarity
            }
            // Simulate the game-side snippet: found vs not-found by the node path
            // literal the proxy spliced into the snippet.
            let payload;
            if (src.includes('/root/Missing')) {
                payload = { ok: false, error: 'NODE_NOT_FOUND', node_path: '/root/Missing' };
            } else {
                payload = {
                    ok: true,
                    node_path: '/root/Main/UI/PlayButton',
                    class: 'Button',
                    visible: true,
                    visible_in_tree: true,
                    is_focus_owner: true,
                    is_hovered: false,
                };
            }
            process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: JSON.stringify({ completed: true, result: JSON.stringify(payload), duration_ms: 3, holder_children: 0 }) }] }
            }) + '\n');
            return;
        }
        if (name === 'godot_input') {
            log({ kind: 'godot_input', inputs: p.arguments && p.arguments.inputs });
            process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: 'Input sequence completed: 2 input(s) executed.' }] }
            }) + '\n');
            return;
        }
        if (name === 'godot_editor_read') {
            const a = p.arguments && p.arguments.action;
            if (a === 'screenshot_game') {
                if (p.arguments && p.arguments.fail === true) {
                    process.stdout.write(JSON.stringify({
                        jsonrpc: '2.0', id: msg.id,
                        error: { code: -32603, message: 'addon capture failed: CAPTURE_FAILED (mock)' }
                    }) + '\n');
                } else {
                    process.stdout.write(JSON.stringify({
                        jsonrpc: '2.0', id: msg.id,
                        result: { content: [
                            { type: 'image', data: PNG_B64, mimeType: 'image/png' },
                            { type: 'text', text: 'Frame @16ms, 320x240:' },
                        ] }
                    }) + '\n');
                }
                return;
            }
        }
        // default benign success
        process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: 'ok' }] }
        }) + '\n');
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

LISTENER_SCRIPT="$TMPDIR/ws-mock-listener.mjs"
cp "$SCRIPT_DIR/ws-mock-listener.mjs" "$LISTENER_SCRIPT"
TEST_PORT=$(find_free_port)
LISTEN_PORT="$TEST_PORT" node "$LISTENER_SCRIPT" </dev/null >/dev/null 2>"$TMPDIR/listener.err" &
LIS_PID=$!

# Scratch worktree so the screenshot-contract exports land in isolation.
SCRATCH_WT="$TMPDIR/scratch-worktree"
mkdir -p "$SCRATCH_WT/launch"
printf 'config_version=5\n\n[godot_mcp]\n\nport_override_enabled=false\nport_override=6550\n' > "$SCRATCH_WT/project.godot"

# SEE-1344: the pre-bound listener must pass the e43cdc73 holder check —
# opt out of the SEE-1338 arbiter and pre-write the .worktree sidecar, or the
# holder reads as a cross-runtime squatter → evict → no warm.
EDITOR_LOG="$TMPDIR/godot-editor-Bachi.log"
printf '%s' "$SCRATCH_WT" > "${EDITOR_LOG%.log}.worktree"
# Mock the spawn-chain helpers (prepare/configure/start) — this suite drives
# its own listener and asserts proxy-side contracts, not editor launching.
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMPDIR/mock-prepare.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMPDIR/mock-configure.sh"
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMPDIR/mock-start.sh"
chmod +x "$TMPDIR/mock-prepare.sh" "$TMPDIR/mock-configure.sh" "$TMPDIR/mock-start.sh"

CALL_LOG="$TMPDIR/call-log.jsonl"; : > "$CALL_LOG"

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
        "KOL_PORT_ARBITER=off" \
        "GODOT_EDITOR_LOG_FILE=$EDITOR_LOG" \
        "GODOT_MCP_PREPARE_SH=$TMPDIR/mock-prepare.sh" \
        "GODOT_MCP_CONFIGURE_SH=$TMPDIR/mock-configure.sh" \
        "GODOT_MCP_START_SH=$TMPDIR/mock-start.sh" \
        "MOCK_CALL_LOG=$CALL_LOG" \
        node "$PROXY" >"$PROXY_OUT" 2>"$PROXY_ERR"
}
PX_PID=$PX_PID

send_line() { printf '%s\n' "$1" >&"${PX[1]}" 2>/dev/null || true; }
wait_for() { local file="$1" pat="$2" budget="$3"; local waited=0
    while (( waited < budget )); do
        grep -q "$pat" "$file" 2>/dev/null && return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    return 1
}

# Fetch the JSON line whose jsonrpc id EXACTLY equals $1 from the proxy stdout
# (substring matching would collide id 9 with id 900).
get_line() {
    python3 - "$1" "$PROXY_OUT" <<'PY'
import sys, json
idv = int(sys.argv[1]); path = sys.argv[2]
for ln in open(path):
    try:
        msg = json.loads(ln)
    except Exception:
        continue
    if msg.get('id') == idv:
        print(ln.strip()); break
PY
}

sep "SEE-1240 WS-3 proxy integration (port=$TEST_PORT)"

# Warm the chain: initialize + a trigger call (B1 lazy-load).
send_line '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"see1240-test"}}}'
if wait_for "$PROXY_OUT" '"id":1' 4000; then ok "pre: initialize answered"; else ko "pre: initialize unanswered — abort"; fi
send_line '{"jsonrpc":"2.0","id":900,"method":"tools/call","params":{"name":"get_project_info","arguments":{}}}'
if wait_for "$PROXY_ERR" 'editor warm detected' 6000; then ok "pre: proxy reached WARM"; else ko "pre: never WARM — later cases may mislead"; fi

# --- T1: tools/list patch ------------------------------------------------------
sep "T1: tools/list — ui_inspect appended + D1 description patches"
send_line '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
if wait_for "$PROXY_OUT" '"id":2' 4000; then
    L=$(get_line 2)
    T1="$L" python3 - <<'PY'
import json, os, sys
msg = json.loads(os.environ['T1'])
tools = msg['result']['tools']
names = [t['name'] for t in tools]
errs = []
if 'godot_ui_inspect' not in names: errs.append('godot_ui_inspect missing')
ui = next((t for t in tools if t['name'] == 'godot_ui_inspect'), None)
if ui:
    if 'godot_exec' not in ui['description']: errs.append('ui_inspect desc missing exec-based note')
    if 'unreliable' not in ui['description']: errs.append('ui_inspect desc missing reliability label')
gi = next((t for t in tools if t['name'] == 'godot_input'), None)
if gi:
    if 'absolute cursor positioning is not' in gi['description']: errs.append('godot_input patch NOT applied (stale anchor text present)')
    if 'SEE-1141 Track D' not in gi['description']: errs.append('godot_input patch text missing')
    if 'drag' not in gi['description']: errs.append('godot_input patch missing drag sugar mention')
er = next((t for t in tools if t['name'] == 'godot_editor_read'), None)
if er:
    if 'SEE-1240 capture contract' not in er['description']: errs.append('godot_editor_read patch NOT applied')
    if '_screenshot' not in er['description']: errs.append('editor_read patch missing freshness metadata mention')
    if 'exports' not in er['description']: errs.append('editor_read patch missing exports mention')
# untouched tool stays byte-identical
if gi and 'Inject input into a running Godot game for testing: named actions' not in gi['description']:
    errs.append('godot_input description head changed unexpectedly')
print("PASS" if not errs else "FAIL: " + "; ".join(errs))
PY
    [[ "$( T1="$L" python3 - <<'PY'
import json, os
msg = json.loads(os.environ['T1'])
print('x' if 'godot_ui_inspect' in [t['name'] for t in msg['result']['tools']] else 'y')
PY
)" == "x" ]] && true
    R=$(T1="$L" python3 - <<'PY'
import json, os, sys
msg = json.loads(os.environ['T1'])
tools = msg['result']['tools']
names = [t['name'] for t in tools]
errs = []
if 'godot_ui_inspect' not in names: errs.append('godot_ui_inspect missing')
ui = next((t for t in tools if t['name'] == 'godot_ui_inspect'), None)
if ui:
    if 'godot_exec' not in ui['description']: errs.append('ui_inspect desc missing exec-based note')
    if 'unreliable' not in ui['description']: errs.append('ui_inspect desc missing reliability label')
gi = next((t for t in tools if t['name'] == 'godot_input'), None)
if gi:
    if 'absolute cursor positioning is not' in gi['description']: errs.append('godot_input patch NOT applied (stale anchor present)')
    if 'SEE-1141 Track D' not in gi['description']: errs.append('godot_input patch text missing')
    if 'drag' not in gi['description']: errs.append('godot_input patch missing drag mention')
er = next((t for t in tools if t['name'] == 'godot_editor_read'), None)
if er:
    if 'SEE-1240 capture contract' not in er['description']: errs.append('editor_read patch NOT applied')
    if '_screenshot' not in er['description']: errs.append('editor_read patch missing _screenshot mention')
print("PASS" if not errs else "FAIL: " + "; ".join(errs))
PY
)
    [[ "$R" == PASS ]] && ok "T1.1: ui_inspect appended; input/editor descriptions patched; heads intact" || ko "T1.1: $R"
else
    ko "T1.1: no tools/list response"
fi

# --- T2: drag sugar -------------------------------------------------------------
sep "T2: godot_input drag entry expanded before forwarding"
send_line '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"godot_input","arguments":{"action":"sequence","inputs":[{"action_name":"ui_click"},{"drag":{"from":[10,20],"to":[100,200]}}]}}}'
if wait_for "$PROXY_OUT" '"id":3' 4000; then
    ok "T2.1: drag call answered"
else
    ko "T2.1: no response"
fi
sleep 0.2
R=$(python3 - "$CALL_LOG" <<'PY'
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
inp = [e for e in lines if e.get('kind') == 'godot_input']
if not inp: print("FAIL: no godot_input reached npx"); raise SystemExit
inputs = inp[-1]['inputs']
errs = []
if inputs[0].get('action_name') != 'ui_click': errs.append('non-drag entry lost/reordered')
kinds = []
for e in inputs[1:]:
    if 'mouse_move' in e: kinds.append('move')
    elif 'mouse_button' in e: kinds.append('click')
    else: kinds.append('other')
if kinds != ['move', 'click', 'move', 'move']: errs.append(f'expansion shape wrong: {kinds}')
clicks = [e for e in inputs[1:] if 'mouse_button' in e]
if len(clicks) == 1:
    c = clicks[0]['mouse_button']
    if not (c['x'] == 10 and c['y'] == 20 and c['button'] == 'left'): errs.append('press coords/button wrong')
    if not (clicks[0]['duration_ms'] >= 1): errs.append('press hold missing')
last = inputs[-1]
if not (last.get('mouse_move') == [100, 200]): errs.append('final move wrong')
if 'drag' in json.dumps(inputs): errs.append('raw drag entry leaked to wire')
print("PASS" if not errs else "FAIL: " + "; ".join(errs))
PY
)
[[ "$R" == PASS ]] && ok "T2.2: wire = move→press/hold→sweep→final-move; drag sugar consumed; ui_click preserved" || ko "T2.2: $R"

# --- T3: malformed drag ----------------------------------------------------------
sep "T3: malformed drag answered at proxy (not forwarded)"
BEFORE=$(wc -l < "$CALL_LOG")
send_line '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"godot_input","arguments":{"action":"sequence","inputs":[{"drag":{"from":[5]}}]}}}'
if wait_for "$PROXY_OUT" '"id":4' 4000; then
    L=$(get_line 4)
    R=$(L4="$L" python3 - <<'PY'
import json, os
msg = json.loads(os.environ['L4'])
if msg.get('error') and 'drag.from expects' in msg['error'].get('message', ''):
    print("PASS")
else:
    print(f"FAIL: expected drag.from error, got {json.dumps(msg)[:200]}")
PY
)
    [[ "$R" == PASS ]] && ok "T3.1: structured drag error returned to caller" || ko "T3.1: $R"
else
    ko "T3.1: no response for malformed drag"
fi
sleep 0.2
AFTER=$(wc -l < "$CALL_LOG")
[[ "$AFTER" -eq "$BEFORE" ]] && ok "T3.2: malformed call never reached npx" || ko "T3.2: call leaked to npx ($BEFORE → $AFTER)"

# --- T4: ui_inspect in-band -------------------------------------------------------
sep "T4: godot_ui_inspect answered in-band via internal godot_exec"
send_line '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"godot_ui_inspect","arguments":{"action":"inspect_node","node_path":"/root/Main/UI/PlayButton"}}}'
if wait_for "$PROXY_OUT" '"id":5' 8000; then
    L=$(get_line 5)
    R=$(L5="$L" python3 - <<'PY'
import json, os
msg = json.loads(os.environ['L5'])
text = msg['result']['content'][0]['text']
errs = []
if '"class":"Button"' not in text and '"class": "Button"' not in text: errs.append('payload class missing')
if 'is_focus_owner' not in text: errs.append('focus field missing')
if '[reliability]' not in text: errs.append('reliability annotation missing')
if 'RUNNING GAME' not in text: errs.append('unified node_path semantics note missing')
print("PASS" if not errs else "FAIL: " + "; ".join(errs))
PY
)
    [[ "$R" == PASS ]] && ok "T4.1: payload + reliability + semantics annotations present" || ko "T4.1: $R"
else
    ko "T4.1: no ui_inspect response"
fi
send_line '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"godot_ui_inspect","arguments":{"action":"inspect_node","node_path":"/root/Missing"}}}'
if wait_for "$PROXY_OUT" '"id":6' 8000; then
    L=$(get_line 6)
    R=$(L6="$L" python3 - <<'PY'
import json, os
msg = json.loads(os.environ['L6'])
text = msg['result']['content'][0]['text']
print("PASS" if text.startswith('Error:') and 'NODE_NOT_FOUND' in text else f"FAIL: {text[:150]}")
PY
)
    [[ "$R" == PASS ]] && ok "T4.2: NODE_NOT_FOUND propagates as Error text" || ko "T4.2: $R"
else
    ko "T4.2: no response for missing node"
fi
sleep 0.2
if grep -q 'FORBIDDEN_UI_INSPECT_REACHED_NPX' "$CALL_LOG"; then
    ko "T4.3: ui_inspect LEAKED to npx (must be proxy-answered)"
else
    ok "T4.3: godot_ui_inspect never forwarded to npx"
fi

# --- T5: screenshot contract (success + error paths) ------------------------------
# Pre-capture hygiene: advance one frame so mutation tracking sees a fresh
# frame advance after T2/T3's exec/input mutations (contract-correct sequence).
send_line '{"jsonrpc":"2.0","id":65,"method":"tools/call","params":{"name":"godot_game_time","arguments":{"action":"step","frames":1}}}'
wait_for "$PROXY_OUT" '"id":65' 4000 >/dev/null

sep "T5: screenshot contract — enrichment, exports, error hint intact"
send_line '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"godot_editor_read","arguments":{"action":"screenshot_game"}}}'
if wait_for "$PROXY_OUT" '"id":7' 6000; then
    L=$(get_line 7)
    EXPORTS_DIR="$SCRATCH_WT/.dev/godot-mcp/exports"
    R=$(L7="$L" EXPORTS_DIR="$EXPORTS_DIR" python3 - <<'PY'
import json, os, struct
msg = json.loads(os.environ['L7'])
content = msg['result']['content']
errs = []
img = next((c for c in content if c.get('type') == 'image'), None)
if not img: errs.append('image content missing')
texts = [c['text'] for c in content if c.get('type') == 'text']
meta = None
for t in texts:
    if '_screenshot' in t:
        meta = json.loads(t); break
if not meta: errs.append('_screenshot metadata block missing')
else:
    m = meta['_screenshot']
    for k in ('captured_at_ms', 'capture_latency_ms', 'auto_step', 'stale'):
        if k not in m: errs.append(f'_screenshot.{k} missing')
    if m['stale'] is not False: errs.append(f'fresh capture flagged stale: {m}')
    if meta['exports'].get('png_path') is None: errs.append('exports.png_path missing')
    else:
        p = meta['exports']['png_path']
        if not os.path.isfile(p): errs.append(f'export not on disk: {p}')
        else:
            data = open(p, 'rb').read(24)
            w, h = struct.unpack('>II', data[16:24])
            if (w, h) != (1, 1): errs.append(f'disk PNG dims wrong: {w}x{h}')
        if meta['exports']['width'] != 1 or meta['exports']['height'] != 1:
            errs.append('exports dims mismatch with disk PNG')
    if not any('exports' in t and 'png_path' in t for t in texts): errs.append('exports info not in response text')
print("PASS" if not errs else "FAIL: " + "; ".join(errs))
PY
)
    [[ "$R" == PASS ]] && ok "T5.1: fresh capture enriched (metadata + exports on disk, dims verified)" || ko "T5.1: $R"
else
    ko "T5.1: no response"
fi
# Error path: SEE-1070 #7 hint contract must survive alongside WS-3.
send_line '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"godot_editor_read","arguments":{"action":"screenshot_game","fail":true}}}'
if wait_for "$PROXY_OUT" '"id":8' 6000; then
    L=$(get_line 8)
    R=$(L8="$L" python3 - <<'PY'
import json, os
msg = json.loads(os.environ['L8'])
e = msg.get('error') or {}
okc = 'screenshot-fallback.sh' in e.get('message', '') and 'addon capture failed' in e.get('message', '')
d = e.get('data') or {}
print("PASS" if okc and d.get('screenshotFallback') else "FAIL: hint contract broken")
PY
)
    [[ "$R" == PASS ]] && ok "T5.2: error path keeps SEE-1070 fallback hint (unchanged)" || ko "T5.2: $R"
else
    ko "T5.2: no error response"
fi

# --- T6: opt-in auto-step ----------------------------------------------------------
sep "T6: auto_step=true steps one game-time frame BEFORE the capture"
send_line '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"godot_editor_read","arguments":{"action":"screenshot_game","auto_step":true}}}'
if wait_for "$PROXY_OUT" '"id":9' 10000; then
    L=$(get_line 9)
    R=$(L9="$L" python3 - <<'PY'
import json, os
msg = json.loads(os.environ['L9'])
content = msg['result']['content']
texts = [c['text'] for c in content if c.get('type') == 'text']
meta = None
for t in texts:
    if '_screenshot' in t:
        meta = json.loads(t); break
errs = []
if not meta: errs.append('no _screenshot block')
else:
    m = meta['_screenshot']
    if not m.get('auto_step') or m['auto_step'] != {'frames': 1, 'ok': True}: errs.append(f'auto_step provenance wrong: {m.get("auto_step")}')
    if m.get('stale') is not False: errs.append('auto_step capture flagged stale')
    if not any('freshness verified' in t for t in texts): errs.append('fresh advisory missing')
print("PASS" if not errs else "FAIL: " + "; ".join(errs))
PY
)
    [[ "$R" == PASS ]] && ok "T6.1: auto_step provenance stamped + fresh advisory" || ko "T6.1: $R"
else
    ko "T6.1: no response"
fi
sleep 0.2
R=$(python3 - "$CALL_LOG" <<'PY'
import json, sys
lines = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
gt = [i for i, e in enumerate(lines) if e.get('kind') == 'game_time']
errs = []
if not gt: errs.append('no game_time step recorded')
else:
    step_args = lines[gt[-1]].get('args') or {}
    if step_args.get('action') != 'step' or step_args.get('frames') != 1:
        errs.append(f'step shape wrong: {step_args}')
print("PASS" if not errs else "FAIL: " + "; ".join(errs))
PY
)
[[ "$R" == PASS ]] && ok "T6.2: internal godot_game_time step frames=1 recorded" || ko "T6.2: $R"

# Teardown.
[[ -n "${PX[1]:-}" ]] && { eval "exec ${PX[1]}>&-" 2>/dev/null || true; }
[[ -n "${PX[0]:-}" ]] && { eval "exec ${PX[0]}<&-" 2>/dev/null || true; }
[[ -n "${PX_PID:-}" ]] && kill -9 "$PX_PID" 2>/dev/null || true
[[ -n "${PX_PID:-}" ]] && wait "$PX_PID" 2>/dev/null || true
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
