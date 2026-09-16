# godot-mcp (tadki fork)

[![CI](https://github.com/tadki/godot-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/tadki/godot-mcp/actions/workflows/ci.yml)
[![Godot 4.5+](https://img.shields.io/badge/Godot-4.5%2B-478cbf?logo=godotengine&logoColor=white)](https://godotengine.org)
[![Node 20+](https://img.shields.io/badge/Node-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/tadki/godot-mcp/blob/main/LICENSE)

Fork of [satelliteoflove/godot-mcp](https://github.com/satelliteoflove/godot-mcp) maintained as a **runtime library**: the Godot editor addon, the MCP server, a multi-agent **launch/ control plane** (per-agent port allocation, sidecar lease lifecycle, port arbiter, reaper), and the `launch/tests/` test tree.

Give your AI assistant eyes and hands in the Godot editor — and a running game it can actually playtest.

## Repository layout

```text
tadki/godot-mcp (this fork)    ← runtime library
├── commands/ core/ ...        ← editor addon (GDScript) — loaded by Godot
├── server/                    ← MCP server (Node/TypeScript), stdio ⇄ WebSocket bridge
├── launch/                    ← multi-agent control plane (shell/Node):
│   │                            per-agent ports, sidecar lease (.godot/mcp-lease.json),
│   │                            port arbiter, stale-lease reaper, proxy, editor lifecycle
│   └── tests/                 ← test tree (scripts/ hooks/ e2e/ abtest/) — see below
└── docs/                      ← architecture, tools reference, runtime-state guide
```

The fork carries a patch layer on top of upstream: multi-agent port isolation (SEE-976…1152), sidecar-based lease lifecycle replacing project.godot marker pinning (SEE-1117 Direction 3, SEE-1240 WS-8), a port arbiter/reaper (SEE-1129/1148), and per-agent worktree guards. It is consumed as a vendored addon / git submodule by downstream game projects; nothing on the consumer side duplicates this logic.

## What the server does

21 tools, 86 actions. Full API docs in the [Tools Reference](docs/tools/README.md). Highlights:

| Tool | What it does |
|------|--------------|
| `godot_scene` / `godot_node_read` / `godot_node_edit` | Open, save, inspect and edit scenes and nodes (including instanced sub-scenes) |
| `godot_editor_read` / `godot_editor_edit` | Editor state, selection, screenshots, error log; run/stop/restart |
| `godot_input` | Inject input into the running game: actions, joypad, raw keys, mouse-look, text |
| `godot_runtime_state` | Live game state as JSON: digests, watch windows, signal timelines |
| `godot_game_time` | Freeze, step, and step-until on the game clock — deterministic observation |
| `godot_exec` | Run GDScript inside the running game for test scenario setup |
| `godot_profiler` | Metric snapshots and per-frame time series with spike detection |

Tools split along the read/write boundary: every `godot_*_read` tool can be auto-allowed in your client's permission settings while writes stay gated. See the upstream docs under [docs/](docs/README.md) for the full picture (installation, architecture, runtime-state guide, troubleshooting).

## Multi-agent launch control plane (`launch/`)

This fork's main addition over upstream. Each agent (Claude-Code session) gets a dedicated Godot editor instance on its own port:

- **Port allocation** — `agent-ports.json` static table + dynamic pool (6560–6609) via the port arbiter; per-runtime `runtime_id` identity.
- **Sidecar lease lifecycle** — `configure-mcp-port.sh` writes `<worktree>/.godot/mcp-lease.json` (state=active); `restore-godot-original.sh` releases it; `verify-godot-written-back.sh` gates pushes on it. `project.godot` never carries per-agent runtime state (its tracked `[godot_mcp]` section holds only machine-level bind constants).
- **Reaper** — `reap-stale-leases.sh` reclaims dead-proxy leases, orphaned editors, and headless orphans; optional systemd timer (`godot-mcp-reaper.{service,timer}`).
- **Proxy** — `godot-mcp-proxy.mjs` masks 50–60s cold editor starts behind a <1s MCP initialize, holds the first tools/call until the CLI is connected, and handles hot reuse/eviction.

Consumer-side hooks (stop-hook sanitize, push guard) live in the consumer repo under `.claude/hooks/`.

## Testing (`launch/tests/`)

181 files across four trees (102 shell suites + 69 Node/Python runners + 10 fixtures/docs):

| Tree | Contents |
|------|----------|
| `scripts/` | Unit/integration suites: sidecar lifecycle, port arbiter, reaper sweeps, proxy gates (SEE-1070/1077/1085/1117/1129/1148/1152/1170/1240/1244…) |
| `hooks/` | Consumer-hook chain acceptance (see1273 harness) + stop-hook sanitize isolation suites |
| `e2e/` | Live-editor and real-machine suites (see1240 real-machine client, KOL game-system e2e — require a real editor) |
| `abtest/` | A/B behavioral comparisons |

Run a suite from the repo root:

```bash
bash launch/tests/scripts/test_see1117_sidecar_lifecycle.sh
bash launch/tests/scripts/test_see1117_phase1_marker_lifecycle.sh   # fork checkout: self-contained arms; hook arms need KOL_ROOT
```

Environment tiers (enforced by the CI split in `.github/workflows/launch-ci.yml` [fast, push/PR] and `launch-special.yml` [long / env-bound / drift-watch, dispatch + weekly cron]):

- **Headless / fast** — script-level suites; run on every push/PR.
- **KOL-coupled** — suites that drive KOL-repo resources (`.claude/hooks`, `project.godot`, `.dev/autopilots`); resolve the consumer checkout via `KOL_ROOT` (explicit env, or auto-detected when this repo is checked out as its submodule).
- **Live-editor / real-machine** — `live_*`, `e2e/`, minutes-long soak suites; manual or scheduled dispatch only, never the fast layer.

## Development

```bash
cd server
npm install && npm run build
npm test                # unit + schema-snapshot tests
npm run test:protocol   # wire-level smoke of the built server
```

The vendored addon (`commands/`, `core/`, addon root scripts) is consumed as-is by downstream projects; runtime-behavior changes belong in `launch/` or `server/` and must keep consumers green.

## Documentation

- [Installation Guide](INSTALL.md) — MCP client configs (Claude Desktop, Claude Code, VSCode/Copilot, and more)
- [Architecture Guide](docs/architecture.md) — how the server, addon, and game bridge fit together
- [Runtime State Guide](docs/runtime-state-guide.md) — expose game state to agents via `mcp_watch` and `_mcp_state()`
- [Tools Reference](docs/tools/README.md) — all 21 tools with full API docs
- [Troubleshooting](docs/troubleshooting.md) — connection checklist, CLI smoke test, common fixes
- [Migrating to v4](docs/migrating-to-v4.md) — renamed tools, removed actions, allowlist updates
- [Contributing](CONTRIBUTING.md) — dev setup, adding tools, release process
- [Changelog](server/CHANGELOG.md) — release history

## Requirements

- **Godot 4.5+** (the addon uses the Logger class introduced in 4.5)
- **Node.js 20+**
- Any MCP client that speaks stdio

## License

[MIT](LICENSE)
