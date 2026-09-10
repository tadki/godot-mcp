#!/usr/bin/env bash
# SEE-1009 A/B test: before-fix WS gate vs after-fix TCP gate against the same
# single-client mock addon (with teardown delay to mirror the real race).
#
# The bug: the addon (websocket_server.gd) accepts a SINGLE WS client. The old
# readiness gate (before commit 5eaac1d) completed a full WS handshake before
# exec npx, so when npx then connected, the addon was still tearing the probe's
# peer down and 4001-closed npx ("WebSocket was closed before the connection was
# established"). The mock here models that teardown window.
#
# The fix (commit 5eaac1d): the gate uses --check tcp (TCP reachability only) so
# the first real WS client is npx itself, avoiding the teardown race entirely.
#
# This script extracts the probe source from before the fix (5eaac1d^) and after
# the fix (current) and runs the SAME "probe then connect npx" scenario against
# both, asserting:
#   A1  old probe --check ws completes a WS handshake
#   A2  a single WS client connecting right after the old probe gets 4001
#   B1  new probe --check tcp is TCP-only (no WS handshake)
#   B2  a single WS client connecting right after the new probe succeeds
#
# Run: bash .dev/godot-mcp/tests/abtest/test_see1009_ws_vs_tcp_gate_ab.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PASS=0; FAIL=0; SKIP=0; FAILS=()
ok() { echo "  [PASS] $*"; PASS=$((PASS+1)); }
ko() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); FAILS+=("$*"); }
sect() { echo; echo "===== $* ====="; }

FIX_COMMIT="5eaac1d"
git -C "$REPO_ROOT" rev-parse --verify "${FIX_COMMIT}^{commit}" >/dev/null 2>&1 || {
    echo "FATAL: cannot resolve fix commit ${FIX_COMMIT}" >&2
    exit 2
}

TMPDIR="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

mkdir -p "$TMPDIR/before" "$TMPDIR/after"

git -C "$REPO_ROOT" show "${FIX_COMMIT}^:.dev/launch/mcp_ready_probe.py" > "$TMPDIR/before/mcp_ready_probe.py"
cp "$REPO_ROOT/launch/mcp_ready_probe.py" "$TMPDIR/after/mcp_ready_probe.py"
chmod +x "$TMPDIR/before"/*.py "$TMPDIR/after"/*.py

find_free_port() {
    python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()"
}

# Mock server: single-client WS with a TEARDOWN_DELAY after a client disconnects
# before the slot is freed (mirrors the real addon's teardown window during
# which a newcomer is 4001-closed).
write_mock_server() {
    cat > "$1" <<'PY'
import sys, socket, base64, hashlib, json, struct, threading, time

teardown_delay = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
port = int(sys.argv[1])

CLOSE_ALREADY_CONNECTED = 4001
active_lock = threading.Lock()
active = {"held": False, "tearing": False}

def recv_until(sock, delim):
    buf = b""
    while delim not in buf:
        c = sock.recv(4096)
        if not c:
            return buf
        buf += c
    return buf

def try_frame(data):
    if len(data) < 2:
        return None, data
    b1, b2 = data[0], data[1]
    op = b1 & 0x0F
    masked = (b2 & 0x80) != 0
    ln = b2 & 0x7F
    i = 2
    if ln == 126:
        if len(data) < i + 2:
            return None, data
        ln = struct.unpack(">H", data[i:i+2])[0]
        i += 2
    elif ln == 127:
        if len(data) < i + 8:
            return None, data
        ln = struct.unpack(">Q", data[i:i+8])[0]
        i += 8
    mk = b""
    if masked:
        if len(data) < i + 4:
            return None, data
        mk = data[i:i+4]
        i += 4
    if len(data) < i + ln:
        return None, data
    pl = data[i:i+ln]
    if masked:
        pl = bytes(b ^ mk[j % 4] for j, b in enumerate(pl))
    return {"op": op, "payload": pl}, data[i+ln:]

def send_text(sock, obj):
    payload = json.dumps(obj).encode("utf-8")
    header = bytearray([0x81])
    if len(payload) < 126:
        header.append(len(payload))
    elif len(payload) < 65536:
        header.append(126)
        header += struct.pack(">H", len(payload))
    else:
        header.append(127)
        header += struct.pack(">Q", len(payload))
    sock.sendall(bytes(header) + payload)

def send_close(sock, code, reason=b""):
    payload = struct.pack(">H", code) + reason
    try:
        sock.sendall(bytes(bytearray([0x88, len(payload)])) + payload)
    except OSError:
        pass

def handle(sock):
    req = recv_until(sock, b"\r\n\r\n").decode("latin1", "replace")
    key = None
    for line in req.split("\r\n"):
        if line.lower().startswith("sec-websocket-key:"):
            key = line.split(":", 1)[1].strip()
    accept = base64.b64encode(
        hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
    ).decode("ascii")
    resp = (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
    )
    sock.sendall(resp.encode("ascii"))

    rejected = False
    with active_lock:
        if active["held"] or active["tearing"]:
            rejected = True
        else:
            active["held"] = True
    if rejected:
        send_close(sock, CLOSE_ALREADY_CONNECTED, b"another client is already connected")
        time.sleep(0.1)
        sock.close()
        return

    try:
        data = b""
        while True:
            f, data = try_frame(data)
            if f is None:
                c = sock.recv(4096)
                if not c:
                    break
                data += c
                continue
            cmd = json.loads(f["payload"].decode("utf-8", "replace")).get("command")
            if cmd == "heartbeat":
                send_text(sock, {"id": "probe", "status": "success", "result": {"status": "ok"}})
            elif cmd == "get_editor_state":
                send_text(sock, {
                    "id": "probe", "status": "success",
                    "result": {"main_screen": "3D", "godot_version": "4.6.2",
                               "current_scene": "res://Main.tscn"},
                })
            else:
                break
    finally:
        with active_lock:
            active["held"] = False
            if teardown_delay > 0:
                active["tearing"] = True
        # Hold the slot in "tearing" state to model the addon's teardown window
        # during which a newcomer is 4001-rejected.
        if teardown_delay > 0:
            time.sleep(teardown_delay)
            with active_lock:
                active["tearing"] = False
        sock.close()

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port))
s.listen(8)
print(f"listening on {port} teardown_delay={teardown_delay}", flush=True)
while True:
    try:
        c, _ = s.accept()
    except OSError:
        break
    t = threading.Thread(target=handle, args=(c,), daemon=True)
    t.start()
PY
}

mock_pid=""
start_mock_server() {
    local port="$1" delay="${2:-0}"
    python3 "$TMPDIR/mock_server.py" "$port" "$delay" >"$TMPDIR/mock_server.log" 2>&1 &
    mock_pid=$!
    local tries=0
    while (( tries < 30 )); do
        if python3 -c "import socket; s=socket.socket(); s.settimeout(0.5); s.connect(('127.0.0.1',$port)); s.close()" 2>/dev/null; then
            return 0
        fi
        sleep 0.1
        tries=$((tries + 1))
    done
    echo "FATAL: mock server did not start" >&2
    cat "$TMPDIR/mock_server.log" >&2
    exit 2
}
stop_mock_server() {
    if [[ -n "${mock_pid:-}" ]]; then
        kill "$mock_pid" 2>/dev/null || true
        wait "$mock_pid" 2>/dev/null || true
        mock_pid=""
    fi
}

# A single WS "npx" client: open, handshake, send heartbeat. Prints:
#   NPX_OK   (handshake + heartbeat succeeded)
#   NPX_4001 (handshake returned 4001 close)
#   NPX_FAIL <reason>
npx_ws_client() {
    python3 - "$1" "$2" <<'PY'
import socket, base64, hashlib, json, struct, sys, time
host, port = sys.argv[1], int(sys.argv[2])
try:
    s = socket.create_connection((host, port), timeout=3); s.settimeout(3)
except Exception as exc:
    print("NPX_FAIL connect: %s" % exc); sys.exit(0)
key = base64.b64encode(bytes(range(16))).decode()
req = ("GET / HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
       "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (host, port, key))
try:
    s.sendall(req.encode())
except Exception as exc:
    print("NPX_FAIL send: %s" % exc); sys.exit(0)
buf = b""
try:
    while b"\r\n\r\n" not in buf:
        c = s.recv(4096)
        if not c:
            print("NPX_FAIL handshake closed"); sys.exit(0)
        buf += c
except Exception as exc:
    print("NPX_FAIL recv: %s" % exc); sys.exit(0)
header, _, leftover = buf.partition(b"\r\n\r\n")
status = header.split(b"\r\n", 1)[0]
# A 4001-rejected connection still completes the HTTP 101 upgrade then sends a
# close frame. Inspect leftover (and any following bytes) for a close frame.
data = leftover
deadline = time.monotonic() + 2
while True:
    if len(data) >= 2:
        op = data[0] & 0x0F; ln = data[1] & 0x7F; i = 2
        if ln == 126 and len(data) >= i + 2:
            ln = struct.unpack(">H", data[i:i+2])[0]; i += 2
        elif ln == 127 and len(data) >= i + 8:
            i += 8
        if len(data) >= i + ln:
            pl = data[i:i+ln]
            if op == 0x8 and len(pl) >= 2:
                code = struct.unpack(">H", pl[:2])[0]
                print("NPX_%d" % code); sys.exit(0)
            data = data[i+ln:]
            continue
    if time.monotonic() > deadline:
        break
    try:
        c = s.recv(4096)
    except Exception:
        break
    if not c:
        break
    data += c
# No close frame seen within the window — try a heartbeat and look for a reply.
pl = json.dumps({"id": "p", "command": "heartbeat", "params": {}}).encode()
mask = bytes(range(4))
hdr = bytearray([0x81, 0x80 | len(pl)]) + mask
try:
    s.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(pl)))
except Exception:
    print("NPX_FAIL hb send"); sys.exit(0)
data = b""
deadline = time.monotonic() + 2
while time.monotonic() < deadline:
    try:
        c = s.recv(4096)
    except Exception:
        break
    if not c:
        break
    data += c
    if len(data) >= 2:
        op = data[0] & 0x0F
        if op == 0x1:
            print("NPX_OK"); sys.exit(0)
        if op == 0x8:
            print("NPX_CLOSED"); sys.exit(0)
print("NPX_FAIL no reply")
PY
}

write_mock_server "$TMPDIR/mock_server.py"

# ---------------------------------------------------------------------------
# A: BEFORE the fix — WS gate occupies the slot during teardown
# ---------------------------------------------------------------------------
sect "A: before-fix WS gate -> npx rejected during teardown window"

PORT_A=$(find_free_port)
# 1.5s teardown window so the probe's WS slot is still "tearing" when npx lands.
start_mock_server "$PORT_A" 1.5

A1_LOG="$TMPDIR/A1.log"
python3 "$TMPDIR/before/mcp_ready_probe.py" --host 127.0.0.1 --port "$PORT_A" --check ws --timeout 3 >"$A1_LOG" 2>&1
A1_RC=$?
if (( A1_RC == 0 )) && grep -q "WS responsive" "$A1_LOG"; then
    ok "A1 old probe --check ws completes handshake"
else
    ko "A1 old probe did not handshake (rc=$A1_RC): $(cat "$A1_LOG")"
fi

A2_LOG="$TMPDIR/A2.log"
npx_ws_client 127.0.0.1 "$PORT_A" >"$A2_LOG" 2>&1
if grep -q "NPX_4001" "$A2_LOG"; then
    ok "A2 npx gets 4001 (single-client race reproduced)"
else
    ko "A2 expected NPX_4001 race, got: $(cat "$A2_LOG")"
fi
stop_mock_server

# ---------------------------------------------------------------------------
# B: AFTER the fix — TCP gate never touches the WS slot
# ---------------------------------------------------------------------------
sect "B: after-fix TCP gate -> npx succeeds (slot never occupied)"

PORT_B=$(find_free_port)
start_mock_server "$PORT_B" 1.5

B1_LOG="$TMPDIR/B1.log"
python3 "$TMPDIR/after/mcp_ready_probe.py" --host 127.0.0.1 --port "$PORT_B" --check tcp --timeout 3 >"$B1_LOG" 2>&1
B1_RC=$?
if (( B1_RC == 0 )) && grep -q "TCP reachable" "$B1_LOG" && ! grep -q "WS responsive" "$B1_LOG"; then
    ok "B1 new probe --check tcp is TCP-only, no WS handshake"
else
    ko "B1 new probe did not behave as TCP-only (rc=$B1_RC): $(cat "$B1_LOG")"
fi

B2_LOG="$TMPDIR/B2.log"
npx_ws_client 127.0.0.1 "$PORT_B" >"$B2_LOG" 2>&1
if grep -q "NPX_OK" "$B2_LOG"; then
    ok "B2 npx WS handshake + heartbeat succeeds with TCP gate"
else
    ko "B2 expected NPX_OK, got: $(cat "$B2_LOG")"
fi
stop_mock_server

echo
echo "============================================================"
echo "SUMMARY: PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
if [[ ${#FAILS[@]} -gt 0 ]]; then
    echo "FAILURES:"
    for f in "${FAILS[@]}"; do echo "  - $f"; done
fi
echo "============================================================"

[[ $FAIL -eq 0 ]]
