#!/usr/bin/env python3
"""SEE-1356 方案A QA driver — editor_undo/editor_redo + set_main_screen (aaf2fd4).
Full godot-mcp lib + full KOL checkout host runtime (see-qa6 slot).
Pure JSON-RPC driving — zero OS key injection.
Scenarios (test-plan-see1356-scheme-a.md):
  P0  precondition (runtime alive, snapshot echo)
  U0  fresh scratch scene: editor_undo on empty history -> EMPTY_HISTORY
      (also proves the new command is live; "unknown command" would abort)
  U1-U2 add QAU1/QAU2 (join undo stack)
  U3-U4 editor_undo x2 -> tree: QAU2 gone, then both gone (cursor signals)
  U5  editor_undo on empty stack -> EMPTY_HISTORY
  U6-U7 editor_redo x2 -> tree: QAU1 back, then both back
  U8  editor_redo on empty stack -> EMPTY_HISTORY
  S1  set_main_screen Script -> response + get_state witness
  S2  screenshot_editor in Script state -> PNG magic, save for eyeball
  S3  set_main_screen invalid "Foo" -> schema rejection (is_error)
  S4  set_main_screen 2D back -> response + get_state witness
  S5  L3 2D spot: screenshot_editor PNG magic
  R1  L4-01 spot: add_node envelope (saved/save_hint/Revert hint)
"""
import base64
import json
import os
import re
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
OUTDIR = "/tmp/see1356-scheme-a"
os.makedirs(OUTDIR, exist_ok=True)

_id = 2000


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


def tree_has(name):
    t = call_tool("godot_node_read", {"action": "get_scene_tree"})
    return name in json.dumps(t["parsed"] or {})


HISTORY_RE = re.compile(
    r"(Undid|Redid) one action \(next: (.*?); has_undo: (true|false), has_redo: (true|false)\)")


def history_call(action):
    r = call_tool("godot_node_edit", {"action": action})
    text = r["texts"][0] if r["texts"] else ""
    m = HISTORY_RE.search(text)
    signals = None
    if m:
        signals = {"op_word": m.group(1), "next": m.group(2),
                   "has_undo": m.group(3) == "true", "has_redo": m.group(4) == "true"}
    return r, text, signals


def get_main_screen():
    st = (call_tool("godot_editor_read", {"action": "get_state"})["parsed"]) or {}
    return st.get("main_screen")


def png_magic_ok(b64):
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return False, None
    return raw[:8] == b"\x89PNG\r\n\x1a\n", raw


# ---- P0: precondition ----
print("== P0: precondition ==")
g = call_tool("godot_project", {"action": "get_info"})
echo = None
for t in g["texts"]:
    if "workdir_snapshot" in t:
        echo = json.loads(t).get("workdir_snapshot")
        break
check("P0 runtime alive + snapshot echo", echo is not None and echo.get("hash_source") in ("slot", "path"), str(echo))

# ---- U0: fresh scene, empty undo history -> EMPTY_HISTORY ----
print("== U0: fresh scratch scene ==")
scratch_rel = "res://qa_scheme_a.tscn"
scratch_abs = os.path.join(W, "qa_scheme_a.tscn")
with open(scratch_abs, "w") as f:
    f.write('[gd_scene format=3]\n\n[node name="QASchemeA" type="Node2D"]\n')
o = call_tool("godot_scene", {"action": "open", "scene_path": scratch_rel})
check("U0 open scratch scene", not o.get("is_error"), str(o.get("texts"))[:150])
time.sleep(1.0)

r0, t0, s0 = history_call("editor_undo")
check("U0 empty undo history -> EMPTY_HISTORY (new command live)",
      r0.get("is_error") and "EMPTY_HISTORY" in t0, t0[:200])

# ---- U1/U2: add two nodes ----
print("== U1/U2: add QAU1/QAU2 ==")
a1 = call_tool("godot_node_edit", {"action": "add_node", "parent_path": ".",
                                   "node_type": "Label", "name": "QAU1"})
check("U1 add QAU1", not a1.get("is_error"), str(a1.get("texts"))[:150])
check("U1b QAU1 in tree", tree_has("QAU1"))
a2 = call_tool("godot_node_edit", {"action": "add_node", "parent_path": ".",
                                   "node_type": "Sprite2D", "name": "QAU2"})
check("U2 add QAU2", not a2.get("is_error"), str(a2.get("texts"))[:150])
check("U2b QAU2 in tree", tree_has("QAU2"))

# ---- U3: undo #1 -> QAU2 gone only ----
print("== U3-U5: undo chain ==")
r3, t3, s3 = history_call("editor_undo")
check("U3 undo #1 response (Undid)", s3 is not None and s3["op_word"] == "Undid", t3[:200])
check("U3b cursor: has_undo=true, has_redo=true",
      s3 is not None and s3["has_undo"] and s3["has_redo"], t3[:200])
check("U3c next mentions MCP add_node", s3 is not None and "MCP add_node" in s3["next"], t3[:200])
check("U3d QAU2 gone from tree", not tree_has("QAU2"))
check("U3e QAU1 still in tree", tree_has("QAU1"))

# ---- U4: undo #2 -> both gone ----
r4, t4, s4 = history_call("editor_undo")
check("U4 undo #2 response (Undid)", s4 is not None and s4["op_word"] == "Undid", t4[:200])
check("U4b cursor: has_undo=false, has_redo=true",
      s4 is not None and (not s4["has_undo"]) and s4["has_redo"], t4[:200])
check("U4c both nodes gone from tree", not tree_has("QAU1") and not tree_has("QAU2"))

# ---- U5: undo on empty -> EMPTY_HISTORY ----
r5, t5, s5 = history_call("editor_undo")
check("U5 undo on empty stack -> EMPTY_HISTORY", r5.get("is_error") and "EMPTY_HISTORY" in t5, t5[:200])

# ---- U6: redo #1 -> QAU1 back ----
print("== U6-U8: redo chain ==")
r6, t6, s6 = history_call("editor_redo")
check("U6 redo #1 response (Redid)", s6 is not None and s6["op_word"] == "Redid", t6[:200])
check("U6b cursor: has_undo=true, has_redo=true",
      s6 is not None and s6["has_undo"] and s6["has_redo"], t6[:200])
check("U6c QAU1 back in tree", tree_has("QAU1"))
check("U6d QAU2 still gone", not tree_has("QAU2"))

# ---- U7: redo #2 -> both back ----
r7, t7, s7 = history_call("editor_redo")
check("U7 redo #2 response (Redid)", s7 is not None and s7["op_word"] == "Redid", t7[:200])
check("U7b cursor: has_undo=true, has_redo=false",
      s7 is not None and s7["has_undo"] and (not s7["has_redo"]), t7[:200])
check("U7c both nodes back in tree", tree_has("QAU1") and tree_has("QAU2"))

# ---- U8: redo on empty -> EMPTY_HISTORY ----
r8, t8, s8 = history_call("editor_redo")
check("U8 redo on empty stack -> EMPTY_HISTORY", r8.get("is_error") and "EMPTY_HISTORY" in t8, t8[:200])

# ---- S1: set_main_screen Script ----
print("== S1-S2: Script main screen ==")
ms_before = get_main_screen()
sw = call_tool("godot_editor_edit", {"action": "set_main_screen", "screen": "Script"})
sw_text = sw["texts"][0] if sw["texts"] else ""
check("S1 set_main_screen Script response", not sw.get("is_error") and "Main screen switched to: Script" in sw_text, sw_text[:200])
time.sleep(1.0)
check("S1b get_state witness main_screen==Script", get_main_screen() == "Script", f"before={ms_before} after={get_main_screen()}")

# ---- S2: screenshot in Script state ----
s2 = call_tool("godot_editor_read", {"action": "screenshot_editor", "viewport": "2d", "max_width": 900})
imgs = s2["images"]
check("S2 screenshot returns image", len(imgs) == 1, str(s2.get("texts"))[:150])
if imgs:
    ok, raw = png_magic_ok(imgs[0]["data"])
    check("S2b PNG magic", ok)
    if ok:
        p = os.path.join(OUTDIR, "script_main_screen.png")
        with open(p, "wb") as f:
            f.write(raw)
        print(f"  [info] saved {p} ({len(raw)} bytes)")

# ---- S3: invalid screen -> schema rejection ----
print("== S3-S4: invalid + switch back ==")
bad = call_tool("godot_editor_edit", {"action": "set_main_screen", "screen": "Foo"})
check("S3 invalid screen -> schema rejection (is_error)", bad.get("is_error"), str(bad.get("texts"))[:200])

# ---- S4: switch back to 2D ----
sb = call_tool("godot_editor_edit", {"action": "set_main_screen", "screen": "2D"})
sb_text = sb["texts"][0] if sb["texts"] else ""
check("S4 set_main_screen 2D response", not sb.get("is_error") and "Main screen switched to: 2D" in sb_text, sb_text[:200])
time.sleep(1.0)
check("S4b get_state witness main_screen==2D", get_main_screen() == "2D")

# ---- S5: L3 2D spot ----
print("== S5/R1: spot checks ==")
s5 = call_tool("godot_editor_read", {"action": "screenshot_editor", "viewport": "2d", "max_width": 900})
ok5 = False
if s5["images"]:
    ok5, _ = png_magic_ok(s5["images"][0]["data"])
check("S5 L3 2D screenshot PNG magic (spot)", ok5)

# ---- R1: L4-01 add_node envelope spot ----
r1 = call_tool("godot_node_edit", {"action": "add_node", "parent_path": ".",
                                   "node_type": "Node2D", "name": "QAR1"})
r1_text = r1["texts"][0] if r1["texts"] else ""
check("R1 add_node envelope (saved/persist guidance/Revert hint)",
      not r1.get("is_error") and "saved:" in r1_text and "persist" in r1_text and "Revert hint:" in r1_text,
      r1_text[:240])
check("R1b QAR1 in tree", tree_has("QAR1"))
# leave scene clean for reruns
history_call("editor_undo")

print(f"\nSUMMARY: PASS={PASS} FAIL={FAIL}")
sys.exit(0 if FAIL == 0 else 1)
