# QA Assertions Tools

Live-game QA assertion primitives: property assertions, one-shot signal waits with predicates, layout geometry checks, and per-node screenshot crops. All read-only; drives the RUNNING game (freeze included) — not a GUT replacement (GUT owns repo test suites).

## Tools

- [godot_qa](#godot_qa)

---

## godot_qa

Live-game QA assertion primitives for the RUNNING game — the act/observe/verify loop with real-machine oracles: assert_property (node property vs expected, tolerance-aware), wait_for_signal (one-shot signal listen with an optional predicate over declared args; timeout is a clean emitted:false, never an error), assert_layout (visible/onscreen/within_parent/min_size geometry checks as cheap text), and screenshot_node (lossless PNG cropped to one node). All read-only. NOT a GUT replacement: GUT owns repo test suites; godot_qa drives the running game, freeze included (freeze note: gameplay signals do not fire under godot_game_time freeze — waits resolve emitted:false there).

### Actions

#### `assert_property`

Assert a node property against an expected value in the RUNNING game. Numeric and Vector2/3 comparisons support tolerance (default 0.01); the result always carries `actual` (stringified for non-primitives), so a failed assert still tells you what the game held. Read-only oracle — pairs with godot_runtime_state digest for discovery and godot_input for actuation. NOT a GUT replacement: godot_qa drives the RUNNING game (the live-game oracle), GUT owns repo test suites.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Full node path (e.g. "/root/Level/Player"). Absolute /root/... paths reach autoloads. |
| `property` | string | Yes | Property name to read (e.g. "speed", "heart_count", "global_position") |
| `op` | `approx`, `eq`, `ne`, `gt`, `gte`, `lt`, `lte` | No | Comparison: "approx" (default) = \|a-b\| <= tolerance for numbers/vectors, exact == otherwise; "eq"/"ne" exact; "gt"/"gte"/"lt"/"lte" numeric order (false, not an error, for non-numeric operands) |
| `expected` | unknown | Yes | Expected value (number, string, bool, or [x, y] / [x, y, z] for vectors) |
| `tolerance` | number | No | Tolerance for "approx" (default 0.01) |

#### `wait_for_signal`

Wait for ONE emission of a signal on a node in the RUNNING game, with an optional predicate over the signal's DECLARED argument names (e.g. "value > 10" for `signal value_changed(value)`). An emission that fails the predicate keeps the wait running (counted in `rejected`). Resolves emitted:true with stringified args and t_ms, or emitted:false on timeout — a clean negative, never an error. FREEZE SEMANTICS: gameplay signals cannot fire under a godot_game_time freeze; a frozen wait resolves emitted:false at the wall-clock timeout (the documented negative case) — step or thaw first. One wait at a time (a second concurrent wait is an error). Read-only: the connection is torn down on every exit path (hit, timeout, restart, scene exit).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Emitter node path (e.g. "/root/G" for an autoload singleton) |
| `signal` | string | Yes | Signal name on that node — script or built-in (e.g. "body_entered") |
| `predicate` | string | No | Optional Expression over the signal's declared argument names (arity 1-5); e.g. "value > 10", "node == player". Malformed predicates are rejected up front; a runtime predicate failure counts the emission as rejected and reports predicate_failed. |
| `timeout_ms` | integer | No | Wall-clock budget before resolving emitted:false (default 5000, max 30000) |

#### `assert_layout`

Assert layout geometry of a visual node in the RUNNING game (cheap text — no screenshot needed). Checks: "visible" (is_visible_in_tree), "onscreen" (rect intersects the viewport), "within_parent" (rect enclosed by the parent Control, optional tolerance), "min_size" (Control size floors). Defaults to [visible, onscreen] when no checks are given; result always carries the measured rects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Full node path of the visual node (Control preferred) |
| `checks` | object[] | No | Checks to run (default: visible + onscreen) |

#### `screenshot_node`

Capture a lossless PNG cropped to ONE visual node's rect in the RUNNING game — an appearance check for a specific element without the full-frame token cost. Frozen-safe: captures under a game-layer pause and a godot_game_time freeze like screenshot_game. Supports Controls and Node2D items with a get_rect; the result carries the crop rect and a `clamped` flag when the node was partially off-screen. For structure/state prefer godot_node_read / godot_runtime_state (free).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Full node path of the visual node to capture |
| `max_width` | integer | No | Max width in px for the cropped image (default 640). Cost scales with resolution (~1 visual token per 28x28px patch); drop toward 640 to halve per-frame cost, raise only when fine detail is unreadable. |

### Examples

```json
// assert_property
{
  "action": "assert_property",
  "path": "/root/Main/Player",
  "property": "example",
  "expected": null
}
```

```json
// wait_for_signal
{
  "action": "wait_for_signal",
  "path": "/root/Main/Player",
  "signal": "body_entered"
}
```

```json
// assert_layout
{
  "action": "assert_layout",
  "path": "/root/Main/Player"
}
```

*1 more actions available: `screenshot_node`*

---

