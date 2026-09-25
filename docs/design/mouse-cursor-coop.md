# Cooperative Virtual Cursor (MCPCursor / MousePos) — Migration Guide

**Status:** companion to the [mouse input spike decision](mouse-input-spike.md) (DECIDED).
**Applies from:** SEE-1141 Track D (absolute `mouse_move` / `mouse_button` in `godot_input`) + SEE-1142 reference implementation.

In one line: injected input drives the **event path** but never the **polled cursor**
— so games that poll the cursor adopt the cooperative **MCPCursor / MousePos**
contract, and `godot_input`'s absolute entries then drive them fully.

---

## Why the polled cursor cannot move (do not re-open this)

| How a game reads the cursor | Driven by injected input? |
|---|---|
| Event path — `event.position`, `Control._gui_input`, `mouse_entered` | ✅ (`mouse_move`/`mouse_button`/`look`) |
| Camera-relative — `.relative`, centre raycast | ✅ (`look`) |
| **Polled absolute** — `Viewport.get_mouse_position()`, `CanvasItem.get_global_mouse_position()` polled in `_process` | ❌ reads the **physical OS cursor**; injection never moves it |

The only engine mechanism that moves the polled cursor is `Input.warp_mouse()` /
`DisplayServer.warp_mouse`, which yanks the developer's real pointer in a shared
editor session — **off-limits by DECIDED design** (2026-06-01, reaffirmed
SEE-1326 M1). This is why `godot_input`'s absolute entries "do nothing" for
polled readers, by design rather than by bug.

## The contract: capability detection + fallback (no reverse dependency)

- The bridge owns an `MCPCursor` node under `/root` (class in
  `game_bridge/mcp_cursor.gd`). Every absolute `mouse_move` / `mouse_button`
  updates it via `set_virtual_global(viewport_pos)` — **in viewport coordinates**,
  same convention as `Viewport.get_mouse_position()`.
- `clear_virtual()` exists but is **intentionally never called** — last-position
  semantics are useful: once an absolute entry has set the cursor, the
  cooperative reader keeps reporting that position for the rest of the session
  instead of silently falling back to the physical cursor mid-session. A click
  without a prior move seeds from the last known position (first use: the
  physical cursor).
- Game-side code reads through its own **MousePos** helper, which does
  capability detection via `get_node_or_null("/root/MCPCursor")` and falls back
  to the physical cursor when the node is absent. Removing the addon leaves
  game behavior byte-identical. The game must not import, reference, or
  hard-code anything else from godot-mcp — one helper file, zero if-branches in
  business code.

## Migration recipe (per call site)

Replace every polled cursor read in gameplay code with the MousePos helper:

| Before | After |
|---|---|
| `CanvasItem.get_global_mouse_position()` | `MousePos.global_pos(self)` (viewport coords, same convention) |
| `CanvasItem.get_local_mouse_position()` | `MousePos.local_pos(self)` |
| `Viewport.get_mouse_position()` (from a non-CanvasItem `Node`) | `MousePos.viewport_pos(node)` |

After migration:

1. `grep` your project for the polled APIs outside the helper and test code —
   it must return **zero hits in business code** (see the KOL scan below for
   the audit shape).
2. Draggables now drive end-to-end under `godot_input` absolute entries; see
   the drag recipe in [`docs/tools/input.md`](../tools/input.md) (grab-offset,
   `duration_ms = 0` tap trap, frame separation).

Reference implementation: KingOfLikes-Godot `utils/mouse_pos.gd` (class
`MousePos`) with adopters in its drag/tooltip/UI systems; E2E guard in its
`tests/e2e/see1142/`.

## Auditing a third-party game: the one-shot polled-read scan

Run once when onboarding a game (this is a **documentation artifact only** — no
project-specific paths may be asserted in godot-mcp code or tests):

```bash
# 1. Business code — every hit is a migration site
grep -rn 'get_global_mouse_position\|get_local_mouse_position\|get_mouse_position' \
  --include='*.gd' . | grep -v 'addons/' | grep -v 'tests/'

# 2. Other polled/warp surfaces (rarer, same verdict)
grep -rn 'Input\.get_last_mouse_velocity\|Input\.get_mouse_position\|warp_mouse\|DisplayServer\.mouse_get_position' \
  --include='*.gd' . | grep -v 'addons/'
```

Classify each hit:

- **Helper fallback** (inside your MousePos file) — correct, keep; this is the
  sole allowed physical read.
- **Test/expectation code** — fine; tests may legitimately read the physical
  API to assert the helper's fallback.
- **Vendored addon internals** (e.g. a testing addon's own input sender) — out
  of scope; they run only under editor-driven tests.
- **Business code** — migrate per the table above.

### Worked example: KingOfLikes scan (2026-09-25, SEE-1348 M1 docs)

Result: **no unmigrated business-code polled reads remain.** Every gameplay
read already routes through `MousePos` (`drag_manager.gd`, `drag_proxy_visual.gd`,
`item_container_visual.gd`, `hardware_widget.gd`, `item_tooltip_host.gd`,
`sane_sanetree.gd`, `sc_shadow_console_sandbox.gd`). Remaining hits are exactly
the allowed classes above (helper fallbacks, unit/e2e expectation reads, GUT
addon-internal logo hover). No action items.

## Semantics summary for tool users

- Absolute entries (`mouse_move`/`mouse_button`) → event path **+** MCPCursor
  update (when the game adopted the contract, polled readers see it too).
- Absolute entries with **no** MCPCursor in the tree → event path only; polled
  readers see nothing (this is the documented ceiling, not a bug).
- The **polled OS cursor** itself never moves, in every configuration.
