# Node Tools

Node inspection and editing tools: read properties and the scene tree, find nodes (live-game tree when playing), update properties, and reparent

## Tools

- [godot_node_read](#godot_node_read)
- [godot_node_edit](#godot_node_edit)

---

## godot_node_read

Inspect scene nodes: read a node's effective properties (including class defaults a .tscn read cannot show), view the full scene tree as the editor sees it (including children inside instanced sub-scenes), and find nodes by name or type — find searches the RUNNING game's live tree (spawned entities included) while a game is playing, otherwise the scene open in the editor. Use it to discover node paths and verify live state. It cannot modify anything; to update properties or reparent a node, use godot_node_edit.

### Actions

#### `get_properties`

Get a node's properties

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_path` | string | Yes | Path to the node |

#### `get_scene_tree`

Full hierarchy of the open scene as the editor sees it, including children inside instanced sub-scenes (a .tscn file read cannot show those). Deep or wide scenes can be large — cap the result with max_depth and/or max_children; any node whose children are cut off carries "truncated_children": <count of omitted direct children> instead of (or alongside) "children".

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `max_depth` | integer | No | Cap recursion depth (root = depth 1). Omit for the full tree. |
| `max_children` | integer | No | Cap how many children are listed per node. Omit to list every child. |

#### `find`

Find nodes by name and/or type. Searches the RUNNING game's live tree when a game is playing (spawned entities included); otherwise searches the scene open in the editor.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name_pattern` | string | No | Glob pattern to match node names, e.g. "*Spawner*", "Turret?" |
| `type` | string | No | Filter by node type, e.g. "CharacterBody2D", "Area2D" |
| `root_path` | string | No | Path to start search from (defaults to scene root) |

### Examples

```json
// get_properties
{
  "action": "get_properties",
  "node_path": "/root/Main/Player"
}
```

```json
// get_scene_tree
{
  "action": "get_scene_tree"
}
```

```json
// find
{
  "action": "find",
  "name_pattern": "*Enemy*"
}
```

---

## godot_node_edit

Modify scene nodes in the editor: update a node's properties, reparent it, add a new node (add_node), attach an existing script (attach_script), connect a signal (connect_signal), or step the editor's undo history (editor_undo / editor_redo — the same stack add_node and attach_script commit into, so MCP scene writes are undoable like native edits; connect_signal is a direct write that does not join the stack). Structure edits go through the editor's own serialization on save, so load_steps/UID/ext_resource stay consistent without hand-editing .tscn. Every write lands in editor memory and returns a revert_hint plus a save hint; persist with godot_scene save. Writes targeting an instanced sub-scene node are rejected with a clear error (those nodes are owned by their sub-scene). To inspect properties, the scene tree, or search for nodes, use godot_node_read.

### Actions

#### `update`

Update a node's properties

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_path` | string | Yes | Path to the node |
| `properties` | Record<string, unknown> | Yes | Properties to set on the node |

#### `reparent`

Move a node to a new parent

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_path` | string | Yes | Path to the node |
| `new_parent_path` | string | Yes | Path to the new parent node |

#### `add_node`

Add a new node to the open scene: instantiated from an engine class or a global class_name script, owned by the scene root (an unset owner makes the node silently vanish from the saved .tscn), and inserted at `index` (default: append). Unknown types return a structured UNKNOWN_TYPE error; writes into an instanced sub-scene are rejected (INSTANCED_SCENE). The edit joins the editor undo history and lands in memory — save with godot_scene save to persist.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `parent_path` | string | Yes | Path to the parent node (the scene root path or "/" adds a root-level child) |
| `node_type` | string | Yes | Engine class name ("Node2D", "Label", "CharacterBody2D", ...) or a project class_name script class |
| `name` | string | No | Node name (must not contain . : @ / or ") |
| `index` | integer | No | Insert position among the parent's children (0 = first). Default: append. |

#### `attach_script`

Attach an EXISTING script to a node (set_script) and return the post-attach property snapshot. Script creation/generation is not supported — write the .gd first, then attach it. Joins the editor undo history; lands in memory until godot_scene save.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_path` | string | Yes | Path to the node |
| `script_path` | string | Yes | Path of an existing script file (res:// or uid://) |

#### `connect_signal`

Connect a signal to a target method as a DIRECT write with CONNECT_PERSIST — the only flag the scene serializer packs into the .tscn [connection] section (an undo-action connect provably does not persist). Unlike the other writes this does NOT join the editor undo history (documented contract: MCP writes bypass the undo stack); the response's revert_hint carries the connection quadruple for a manual disconnect. Lands in memory until godot_scene save. Instanced sub-scene endpoints are rejected.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `node_path` | string | Yes | Path to the node that owns the signal |
| `signal` | string | Yes | Signal name on the source node (e.g. "pressed") |
| `target_path` | string | Yes | Path to the node that owns the handler method |
| `method` | string | Yes | Method name on the target node |

#### `editor_undo`

Undo the editor's last reversible action for the open scene — the SAME EditorUndoRedoManager stack godot_node_edit's add_node/attach_script commit into, so MCP scene writes are undoable exactly like native editor edits. Empty history returns a structured EMPTY_HISTORY error; the response reports the remaining has_undo/has_redo and the action name the NEXT op would consume.

*No parameters.*

#### `editor_redo`

Redo the most recently undone editor action for the open scene (same history stack as editor_undo). Empty redo history returns a structured EMPTY_HISTORY error; the response reports the remaining has_undo/has_redo and the next action name.

*No parameters.*

### Examples

```json
// update
{
  "action": "update",
  "node_path": "/root/Main/Player",
  "properties": {
    "position": {
      "x": 100,
      "y": 50
    }
  }
}
```

```json
// reparent
{
  "action": "reparent",
  "node_path": "/root/Main/Player",
  "new_parent_path": "/root/UI"
}
```

```json
// add_node
{
  "action": "add_node",
  "parent_path": "/root/Main",
  "node_type": "Sprite2D"
}
```

*4 more actions available: `attach_script`, `connect_signal`, `editor_undo`, `editor_redo`*

---

