#!/usr/bin/env bash
# SEE-1356 batch-2 — .gd face harness (L3 capture normalization + L4 node
# write-command pure faces). The addon command classes carry their decision
# logic in EditorInterface-free static helpers, so the classification branches
# are probe-able by a headless Godot run — no editor, no game (the live
# editor three-step stays QA's lane).
#
# Face = a group of assertions inside the probe; the caller picks one via
# argv[1]: "capture" | "node_commands" | "all" (default all). The probe prints
#   FACE <group> PASS|FAIL <detail>
#   FACES_SUMMARY PASS=<n> FAIL=<m>
# and this harness prints the batch-1 contract line `FAIL=0` on success.
#
# The tmp project gets FRESH COPIES of core/ + commands/ on every run, so the
# face always exercises the current tree (no fixture drift). The one-time
# `--import` pass only feeds the throwaway project's global class cache so
# class_name resolution (L4 stage-2 instantiation) is reachable headless.
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FACE="${1:-all}"

case "$FACE" in
	capture | node_commands | all) ;;
	*)
		echo "usage: $0 [capture|node_commands|all]" >&2
		exit 2
		;;
esac

if ! command -v godot >/dev/null 2>&1; then
	echo "godot binary not found on PATH (headless probe lane)" >&2
	exit 2
fi

TMP="$(mktemp -d)"
# The headless import may leave root-owned .godot entries behind on some
# setups — best-effort cleanup, never a harness failure. On a FAILED run the
# tmp dir is kept (path printed) so faces.log stays inspectable.
cleanup() {
	if [ "${FACE_HARNESS_FAILED:-0}" = "1" ]; then
		echo "kept tmp for inspection: $TMP" >&2
	else
		rm -rf "$TMP" 2>/dev/null || true
	fi
}
trap cleanup EXIT

cat >"$TMP/project.godot" <<'EOF'
config_version=5

[application]
config/name="see1356-gd-faces"

[debug]
gdscript/warnings/untyped_declaration=0
gdscript/warnings/inference_on_variant=0
EOF

cp -r "$REPO/core" "$REPO/commands" "$TMP/"

# L4 stage-2 fixtures: a class_name NODE script and a class_name NON-Node
# script, so the global-class-list lookup and its not-a-Node rejection are
# both exercisable (the --import pass registers them).
cat >"$TMP/probe_script_class.gd" <<'EOF'
class_name ProbeScriptClass
extends Node2D

@export var speed: float = 300.0
EOF

cat >"$TMP/probe_resource_class.gd" <<'EOF'
class_name ProbeResourceClass
extends Resource
EOF

cat >"$TMP/face_probe.gd" <<'EOF'
extends SceneTree

# SEE-1356 batch-2 .gd face probe. Pure faces only — everything reachable
# without an editor. Editor-coupled behavior (undo/redo wiring, owner
# persistence, connection persistence) is the QA lane's editor three-step.

var passes := 0
var failures := 0


func check(group: String, cond: bool, detail: String) -> void:
	if cond:
		passes += 1
		print("FACE %s PASS %s" % [group, detail])
	else:
		failures += 1
		print("FACE %s FAIL %s" % [group, detail])


func _init() -> void:
	# Face selector rides the command line as a user arg (after `--`), NOT the
	# environment: the local godot is a WSL wrapper around the Windows engine
	# binary, and custom env vars do not cross that boundary.
	var face := "all"
	var user_args := OS.get_cmdline_user_args()
	if user_args.size() > 0:
		face = user_args[0]
	var screenshot: GDScript = load("res://commands/screenshot_commands.gd")
	var node: GDScript = load("res://commands/node_commands.gd")
	if face == "capture" or face == "all":
		_run_capture(screenshot)
	if face == "node_commands" or face == "all":
		_run_node(node, screenshot)
	print("FACES_SUMMARY PASS=%d FAIL=%d" % [passes, failures])
	quit(0 if failures == 0 else 1)


func _run_capture(SC: GDScript) -> void:
	# C1 — null image → CAPTURE_FAILED + detail empty_viewport.
	var r: Dictionary = SC.process_and_encode_image(null, 0)
	check("empty_viewport", r.get("status") == "error" and r["error"]["code"] == "CAPTURE_FAILED" \
		and r["error"].get("detail", "") == "empty_viewport", "null image classification")

	# C2 — already-RGBA8 2D-style image passes through untouched: success,
	# non-empty payload, unified schema (incl. captured_at_ms), decodes to RGBA8.
	var rgba: Image = Image.create(8, 6, false, Image.Format.FORMAT_RGBA8)
	rgba.fill(Color(1, 0, 0, 1))
	r = SC.process_and_encode_image(rgba, 0)
	var payload: Dictionary = r.get("result", {})
	var decoded: Image = Image.new()
	if r.get("status") == "success":
		decoded.load_png_from_buffer(Marshalls.base64_to_raw(payload["image_base64"]))
	check("rgba8_passthrough", r.get("status") == "success" \
		and payload["image_base64"] != "" \
		and int(payload.get("captured_at_ms", 0)) > 1600000000000 \
		and decoded.get_format() == Image.Format.FORMAT_RGBA8, "RGBA8 in → RGBA8 PNG out, unified schema")

	# C3 — non-8-bit (RGBH, the HDR-viewport form) is converted to RGBA8.
	var hdr: Image = Image.create(4, 4, false, Image.Format.FORMAT_RGBH)
	check("rgbh_input_is_16bit", hdr.get_format() == Image.Format.FORMAT_RGBH, "fixture is non-8-bit")
	r = SC.process_and_encode_image(hdr, 0)
	decoded = Image.new()
	if r.get("status") == "success":
		decoded.load_png_from_buffer(Marshalls.base64_to_raw(r["result"]["image_base64"]))
	check("rgbh_converted_to_rgba8", r.get("status") == "success" \
		and decoded.get_format() == Image.Format.FORMAT_RGBA8, "RGBH in → RGBA8 PNG out")

	# C4 — compressed (VRAM) texture: convert() cannot normalize it, so the
	# honest classification is unsupported_format, not an empty-buffer misread.
	var compressed: Image = Image.create(8, 6, false, Image.Format.FORMAT_RGBA8)
	compressed.compress(Image.COMPRESS_S3TC, Image.COMPRESS_SOURCE_GENERIC)
	r = SC.process_and_encode_image(compressed, 0)
	check("unsupported_format", r.get("status") == "error" \
		and r["error"].get("detail", "") == "unsupported_format", "compressed texture classification")

	# C5 — encode failure (zero-data image) → empty_buffer_after_convert,
	# the SEE-1327 root-cause guard.
	var broken: Image = Image.create(0, 0, false, Image.Format.FORMAT_RGBA8)
	r = SC.process_and_encode_image(broken, 0)
	check("empty_buffer_after_convert", r.get("status") == "error" \
		and r["error"].get("detail", "") == "empty_buffer_after_convert", "empty PNG buffer guard")

	# C6 — max_width downsize still works on the normalized path.
	var wide: Image = Image.create(8, 6, false, Image.Format.FORMAT_RGBA8)
	r = SC.process_and_encode_image(wide, 4)
	check("max_width_downsize", r.get("status") == "success" \
		and int(r["result"]["width"]) == 4 and int(r["result"]["height"]) == 3, "resize after normalization")

	# C7 — the dual-track registration face: both capture commands registered.
	var cmds: Array = SC.new().get_commands().keys()
	check("capture_registration", cmds.has("capture_game_screenshot") and cmds.has("capture_editor_screenshot"),
		"capture command registry")


func _run_node(NC: GDScript, _SC: GDScript) -> void:
	# N1 — the write-command registry (SSOT get_commands): six commands live;
	# connect_signal is SHELVED (SEE-1356 终裁: binary gate unproven) and must
	# NOT be registered until the three-step gate is proven on a stable session.
	var cmds: Array = NC.new().get_commands().keys()
	check("node_registration", cmds.has("add_node") and cmds.has("attach_script") \
		and cmds.has("update_node") and cmds.has("reparent_node") \
		and cmds.has("get_node_properties") and cmds.has("find_nodes"),
		"node command registry (connect_signal shelved)")
	check("connect_signal_shelved", not cmds.has("connect_signal"),
		"connect_signal absent from the registry (SEE-1356 终裁搁置)")

	# N2 — UNKNOWN_TYPE: neither an engine class nor a class_name script;
	# also an engine class that is NOT a Node must not instantiate.
	check("unknown_type", NC.instantiate_node_type("DefinitelyNotAClass") == null \
		and NC.instantiate_node_type("Resource") == null, "UNKNOWN_TYPE classification")

	# N3 — engine classes instantiate through ClassDB.
	var n2d: Node = NC.instantiate_node_type("Node2D")
	var lbl: Node = NC.instantiate_node_type("Label")
	check("engine_class_instantiation", n2d is Node2D and lbl is Label, "ClassDB stage")

	# N4 — class_name script class via the global class list; a script whose
	# base is not a Node classifies as UNKNOWN_TYPE.
	var scripted: Node = NC.instantiate_node_type("ProbeScriptClass")
	check("script_class_instantiation", scripted is Node2D and scripted != null \
		and scripted.get("speed") != null, "global_class_list stage")
	check("script_class_not_node_rejected", NC.instantiate_node_type("ProbeResourceClass") == null,
		"non-Node script class → UNKNOWN_TYPE")

	# N5 — instanced sub-scene detection: only nodes owned by a DIFFERENT
	# root are un-writable from the edited scene.
	var scene_root: Node2D = Node2D.new()
	var owned: Node2D = Node2D.new()
	scene_root.add_child(owned)
	owned.owner = scene_root
	var sub_root: Node2D = Node2D.new()
	owned.add_child(sub_root)
	sub_root.owner = sub_root
	check("instanced_scene_detection", not NC.is_instanced_scene_node(scene_root, scene_root) \
		and not NC.is_instanced_scene_node(owned, scene_root) \
		and NC.is_instanced_scene_node(sub_root, scene_root), "instanced sub-scene classifier")

	# N6 — node name validation boundary (the five forbidden characters).
	var handler: RefCounted = NC.new()
	check("node_name_validation", handler._validated_node_name("bad/name").get("status") == "error" \
		and handler._validated_node_name("bad:name").get("status") == "error" \
		and handler._validated_node_name("ok_name").is_empty(), "name boundary rejects . : @ / \"")

	# N7 — post-attach property snapshot carries script variables.
	var snapshot: Dictionary = NC.snapshot_script_properties(scripted)
	check("property_snapshot", snapshot.has("speed") and snapshot["speed"] == 300.0, "script variable snapshot")

	# N8 — the error envelope: detail is a real optional field, absent when
	# empty (existing CAPTURE_FAILED consumption surface unchanged).
	var with_detail: Dictionary = MCPUtils.error("CAPTURE_FAILED", "m", "empty_viewport")
	var without_detail: Dictionary = MCPUtils.error("GAME_ERROR", "m")
	check("error_envelope_detail", with_detail["error"].get("detail", "") == "empty_viewport" \
		and not without_detail["error"].has("detail"), "optional detail field shape")

	# N9 — D-NEW connect_signal retained-body contract (shelved SEE-1356 终裁:
	# body kept for re-enable after the three-step gate is proven). The source
	# shape pins hold on the retained body: `node.connect(..., CONNECT_PERSIST)`
	# (serializer-visible) and NO undo action (the provably-non-persisting
	# form) — so a future re-enable cannot silently regress to it.
	var node_src: String = FileAccess.get_file_as_string("res://commands/node_commands.gd")
	var cs_body := node_src.substr(node_src.find("func connect_signal"), \
		node_src.find("func reparent_node") - node_src.find("func connect_signal"))
	check("connect_signal_direct_persist", cs_body.contains("node.connect(signal_name, callable, CONNECT_PERSIST)"),
		"connect() carries CONNECT_PERSIST (serializer-visible)")
	check("connect_signal_no_undo_action", not cs_body.contains("create_action") and not cs_body.contains("commit_action"),
		"undo action removed from connect_signal (D-NEW ruling)")

	# N10 — F1 update_node gate wiring (批 2 QA MEDIUM): the gate call must sit
	# in update_node's body, edited-scene-scoped. Source-shape pin for the
	# omission defect; the live INSTANCED_SCENE rejection is the QA lane.
	var un_body := node_src.substr(node_src.find("func update_node"), \
		node_src.find("func add_node") - node_src.find("func update_node"))
	check("update_node_instanced_gate_wired", un_body.contains("_reject_instanced_scene_writer(node, scene_root)") \
		and un_body.contains("scene_root.is_ancestor_of(node)"),
		"update_node carries the edited-scene-scoped INSTANCED_SCENE gate")
EOF

timeout 180 godot --headless --path "$TMP" --import >/dev/null 2>&1
LOG="$TMP/faces.log"
timeout 120 godot --headless --path "$TMP" -s res://face_probe.gd -- "$FACE" >"$LOG" 2>&1
rc=$?

grep -E "^FACE |^FACES_SUMMARY" "$LOG"
FAILS="$(grep -c '^FACE .* FAIL' "$LOG" || true)"
RUNS="$(grep -c '^FACE ' "$LOG" || true)"
if [ "$rc" -ne 0 ] || [ "$FAILS" -ne 0 ] || [ "$RUNS" -eq 0 ]; then
	export FACE_HARNESS_FAILED=1
	echo "FAIL=$FAILS rc=$rc runs=$RUNS (see $LOG)"
	exit 1
fi
echo "FAIL=0"
exit 0
