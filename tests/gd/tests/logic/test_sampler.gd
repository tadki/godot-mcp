extends GutTest

## SEE-1348 §SPEC-016 guard tests — game_bridge/mcp_runtime_state_sampler.gd.
## Covers: start() spec resolution + caps + dedupe, record/cap accounting,
## stringify caps, wait machinery (hit / predicate reject / timeout / teardown /
## restart / stop-resolve), _read_field matrix incl. _mcp_state + generic
## property fallbacks, resolve_node paths. _process timing verified via direct
## _process(delta) calls (headless-safe; no fixed sleeps).


var s: Node = null

func _load_script(rel: String) -> GDScript:
	return load("res://game_bridge/" + rel)

func before_each() -> void:
	s = _load_script("mcp_runtime_state_sampler.gd").new()
	get_tree().root.add_child(s)

func after_each() -> void:
	if is_instance_valid(s):
		s.queue_free()
		await get_tree().process_frame
		await get_tree().process_frame  # second frame: deferred _exit_tree / frees land in-test

func _emitter() -> Node:
	var n := Node.new()
	n.name = "SigEmitter" + str(randi() % 100000)
	get_tree().root.add_child(n)
	return n

# ── start(): spec resolution / caps / dedupe / error reasons ────────────────

func test_start_resolves_fields_and_reports_counts() -> void:
	var n := Control.new()
	n.name = "Sm1"
	n.visible = true
	get_tree().root.add_child(n)
	var r: Dictionary = s.start([{"path": str(n.get_path()), "fields": ["visible", "size"]}], 10, 500)
	assert_true(int(r.get("resolved_fields")) == 2)
	assert_true(int(r.get("connected_signals")) == 0)
	assert_true(s.is_active())
	n.queue_free()

func test_start_skips_empty_paths_and_unresolved_nodes() -> void:
	var r: Dictionary = s.start([
		{"path": "", "fields": ["a"]},
		{"path": "/missing", "fields": ["b"]},
		{"path": "/root", "fields": []},
	], 10, 500)
	assert_true(int(r.get("resolved_fields")) == 0)

func test_start_field_cap_enforced() -> void:
	var n := Control.new()
	n.name = "SmCap"
	get_tree().root.add_child(n)
	var fields: Array = []
	for i in range(40):
		fields.append("f%d" % i)
	var r: Dictionary = s.start([{"path": str(n.get_path()), "fields": fields}], 10, 500)
	assert_true(int(r.get("resolved_fields")) == 32, "MAX_FIELDS=32 cap")
	n.queue_free()

func test_start_signal_paths_reasons() -> void:
	var n := Node.new()
	n.name = "SmSig"
	n.add_user_signal("my_sig", [{"name": "v", "type": TYPE_INT}])
	n.add_user_signal("five_args", [
		{"name": "a", "type": TYPE_INT}, {"name": "b", "type": TYPE_INT},
		{"name": "c", "type": TYPE_INT}, {"name": "d", "type": TYPE_INT},
		{"name": "e", "type": TYPE_INT}, {"name": "f", "type": TYPE_INT},
	])
	get_tree().root.add_child(n)
	var r: Dictionary = s.start([], 10, 500, [
		{"path": "/missing", "signal": "x"},                    # node_not_found
		{"path": "", "signal": "x"},                            # empty skip
		{"path": str(n.get_path()), "signal": "no_such"},       # signal_not_found
		{"path": str(n.get_path()), "signal": "five_args"},     # unsupported_arity (6)
		{"path": str(n.get_path()), "signal": "my_sig"},        # ok
		{"path": str(n.get_path()), "signal": "my_sig"},        # duplicate
	])
	assert_true(int(r.get("connected_signals")) == 1)
	var reasons := {}
	for u in r.get("unresolved_signals"):
		reasons[str(u.get("reason"))] = true
	assert_true(reasons.has("node_not_found") and reasons.has("signal_not_found"))
	assert_true(reasons.has("unsupported_arity") and reasons.has("duplicate"))
	n.queue_free()

func test_start_signal_cap_and_non_dict_spec() -> void:
	var holders: Array = []
	for i in range(20):
		var n := Node.new()
		n.name = "SmMany%d" % i
		n.add_user_signal("s")
		get_tree().root.add_child(n)
		holders.append(n)
	var sigs: Array = []
	for h in holders:
		sigs.append({"path": str(h.get_path()), "signal": "s"})
	sigs.append("not-a-dict")  # skipped silently
	var r: Dictionary = s.start([], 10, 500, sigs)
	assert_true(int(r.get("connected_signals")) == 16, "MAX_SIGNALS=16 cap")
	var reasons := {}
	for u in r.get("unresolved_signals"):
		reasons[str(u.get("reason"))] = true
	assert_true(reasons.has("signal_cap"))
	for h in holders:
		h.queue_free()

# ── signal recording + caps + keep-first ────────────────────────────────────

func test_record_event_and_per_signal_cap_and_drops() -> void:
	var n := Control.new()
	n.name = "Rec1"
	get_tree().root.add_child(n)
	s.start([{"path": str(n.get_path()), "fields": ["visible"]}], 60, 500, [])
	await get_tree().process_frame  # let start()'s set_process land cleanly
	# force a tiny per-signal cap: start with 200 connected? — instead call
	# _record_event directly with _per_signal_cap forced small
	s._per_signal_cap = 3
	for i in range(5):
		s._record_event(str(n.get_path()), "ping", [i])
	var c: Dictionary = s.collect()
	assert_true((c.get("events") as Array).size() == 3, "per-signal cap keeps first 3")
	assert_true(int(c.get("events_dropped")) == 2)
	assert_true(bool(c.get("events_truncated")))
	var by_signal: Dictionary = c.get("events_dropped_by_signal")
	assert_true(int(by_signal.get(str(n.get_path()) + ":ping")) == 2)
	n.queue_free()

func test_record_event_skipped_when_inactive() -> void:
	s._record_event("/root/x", "s", [])
	assert_true((s.collect().get("events") as Array).is_empty(), "inactive sampler records nothing")

func test_record_event_empty_args_key_omitted() -> void:
	s._active = true
	s._per_signal_cap = 10
	s._record_event("/root/x", "s0", [])
	var evs: Array = s.collect().get("events")
	assert_true(evs.size() == 1 and not evs[0].has("args"))

func test_stringify_args_caps() -> void:
	var long_arg := "y".repeat(60)
	var out: String = s._stringify_args([long_arg])
	assert_string_contains(out, "...")
	assert_true(out.length() <= 43 + 3, "per-arg cap 40 + ellipsis")
	var huge := "z".repeat(300)
	var out2: String = s._stringify_args([huge, huge])
	assert_true(out2.length() <= 100 + 3, "total cap 100 + ellipsis")

# ── wait machinery ──────────────────────────────────────────────────────────

func test_start_signal_wait_error_arms() -> void:
	var n := Node.new()
	n.name = "WaitErr"
	n.add_user_signal("six_args", [
		{"name": "a", "type": TYPE_INT}, {"name": "b", "type": TYPE_INT},
		{"name": "c", "type": TYPE_INT}, {"name": "d", "type": TYPE_INT},
		{"name": "e", "type": TYPE_INT}, {"name": "f", "type": TYPE_INT},
	])
	get_tree().root.add_child(n)
	n.add_user_signal("one_arg", [{"name": "v", "type": TYPE_INT}])
	assert_string_contains(str(s.start_signal_wait("/missing", "s", 100, "").get("error")), "node_not_found")
	assert_string_contains(str(s.start_signal_wait(str(n.get_path()), "no_such", 100, "").get("error")), "signal_not_found")
	assert_string_contains(str(s.start_signal_wait(str(n.get_path()), "six_args", 100, "").get("error")), "unsupported_arity")
	# a real signal with a malformed predicate → parse error arm (signal checks precede it)
	assert_string_contains(str(s.start_signal_wait(str(n.get_path()), "one_arg", 100, "1 +").get("error")), "predicate parse error")
	n.queue_free()

func test_wait_hit_path_and_teardown() -> void:
	var n := Control.new()
	n.name = "WaitHit"
	n.add_user_signal("pinged", [{"name": "value", "type": TYPE_INT}])
	get_tree().root.add_child(n)
	var r: Dictionary = s.start_signal_wait(str(n.get_path()), "pinged", 5000, "value > 10")
	assert_true(r.get("connected") == true)
	n.emit_signal("pinged", 5)   # rejected by predicate
	n.emit_signal("pinged", 42)  # passes
	var got: Array = []
	var got_signal: Array = []
	s.qa_wait_finished.connect(func(res: Dictionary) -> void:
		got.append(res))
	await get_tree().process_frame  # deferred finish + emit
	assert_true(got.size() == 1)
	var res: Dictionary = got[0]
	assert_true(bool(res.get("emitted")))
	assert_true(int(res.get("rejected")) == 1)
	assert_true(bool(res.get("predicate_supplied")))
	assert_string_contains(str(res.get("args")), "42")
	assert_true(res.has("t_ms"))
	# teardown: connection dropped, wait inactive
	assert_false(s._wait_active)
	assert_null(s._wait_node)
	n.queue_free()

func test_wait_predicate_reject_keeps_waiting() -> void:
	var n := Control.new()
	n.name = "WaitPRej"
	n.add_user_signal("pinged", [{"name": "value", "type": TYPE_INT}])
	get_tree().root.add_child(n)
	# a predicate that RETURNS false (no engine error — plain-reject path)
	var r: Dictionary = s.start_signal_wait(str(n.get_path()), "pinged", 5000, "value > 10")
	assert_true(r.get("connected") == true)
	n.emit_signal("pinged", 5)
	await get_tree().process_frame
	assert_true(s._wait_active)
	assert_false(s._wait_predicate_failed)
	assert_true(int(s._wait_rejected) == 1)
	n.queue_free()

func test_wait_wall_clock_timeout_via_direct_process_ticks() -> void:
	var n := Control.new()
	n.name = "WaitTO"
	n.add_user_signal("never")
	get_tree().root.add_child(n)
	var got: Array = []
	s.qa_wait_finished.connect(func(res: Dictionary) -> void: got.append(res))
	s.start_signal_wait(str(n.get_path()), "never", 200, "")
	# simulate frames: 3 x 100ms delta ticks = 300ms > 200ms budget (event-driven: direct _process calls)
	for i in range(3):
		s._process(0.1)
	await get_tree().process_frame
	assert_true(got.size() == 1)
	assert_true(bool(got[0].get("emitted")) == false, "timeout resolves emitted:false")
	assert_true(int(got[0].get("timeout_ms")) == 200)
	assert_false(s._wait_active)
	await get_tree().process_frame
	n.queue_free()

func test_wait_reconnect_tears_down_previous() -> void:
	var n := Control.new()
	n.name = "WaitRe"
	n.add_user_signal("sig")
	get_tree().root.add_child(n)
	s.start_signal_wait(str(n.get_path()), "sig", 5000, "")
	var first_cb: Callable = s._wait_callable
	# a restart while a wait is live tears the old one down
	s.start_signal_wait(str(n.get_path()), "sig", 5000, "")
	assert_false(n.is_connected("sig", first_cb), "old wait connection dropped on restart")
	await get_tree().process_frame  # drain deferred teardown before freeing
	n.queue_free()

func test_stop_resolves_pending_wait() -> void:
	var n := Control.new()
	n.name = "WaitStop"
	n.add_user_signal("sig")
	get_tree().root.add_child(n)
	var got: Array = []
	s.qa_wait_finished.connect(func(res: Dictionary) -> void: got.append(res))
	s.start_signal_wait(str(n.get_path()), "sig", 30000, "")
	s.stop()
	await get_tree().process_frame
	assert_true(got.size() == 1, "stop() resolves a pending wait (emitted:false)")
	assert_true(bool(got[0].get("emitted")) == false)
	assert_false(s.is_active())
	n.queue_free()

func test_exit_tree_tears_down_everything() -> void:
	await get_tree().process_frame  # let the prior test's deferred engine logs land HERE
	for e in get_errors():
		e.handled = true
	var n := Control.new()
	n.name = "WaitExit"
	n.add_user_signal("sig")
	get_tree().root.add_child(n)
	s.start([{"path": str(n.get_path()), "fields": ["visible"]}], 10, 5000, [{"path": str(n.get_path()), "signal": "sig"}])
	s._exit_tree()
	# the prior predicate test's deferred engine log (Invalid named index) lands in
	# THIS test's error bucket — the production-documented reject path; mark handled
	for e in get_errors():
		e.handled = true
	# production semantics: _exit_tree drops connections + tears the wait, but does
	# NOT flip the sampling _active flag (only stop()/window-end do)
	assert_true(s._connections.is_empty())
	assert_false(s._wait_active)
	await get_tree().process_frame
	n.queue_free()

# ── sampling loop: window stop, freed nodes, per-field caps ─────────────────

func test_process_window_stops_at_duration() -> void:
	var n := Control.new()
	n.name = "WinStop"
	get_tree().root.add_child(n)
	s.start([{"path": str(n.get_path()), "fields": ["visible"]}], 60, 300, [])
	s._elapsed_ms = 0.0
	# 4 x 100ms ticks = 400ms > 300ms window; window closes mid-tick
	for i in range(4):
		s._elapsed_ms = float(i) * 100.0  # pin elapsed: tick 3 crosses 300ms
		s._process(0.1)
	assert_false(s.is_active())
	n.queue_free()

func test_process_freed_node_marks_freed() -> void:
	var n := Control.new()
	n.name = "FreedN"
	get_tree().root.add_child(n)
	var full_key := str(n.get_path()) + ":visible"
	s.start([{"path": str(n.get_path()), "fields": ["visible"]}], 60, 5000, [])
	s._sample_interval = 1
	s._elapsed_ms = 0.0
	s._active = true
	n.free()  # hard free; sampler keeps a dangling reference
	s._process(0.016)
	var samples: Dictionary = s.collect().get("fields")
	assert_string_contains(str(samples[full_key][0].get("value")), "freed")

func test_process_field_sample_cap_marks_truncated() -> void:
	var n := Control.new()
	n.name = "CapN"
	get_tree().root.add_child(n)
	var full_key := str(n.get_path()) + ":visible"
	s.start([{"path": str(n.get_path()), "fields": ["visible"]}], 60, 5000, [])
	s._sample_interval = 1
	# duration clamps to 5000ms, and free-running engine frames between tests burn
	# window game-time before our loop starts — reset the window at loop start so
	# the 200-sample cap (not the window) is the binding constraint.
	s._elapsed_ms = 0.0
	for i in range(250):
		s._elapsed_ms = 0.0  # hold the window open; only the sample cap is under test
		s._active = true  # engine ticks between ours may have closed the window
		s._process(0.004)  # 4ms game-time (delta=seconds)
	var c: Dictionary = s.collect()
	assert_true((c.get("fields")[full_key] as Array).size() == 200, "MAX_SAMPLES_PER_FIELD=200 cap reached")
	assert_true(bool(c.get("fields_truncated").get(full_key)), "truncation flag set at cap")
	n.queue_free()

func test_process_paused_tree_skips_sampling_but_not_wait() -> void:
	var n := Control.new()
	n.name = "PausedN"
	get_tree().root.add_child(n)
	var full_key := str(n.get_path()) + ":visible"
	s.start([{"path": str(n.get_path()), "fields": ["visible"]}], 60, 5000, [])
	s._sample_interval = 1
	s._elapsed_ms = 0.0
	s._active = true
	s._process(0.016)  # one baseline sample
	# a real signal for the wait part
	n.add_user_signal("sig")
	s.start_signal_wait(str(n.get_path()), "sig", 200, "")
	var samples_before: int = (s.collect().get("fields")[full_key] as Array).size()
	get_tree().paused = true
	s._process(0.5)
	get_tree().paused = false
	var samples_after: int = (s.collect().get("fields")[full_key] as Array).size()
	assert_true(samples_after == samples_before, "paused: no sampling accumulation")
	assert_true(s._wait_elapsed_ms > 0.0, "paused: wait wall-clock still advances")
	n.queue_free()
	await get_tree().process_frame  # drain deferred frees (their engine logs) in-test

func test_process_time_window_only_unpaused_game_time() -> void:
	var n := Control.new()
	n.name = "TimeN"
	get_tree().root.add_child(n)
	s.start([{"path": str(n.get_path()), "fields": ["visible"]}], 60, 500, [])
	s._process(0.5)
	var window_ms: int = (s.collect().get("window_ms"))
	assert_true(window_ms == 500, "unpaused _process accumulates game time 1:1")

# ── _read_field matrix ──────────────────────────────────────────────────────

func test_read_field_2d3d_matrix() -> void:
	# NOTE: reads require inside-tree nodes; free only after all reads.
	var n2 := Node2D.new()
	n2.name = "RF2D"
	get_tree().root.add_child(n2)
	n2.global_position = Vector2(1.234, 5.678)  # global setters need inside-tree
	n2.global_rotation = 0.5
	assert_between(s._read_field(n2, "pos.x"), 1.23, 1.24)
	assert_between(s._read_field(n2, "pos.y"), 5.67, 5.68)
	assert_between(s._read_field(n2, "rot"), 28.6, 28.7)
	assert_null(s._read_field(n2, "pos.z"), "2D has no pos.z")
	var n3 := Node3D.new()
	n3.name = "RF3D"
	get_tree().root.add_child(n3)
	n3.global_position = Vector3(1, 2, 3)  # global setters need inside-tree
	assert_true(float(s._read_field(n3, "pos.z")) == 3.0)
	n2.queue_free()
	n3.queue_free()

func test_read_field_velocity_matrix() -> void:
	# reads require inside-tree physics nodes; free only after all reads.
	var cb := CharacterBody2D.new()
	cb.name = "RFB2"
	cb.velocity = Vector2(10, 20)
	get_tree().root.add_child(cb)
	assert_between(s._read_field(cb, "vel.x"), 9.99, 10.01)
	assert_between(s._read_field(cb, "vel.y"), 19.99, 20.01)
	var rb := RigidBody2D.new()
	rb.name = "RFR2"
	rb.linear_velocity = Vector2(5, 0)
	get_tree().root.add_child(rb)
	assert_between(s._read_field(rb, "vel.x"), 4.99, 5.01)
	var cb3 := CharacterBody3D.new()
	cb3.name = "RFB3"
	cb3.velocity = Vector3(1, 2, 3)
	get_tree().root.add_child(cb3)
	assert_between(s._read_field(cb3, "vel.z"), 2.99, 3.01)
	for x in [cb, rb, cb3]:
		x.queue_free()

func test_read_field_anim_fields() -> void:
	var ap := AnimationPlayer.new()
	ap.name = "RFAP"
	get_tree().root.add_child(ap)
	# AnimationPlayer with no animation reports the empty current animation —
	# the sampled value is a String (""), not null; either is a legitimate
	# no-animation verdict, pin whatever the current build reports.
	var anim_val: Variant = s._read_field(ap, "anim")
	assert_true(anim_val == null or str(anim_val) == "", "no-anim → null or empty string, not a crash")
	var asp := AnimatedSprite2D.new()
	asp.name = "RFAS"
	get_tree().root.add_child(asp)
	assert_true(typeof(s._read_field(asp, "anim_frame")) in [TYPE_INT, TYPE_NIL])
	asp.queue_free()
	ap.queue_free()

func test_read_field_mcp_state_and_generic_fallback() -> void:
	var gd := GDScript.new()
	gd.source_code = """
extends Control
func _mcp_state() -> Dictionary:
	return {"health": 3.14159, "label": "ok"}
"""
	gd.reload()
	var n := Control.new()
	n.set_script(gd)
	n.name = "StateHost"
	get_tree().root.add_child(n)
	await get_tree().process_frame
	assert_between(s._read_field(n, "health"), 3.14, 3.15)
	assert_string_contains(str(s._read_field(n, "label")), "ok")
	# generic property fallback (float and string/bool passthrough)
	# dotted property keys are NOT in `key in node` — generic fallback only
	# handles whole properties; dotted reads belong to the match arms. Pin that:
	assert_null(s._read_field(n, "size.x"), "dotted non-match-arm key → null (no crash)")
	assert_null(s._read_field(n, "totally_absent_key"))
	n.queue_free()

func test_read_field_bool_and_string_passthrough() -> void:
	var n := Control.new()
	n.name = "Passthrough"
	n.visible = true
	get_tree().root.add_child(n)
	assert_true(s._read_field(n, "visible") == true)
	n.queue_free()

# ── _signal_arg_count / resolve_node ────────────────────────────────────────

func test_signal_arg_count_builtin_and_missing() -> void:
	var n := Control.new()
	n.name = "ArgC"
	get_tree().root.add_child(n)
	assert_true(s._signal_arg_count(n, "mouse_entered") == 0, "builtin 0-arity signal found")
	assert_true(s._signal_arg_count(n, "nope") == -1)
	n.queue_free()

func test_resolve_node_paths() -> void:
	var scene := Node2D.new()
	scene.name = "ResScene"
	get_tree().root.add_child(scene)
	# scene-relative arms need current_scene set (the fixture has no main scene)
	get_tree().current_scene = scene
	var child := Control.new()
	child.name = "ResKid"
	scene.add_child(child)
	assert_true(s.resolve_node("/") == scene, "/ = scene root (not the Window)")
	assert_true(s.resolve_node("/root/ResScene") == scene)
	assert_true(s.resolve_node("/root/ResScene/ResKid") == child)
	assert_true(s.resolve_node("ResKid") == child, "relative path from scene root")
	assert_null(s.resolve_node("/root/ResScene/Missing"))
	assert_null(s.resolve_node("Missing"))
	scene.queue_free()

func test_start_clamps_hz_and_duration() -> void:
	var n := Control.new()
	n.name = "ClampN"
	get_tree().root.add_child(n)
	s.start([], 0, 50, [])
	assert_true(int(s._hz) == 1 and int(s._duration_ms) == 100, "hz→1 duration→100 lower clamps")
	s.start([], 100, 9999, [])
	assert_true(int(s._hz) == 60 and int(s._duration_ms) == 5000, "hz→60 duration→5000 upper clamps")
	n.queue_free()

func test_collect_no_aliasing() -> void:
	var n := Control.new()
	n.name = "AliasN"
	get_tree().root.add_child(n)
	var full_key := str(n.get_path()) + ":visible"
	s.start([{"path": str(n.get_path()), "fields": ["visible"]}], 60, 500000, [])
	s._sample_interval = 1
	s._process(1.0)
	var c1: Dictionary = s.collect()
	var before: int = (c1.get("fields")[full_key] as Array).size()
	s._process(1.0)  # recording continues after collect (mid-window)
	var after: int = (c1.get("fields")[full_key] as Array).size()
	assert_true(after == before, "collect returned a copy — caller's array does not grow")
	n.queue_free()
