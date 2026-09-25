@tool
extends MCPBaseCommand
class_name MCPQACommands

# SEE-1348 WP6 (M3, §SPEC-006) F-QA-1 rework: godot_qa relay leg. The server's
# godot_qa tool lands here over the WS command channel; this side forwards to
# the running game's bridge (mcp_game_bridge.gd dispatch -> mcp_qa.gd handlers)
# and waits, exactly like exec_commands.gd. The server derives the timeout
# cascade and pushes relay_timeout_ms in params for the two actions whose game
# side can legitimately take long (wait_for_signal's wall-clock budget,
# screenshot_node's frame_post_draw capture); the constants are fallbacks for
# an older server that pushes none.

const BASE_TIMEOUT := 10.0
const LONG_TIMEOUT := 28.0

var _last_error: Dictionary = {}
var _call_seq := 0
# F-QA-8 residual: the debugger plugin keeps ONE response slot per msg_type,
# so a second concurrent wait's bridge-side wait_already_pending rejection
# (a mismatched call_id from its slot) gets consumed and discarded by the
# FIRST wait's relay, and the second starves to its relay [TIMEOUT]. This
# relay-level mutex refuses the second wait BEFORE the debugger channel:
# nothing is sent for the refused call, so the in-flight wait's slot and
# relay stay untouched. The flag returns when the in-flight relay completes
# — response or timeout, both fall through the single await below.
var _wait_in_flight := false


func get_commands() -> Dictionary:
	return {
		"qa_assert_property": qa_assert_property,
		"qa_wait_for_signal": qa_wait_for_signal,
		"qa_assert_layout": qa_assert_layout,
		"qa_screenshot_node": qa_screenshot_node,
	}


func qa_assert_property(params: Dictionary) -> Dictionary:
	return await _relay("qa_assert_property", params, BASE_TIMEOUT)


func qa_wait_for_signal(params: Dictionary) -> Dictionary:
	# The bridge resolves the wait at min(emission, wall-clock timeout_ms); the
	# pushed relay budget (server: budget + margins) only covers transit slop.
	if _wait_in_flight:
		# Refused before the debugger channel — see _wait_in_flight.
		return _error("QA_ERROR", "wait_already_pending: one wait_for_signal at a time")
	_wait_in_flight = true
	var result = await _relay("qa_wait_for_signal", params, _relay_timeout(params, LONG_TIMEOUT))
	_wait_in_flight = false
	return result


func qa_assert_layout(params: Dictionary) -> Dictionary:
	return await _relay("qa_assert_layout", params, BASE_TIMEOUT)


func qa_screenshot_node(params: Dictionary) -> Dictionary:
	# Capture awaits RenderingServer.frame_post_draw; frozen-safe but a stalled
	# render must degrade to a typed TIMEOUT, not a socket kill.
	return await _relay("qa_screenshot_node", params, _relay_timeout(params, LONG_TIMEOUT))


func _relay_timeout(params: Dictionary, fallback: float) -> float:
	var ms: float = float(params.get("relay_timeout_ms", fallback * 1000.0))
	return ms / 1000.0


func _relay(msg_type: String, params: Dictionary, timeout: float) -> Dictionary:
	# Explicit request/response correlation (see exec_commands._relay): the
	# debugger plugin keys responses by msg_type alone, so a timed-out call's
	# LATE response could otherwise be consumed as the answer to the next call
	# of the same type. The bridge (mcp_qa.gd _send) echoes call_id; mismatches
	# are discarded here.
	_call_seq += 1
	var call_id := _call_seq
	params = params.duplicate()
	params["call_id"] = call_id
	var response = await _send_and_wait(msg_type, [params], timeout, call_id)
	if response == null:
		return _last_error
	if response is Dictionary:
		response.erase("call_id")  # transport detail, not part of the result
		if response.has("error"):
			return _error("QA_ERROR", str(response["error"]))
		return _success(response)
	return _success({"data": response})


func _send_and_wait(msg_type: String, args: Array, timeout: float, call_id: int):
	if not EditorInterface.is_playing_scene():
		_last_error = _error("NOT_RUNNING", "No game is currently running")
		return null

	var debugger_plugin = _plugin.get_debugger_plugin() if _plugin else null
	if debugger_plugin == null or not debugger_plugin.has_active_session():
		_last_error = _error("NO_SESSION", "No active debug session")
		return null

	var sent: bool = debugger_plugin.send_game_message(msg_type, args)
	if not sent:
		_last_error = _error("SEND_FAILED", "Failed to send message to game")
		return null

	var start_time := Time.get_ticks_msec()
	while true:
		await Engine.get_main_loop().process_frame
		if debugger_plugin.has_response(msg_type):
			var response = debugger_plugin.get_response(msg_type)
			debugger_plugin.clear_response(msg_type)
			if (
				response is Dictionary
				and response.has("call_id")
				and int(response["call_id"]) != call_id
			):
				continue  # a previous call's late response — discard, keep waiting for ours
			return response
		if (Time.get_ticks_msec() - start_time) / 1000.0 > timeout:
			debugger_plugin.clear_response(msg_type)
			_last_error = _error("TIMEOUT", "Timed out waiting for %s response" % msg_type)
			return null
