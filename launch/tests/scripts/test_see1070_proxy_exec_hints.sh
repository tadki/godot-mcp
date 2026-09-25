#!/usr/bin/env bash
# SEE-1070 Stage 3 #8 — proxy godot_exec hint injection.
#
# Drives the REAL godot-mcp-proxy.mjs against a mock npx + a TCP listener that
# satisfies the editor-warmup probe, so the proxy reaches WARM and forwards
# tools/call. Verifies the proxy appends targeted GDScript-pitfall hints to
# godot_exec responses WITHOUT swallowing the original payload:
#   - list comprehension  ([x for x in arr]) → use arr.map()/for
#   - override signature conflict (-> void vs parent -> bool) → unify signature
#   - truncated Array/Dict return (str() ~200 cap) → return JSON.stringify(value)
# And that a clean primitive return and a non-exec tool are passed through
# UNTOUCHED (no false hit).
#
# Boundary (Archi ca665f75, extended to exec by Atlas #8): hints are the only
# side-effect on these responses; the original result/error is fully preserved.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1070_proxy_exec_hints.sh

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
# godot_exec responses keyed off a marker in args.source so each pitfall is
# exercised independently. Returns a SUCCESS result whose text is the outer
# {completed,result,runtime_errors} envelope — the common exec path (errors live
# inside the result text, not as MCP-level errors). emit_garbage emits a raw
# non-JSON line for the verbatim-forward probe.
MOCK_NPX="$TMPDIR/mock-npx.mjs"
cat > "$MOCK_NPX" <<'EOF'
import * as readline from 'node:readline';
const longArr = '[' + Array(220).fill('(1, 2, 3)').join(', ') + ']'; // > 200 chars → str()-truncated
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
        const src = (p.arguments && p.arguments.source) || '';
        if (p.name === 'emit_garbage') {
            process.stdout.write('not-valid-json-{broken\n');
            return;
        }
        if (p.name !== 'godot_exec') {
            // Non-exec tool — plain success, must pass through UNTOUCHED.
            process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id: msg.id,
                result: { content: [{ type: 'text', text: 'project: KingOfLikes' }] }
            }) + '\n');
            return;
        }
        let env;
        if (src.includes('listcomp')) {
            env = { completed: false, result: '', runtime_errors: ['Parse Error: unexpected token near [x for x in range(10)]'] };
        } else if (src.includes('sigconflict')) {
            env = { completed: false, result: '', runtime_errors: ['Override return type "-> void" conflicts with parent signature -> bool'] };
        } else if (src.includes('truncateme')) {
            env = { completed: true, result: longArr, runtime_errors: [] };
        } else if (src.includes('dictshorthand')) {
            env = { completed: false, result: '', runtime_errors: ['Parse Error: Dictionary key must have a name (shorthand not allowed)'] };
        } else if (src.includes('topfunc')) {
            env = { completed: false, result: '', runtime_errors: ['Parse Error: Cannot declare a top-level func in a function body (nested declaration)'] };
        } else if (src.includes('waitsleep')) {
            env = { completed: false, result: '', runtime_errors: ['SYNC_ONLY: exec source is synchronous-only; await is not allowed'] };
        } else {
            // clean — primitive return, no pitfall, no hint expected.
            env = { completed: true, result: '42', runtime_errors: [] };
        }
        process.stdout.write(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: JSON.stringify(env) }] }
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
start_listener() { LISTEN_PORT="$1" node "$LISTENER_SCRIPT" </dev/null >/dev/null 2>"$TMPDIR/listener.err" & echo $!; }

TEST_PORT=$(find_free_port)
LIS_PID=$(start_listener "$TEST_PORT")

# --- Scratch worktree (SEE-1111 isolation) -----------------------------------
# The proxy's hot-reuse path re-pins the agent port in the resolved worktree's
# project.godot (SEE-1091). With cwd at the repo checkout and no KOL_WORKTREE,
# resolveWorktreeForSpawn() walks up from the proxy scriptDir and lands on THIS
# checkout — rewriting the real project.godot (SEE-1111 Goal 3 violation). Point
# it at an isolated scratch Godot project so the re-pin stays in the scratch copy.
SCRATCH_WT="$TMPDIR/scratch-worktree"
mkdir -p "$SCRATCH_WT/launch"
printf 'config_version=5\n\n[godot_mcp]\n\nport_override_enabled=false\nport_override=6550\n' > "$SCRATCH_WT/project.godot"
# SEE-1148 P2 sandbox semantics (same seam as T2): opt the proxy out of the
# port arbiter and prove the pre-bound mock listener with the e43cdc73
# .worktree sidecar, else it reads as a cross-runtime holder → evict → no warm.
EDITOR_LOG="$TMPDIR/godot-editor-Bachi.log"
printf '%s' "$SCRATCH_WT" > "${EDITOR_LOG%.log}.worktree"

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
wait_for() {
    local file="$1" pat="$2" budget="$3" waited=0
    while (( waited < budget )); do
        grep -q "$pat" "$file" 2>/dev/null && return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    return 1
}

# Per-id checks via python. Args: id, then check names. Prints PASS or FAIL: <reason>.
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
    print("FAIL: id=%s response not valid JSON (%s) — line=%r" % (idv, e, line)); sys.exit()
errs = []
# The exec payload is a text item whose .text is the outer {completed,result,runtime_errors} JSON,
# possibly with a hint appended AFTER the JSON. Split on the last '}' to recover envelope + suffix.
items = (msg.get('result') or {}).get('content') or []
text = next((c.get('text') for c in items if c.get('type') == 'text'), '')
envelope, suffix = text, ''
# SEE-1348 WP5: hints themselves contain balanced braces, so a brace-walk
# split mis-lands. Use JSONDecoder.raw_decode: the envelope is the FIRST
# JSON value in the text; everything after it is the appended hint.
try:
    dec = json.JSONDecoder()
    env, end = dec.raw_decode(text.lstrip())
    suffix = text.lstrip()[end:]
except Exception:
    env = {}
for c in checks:
    if c == 'is_result':
        if msg.get('result') is None: errs.append("expected result, got error")
    elif c == 'completed_false':
        if env.get('completed') is not False: errs.append("completed not preserved as False: %r" % env.get('completed'))
    elif c == 'completed_true':
        if env.get('completed') is not True: errs.append("completed not preserved as True: %r" % env.get('completed'))
    elif c == 'runtime_errors_intact':
        if not (env.get('runtime_errors') and isinstance(env['runtime_errors'], list) and len(env['runtime_errors']) > 0):
            errs.append("runtime_errors lost: %r" % env.get('runtime_errors'))
    elif c == 'result_long_arr':
        r = env.get('result') or ''
        if not (isinstance(r, str) and r.startswith('[') and len(r) >= 190):
            errs.append("result not the long Array: len=%d head=%r" % (len(r), r[:20]))
    elif c == 'result_primitive':
        if env.get('result') != '42': errs.append("primitive result not preserved: %r" % env.get('result'))
    elif c.startswith('hint='):
        want = c.split('=', 1)[1]
        # SEE-1348 WP5: in-band exec rejections carry hints appended to the
        # MCP error message, not to a result text suffix.
        err_blob = json.dumps(msg.get('error') or {}, ensure_ascii=False)
        if want not in suffix and want not in err_blob:
            errs.append("hint %r not appended (suffix=%r err=%r)" % (want, suffix[:80], err_blob[:120]))
    elif c == 'is_inband_sync_only':
        if msg.get('error') is None or 'SYNC_ONLY' not in (msg['error'].get('message') or ''):
            errs.append("expected in-band SYNC_ONLY error: %r" % (msg.get('error')))
    elif c == 'no_hint':
        if suffix.strip() != '': errs.append("unexpected hint on clean path: %r" % suffix[:80])
    elif c == 'no_hint_anywhere':
        blob = json.dumps(msg.get('result'))
        if any(k in blob for k in ['GDScript 无列表推导', 'JSON.stringify(value)', 'override 的返回类型', '字典键必须加引号', '不能声明顶层 func', 'exec 是同步执行的']):
            errs.append("non-exec/clean result wrongly carries a hint")
if errs:
    print("FAIL: " + "; ".join(errs))
else:
    print("PASS")
PY
}

sep "SEE-1070 #8 proxy exec-hint E2E (port=$TEST_PORT)"

INIT_LINE='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"revy-test"}}}'
send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 4000 && ok "pre: initialize (id=1) answered through proxy" || ko "pre: no initialize response — chain dead"
# B1 lazy-load (SEE-1085): warmup is deferred to the first tools/call. The
# listener is already up, so a trigger call makes ensureEditor's probe
# short-circuit (reuse) and the proxy reaches WARM. Without this the proxy
# idles in COLD_EMPTY and never warms. The trigger's response (id=999) is
# inert; subsequent cases use their own ids.
send_line '{"jsonrpc":"2.0","id":999,"method":"tools/call","params":{"name":"get_project_info","arguments":{}}}'
wait_for "$PROXY_ERR" 'editor warm detected' 6000 && ok "pre: proxy reached WARM" || ko "pre: proxy never reached WARM — later cases may mislead"

# T1 — list comprehension runtime error → hint appended, envelope preserved.
sep "T1: exec list-comprehension error → hint + original envelope preserved"
send_line '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"godot_exec","arguments":{"action":"run","source":"# listcomp\nvar a = [x for x in range(10)]"}}}'
if wait_for "$PROXY_OUT" '"id":2' 4000; then
    R=$(check_id 2 is_result completed_false runtime_errors_intact 'hint=GDScript 无列表推导')
    [[ "$R" == PASS ]] && ok "T1.1: id=2 listcomp → hint appended, completed/runtime_errors intact" || ko "T1.1: $R"
else
    ko "T1.1: no id=2 response on stdout"
fi

# T2 — override signature conflict → hint appended.
sep "T2: exec override-signature conflict → hint + envelope preserved"
send_line '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"godot_exec","arguments":{"action":"run","source":"# sigconflict\nfunc get() -> void: pass"}}}'
if wait_for "$PROXY_OUT" '"id":3' 4000; then
    R=$(check_id 3 is_result completed_false runtime_errors_intact 'hint=override 的返回类型')
    [[ "$R" == PASS ]] && ok "T2.1: id=3 sigconflict → hint appended, envelope intact" || ko "T2.1: $R"
else
    ko "T2.1: no id=3 response on stdout"
fi

# T3 — truncated Array return → JSON.stringify hint appended, long result preserved.
sep "T3: exec truncated Array return → JSON.stringify hint + result preserved"
send_line '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"godot_exec","arguments":{"action":"run","source":"# truncateme\nreturn get_many()"}}}'
if wait_for "$PROXY_OUT" '"id":4' 4000; then
    R=$(check_id 4 is_result completed_true result_long_arr 'hint=JSON.stringify(value)')
    [[ "$R" == PASS ]] && ok "T3.1: id=4 truncated Array → hint appended, long result intact" || ko "T3.1: $R"
else
    ko "T3.1: no id=4 response on stdout"
fi

# T4 — clean primitive return → NO hint (happy path untouched, byte-identical).
sep "T4: exec clean primitive return → NO hint (happy path untouched)"
send_line '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"godot_exec","arguments":{"action":"run","source":"return 42"}}}'
if wait_for "$PROXY_OUT" '"id":5' 4000; then
    R=$(check_id 5 is_result completed_true result_primitive no_hint)
    [[ "$R" == PASS ]] && ok "T4.1: id=5 clean → no hint, primitive result preserved" || ko "T4.1: $R"
else
    ko "T4.1: no id=5 response on stdout"
fi

# T5 — non-exec tool passes through UNTOUCHED (exec matcher does not false-hit).
sep "T5: non-exec tool (get_project_info) → NO hint (matcher not false-hit)"
send_line '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"get_project_info","arguments":{}}}'
if wait_for "$PROXY_OUT" '"id":6' 4000; then
    R=$(check_id 6 is_result no_hint_anywhere)
    [[ "$R" == PASS ]] && ok "T5.1: id=6 non-exec → passed through, no hint" || ko "T5.1: $R"
else
    ko "T5.1: no id=6 response on stdout"
fi

# SEE-1348 WP5 (§SPEC-005): compile-hint rules — dict shorthand / top-level
# func / await. Each: hint appended, envelope preserved.
sep "T7: exec dict-shorthand compile error → hint + envelope preserved"
send_line '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"godot_exec","arguments":{"action":"run","source":"# dictshorthand\nreturn {name: \"x\"}"}}}'
if wait_for "$PROXY_OUT" '"id":8' 4000; then
    R=$(check_id 8 is_result completed_false runtime_errors_intact 'hint=GDScript 字典键')
    [[ "$R" == PASS ]] && ok "T7.1: id=8 dictshorthand → hint appended, envelope intact" || ko "T7.1: $R"
else
    ko "T7.1: no id=8 response on stdout"
fi

sep "T8: exec top-level func compile error → hint + envelope preserved"
send_line '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"godot_exec","arguments":{"action":"run","source":"# topfunc\nfunc helper(): pass"}}}'
if wait_for "$PROXY_OUT" '"id":9' 4000; then
    R=$(check_id 9 is_result completed_false runtime_errors_intact 'hint=不能声明顶层 func')
    [[ "$R" == PASS ]] && ok "T8.1: id=9 topfunc → hint appended, envelope intact" || ko "T8.1: $R"
else
    ko "T8.1: no id=9 response on stdout"
fi

sep "T9: exec await compile error → hint + envelope preserved"
send_line '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"godot_exec","arguments":{"action":"run","source":"# waitsleep\nawait tree.create_timer(1.0).timeout"}}}'
if wait_for "$PROXY_OUT" '"id":10' 4000; then
    R=$(check_id 10 is_inband_sync_only 'hint=exec 是同步执行的')
    [[ "$R" == PASS ]] && ok "T9.1: id=10 await → hint appended, envelope intact" || ko "T9.1: $R"
else
    ko "T9.1: no id=10 response on stdout"
fi

# T6 — non-JSON npx output forwarded VERBATIM; proxy survives.
sep "T6: invalid-JSON npx line forwarded verbatim; proxy does not crash"
send_line '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"emit_garbage","arguments":{}}}'
if wait_for "$PROXY_OUT" 'not-valid-json-{broken' 4000; then
    ok "T6.1: garbage line forwarded verbatim to Claude stdout"
else
    ko "T6.1: garbage line dropped (not on proxy stdout)"
fi
proxy_alive && ok "T6.2: proxy still alive after non-JSON line" || ko "T6.2: proxy died after forwarding non-JSON line"

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
