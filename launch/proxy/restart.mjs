// proxy/restart.mjs — SEE-1134 Q1/Q2 editor-restart proxy-hold
// (extracted from godot-mcp-proxy.mjs, SEE-1334 Phase 0a): holds the restart
// call's response until the relaunched editor is warm and the CLI reconnected.
import { S } from './state.mjs';
import { GODOT_HOST, GODOT_PORT, PROBE_INTERVAL_MS, RESTART_HOLD_TIMEOUT_MS } from './config.mjs';
import { log } from './log.mjs';
import { forwardToNpx, makeErrorResponse, sendToClaude } from './protocol.mjs';
import { dropToolsCallId, flushQueue } from './router.mjs';
import { warmupDiagnostic } from './diagnostics.mjs';
import { wsProbe } from './probes.mjs';
import { cliConnectSignalExpected } from './npx.mjs';

// SEE-1134 Q1: detect a godot_editor_edit restart tools/call. The fork CLI
// consumes the addon's {restarting:true} ack and returns a fire-and-forget TEXT,
// so the proxy cannot recognize the restart by the ack payload — it must match
// the INBOUND call shape (tool name + action) before forwarding.
function isRestartToolsCall(msg) {
    const params = msg && msg.params;
    if (!params || typeof params !== 'object') return false;
    if (params.name !== 'godot_editor_edit') return false;
    const args = params.arguments;
    return !!args && typeof args === 'object' && args.action === 'restart';
}

// ---- SEE-1134 Q1/Q2 path B: editor-restart proxy-hold ----
//
// Contract change: godot_editor_edit restart was "fire-and-forget" (the fork CLI
// folds the addon's {restarting:true} ack into a TEXT result and the bridge
// auto-reconnects). Atlas Q1 requires a BLOCKING, immediately-usable restart:
// the proxy holds the restart call's response until the relaunched editor is
// warm and the CLI reconnected, then answers {restarted:true} (or
// {restarted:false, reason:'timeout'} after RESTART_HOLD_TIMEOUT_MS, which is
// aligned with the lease grace window). The addon side is unchanged (return-then-
// quit, with Q2 path A releasing the WS port first).

function beginRestartHold(msg, line) {
    const id = msg.id;
    const hold = {
        id,
        phase: 'ack-pending',
        deadline: Date.now() + RESTART_HOLD_TIMEOUT_MS,
        timer: null,
        resolved: false,
    };
    S.restartHold = hold;
    // Safety net for the ack-never-comes case (npx died before the addon acked):
    // the held call must still resolve instead of leaking into a client hang.
    hold.timer = setTimeout(() => {
        if (!hold.resolved) {
            log(`WARNING: editor restart hold timed out awaiting the addon ack (${RESTART_HOLD_TIMEOUT_MS}ms); answering {restarted:false, reason:'timeout'}.`);
            finishRestartHold(hold, { restarted: false, reason: 'timeout' });
        }
    }, RESTART_HOLD_TIMEOUT_MS);
    log(`restart: intercepting godot_editor_edit restart id=${id}; holding response, forwarding to addon.`);
    forwardToNpx(line);
}

// Single completion point for a held restart call: answer the client, clear the
// hold, then flush (success) or reject (failure) the calls held during the
// window. Idempotent — the first caller wins.
// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
function finishRestartHold(hold, result) {
    if (!hold || hold.resolved) return;
    hold.resolved = true;
    if (hold.timer) { clearTimeout(hold.timer); hold.timer = null; }
    if (S.restartHold === hold) S.restartHold = null;
    sendToClaude({
        jsonrpc: '2.0',
        id: hold.id,
        result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
        },
    });
    log(`restart: answered held restart id=${hold.id} -> ${JSON.stringify(result)}.`);
    if (result.restarted) {
        if (S.pendingCalls.length > 0) {
            log(`restart: flushing ${S.pendingCalls.length} call(s) held during the restart window.`);
            flushQueue();
        }
    } else {
        // Reject each held call with a retryable diagnostic and drop its per-id
        // trackers (the call was never forwarded during the window, so no npx
        // response will come to clear them).
        while (S.pendingCalls.length > 0) {
            const heldLine = S.pendingCalls.shift();
            try {
                const heldMsg = JSON.parse(heldLine);
                if (heldMsg.id !== undefined) {
                    dropToolsCallId(heldMsg.id);
                    sendToClaude(makeErrorResponse(
                        heldMsg.id,
                        `editor restart failed (${result.reason}); please retry`,
                        -32000,
                        warmupDiagnostic('recovering'),
                    ));
                }
            } catch (err) {
                log(`WARNING: failed to parse restart-held call for rejection: ${err && err.message}`);
            }
        }
    }
}

// After the addon acks restart_editor, the OLD editor process quits (its grace
// timer ran stop_server + restart_editor) and the relaunched instance rebinds
// GODOT_PORT. The proxy must NOT spawn a replacement — the restarted editor IS
// the replacement, and spawning here would double-bind 6550 (the "no concurrent
// spawn" Q2 path B requires). So we pre-position the warm state
// (beginWarmEditorRespawn) and WATCH for the new editor, bounding the watch by
// the restart hold deadline. Phases:
//   1. port goes cold  — the old process has quit and released the port;
//   2. port is back    — the relaunched editor's WS accepts a handshake;
//   3. CLI reconnects  — npxCliConnected flips true (we STOP probing in phase 2
//                        to free the addon's single WS slot for the CLI,
//                        mirroring the warmup flush gate). Returns true only then.
// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
async function driveRestartRespawn(hold) {
    // SEE-1134 Q1 (real-device fix): do NOT call beginWarmEditorRespawn() here.
    // That helper sets warmEditorDead=true which the resident runWarmupLoop
    // responds to by triggering a fresh editor spawn via configure/start mock —
    // that fights driveRestartRespawn (which only wants to wait for the port to
    // cycle). driveRestartRespawn drives its own state: warm stays true (the
    // relaunched editor will rebind the same port), and we let the resident
    // warmupLoop idle until either the CLI reconnects or we time out.
    log(`restart: waiting for old editor port ${GODOT_PORT} to go cold (relaunched instance booting).`);
    let coldConfirmed = false;
    let coldFailures = 0;
    while (!S.shutdownRequested && Date.now() < hold.deadline) {
        if (!coldConfirmed) {
            const alive = await wsProbe();
            if (alive) {
                coldFailures = 0; // old editor still alive (0.3s grace + teardown lags); keep waiting
            } else {
                coldFailures += 1;
                if (coldFailures >= 2) {
                    coldConfirmed = true;
                    log(`restart: old editor port is cold; waiting for the relaunched instance to rebind ${GODOT_PORT}.`);
                }
            }
        } else {
            const up = await wsProbe();
            if (up) {
                S.warm = true;
                S.warmAt = Date.now();
                S.warmEditorDead = false;
                log(`restart: relaunched editor detected warm on ${GODOT_HOST}:${GODOT_PORT}; waiting for godot-mcp CLI to reconnect.`);
                // Stop probing (the slot belongs to the CLI now) and wait for the
                // CLI's own reconnect signal, exactly like the warmup flush gate.
                while (!S.shutdownRequested && Date.now() < hold.deadline) {
                    if (S.npxCliConnected || !cliConnectSignalExpected()) {
                        return true;
                    }
                    await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
                }
                return false; // deadline passed while waiting for the CLI reconnect
            }
            // Relaunched editor still booting; keep probing.
        }
        await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
    }
    return false;
}

export {
    isRestartToolsCall,
    beginRestartHold,
    finishRestartHold,
    driveRestartRespawn,
};
