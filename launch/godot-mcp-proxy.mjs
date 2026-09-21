#!/usr/bin/env node
// Warmup-aware MCP stdio proxy for the per-agent Godot editor.
//
// SEE-1043 / Plan B+: Claude (stdio) -> this proxy -> npx godot-mcp (stdio) ->
// Godot editor (WS port 6551-6556).
//
// The proxy starts immediately, forwards initialize/tools/list and
// notifications to npx, and holds tools/call in a FIFO queue until the editor
// TCP port is listening. This masks a 50-60s cold Godot editor start behind a
// <1s MCP initialize response, avoiding Claude's 30s MCP init timeout.
//
// Warmup is detected via TCP reachability only (no WS handshake). The addon is
// single-client; a WS handshake probe would occupy the slot and reject the
// real npx client with 4001. The TCP port is accepted as the warm signal because
// the launcher has already run render-stable / orphan gates before exec'ing us.
//
// npx lifecycle (SEE-1043 cold-start fix): npx @satelliteoflove/godot-mcp answers
// initialize/tools/list before it ever touches Godot, and reconnects to the
// editor in the background — so it does not exit merely because Godot is cold.
// To be robust against npx dying for any other reason (spawn glitch, OOM, a
// future package revision) we RESPAWN npx while waiting for warmup instead of
// taking the proxy down. Only once warmup has succeeded does an npx exit become
// a real failure, bounded by HOT_NPX_RESTART_DEADLINE_MS.
//
// SEE-1334 Phase 0a: this entry is a thin assembly layer. The implementation
// lives in ./proxy/*.mjs (config/state/log/protocol/router/spawn/heal/warmup/
// npx/lease/probes/restart/takeover/lifecycle/worktree/diagnostics/errors/
// screenshot/ui-inspect/exec/tools-cache). External invocation (launcher, CI,
// thin-shim, `node godot-mcp-proxy.mjs`) is unchanged; pure local ESM imports
// keep the zero-npm-install direct-run property.
import {
    GODOT_HOST, GODOT_PORT, EDITOR_LOG_FILE, isValidPort,
} from './proxy/config.mjs';
import { log } from './proxy/log.mjs';
import { startNpx } from './proxy/npx.mjs';
import { startClaudeReader } from './proxy/router.mjs';
import { shutdown, startHeartbeat } from './proxy/lifecycle.mjs';
import { startLeaseMonitor } from './proxy/lease.mjs';
import { runWarmupLoop } from './proxy/warmup.mjs';

// Public test seam (SEE-1240 WS-3): re-exported from its new home so existing
// importers of launch/godot-mcp-proxy.mjs keep working unchanged.
export { patchToolsListForTest } from './proxy/tools-cache.mjs';

if (!isValidPort(GODOT_PORT)) {
    log(`ERROR: GODOT_PORT must be set to a valid port (6000-65535), got: ${GODOT_PORT}`);
    process.exit(1);
}

// SEE-1070 #1: refuse the shared default port. Each agent must get its own port
// from agent-ports.json (loaded by the launcher via agent-ports.lib.sh); GODOT_PORT
// == 6550 here means the per-agent allocation never ran and this proxy would
// collide with every other default client on the bridge's single WS slot. The
// addon's own DEFAULT_PORT=6550 stays untouched (upstream default + the
// port_override_enabled=false fallback). --allow-default is an escape hatch for
// deliberate single-instance debugging, not for normal use.
const DEFAULT_PORT = 6550;
const ALLOW_DEFAULT_PORT = process.argv.includes('--allow-default');
if (GODOT_PORT === DEFAULT_PORT && !ALLOW_DEFAULT_PORT) {
    log(
        `ERROR: GODOT_PORT=${DEFAULT_PORT} is the shared default port; refusing to start. `
        + `Set GODOT_PORT to this agent's port from .dev/godot-mcp/launch/agent-ports.json `
        + `(see .dev/godot-mcp/docs/mcp-multi-port-usage.md §2). `
        + `Pass --allow-default to override (not recommended: collides with other clients).`
    );
    process.exit(1);
}

process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });

function main() {
    log(`starting; GODOT_HOST=${GODOT_HOST} GODOT_PORT=${GODOT_PORT} log=${EDITOR_LOG_FILE || '<none>'}`);
    startNpx();
    startClaudeReader();
    startHeartbeat();
    startLeaseMonitor();
    runWarmupLoop().catch((err) => {
        log(`ERROR: warmup loop failed: ${err.message}`);
        shutdown();
    });
}

main();
