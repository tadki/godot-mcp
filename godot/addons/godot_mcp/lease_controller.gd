@tool
extends RefCounted

# Event-driven lease (SEE-1009): decides when an editor with no active MCP
# client should self-exit. The editor's lifetime is bound to "is an MCP client
# using me right now?" — when the WebSocket client disconnects (npx died /
# session ended), schedule a one-shot quit; when a client (re)connects, cancel
# it. A fresh editor with no client yet gets a longer grace so cold-start before
# npx connects does not trip a quit.
#
# This is a pure state machine: it returns start/stop decisions and tracks
# whether a quit is pending. The host (plugin.gd) owns the real Timer and
# applies the decisions, which keeps this unit-testable without a SceneTree.
# There is deliberately NO polling, NO filesystem watch, NO background sweep —
# only connect/disconnect events driving a single one-shot Timer.

const QUIT_DELAY_SEC := 120.0
const INITIAL_GRACE_SEC := 300.0

var _quit_scheduled := false
var _scheduled_delay := 0.0


func is_quit_scheduled() -> bool:
	return _quit_scheduled


func get_scheduled_delay() -> float:
	return _scheduled_delay


# Fresh editor: no client yet. Allow a long grace for npx to connect.
func start_initial_grace() -> Dictionary:
	return _schedule(INITIAL_GRACE_SEC)


# WS client connected: cancel any pending quit.
func on_client_connected() -> Dictionary:
	return _cancel()


# WS client disconnected: schedule a one-shot quit after QUIT_DELAY_SEC.
func on_client_disconnected() -> Dictionary:
	return _schedule(QUIT_DELAY_SEC)


# Called by the host when its Timer actually fires. Returns true if a quit is
# still wanted (it will have been cancelled if a client reconnected in time).
func consume_timeout() -> bool:
	if _quit_scheduled:
		_quit_scheduled = false
		_scheduled_delay = 0.0
		return true
	return false


func _schedule(delay: float) -> Dictionary:
	_quit_scheduled = true
	_scheduled_delay = delay
	return {"action": "start", "delay": delay}


func _cancel() -> Dictionary:
	_quit_scheduled = false
	_scheduled_delay = 0.0
	return {"action": "stop"}
