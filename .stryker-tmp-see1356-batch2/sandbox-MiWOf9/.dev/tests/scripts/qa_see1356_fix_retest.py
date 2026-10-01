#!/usr/bin/env python3
"""SEE-1356 D-NEW/F1 retest driver (fix e64d359).

  G1  connect_signal binary gate: connect → save → [connection] on disk →
      reload persistence → runtime callback fires (Timer 0.5s → marker print)
  G2  F1: update_node on instanced sub-scene child → INSTANCED_SCENE;
      control: normal direct child update still works (no false rejection)
  G3  spot checks: add_node reply contract, attach_script, screenshot 2D,
      get_info echo
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
OUTDIR = "/tmp/see1356-b2-qa-evidence"
os.makedirs(OUTDIR, exist_ok=True)
PWSH = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
EDITOR_PID = sys.argv[1] if len(sys.argv) > 1 else None

_id = 700


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


print("== G1: connect_signal binary gate (CONNECT_PERSIST 直写) ==")
scratch_rel = "res://qa_scratch_b2.tscn"
scratch_abs = os.path.join(W, "qa_scratch_b2.tscn")
with open(scratch_abs, "w") as f:
    f.write("""[gd_scene load_steps=2 format=3 uid="uid://cqab2scratch1"]

[ext_resource type="Script" path="res://qa_scratch_b2_root.gd" id="1_root"]

[node name="QARoot" type="Node2D"]
script = ExtResource("1_root")
""")
with open(os.path.join(W, "qa_scratch_b2_root.gd"), "w") as f:
    f.write("extends Node2D\nvar fired := 0\nfunc on_qa_timeout() -> void:\n\tfired += 1\n\tprint(\"QA_CALLBACK_FIRED_\", fired)\n")

o = call_tool("godot_scene", {"action": "open", "scene_path": scratch_rel})
check("G1 open scratch", not o.get("is_error"), str(o.get("texts"))[:150])
time.sleep(1.5)

a = call_tool("godot_node_edit", {"action": "add_node", "parent_path": ".",
                                  "node_type": "Timer", "name": "QA_Timer"})
reply = a["texts"][0] if a["texts"] else ""
check("G1a add_node QA_Timer (undo action 形态保留)", "Revert hint:" in reply and "(saved: false)" in reply, reply[:200])

u = call_tool("godot_node_edit", {"action": "update", "node_path": "QA_Timer",
                                  "properties": {"wait_time": 0.5, "autostart": True}})
check("G1b update wait_time/autostart ok", not u.get("is_error"), str(u.get("texts"))[:120])

c = call_tool("godot_node_edit", {"action": "connect_signal", "node_path": "QA_Timer",
                                  "signal": "timeout", "target_path": ".", "method": "on_qa_timeout"})
creply = c["texts"][0] if c["texts"] else ""
check("G1c connect_signal accepted (直写 CONNECT_PERSIST)", "Connected" in creply and "saved: false" in creply, creply[:200])

sv = call_tool("godot_scene", {"action": "save"})
check("G1d save ok", not sv.get("is_error"), str(sv.get("texts"))[:120])

disk = open(scratch_abs, encoding="utf-8").read()
check("G1e [connection] 段落盘（binary gate 核心判据）",
      '[connection signal="timeout" from="QA_Timer" to="." method="on_qa_timeout"]' in disk,
      "\n".join(l for l in disk.splitlines() if "connection" in l.lower()) or "NO CONNECTION SECTION")

# reload persistence
call_tool("godot_scene", {"action": "open", "scene_path": "res://scenes/ui/title_screen/title_screen.tscn"})
time.sleep(1.5)
call_tool("godot_scene", {"action": "open", "scene_path": scratch_rel})
time.sleep(2.0)
disk2 = open(scratch_abs, encoding="utf-8").read()
check("G1f reload 后 [connection] 仍在", '[connection signal="timeout"' in disk2)

# runtime callback: run the scene, wait 1.5s game time, stop; assert via the
# editor log tail — the child process stdout lands in the editor log stream
logs_before = call_tool("godot_editor_read", {"action": "get_log_messages"})
r = call_tool("godot_editor_edit", {"action": "run", "scene_path": scratch_rel})
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
    # fallback: stdout echo also lands in the editor log file the addon tails;
    # check via the proxy tee of the log-tail debug channel is not exposed, so
    # scan the editor log on disk through the QA worktree path
    try:
        edlog = None
        import glob
        cands = sorted(glob.glob(os.path.join(ENV["SB"], "home", ".multica", "godot-editor", "*.log")), key=os.path.getmtime)
        if cands:
            edlog = cands[-1]
        if edlog and "QA_CALLBACK_FIRED" in open(edlog, encoding="utf-8", errors="replace").read():
            fired = True
    except Exception:
        pass
check("G1g 运行期回调触发（QA_CALLBACK_FIRED 落日志）", fired)

print("== G2: F1 — update_node INSTANCED_SCENE gate ==")
inst_scene = "res://qa_f1_host.tscn"
inst_child = os.path.join(W, "qa_f1_child.tscn")
with open(inst_child, "w") as f:
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
o = call_tool("godot_scene", {"action": "open", "scene_path": inst_scene})
time.sleep(1.5)
r = call_tool("godot_node_edit", {"action": "update", "node_path": "Inst/Inner",
                                  "properties": {"text": "tampered"}}, expect_error=False)
joined = json.dumps(r.get("parsed") or "") + json.dumps(r.get("texts") or "")
check("G2a update 于 instanced 子场景子节点 → INSTANCED_SCENE 明确拒绝",
      ("INSTANCED_SCENE" in joined) and r.get("is_error"), joined[:240])
# 对抗控制：普通直接子节点 update 不被误拒
r2 = call_tool("godot_node_edit", {"action": "update", "node_path": "F1Host",
                                   "properties": {"position": {"x": 5}}}, expect_error=True)
check("G2b 控制: 直接子节点 update 不误拒", not r2.get("is_error"), str(r2.get("texts"))[:150])

print("== G3: spot checks (原 PASS 项抽核) ==")
g = call_tool("godot_project", {"action": "get_info"})
echo = None
for t in g["texts"]:
    if "workdir_snapshot" in t:
        echo = json.loads(t).get("workdir_snapshot")
        break
check("G3a get_info 快照回显", echo and echo.get("hash_source") == "slot", str(echo))
s = call_tool("godot_editor_read", {"action": "screenshot_editor", "viewport": "2d", "max_width": 900})
imgs = s["images"]
if imgs:
    import base64 as b64m
    raw = b64m.b64decode(imgs[0]["data"])
    check("G3b 2D screenshot PNG magic", raw[:8] == b"\x89PNG\r\n\x1a\n")
    with open(os.path.join(OUTDIR, "retest_2d.png"), "wb") as f:
        f.write(raw)
else:
    check("G3b 2D screenshot PNG magic", 0, "no image")

print(f"\nSUMMARY: PASS={PASS} FAIL={FAIL}")
sys.exit(0 if FAIL == 0 else 1)
