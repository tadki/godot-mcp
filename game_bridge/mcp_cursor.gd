class_name MCPCursor
extends Node

## SEE-1142: cooperative virtual cursor. The polled APIs (`Viewport.get_mouse_position`
## / `CanvasItem.get_global_mouse_position`) read the physical OS cursor (root viewport
## goes straight to `DisplayServer::mouse_get_position`), so injected motion can never
## move them. Game-side code that needs the injected position reads it through this
## node (via the game's own MousePos helper); when no virtual position is set it falls
## back to the physical cursor, so the game behaves identically without the addon.

var _virtual_pos: Vector2 = Vector2.ZERO
var _has_virtual: bool = false


func set_virtual_global(viewport_pos: Vector2) -> void:
	_virtual_pos = viewport_pos
	_has_virtual = true


func clear_virtual() -> void:
	_has_virtual = false


func has_virtual() -> bool:
	return _has_virtual


func get_global_position(fallback_viewport: Viewport) -> Vector2:
	if _has_virtual:
		return _virtual_pos
	if fallback_viewport != null:
		return fallback_viewport.get_mouse_position()
	# No viewport and no virtual position: cannot resolve a cursor position.
	push_error("MCPCursor.get_global_position: no virtual cursor set and no fallback viewport")
	return Vector2.ZERO
