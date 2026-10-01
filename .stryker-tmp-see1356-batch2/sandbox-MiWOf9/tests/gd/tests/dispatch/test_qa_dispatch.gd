extends GutTest

## SEE-1348 §SPEC-016 dispatch/send-leg coverage (mcp_qa.gd handle_* + screenshot
## prelude). Runs under COVERAGE only (full -gdir=res://tests/); mutation runs target
## tests/logic (take_over + SpyQa-extends re-parse under mutant impl would hang GUT —
## documented in the §SPEC-016 report).
## SpyQa: stubs the EngineDebugger-gated _send (headless has no debugger session);
## logic inherited unchanged.

const SamplerScript = preload("res://game_bridge/mcp_runtime_state_sampler.gd")

class SpyQa:
	extends "res://game_bridge/mcp_qa.gd"
	var sent: Array = []
	func _send(msg_type: String, result: Dictionary, params: Dictionary) -> void:
		var payload := result.duplicate(true)
		if params.has("call_id"):
			payload["call_id"] = params["call_id"]
		sent.append([msg_type, payload])

var qa: Node = null
var sampler: Node = null

func before_each() -> void:
	sampler = SamplerScript.new()
	qa = SpyQa.new()
	qa.sampler = sampler
	get_tree().root.add_child(sampler)
	get_tree().root.add_child(qa)

func after_each() -> void:
	if is_instance_valid(qa):
		qa.queue_free()
	if is_instance_valid(sampler):
		sampler.queue_free()
	for i in range(4):
		await get_tree().process_frame

func test_handle_assert_property_dispatch() -> void:
	var n := Control.new()
	n.name = "DH1"
	n.visible = true
	get_tree().root.add_child(n)
	qa.handle_assert_property([{"path": str(n.get_path()), "property": "visible", "op": "eq", "expected": true, "call_id": 3}])
	var sent: Dictionary = (qa.sent as Array)[0][1]
	assert_true(sent.get("passed") == true)
	assert_true(int(sent.get("call_id")) == 3)
	qa.handle_assert_property([{"path": "/missing", "property": "x", "expected": 1, "call_id": 4}])
	assert_string_contains(str((qa.sent as Array)[1][1].get("error")), "node_not_found")
	qa.handle_assert_property([{"path": str(n.get_path()), "property": "nope", "expected": 1}])
	assert_string_contains(str((qa.sent as Array)[2][1].get("error")), "property_not_found")
	n.queue_free()
	for e in get_errors():
		e.handled = true

func test_handle_assert_layout_dispatch() -> void:
	var n := Control.new()
	n.name = "DH2"
	n.size = Vector2(50, 50)
	get_tree().root.add_child(n)
	qa.handle_assert_layout([{"path": str(n.get_path()), "checks": [{"type": "visible"}], "call_id": 6}])
	assert_true((qa.sent as Array)[0][1].get("passed") == true)
	qa.handle_assert_layout([{"path": "/missing", "call_id": 7}])
	assert_string_contains(str((qa.sent as Array)[1][1].get("error")), "node_not_found")
	n.queue_free()
	for e in get_errors():
		e.handled = true

func test_handle_wait_for_signal_dispatch() -> void:
	qa.handle_wait_for_signal([{"path": "/missing", "signal": "x", "call_id": 9}])
	assert_string_contains(str((qa.sent as Array)[0][1].get("error")), "node_not_found")
	# sampler-null arm
	qa.sampler = null
	qa.handle_wait_for_signal([{"path": "/root", "signal": "x"}])
	assert_string_contains(str((qa.sent as Array)[1][1].get("error")), "sampler_not_initialized")
	for e in get_errors():
		e.handled = true

func test_handle_wait_already_pending_dispatch() -> void:
	qa._wait_pending = true
	qa.handle_wait_for_signal([{"path": "/missing", "signal": "x", "call_id": 5}])
	assert_string_contains(str((qa.sent as Array)[0][1].get("error")), "wait_already_pending")
	assert_true(int((qa.sent[0][1] as Dictionary).get("call_id")) == 5)
	qa._wait_pending = false
	for e in get_errors():
		e.handled = true

func test_screenshot_node_dispatch_arms() -> void:
	qa.handle_screenshot_node([{"path": "/missing", "call_id": 11}])
	await get_tree().process_frame
	await get_tree().process_frame
	assert_string_contains(str((qa.sent as Array)[0][1].get("error")), "node_not_found")
	# non-CanvasItem arm
	var plain := Node.new()
	plain.name = "DHS1"
	get_tree().root.add_child(plain)
	qa.handle_screenshot_node([{"path": str(plain.get_path()), "call_id": 12}])
	await get_tree().process_frame
	await get_tree().process_frame
	assert_string_contains(str((qa.sent as Array)[1][1].get("error")), "not_canvas_item")
	# rect_unavailable arm (Node2D without get_rect)
	var n2 := Node2D.new()
	n2.name = "DHS2"
	get_tree().root.add_child(n2)
	qa.handle_screenshot_node([{"path": str(n2.get_path()), "call_id": 13}])
	await get_tree().process_frame
	await get_tree().process_frame
	assert_string_contains(str((qa.sent as Array)[2][1].get("error")), "rect_unavailable")
	plain.queue_free()
	n2.queue_free()
	for e in get_errors():
		e.handled = true

func test_handle_assert_property_empty_data() -> void:
	# data[0] ternary + default params: empty data → {} params → node_not_found
	qa.handle_assert_property([])
	assert_string_contains(str((qa.sent as Array)[0][1].get("error")), "node_not_found")
	qa.handle_assert_layout([])
	assert_string_contains(str((qa.sent as Array)[1][1].get("error")), "node_not_found")
	for e in get_errors():
		e.handled = true

# ── SEE-1348 r26 survivor kill tests (l31 ×3 + l36 ×13 + l47 ×2) ────────────

func test_ready_connects_wait_funnel() -> void:
	# kills l31 ROR !=→==/</> : _ready's connect must fire when sampler is present.
	# Observable: a pending wait is consumed when sampler emits qa_wait_finished.
	qa._wait_pending = true
	sampler.qa_wait_finished.emit({"emitted": false})
	await get_tree().process_frame
	await get_tree().process_frame
	assert_false(qa._wait_pending, "sampler signal must reach qa funnel via _ready connect")

func test_handle_wait_param_extraction_empty_data() -> void:
	# kills l36 boundary 0→-1 / TERNARY if→if not / LOGICAL and→or : empty data must
	# yield {} params → node_not_found, never data[0] index error
	qa.handle_wait_for_signal([])
	await get_tree().process_frame
	await get_tree().process_frame
	assert_string_contains(str((qa.sent as Array)[0][1].get("error")), "node_not_found")

func test_handle_wait_param_extraction_non_dict() -> void:
	# kills l36 LOGICAL and→or / ROR >→== / >→<= / >→>= : size>0 but non-Dictionary
	# must fall to {} params → node_not_found
	qa.handle_wait_for_signal(["not-a-dict"])
	await get_tree().process_frame
	await get_tree().process_frame
	assert_string_contains(str((qa.sent as Array)[0][1].get("error")), "node_not_found")

func test_handle_assert_property_param_extraction_valid() -> void:
	# kills l36 boundary 0→1 / TERNARY swap : size-1 valid dict must flow through
	var n := Control.new()
	n.name = "PX1"
	n.visible = true
	get_tree().root.add_child(n)
	qa.handle_assert_property([{"path": str(n.get_path()), "property": "visible", "op": "eq", "expected": true}])
	await get_tree().process_frame
	await get_tree().process_frame
	var sent: Dictionary = (qa.sent as Array)[0][1]
	assert_true(sent.get("passed") == true, "valid size-1 dict must reach the comparator")
	n.queue_free()

func test_handle_assert_layout_param_extraction_valid() -> void:
	# kills l36 boundary 0→1 for the layout handler
	var n := Control.new()
	n.name = "PX2"
	n.size = Vector2(50, 50)
	get_tree().root.add_child(n)
	qa.handle_assert_layout([{"path": str(n.get_path()), "checks": [{"type": "visible"}]}])
	await get_tree().process_frame
	await get_tree().process_frame
	var sent: Dictionary = (qa.sent as Array)[0][1]
	assert_true(sent.get("passed") == true, "valid size-1 dict must reach layout checks")

func test_assert_property_null_guard_symmetry() -> void:
	# kills l47 ROR ==→<= / →>= : the null guard must produce a clean error payload
	# for a resolvable node path under all comparison mutations
	var n := Control.new()
	n.name = "NG1"
	n.visible = true
	get_tree().root.add_child(n)
	var r: Dictionary = qa._assert_property({"path": str(n.get_path()), "property": "visible", "expected": true})
	assert_true(r.get("passed") == true, "resolvable node reads normally under guard mutations")
	n.queue_free()

func test_screenshot_param_extraction_empty_data() -> void:
	# kills l36 for the screenshot handler: empty data → node_not_found
	qa.handle_screenshot_node([])
	await get_tree().process_frame
	await get_tree().process_frame
	assert_string_contains(str((qa.sent as Array)[0][1].get("error")), "node_not_found")
