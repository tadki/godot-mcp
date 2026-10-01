# godot-mcp E2E Tests

E2E tests for all KingOfLikes game systems, driven from WSL2 through the
`@satelliteoflove/godot-mcp` MCP server against the running Windows Godot
editor. Follows the contract in
[`docs/project/e2e-mcp-workflow.md`](../../../../../docs/project/e2e-mcp-workflow.md).

## Prerequisites

- Windows Godot editor (4.6+) running the KingOfLikes project with the
  `godot_mcp` addon enabled. The MCP panel must show a bound address
  like `<WSL2 gateway>:6550 [WSL]` (the exact IP is auto-detected by the addon
  from the `vEthernet (WSL)` adapter).
- WSL2 with Node.js 20+ and `npx`.
- No other `npx @satelliteoflove/godot-mcp` client connected (the addon
  accepts a single client; stale processes must be killed first).

## Layout

```
.dev/godot-mcp/tests/e2e/godot-mcp/
├── mcp_client.mjs   # shared MCP client wrapper with retry + JSON parse
├── harness.mjs      # tiny test runner: tracks pass/fail, exits 1 on failure
├── run_all.mjs      # orchestrator: runs every test sequentially
├── package.json     # @modelcontextprotocol/sdk dependency
└── tests/
    ├── 01_smoke.mjs          # connectivity + game launch + autoload smoke
    ├── 02_title_screen.mjs   # title scene structure + input map
    ├── 03_new_game.mjs       # profile creation + GameState reset
    ├── 04_hardware.mjs       # definitions + unlock/purchase/upgrade
    ├── 05_economy.mjs        # add likes + EPD auto-settle + LCPS
    ├── 06_save_load.mjs      # slot 7 round-trip via mcp_* helpers
    ├── 07_vendor.mjs         # subsystem init + offer generator + pricing
    ├── 08_shadow_console.mjs # nexus/tunnel CSV load + adjacency graph
    ├── 09_infi.mjs           # InfiService + InfiFactory availability
    ├── 10_sane.mjs           # node data + layouts + adjacency + resolver
    ├── 11_cyberdomain.mjs    # 8x8 container + serialize()
    ├── 12_aidomain.mjs       # 8x8 container + error flow engine
    ├── 13_pause_menu.mjs     # ESC input injection sanity on ProfileCreation
    ├── 14_tag_manager.mjs    # Tag/Effect/Inventory/Registry smoke
    └── 15_title_screen_visibility.mjs # runtime node visibility + screenshot validation
```

## Running

```bash
# Ensure no stale MCP clients
ps -ef | grep godot-mcp | grep -v grep | awk '{print $2}' | xargs -r kill

cd .dev/godot-mcp/tests/e2e/godot-mcp
npm install                       # one-time
node run_all.mjs                  # run all
node tests/01_smoke.mjs           # run a single suite
```

Each test owns its own MCP client connection and tears down the game
(`thaw` + `stop`) before exit, so suites are independent. The orchestrator
waits 2 s between suites to let the previous `npx` process fully disconnect.

## Conventions

- Each suite starts with `editor run frozen=true`, steps a few frames to let
  autoloads settle, then asserts via `godot_exec` + `_mcp_state()`.
- Save/load round-trips use **slot 7** per the e2e-mcp-workflow guide and
  always `mcp_delete_test_snapshot(7)` themselves before and after.
- GDScript in `godot_exec` uses single-statement form with `;` and `for x in y: stmt`
  to avoid tab-vs-space parse errors from JS template strings.
- Structured state reads via `_mcp_state()` / `digest` are preferred; one
  screenshot is used in `15_title_screen_visibility` for frontend render validation.
