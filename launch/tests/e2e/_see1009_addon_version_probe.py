#!/usr/bin/env python3
"""Raw WS handshake diagnostic for SEE-1009 multi-port regression.

Connects directly to a godot-mcp addon WS endpoint, performs the WebSocket
upgrade, sends `mcp_handshake` (the same command npx sends), and prints the
raw `addon_version` / `project_path` / `godot_version` the RUNNING editor
actually reports. This bypasses npx's version check so we can see exactly why
npx prints `addon=unknown` (stale addon in memory vs. version drift vs. missing
field).

Standalone (no Godot, no npx) — only needs python3 stdlib.

Usage:
    python3 _see1009_addon_version_probe.py <host> <port>

Prints one line:
    ADDON version=<v> godot=<g> project=<path>
or:
    ADDON_FAIL <reason>
"""
import base64
import hashlib
import json
import os
import socket
import struct
import sys


def ws_handshake(host, port):
    s = socket.create_connection((host, port), timeout=5)
    s.settimeout(5)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    req = (
        "GET / HTTP/1.1\r\n"
        "Host: {}:{}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: {}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    ).format(host, port, key)
    s.sendall(req.encode("ascii"))
    buf = b""
    while b"\r\n\r\n" not in buf:
        c = s.recv(4096)
        if not c:
            raise RuntimeError("handshake closed before 101")
        buf += c
    header, _, leftover = buf.partition(b"\r\n\r\n")
    if b" 101 " not in header.split(b"\r\n")[0]:
        raise RuntimeError("not a 101: %r" % header.split(b"\r\n")[0])
    return s, leftover


def send_text(s, obj):
    payload = json.dumps(obj).encode("utf-8")
    mask = os.urandom(4)
    header = bytearray([0x81])  # FIN + text
    if len(payload) < 126:
        header.append(0x80 | len(payload))  # mask bit set
    elif len(payload) < 65536:
        header.append(0x80 | 126)
        header += struct.pack(">H", len(payload))
    else:
        header.append(0x80 | 127)
        header += struct.pack(">Q", len(payload))
    header += mask
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    s.sendall(bytes(header) + masked)


def recv_frame(s, leftover):
    data = leftover
    deadline_recv = 50  # iterations
    while True:
        if len(data) >= 2:
            b1, b2 = data[0], data[1]
            op = b1 & 0x0F
            masked = (b2 & 0x80) != 0
            ln = b2 & 0x7F
            i = 2
            if ln == 126:
                if len(data) < i + 2:
                    pass
                else:
                    ln = struct.unpack(">H", data[i:i + 2])[0]
                    i += 2
            elif ln == 127:
                if len(data) >= i + 8:
                    ln = struct.unpack(">Q", data[i:i + 8])[0]
                    i += 8
            mk_len = 4 if masked else 0
            if masked and len(data) >= i + mk_len + ln:
                mk = data[i:i + 4]
                i += 4
                pl = data[i:i + ln]
                pl = bytes(b ^ mk[j % 4] for j, b in enumerate(pl))
                return op, pl, data[i + ln:]
            if not masked and len(data) >= i + ln:
                pl = data[i:i + ln]
                return op, pl, data[i + ln:]
        c = s.recv(4096)
        if not c:
            raise RuntimeError("connection closed waiting for frame")
        data += c
        deadline_recv -= 1
        if deadline_recv <= 0:
            raise RuntimeError("recv_frame exhausted")


def main():
    host = sys.argv[1]
    port = int(sys.argv[2])
    try:
        s, leftover = ws_handshake(host, port)
    except Exception as exc:
        print("ADDON_FAIL handshake: %s" % exc)
        return
    try:
        # Some addon versions 4001-reject a second client. If that happens the
        # very first frame we read will be a close(4001).
        send_text(s, {
            "id": "see1009-probe",
            "command": "mcp_handshake",
            "params": {"server_version": "4.1.0"},
        })
        op, pl, _ = recv_frame(s, leftover)
        if op == 0x8:
            code = struct.unpack(">H", pl[:2])[0] if len(pl) >= 2 else 0
            print("ADDON_FAIL close_code=%d" % code)
            return
        obj = json.loads(pl.decode("utf-8", "replace"))
        result = obj.get("result", obj)
        version = result.get("addon_version", "<missing>")
        godot = result.get("godot_version", "<missing>")
        project = result.get("project_path", "<missing>")
        name = result.get("project_name", "<missing>")
        print("ADDON version=%s godot=%s project=%s name=%s" %
              (version, godot, project, name))
    except Exception as exc:
        print("ADDON_FAIL %s" % exc)
    finally:
        try:
            s.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
