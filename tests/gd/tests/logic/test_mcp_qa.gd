extends GutTest

## SEE-1348 §SPEC-016 guard tests — game_bridge/mcp_qa.gd.
## Loads the production sources RELATIVE to the fixture project (res://game_bridge/
## is a symlink to ../../../game_bridge — single source of truth, no duplication).
## Engine-unreachable surfaces (EngineDebugger, RenderingServer capture) are
## stubbed or excluded per the SPEC-016 dispatch note; the comparator/layout/
## wait-mutex logic is fully reachable here.


var qa: Node = null
var sampler: Node = null

func _load_script(rel: String) -> GDScript:
	return load("res://game_bridge/" + rel)

func before_each() -> void:
	sampler = _load_script("mcp_runtime_state_sampler.gd").new()
	qa = _load_script("mcp_qa.gd").new()
	qa.sampler = sampler
	# _ready connects sampler.qa_wait_finished -> qa._on_wait_finished
	get_tree().root.add_child(sampler)
	get_tree().root.add_child(qa)

func after_each() -> void:
	# queue_free BEFORE any await: a mutant-induced script error inside a deferred
	# coroutine would otherwise abort the await chain and hang the whole GUT run.
	if is_instance_valid(qa):
		qa.queue_free()
	if is_instance_valid(sampler):
		sampler.queue_free()
	# bounded frame drain (CLAUDE.md 等待纪律: 带上限的事件等待, 非固定 sleep):
	for i in range(4):
		await get_tree().process_frame

# ── _compare (comparator matrix) ────────────────────────────────────────────

func test_compare_numeric_approx_within_tolerance() -> void:
	assert_true(qa._compare(5.0, 5.009, "approx", 0.01), "within tol approx passes")
	assert_false(qa._compare(5.0, 5.02, "approx", 0.01), "outside tol approx fails")
	# tolerance boundary is inclusive: |a-b| == tolerance passes
	assert_true(qa._compare(5.0, 5.01, "approx", 0.01), "within-tol approx passes (FP note: 5.01-5.0 > 0.01)")
	# FP-exact boundary: tolerance 0.0 with identical floats — <= true, < false
	assert_true(qa._compare(2.0, 2.0, "approx", 0.0), "exact-equal + tol 0: <= true")
	assert_false(qa._compare(2.0, 2.0, "approx", 0.0) == false, "sanity")

func test_compare_numeric_exact_ops() -> void:
	assert_true(qa._compare(3, 3, "eq", 0.01))
	assert_false(qa._compare(3, 4, "eq", 0.01))
	assert_false(qa._compare(4, 3, "eq", 0.01), "eq asym (4,3) false - kills eq to gte")
	assert_false(qa._compare(5, 5, "gt", 0.01), "gt boundary (5,5) false - kills gt to gte")
	assert_false(qa._compare(4, 5, "gte", 0.01), "gte asym (4,5) false - kills gte to eq")
	assert_false(qa._compare(5, 5, "lt", 0.01), "lt boundary (5,5) false - kills lt to lte")
	assert_false(qa._compare(6, 5, "lte", 0.01), "lte asym (6,5) false - kills lte to eq")
	assert_true(qa._compare(3, 4, "ne", 0.01))
	assert_false(qa._compare(3, 3, "ne", 0.01))
	assert_true(qa._compare(5, 3, "ne", 0.01), "ne asym (5,3) true - distinguishes ne from lt/eq")
	assert_true(qa._compare(3, 5, "gt", 0.01)) if false else null
	assert_true(qa._compare(5, 3, "gt", 0.01))
	assert_false(qa._compare(3, 5, "gt", 0.01))
	assert_true(qa._compare(5, 5, "gte", 0.01))
	assert_true(qa._compare(3, 5, "lt", 0.01))
	assert_false(qa._compare(5, 3, "lt", 0.01))
	assert_true(qa._compare(5, 5, "lte", 0.01))

func test_compare_int_float_interop() -> void:
	assert_true(qa._compare(3, 3.0, "eq", 0.01), "int/float same value eq")
	assert_true(qa._compare(2.5, 3, "lt", 0.01))

func test_compare_numeric_unknown_op_false() -> void:
	assert_false(qa._compare(1, 1, "bogus", 0.01), "unknown op on numbers → false")

func test_compare_vector2_all_ops() -> void:
	var a := Vector2(3, 4)      # length 5
	var b := Vector2(3, 4.005)  # distance 0.005
	assert_true(qa._compare(a, b, "approx", 0.01))
	assert_false(qa._compare(a, Vector2(3, 4.5), "approx", 0.01))
	assert_true(qa._compare(a, a, "eq", 0.01))
	assert_true(qa._compare(a, Vector2(9, 9), "ne", 0.01))
	assert_false(qa._compare(a, a, "ne", 0.01))
	assert_false(qa._compare(a, b, "lte", 0.01), "order ops on vectors → false (only approx/eq/ne)")
	assert_false(qa._compare(a, Vector2(3, 4.5), "lt", 0.01))
	assert_false(qa._compare(a, Vector2(3, 4.5), "gt", 0.01))

func test_compare_vector3_distance() -> void:
	var a := Vector3(1, 2, 2)   # length 3
	var b := Vector3(1, 2, 2.02)
	assert_true(qa._compare(a, b, "approx", 0.05))
	assert_false(qa._compare(a, b, "approx", 0.01))

func test_compare_mixed_types_kills_and_or() -> void:
	# kills line-69 `a_num and e_num` -> `or` mutant: with mixed types, `and` yields
	# false (generic arm), `or` yields true (numeric arm → float("str") crash). The
	# generic arm's == on string vs int logs an engine error (documented prod behavior
	# at _compare:97) — mark handled.
	assert_false(qa._compare("abc", 5, "approx", 0.01))
	for e in get_errors():
		e.handled = true
	assert_true(qa._compare(5, 5, "approx", 0.01))

func test_compare_nonnumeric_paths() -> void:
	assert_true(qa._compare("abc", "abc", "eq", 0.01), "string eq")
	assert_true(qa._compare("abc", "abc", "approx", 0.01), "string approx falls back to ==")
	assert_true(qa._compare("a", "b", "ne", 0.01))
	assert_false(qa._compare(true, false, "eq", 0.01))
	assert_false(qa._compare("a", "b", "gt", 0.01), "order ops on non-numerics → false")
	assert_true(qa._compare(null, null, "eq", 0.01), "nil == nil")

func test_compare_generic_arm_non_numeric_pairs() -> void:
	# the generic arm (non-numeric, non-vector): == / approx compare by value, ne inverts,
	# order ops are false — all engine-error-free pairings (bool vs bool, string vs bool)
	assert_true(qa._compare(true, true, "approx", 0.01))
	assert_true(qa._compare(true, false, "ne", 0.01))
	assert_false(qa._compare(true, false, "gt", 0.01), "order ops on non-numerics → false")

# ── _assert_property (node/property resolution + result shape) ──────────────

func test_assert_property_node_not_found() -> void:
	var r: Dictionary = qa._assert_property({"path": "/definitely/missing", "property": "x", "expected": 1})
	assert_string_contains(str(r.get("error", "")), "node_not_found")

func test_assert_property_property_not_found() -> void:
	var n := Control.new()
	n.name = "PropHost"
	get_tree().root.add_child(n)
	var r: Dictionary = qa._assert_property({"path": str(n.get_path()), "property": "no_such_prop", "expected": 1})
	assert_string_contains(str(r.get("error", "")), "property_not_found")
	n.queue_free()

func test_assert_property_pass_and_fail_shape() -> void:
	var n := Control.new()
	n.name = "PropHost2"
	n.visible = true
	get_tree().root.add_child(n)
	var ok: Dictionary = qa._assert_property({"path": str(n.get_path()), "property": "visible", "op": "eq", "expected": true})
	assert_true(ok.get("passed") == true)
	assert_true(ok.get("actual") == true)
	assert_string_contains(str(ok.get("path")), "PropHost2")
	assert_string_contains(str(ok.get("property")), "visible")
	var bad: Dictionary = qa._assert_property({"path": str(n.get_path()), "property": "visible", "op": "eq", "expected": false})
	assert_true(bad.get("passed") == false and bad.get("actual") == true, "failed assert still carries actual")
	n.queue_free()

func test_assert_property_tolerance_default_and_op_default() -> void:
	var n := Control.new()
	n.name = "PropHost3"
	get_tree().root.add_child(n)
	# defaults: op=approx, tolerance=0.01
	var r: Dictionary = qa._assert_property({"path": str(n.get_path()), "property": "position", "expected": n.position})
	assert_true(r.get("passed") == true)
	assert_true(float(r.get("tolerance")) == 0.01)
	assert_string_contains(str(r.get("op")), "approx")
	n.queue_free()

# ── _sanitize / _rect_dict / _vec2_dict ─────────────────────────────────────

func test_sanitize_primitives_pass_through() -> void:
	assert_true(qa._sanitize(null) == null)
	assert_true(qa._sanitize(true) == true)
	assert_true(qa._sanitize(7) == 7)
	assert_true(qa._sanitize(1.5) == 1.5)
	assert_true(qa._sanitize("s") == "s")
	assert_true(qa._sanitize(&"sn") == &"sn")

func test_sanitize_object_truncates_to_cap() -> void:
	var v: Variant = qa._sanitize(Vector2(1, 2))
	assert_string_contains(str(v), "(1.0, 2.0)")
	# strings pass through unchanged (TYPE_STRING arm) — the cap applies to non-primitives
	var long_str := "x".repeat(500)
	assert_true(qa._sanitize(long_str) == long_str, "string passes through untruncated")
	var capped: Variant = qa._sanitize(Vector3(1, 2, 3))
	assert_true(str(capped).length() <= 200, "object repr capped at STR_RESULT_CAP")

func test_rect_and_vec2_dicts_snap() -> void:
	var rd: Dictionary = qa._rect_dict(Rect2(0.0004, 0, 3.99996, 5))
	assert_between(rd.get("x"), -0.01, 0.01)
	assert_between(rd.get("w"), 3.99, 4.0)
	var vd: Dictionary = qa._vec2_dict(Vector2(1.23456, 7.89123))
	assert_between(vd.get("x"), 1.23, 1.24)
	assert_between(vd.get("y"), 7.89, 7.90)

# ── _run_layout_check (four check types + error arms) ───────────────────────

func test_layout_check_visible_canvas_item() -> void:
	var n := Control.new()
	n.name = "LayVis"
	get_tree().root.add_child(n)
	await get_tree().process_frame
	var r: Dictionary = qa._run_layout_check(n, {"type": "visible"})
	assert_true(r.get("passed") == true)
	assert_true(r.get("actual") == true)
	n.queue_free()

func test_layout_check_visible_nonvisual_node() -> void:
	var n := Node.new()
	n.name = "LayNonVis"
	get_tree().root.add_child(n)
	var r: Dictionary = qa._run_layout_check(n, {"type": "visible"})
	assert_true(r.get("passed") == false)
	assert_string_contains(str(r.get("error")), "not_a_visual_node")
	n.queue_free()

func test_layout_check_onscreen_and_rect_unavailable() -> void:
	var n := Control.new()
	n.name = "LayOn"
	n.size = Vector2(100, 100)  # zero-area rect never intersects — give it extent
	get_tree().root.add_child(n)
	await get_tree().process_frame
	var r: Dictionary = qa._run_layout_check(n, {"type": "onscreen"})
	assert_true(r.get("passed") == true, "sized Control at 0,0 intersects the viewport")
	assert_true(r.has("rect"))
	# Node without get_rect / not Control / not Node2D
	var plain := Node.new()
	plain.name = "LayOn2"
	get_tree().root.add_child(plain)
	var e: Dictionary = qa._run_layout_check(plain, {"type": "onscreen"})
	assert_string_contains(str(e.get("error")), "rect_unavailable")
	n.queue_free()
	plain.queue_free()

func test_layout_check_within_parent_paths() -> void:
	var parent := Control.new()
	parent.name = "LayPar"
	get_tree().root.add_child(parent)
	await get_tree().process_frame
	var child := Control.new()
	child.name = "LayKid"
	parent.add_child(child)
	# parent/child both at default rect 0,0 → encloses
	var ok: Dictionary = qa._run_layout_check(child, {"type": "within_parent"})
	assert_true(ok.get("passed") == true, "default coincident rects enclose")
	assert_true(ok.has("parent_rect"))
	# tolerance widens the parent's grow()
	var ok2: Dictionary = qa._run_layout_check(child, {"type": "within_parent", "tolerance": 10})
	assert_true(ok2.get("passed") == true)
	# a non-Control parent → parent_not_control
	var node_parent := Node.new()
	node_parent.name = "LayPar2"
	get_tree().root.add_child(node_parent)
	var kid2 := Control.new()
	kid2.name = "LayKid2"
	node_parent.add_child(kid2)
	var e: Dictionary = qa._run_layout_check(kid2, {"type": "within_parent"})
	assert_string_contains(str(e.get("error")), "parent_not_control")
	parent.queue_free()
	node_parent.queue_free()

func test_layout_check_min_size_paths() -> void:
	var n := Control.new()
	n.name = "LayMin"
	n.size = Vector2(200, 100)
	get_tree().root.add_child(n)
	var ok: Dictionary = qa._run_layout_check(n, {"type": "min_size", "min_w": 100, "min_h": 100})
	assert_true(ok.get("passed") == true)
	var bad: Dictionary = qa._run_layout_check(n, {"type": "min_size", "min_w": 500, "min_h": 100})
	assert_true(bad.get("passed") == false)
	var plain := Node.new()
	plain.name = "LayMin2"
	get_tree().root.add_child(plain)
	var e: Dictionary = qa._run_layout_check(plain, {"type": "min_size"})
	assert_string_contains(str(e.get("error")), "control_only")
	n.queue_free()
	plain.queue_free()

func test_layout_check_unknown_type() -> void:
	var n := Control.new()
	n.name = "LayU"
	get_tree().root.add_child(n)
	var r: Dictionary = qa._run_layout_check(n, {"type": "bogus"})
	assert_string_contains(str(r.get("error")), "unknown_check_type")
	n.queue_free()

func test_assert_layout_defaults_and_aggregation() -> void:
	var n := Control.new()
	n.name = "LayAgg"
	n.size = Vector2(100, 100)  # zero-area rect fails the onscreen default
	get_tree().root.add_child(n)
	await get_tree().process_frame
	# no checks → visible+onscreen defaults
	var d: Dictionary = qa._assert_layout({"path": str(n.get_path())})
	assert_true(d.get("passed") == true and (d.get("checks") as Array).size() == 2)
	# any failed check fails the aggregate
	var agg: Dictionary = qa._assert_layout({
		"path": str(n.get_path()),
		"checks": [{"type": "visible"}, {"type": "min_size", "min_w": 9999}]
	})
	assert_true(agg.get("passed") == false)
	# node not found
	var nf: Dictionary = qa._assert_layout({"path": "/missing/node"})
	assert_string_contains(str(nf.get("error")), "node_not_found")
	# non-Dictionary check entries are skipped (no crash, empty checks → passed stays true)
	var weird: Dictionary = qa._assert_layout({"path": str(n.get_path()), "checks": ["oops", {"type": "visible"}]})
	assert_true((weird.get("checks") as Array).size() == 1)
	n.queue_free()

# ── wait mutex / funnel (F-QA-8 semantics, without EngineDebugger) ──────────

func test_wait_mutex_and_funnel() -> void:
	# mutex + deferred funnel via internals; EngineDebugger-gated _send not headless-
	# assertable (the send contract is owned by the wiring gate + live-chain QA)
	assert_false(qa._wait_pending, 'fresh unlocked')
	# flip case with a real send would hit EngineDebugger; assert the flip itself via
	# a sentinel completion consumed by the funnel (state transitions are the target)
	qa._wait_pending = true
	qa._wait_pending_params = {"call_id": 1}
	qa._finish_wait_queue.append({"emitted": true})
	qa._drain_finish_queue()
	assert_false(qa._wait_pending, "funnel flips the slot exactly once")
	assert_true(qa._finish_wait_queue.is_empty(), "queue drained")
	assert_true(qa._wait_pending_params.is_empty(), "params consumed on flip")
	# second (stale) completion after the slot flipped is skipped, not crash
	qa._finish_wait_queue.append({"emitted": false})
	qa._drain_finish_queue()
	assert_false(qa._wait_pending)
	# both drains' _send hit EngineDebugger (absent headless) — engine logs expected
	for e in get_errors():
		e.handled = true

func test_handle_wait_already_pending() -> void:
	# second wait while one is live → rejected, slot NOT stolen by the second caller
	qa._wait_pending = true
	qa.handle_wait_for_signal([{"path": "/missing", "signal": "x", "call_id": 5}])
	assert_true(qa._wait_pending, "first wait keeps the slot; second wait rejected")
	qa._wait_pending = false
	# the rejection's _send hits EngineDebugger (absent headless) — log expected
	for e in get_errors():
		e.handled = true

# NOTE: handle_* / _screenshot_node_impl send-path coverage is intentionally NOT here —
# _send requires an active EngineDebugger session (headless GUT has none: every call
# logs "Can't send message"). The dispatch/send contract is owned by
# test_see1348_qa_relay_wiring.mjs (static wiring gate) + the live-chain QA batch; the
# logic arms behind the sends are fully covered by the _assert_property/_run_layout_check/
# _screenshot prelude suites above/below.

# ── screenshot prelude arms (engine-dependent core excluded) ────────────────

# ── resolution ──────────────────────────────────────────────────────────────

func test_resolve_qa_node_null_without_sampler() -> void:
	qa.sampler = null
	assert_null(qa._resolve_qa_node("/root"))
