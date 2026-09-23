#!/usr/bin/env bash
# SEE-990 LIVE regression: the wrapper MCP/WS readiness gate against a REAL
# godot_mcp addon (single-client policy).
#
# The mock-based test (test_see990_mcp_ready_gate.sh) proves the gate LOGIC on
# a stub WS server. This companion test runs the same gate against a LIVE editor
# on one of the per-agent ports to validate the single-client fix under the real
# addon (websocket_server.gd CLOSE_CODE_ALREADY_CONNECTED=4001). The probe now
# sends heartbeat + get_editor_state over ONE socket, so the gate must reach
# exec npx on a healthy editor instead of dying with "became unresponsive".
#
# Verdicts:
#   T1  single-connection heartbeat+get_editor_state on one socket  -> success
#       (proves the editor itself is healthy and ready)
#   T2  wrapper gate as shipped (now single-connection)             -> success
#       (validates the fix: the gate reaches exec npx on a live editor)
#   T3  shipped --check ready probe against the live single-client addon
#                                                                    -> success
#       (validates the fix at the probe level: heartbeat + get_editor_state
#        ride one socket, so the addon's 4001 single-client guard is not hit)
#
# This test was originally a BUG-EXISTENCE regression (the --check ready probe
# opened a second connection for get_editor_state and tripped the addon's 4001
# single-client guard). The probe now reuses one socket for both commands; T2/T3
# validate that fix end-to-end against a real editor.
#
# Run:  bash .dev/godot-mcp/tests/scripts/test_see990_live_gate_race.sh
#        KOL_LIVE_PORT=6553 bash .dev/godot-mcp/tests/scripts/test_see990_live_gate_race.sh
#        SEE930_SKIP_LIVE=1 bash ...   # skip when no live editor is available
#
# Requires: a live godot_mcp editor listening on the target port (the per-agent
# editors run on Windows; the wrapper resolves the WSL gateway IP itself).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LAUNCH_DIR="$REPO_ROOT/launch"
WRAPPER="$LAUNCH_DIR/godot-mcp-launcher.sh"
PROBE="$LAUNCH_DIR/mcp_ready_probe.py"

PASS=0; FAIL=0; SKIP=0; FAILS=()
ok() { echo "  [PASS] $*"; PASS=$((PASS+1)); }
ko() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }
sk() { echo "  [SKIP] $*"; SKIP=$((SKIP+1)); }
sect() { echo; echo "===== $* ====="; }

[[ -f "$WRAPPER" ]] || { echo "FATAL: $WRAPPER not found" >&2; exit 2; }
[[ -f "$PROBE" ]]   || { echo "FATAL: $PROBE not found" >&2; exit 2; }

PORT="${KOL_LIVE_PORT:-6553}"
HOST="$(ip route show default 2>/dev/null | sed -n 's/^.*via[[:space:]]\{1,\}\([0-9.]\{1,\}\).*$/\1/p' | head -n1)"
[[ -n "$HOST" ]] || HOST="127.0.0.1"

if [[ "${SEE930_SKIP_LIVE:-0}" == "1" || "${SEE990_SKIP_LIVE:-0}" == "1" ]]; then
    sk "SEE990_SKIP_LIVE=1; live race test bypassed"
    echo; echo "SUMMARY: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"; exit 0
fi

# Is a live editor listening on HOST:PORT? The editors bind the Windows vEthernet
# IP, which Linux `ss` does not see; reach it via a real TCP connect.
port_reachable() {
    python3 -c "import socket,sys
s=socket.socket(); s.settimeout(2)
try:
    s.connect(('$HOST', $PORT)); print('up')
except Exception:
    print('down')
finally:
    s.close()" 2>/dev/null
}
[[ "$(port_reachable)" == "up" ]] || {
    sk "no live editor on $HOST:$PORT (set KOL_LIVE_PORT or run start-godot-editor.sh)"
    echo; echo "SUMMARY: PASS=$PASS FAIL=$FAIL SKIP=$SKIP"; exit 0
}

TMPDIR="$(mktemp -d)"; trap 'rm -rf "$TMPDIR"' EXIT

# --- T1: single-connection heartbeat + get_editor_state ----------------------
sect "T1: single-connection probe (editor health baseline)"
python3 - "$HOST" "$PORT" >"$TMPDIR/t1.log" 2>&1 <<'PY'
import socket, base64, hashlib, json, struct, sys, time
host, port = sys.argv[1], int(sys.argv[2])
sock = socket.create_connection((host, port), timeout=5); sock.settimeout(5)
key = base64.b64encode(bytes(range(16))).decode()
req = ("GET / HTTP/1.1\r\nHost: {}:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
       "Sec-WebSocket-Key: {}\r\nSec-WebSocket-Version: 13\r\n\r\n").format(host, port, key)
sock.sendall(req.encode())
buf = b""
while b"\r\n\r\n" not in buf:
    c = sock.recv(4096)
    if not c: raise SystemExit("handshake closed")
    buf += c

def send_json(obj):
    pl = json.dumps(obj).encode(); mask = bytes(range(4))
    hdr = bytearray([0x81, 0x80 | len(pl)]) + mask
    sock.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(pl)))

def recv_json(deadline):
    data = b""
    while True:
        if len(data) >= 2:
            op = data[0] & 0x0F; ln = data[1] & 0x7F; i = 2
            if ln == 126 and len(data) > i + 2:
                ln = struct.unpack(">H", data[i:i+2])[0]; i += 2
            elif ln == 127 and len(data) > i + 8:
                i += 8
            if len(data) >= i + ln:
                pl = data[i:i+ln]
                if op == 0x8: raise SystemExit("close frame")
                return json.loads(pl.decode("utf-8", "replace"))
        if time.monotonic() > deadline: raise SystemExit("timeout")
        c = sock.recv(8192)
        if not c: raise SystemExit("conn closed")
        data += c

send_json({"id": "p", "command": "heartbeat", "params": {}})
hb = recv_json(time.monotonic() + 3)
send_json({"id": "p", "command": "get_editor_state", "params": {}})
st = recv_json(time.monotonic() + 3)
ms = (st.get("result") or {}).get("main_screen") if st.get("status") == "success" else None
sock.close()
print("HEARTBEAT=%s STATE=%s main_screen=%r" % (
    hb.get("status"), st.get("status"), ms))
ok_t1 = hb.get("status") == "success" and st.get("status") == "success" and ms in {"2D", "3D", "Script", "AssetLib"}
sys.exit(0 if ok_t1 else 1)
PY
if [[ $? -eq 0 ]]; then ok "T1: single-connection probe healthy ($(tail -1 "$TMPDIR/t1.log"))"; else ko "T1: single-connection probe failed: $(cat "$TMPDIR/t1.log")"; fi

# --- T2: wrapper gate as shipped (single-connection probe) -------------------
sect "T2: wrapper gate reaches exec npx (fix validated)"
MOCK_NPX_DIR="$TMPDIR/mock_npx"; mkdir -p "$MOCK_NPX_DIR"
cat > "$MOCK_NPX_DIR/npx" <<'MOCK'
#!/usr/bin/env bash
echo "MOCK_NPX_GODOT_PORT=${GODOT_PORT:-unset}"
MOCK
chmod +x "$MOCK_NPX_DIR/npx"
WOUT="$TMPDIR/wrapper.out"; WERR="$TMPDIR/wrapper.err"
PATH="$MOCK_NPX_DIR:$PATH" timeout 90 "$WRAPPER" --port "$PORT" >"$WOUT" 2>"$WERR"
WRC=$?
if (( WRC == 0 )) && grep -q "MOCK_NPX_GODOT_PORT" "$WOUT"; then
    ok "T2: wrapper reached exec npx on live editor (rc=0)"
else
    ko "T2: wrapper failed to reach exec npx rc=$WRC: $(grep -E 'ERROR' "$WERR" | tail -1)"
fi

# --- T3: shipped --check ready probe against the live single-client addon ----
sect "T3: shipped probe --check ready succeeds (one-connection fix)"
# Each --check ready call is ONE connection, but the live addon takes ~2s to
# tear down the previous client (T1/T2 ran first). Retry across that teardown
# window. This does NOT mask a two-connection regression: a probe that opened a
# second connection would race ITSELF on every attempt and never succeed.
T3_LOG="$TMPDIR/t3.log"; T3_RC=1
for attempt in 1 2 3; do
    python3 "$PROBE" --host "$HOST" --port "$PORT" --check ready --timeout 5 >"$T3_LOG" 2>&1
    T3_RC=$?
    (( T3_RC == 0 )) && grep -q "editor ready" "$T3_LOG" && break
    sleep 2   # 竞态窗口语义（CLAUDE.md 边界）：重试退避间隔（probe 本身即 ready 事件探测），非固定同步等待
done
if (( T3_RC == 0 )) && grep -q "editor ready" "$T3_LOG"; then
    ok "T3: shipped probe reaches ready over one connection on live addon ($(tail -1 "$T3_LOG"))"
else
    ko "T3: shipped probe failed (rc=$T3_RC): $(cat "$T3_LOG")"
fi

echo
echo "============================================================"
echo "SUMMARY: PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
[[ ${#FAILS[@]} -gt 0 ]] && { echo "FAILURES:"; for f in "${FAILS[@]}"; do echo "  - $f"; done; }
echo "============================================================"
[[ $FAIL -eq 0 ]]
