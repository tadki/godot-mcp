#!/usr/bin/env python3
"""Single-shot MCP readiness probe for godot-mcp-launcher.sh.

Three modes:

  --check tcp    TCP reachability only: open a socket to host:port, then close
                 immediately WITHOUT performing the RFC 6455 WebSocket upgrade.
                 This is the mode the launcher's readiness gate must use: the
                 godot_mcp addon (websocket_server.gd) accepts a SINGLE client
                 and rejects an incoming connection while the previous one is
                 still closing (CLOSE_CODE_ALREADY_CONNECTED=4001). Any WS
                 handshake here would occupy that one slot; when the probe then
                 closes, the addon enters teardown, and the real client (npx)
                 connecting in that window gets 4001-closed ("WebSocket was
                 closed before the connection was established"). TCP-only leaves
                 the WS slot free so npx is the first real WS client.

  --check ws     Full WS handshake + heartbeat reply on one socket. Used by the
                 launcher's orphan gate and manual diagnostics to prove the addon
                 is genuinely live (an idle Session 0 residual Godot holds the
                 TCP port with no live addon — TCP-only cannot tell those apart).

  --check ready  ws + get_editor_state, requiring the editor main screen to be
                 initialized. Used by manual diagnostics and the regression
                 suite; NOT by the launcher gate (would re-introduce the race).

In every mode the WS handshake (when performed) and heartbeat/get_editor_state
share a SINGLE socket, never a second connection. Stdlib-only so the wrapper
picks up no new dependency (no `websockets`/`websocket-client`/`ws` in the dev
env).

Distinct exit codes let the bash gate emit precise diagnostics:

  0  ready    -- TCP reachable (tcp); WS handshake + heartbeat replied (ws); or
                 ws + editor reports an initialized main screen (ready).
  2  WS-down  -- TCP refused (any mode), the WS upgrade was rejected, no
                 heartbeat reply arrived, or the connection dropped mid-probe.
                 In ws/ready mode this is the "port listens but the addon is not
                 live" signature (idle Session 0 residual Godot).
  3  editor   -- WS is responsive but EditorInterface is not ready yet
                 (get_editor_state reports main_screen "unknown"). Only emitted
                 by --check ready; the gate should keep waiting, not die on the
                 first sight of this.
  4  usage    -- bad arguments.

JSON-RPC envelope (addons/godot_mcp/mcp_utils.gd):
  request  {"id": "...", "command": "...", "params": {...}}
  response {"id": "...", "status": "success" | "error", "result": {...}}
"""

import argparse
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import time

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
# selection_commands.gd _get_current_main_screen: "unknown" until EditorInterface
# has a real main screen; any of these four means the editor UI is initialized.
READY_MAIN_SCREENS = {"2D", "3D", "Script", "AssetLib"}

EXIT_READY = 0
EXIT_WS_DOWN = 2
EXIT_EDITOR_NOT_READY = 3
EXIT_USAGE = 4
# SEE-1009 orphan gate: heartbeat ok but the addon is not the expected version
# (addon_version absent/"unknown" or != --expected-version). The launcher's
# orphan gate treats this as "stale residual editor holding the port".
EXIT_ORPHAN_VERSION = 5


def log(msg):
    print("[mcp-ready-probe] {}".format(msg), file=sys.stderr)


class WSSession:
    """One WebSocket connection carrying one or more JSON-RPC calls.

    godot_mcp's websocket_server.gd accepts a single client at a time and
    rejects an incoming connection while the previous one is still closing
    (CLOSE_CODE_ALREADY_CONNECTED=4001). The readiness probe therefore sends
    heartbeat and get_editor_state over the SAME socket instead of opening a
    second connection behind the first.
    """

    def __init__(self, host, port, timeout):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.deadline = time.monotonic() + timeout
        # Bytes read after the HTTP upgrade headers / after the last reply; the
        # next call() resumes parsing from here so pipelined frames aren't lost.
        self._leftover = b""
        self.sock = socket.create_connection((host, port), timeout=timeout)
        try:
            self.sock.settimeout(timeout)
            self._handshake()
        except Exception:
            try:
                self.sock.close()
            except OSError:
                pass
            raise

    def _handshake(self):
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            "GET / HTTP/1.1\r\n"
            "Host: {}:{}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: {}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        ).format(self.host, self.port, key)
        self.sock.sendall(request.encode("ascii"))

        buf = self._leftover
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise Exception("connection closed during WS handshake")
            buf += chunk
            if len(buf) > 16384:
                raise Exception("handshake response exceeded 16KB")

        header_blob, self._leftover = buf.split(b"\r\n\r\n", 1)
        header_text = header_blob.decode("latin1", "replace")
        status_line = header_text.split("\r\n", 1)[0]
        if " 101 " not in status_line:
            raise Exception("WS upgrade rejected: {}".format(status_line.strip()))

        expected_accept = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode("ascii")).digest()
        ).decode("ascii")
        if expected_accept not in header_text:
            raise Exception("Sec-WebSocket-Accept mismatch")

    def call(self, command, params, req_id="probe"):
        """Send one JSON-RPC command on this connection; return the parsed reply.

        Raises Exception on any transport/protocol/timeout/close failure, on an
        unexpected continuation frame, on a masked server frame, or when the
        reply id does not match the request id.
        """
        # Masked text frame (RFC 6455 5.3: client-to-server frames MUST be masked).
        payload = json.dumps(
            {"id": req_id, "command": command, "params": params}
        ).encode("utf-8")
        _send_text_frame(self.sock, payload)

        data = self._leftover
        while True:
            frame, data = _try_parse_frame(data)
            if frame is not None:
                if frame["opcode"] == 0x0:  # continuation — no fragmented reply expected
                    raise Exception("unexpected continuation frame (opcode 0x0)")
                if frame["opcode"] == 0x8:  # close
                    raise Exception(
                        "server closed (code {})".format(frame.get("code", "?"))
                    )
                if frame["opcode"] == 0x1:  # text
                    self._leftover = data
                    reply = json.loads(frame["payload"].decode("utf-8", "replace"))
                    # The addon (plugin.gd) echoes the request id verbatim; a
                    # mismatch means the reply is not for this call.
                    if reply.get("id") != req_id:
                        raise Exception(
                            "reply id {!r} != request id {!r}".format(
                                reply.get("id"), req_id
                            )
                        )
                    return reply
                # ping (0x9) / pong (0xA): control frames, keep reading.
            if time.monotonic() > self.deadline:
                raise Exception("timeout waiting for JSON-RPC reply")
            chunk = self.sock.recv(8192)
            if not chunk:
                raise Exception("connection closed waiting for JSON-RPC reply")
            data += chunk

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def _send_text_frame(sock, payload):
    mask = os.urandom(4)
    header = bytearray([0x81])  # FIN + text opcode.
    length = len(payload)
    if length < 126:
        header.append(0x80 | length)
    elif length < 65536:
        header.append(0x80 | 126)
        header += struct.pack(">H", length)
    else:
        header.append(0x80 | 127)
        header += struct.pack(">Q", length)
    header += mask
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(bytes(header) + masked)


def _try_parse_frame(data):
    """Parse one server frame. Partial -> wait.

    Server-to-client frames MUST be unmasked (RFC 6455 5.1); a masked server
    frame is a protocol violation and raises immediately. The godot_mcp addon
    never masks its replies, so masking signals a buggy or hostile peer.
    """
    if len(data) < 2:
        return None, data
    b1, b2 = data[0], data[1]
    opcode = b1 & 0x0F
    if (b2 & 0x80) != 0:
        raise Exception("server frame MUST NOT be masked (RFC 6455 5.1)")
    length = b2 & 0x7F
    idx = 2
    if length == 126:
        if len(data) < idx + 2:
            return None, data
        length = struct.unpack(">H", data[idx:idx + 2])[0]
        idx += 2
    elif length == 127:
        if len(data) < idx + 8:
            return None, data
        length = struct.unpack(">Q", data[idx:idx + 8])[0]
        idx += 8
    if len(data) < idx + length:
        return None, data
    payload = data[idx:idx + length]
    remaining = data[idx + length:]
    frame = {"opcode": opcode, "payload": payload}
    if opcode == 0x8 and length >= 2:
        frame["code"] = struct.unpack(">H", payload[:2])[0]
    return frame, remaining


def _is_success(reply):
    return (
        isinstance(reply, dict)
        and reply.get("status") == "success"
        and isinstance(reply.get("result"), dict)
    )


def main():
    parser = argparse.ArgumentParser(description="godot-mcp readiness probe")
    parser.add_argument("--host", default=os.environ.get("GODOT_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument(
        "--check",
        choices=["tcp", "ws", "ready", "orphan"],
        default="ws",
        help=(
            "tcp: TCP reachability only (no WS handshake, safe before npx); "
            "ws: handshake+heartbeat (default); "
            "ready: also require editor main screen; "
            "orphan: also call mcp_handshake and emit ADDON_VERSION=<v> (SEE-1009)"
        ),
    )
    parser.add_argument(
        "--expected-version",
        default=os.environ.get("KOL_MCP_EXPECTED_VERSION", ""),
        help=(
            "with --check orphan: require addon_version to equal this. "
            "Absent/unknown or mismatch => exit 5 (EXIT_ORPHAN_VERSION). "
            "Defaults to $KOL_MCP_EXPECTED_VERSION."
        ),
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=3.0,
        help="per-attempt connect(+handshake+reply) timeout (seconds)",
    )
    args = parser.parse_args()

    # TCP mode: open and immediately close a socket. Do NOT send a WS upgrade;
    # the addon is single-client and the real client (npx) must be the first to
    # complete the WebSocket handshake.
    if args.check == "tcp":
        try:
            sock = socket.create_connection((args.host, args.port), timeout=args.timeout)
            sock.close()
        except Exception as exc:  # noqa: BLE001 - any TCP failure is WS-down
            log("TCP probe failed on {}:{}: {}".format(args.host, args.port, exc))
            return EXIT_WS_DOWN
        log("TCP reachable on {}:{}; leaving WS slot free for npx.".format(args.host, args.port))
        return EXIT_READY

    try:
        session = WSSession(args.host, args.port, args.timeout)
    except Exception as exc:  # noqa: BLE001 - any transport/handshake failure is WS-down
        log("WS probe failed on {}:{}: {}".format(args.host, args.port, exc))
        return EXIT_WS_DOWN

    try:
        try:
            heartbeat_reply = session.call("heartbeat", {})
        except Exception as exc:  # noqa: BLE001
            log("heartbeat transport failed on {}:{}: {}".format(
                args.host, args.port, exc))
            return EXIT_WS_DOWN

        if not _is_success(heartbeat_reply):
            log("heartbeat returned non-success: {}".format(heartbeat_reply))
            return EXIT_WS_DOWN

        log("WS responsive (heartbeat ok) on {}:{}.".format(args.host, args.port))
        if args.check == "ws":
            return EXIT_READY

        if args.check == "orphan":
            # SEE-1009 orphan gate: heartbeat is alive, so an editor process is
            # holding the port. Now confirm the addon is the EXPECTED version: a
            # residual Session-0 editor from a prior addon version (or a stale
            # build reporting addon_version="unknown") is an orphan even though
            # it answers heartbeat. mcp_handshake rides the SAME socket.
            expected = (args.expected_version or "").strip()
            try:
                hs_reply = session.call(
                    "mcp_handshake",
                    {"server_version": expected} if expected else {},
                )
            except Exception as exc:  # noqa: BLE001
                log("mcp_handshake transport failed on {}:{}: {}".format(
                    args.host, args.port, exc))
                return EXIT_WS_DOWN

            if not _is_success(hs_reply):
                log("mcp_handshake returned non-success: {}".format(hs_reply))
                return EXIT_ORPHAN_VERSION

            result = hs_reply.get("result") or {}
            addon_version = str(result.get("addon_version", "")).strip()
            # Emit the discovered version so the launcher gate can log it without
            # re-parsing probe stderr in a second call.
            sys.stderr.write("ADDON_VERSION={}\n".format(addon_version))
            sys.stderr.flush()

            if addon_version == "" or addon_version.lower() == "unknown":
                log("orphan verdict: addon_version absent/unknown on {}:{}".format(
                    args.host, args.port))
                return EXIT_ORPHAN_VERSION
            if expected and addon_version != expected:
                log("orphan verdict: addon_version {} != expected {} on {}:{}".format(
                    addon_version, expected, args.host, args.port))
                return EXIT_ORPHAN_VERSION
            log("addon live (version {}) on {}:{}.".format(
                addon_version, args.host, args.port))
            return EXIT_READY

        # get_editor_state rides the SAME socket as heartbeat — opening a second
        # connection here trips the addon's single-client 4001 rejection.
        try:
            state_reply = session.call("get_editor_state", {})
        except Exception as exc:  # noqa: BLE001
            log("get_editor_state transport failed on {}:{}: {}".format(
                args.host, args.port, exc))
            return EXIT_WS_DOWN

        if not _is_success(state_reply):
            log("get_editor_state returned non-success: {}".format(state_reply))
            return EXIT_EDITOR_NOT_READY

        main_screen = (state_reply.get("result") or {}).get("main_screen")
        if main_screen in READY_MAIN_SCREENS:
            log("editor ready (main_screen={}) on {}:{}.".format(
                main_screen, args.host, args.port))
            return EXIT_READY

        log("editor not ready yet (main_screen={!r}); waiting for EditorInterface.".format(
            main_screen))
        return EXIT_EDITOR_NOT_READY
    finally:
        session.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(EXIT_USAGE)
