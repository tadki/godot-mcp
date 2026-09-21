// proxy/probes.mjs — editor liveness probes + render-stable monitor
// (extracted from godot-mcp-proxy.mjs, SEE-1334 Phase 0a): real-WS-handshake
// probe (slot-safe), raw TCP fallback, swap_chain_resize stability gate.
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { S } from './state.mjs';
import {
    EDITOR_LOG_FILE, GODOT_HOST, GODOT_PORT, RENDER_SAMPLE_MS,
    RENDER_STABLE_REQUIRED_MS, RENDER_STABLE_TIMEOUT_MS,
} from './config.mjs';
import { log, stageLog } from './log.mjs';

// SEE-1111 缺陷 #6: a raw TCP probe gets ACCEPTED by the addon's single-slot
// WebSocket server as a `_ws_peer` stuck in STATE_CONNECTING (websocket_server.gd
// `_accept_connection` accepts any TCP stream; `_process_websocket` has no
// STATE_CONNECTING timeout). The real CLI's WS connect then sees `_ws_peer !=
// null` → not stale yet (activity within 45s) → is REJECTED with 4001, and the
// first cold-start tools/call fails "Never successfully connected" (Revy hard
// acceptance). Replacing the raw probe with a REAL WebSocket handshake probe:
//   * probe completes the HTTP Upgrade → addon reaches STATE_OPEN → probe closes
//     → STATE_CLOSED → the slot is RELEASED before the real CLI connects;
//   * probe is accepted but never upgrades (editor not ready) → probe destroys
//     the TCP → next real CLI arrival sees `_peer.get_status() != CONNECTED` →
//     `_is_stale_connection()` → `_force_close_connection()` replaces it;
//   * probe is rejected with 4001 (a real client holds the slot) → the editor
//     is already serving a client → warm-equivalent signal.
// So a complete probe can never leave the addon's slot occupied by a dead peer.
// The addon may log the probe's own handshake as a real one — that is fine, it
// is indistinguishable from a real client and releases promptly.
//
// KOL_WS_PROBE_DISABLE=1 degrades to the old raw-TCP probe for test seams whose
// mock listener only binds a TCP port (it cannot speak HTTP Upgrade).
function wsProbe() {
    if ((process.env.GODOT_MCP_WS_PROBE_DISABLE || process.env.KOL_WS_PROBE_DISABLE) === '1') return tcpProbe();
    // SEE-1114 Q1 (restart-hold): during a restart_hold the CLI is INTENTIONALLY
    // disconnected and the editor is intentionally being torn down — the slot is
    // NOT owned by the CLI. The warm+npxCliConnected short-circuit would falsely
    // report "alive" while the port is in fact cold, which would race
    // driveRestartRespawn into {restarted:false, reason:'timeout'} even though
    // the relaunched editor is on its way back. Probe for real so the restart
    // path observes the port cycle.
    if (S.restartHold) {
        // fall through to real WS handshake below
    } else if (S.warm && S.npxCliConnected) {
        // SEE-1111 (cold-start one-shot): once the editor is WARM and the CLI
        // owns the slot, the CLI IS the liveness signal and probing would
        // poison its slot with 4001.
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        let ws = null;
        let settled = false;
        let timeout = null;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            try { if (ws) ws.close(); } catch (err) { /* ignore */ }
            resolve(ok);
        };
        try {
            // Node >= 22 global WebSocket client (workspace runs v25.9.0); no dep.
            ws = new WebSocket(`ws://${GODOT_HOST}:${GODOT_PORT}`, { perMessageDeflate: false });
        } catch (err) {
            finish(false);
            return;
        }
        timeout = setTimeout(() => finish(false), 3000);
        ws.onopen = () => finish(true);
        ws.onerror = () => finish(false);
        ws.onclose = () => finish(false);
    });
}

function tcpProbe() {
    return new Promise((resolve) => {
        const socket = createConnection({ host: GODOT_HOST, port: GODOT_PORT });
        let resolved = false;

        const finish = (ok) => {
            if (resolved) return;
            resolved = true;
            try { socket.destroy(); } catch (err) { /* ignore */ }
            resolve(ok);
        };

        socket.on('connect', () => finish(true));
        socket.on('error', () => finish(false));
        socket.on('timeout', () => finish(false));
        socket.setTimeout(3000);
    });
}

async function countSwapChainResize() {
    if (!EDITOR_LOG_FILE) return 0;
    try {
        const content = await readFile(EDITOR_LOG_FILE, 'utf-8');
        return (content.match(/swap_chain_resize/g) || []).length;
    } catch (err) {
        return 0;
    }
}

function startRenderStableMonitor() {
    // SEE-1070 #2: clear any prior monitor before starting a fresh one, so the
    // T2 (WARMING -> RECOVERING) transition can re-prove render stability
    // without leaving a stale interval running.
    if (S.renderStableTimer) { clearInterval(S.renderStableTimer); S.renderStableTimer = null; }
    if (!EDITOR_LOG_FILE) {
        S.renderStable = true;
        return;
    }
    S.renderStable = false;
    let prev = 0;
    let stableMs = 0;
    let waitedMs = 0;
    S.renderStableTimer = setInterval(async () => {
        if (S.warm || S.warmupTimedOut || S.shutdownRequested) {
            clearInterval(S.renderStableTimer);
            S.renderStableTimer = null;
            return;
        }
        const curr = await countSwapChainResize();
        if (curr === prev) {
            stableMs += RENDER_SAMPLE_MS;
        } else {
            stableMs = 0;
        }
        prev = curr;
        waitedMs += RENDER_SAMPLE_MS;
        if (stableMs >= RENDER_STABLE_REQUIRED_MS) {
            S.renderStable = true;
            stageLog('RENDER_STABLE_PASS', `waited_ms=${waitedMs}`);
            clearInterval(S.renderStableTimer);
            S.renderStableTimer = null;
            return;
        }
        if (waitedMs >= RENDER_STABLE_TIMEOUT_MS) {
            // Render-stable gate failed; do not block forever. TCP probe is the
            // final signal, but we note the failure on stderr.
            log(`WARNING: editor log keeps producing D3D12 swap_chain_resize errors; render-stable gate failed. Warmup will rely on TCP probe only.`);
            stageLog('RENDER_STABLE_FAIL', `waited_ms=${waitedMs} (gate bypassed, falling back to TCP probe)`);
            S.renderStable = true; // unblock warmup; npx will fail if the editor is truly dead
            clearInterval(S.renderStableTimer);
            S.renderStableTimer = null;
        }
    }, RENDER_SAMPLE_MS);
}

export {
    wsProbe,
    tcpProbe,
    countSwapChainResize,
    startRenderStableMonitor,
};
