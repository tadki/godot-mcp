# Input Tools

Input injection for testing running games: named actions, joypad buttons, analog axes and stick vectors, raw keyboard keys with modifier combos, relative mouse-look, absolute mouse positioning (mouse_move/mouse_button), and text typing. Absolute entries drive the event path only — the polled OS cursor deliberately does not move (DECIDED: docs/design/mouse-input-spike.md); cooperative games adopt MCPCursor/MousePos instead (migration: docs/design/mouse-cursor-coop.md).

## Tools

- [godot_input](#godot_input)

---

## godot_input

Inject input into a running Godot game for testing: named actions (with analog strength), joypad buttons, analog axes, stick vectors, raw keyboard keys (with modifier combos), relative mouse-look (look: [dx, dy], for FPS-camera _input handlers), and ABSOLUTE mouse positioning (mouse_move/mouse_button, viewport/canvas space). Use get_map to discover available input actions and their bindings, sequence to execute inputs with precise timing (optionally with an effect probe that proves the inputs changed game state), or type_text to type into UI elements. Absolute entries drive the EVENT path only (event.position, Control._gui_input, mouse_entered); they deliberately do NOT move the polled OS cursor — games polling get_mouse_position() read the physical pointer, and warping it is off-limits by DECIDED design (docs/design/mouse-input-spike.md); poll-based games adopt the cooperative MCPCursor/MousePos contract instead (migration guide in docs/design/mouse-cursor-coop.md). Last-position semantics: the bridge never clears the virtual cursor (clear_virtual is intentionally never called) — once any absolute entry sets it, the game-side cooperative cursor keeps reporting that position for the rest of the session rather than falling back to the physical cursor mid-session; a click without a prior move seeds from the last known (first use: physical) position.

### Actions

#### `get_map`

List available input actions from the project Input Map

*No parameters.*

#### `sequence`

Execute an input timeline. While the game runs at real speed, keep tightly-timed inputs in ONE call — e.g. the run-starting menu press AND the gameplay that follows — because seconds of uncontrolled game time pass between two separate tool calls. For a window longer than one call can hold, drive input through godot_game_time step instead.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `inputs` | array | Yes | Array of inputs to execute. Each entry is one of: a named ACTION (action_name, optional analog strength), a joypad BUTTON (joy_button), an analog AXIS hold (axis + value), a STICK vector (stick + x/y), a raw KEY (key, e.g. "ctrl+s"), or relative mouse LOOK (look: [dx, dy]) — mix freely on one timeline. Joypad events drive bound actions (with real deadzone math), raw _input handlers, and the polled Input singletons (get_joy_axis / is_joy_button_pressed); key events likewise drive bound actions, _input/_unhandled_input, and Input.is_key_pressed; look events deliver InputEventMouseMotion.relative to _input/_unhandled_input for FPS-camera code (duration_ms >= 16 distributes the delta as a smooth sweep). No physical pad, keyboard, or mouse is needed. Limitation: Input.get_connected_joypads() never reports a virtual pad, so games that gate controller mode on pad DETECTION cannot be switched into it. |
| `report` | string[] | No | Optional effect probe: GDScript expressions evaluated once before the first input and again after the last, to prove the inputs actually changed something (vs. falling into the void — player dead, UI focus elsewhere, wrong action). Reference autoloads by name (e.g. "G.shots", "G.wave") plus `tree`/`root` (e.g. "tree.get_nodes_in_group('enemies').size()"), same context as godot_game_time step_until. Each expression returns {before, after, changed}; the result also carries any_changed. Expressions do NOT short-circuit and a parse/eval error rejects the call. The after-reading is sampled a couple frames past the final input, so only near-immediate effects register — for slower effects use godot_game_time or runtime_state watch. |
| `screenshot_at_ms` | integer[] | No | Optional: millisecond offsets (from sequence start) at which to capture a lossless PNG frame DURING the real-time run. The bridge owns the sequence clock, so it grabs each frame at the right moment and returns them with the result — letting you catch transient visuals (muzzle flashes, explosions, kill banners) that fade long before a separate screenshot call could land. Up to 8 frames, each returned as an image labeled with its actual offset; an offset (like the whole sequence) must fall within the 40000ms single-call window. COST: each frame is a SEPARATE image that persists in context every following turn and never decays; cost scales with resolution (~1 visual token per 28x28px patch), independent of format. Use multi-frame ONLY for transient/animated visuals — a static layout needs exactly ONE frame. Prefer a few frames at a modest screenshot_max_width over many large ones; for frozen/precise inspection use godot_game_time step + screenshot_game instead. |
| `screenshot_max_width` | integer | No | Max width in px for captured frames (default 640). Resolution is the real cost lever (~1 visual token per 28x28px patch; a 640px frame ≈ 300 tokens). 640 catches transient visuals cheaply; raise it when you need to READ text/detail in the frame, lower it only for pure motion where legibility does not matter. |

#### `type_text`

Type text into the focused UI element

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | Yes | Text to type |
| `delay_ms` | integer | No | Delay between keystrokes in milliseconds (default 50) |
| `submit` | boolean | No | Press Enter after typing to submit (for LineEdit text_submitted) |

### Examples

```json
// get_map
{
  "action": "get_map"
}
```

```json
// sequence
{
  "action": "sequence",
  "inputs": [
    {
      "action_name": "example"
    }
  ]
}
```

```json
// type_text
{
  "action": "type_text",
  "text": "example"
}
```

---

## Absolute mouse recipes (SEE-1141 Track D)

`mouse_move` / `mouse_button` place the cursor in **VIEWPORT/canvas space** (the
bridge maps through the viewport's final transform, so the same coordinate lands
on the same canvas pixel under every stretch/content-scale config).

### Grab-offset drag recipe

A drag that grabs an item at an offset (e.g. its top-left corner) must not teleport
the item's anchor to the cursor. Resolve the grab offset **game-side** and encode
it in the coordinates you send:

1. `mouse_move` to `(item_pos + grab_offset)` — hover/hit-testing now points at
   the item (read `item_pos` from `godot_runtime_state`; `grab_offset` is the
   vector from the item origin to the point a real user would grab).
2. `mouse_button` press at the same point with a real `duration_ms`.
3. `mouse_move` entries to each intermediate/final waypoint. The **release
   automatically fires at press start_ms + duration_ms** and reuses the press
   coordinates, so the release does not take its own position: place the drop
   point in the LAST `mouse_move` before the hold expires (or give the hold a
   longer `duration_ms` to leave room for the waypoint moves).
4. Release — nothing to send; it rides the press entry's paired release.

### duration_ms = 0 is a tap (the classic trap)

With `duration_ms: 0` the press and its paired release fire back-to-back in the
same frame — for drag-based UI the button is never observed as held, and the drag
silently becomes a click. Any interaction that must be *held* (drag, hold-to-paint,
long-press) needs a real `duration_ms` on the press entry.

### Keep moves and press/release on separate frames

The equal-time event sort deliberately fires presses before releases at the same
timestamp, but a `mouse_move` sharing the press's `start_ms` may land before or
with the press — order between different entry kinds at equal time is not
guaranteed. Give the press and every move **distinct `start_ms` values spaced
≥ one frame** (e.g. press at 0 with `duration_ms` 400, moves at 50 / 100 / 150 /
200 — the release lands at 400, at least one frame after the last waypoint).
This also lets hover/`mouse_entered` update between waypoints, which drag
previews and grid highlighting typically require.
