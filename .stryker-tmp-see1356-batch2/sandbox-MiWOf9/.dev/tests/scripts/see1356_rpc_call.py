#!/usr/bin/env python3
"""see1356 QA driver helper — JSON-RPC call over a launcher's stdio.

Usage: rpc_call.py <fifo-in> <stdout-log> <request-json> <id> [timeout-s] [init]
Sends the MCP initialize handshake first ONLY when init=1 (default) — the
fork treats a repeated initialize on an established session as a protocol
violation and drops the connection (wedged npx churn). Later calls on the
same runtime must pass init=0.
"""
import json
import sys
import time

INIT = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"see1356-qa","version":"0.0"}}}'
NOTIF = '{"jsonrpc":"2.0","method":"notifications/initialized"}'


def main() -> int:
    fifo_in, stdout_log, request, rid = sys.argv[1:5]
    timeout = float(sys.argv[5]) if len(sys.argv) > 5 else 30.0
    do_init = sys.argv[6] != "0" if len(sys.argv) > 6 else True
    target = int(rid)
    with open(fifo_in, "w", buffering=1) as f:
        if do_init:
            f.write(INIT + "\n")
            time.sleep(0.3)
            f.write(NOTIF + "\n")
            time.sleep(0.1)
        f.write(request.rstrip() + "\n")
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with open(stdout_log, encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line.startswith("{"):
                        continue
                    try:
                        doc = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if doc.get("id") == target:
                        print(json.dumps(doc))
                        return 0
        except OSError:
            pass
        time.sleep(0.25)
    print(f"rpc_call timeout waiting for id={rid} in {stdout_log}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
