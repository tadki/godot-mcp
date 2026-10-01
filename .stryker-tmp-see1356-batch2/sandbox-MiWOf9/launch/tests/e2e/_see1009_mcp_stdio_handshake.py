#!/usr/bin/env python3
"""MCP stdio handshake helper for the SEE-1009 E2E test.

Runs a given command as an MCP stdio server (the launcher that execs npx),
speaks initialize + notifications/initialized + tools/list over stdio using the
Model Context Protocol stdio transport framing — **newline-delimited JSON
(NDJSON)**, not HTTP Content-Length headers — and prints a one-line verdict to
stdout:

    TOOLS_OK count=<n> server=<name> proto=<ver>
    TOOLS_FAIL <reason>

It writes a transcript (requests + replies) to the file given by argv[1].

Framing note (SEE-1009): the MCP SDK stdio transport serializes each message as
`JSON.stringify(msg) + '\n'` and parses by splitting on '\n'
(@modelcontextprotocol/sdk .../shared/stdio.js). The earlier version of this
helper wrote HTTP-style `Content-Length: N\r\n\r\n{payload}` frames with no
trailing newline, so the server's ReadBuffer never found a message boundary,
never parsed `initialize`, and never replied — the helper then blocked forever
in a blocking read1() until the outer `timeout` killed it. Both bugs are fixed
here: NDJSON framing, and a select-based non-blocking read with a deadline.
"""
import json
import os
import select
import subprocess
import sys
import time


def main():
    transcript_path = sys.argv[1]
    timeout = float(sys.argv[2]) if len(sys.argv) > 2 else 60.0
    cmd = sys.argv[3:]

    with open(transcript_path, "w", encoding="utf-8") as log:
        def log_line(line):
            log.write(line + "\n")
            log.flush()

        env = os.environ.copy()
        # stdout must be kept clean for the MCP JSON-RPC stream. stderr is left
        # connected to our own stderr so the bash layer can capture the launcher
        # logs directly (we do not need to drain it here).
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,  # inherit helper's stderr
            env=env,
            bufsize=-1,  # default buffering: BufferedReader gives read1()
        )

        # NDJSON framing: one JSON object per line, terminated by '\n'. This is
        # what the MCP SDK stdio transport reads and writes.
        def send(obj):
            line = (json.dumps(obj) + "\n").encode("utf-8")
            proc.stdin.write(line)
            proc.stdin.flush()

        deadline = time.monotonic() + timeout

        def read_msg(want_id, skip_log_prefix=""):
            """Non-blocking read until a JSON-RPC reply with id == want_id.

            Uses select() with the remaining deadline so we never block past it
            (the old blocking read1() could hang forever if the server wrote
            nothing). Unrelated notifications/replies are logged and skipped.
            Returns the matching message dict, or None on timeout/EOF.
            """
            buf = b""
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                ready, _, _ = select.select([proc.stdout], [], [], min(1.0, remaining))
                if not ready:
                    continue
                chunk = proc.stdout.read1(65536) if hasattr(proc.stdout, "read1") else proc.stdout.read(65536)
                if not chunk:
                    return None  # EOF
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line.decode("utf-8", "replace"))
                    except Exception as exc:  # noqa: BLE001 - keep going on a bad line
                        log_line("PARSE_ERROR %s %r" % (exc, line[:200]))
                        continue
                    if msg.get("id") == want_id:
                        return msg
                    if "method" in msg:
                        log_line("%sNOTIFICATION %s" % (skip_log_prefix, msg.get("method")))
                    elif "id" in msg:
                        log_line("%sREPLY id=%s (not %s)" % (skip_log_prefix, msg.get("id"), want_id))
            # unreachable
            return None

        send({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "see1009-e2e-probe", "version": "1.0"},
            },
        })
        init = read_msg(1)
        log_line("INIT_REPLY " + json.dumps(init, ensure_ascii=False))
        if not isinstance(init, dict) or init.get("id") != 1 or "result" not in init:
            print("TOOLS_FAIL no initialize reply")
            _close(proc, deadline)
            return

        result = init.get("result") or {}
        server_info = (result.get("serverInfo") or {}).get("name", "?")
        proto = result.get("protocolVersion", "?")
        caps = result.get("capabilities") or {}
        if "tools" not in caps:
            print("TOOLS_FAIL server has no tools capability: %s" % json.dumps(caps))
            _close(proc, deadline)
            return

        send({"jsonrpc": "2.0", "method": "notifications/initialized"})

        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        tl = read_msg(2)
        log_line("TOOLS_LIST_REPLY " + json.dumps(tl, ensure_ascii=False))
        if not isinstance(tl, dict) or tl.get("id") != 2:
            print("TOOLS_FAIL no tools/list reply")
            _close(proc, deadline)
            return
        if tl.get("error"):
            print("TOOLS_FAIL tools/list error: %s" % json.dumps(tl.get("error")))
            _close(proc, deadline)
            return
        tools = ((tl.get("result") or {}).get("tools")) or []
        print("TOOLS_OK count=%d server=%s proto=%s" % (len(tools), server_info, proto))

        _close(proc, deadline)


def _close(proc, deadline):
    try:
        proc.stdin.close()
    except Exception:
        pass
    remaining = max(0.0, deadline - time.monotonic())
    try:
        proc.wait(timeout=remaining)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


if __name__ == "__main__":
    main()
