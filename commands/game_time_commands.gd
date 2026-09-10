@tool
extends MCPBaseCommand
class_name MCPGameTimeCommands

# Game-time control relay: freeze / step / step_until / thaw / status execute in
# the game bridge (see mcp_game_bridge.gd); this side only forwards over the
# debugger channel and waits. Timeout cascade (#276): the server derives the
# whole stagger from the call's in-game budget and pushes relay_timeout_ms down
# in params; we wait exactly that long, so the bridge (which returns by its
# pushed wall budget) answers first and errors surface typed. BASE_TIMEOUT and
# STEP_TIMEOUT are fallbacks only — for an older server that pushes no budget.
const BASE_TIMEOUT := 10.0
const STEP_TIMEOUT := 28.0

var _last_error: Dictionary = {}


func get_commands() -> Dictionary:
	return {
		"game_time_freeze": game_time_freeze,
		"game_time_step": game_time_step,
		"game_time_step_until": game_time_step_until,
		"game_time_thaw": game_time_thaw,
		"game_time_status": game_time_status,
	}


func game_time_freeze(params: Dictionary) -> Dictionary:
	return await _relay("game_time_freeze", [params], BASE_TIMEOUT)


func game_time_step(params: Dictionary) -> Dictionary:
	return await _relay("game_time_step", [params], _relay_timeout(params, STEP_TIMEOUT))


func game_time_step_until(params: Dictionary) -> Dictionary:
	return await _relay("game_time_step_until", [params], _relay_timeout(params, STEP_TIMEOUT))


func game_time_thaw(params: Dictionary) -> Dictionary:
	return await _relay("game_time_thaw", [params], BASE_TIMEOUT)


func game_time_status(params: Dictionary) -> Dictionary:
	return await _relay("game_time_status", [params], BASE_TIMEOUT)


func _relay_timeout(params: Dictionary, fallback: float) -> float:
	# Use the server-pushed relay budget when present (#276); the local constant
	# is only a fallback for an older server that does not derive the cascade.
	var ms: float = float(params.get("relay_timeout_ms", fallback * 1000.0))
	return ms / 1000.0


func _relay(msg_type: String, args: Array, timeout: float) -> Dictionary:
	var response = await _send_and_wait(msg_type, args, timeout)
	if response == null:
		return _last_error
	if response is Dictionary and response.has("error"):
		return _error("GAME_TIME_ERROR", str(response["error"]))
	if response is Dictionary:
		return _success(response)
	return _success({"data": response})


func _send_and_wait(msg_type: String, args: Array, timeout: float):
	if not EditorInterface.is_playing_scene():
		_last_error = _error("NOT_RUNNING", "No game is currently running")
		return null

	var debugger_plugin = _plugin.get_debugger_plugin() if _plugin else null
	if debugger_plugin == null or not debugger_plugin.has_active_session():
		_last_error = _error("NO_SESSION", "No active debug session")
		return null

	# SEE-1134 D1: a step/freeze/thaw landing in the first frames after a frozen
	# launch races the game bridge's first drivable tick. has_active_session() is
	# true the instant the debug session opens, but the game's main loop is still
	# draining first-frame init (autoload warmup, first resource loads), so the
	# message sits in the queue and the response never comes back inside the
	# relay timeout. Wait for the bridge's own bridge_ready signal — which the
	# game emits only once _process is actually ticking past init — before we
	# send. Bounded so a bridge that never reports ready still fails honestly as
	# TIMEOUT instead of hanging forever.
	var ready_start := Time.get_ticks_msec()
	# The ready-wait and the response-wait below both draw from the same relay
	# budget, but the server socket only gives relayMs + its margin. If the
	# ready-wait could consume the full half budget on top of a full-length
	# response-wait, the socket would kill the request before we could answer
	# with a typed TIMEOUT (SEE-1134 D5). Cap the pre-send wait so
	# ready_wait + response_wait stays inside the socket window.
	var ready_budget := minf(timeout * 0.5, 1.5)
	while not debugger_plugin.is_bridge_ready():
		if not EditorInterface.is_playing_scene():
			_last_error = _error("NOT_RUNNING", "Game stopped before bridge became ready")
			return null
		await Engine.get_main_loop().process_frame
		if (Time.get_ticks_msec() - ready_start) / 1000.0 > ready_budget:
			_last_error = _error(
				"BRIDGE_NOT_READY", "Game bridge did not report ready within %.1fs" % ready_budget
			)
			return null

	var sent: bool = debugger_plugin.send_game_message(msg_type, args)
	if not sent:
		_last_error = _error("SEND_FAILED", "Failed to send message to game")
		return null

	var start_time := Time.get_ticks_msec()
	while not debugger_plugin.has_response(msg_type):
		await Engine.get_main_loop().process_frame
		if (Time.get_ticks_msec() - start_time) / 1000.0 > timeout:
			debugger_plugin.clear_response(msg_type)
			_last_error = _error("TIMEOUT", "Timed out waiting for %s response" % msg_type)
			return null

	var response = debugger_plugin.get_response(msg_type)
	debugger_plugin.clear_response(msg_type)
	return response
