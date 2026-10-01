#!/usr/bin/env bash
# SEE-990 regression tests for the launcher MCP/WS readiness boundary.
#
# Verifies godot-mcp-launcher.sh always reaches `exec godot-mcp-proxy.mjs`
# (Stage 1b: TCP reachability is delegated to the proxy, which owns the WS
# handshake). Uses a stubbed wrapper (SCRIPT_DIR rewritten, port_in_use
# overridden to a no-op) and a Python stdlib mock WebSocket server so the
# test is fully deterministic and does not need a real Godot editor.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see990_mcp_ready_gate.sh

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

if [[ ! -f "$WRAPPER" ]]; then
    echo "FATAL: $WRAPPER not found" >&2
    exit 2
fi
if [[ ! -f "$PROBE" ]]; then
    echo "FATAL: $PROBE not found" >&2
    exit 2
fi

TMPDIR="$(mktemp -d)"

mock_server_pid=""
cleanup() {
    if [[ -n "$mock_server_pid" ]]; then
        kill "$mock_server_pid" 2>/dev/null || true
        wait "$mock_server_pid" 2>/dev/null || true
    fi
    rm -rf "$TMPDIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Mock helpers
# ---------------------------------------------------------------------------

# Build a fake npx that prints GODOT_PORT and exits; prepend to PATH.
make_mock_npx() {
    local d="$TMPDIR/mock_npx"
    mkdir -p "$d"
    cat > "$d/npx" <<'MOCK'
#!/usr/bin/env bash
# Mock npx used to verify the wrapper exports GODOT_PORT and reaches exec.
echo "MOCK_NPX_GODOT_PORT=${GODOT_PORT:-unset}"
echo "MOCK_NPX_ARGS=$*"
MOCK
    chmod +x "$d/npx"
    echo "$d"
}

# Build a stubbed launcher copy in a temp dir. It re-uses the real probe but
# overrides the slow parts (port detection, render-stable) and shortens the new
# gate timeouts so tests run in seconds.
make_stubbed_wrapper_dir() {
    local dir="$TMPDIR/stub_wrapper"
    mkdir -p "$dir"

    # awk rewrites SCRIPT_DIR and injects a no-op override for port_in_use
    # BEFORE the main flow (bash registers function definitions top-to-bottom,
    # so an override after `exec npx` at EOF would never take effect).
    awk -v dir="$dir" '
        /^SCRIPT_DIR=".*"$/       { print "SCRIPT_DIR=\"" dir "\""; next }
        /^# --- Parse CLI ---/ && !ins {
            print "# Test override: pretend the port is always up so the"
            print "# reuse/fast paths are taken by these tests."
            print "port_in_use() { return 0; }"
            ins = 1
        }
        { print }
    ' "$WRAPPER" > "$dir/godot-mcp-launcher.sh"

    # Stub configure/start to no-ops; the real editor setup is bypassed.
    cat > "$dir/configure-mcp-port.sh" <<'EOF'
#!/usr/bin/env bash
echo "[stub-configure] called with args: $*" >&2
exit 0
EOF
    cat > "$dir/start-godot-editor.sh" <<'EOF'
#!/usr/bin/env bash
echo "[stub-start] called with args: $*" >&2
exit 0
EOF
    chmod +x "$dir"/*.sh

    # Copy the real probe into the stub dir so SCRIPT_DIR resolves it.
    cp "$PROBE" "$dir/mcp_ready_probe.py"

    # SEE-1070 cleanup item 6: the launcher sources $SCRIPT_DIR/agent-ports.lib.sh
    # and reads agent-ports.json, then execs $SCRIPT_DIR/godot-mcp-proxy.mjs.
    # The awk above rewrites SCRIPT_DIR to this stub dir, so all three must
    # exist here or the launcher dies at `source` (line ~64) before the gate
    # ever runs. B1 reaches the exec, so the real proxy must be present too.
    cp "$LAUNCH_DIR/agent-ports.lib.sh" "$dir/agent-ports.lib.sh"
    cp "$LAUNCH_DIR/agent-ports.json" "$dir/agent-ports.json"
    # SEE-1344: the launcher sources $SCRIPT_DIR/env.sh (SEE-1292 K5 alias
    # chain) before exec; vendor the full launch top-level + proxy/ tree so
    # the stub never goes stale and env.sh is present at source time.
    (cd "$LAUNCH_DIR" && find . -maxdepth 1 -type f -exec cp {} "$dir/" \; && cp -r proxy "$dir/")
    # The proxy statically imports ./godot-mcp-resolve.mjs and
    # ./warmup-stage-parser.mjs; both must be present or the exec'd proxy dies
    # at module load (ERR_MODULE_NOT_FOUND) before the gate ever runs.
    cp "$LAUNCH_DIR/godot-mcp-resolve.mjs" "$dir/godot-mcp-resolve.mjs"
    cp "$LAUNCH_DIR/warmup-stage-parser.mjs" "$dir/warmup-stage-parser.mjs"

    echo "$dir"
}

# Pick an unused port by binding a socket and immediately releasing it.
find_free_port() {
    python3 -c "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()"
}

# Launch the mock godot-mcp WS server. Writes its log to $TMPDIR/m_<port>.log.
start_mock_server() {
    local mode="$1" port="$2" ready_after="${3:-0}"
    cat > "$TMPDIR/mock_server.py" <<'PY'
import sys, socket, base64, hashlib, json, struct, threading, time

mode = sys.argv[1]
port = int(sys.argv[2])
ready_after = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
start = time.monotonic()

# Mirror addons/godot_mcp/websocket_server.gd: the addon keeps a single client
# and rejects an incoming connection while the previous one is still open
# (CLOSE_CODE_ALREADY_CONNECTED=4001). Only enforced in "single_client" mode so
# the multi-command success paths (healthy/late_ready/never_ready) stay
# deterministic regardless of how the wrapper interleaves its phase-1/phase-2
# probe processes.
CLOSE_ALREADY_CONNECTED = 4001
active_lock = threading.Lock()
active = {"held": False}

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

def send_continuation(sock, obj):
    # Deliberately malformed: opcode 0x0 (continuation) with FIN set and no
    # prior fragmented text frame. The probe must reject this rather than drop
    # it silently.
    payload = json.dumps(obj).encode("utf-8")
    header = bytearray([0x80])  # FIN=1, opcode=0 (continuation)
    if len(payload) < 126:
        header.append(len(payload))
    elif len(payload) < 65536:
        header.append(126)
        header += struct.pack(">H", len(payload))
    else:
        header.append(127)
        header += struct.pack(">Q", len(payload))
    sock.sendall(bytes(header) + payload)

def send_masked_text(sock, obj):
    # Deliberately malformed: a server->client frame MUST be unmasked
    # (RFC 6455 5.1); setting the mask bit is a protocol violation.
    payload = json.dumps(obj).encode("utf-8")
    mask = bytes(range(4))
    header = bytearray([0x81])  # FIN=1, opcode=1 (text)
    if len(payload) < 126:
        header.append(0x80 | len(payload))
    elif len(payload) < 65536:
        header.append(0x80 | 126)
        header += struct.pack(">H", len(payload))
    else:
        header.append(0x80 | 127)
        header += struct.pack(">Q", len(payload))
    header += mask
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(bytes(header) + masked)

def send_close(sock, code, reason=b""):
    payload = struct.pack(">H", code) + reason
    try:
        sock.sendall(bytes(bytearray([0x88, len(payload)])) + payload)
    except OSError:
        pass

def handle(sock):
    if mode == "dead":
        try:
            recv_until(sock, b"\r\n\r\n")
        except Exception:
            pass
        time.sleep(0.3)
        sock.close()
        return

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

    # Single-client enforcement: reject a second connection while the first is
    # still being served (the real addon does this with close code 4001).
    rejected = False
    if mode == "single_client":
        with active_lock:
            if active["held"]:
                rejected = True
            else:
                active["held"] = True
        if rejected:
            send_close(sock, CLOSE_ALREADY_CONNECTED, b"another client is already connected")
            time.sleep(0.1)
            sock.close()
            return

    try:
        # Serve multiple JSON-RPC commands on this one persistent connection,
        # matching the real addon which keeps the socket open across commands.
        data = b""
        while True:
            f, data = try_frame(data)
            if f is None:
                try:
                    c = sock.recv(4096)
                except OSError:
                    break
                if not c:
                    break
                data += c
                continue
            cmd = json.loads(f["payload"].decode("utf-8", "replace")).get("command")
            if cmd == "heartbeat":
                if mode == "continuation_frame":
                    send_continuation(sock, {"id": "probe", "status": "success", "result": {"status": "ok"}})
                elif mode == "masked_frame":
                    send_masked_text(sock, {"id": "probe", "status": "success", "result": {"status": "ok"}})
                elif mode == "wrong_id":
                    send_text(sock, {"id": "wrong_id", "status": "success", "result": {"status": "ok"}})
                else:
                    send_text(sock, {"id": "probe", "status": "success", "result": {"status": "ok"}})
            elif cmd == "get_editor_state":
                if mode in ("healthy", "single_client"):
                    ms = "3D"
                elif mode == "late_ready":
                    ms = "unknown" if (time.monotonic() - start) < ready_after else "3D"
                elif mode == "never_ready":
                    ms = "unknown"
                else:
                    ms = "3D"
                send_text(sock, {
                    "id": "probe",
                    "status": "success",
                    "result": {
                        "main_screen": ms,
                        "godot_version": "4.6.2",
                        "current_scene": "res://Main.tscn" if ms != "unknown" else None,
                    },
                })
            else:
                break
    finally:
        if mode == "single_client" and not rejected:
            with active_lock:
                active["held"] = False
        sock.close()

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port))
s.listen(8)
sys.stdout.write(f"listening on {port} mode={mode}\n")
sys.stdout.flush()
while True:
    try:
        c, _ = s.accept()
    except OSError:
        break
    t = threading.Thread(target=handle, args=(c,), daemon=True)
    t.start()
PY

    python3 "$TMPDIR/mock_server.py" "$mode" "$port" "$ready_after" \
        >"$TMPDIR/m_${port}.log" 2>&1 &
    mock_server_pid=$!

    # Wait for the listening socket to be reachable.
    local tries=0
    while (( tries < 30 )); do
        if python3 -c "import socket; s=socket.socket(); s.settimeout(0.5); s.connect(('127.0.0.1',$port)); s.close()" 2>/dev/null; then
            return 0
        fi
        sleep 0.1
        tries=$((tries + 1))
    done
    echo "FATAL: mock server on port $port did not start" >&2
    cat "$TMPDIR/m_${port}.log" >&2
    exit 2
}

# Stop the currently running mock server.
stop_mock_server() {
    if [[ -n "$mock_server_pid" ]]; then
        kill "$mock_server_pid" 2>/dev/null || true
        wait "$mock_server_pid" 2>/dev/null || true
        mock_server_pid=""
    fi
}

# ---------------------------------------------------------------------------
# BLOCK A: launcher responsibility boundary — exec proxy regardless of TCP.
# Stage 1b moved TCP-readiness INTO the proxy (godot-mcp-launcher.sh:629-641:
# "Render-stable and TCP readiness monitoring are handled inside the proxy";
# the launcher always `exec node godot-mcp-proxy.mjs`). The old pre-exec
# wait_mcp_ready() gate is now dead code (zero call sites in the launcher), so
# with nothing listening the launcher STILL reaches `exec proxy` and hands
# stdio off — it no longer dies with "MCP endpoint not reachable". The proxy-
# side TCP-unreachable state machine is owned by test_see1070_warmup_self_heal
# (T2/T3/T4) and is NOT re-tested here. A1 asserts ONLY the launcher boundary.
# ---------------------------------------------------------------------------
sect "A: launcher execs proxy (TCP unreachable — boundary, not proxy state machine)"

STUB_DIR="$(make_stubbed_wrapper_dir)"
STUB_WRAPPER="$STUB_DIR/godot-mcp-launcher.sh"
MOCK_NPX_DIR="$(make_mock_npx)"

# SEE-1344: pin an explicit scratch project.godot for every launcher run —
# the 120s WORKTREE_WAIT tier (shared/SEE-1342 sync) preempts these short
# handoff windows when resolution falls through; the asserted contract is the
# Stage-1b exec handoff, not worktree resolution.
mk990scratch() {  # per-case scratch: same-worktree contention is worktree-granular
    local d="$TMPDIR/scratch-$1"; mkdir -p "$d"
    printf 'config_version=5\n\n[godot_mcp]\n\nport_override_enabled=false\nport_override=6550\n' > "$d/project.godot"
    echo "$d"
}

# Force the probe onto the loopback interface where the mock server binds. The
# real launcher resolves the WSL gateway (the Windows editor binds the vEthernet
# IP); in tests we point at 127.0.0.1 directly.
# B1 runs against a healthy listener — give it its own scratch (contention
# granularity is the worktree, and A1's handoff runtime still holds theirs).
SCRATCH_B1="$(mk990scratch b1)"
WRAP_ENV=(env "GODOT_HOST=127.0.0.1" "PATH=$MOCK_NPX_DIR:$PATH" "KOL_GODOT_MCP_CMD=npx" "KOL_PROJECT_GODOT=$SCRATCH_B1/project.godot" "KOL_WORKTREE=$SCRATCH_B1")

# A1: nothing listening on the port — the launcher must STILL exec the proxy
# (Stage 1b contract). Shorten the handed-off proxy's warmup/exit windows so it
# resolves and exits promptly; we observe the handoff, not the proxy lifecycle.
# stdin is held open briefly (sleep) so the proxy runs long enough to log.
PORT_A=$(find_free_port)
A1_OUT="$TMPDIR/A1_out.$$"; A1_ERR="$TMPDIR/A1_err.$$"
SCRATCH_A1="$(mk990scratch a1)"
A1_ENV=(env "GODOT_HOST=127.0.0.1" "PATH=$MOCK_NPX_DIR:$PATH" \
    "KOL_GODOT_MCP_CMD=npx" \
    "KOL_PROJECT_GODOT=$SCRATCH_A1/project.godot" "KOL_WORKTREE=$SCRATCH_A1" \
    "KOL_WARMUP_TIMEOUT_MS=2000" "KOL_FAILED_EXIT_MS=3000" "KOL_PROBE_INTERVAL_MS=500")
start_ts=$(date +%s)
( sleep 7 ) | timeout 20s "${A1_ENV[@]}" bash "$STUB_WRAPPER" --port "$PORT_A" >"$A1_OUT" 2>"$A1_ERR"
A1_RC=$?
end_ts=$(date +%s)
A1_ELAPSED=$((end_ts - start_ts))
# 1. Launcher reached the exec (handoff log emitted at godot-mcp-launcher.sh:640).
if grep -q "\[godot-mcp-launcher\] exec .*godot-mcp-proxy.mjs.*GODOT_PORT=${PORT_A}" "$A1_ERR"; then
    ok "A1: launcher reaches exec proxy (handoff logged, port=${PORT_A})"
else
    ko "A1: launcher did not log the exec-proxy handoff: $(head -c 200 "$A1_ERR")"
fi
# 2. The proxy actually took over (proxy-prefixed stderr proves exec landed).
if grep -q "\[godot-mcp-proxy\]" "$A1_ERR"; then
    ok "A1: proxy process started (launcher handed stdio off)"
else
    ko "A1: no [godot-mcp-proxy] output — exec did not land: $(head -c 200 "$A1_ERR")"
fi
# 3. Launcher did NOT gate-die on TCP — the old wait_mcp_ready diagnostic must
#    be absent (it is dead code), confirming the launcher no longer pre-exec
#    gates on TCP reachability.
if grep -q "MCP endpoint not reachable" "$A1_ERR"; then
    ko "A1: launcher emitted the old TCP-gate death — should not gate on TCP anymore"
else
    ok "A1: launcher did not gate-die on TCP (wait_mcp_ready not called)"
fi
# NOTE: the proxy's warmup/FAILED_EXIT outcome, stdout content, and overall rc
# are intentionally NOT asserted here — that state machine is owned by
# test_see1070_warmup_self_heal (T2/T3/T4). The launcher contract ends at exec.
if (( A1_ELAPSED <= 20 )); then
    ok "A1: resolved within bound (${A1_ELAPSED}s)"
else
    ko "A1: ran past the 20s bound (${A1_ELAPSED}s) — proxy may not be exiting"
fi

# ---------------------------------------------------------------------------
# BLOCK B: gate success path — TCP listener up, gate passes and execs npx.
# Under the TCP-only gate a plain TCP listener is sufficient; the gate does not
# perform a WS handshake (that would race the single-client addon slot, SEE-1009).
# ---------------------------------------------------------------------------
sect "B: gate success path (TCP reachable)"

# B1: any TCP listener — gate passes immediately and execs mock npx.
PORT_B1=$(find_free_port)
start_mock_server healthy "$PORT_B1"
out="$TMPDIR/B1_out.$$"; err="$TMPDIR/B1_err.$$"
start_ts=$(date +%s)
"${WRAP_ENV[@]}" bash "$STUB_WRAPPER" --port "$PORT_B1" >"$out" 2>"$err"
rc=$?
end_ts=$(date +%s)
if [[ $rc -eq 0 && -s "$out" && "$(cat "$out")" == *"MOCK_NPX_GODOT_PORT=${PORT_B1}"* ]]; then
    ok "B1: TCP gate passes and execs mock npx with GODOT_PORT=${PORT_B1}"
else
    ko "B1: expected success + mock npx output, rc=$rc stdout=$(head -c 200 "$out")"
fi
if (( end_ts - start_ts < 6 )); then
    ok "B1: gate path fast ($((end_ts - start_ts))s)"
else
    ko "B1: gate path took $((end_ts - start_ts))s, TCP gate should be fast when reachable"
fi
rm -f "$out" "$err"
stop_mock_server

# ---------------------------------------------------------------------------
# BLOCK R: probe-level editor-readiness check (direct, not via the launcher
# gate). The launcher gate no longer checks editor readiness (TCP-only), but the
# probe still exposes --check ready for manual diagnostics / future callers.
# never_ready serves get_editor_state with main_screen="unknown", so the probe
# must return rc=3 (editor not ready), NOT rc=2 (WS-down).
# ---------------------------------------------------------------------------
sect "R: probe --check ready detects editor-not-ready"

PORT_R=$(find_free_port)
start_mock_server never_ready "$PORT_R"
R_LOG="$TMPDIR/R_log.$$"
python3 "$PROBE" --host 127.0.0.1 --port "$PORT_R" --check ready --timeout 3 >"$R_LOG" 2>&1
R_RC=$?
if (( R_RC == 3 )) && grep -qE 'editor not ready yet|main_screen' "$R_LOG"; then
    ok "R: probe --check ready returns editor-not-ready (rc=3) for never_ready"
else
    ko "R: expected rc=3 editor-not-ready, got rc=$R_RC: $(head -c 200 "$R_LOG")"
fi
rm -f "$R_LOG"
stop_mock_server

# ---------------------------------------------------------------------------
# BLOCK D: single-client enforcement (matches real addon 4001 policy)
# ---------------------------------------------------------------------------
sect "D: single-client 4001 rejection"

# The mock's single_client mode rejects a second connection while the first is
# still open — the same policy as websocket_server.gd (4001). D1 proves the
# shipped probe reaches ready over ONE connection (so it never trips the guard).
# D2 is a negative control proving the mock actually bites a two-connection
# probe — without it D1 could pass vacuously and the guard would be meaningless.
PORT_D=$(find_free_port)
start_mock_server single_client "$PORT_D"

# D1: shipped probe --check ready against the single-client server. The fixed
# probe sends heartbeat + get_editor_state on one socket, so it must succeed.
D1_LOG="$TMPDIR/D1_log.$$"
python3 "$PROBE" --host 127.0.0.1 --port "$PORT_D" --check ready --timeout 3 >"$D1_LOG" 2>&1
D1_RC=$?
if (( D1_RC == 0 )) && grep -q "editor ready" "$D1_LOG"; then
    ok "D1: shipped probe reaches ready over one connection (rc=0)"
else
    ko "D1: probe failed against single-client server (rc=$D1_RC): $(head -c 200 "$D1_LOG")"
fi
# Brief pause so the mock releases the held slot before D2.
sleep 0.3

# D2: negative control — a probe that deliberately opens a SECOND connection
# while the first is still held must observe the 4001 rejection. Proves the mock
# enforces single-client, so D1 passing is a real signal.
D2_LOG="$TMPDIR/D2_log.$$"
python3 - 127.0.0.1 "$PORT_D" >"$D2_LOG" 2>&1 <<'PY'
import socket, base64, hashlib, json, struct, sys
host, port = sys.argv[1], int(sys.argv[2])

def ws_open():
    s = socket.create_connection((host, port), timeout=3); s.settimeout(3)
    key = base64.b64encode(bytes(range(16))).decode()
    req = ("GET / HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
           "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n" % (host, port, key))
    s.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        c = s.recv(4096)
        if not c: raise SystemExit("handshake closed")
        buf += c
    header, _, leftover = buf.partition(b"\r\n\r\n")
    if b" 101 " not in header.split(b"\r\n", 1)[0]:
        raise SystemExit("upgrade rejected")
    return s, leftover

def send_heartbeat(s):
    pl = json.dumps({"id": "p", "command": "heartbeat", "params": {}}).encode()
    mask = bytes(range(4))
    hdr = bytearray([0x81, 0x80 | len(pl)]) + mask
    s.sendall(bytes(hdr) + bytes(b ^ mask[i % 4] for i, b in enumerate(pl)))
    data = b""
    while True:
        if len(data) >= 2 and len(data) >= 2 + (data[1] & 0x7F):
            return
        c = s.recv(4096)
        if not c: raise SystemExit("hb closed")
        data += c

def read_close_code(s, data):
    while True:
        if len(data) >= 2:
            op = data[0] & 0x0F; ln = data[1] & 0x7F; i = 2
            if len(data) >= i + ln:
                pl = data[i:i+ln]
                if op == 0x8 and len(pl) >= 2:
                    print("CLOSE_CODE=%d" % struct.unpack(">H", pl[:2])[0])
                else:
                    print("OP=%d" % op)
                return
        c = s.recv(4096)
        if not c: print("CONN_CLOSED"); return
        data += c

a, _ = ws_open()
send_heartbeat(a)              # force the server thread to hold the slot
b, blog = ws_open()            # second connection — must be rejected (4001)
read_close_code(b, blog)
a.close(); b.close()
PY
D2_RC=$?
if (( D2_RC == 0 )) && grep -q "CLOSE_CODE=4001" "$D2_LOG"; then
    ok "D2: mock rejects a second connection with 4001 (negative control)"
else
    ko "D2: mock did not reject the second connection: $(head -c 200 "$D2_LOG")"
fi
rm -f "$D1_LOG" "$D2_LOG"
stop_mock_server

# ---------------------------------------------------------------------------
# BLOCK E: protocol-violation frames — probe must raise (LOW hardening)
# ---------------------------------------------------------------------------
sect "E: probe rejects protocol-violation frames"

# The mock sends a deliberately malformed frame as its heartbeat reply. Each
# case runs the shipped probe directly and asserts it dies (rc != 0) with the
# specific diagnostic, proving the probe rejects the violation rather than
# silently accepting a malformed reply.

# E1: continuation frame (opcode 0x0) with no prior fragment.
PORT_E1=$(find_free_port)
start_mock_server continuation_frame "$PORT_E1"
E1_LOG="$TMPDIR/E1_log.$$"
python3 "$PROBE" --host 127.0.0.1 --port "$PORT_E1" --check ready --timeout 3 >"$E1_LOG" 2>&1
E1_RC=$?
if (( E1_RC != 0 )) && grep -q "continuation frame" "$E1_LOG"; then
    ok "E1: probe rejects continuation frame (rc=$E1_RC)"
else
    ko "E1: probe should reject continuation frame, rc=$E1_RC: $(head -c 200 "$E1_LOG")"
fi
rm -f "$E1_LOG"
stop_mock_server

# E2: masked server->client frame (RFC 6455 5.1 violation).
PORT_E2=$(find_free_port)
start_mock_server masked_frame "$PORT_E2"
E2_LOG="$TMPDIR/E2_log.$$"
python3 "$PROBE" --host 127.0.0.1 --port "$PORT_E2" --check ready --timeout 3 >"$E2_LOG" 2>&1
E2_RC=$?
if (( E2_RC != 0 )) && grep -q "MUST NOT be masked" "$E2_LOG"; then
    ok "E2: probe rejects masked server frame (rc=$E2_RC)"
else
    ko "E2: probe should reject masked server frame, rc=$E2_RC: $(head -c 200 "$E2_LOG")"
fi
rm -f "$E2_LOG"
stop_mock_server

# E3: JSON-RPC reply whose id does not match the request id.
PORT_E3=$(find_free_port)
start_mock_server wrong_id "$PORT_E3"
E3_LOG="$TMPDIR/E3_log.$$"
python3 "$PROBE" --host 127.0.0.1 --port "$PORT_E3" --check ready --timeout 3 >"$E3_LOG" 2>&1
E3_RC=$?
if (( E3_RC != 0 )) && grep -qE "reply id|request id" "$E3_LOG"; then
    ok "E3: probe rejects mismatched reply id (rc=$E3_RC)"
else
    ko "E3: probe should reject mismatched reply id, rc=$E3_RC: $(head -c 200 "$E3_LOG")"
fi
rm -f "$E3_LOG"
stop_mock_server

# ---------------------------------------------------------------------------
# BLOCK C: static checks
# ---------------------------------------------------------------------------
sect "C: static checks"

if bash -n "$WRAPPER"; then ok "launcher: bash -n syntax OK"; else ko "launcher: bash -n failed"; fi
if python3 -m py_compile "$PROBE"; then ok "probe: python3 -m py_compile OK"; else ko "probe: python compile failed"; fi
if [[ -x "$WRAPPER" ]]; then ok "launcher is executable"; else ko "launcher not executable"; fi
if [[ -x "$PROBE" ]]; then ok "probe is executable"; else ko "probe not executable"; fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo "============================================================"
echo "SUMMARY: PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
if [[ ${#FAILS[@]} -gt 0 ]]; then
    echo "FAILURES:"
    for f in "${FAILS[@]}"; do echo "  - $f"; done
fi
echo "============================================================"

[[ $FAIL -eq 0 ]]
