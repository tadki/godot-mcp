#!/usr/bin/env python3
"""S3v2 — Script tab switch WITHOUT SendKeys: use the editor's own
Layout/EditorLayout loading? Not exposed. Alternative: gd script exec is not
available. Use the addon's open_scene on a .gd file → editor opens the script
in the Script main screen natively (open_scene_from_path on a .gd switches to
the Script editor). Then main_screen should read 'Script'."""
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
OUTDIR = "/tmp/see1356-final-qa"
os.makedirs(OUTDIR, exist_ok=True)

_id = 1100


def next_id():
    global _id
    _id += 1
    return _id


def send(request):
    with open(FIFO, "w", buffering=1) as f:
        f.write(json.dumps(request) + "\n")


def read_response(target, timeout_s=60):
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


def call_tool(name, arguments, timeout_s=60):
    rid = next_id()
    send({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
          "params": {"name": name, "arguments": arguments}})
    resp = read_response(rid, timeout_s)
    if resp is None:
        return {"__timeout": True}
    result = resp.get("result", {})
    texts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
    images = [c for c in result.get("content", []) if c.get("type") == "image"]
    parsed = None
    for t in texts:
        try:
            parsed = json.loads(t)
            break
        except (json.JSONDecodeError, ValueError):
            continue
    return {"texts": texts, "images": images, "parsed": parsed, "is_error": result.get("isError", False)}


PASS = 0
FAIL = 0
def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [PASS] {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name}{' — ' + detail if detail else ''}")
    return cond


def get_state():
    return (call_tool("godot_editor_read", {"action": "get_state"})["parsed"]) or {}


print("== S3v2: Script editor via open_scene(.gd) ==")
gd_rel = "res://qa_final_cs_root.gd"
o = call_tool("godot_scene", {"action": "open", "scene_path": gd_rel})
check("S3v2a open .gd via godot_scene", not o.get("is_error"), str(o.get("texts"))[:150])
time.sleep(2.0)
st = get_state()
ms = st.get("main_screen")
check("S3v2b main_screen=Script (open_scene_from_path on .gd switches)", ms == "Script", str(ms))

s = call_tool("godot_editor_read", {"action": "screenshot_editor", "viewport": "2d", "max_width": 900})
imgs = s["images"]
check("S3v2c Script 态 screenshot returns image", len(imgs) == 1)
if imgs:
    import base64
    raw = base64.b64decode(imgs[0]["data"])
    check("S3v2d Script 态 PNG magic", raw[:8] == b"\x89PNG\r\n\x1a\n")
    p = os.path.join(OUTDIR, "final_script_v2.png")
    with open(p, "wb") as f:
        f.write(raw)
    print(f"  [info] saved {p} ({len(raw)} bytes)")

print(f"\nSUMMARY: PASS={PASS} FAIL={FAIL}")
sys.exit(0 if FAIL == 0 else 1)
