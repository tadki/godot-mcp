extends Node
class_name MCPQa

## SEE-1348 M3: godot_qa primitives executed in the running game — live-game
## oracle assertions for agent-driven QA, NOT a GUT replacement (GUT owns repo
## test suites; these drive the RUNNING game, freeze included). All four
## handlers are read-only observations: property reads, geometry reads, a
## one-shot signal listen, and a node-region frame crop. No game state is
## mutated. Node resolution reuses the sampler's resolver so qa paths and
## watch paths are interchangeable; wait_for_signal reuses the sampler's
## connection machinery (arity-matched lambda, guaranteed teardown).

const DEFAULT_SCREENSHOT_WIDTH := 640
const STR_RESULT_CAP := 200

var sampler: MCPRuntimeStateSampler = null

# wait_for_signal is a one-shot single slot: a second wait while one is live is
# answered with an error instead of silently stealing the first call's result
# (the response is keyed by msg_type in the editor plugin, so two live waits
# of the same type could not be told apart).
var _wait_pending := false
var _wait_pending_params: Dictionary = {}


func _ready() -> void:
	# Inherits PROCESS_MODE_ALWAYS from the bridge: waits resolve and screenshots
	# capture under a game-layer pause or a godot_game_time freeze.
	if sampler != null:
		sampler.qa_wait_finished.connect(_on_wait_finished)


func handle_assert_property(data: Array) -> void:
	var params: Dictionary = data[0] if data.size() > 0 and data[0] is Dictionary else {}
	_send("qa_assert_property", _assert_property(params), params)


func _assert_property(params: Dictionary) -> Dictionary:
	var path := str(params.get("path", ""))
	var prop := str(params.get("property", ""))
	var op := str(params.get("op", "approx"))
	var expected: Variant = params.get("expected")
	var tolerance := float(params.get("tolerance", 0.01))
	var node := _resolve_qa_node(path)
	if node == null:
		return {"error": "node_not_found: %s" % path}
	if prop.is_empty() or not (prop in node):
		return {"error": "property_not_found: %s on %s" % [prop, path]}
	var actual: Variant = node.get(prop)
	return {
		"path": path,
		"property": prop,
		"op": op,
		"expected": _sanitize(expected),
		"actual": _sanitize(actual),
		"passed": _compare(actual, expected, op, tolerance),
		"tolerance": tolerance,
	}


# `op` semantics: approx (default) = |a-b| <= tolerance for numbers/vectors,
# == for everything else; eq/ne = exact; gt/gte/lt/lte = numeric order only
# (false, not an error, for non-numeric operands — the caller reads actual).
func _compare(actual: Variant, expected: Variant, op: String, tolerance: float) -> bool:
	var a_num := actual is int or actual is float
	var e_num := expected is int or expected is float
	if a_num and e_num:
		var a := float(actual)
		var b := float(expected)
		match op:
			"approx":
				return absf(a - b) <= tolerance
			"eq":
				return a == b
			"ne":
				return a != b
			"gt":
				return a > b
			"gte":
				return a >= b
			"lt":
				return a < b
			"lte":
				return a <= b
			_:
				return false
	if actual is Vector2 and expected is Vector2:
		var d2: Vector2 = actual - expected
		return _vector_compare(d2.length(), op, tolerance)
	if actual is Vector3 and expected is Vector3:
		var d3: Vector3 = actual - expected
		return _vector_compare(d3.length(), op, tolerance)
	match op:
		"eq", "approx":
			return actual == expected
		"ne":
			return actual != expected
		_:
			return false


func _vector_compare(distance: float, op: String, tolerance: float) -> bool:
	match op:
		"approx", "eq":
			return distance <= tolerance
		"ne":
			return distance > tolerance
		_:
			return false


func handle_assert_layout(data: Array) -> void:
	var params: Dictionary = data[0] if data.size() > 0 and data[0] is Dictionary else {}
	_send("qa_assert_layout", _assert_layout(params), params)


func _assert_layout(params: Dictionary) -> Dictionary:
	var path := str(params.get("path", ""))
	var node := _resolve_qa_node(path)
	if node == null:
		return {"error": "node_not_found: %s" % path}
	var requested: Array = params.get("checks", [])
	if requested.is_empty():
		requested = [{"type": "visible"}, {"type": "onscreen"}]
	var checks: Array = []
	for raw in requested:
		if raw is Dictionary:
			checks.append(_run_layout_check(node, raw))
	var all_passed := true
	for c in checks:
		if not bool(c.get("passed", false)):
			all_passed = false
			break
	return {"path": path, "checks": checks, "passed": all_passed}


func _run_layout_check(node: Node, check: Dictionary) -> Dictionary:
	var type := str(check.get("type", ""))
	match type:
		"visible":
			if node is CanvasItem or node is Node3D:
				return {
					"type": type,
					"passed": node.is_visible_in_tree(),
					"actual": node.is_visible_in_tree()
				}
			return {
				"type": type, "passed": false, "error": "not_a_visual_node: %s" % node.get_class()
			}
		"onscreen":
			var rect := _qa_node_rect(node)
			if rect is Dictionary:
				return {"type": type, "passed": false, "error": rect["error"]}
			var visible := (
				(node.get_viewport() != null)
				and (node.get_viewport().get_visible_rect().intersects(rect))
			)
			return {
				"type": type,
				"passed": visible,
				"actual": _rect_dict(rect),
				"rect": _rect_dict(rect)
			}
		"within_parent":
			var rect := _qa_node_rect(node)
			if rect is Dictionary:
				return {"type": type, "passed": false, "error": rect["error"]}
			var parent := node.get_parent()
			if parent == null or not (parent is Control):
				return {
					"type": type,
					"passed": false,
					"error":
					"parent_not_control: %s" % (str(parent.get_class()) if parent else "none")
				}
			var tolerance := float(check.get("tolerance", 0.0))
			var inside: bool = (parent as Control).get_global_rect().grow(tolerance).encloses(rect)
			return {
				"type": type,
				"passed": inside,
				"rect": _rect_dict(rect),
				"parent_rect": _rect_dict((parent as Control).get_global_rect()),
				"tolerance": tolerance,
			}
		"min_size":
			if not (node is Control):
				return {
					"type": type, "passed": false, "error": "control_only: %s" % node.get_class()
				}
			var min_size := Vector2(float(check.get("min_w", 0.0)), float(check.get("min_h", 0.0)))
			var size: Vector2 = (node as Control).size
			return {
				"type": type,
				"passed": size.x >= min_size.x and size.y >= min_size.y,
				"actual": _vec2_dict(size)
			}
		_:
			return {"type": type, "passed": false, "error": "unknown_check_type: %s" % type}


# Global (canvas-space) rect of a visual node. Control: its global rect. Other
# Node2D CanvasItems: transformed get_rect() when the class defines one
# (Sprite2D &c.), else unavailable — the caller reports a typed error instead
# of a made-up zero-size rect.
func _qa_node_rect(node: Node) -> Variant:
	if node is Control:
		return (node as Control).get_global_rect()
	if node is Node2D and (node as Object).has_method("get_rect"):
		var n2d := node as Node2D
		return n2d.get_global_transform() * (n2d.call("get_rect") as Rect2)
	return {
		"error":
		"rect_unavailable: %s (needs a Control or a Node2D with get_rect)" % node.get_class()
	}


func handle_wait_for_signal(data: Array) -> void:
	var params: Dictionary = data[0] if data.size() > 0 and data[0] is Dictionary else {}
	if sampler == null:
		_send("qa_wait_for_signal", {"error": "sampler_not_initialized"}, params)
		return
	if _wait_pending:
		_send(
			"qa_wait_for_signal",
			{"error": "wait_already_pending: one wait_for_signal at a time"},
			params
		)
		return
	var start := sampler.start_signal_wait(
		str(params.get("path", "")),
		str(params.get("signal", "")),
		int(params.get("timeout_ms", 5000)),
		str(params.get("predicate", ""))
	)
	if start.has("error"):
		_send("qa_wait_for_signal", start, params)
		return
	_wait_pending = true
	_wait_pending_params = params.duplicate()
	# The sampler resolves (emitted:true or the wall-timeout emitted:false) and
	# qa_wait_finished carries the final result — the response is keyed by
	# msg_type, so nothing is sent here.


func _on_wait_finished(result: Dictionary) -> void:
	if not _wait_pending:
		return  # a stale wait from a torn-down call — nothing to answer
	_wait_pending = false
	var params := _wait_pending_params
	_wait_pending_params = {}
	_send("qa_wait_for_signal", result.duplicate(true), params)


func handle_screenshot_node(data: Array) -> void:
	var params: Dictionary = data[0] if data.size() > 0 and data[0] is Dictionary else {}
	# Deferred: the capture awaits RenderingServer.frame_post_draw and must not
	# run inside the debugger-message callback (same shape as take_screenshot).
	_screenshot_node_impl.call_deferred(params)


func _screenshot_node_impl(params: Dictionary) -> void:
	var path := str(params.get("path", ""))
	var node := _resolve_qa_node(path)
	if node == null:
		_send("qa_screenshot_node", {"error": "node_not_found: %s" % path}, params)
		return
	if not (node is CanvasItem):
		_send(
			"qa_screenshot_node",
			{
				"error":
				(
					"not_canvas_item: %s (%s) — screenshot_node supports 2D visual nodes"
					% [path, node.get_class()]
				)
			},
			params
		)
		return
	var rect: Variant = _qa_node_rect(node)
	if rect is Dictionary:
		_send("qa_screenshot_node", rect, params)
		return
	var canvas_rect: Rect2 = rect
	var vp := get_viewport()
	if vp == null:
		_send("qa_screenshot_node", {"error": "NO_VIEWPORT: could not get game viewport"}, params)
		return
	# Fresh rendered frame; frame_post_draw fires under a game-layer pause and a
	# godot_game_time freeze (the render loop never stops — SEE-1240 finding),
	# so node captures are frozen-safe like the full-frame screenshot.
	await RenderingServer.frame_post_draw
	var image := vp.get_texture().get_image()
	if image == null:
		_send(
			"qa_screenshot_node", {"error": "CAPTURE_FAILED: could not read viewport image"}, params
		)
		return
	# Canvas space -> window pixels, the same final-transform mapping the
	# absolute mouse entries use, so the crop lands on the same pixels a click
	# at that rect would.
	var window_rect: Rect2 = vp.get_final_transform() * canvas_rect
	var bounds := Rect2(Vector2.ZERO, Vector2(image.get_size()))
	var crop := window_rect.intersection(bounds)
	if crop.size.x < 1.0 or crop.size.y < 1.0:
		_send(
			"qa_screenshot_node",
			{"error": "node_offscreen: no on-screen pixels", "rect": _rect_dict(window_rect)},
			params
		)
		return
	var pos := Vector2i(crop.position.floor())
	var end := Vector2i((crop.position + crop.size).ceil())
	var cropped := image.get_region(Rect2i(pos, end - pos))
	var max_width := int(params.get("max_width", DEFAULT_SCREENSHOT_WIDTH))
	if max_width > 0 and cropped.get_width() > max_width:
		var scale_factor := float(max_width) / float(cropped.get_width())
		cropped.resize(
			max_width, int(cropped.get_height() * scale_factor), Image.INTERPOLATE_LANCZOS
		)
	_send(
		"qa_screenshot_node",
		{
			"image_base64": Marshalls.raw_to_base64(cropped.save_png_to_buffer()),
			"width": cropped.get_width(),
			"height": cropped.get_height(),
			"path": path,
			"rect": _rect_dict(window_rect),
			"clamped": crop != window_rect,
			"frozen": get_tree() != null and get_tree().paused,
		},
		params
	)


func _resolve_qa_node(path: String) -> Node:
	if sampler == null:
		return null
	return sampler.resolve_node(path)


func _send(msg_type: String, result: Dictionary, params: Dictionary) -> void:
	# Responses correlate by message type alone in the editor plugin; echo the
	# relay's call_id so a late response from a timed-out call is discarded by
	# the relay (see mcp_game_bridge _send_exec_response for the full rationale).
	var payload := result.duplicate(true)
	if params.has("call_id"):
		payload["call_id"] = params["call_id"]
	EngineDebugger.send_message("godot_mcp:game_response", [msg_type, payload])


func _sanitize(v: Variant) -> Variant:
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING, TYPE_STRING_NAME:
			return v
		_:
			return str(v).substr(0, STR_RESULT_CAP)


func _rect_dict(r: Rect2) -> Dictionary:
	return {
		"x": snappedf(r.position.x, 0.01),
		"y": snappedf(r.position.y, 0.01),
		"w": snappedf(r.size.x, 0.01),
		"h": snappedf(r.size.y, 0.01),
	}


func _vec2_dict(v: Vector2) -> Dictionary:
	return {"x": snappedf(v.x, 0.01), "y": snappedf(v.y, 0.01)}
