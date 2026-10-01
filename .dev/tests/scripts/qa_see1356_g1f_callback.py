#!/usr/bin/env python3
"""G1f callback probe v2 — connect_signal runtime callback WITHOUT window focus.

The scene runs via godot_editor_edit run; game stdout reaches the editor's
debugger session, not the editor log file. Probe via screenshot_game PNG is
blocked by a LOW-class defect (MCPDebuggerPlugin route/handler name mismatch,
pre-existing — present in the vendored addon too). So the callback marker is
asserted via the RUN's own observable: the game window the editor spawns is
visible in the process list while the Timer autostarts, and after `stop` the
connection must ALSO still be live in the editor memory (is_connected via a
get_scene_tree + properties re-check is not exposed). The plan's callback
proof is instead executed through godot_exec-style injection: run + capture
the game's stdout via the debugger console stream... not exposed either.

Definitive approach: Timer.wait_time=0.5 + autostart + connection to root
script that SETS a node property (`text`). After run+wait+stop, the property
set is runtime-only... it does not persist. So the honest runtime callback
proof = watch the game's own signal: add a second connection from QA_Timer
timeout to QA_Timer's own `start` is meaningless.

The chosen falsifiable probe: run the scene with the connection in place and
capture screenshot_game. If the callback fired, QARoot has no visual change,
so instead: connect timeout → root.on_qa_timeout which calls
`get_tree().quit()`. Run with a 1.2s timer: if the connection fired, the game
process EXITS BY ITSELF within ~2s. Observable via process lifetime — the
strongest unfalsifiable-free oracle.
"""
import json
import os
import subprocess
import sys
import time

ENV = {}
with open("/tmp/see1356-b2-env.env") as f:
    for line in f:
        if "=" in line:
            k, v = line.rstrip("\n").split("=", 1)
            ENV[k] = v

FIFO = ENV["FIFO"]
OUT = os.path.join(ENV["SB"], "rt.out")
W = ENV["W"]
PWSH = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"

_id = 900


def next_id():
    global _id
    _id += 1
    return _id


def send(request):
    with open(FIFO, "w", buffering=1) as f:
        f.write(json.dumps(request) + "\n")


def read_response(target, timeout_s=90):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with open(OUT, encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line.startswith("{"):
                        continue
                    try:
                        d = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if d.get("id") == target:
                        return d
        except OSError:
            pass
        time.sleep(0.25)
    return None


def call_tool(name, arguments, timeout_s=90):
    rid = next_id()
    send({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
          "params": {"name": name, "arguments": arguments}})
    resp = read_response(rid, timeout_s)
    if resp is None:
        return {"__timeout": True}
    result = resp.get("result", {})
    texts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
    return {"texts": texts, "is_error": result.get("isError", False), "result": result}


def editor_pid():
    r = subprocess.run([
        PWSH, "-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name like 'Godot%'\" | "
        "Where-Object { $_.CommandLine -match 'see-qa6' -and $_.CommandLine -match '--editor' } | "
        "ForEach-Object { $_.ProcessId.ToString() }",
    ], capture_output=True, text=True, timeout=30)
    pids = [p for p in r.stdout.replace("\r", "").split("\n") if p.strip().isdigit()]
    return pids[0] if pids else None


def game_pids():
    r = subprocess.run([
        PWSH, "-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name like 'Godot%'\" | "
        "Where-Object { $_.CommandLine -match 'see-qa6' -and $_.CommandLine -notmatch '--editor' } | "
        "ForEach-Object { $_.ProcessId.ToString() }",
    ], capture_output=True, text=True, timeout=30)
    return [p for p in r.stdout.replace("\r", "").split("\n") if p.strip().isdigit()]


# rewrite the root script: on_qa_timeout quits the game (connection fired!)
with open(os.path.join(W, "qa_final_cs_root.gd"), "w") as f:
    f.write("extends Node2D\nfunc on_qa_timeout() -> void:\n\tget_tree().quit()\n")

# reopen to make sure the editor picks up the script change cleanly
def call_tool_local(name, arguments, timeout_s=90):
    rid = next_id()
    send({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
          "params": {"name": name, "arguments": arguments}})
    return read_response(rid, timeout_s)


call_tool_local("godot_scene", {"action": "open", "scene_path": "res://scenes/ui/title_screen/title_screen.tscn"})
time.sleep(1.5)
call_tool_local("godot_scene", {"action": "open", "scene_path": "res://qa_final_cs.tscn"})
time.sleep(2.0)

# ensure connection is present in the editor-memory scene (it was saved in G1)
disk = open(os.path.join(W, "qa_final_cs.tscn"), encoding="utf-8").read()
print("connection on disk:", '[connection signal="timeout"' in disk)

epid = editor_pid()
print("editor pid:", epid)

r = call_tool_local("godot_editor_edit", {"action": "run", "scene_path": "res://qa_final_cs.tscn"})
texts = r.get("result", {}).get("content", [])
run_ok = not r.get("result", {}).get("isError", False)
print("run:", (texts[0].get("text", "") if texts else "")[:120])

time.sleep(2.0)
games_before = game_pids()
print("game pids during run:", games_before)
# Timer fires at 0.5s; give the quit a moment
time.sleep(3.0)
games_after = game_pids()

self_quit = bool(games_before) and not games_after
print("game self-exited:", self_quit, f"({len(games_before)} -> {len(games_after)})")

# stop the editor run if the game is still up (connection did NOT fire)
if games_after:
    call_tool_local("godot_editor_edit", {"action": "stop"})
    time.sleep(1.5)

conn = '[connection signal="timeout" from="QA_Timer" to="." method="on_qa_timeout"]' in disk
print("VERDICT: connection_on_disk =", conn, "| runtime_quit =", self_quit)

sys.exit(0 if (conn and self_quit) else 1)
