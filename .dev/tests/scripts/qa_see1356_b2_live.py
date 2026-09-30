#!/usr/bin/env python3
"""SEE-1356 batch-2 live QA driver (v2) — §SPEC-L3-02/03 + §SPEC-L4-01/02.

Flow (re-ordered for main-screen control):
  P0  precondition: echo + state
  S1  open 2D scratch scene → screenshot_editor(2d) → PNG magic + eyeball file
  L4a add_node → tree 复核 → save('save') → .tscn serialization asserts
  L4d undo/redo via editor SendKeys Ctrl+Z / Ctrl+Y (EditorUndoRedoManager)
  L4b attach_script → reload → log cursor zero-error
  R1  instanced sub-scene write → INSTANCED_SCENE rejection
  S2  open 3D scene → main_screen=3D → screenshot_editor(3d) → PNG magic
  S3  SendKeys Ctrl+F3 → main_screen=Script → screenshot → PNG magic
Evidence PNGs land in /tmp/see1356-b2-qa-evidence for --attachment eyeball.
"""
import base64
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
RID = ENV["RID"]
OUTDIR = "/tmp/see1356-b2-qa-evidence"
os.makedirs(OUTDIR, exist_ok=True)
PWSH = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
EDITOR_PID = sys.argv[1] if len(sys.argv) > 1 else None

_id = 500


def send(request):
    with open(FIFO, "w", buffering=1) as f:
        f.write(json.dumps(request) + "\n")


def next_id():
    global _id
    _id += 1
    return _id


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


def call_tool(name, arguments, timeout_s=60, expect_error=False):
    rid = next_id()
    send({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
          "params": {"name": name, "arguments": arguments}})
    resp = read_response(rid, timeout_s)
    if resp is None:
        return {"__timeout": True}
    result = resp.get("result", {})
    texts = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
    images = [c for c in result.get("content", []) if c.get("type") == "image"]
    is_error = result.get("isError", False)
    parsed = None
    for t in texts:
        try:
            parsed = json.loads(t)
            break
        except (json.JSONDecodeError, ValueError):
            continue
    if expect_error:
        return {"texts": texts, "images": images, "parsed": parsed, "is_error": is_error, "raw": resp}
    assert not is_error, f"{name} errored: {texts}"
    return {"texts": texts, "images": images, "parsed": parsed, "raw": resp}


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


def png_magic_ok(b64):
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return False, None
    return raw[:8] == b"\x89PNG\r\n\x1a\n", raw


def save_b64_png(b64, name):
    raw = base64.b64decode(b64)
    p = os.path.join(OUTDIR, name)
    with open(p, "wb") as f:
        f.write(raw)
    return p, len(raw)


def get_state():
    return (call_tool("godot_editor_read", {"action": "get_state"})["parsed"]) or {}


def send_keys(keys):
    """Real Windows UI input to the editor window (main-screen switches / undo)."""
    subprocess.run([
        PWSH, "-NoProfile", "-Command",
        "[Microsoft.VisualBasic.Interaction]::AppActivate(" + EDITOR_PID + ");"
        "Start-Sleep -Milliseconds 300;"
        "[System.Windows.Forms.SendKeys]::SendWait('" + keys + "')",
    ], capture_output=True, timeout=30)
    time.sleep(0.6)


print("== P0: precondition ==")
r = call_tool("godot_project", {"action": "get_info"})
echo = None
for t in r["texts"]:
    if "workdir_snapshot" in t:
        echo = json.loads(t).get("workdir_snapshot")
        break
check("P0 echo workdir_hash == b2c0ffee0001 (slot)", echo and echo.get("workdir_hash") == "b2c0ffee0001" and echo.get("hash_source") == "slot", str(echo))

# ---- S1: 2D scratch scene + screenshot ----
print("== S1: 2D scene open + screenshot ==")
scratch_rel = "res://qa_scratch_b2.tscn"
scratch_abs = os.path.join(W, "qa_scratch_b2.tscn")
with open(scratch_abs, "w") as f:
    f.write("""[gd_scene load_steps=2 format=3 uid="uid://cqab2scratch1"]

[ext_resource type="Script" path="res://qa_scratch_b2_root.gd" id="1_root"]

[node name="QARoot" type="Node2D"]
script = ExtResource("1_root")

[node name="Anchor" type="Marker2D" parent="."]
position = Vector2(40, 60)
""")
with open(os.path.join(W, "qa_scratch_b2_root.gd"), "w") as f:
    f.write("extends Node2D\nfunc on_qa_pressed() -> void:\n\tprint(\"QA_SIGNAL_CALLBACK_FIRED\")\n")
with open(os.path.join(W, "qa_scratch_b2_node.gd"), "w") as f:
    f.write("extends Label\n")

o = call_tool("godot_scene", {"action": "open", "scene_path": scratch_rel})
check("S1 open scratch 2D scene", not o.get("is_error"), str(o.get("texts"))[:150])
time.sleep(2.0)
st = get_state()
check("S1 main_screen=2D", st.get("main_screen") == "2D", str(st.get("main_screen")))

s = call_tool("godot_editor_read", {"action": "screenshot_editor", "viewport": "2d", "max_width": 900})
imgs = s["images"]
check("S1 2D screenshot returns one image block", len(imgs) == 1)
if imgs:
    ok, raw = png_magic_ok(imgs[0]["data"])
    check("S1 PNG magic bytes (89 50 4E 47 0D 0A 1A 0A)", ok)
    if ok:
        p, n = save_b64_png(imgs[0]["data"], "shot_2d.png")
        print(f"  [info] saved {p} ({n} bytes)")

# ---- L4a: add_node → 复核 → save → .tscn serialization ----
print("== L4a: add_node → save → .tscn serialization ==")
a = call_tool("godot_node_edit", {"action": "add_node", "parent_path": ".",
                                  "node_type": "Label", "name": "QANode"})
reply = a["texts"][0] if a["texts"] else ""
# LIVE contract (differs from unit wording): saved:false + save_scene guidance + revert hint
check("L4a add_node reply: saved:false + save_scene guidance + revert_hint",
      "(saved: false)" in reply and "save_scene" in reply and "Revert hint:" in reply,
      reply[:260])
tree = call_tool("godot_node_read", {"action": "get_scene_tree"})
check("L4a get_scene_tree 复核 QANode present", "QANode" in json.dumps(tree["parsed"] or {}))
sv = call_tool("godot_scene", {"action": "save"})
check("L4a save_scene('save') ok", not sv.get("is_error"), str(sv.get("texts"))[:150])

disk = open(scratch_abs, encoding="utf-8").read()
check("L4a .tscn load_steps line", "[gd_scene load_steps=" in disk.split("\n")[0])
check("L4a QANode serialized as root child (owner 必设生效)",
      '[node name="QANode" type="Label" parent="."' in disk)
import re as _re
check("L4a scene uid present", bool(_re.search(r'uid="uid://[a-z0-9]+"', disk)))

# ---- L4d: undo/redo via editor SendKeys (EditorUndoRedoManager stack) ----
print("== L4d: undo/redo via editor SendKeys ==")
if EDITOR_PID:
    send_keys("^z")  # Ctrl+Z — undo the add_node
    time.sleep(1.0)
    tree_u = call_tool("godot_node_read", {"action": "get_scene_tree"})
    check("L4d Ctrl+Z undo → QANode gone（undo 栈行为正常）",
          "QANode" not in json.dumps(tree_u["parsed"] or {}))
    send_keys("^y")  # Ctrl+Y — redo
    time.sleep(1.0)
    tree_r = call_tool("godot_node_read", {"action": "get_scene_tree"})
    check("L4d Ctrl+Y redo → QANode back", "QANode" in json.dumps(tree_r["parsed"] or {}))
else:
    print("  [skip] EDITOR_PID not provided")

# ---- L4b: attach_script + reload + log cursor zero-error ----
print("== L4b: attach_script + 增量 cursor ==")
logs_before = call_tool("godot_editor_read", {"action": "get_log_messages"})
cursor0 = None
for t in logs_before["texts"]:
    try:
        cursor0 = json.loads(t).get("cursor")
        break
    except (json.JSONDecodeError, ValueError):
        continue
b = call_tool("godot_node_edit", {"action": "attach_script", "node_path": "QANode",
                                  "script_path": "res://qa_scratch_b2_node.gd"})
breply = b["texts"][0] if b["texts"] else ""
check("L4b attach_script reply carries contract fields",
      "(saved:" in breply and "Revert hint:" in breply and "Properties:" in breply, breply[:220])
call_tool("godot_scene", {"action": "save"})
time.sleep(1.0)
logs_after = call_tool("godot_editor_read", {"action": "get_log_messages", "since": cursor0 or 0})
err_new = []
for t in logs_after["texts"]:
    try:
        d = json.loads(t)
        err_new = [m for m in d.get("messages", []) if m.get("type") == "Error"]
        break
    except (json.JSONDecodeError, ValueError):
        continue
check("L4b reload 后增量日志零 Error", len(err_new) == 0, str(err_new)[:200])

# ---- R1: instanced sub-scene write rejection ----
print("== R1: instanced 子场景写拒绝 ==")
r = call_tool("godot_node_edit", {"action": "add_node", "parent_path": "QANode",
                                  "node_type": "Label", "name": "Inner"}, expect_error=True)
# QANode is a direct child — allowed. Open title_screen to hunt an instanced
# sub-scene child (its members' owner != edited root → INSTANCED_SCENE).
call_tool("godot_scene", {"action": "open", "scene_path": "res://scenes/ui/title_screen/title_screen.tscn"})
time.sleep(1.5)
ts = call_tool("godot_node_read", {"action": "get_scene_tree", "max_depth": 4})
treej = ts["parsed"] or {}
instanced_target = None
def hunt(node):
    global instanced_target
    if instanced_target:
        return
    for k in (node.get("children") or []):
        path = k.get("path") or ""
        if k.get("children"):
            instanced_target = path or k.get("name")
            return
        hunt(k)
hunt(treej if isinstance(treej, dict) else {})
print(f"  [info] instanced candidate: {instanced_target}")
if instanced_target:
    r2 = call_tool("godot_node_edit", {"action": "update", "node_path": instanced_target,
                                       "properties": {"visible": False}}, expect_error=True)
    joined = json.dumps(r2.get("parsed") or "") + json.dumps(r2.get("texts") or "")
    check("R1 instanced 子场景写 → INSTANCED_SCENE 明确拒绝", "INSTANCED_SCENE" in joined, joined[:220])
else:
    check("R1 instanced 子场景写 → INSTANCED_SCENE 明确拒绝", 0, "no candidate found")

# ---- S2: 3D scene → main_screen=3D → screenshot ----
print("== S2: 3D scene + screenshot ==")
scratch3d_rel = "res://qa_scratch_3d.tscn"
with open(os.path.join(W, "qa_scratch_3d.tscn"), "w") as f:
    f.write("""[gd_scene format=3]

[node name="QA3DRoot" type="Node3D"]

[node name="Mesh" type="MeshInstance3D" parent="."]
""")
o = call_tool("godot_scene", {"action": "open", "scene_path": scratch3d_rel})
time.sleep(2.0)
st3 = get_state()
check("S2 open 3D scene → main_screen=3D", st3.get("main_screen") == "3D", str(st3.get("main_screen")))
s = call_tool("godot_editor_read", {"action": "screenshot_editor", "viewport": "3d", "max_width": 900})
imgs = s["images"]
check("S2 3D screenshot returns image", len(imgs) == 1)
if imgs:
    ok, raw = png_magic_ok(imgs[0]["data"])
    check("S2 3D PNG magic bytes", ok)
    if ok:
        p, n = save_b64_png(imgs[0]["data"], "shot_3d.png")
        print(f"  [info] saved {p} ({n} bytes)")

# ---- S3: Script tab via editor shortcut ----
print("== S3: Script tab screenshot ==")
if EDITOR_PID:
    send_keys("^{F3}")  # Ctrl+F3 — Script main screen (Godot 4 default)
    time.sleep(1.2)
    st4 = get_state()
    check("S3 main_screen=Script (Ctrl+F3)", st4.get("main_screen") == "Script",
          str(st4.get("main_screen")))
    s = call_tool("godot_editor_read", {"action": "screenshot_editor", "viewport": "2d", "max_width": 900})
    imgs = s["images"]
    check("S3 Script-tab screenshot returns image", len(imgs) == 1)
    if imgs:
        ok, raw = png_magic_ok(imgs[0]["data"])
        check("S3 Script-tab PNG magic bytes", ok)
        if ok:
            p, n = save_b64_png(imgs[0]["data"], "shot_script.png")
            print(f"  [info] saved {p} ({n} bytes)")
else:
    print("  [skip] EDITOR_PID not provided")

print(f"\nSUMMARY: PASS={PASS} FAIL={FAIL}")
sys.exit(0 if FAIL == 0 else 1)
