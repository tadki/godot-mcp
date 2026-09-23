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
    GODOT_HOST, GODOT_PORT, EDITOR_LOG_FILE, isValidPort, RUNTIME_ID,
} from './proxy/config.mjs';
import { log } from './proxy/log.mjs';
import { startNpx } from './proxy/npx.mjs';
import { startClaudeReader } from './proxy/router.mjs';
import { shutdown, startHeartbeat } from './proxy/lifecycle.mjs';
import { startLeaseMonitor } from './proxy/lease.mjs';
import { runWarmupLoop } from './proxy/warmup.mjs';
import {
    readRuntimeState, writeRuntimeState, acquireRuntimeLock, releaseRuntimeLock,
    proxyAlive,
} from './proxy/state-file.mjs';
import { decideHandoffAction } from './see1338-handoff.mjs';

// Public test seam (SEE-1240 WS-3): re-exported from its new home so existing
// importers of launch/godot-mcp-proxy.mjs keep working unchanged.
export { patchToolsListForTest } from './proxy/tools-cache.mjs';

// SEE-1338 spec v2.1: expose the startup handoff for unit tests.
export { startupHandoff };

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

// SEE-1338 spec v2.1 §4.2 (D3): the startup handoff — acquire the held-runtime
// logical lock, READ the .state file, and run the decision tree. The disk is
// the ONLY decision input; the connection is the action receipt layered by the
// warmup loop (warm-gate 教训: no component may hold private judgments that
// nobody else can read). HANDOFF adoption marks lastSpawnReused so the
// warm-gate milestone conditions bypass (hot-reuse provably bound long ago).
// The current proxy's pid+startedAt are recorded so the NEXT successor can run
// the AMEND-1 triple liveness check (kill-0 + exe + started_at).
function startupHandoff() {
    if (!RUNTIME_ID) {
        log('handoff: no runtime id (solo/manual) — skipping .state handoff (cold start).');
        return;
    }
    try {
        const lock = acquireRuntimeLock(RUNTIME_ID);
        if (!lock.locked) {
            log(`handoff: held-runtime lock busy (holder=${lock.holder}) — another proxy of this runtime is managing the editor; this proxy will proceed read-only.`);
            return;
        }
        const disk = readRuntimeState(RUNTIME_ID);
        const holderProxy = holderProxyFromDisk(disk);
        const d = decideHandoffAction({ disk, holderProxy });
        log(`handoff decision: ${d.action} (${d.reason}) from disk state=${disk.ok ? disk.state.state : disk.reason}.`);
        if (handleHandoffAction(d)) return;
    } catch (e) {
        // The handoff must never wedge the allocation path (spec §3.4).
        log(`WARNING: startup handoff failed (non-fatal, cold start): ${e && e.message}`);
    }
}

function holderProxyFromDisk(disk) {
    if (!disk.ok || !disk.state.proxy_pid) return null;
    const holder = {
        pid: Number(disk.state.proxy_pid),
        startedAt: disk.state.proxy_pid_started_at
            ? Date.parse(disk.state.proxy_pid_started_at) : null,
    };
    holder.verified = proxyAlive(holder.pid, holder.startedAt);
    return holder;
}

// Returns true when the action ends startup (busy-exit / read-only join).
function handleHandoffAction(d) {
    if (d.action === 'editor_busy') {
        // AMEND-1: 前任在管 — do not touch the editor or the record. The
        // successor exits cleanly; Claude's MCP restart retries later.
        releaseRuntimeLock(RUNTIME_ID);
        log(`ERROR: previous session's proxy still manages this runtime (AMEND-1 guard) — refusing to double-manage. Retry later.`);
        process.exit(1);
    }
    if (d.action === 'join_wait') {
        // Predecessor mid-flight (WARMING/RECOVERING, live proxy): it is
        // bounded by the R2 hard cap; log-and-continue as read-only so we
        // never double-spawn. Full join queues are a P2 refinement.
        log(`handoff: predecessor is mid-flight (${d.reason}) — proceeding read-only; R2 hard cap bounds its outcome.`);
        return true;
    }
    // cold_start / reclaim_dead / handoff_warm: this proxy takes OWNERSHIP
    // of the record now — HANDOFF atomically replaces proxy ownership
    // (spec §3.3 修改阶段). The warmup loop drives the actual connection
    // receipt; the editor is never touched here (no probe, no kill).
    writeRuntimeState(RUNTIME_ID, {
        state: 'COLD',
        port: GODOT_PORT,
        proxy_pid: process.pid,
        proxy_pid_started_at: new Date().toISOString(),
        agent: process.env.GODOT_MCP_AGENT_NAME || process.env.KOL_AGENT_NAME || '',
        issue_id: process.env.KOL_ISSUE_ID || '',
        worktree: process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE || '',
        editor_pid: null,
        editor_pid_started_at: null,
        last_error: null,
    }, { event: 'PROXY_START', detail: `action=${d.action} reason=${d.reason}` });
    // HANDOFF adoption: a prior WARM record we're taking over means the
    // editor provably bound long ago — bypass the warm-gate milestones.
    if (d.action === 'handoff_warm' || d.action === 'reclaim_dead') {
        process.env.GODOT_MCP_HANDOFF_WARM = '1';
    }
    return false;
}

function main() {
    log(`starting; GODOT_HOST=${GODOT_HOST} GODOT_PORT=${GODOT_PORT} log=${EDITOR_LOG_FILE || '<none>'}`);
    startupHandoff();
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
