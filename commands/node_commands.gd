@tool
extends MCPBaseCommand
class_name MCPNodeCommands

const FIND_NODES_TIMEOUT := 5.0

var _find_nodes_pending := false
var _find_nodes_result: Dictionary = {}


func get_commands() -> Dictionary:
	# connect_signal is SHELVED (SEE-1356 终裁): the persistence binary gate
	# could not be proven across two live rounds (undo-action form failed the
	# [connection]-section proof; the direct-write CONNECT_PERSIST retest was
	# blocked by an unstable runtime session). The function body below is
	# RETAINED for re-enable after a stable runtime session proves the
	# three-step gate — do not re-register until then.
	return {
		"get_node_properties": get_node_properties,
		"find_nodes": find_nodes,
		"update_node": update_node,
		"reparent_node": reparent_node,
		"add_node": add_node,
		"attach_script": attach_script
	}


func get_node_properties(params: Dictionary) -> Dictionary:
	var node_path: String = params.get("node_path", "")
	if node_path.is_empty():
		return _error("INVALID_PARAMS", "node_path is required")

	var node := _get_node(node_path)
	if not node:
		return _error("NODE_NOT_FOUND", "Node not found: %s" % node_path)

	var properties := {}
	for prop in node.get_property_list():
		var name: String = prop["name"]
		if name.begins_with("_") or prop["usage"] & PROPERTY_USAGE_SCRIPT_VARIABLE == 0:
			if prop["usage"] & PROPERTY_USAGE_EDITOR == 0:
				continue

		var value = node.get(name)
		properties[name] = _serialize_value(value)

	return _success({"properties": properties})


func find_nodes(params: Dictionary) -> Dictionary:
	var name_pattern: String = params.get("name_pattern", "")
	var type_filter: String = params.get("type", "")
	var root_path: String = params.get("root_path", "")

	if name_pattern.is_empty() and type_filter.is_empty():
		return _error("INVALID_PARAMS", "At least one of name_pattern or type is required")

	var debugger := _plugin.get_debugger_plugin() as MCPDebuggerPlugin
	if debugger and EditorInterface.is_playing_scene() and debugger.has_active_session():
		return await _find_nodes_via_game(debugger, name_pattern, type_filter, root_path)

	var scene_check := _require_scene_open()
	if not scene_check.is_empty():
		return scene_check

	var scene_root := EditorInterface.get_edited_scene_root()
	var search_root: Node = scene_root

	if not root_path.is_empty():
		search_root = _get_node(root_path)
		if not search_root:
			return _error("NODE_NOT_FOUND", "Root node not found: %s" % root_path)

	var matches: Array[Dictionary] = []
	_find_recursive(search_root, scene_root, name_pattern, type_filter, matches)

	return _success({"matches": matches, "count": matches.size()})


func _find_nodes_via_game(debugger: MCPDebuggerPlugin, name_pattern: String, type_filter: String, root_path: String) -> Dictionary:
	_find_nodes_pending = true
	_find_nodes_result = {}

	if debugger.find_nodes_received.is_connected(_on_find_nodes_received):
		debugger.find_nodes_received.disconnect(_on_find_nodes_received)
	debugger.find_nodes_received.connect(_on_find_nodes_received, CONNECT_ONE_SHOT)
	debugger.request_find_nodes(name_pattern, type_filter, root_path)

	var start_time := Time.get_ticks_msec()
	while _find_nodes_pending:
		await Engine.get_main_loop().process_frame
		if (Time.get_ticks_msec() - start_time) / 1000.0 > FIND_NODES_TIMEOUT:
			_find_nodes_pending = false
			if debugger.find_nodes_received.is_connected(_on_find_nodes_received):
				debugger.find_nodes_received.disconnect(_on_find_nodes_received)
			return _error("TIMEOUT", "Game did not respond within %d seconds" % int(FIND_NODES_TIMEOUT))

	return _find_nodes_result


func _on_find_nodes_received(matches: Array, count: int, error: String) -> void:
	_find_nodes_pending = false
	if not error.is_empty():
		_find_nodes_result = _error("GAME_ERROR", error)
	else:
		_find_nodes_result = _success({"matches": matches, "count": count})


func _find_recursive(node: Node, scene_root: Node, name_pattern: String, type_filter: String, results: Array[Dictionary]) -> void:
	var name_matches := name_pattern.is_empty() or node.name.matchn(name_pattern)
	var type_matches := type_filter.is_empty() or node.is_class(type_filter)

	if name_matches and type_matches:
		var relative_path := scene_root.get_path_to(node)
		var usable_path := "/root/" + scene_root.name
		if relative_path != NodePath("."):
			usable_path += "/" + str(relative_path)

		results.append({
			"path": usable_path,
			"type": node.get_class()
		})

	for child in node.get_children():
		_find_recursive(child, scene_root, name_pattern, type_filter, results)


func update_node(params: Dictionary) -> Dictionary:
	var node_path: String = params.get("node_path", "")
	var properties: Dictionary = params.get("properties", {})

	if node_path.is_empty():
		return _error("INVALID_PARAMS", "node_path is required")
	if properties.is_empty():
		return _error("INVALID_PARAMS", "properties is required")

	var node := _get_node(node_path)
	if not node:
		return _error("NODE_NOT_FOUND", "Node not found: %s" % node_path)

	# SEE-1356 F1 (批 2 实机 QA): update_node missed the INSTANCED_SCENE gate —
	# property writes into an instanced sub-scene's interior silently don't
	# persist (the outer pack drops them). Same gate as the three write
	# commands, scoped to the edited scene: nodes OUTSIDE the edited scene
	# (runtime/play-mode tree) are transient state, not scene-file writes.
	var scene_root := EditorInterface.get_edited_scene_root()
	if scene_root != null and scene_root.is_ancestor_of(node):
		var instanced_check := _reject_instanced_scene_writer(node, scene_root)
		if not instanced_check.is_empty():
			return instanced_check

	for key in properties:
		if key in node:
			var deserialized := MCPUtils.deserialize_value(properties[key])
			node.set(key, deserialized)

	return _success({})


# add_node: scene-structure write per SEE-1356 L4 (§SPEC-L4-01). Three-stage
# instantiation (engine class → class_name script → UNKNOWN_TYPE), the node is
# ALWAYS owned by the edited scene root (an unset owner makes pack() silently
# drop the node — the #1 trap), and `index` selects the insert position.
# The whole edit is one EditorUndoRedoManager action (the editor's own
# SceneTreeDock add path), so Ctrl+Z reverts MCP writes like native edits.
func add_node(params: Dictionary) -> Dictionary:
	var scene_check := _require_scene_open()
	if not scene_check.is_empty():
		return scene_check

	var params_check := _validated_add_params(params)
	if not params_check.is_empty():
		return params_check

	var parent := _get_node(params.get("parent_path", ""))
	if not parent:
		return _error("NODE_NOT_FOUND", "Parent node not found: %s" % params.get("parent_path", ""))

	var scene_root := EditorInterface.get_edited_scene_root()
	var instanced_check := _reject_instanced_scene_writer(parent, scene_root)
	if not instanced_check.is_empty():
		return instanced_check

	var node := instantiate_node_type(params.get("node_type", ""))
	if node == null:
		return _error("UNKNOWN_TYPE", "Unknown node type: %s (not an engine class and not a class_name script)" % params.get("node_type", ""))

	var node_name: String = params.get("name", "")
	if not node_name.is_empty():
		node.name = node_name

	var index: int = int(params.get("index", -1))
	if index > parent.get_child_count():
		return _error("INVALID_PARAMS", "index %d out of range: parent has %d children" % [index, parent.get_child_count()])

	var undo := _plugin.get_undo_redo()
	undo.create_action("MCP add_node")
	undo.add_do_method(parent, "add_child", node)
	if index >= 0:
		undo.add_do_method(parent, "move_child", node, index)
	undo.add_do_method(node, "set_owner", scene_root)
	undo.add_do_reference(node)
	undo.add_undo_method(parent, "remove_child", node)
	undo.commit_action()

	var new_path := str(scene_root.get_path_to(node))
	return _write_result({"command": "add_node", "node_path": new_path}, new_path)


# Boundary validation for add_node's scalar params (required keys + node-name
# character rules); returns an error Dictionary or {} when all pass.
func _validated_add_params(params: Dictionary) -> Dictionary:
	var parent_path: String = params.get("parent_path", "")
	var node_type: String = params.get("node_type", "")
	if parent_path.is_empty() or node_type.is_empty():
		return _error("INVALID_PARAMS", "parent_path and node_type are required")
	var node_name: String = params.get("name", "")
	if not node_name.is_empty():
		var name_check := _validated_node_name(node_name)
		if not name_check.is_empty():
			return name_check
	return {}


# attach_script: attaches an EXISTING script (set_script(load)); code
# generation is a later decision (plan L4 终裁). Returns the post-attach
# script-property snapshot as the caller's verification anchor.
func attach_script(params: Dictionary) -> Dictionary:
	var scene_check := _require_scene_open()
	if not scene_check.is_empty():
		return scene_check

	var node_path: String = params.get("node_path", "")
	var script_path: String = params.get("script_path", "")
	if node_path.is_empty() or script_path.is_empty():
		return _error("INVALID_PARAMS", "node_path and script_path are required")

	var node := _get_node(node_path)
	if not node:
		return _error("NODE_NOT_FOUND", "Node not found: %s" % node_path)

	var scene_root := EditorInterface.get_edited_scene_root()
	var instanced_check := _reject_instanced_scene_writer(node, scene_root)
	if not instanced_check.is_empty():
		return instanced_check

	if not FileAccess.file_exists(script_path):
		return _error("SCRIPT_NOT_FOUND", "Script file not found: %s" % script_path)
	var script: Script = load(script_path)
	if not (script is Script):
		return _error("INVALID_PARAMS", "Resource at %s is not a Script" % script_path)

	var old_script: Script = node.get_script()
	var undo := _plugin.get_undo_redo()
	undo.create_action("MCP attach_script")
	undo.add_do_method(node, "set_script", script)
	undo.add_do_reference(script)
	undo.add_undo_method(node, "set_script", old_script)
	if old_script != null:
		undo.add_undo_reference(old_script)
	undo.commit_action()

	return _write_result({
		"command": "attach_script",
		"node_path": node_path,
		"previous_script": old_script.resource_path if old_script != null else ""
	}, node_path, {"properties": snapshot_script_properties(node)})


# connect_signal — DISABLED, not registered (SEE-1356 终裁: binary gate 未通过，
# 禁用中——待实机三连复验后重启用; see get_commands() note above). The body is
# retained verbatim so re-enabling is a one-line registry change.
#
# Form: DIRECT write with CONNECT_PERSIST — that flag is the only bit the
# scene serializer honors when packing `[connection]` sections into the .tscn
# (plain connect() is runtime-only and silently dropped by save_scene).
# SEE-1356 D-NEW history: the undo-action form (create_action + do=connect +
# undo=disconnect) provably did NOT persist on the real editor chain —
# connect succeeded, save_scene reported Saved, yet the .tscn carried no
# [connection] section. MCP 写不入 undo 栈 (documented contract).
# Revert = manual disconnect using the returned quadruple (revert_hint).
func connect_signal(params: Dictionary) -> Dictionary:
	var scene_check := _require_scene_open()
	if not scene_check.is_empty():
		return scene_check

	var node_path: String = params.get("node_path", "")
	var signal_name: String = params.get("signal", "")
	var target_path: String = params.get("target_path", "")
	var method_name: String = params.get("method", "")
	if node_path.is_empty() or signal_name.is_empty() or target_path.is_empty() or method_name.is_empty():
		return _error("INVALID_PARAMS", "node_path, signal, target_path and method are required")

	var node := _get_node(node_path)
	if not node:
		return _error("NODE_NOT_FOUND", "Node not found: %s" % node_path)
	var target := _get_node(target_path)
	if not target:
		return _error("NODE_NOT_FOUND", "Target node not found: %s" % target_path)

	var scene_root := EditorInterface.get_edited_scene_root()
	for writer: Node in [node, target]:
		var instanced_check := _reject_instanced_scene_writer(writer, scene_root)
		if not instanced_check.is_empty():
			return instanced_check

	if not node.has_signal(signal_name):
		return _error("UNKNOWN_SIGNAL", "Node %s has no signal: %s" % [node_path, signal_name])
	if not target.has_method(method_name):
		return _error("METHOD_NOT_FOUND", "Target %s has no method: %s" % [target_path, method_name])

	var callable := Callable(target, method_name)
	if node.is_connected(signal_name, callable):
		return _error("ALREADY_CONNECTED", "%s is already connected to %s.%s" % [signal_name, target_path, method_name])

	node.connect(signal_name, callable, CONNECT_PERSIST)

	return _write_result({
		"command": "connect_signal",
		"node_path": node_path,
		"signal": signal_name,
		"target_path": target_path,
		"method": method_name
	}, node_path)


# ── shared write-command scaffolding ─────────────────────────────────────────

# Every write command responds with revert_hint + saved + save guidance
# (plan L4 终裁). `saved` is false at response time by definition — MCP writes
# land in the editor's memory and never persist implicitly; save_hint names the
# one canonical persist path (save_scene).
func _write_result(revert_hint: Dictionary, subject_path: String, extra: Dictionary = {}) -> Dictionary:
	var payload := {
		"path": subject_path,
		"saved": false,
		"save_hint": "Write landed in the editor's memory only — call save_scene to persist it",
		"revert_hint": revert_hint
	}
	payload.merge(extra, true)
	return _success(payload)


# Write-operations on nodes inside an instanced sub-scene don't persist: the
# node is owned by the sub-scene's PackedScene, so the outer scene's pack
# silently drops the change. Reject up front with a clear error (§SPEC-L4-03).
func _reject_instanced_scene_writer(writer: Node, scene_root: Node) -> Dictionary:
	if is_instanced_scene_node(writer, scene_root):
		return _error("INSTANCED_SCENE", "Node %s belongs to an instanced sub-scene and cannot be written from the outer scene" % str(scene_root.get_path_to(writer)))
	return {}


# True when `node` is editable only through its own sub-scene, not through the
# currently edited scene (the scene root itself is always writable).
static func is_instanced_scene_node(node: Node, scene_root: Node) -> bool:
	return node != scene_root and node.owner != scene_root


# Pure three-stage instantiation (§SPEC-L4-01): engine-registered class →
# ClassDB; class_name script class → global class list lookup → load().new();
# anything else → null (the caller reports UNKNOWN_TYPE). ClassDB and
# ProjectSettings are reachable headless, so this is unit-testable.
static func instantiate_node_type(node_type: String) -> Node:
	if ClassDB.class_exists(node_type) and ClassDB.is_parent_class(node_type, "Node"):
		return ClassDB.instantiate(node_type)
	for info in ProjectSettings.get_global_class_list():
		if info.get("class") == node_type:
			var instance: Variant = load(info["path"]).new()
			return instance if instance is Node else null
	return null


# Post-attach snapshot of the script's variables (PROPERTY_USAGE_SCRIPT_
# VARIABLE set) with their current values, through the shared serializer.
static func snapshot_script_properties(node: Node) -> Dictionary:
	var snapshot := {}
	for prop in node.get_property_list():
		if prop["usage"] & PROPERTY_USAGE_SCRIPT_VARIABLE == 0:
			continue
		var prop_name: String = prop["name"]
		snapshot[prop_name] = MCPUtils.serialize_value(node.get(prop_name))
	return snapshot


# Godot node names exclude exactly these five characters; reject early so the
# caller gets a structured error instead of a silently path-breaking name.
func _validated_node_name(node_name: String) -> Dictionary:
	for ch in [".", ":", "@", "/", "\""]:
		if node_name.contains(ch):
			return _error("INVALID_PARAMS", "Node name must not contain %s" % ch)
	return {}


func reparent_node(params: Dictionary) -> Dictionary:
	var scene_check := _require_scene_open()
	if not scene_check.is_empty():
		return scene_check

	var node_path: String = params.get("node_path", "")
	var new_parent_path: String = params.get("new_parent_path", "")

	if node_path.is_empty():
		return _error("INVALID_PARAMS", "node_path is required")
	if new_parent_path.is_empty():
		return _error("INVALID_PARAMS", "new_parent_path is required")

	var node := _get_node(node_path)
	if not node:
		return _error("NODE_NOT_FOUND", "Node not found: %s" % node_path)

	var new_parent := _get_node(new_parent_path)
	if not new_parent:
		return _error("NODE_NOT_FOUND", "New parent not found: %s" % new_parent_path)

	var root := EditorInterface.get_edited_scene_root()
	if node == root:
		return _error("CANNOT_REPARENT_ROOT", "Cannot reparent the root node")

	if new_parent == node or node.is_ancestor_of(new_parent):
		return _error("INVALID_REPARENT", "Cannot reparent a node to itself or its descendant")

	node.reparent(new_parent)

	return _success({"new_path": str(root.get_path_to(node))})


