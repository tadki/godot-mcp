# godot-mcp Documentation

MCP (Model Context Protocol) server for Godot Engine integration.

## Overview

This server provides **22 tools** for AI-assisted Godot development.

## Quick Links

- [Claude Code Setup Guide](claude-code-setup.md) - Configure your project for AI-assisted development
- [Tools Reference](tools/README.md) - All available MCP tools
- [Architecture Guide](architecture.md) - How the server, addon, and game bridge fit together
- [Troubleshooting](troubleshooting.md) - Connection checklist, CLI smoke test, common fixes

## Tool Categories

| Category | Tools | Description |
|----------|-------|-------------|
| [Scene](tools/scene.md) | 1 | Scene management tools |
| [Node](tools/node.md) | 2 | Node manipulation and script attachment tools |
| [Editor](tools/editor.md) | 2 | Editor control, debugging, and screenshot tools |
| [Project](tools/project.md) | 1 | Project information tools |
| [Animation](tools/animation.md) | 2 | Animation query, playback, and editing tools |
| [TileMapLayer/GridMap](tools/tilemap.md) | 4 | TileMapLayer and GridMap editing tools (uses Godot 4.3+ TileMapLayer, not deprecated TileMap) |
| [Resource](tools/resource.md) | 1 | Resource inspection tools for SpriteFrames, TileSet, Materials, etc. |
| [Scene3D](tools/scene3d.md) | 1 | 3D spatial information and bounding box tools |
| [Documentation](tools/docs.md) | 1 | Fetch Godot Engine documentation with smart extraction |
| [Input](tools/input.md) | 1 | Input injection for testing running games: named actions, joypad buttons, analog axes and stick vectors, raw keyboard keys with modifier combos, relative mouse-look, absolute mouse positioning (mouse_move/mouse_button), and text typing. Absolute entries drive the event path only — the polled OS cursor deliberately does not move (DECIDED: docs/design/mouse-input-spike.md); cooperative games adopt MCPCursor/MousePos instead (migration: docs/design/mouse-cursor-coop.md). |
| [Profiler](tools/profiler.md) | 1 | Performance profiling: snapshots, per-frame time series with spike detection, active process inspection, signal connections |
| [Runtime State](tools/runtime-state.md) | 1 | Observe live game entity state as structured JSON — positions, velocities, animation state, and custom _mcp_state() data. Works out of the box for both 2D and 3D scenes (the auto fallback surfaces visible 3D world nodes — meshes, gridmaps, cameras, lights, physics bodies and areas — not just UI). Much cheaper than screenshots. |
| [QA Assertions](tools/qa.md) | 1 | Live-game QA assertion primitives: property assertions, one-shot signal waits with predicates, layout geometry checks, and per-node screenshot crops. All read-only; drives the RUNNING game (freeze included) — not a GUT replacement (GUT owns repo test suites). |
| [Game Time Control](tools/game-time.md) | 1 | Deterministic game-clock control: freeze the running game, step a bounded slice of game time (or step until a condition holds) with inputs riding inside the window, then thaw — so observation is not racing ahead between tool calls. |
| [Game Script Execution](tools/exec.md) | 1 | Run GDScript inside the running game for test scenario setup: one-shot state mutations plus persistent holder-managed nodes, behind a denylist accident guard. |
| [Mesh Validation](tools/validate-meshes.md) | 1 | Detect silently corrupt procedurally generated mesh data (inside-out winding, dropped triangles, degenerate UVs, NaN normals/tangents) that renders without errors and masquerades as lighting problems. Findings carry their likely cause and fix; a cheap scene-load sniff also attaches one-line warnings to game screenshots. |

## Installation

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "godot-mcp": {
      "command": "npx",
      "args": ["-y", "@satelliteoflove/godot-mcp"]
    }
  }
}
```

## Requirements

- Godot 4.5+ (required for Logger class)
- godot-mcp addon installed and enabled in your Godot project

---

*This documentation is auto-generated from tool definitions.*
