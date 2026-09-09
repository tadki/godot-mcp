@tool
class_name MCPDebugCommands
extends MCPBaseCommand

# Keep in sync with LAUNCH_FROZEN_ENV in mcp_game_bridge.gd.
const LAUNCH_FROZEN_ENV := "GODOT_MCP_LAUNCH_FROZEN"

# How long `run` may wait for the launched game's bridge to report its main
# scene is up before giving up. Sized for a cold game boot (autoload _ready +
# scene instantiation), not the ~1s ready-wait of an already-running game
# (input_commands.READY_TIMEOUT). Must stay under the server's socket timeout
# for run_project (QUICK_TIMEOUT_MS: 90s in this deployment, 30s upstream) or
# the fork kills the wait before it can succeed.
const BRIDGE_READY_TIMEOUT := 60.0

# SEE-1134 D1 final: EditorInterface.is_playing_scene() flips true a few frames
# after play_main_scene() while the editor spins up the debug session. Polling
# is_bridge_ready() during that window is unsafe because has_active_session()
# (called inside is_bridge_ready) clobbers _active_session_id to -1 when
# is_playing_scene() is transiently false — if the game's bridge_ready message
# arrives during that window it sets _bridge_ready=true but the session id is
# already gone, so every subsequent poll reads false and run reports
# bridge_ready:false even though the bridge is drivable (Revy saw 4/4 false +
# 75% first-step TIMEOUT; my R1 step at 8ms proved the bridge IS ready). The
# fix polls _bridge_ready directly during the ramp-up grace (no
# has_active_session side effect), then switches to the full is_bridge_ready
# check once the editor confirms the session is live.
#
# SEE-1134 D1 grace30: widened from 5s to 30s. Revy's N=6 QA at PR #510 showed
# `bridge_ready` still 6/6 false with R3/R6 first-step timeouts — the 5s window
# does not cover the worst-case cold boot (autoload _ready + scene tree build
# under editor scan/import contention, observed ~10.8s idle gate alone). 30s is
# Revy's upper bound (15-30s) and stays well inside BRIDGE_READY_TIMEOUT (60s)
# and the server socket deadline (90s). If a cold boot still exceeds this, the
# race moves to the tool layer (run_project emits a warning so callers retry).
const PLAY_RAMP_GRACE := 30.0


func get_commands() -> Dictionary:
	return {
		"run_project": run_project,
		"stop_project": stop_project,
		"get_log_messages": get_log_messages,
		"get_stack_trace": get_stack_trace,
	}


func run_project(params: Dictionary) -> Dictionary:
	var scene_path: String = params.get("scene_path", "")
	var frozen: bool = params.get("frozen", false)

	# Launch-frozen: the spawned game inherits the editor's environment, so
	# setting this before play makes the bridge freeze the tree in _ready —
	# before the first process frame. Deterministic, unlike sending a freeze
	# message after the debug session comes up (which races the game's first
	# frames against the agent's latency).
	if frozen:
		OS.set_environment(LAUNCH_FROZEN_ENV, "1")

	if scene_path.is_empty():
		EditorInterface.play_main_scene()
	else:
		EditorInterface.play_custom_scene(scene_path)

	if frozen:
		# The child captured its environment at spawn; clear promptly so a
		# manual F5 run doesn't inherit the freeze. Two frames covers a
		# deferred spawn. (Godot has no unset; empty fails the == "1" check.)
		await Engine.get_main_loop().process_frame
		await Engine.get_main_loop().process_frame
		OS.set_environment(LAUNCH_FROZEN_ENV, "")

	# `run` must not answer before the launched game's bridge reports its main
	# scene is up (SEE-1134). Downstream tools (input, runtime_state, screenshot)
	# gate on is_bridge_ready(), so a run response that lands mid-boot makes the
	# immediately-following call time out against a half-initialized game. The
	# game's own addon announces bridge_ready on its first drivable frame even
	# under launch-frozen, so the wait is compatible with frozen runs.
	var debugger_plugin = _plugin.get_debugger_plugin() if _plugin else null
	var bridge_ready := true
	if debugger_plugin != null:
		bridge_ready = await _await_game_ready(debugger_plugin)

	# SEE-1134 D1 grace30: emit the final gate outcome so QA can tell "the bridge
	# announced within the ramp grace" (true) apart from "grace expired / game
	# never confirmed playing" (false) without guessing from the run result field.
	# false uses warn (the degraded path a caller may want to retry); true is an
	# info trace. MCPLog.info goes to the editor stdout log stream (Revy reads
	# ~/.multica/godot-editor-*.log); there is no info tier in the MCPLogger
	# error buffer, so true traces do not surface via get_log_messages filters.
	if bridge_ready:
		MCPLog.info(
			"SEE-1134 run gate: bridge_ready=true (announced within ramp grace or already live)."
		)
	else:
		MCPLog.warn(
			(
				"SEE-1134 run gate: returning bridge_ready=false — the "
				+ "immediately-following step may time out; caller should retry."
			)
		)

	return _success({"frozen": frozen, "bridge_ready": bridge_ready})


# Block until the launched game's bridge reports it can receive commands, bounded
# by BRIDGE_READY_TIMEOUT. `is_playing` is injectable so headless tests can stub
# the editor's play state (no game is really launched there); the default reads
# the live EditorInterface, mirroring input_commands._await_bridge_ready. Returns
# false if the game stops or never comes up in time.
func _await_game_ready(
	debugger_plugin, is_playing: Callable = Callable(), timeout: float = BRIDGE_READY_TIMEOUT
) -> bool:
	if is_playing.is_null():
		is_playing = EditorInterface.is_playing_scene
	var op_start := Time.get_ticks_msec()
	var seen_playing := false
	while true:
		var playing := is_playing.call()
		var elapsed := (Time.get_ticks_msec() - op_start) / 1000.0
		# Decide which readiness signal to trust on this poll. During the ramp-up
		# grace window is_playing_scene() is unreliable AND has_active_session()
		# clobbers _active_session_id as a side effect, so use is_bridge_announced()
		# (the bridge's own announce flag, no session side effect — if the announce
		# arrived at all, the WS connection is up). Once is_playing has been seen
		# true we trust the full is_bridge_ready() (session id is now stable, the
		# gate is meaningful).
		var ready_signal: bool
		if playing:
			if not seen_playing:
				# Path switch (announced -> ready): log once so QA can tell a
				# within-grace announce-to-ready handoff apart from an
				# outside-window fallback to false. MCPLog.info routes to the
				# editor stdout log (Revy reads ~/.multica/godot-editor-*.log);
				# there is no info tier in the MCPLogger error buffer, so this
				# trace does not surface via get_log_messages severity filters
				# but is captured by the editor process log stream.
				MCPLog.info(
					(
						(
							"SEE-1134 run gate: editor confirmed playing at %.2fs; "
							+ "switching readiness probe from is_bridge_announced "
							+ "to is_bridge_ready."
						)
						% elapsed
					)
				)
			seen_playing = true
			ready_signal = debugger_plugin.is_bridge_ready()
		elif seen_playing:
			return false  # was playing, now stopped -> genuine stop/crash
		else:
			if not elapsed < PLAY_RAMP_GRACE:
				# Outside the ramp grace and the editor never confirmed playing:
				# log so QA can distinguish this from an in-window announce.
				MCPLog.warn(
					(
						(
							"SEE-1134 run gate: ramp grace %.0fs expired at %.2fs; "
							+ "editor still not playing, run will report "
							+ "bridge_ready:false (cold boot exceeded grace — retry)."
						)
						% [PLAY_RAMP_GRACE, elapsed]
					)
				)
				return false  # game never came up within the ramp grace
			ready_signal = debugger_plugin.is_bridge_announced()
		if ready_signal:
			return true
		await Engine.get_main_loop().process_frame
		if elapsed > timeout:
			return false
	return true  # unreachable; satisfies GDScript's "all paths return" check


func stop_project(_params: Dictionary) -> Dictionary:
	EditorInterface.stop_playing_scene()
	return _success({})


func get_log_messages(params: Dictionary) -> Dictionary:
	var clear: bool = params.get("clear", false)
	var limit: int = int(params.get("limit", 50))
	var severity: String = params.get("severity", "all")
	var since: int = int(params.get("since", 0))

	var result := MCPLogger.query(since, severity, limit)

	if clear:
		MCPLogger.clear_errors()

	# The phantom "Identifier not found: <autoload>" errors that mislead agents
	# come from the editor running stale after project.godot was edited on disk
	# (#245). When that divergence is present, attach it here so the caller reads
	# the log and the "your editor is stale, restart it" advisory in one shot,
	# instead of chasing compile errors that do not exist at runtime.
	var staleness := MCPUtils.detect_project_staleness()
	if staleness.get("stale", false):
		result["staleness"] = staleness

	return _success(result)


func get_stack_trace(_params: Dictionary) -> Dictionary:
	var frames := MCPLogger.get_last_stack_trace()
	var errors := MCPLogger.get_errors()
	var last_error: Dictionary = errors[-1] if not errors.is_empty() else {}
	return _success(
		{
			"error": last_error.get("message", ""),
			"error_type": last_error.get("type", ""),
			"file": last_error.get("file", ""),
			"line": last_error.get("line", 0),
			"frames": frames,
		}
	)
