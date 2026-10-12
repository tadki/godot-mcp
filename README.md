# godot-mcp

[![CI](https://github.com/tadki/godot-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/tadki/godot-mcp/actions/workflows/ci.yml)
[![Godot 4.5+](https://img.shields.io/badge/Godot-4.5%2B-478cbf?logo=godotengine&logoColor=white)](https://godotengine.org)
[![Node 20+](https://img.shields.io/badge/Node-20%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Godot editor addon + MCP (Model Context Protocol) server that gives your AI assistant eyes and hands in the editor — and a running game it can actually playtest. Includes a multi-agent **launch control plane** for running several agent sessions against isolated Godot editors on one machine.

## Highlights

- **22 tools, 90 actions** — scene editing, runtime-state inspection, input injection, screenshots, profiling. Read/write split lets you auto-allow every `godot_*_read` tool while writes stay gated.
- **Deterministic observation** — freeze, step, and step-until on the game clock; live state digests instead of screenshot guessing.
- **Multi-agent control plane** — per-agent editor instances, port allocation, sidecar lease lifecycle, proxy that masks editor cold starts.
- **Battle-tested** — 180+ test files across shell/Node/Python, six PR-gate CI jobs including a mutation gate.

## Origins

This project began as a fork of [satelliteoflove/godot-mcp](https://github.com/satelliteoflove/godot-mcp) and has since evolved into an independent repository with its own identity. The upstream project provided the original MCP server and editor addon; everything on top — the multi-agent launch control plane, the sidecar lease lifecycle, the port arbiter and reaper, and the extended test suites — is developed and maintained here. Commit history from the fork period is fully preserved.

## Quick start

```bash
# 1. Build the server
cd server && npm install && npm run build

# 2. Point your MCP client at it (Claude Desktop / Claude Code / VSCode / any stdio client)
#    → see INSTALL.md for per-client configs
```

Then open any Godot 4.5+ project with the addon installed and ask your assistant to do something in the editor. Full walkthrough: [INSTALL.md](INSTALL.md).

## How it fits together

```text
┌─────────────┐   stdio    ┌──────────────┐    WebSocket   ┌─────────────────┐
│ MCP client  │ ⇄          │ server/      │ ⇄              │ Godot editor    │
│ (agent)     │            │ (Node/TS)    │                │ + addon (GDScript)│
└─────────────┘            └──────────────┘                └─────────────────┘
                                 │
                                 ▼
                        launch/ control plane
              per-agent ports · lease lifecycle · arbiter · reaper · proxy
```

| Directory | What lives there |
|---|---|
| `commands/` `core/` | Editor addon (GDScript), loaded by Godot — consumed as-is by downstream projects |
| `server/` | MCP server (Node/TypeScript): stdio ⇄ WebSocket bridge, 22 tools |
| `launch/` | Multi-agent control plane: port allocation, sidecar leases (`.godot/mcp-lease.json`), port arbiter, stale-lease reaper, proxy, editor lifecycle |
| `launch/tests/` | 180+ test files: scripts / hooks / e2e / abtest |
| `docs/` | Architecture, tools reference, runtime-state guide, troubleshooting |

## Multi-agent launch control plane

Each agent session gets its own Godot editor instance on a dedicated port:

- **Port allocation** — static table (`agent-ports.json`) plus a dynamic pool (6560–6609) managed by the port arbiter, with per-runtime identity.
- **Sidecar lease lifecycle** — `configure-mcp-port.sh` writes `.godot/mcp-lease.json` (state=active); `restore-godot-original.sh` releases it; `verify-godot-written-back.sh` gates pushes on it. `project.godot` never carries per-agent runtime state.
- **Reaper** — `reap-stale-leases.sh` reclaims dead-proxy leases, orphaned editors, and headless orphans; ships with an optional systemd timer.
- **Proxy** — `godot-mcp-proxy.mjs` masks 50–60s cold editor starts behind a sub-second MCP initialize, and handles hot reuse/eviction.

Consumer-side hooks (stop-hook sanitize, push guard) live in the consumer repo under `.claude/hooks/`.

## Testing

```bash
bash launch/tests/scripts/test_see1117_sidecar_lifecycle.sh   # example suite
```

Four test trees (see [`launch/tests/`](launch/tests/)):

| Tree | Contents |
|------|----------|
| `scripts/` | Unit/integration: sidecar lifecycle, port arbiter, reaper sweeps, proxy gates |
| `hooks/` | Consumer-hook chain acceptance + stop-hook sanitize isolation |
| `e2e/` | Live-editor and real-machine suites (require a real editor) |
| `abtest/` | A/B behavioral comparisons |

Environment tiers, CI gates (six PR-gate jobs incl. the mutation gate), and the test-timing plan: [docs/ci-test-plan.md](docs/ci-test-plan.md) and [docs/mutation-exemptions.md](docs/mutation-exemptions.md).

## Documentation

| Doc | Contents |
|-----|----------|
| [INSTALL.md](INSTALL.md) | MCP client configs: Claude Desktop, Claude Code, VSCode/Copilot, and more |
| [docs/architecture.md](docs/architecture.md) | How the server, addon, and game bridge fit together |
| [docs/runtime-state-guide.md](docs/runtime-state-guide.md) | Expose game state to agents via `mcp_watch` and `_mcp_state()` |
| [docs/tools/README.md](docs/tools/README.md) | All 22 tools, full API reference |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Connection checklist, CLI smoke test, common fixes |
| [docs/migrating-to-v4.md](docs/migrating-to-v4.md) | Renamed tools, removed actions, allowlist updates |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup, adding tools, release process |
| [server/CHANGELOG.md](server/CHANGELOG.md) | Release history |

## Requirements

- **Godot 4.5+** (addon uses the `Logger` class introduced in 4.5)
- **Node.js 20+**
- Any MCP client that speaks stdio

## Development

```bash
cd server
npm install && npm run build
npm test                # unit + schema-snapshot tests
npm run test:protocol   # wire-level smoke of the built server
```

The vendored addon (`commands/`, `core/`, addon root scripts) is consumed as-is by downstream projects; runtime-behavior changes belong in `launch/` or `server/` and must keep consumers green.

## License

[MIT](LICENSE)
