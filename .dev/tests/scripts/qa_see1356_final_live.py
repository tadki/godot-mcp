#!/usr/bin/env python3
"""SEE-1356 final full-QA driver — Owner 终局指示（禁降级）.
Full godot-mcp lib + full KOL checkout host runtime (see-qa6 slot).
Scenarios (§SPEC-L4-02/03, §SPEC-L3-03, LOW1-3, spot checks):
  P0  precondition
  G1  connect_signal binary gate: connect → save → [connection] on disk →
      reload → runtime callback fires (Timer → root script print marker)
  G2  undo stack: Ctrl+Z via editor SendKeys after add_node → node gone;
      Ctrl+Y → node back (real editor undo, NOT the MCP write path)
  G3  F1: update_node on instanced sub-scene child → INSTANCED_SCENE;
      control: direct child update not rejected
  S3  Script tab: Ctrl+F3 → screenshot → PNG magic + eyeball file
  L1  LOW1: half-schema snapshot (delete worktree key) → snapshot_absent
  G4  LOW2/LOW3 machine re-verification (separate shells, see report)
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
OUTDIR = "/tmp/see1356-final-qa"
os.makedirs(OUTDIR, exist_ok=True)
PWSH = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
EDITOR_PID = sys.argv[1] if len(sys.argv) > 1 else None

_id = 800


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
    images = [c for c in result.get("content", []) if c.get("type") == "image"]
    is_error = result.get("isError", False)
    parsed = None
    for t in texts:
        try:
            parsed = json.loads(t)
            break
        except (json.JSONDecodeError, ValueError):
            continue
    return {"texts": texts, "images": images, "parsed": parsed, "is_error": is_error, "raw": resp}


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


def save_png(b64, name):
    raw = base64.b64decode(b64)
    p = os.path.join(OUTDIR, name)
    with open(p, "wb") as f:
        f.write(raw)
    return p, len(raw)


def get_state():
    return (call_tool("godot_editor_read", {"action": "get_state"})["parsed"]) or {}


def send_keys(keys):
    subprocess.run([
        PWSH, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        r"C:\Users\happy\win_focus.ps1",
    ], capture_output=True, timeout=30)
    time.sleep(0.4)
    subprocess.run([
        PWSH, "-NoProfile", "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; "
        "[System.Windows.Forms.SendKeys]::SendWait('" + keys + "')",
    ], capture_output=True, timeout=30)
    time.sleep(0.8)


print("== P0: precondition ==")
g = call_tool("godot_project", {"action": "get_info"})
echo = None
for t in g["texts"]:
    if "workdir_snapshot" in t:
        echo = json.loads(t).get("workdir_snapshot")
        break
check("P0 runtime alive + snapshot echo", echo is not None and echo.get("hash_source") in ("slot", "path"), str(echo))

# ---- G1: connect_signal binary gate (re-enabled direct CONNECT_PERSIST) ----
print("== G1: connect_signal binary gate 三连 ==")
scratch_rel = "res://qa_final_cs.tscn"
scratch_abs = os.path.join(W, "qa_final_cs.tscn")
with open(scratch_abs, "w") as f:
    f.write("""[gd_scene load_steps=2 format=3 uid="uid://cfinalcs0001"]

[ext_resource type="Script" path="res://qa_final_cs_root.gd" id="1_root"]

[node name="QARoot" type="Node2D"]
script = ExtResource("1_root")
""")
with open(os.path.join(W, "qa_final_cs_root.gd"), "w") as f:
    f.write("extends Node2D\nvar fired := 0\nfunc on_qa_timeout() -> void:\n\tfired += 1\n\tprint(\"QA_CALLBACK_FIRED_\", fired)\n")

o = call_tool("godot_scene", {"action": "open", "scene_path": scratch_rel})
check("G1 open scratch", not o.get("is_error"), str(o.get("texts"))[:150])
time.sleep(1.5)

a = call_tool("godot_node_edit", {"action": "add_node", "parent_path": ".",
                                  "node_type": "Timer", "name": "QA_Timer"})
check("G1a add_node QA_Timer", not a.get("is_error"), str(a.get("texts"))[:150])
call_tool("godot_node_edit", {"action": "update", "node_path": "QA_Timer",
                              "properties": {"wait_time": 0.5, "autostart": True}})
c = call_tool("godot_node_edit", {"action": "connect_signal", "node_path": "QA_Timer",
                                  "signal": "timeout", "target_path": ".", "method": "on_qa_timeout"})
creply = c["texts"][0] if c["texts"] else ""
check("G1b connect accepted (CONNECT_PERSIST 直写)", "Connected" in creply, creply[:200])
sv = call_tool("godot_scene", {"action": "save"})
check("G1c save ok", not sv.get("is_error") and "Saved" in str(sv.get("texts")), str(sv.get("texts"))[:150])

disk = open(scratch_abs, encoding="utf-8").read()
conn_line = '[connection signal="timeout" from="QA_Timer" to="." method="on_qa_timeout"]'
check("G1d [connection] 段落盘（binary gate 核心判据）", conn_line in disk,
      "\n".join(l for l in disk.splitlines() if "connection" in l.lower()) or "NO CONNECTION SECTION")

call_tool("godot_scene", {"action": "open", "scene_path": "res://scenes/ui/title_screen/title_screen.tscn"})
time.sleep(1.5)
call_tool("godot_scene", {"action": "open", "scene_path": scratch_rel})
time.sleep(2.0)
disk2 = open(scratch_abs, encoding="utf-8").read()
check("G1e reload 后 [connection] 仍在", conn_line in disk2)

logs_before = call_tool("godot_editor_read", {"action": "get_log_messages"})
call_tool("godot_editor_edit", {"action": "run", "scene_path": scratch_rel})
time.sleep(3.5)
call_tool("godot_editor_edit", {"action": "stop"})
logs_after = call_tool("godot_editor_read", {"action": "get_log_messages"})
fired = False
for t in logs_after["texts"]:
    try:
        d = json.loads(t)
        for m in d.get("messages", []):
            if "QA_CALLBACK_FIRED" in (m.get("message") or ""):
                fired = True
        break
    except (json.JSONDecodeError, ValueError):
        continue
if not fired:
    import glob
    cands = sorted(glob.glob(os.path.join(ENV["SB"], ".multica", "godot-editor", "*.log")), key=os.path.getmtime)
    for cand in cands[-3:]:
        try:
            if "QA_CALLBACK_FIRED" in open(cand, encoding="utf-8", errors="replace").read():
                fired = True
                break
        except Exception:
            continue
check("G1f 运行期回调触发（QA_CALLBACK_FIRED 落日志）", fired)

# ---- G2: undo stack via real editor Ctrl+Z ----
print("== G2: undo 栈实机（Ctrl+Z / Ctrl+Y） ==")
an = call_tool("godot_node_edit", {"action": "add_node", "parent_path": ".",
                                   "node_type": "Label", "name": "QANodeUndo"})
if EDITOR_PID:
    send_keys("^z")
    time.sleep(1.0)
    tree_u = call_tool("godot_node_read", {"action": "get_scene_tree"})
    check("G2a Ctrl+Z undo → QANodeUndo 消失（真实编辑器 undo 栈）",
          "QANodeUndo" not in json.dumps(tree_u["parsed"] or {}))
    send_keys("^y")
    time.sleep(1.0)
    tree_r = call_tool("godot_node_read", {"action": "get_scene_tree"})
    check("G2b Ctrl+Y redo → QANodeUndo 回归", "QANodeUndo" in json.dumps(tree_r["parsed"] or {}))
else:
    print("  [skip] EDITOR_PID not provided")

# ---- G3: F1 gate ----
print("== G3: F1 update_node INSTANCED_SCENE gate ==")
with open(os.path.join(W, "qa_f1_child.tscn"), "w") as f:
    f.write("""[gd_scene format=3]

[node name="F1Child" type="Node2D"]

[node name="Inner" type="Label" parent="."]
text = "inner"
""")
with open(os.path.join(W, "qa_f1_host.tscn"), "w") as f:
    f.write("""[gd_scene load_steps=2 format=3]

[ext_resource type="PackedScene" path="res://qa_f1_child.tscn" id="1_child"]

[node name="F1Host" type="Node2D"]

[node name="Inst" parent="." instance=ExtResource("1_child")]
""")
o = call_tool("godot_scene", {"action": "open", "scene_path": "res://qa_f1_host.tscn"})
time.sleep(1.5)
r = call_tool("godot_node_edit", {"action": "update", "node_path": "Inst/Inner",
                                  "properties": {"text": "tampered"}})
joined = json.dumps(r.get("parsed") or "") + json.dumps(r.get("texts") or "")
check("G3a update 于 instanced 子场景子节点 → INSTANCED_SCENE 拒绝",
      "INSTANCED_SCENE" in joined and r.get("is_error"), joined[:240])
r2 = call_tool("godot_node_edit", {"action": "update", "node_path": "F1Host",
                                   "properties": {"position": {"x": 5}}})
check("G3b 控制: 直接子节点 update 不误拒", not r2.get("is_error"), str(r2.get("texts"))[:150])

# ---- S3: Script tab (interactive desktop via win_focus) ----
print("== S3: Script 态截图 ==")
if EDITOR_PID:
    send_keys("^{F3}")
    time.sleep(1.2)
    st4 = get_state()
    check("S3a Ctrl+F3 → main_screen=Script", st4.get("main_screen") == "Script",
          str(st4.get("main_screen")))
    s = call_tool("godot_editor_read", {"action": "screenshot_editor", "viewport": "2d", "max_width": 900})
    imgs = s["images"]
    if imgs:
        ok, raw = png_magic_ok(imgs[0]["data"])
        check("S3b Script 态 PNG magic", ok)
        if ok:
            p, n = save_png(imgs[0]["data"], "final_script.png")
            print(f"  [info] saved {p} ({n} bytes)")
    else:
        check("S3b Script 态 screenshot", 0, str(s.get("texts"))[:150])
else:
    print("  [skip] EDITOR_PID not provided")

# ---- L1: LOW1 half-schema → snapshot_absent ----
print("== L1: LOW1 half-schema snapshot_absent ==")
ps_file = os.path.join(ENV["SB"], ".multica", "godot-editor")
import glob as _glob
cands = _glob.glob(os.path.join(ps_file, "*.proxy-state.json"))
target = None
for cand in cands:
    try:
        doc = json.loads(open(cand).read())
        if doc.get("workdir_hash") is not None:
            target = cand
            break
    except Exception:
        continue
if target:
    doc = json.loads(open(target).read())
    doc.pop("worktree", None)
    open(target, "w").write(json.dumps(doc))
    r = call_tool("godot_project", {"action": "get_info"})
    half = None
    for t in r["texts"]:
        if "workdir_snapshot" in t:
            half = json.loads(t).get("workdir_snapshot")
            break
    check("L1a 半 schema 快照 → snapshot_absent（LOW1 收紧判定）",
          half and half.get("hash_source") == "snapshot_absent", str(half))
else:
    check("L1a 半 schema 快照 → snapshot_absent", 0, "no live snapshot found")

print(f"\nSUMMARY: PASS={PASS} FAIL={FAIL}")
sys.exit(0 if FAIL == 0 else 1)
