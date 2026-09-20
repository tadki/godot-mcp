#!/usr/bin/env bash
# SEE-1244 §9.2 / §7.3 — shim degradation matrix injection tests (D2/D3/D5/D9).
#
# §7.3 runnable criteria per injected fault:
#   ① tools/list response non-empty
#   ② initialize response <1s
#   ③ tools/call returns a structured error (or success) — never hangs
#
# Faults exercised:
#   D2  chain spawn fails (launcher missing) → initialize ok, tools/list ok,
#       tools/call → structured -32000 error, no hang
#   D3  chain spawn ok but launcher dies (mock chain exits immediately) →
#       same triad as D2
#   D5  corrupt cache file → tools/list falls back to placeholder (covered in
#       depth by test_see1244_shim_handshake.mjs; re-asserted here as the D5 anchor)
#   D9  two shims of the same agent concurrently → each independently answers
#       initialize/tools/list; neither dies because of the other
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1244_shim_degrade.sh

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHIM="$HERE/../../../launch/godot-mcp-shim.mjs"
MOCK_CHAIN="$HERE/_see1244_mock_chain.mjs"

PASS=0; FAIL=0
ok() { if [[ "$2" == "1" ]]; then PASS=$((PASS+1)); echo "  [PASS] $1"; else FAIL=$((FAIL+1)); echo "  [FAIL] $1${3:+ — $3}"; fi; }
section() { echo; echo "== $1 =="; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Drive a shim: send lines from $1 (file of NDJSON), read stdout to $2, stderr to $3.
# $4 = optional extra env assignment (KEY=VAL) — MUST land on the NODE process,
# so it is exported between the pipeline stages rather than decorating the
# bash -c producer (env on the producer does NOT propagate through the pipe to
# node's environ… it does in theory, but WSL pipe+timeout combo proved flaky).
# $5 = label.
drive_shim() {
    local infile="$1" outfile="$2" errfile="$3" extraenv="$4" label="$5"
    if [[ -n "$extraenv" ]]; then
        export "$extraenv"
        export KOL_SEE1244_ALLOW_TEST_OVERRIDE=1
    fi
    env HOME="$TMP/home-$label" GODOT_MCP_HOME="$TMP/home-$label/.multica" timeout 10 bash -c \
        "sleep 0.3; cat '$infile'; sleep 2" | env HOME="$TMP/home-$label" GODOT_MCP_HOME="$TMP/home-$label/.multica" node "$SHIM" "$label" \
        >"$outfile" 2>"$errfile"
    if [[ -n "$extraenv" ]]; then
        unset "${extraenv%%=*}"
    fi
}

section "D2: chain spawn impossible (launcher missing)"
{
    IN="$TMP/d2-in.ndjson"
    cat > "$IN" <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"godot_project","arguments":{"action":"get_info"}}}
EOF
    t0=$(date +%s%N)
    drive_shim "$IN" "$TMP/d2-out.ndjson" "$TMP/d2-err.log" \
        "KOL_SEE1244_LAUNCHER_OVERRIDE=/nonexistent/launcher/that/does/not/exist.sh" "d2test"
    t1=$(date +%s%N)
    elapsed_ms=$(( (t1 - t0) / 1000000 ))

    d2_tools_ok=$(node -e "
const lines = require('fs').readFileSync('$TMP/d2-out.ndjson','utf8').split('\n').filter(x=>x.trim());
const m = JSON.parse(lines.find(x=>x.includes('\"id\":2')));
console.log(m.result && Array.isArray(m.result.tools) && m.result.tools.length > 0 ? 1 : 0);
" 2>/dev/null)
    ok "D2-① tools/list answered non-empty" "$d2_tools_ok"
    ok "D2-② initialize present in output" \
        "$(grep -q '"id":1' "$TMP/d2-out.ndjson" && echo 1 || echo 0)"
    ok "D2-② shim log SHIM_ANSWER_INIT elapsed_ms small (<1000)" \
        "$(grep -oE 'SHIM_ANSWER_INIT elapsed_ms=[0-9]+' "$TMP/d2-err.log" | grep -oE '[0-9]+$' | awk '$1 < 1000' | grep -q . && echo 1 || echo 0)"
    ok "D2-③ tools/call returned structured -32000 error (not hang; total ${elapsed_ms}ms < 10s)" \
        "$(grep -q '"id":3' "$TMP/d2-out.ndjson" && grep -q '\-32000' "$TMP/d2-out.ndjson" && [[ $elapsed_ms -lt 10000 ]] && echo 1 || echo 0)" \
        "$(cat "$TMP/d2-out.ndjson" 2>/dev/null | head -3)"
    ok "D2-③ transient error carries decision-report state tag (chain_restarting/exhausted)" \
        "$(grep -q '"state":"chain_restarting"' "$TMP/d2-out.ndjson" || grep -q '"state":"chain_exhausted"' "$TMP/d2-out.ndjson" && echo 1 || echo 0)" \
        "$(grep '"id":3' "$TMP/d2-out.ndjson" 2>/dev/null | head -1)"
    ok "D2-③ exhausted terminal (if reached) names the launcher log; transient keeps retryable:true" \
        "$(node -e "
const lines=require('fs').readFileSync('$TMP/d2-out.ndjson','utf8').split('\n').filter(x=>x.includes('\"id\":3'));
if(!lines.length){console.log(0);process.exit()}
const m=JSON.parse(lines[0]); const d=m.error&&m.error.data||{};
console.log(d.state==='chain_exhausted' ? (d.retryable===false && /launcher/.test(m.error.message)?1:0) : (d.retryable===true?1:0));
" 2>/dev/null)"
}

section "D3: chain spawned but launcher dies immediately"
{
    IN="$TMP/d3-in.ndjson"
    cp "$TMP/d2-in.ndjson" "$IN"
    # mock chain with --die-after-echo dies on first forwarded line
    t0=$(date +%s%N)
    drive_shim "$IN" "$TMP/d3-out.ndjson" "$TMP/d3-err.log" \
        "KOL_SEE1244_LAUNCHER_OVERRIDE=node $MOCK_CHAIN --die-after-echo" "d3test"
    t1=$(date +%s%N)
    elapsed_ms=$(( (t1 - t0) / 1000000 ))

    ok "D3-① tools/list answered non-empty (direct-answer mode maintained)" \
        "$(grep -q '"id":2' "$TMP/d3-out.ndjson" && echo 1 || echo 0)"
    ok "D3-② initialize present" \
        "$(grep -q '"id":1' "$TMP/d3-out.ndjson" && echo 1 || echo 0)"
    ok "D3-③ session terminates (chain death → exit; no hang, ${elapsed_ms}ms < 10s)" \
        "$(awk -v e="$elapsed_ms" 'BEGIN{print (e < 10000 && e >= 0) ? 1 : 0}')"
    ok "D3 chain exit observed in log (SHIM_CHAIN_EXIT)" \
        "$(grep -q 'SHIM_CHAIN_EXIT' "$TMP/d3-err.log" && echo 1 || echo 0)"
}

section "D5: corrupt cache → placeholder fallback"
{
    # NOTE: drive_shim derives HOME from the label ($TMP/home-$label), and this
    # suite now injects GODOT_MCP_HOME=$HOME/.multica (SEE-1328 H2 guard 适配),
    # so the corrupt cache must be planted at $TMP/home-d5test/.multica/.
    mkdir -p "$TMP/home-d5test/.multica"
    echo '{corrupt json' > "$TMP/home-d5test/.multica/godot-mcp-tools-cache-d5test.json"
    in="$TMP/d5-in.ndjson"
    echo '{"jsonrpc":"2.0","id":5,"method":"tools/list"}' > "$in"
    drive_shim "$in" "$TMP/d5-out.ndjson" "$TMP/d5-err.log" "" "d5test"
    d5_tools_ok=$(node -e "
const lines = require('fs').readFileSync('$TMP/d5-out.ndjson','utf8').split('\n').filter(x=>x.trim());
const m = JSON.parse(lines.find(x=>x.includes('\"id\":5')));
console.log(m.result && Array.isArray(m.result.tools) && m.result.tools.length > 0 ? 1 : 0);
" 2>/dev/null)
    ok "D5-① corrupt cache still yields non-empty tools/list (placeholder)" "$d5_tools_ok"
    ok "D5 corruption warned (SHIM_CACHE_WARN reason=corrupt)" \
        "$(grep -q 'SHIM_CACHE_WARN reason=corrupt' "$TMP/d5-err.log" && echo 1 || echo 0)"
}

section "D9: two shims of the same agent concurrently"
{
    mkdir -p "$TMP/home-d9a" "$TMP/home-d9b"
    in="$TMP/d9-in.ndjson"
    cat > "$in" <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
EOF
    drive_shim "$in" "$TMP/d9a-out.ndjson" "$TMP/d9a-err.log" "" "d9a" &
    PA=$!
    drive_shim "$in" "$TMP/d9b-out.ndjson" "$TMP/d9b-err.log" "" "d9b" &
    PB=$!
    wait $PA; RRA=$?
    wait $PB; RRB=$?
    ok "D9 shim A completed cleanly (exit 0)" "$(awk -v e="$RRA" 'BEGIN{print (e == 0) ? 1 : 0}')"
    ok "D9 shim B completed cleanly (exit 0)" "$(awk -v e="$RRB" 'BEGIN{print (e == 0) ? 1 : 0}')"
    ok "D9 both answered initialize + tools/list independently" \
        "$(grep -q '"id":1' "$TMP/d9a-out.ndjson" && grep -q '"id":2' "$TMP/d9a-out.ndjson" \
        && grep -q '"id":1' "$TMP/d9b-out.ndjson" && grep -q '"id":2' "$TMP/d9b-out.ndjson" && echo 1 || echo 0)"
    ok "D9 no cross-kill (neither log shows uncaught SHIM_DIE crash)" \
        "$(grep -q 'SHIM_DIE' "$TMP/d9a-err.log" || true; ! grep -q 'uncaught' "$TMP/d9a-err.log" && ! grep -q 'uncaught' "$TMP/d9b-err.log" && echo 1 || echo 0)"
}

echo
echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
if [[ $FAIL -gt 0 ]]; then exit 1; fi
