// proxy/router.mjs — client message routing + call queue (extracted
// from godot-mcp-proxy.mjs, SEE-1334 Phase 0a): handleClaudeMessage state
// machine (handshake passthrough, tools/call interception, warmup holds,
// spawn triggers), FIFO flush/reject, stdin reader.
import * as readline from 'node:readline';
import { S } from './state.mjs';
import { GIVEUP_REARM_ENABLED, PROGRESS_INTERVAL_MS } from './config.mjs';
import { log } from './log.mjs';
import { forwardToNpx, makeErrorResponse, sendToClaude } from './protocol.mjs';
import {
    buildRespawnHintText, currentWarmupTimeout, warmupDiagnostic, warmupHintResponse,
} from './diagnostics.mjs';
import {
    isScreenshotToolsCall, runAutoStepThenForward, screenshotCaptureMode,
} from './screenshot.mjs';
import { answerUiInspectCall, isUiInspectToolsCall } from './ui-inspect.mjs';
import { isExecToolsCall, isGameTimeToolsCall, isInputSequenceToolsCall } from './exec.mjs';
import { execConstraintDigest, precheckExecSource } from '../see1240-exec-constraints.mjs';
import { expandDragInToolsCall } from '../see1240-ui-tools.mjs';
import { persistGiveUpStatus, spawnFailedDiagnostic, triggerEnsureEditor } from './spawn.mjs';
import { beginRestartHold, isRestartToolsCall } from './restart.mjs';
import { shutdown } from './lifecycle.mjs';
import { writeRuntimeState } from './state-file.mjs';
import { RUNTIME_ID } from './config.mjs';

function maybeProgressLog(force = false) {
    const now = Date.now();
    if (!force && now - S.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    S.lastProgressAt = now;
    const elapsed = Math.floor((now - S.startedAt) / 1000);
    const count = S.pendingCalls.length;
    const status = S.warm ? 'warm' : S.recovering ? 'recovering' : S.warmupTimedOut ? 'failed-exit' : 'waiting';
    log(`waiting for editor warmup... ${elapsed}s elapsed, ${count} call(s) queued (${status})`);
}

// SEE-1338 spec v2.1 §3.3 (CALL_BEGIN/CALL_END): every tools/call refreshes
// the on-disk heartbeat (the R1 reaper clock) and bumps updated_at. Cheap
// tmp+rename write; failure never blocks the call path.
function recordCallEvent(kind) {
    if (!RUNTIME_ID) return;
    writeRuntimeState(RUNTIME_ID, {
        heartbeat_at: new Date().toISOString(),
    }, { event: kind });
}

function flushQueue() {
    while (S.pendingCalls.length > 0) {
        const line = S.pendingCalls.shift();
        // SEE-1240 WS-3: a held godot_ui_inspect call flushed once warm must
        // be ANSWERED by the proxy (npx does not know this tool — forwarding
        // would return "Unknown tool"). Re-dispatch through the interception
        // by handing the original message back to handleClaudeMessage; its
        // warm-branch answer path runs now that `warm` is true.
        try {
            const msg = JSON.parse(line);
            if (isUiInspectToolsCall(msg)) {
                handleClaudeMessage(line);
                continue;
            }
        } catch { /* fall through to plain forward */ }
        forwardToNpx(line);
    }
}

// SEE-1111 缺陷 #9: mark the npx transport ready for tools/call and flush any
// calls that were held because the previous instance was dead/mid-restart.
// (Calls held while the editor is still cold stay held; the warmup gate
// releases them.) Idempotent — the flag is latched, so a later 'drain' cannot
// double-flush.
function markNpxTransportReady() {
    S.npxTransportReady = true;
    if (S.warm) {
        flushQueue();
    }
}

// SEE-1111 缺陷 #9 hard-hold fallback: the warmup gate can hold the first
// tools/call for the full COLD_WARMUP_TIMEOUT_MS window, but if npx NEVER
// becomes transport-ready in that window (its spawn/respawn stalled or crashed),
// flushing the held call into a broken transport starts the WS-connect timeout
// against nothing. Reject the held call with a retryable diagnostic so the agent
// re-issues it against a fresh npx. Once npx IS ready, this is a no-op.
function maybeRejectUnreadyHeld() {
    if (S.npxTransportReady) return;
    if (S.npxReadyDropped) return;
    S.npxReadyDropped = true;
    log('WARNING: npx transport never became ready before the first warm; rejecting held first call as retryable.');
    rejectQueue('editor warmup completed but the godot-mcp transport never became ready; please retry', warmupDiagnostic('recovering'));
}

function rejectQueue(reason, data = undefined) {
    while (S.pendingCalls.length > 0) {
        const line = S.pendingCalls.shift();
        try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined) {
                sendToClaude(makeErrorResponse(msg.id, reason, -32000, data));
            }
        } catch (err) {
            log(`WARNING: failed to parse queued call for rejection: ${err.message}`);
        }
    }
}

// SEE-1111 预热提示: a tools/call the proxy answers DIRECTLY (a warmup hint or a
// terminal/spawn_failed error) never reaches npx, so the forwarder will never see
// a response for its id. Clear every per-id tracker — otherwise the id leaks and
// a later npx response (or an unrelated response with the same id) would be
// misinterpreted by the forwarder's editor_busy / hint machinery.
function dropToolsCallId(id) {
    if (id === undefined) return;
    S.screenshotCallIds.delete(id);
    S.execCallIds.delete(id);
    S.toolsCallIds.delete(id);
    S.toolsCallLines.delete(id);
    S.pendingHandshake.delete(id);
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
function handleClaudeMessage(line) {
    log(`DEBUG: stdin line received: ${line.slice(0, 120)}`);
    let msg;
    try {
        msg = JSON.parse(line);
    } catch (err) {
        log(`WARNING: invalid JSON from Claude: ${err.message}`);
        return;
    }
    const method = msg.method || '';
    const id = msg.id;

    if (
        method === 'initialize' ||
        method === 'notifications/initialized' ||
        method === 'notifications/cancelled' ||
        method === 'tools/list' ||
        method === 'prompts/list' ||
        method === 'prompts/get' ||
        method === 'resources/list' ||
        method === 'resources/read' ||
        method === 'resources/templates/list' ||
        method === 'resources/templates/get' ||
        method === 'completion/complete'
    ) {
        // Track warmup-phase handshake requests by id so an npx respawn can replay
        // them; once warmup completes the live npx instance owns them.
        if (id !== undefined && !S.warm && !S.warmupTimedOut) {
            S.pendingHandshake.set(id, line);
        }
        forwardToNpx(line);
        return;
    }

    if (method === 'tools/call') {
        // SEE-1240 WS-3: the proxy-provided godot_ui_inspect tool. Valid only
        // against a warm chain (it composes godot_exec); otherwise fall through
        // to the normal warmup paths so the caller sees the standard diagnostics.
        if (isUiInspectToolsCall(msg)) {
            if (S.warm && S.npxTransportReady) {
                if (id !== undefined) {
                    S.toolsCallIds.add(id);
                    S.toolsCallLines.set(id, line);
                }
                answerUiInspectCall(msg)
                    .then((response) => {
                        if (id !== undefined) {
                            S.toolsCallIds.delete(id);
                            S.toolsCallLines.delete(id);
                        }
                        sendToClaude(response);
                    })
                    .catch((err) => {
                        if (id !== undefined) {
                            S.toolsCallIds.delete(id);
                            S.toolsCallLines.delete(id);
                        }
                        sendToClaude(makeErrorResponse(
                            id,
                            `godot_ui_inspect failed: ${(err && err.message) || err}`,
                            -32000,
                        ));
                    });
                return;
            }
            // Not warm: defer to the normal hold/warmup machinery below (the
            // call stays tracked as a plain tools/call and will be flushed;
            // when it flushes, warm is true and... this same interception runs
            // only for NEW calls — so re-answering for held calls is handled
            // by the flush path forwarding to npx, which fails with unknown
            // tool. To avoid that, keep uiInspectCallIds so the FLUSH re-runs
            // the interception. Simplified: held ui_inspect calls are answered
            // at flush time by the warm flush gate checking this set.
            if (id !== undefined) S.uiInspectCallIds.add(id);
            // fall through to the hold machinery below.
        }
        // SEE-1240 WS-3: drag sugar — expand {drag} entries in godot_input
        // sequence / godot_game_time step timelines into the bridge's wire
        // vocabulary before forwarding. A malformed drag entry answers with a
        // structured error (same style as the bridge's compile errors).
        {
            const expanded = expandDragInToolsCall(msg);
            if (expanded.error) {
                if (id !== undefined) {
                    dropToolsCallId(id);
                    sendToClaude(makeErrorResponse(id, expanded.error, -32602));
                }
                return;
            }
            if (expanded.msg !== msg) {
                msg = expanded.msg;
                line = JSON.stringify(msg);
            }
        }
        // SEE-1070 #7: track screenshot calls so the npx stdout forwarder can
        // append a fallback hint to their error responses (only side-effect
        // exception; Archi ca665f75). SEE-1240 WS-3 extends the same tracking
        // with the capture contract: opt-in auto_step (one game-time frame
        // stepped before the capture so frozen/paused games return a FRESH
        // frame) and success-path freshness metadata + PNG export.
        if (id !== undefined && isScreenshotToolsCall(msg)) {
            S.screenshotCallIds.add(id);
            const args = (msg.params && msg.params.arguments) || {};
            const mode = screenshotCaptureMode({
                warm: S.warm,
                transportReady: S.npxTransportReady,
                autoStepRequested: args.auto_step === true,
            });
            if (mode === 'auto_step') {
                S.screenshotContract.set(id, {
                    forwardedAtMs: Date.now(),
                    autoStepRequested: true,
                    autoStepPerformed: null,
                    requestArgs: args,
                });
                // Opt-in auto-step: one game-time frame step performed by the
                // proxy BEFORE forwarding the capture. The step goes through
                // the fork's godot_game_time tool (frames:1 — exactly one
                // frame whether or not the game is frozen; a running game is
                // unaffected in practice). pendingAutoStepCallIds carries the
                // original line through the internal-call completion so the
                // capture is forwarded only after the step drew the frame.
                S.pendingAutoStepCalls.set(id, { line, msg });
                runAutoStepThenForward(id);
                return;
            } else if (mode === 'enrich') {
                S.screenshotContract.set(id, {
                    forwardedAtMs: Date.now(),
                    autoStepRequested: false,
                    autoStepPerformed: null,
                    requestArgs: args,
                });
            }
        }
        // SEE-1240 WS-6: exec constraint surface. Answered in-band BEFORE the
        // warmup gate (the constraint list is static — no editor needed):
        //   * {action:'help'} — the fork schema has no help action; the proxy
        //     owns it and answers with the SSOT constraint digest.
        //   * {action:'run'} — regex pre-check (mirror of the addon's
        //     MCPExecGuard.scan_source semantics); a violating source is
        //     rejected here naming the violated entries and never reaches the
        //     fork/addon. The addon denylist remains the authoritative gate.
        if (isExecToolsCall(msg)) {
            const execArgs = (msg.params && msg.params.arguments) || {};
            if (execArgs.action === 'help') {
                if (id !== undefined) {
                    sendToClaude({
                        jsonrpc: '2.0',
                        id,
                        result: {
                            content: [{ type: 'text', text: execConstraintDigest() }],
                        },
                    });
                }
                return;
            }
            if (execArgs.action === 'run' && typeof execArgs.source === 'string') {
                const pc = precheckExecSource(execArgs.source);
                if (!pc.ok) {
                    if (id !== undefined) {
                        const why = pc.kind === 'NO_CODE'
                            ? pc.message
                            : `${pc.message}\nFull constraint list — call godot_exec with {action:"help"}:\n${execConstraintDigest()}`;
                        sendToClaude(makeErrorResponse(id, why, -32602));
                    }
                    return;
                }
            }
        }
        // SEE-1070 #8: track exec calls so their responses can carry GDScript
        // pitfall hints (list-comprehension, override-signature, str() truncation).
        if (id !== undefined && isExecToolsCall(msg)) {
            S.execCallIds.add(id);
            // SEE-1240 WS-3: an exec run may mutate game state — record it for
            // the screenshot frame-age contract (set→不 step→capture detection).
            if (((msg.params.arguments || {}).action) === 'run') S.lastMutationAtMs = Date.now();
        }
        // SEE-1240 WS-3: a game_time step/step_until/thaw draws at least one
        // frame — anything captured after it is definitionally post-advance.
        if (isGameTimeToolsCall(msg)) {
            S.lastFrameAdvanceAtMs = Date.now();
        }
        // SEE-1240 WS-3: an input sequence can also change what the next drawn
        // frame shows (button states, hover). Same mutation tracking applies.
        if (isInputSequenceToolsCall(msg)) {
            S.lastMutationAtMs = Date.now();
        }
        // SEE-1085 usability: track every tools/call id so the forwarder can
        // wrap concurrent-client competition errors with editor_busy.
        if (id !== undefined) {
            S.toolsCallIds.add(id);
            S.toolsCallLines.set(id, line); // SEE-1085 §1: original line for takeover re-dispatch
        }
        if (S.warm) {
            // SEE-1134 Q1: an editor-restart call is intercepted at the proxy.
            // The fork CLI consumes the addon's {restarting:true} ack and returns
            // a fire-and-forget TEXT, so detection is by INBOUND call shape, and
            // the response is HELD (never forwarded to Claude) until the relaunched
            // editor is warm and the CLI reconnected — the old "fire-and-forget"
            // contract becomes a blocking, immediately-usable restart.
            if (isRestartToolsCall(msg)) {
                if (S.restartHold) {
                    // A second restart while one is in flight: queue it; it runs
                    // after the current restart completes.
                    S.pendingCalls.push(line);
                    maybeProgressLog(true);
                    return;
                }
                beginRestartHold(msg, line);
                return;
            }
            // During the restart window (ack pending, or the relaunched editor
            // booting) hold EVERY other tools/call: a call racing a dying or cold
            // editor would fail or hang, and flushing one through the hold-to-warm
            // gate must not trigger a fresh spawn (Q2 path B: "no concurrent
            // spawn" — the restarted editor IS the replacement).
            if (S.restartHold) {
                S.pendingCalls.push(line);
                maybeProgressLog(true);
                return;
            }
            // 缺陷 #9: never forward to an npx whose transport is not ready. The
            // godot-mcp CLI's WS connect chain starts ticking at first forward;
            // handing a call to a just-spawned npx (or one mid-restart) starts a
            // ~23s request timeout while the editor is still cold-booting. Hold it
            // in the pending queue instead — the warmup gate flushes it once warm.
            if (!S.npxTransportReady) {
                S.pendingCalls.push(line);
                maybeProgressLog(true);
                return;
            }
            recordCallEvent('CALL_BEGIN');
            forwardToNpx(line);
            return;
        }
        // SEE-1134 Q1: restart in flight and the editor is not warm yet (cold
        // path). Hold the call — never trigger a fresh spawn (the restarted
        // editor rebinds the port itself; spawning here would double-bind 6550)
        // and never reject with a warmup diagnostic (the editor is restarting,
        // not failing). The calls are flushed/rejected when the restart resolves.
        if (S.restartHold) {
            S.pendingCalls.push(line);
            maybeProgressLog(true);
            return;
        }
        // B1 lazy-load (SEE-1085): terminal spawn failure — reject everything
        // with a structured diagnostic so the agent doesn't hot-loop on a
        // persistently broken spawn (e.g. missing worktree).
        // SEE-1240 WS-5 (C9): the terminal no longer ends the road. During the
        // exponential-backoff cooldown the call is answered with the give-up
        // error (fail-fast 首报保留 — spawnLastFailed consumed it, so re-read
        // spawnLastError for the exact original SpawnError); after the cooldown
        // expires this call RE-ARMS the warmup state machine and falls through
        // to the normal trigger path — the call is then HELD by the FIFO and
        // flushed when the re-spawned editor warms (never silently dropped).
        // KOL_GIVEUP_REARM=0 restores the legacy permanent-terminal reject.
        if (S.spawnTerminal || S.giveUpArmedAt > 0) {
            const cooldownLeft = S.giveUpArmedAt > 0 ? (S.giveUpArmedAt + S.giveUpBackoffMs) - Date.now() : 0;
            if (GIVEUP_REARM_ENABLED && S.spawnTerminal === false && cooldownLeft <= 0) {
                // Cooldown expired → re-arm the warmup state machine. Clear only
                // the cooldown WINDOW (giveUpArmedAt); giveUpBackoffMs stays as
                // the exponential base — the next give-up must double FROM it
                // (WS-5 目标2: 退避加深), not restart from the floor.
                S.giveUpArmedAt = 0;
                S.spawnFailedStreak = 0;
                S.spawnFailedBucket = null;
                S.spawnAttempts = 0;
                S.warm = false;
                S.recovering = false;
                S.spawnLastFailed = false;   // first-report already consumed by the cooldown-era call(s)
                S.spawnLastError = null;
                persistGiveUpStatus('rearm', S.spawnFailedBucket || 'cleared', 'cooldown expired; warmup re-armed');
                log(`give-up cooldown expired (count=${S.giveUpCount}); warmup re-armed — this call re-triggers the spawn (WS-5).`);
                // fall through to the normal trigger path below.
            } else {
                if (id !== undefined) {
                    dropToolsCallId(id);
                    if (S.spawnTerminal) {
                        sendToClaude(makeErrorResponse(
                            id,
                            `editor spawn kept failing (${S.spawnFailedBucket}); giving up this run — restart the MCP server to retry`,
                            -32000,
                            spawnFailedDiagnostic(S.spawnFailedBucket, null, true),
                        ));
                    } else {
                        // In-band give-up cooldown: surface the ORIGINAL first-report
                        // error (首报保留) plus the recovery plan so the agent can
                        // decide to retry after the cooldown instead of restarting
                        // the MCP server.
                        sendToClaude(makeErrorResponse(
                            id,
                            `editor spawn kept failing (give-up #${S.giveUpCount}): ${S.giveUpLastReason}; in-band recovery armed — retry after ${Math.ceil(cooldownLeft / 1000)}s cooldown (retryable, no MCP restart needed)`,
                            -32000,
                            Object.assign(spawnFailedDiagnostic(S.spawnFailedBucket, S.spawnLastError, true), {
                                state: 'FAILED_CLEAN',
                                giveup_count: S.giveUpCount,
                                cooldown_until_ms: S.giveUpArmedAt + S.giveUpBackoffMs,
                                backoff_ms: S.giveUpBackoffMs,
                            }),
                        ));
                    }
                }
                return;
            }
        }
        // B1 lazy-load: the first tools/call triggers the editor spawn (once).
        // The call is then HELD in the FIFO (see the hold-to-warm block below)
        // until the warmup gate opens — under the fork's 90s QUICK_TIMEOUT the
        // first call can wait out the cold boot and succeed directly, so no
        // friendly warmup hint is emitted while the editor is genuinely warming.
        // Terminal spawn failure, RECOVERING, and FAILED_EXIT keep their real
        // diagnostics below (误报防护 — those are real failures, never a
        // "warming" hint).
        if (!S.spawnTriggered && !S.recovering && !S.warmupTimedOut) {
            // SEE-1338 spec v2.1 §6: spawn failures carry an exponential
            // backoff (capped 60s). The FIRST post-failure call keeps its
            // priority — the spawnLastFailed one-shot latch matches it, it
            // gets the real diagnostic AND re-triggers the fresh spawn (误报
            // 防护 + attempt 2 walks immediately). The backoff window only
            // gates HOT retries: a later call while the window is still open
            // AND the latch already consumed is answered with retry-after
            // instead of re-spawning.
            const backoffLeft = S.spawnBackoffUntil - Date.now();
            if (backoffLeft > 0 && !S.spawnLastFailed) {
                if (id !== undefined) {
                    dropToolsCallId(id);
                    sendToClaude(makeErrorResponse(
                        id,
                        `editor spawn failed: ${S.spawnFailedBucket}; backoff window active — retry after ${Math.ceil(backoffLeft / 1000)}s (streak ${S.spawnFailedStreak})`,
                        -32000,
                        Object.assign(spawnFailedDiagnostic(S.spawnFailedBucket, S.spawnLastError, false), {
                            retry_after_ms: backoffLeft,
                        }),
                    ));
                }
                return;
            }
            S.spawnBackoffUntil = 0;   // an honored retry clears the window
            if (S.firstCallProgressToken == null) {
                const meta = msg.params && msg.params._meta;
                if (meta && Object.prototype.hasOwnProperty.call(meta, 'progressToken')) {
                    S.firstCallProgressToken = meta.progressToken;
                }
            }
            S.spawnTriggered = true;
            triggerEnsureEditor();
        }
        // SEE-1111 预热提示 误报防护: the last spawn attempt FAILED (non-terminal).
        // The warmup loop has returned to COLD_EMPTY idle (spawnTriggered reset
        // false), so this call is about to re-trigger spawn — but the agent must
        // first see the REAL spawn_failed diagnostic for the attempt that just
        // broke, never a friendly "warming" hint. One-shot: cleared when a fresh
        // spawn attempt begins (triggerEnsureEditor above would set it false only
        // on success, so re-arming is handled by the next failure latch).
        if (S.spawnLastFailed) {
            S.spawnLastFailed = false;
            const lastErr = S.spawnLastError;
            S.spawnLastError = null;
            if (id !== undefined) {
                dropToolsCallId(id);
                sendToClaude(makeErrorResponse(
                    id,
                    `editor spawn failed: ${S.spawnFailedBucket}; will retry on next call`,
                    -32000,
                    spawnFailedDiagnostic(S.spawnFailedBucket, lastErr, false),
                ));
            }
            return;
        }
        // SEE-1111 缺陷 #7/#8: a post-warm editor death means a respawn round is
        // in flight. The editor is NOT cold-warming (it was warm and died) — a
        // generic "冷启动预热" hint would be wrong. Give the distinct restart
        // hint so the agent retries (the retry will re-trigger the spawn).
        if (S.warmEditorDead) {
            if (id !== undefined) {
                dropToolsCallId(id);
                sendToClaude(warmupHintResponse(id, 'warming', buildRespawnHintText()));
            }
            return;
        }
        // SEE-1070 #2: RECOVERING — warmup window exhausted but the editor may
        // still come back. Reject NEW calls immediately with a recovering
        // diagnostic so the client can retry, instead of buffering them behind
        // an indeterminate outage.
        if (S.recovering) {
            if (id !== undefined) {
                dropToolsCallId(id);
                sendToClaude(makeErrorResponse(
                    id,
                    'editor recovering after warmup timeout; please retry',
                    -32000,
                    warmupDiagnostic('recovering'),
                ));
            }
            return;
        }
        if (S.warmupTimedOut) {
            if (id !== undefined) {
                dropToolsCallId(id);
                sendToClaude(makeErrorResponse(
                    id,
                    `editor warmup timed out after ${Math.floor(currentWarmupTimeout() / 1000)}s; please retry`,
                    -32000,
                    warmupDiagnostic('warmup_timed_out'),
                ));
            }
            return;
        }
        // SEE-1111 (hold-to-warm): the editor is warming (spawn triggered, not
        // yet WARM). HOLD the call in the FIFO instead of answering a friendly
        // warmup hint — under the fork's 90s QUICK_TIMEOUT the first call can
        // legitimately wait out the cold boot (proxy holds it, the warmup gate
        // flushes it to npx on WARM, and the agent sees its first call succeed
        // directly). Do NOT dropToolsCallId: the call stays tracked so the
        // forwarder can match the flushed call's response. The warmup timeout
        // branches above (RECOVERING / warmupTimedOut) are the 180s-window
        // fallbacks: if the editor never warms, the held call is rejected with
        // a retryable diagnostic instead of hanging forever.
        S.pendingCalls.push(line);
        maybeProgressLog(true);
        return;
    }

    // Unknown methods: forward to npx rather than silently drop.
    forwardToNpx(line);
}

function startClaudeReader() {
    const rl = readline.createInterface({
        input: process.stdin,
        terminal: false,
        crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
        if (!line.trim()) return;
        handleClaudeMessage(line);
    });
    rl.on('close', () => {
        log('stdin EOF received; shutting down npx...');
        shutdown();
    });
}

export {
    maybeProgressLog,
    flushQueue,
    markNpxTransportReady,
    maybeRejectUnreadyHeld,
    rejectQueue,
    dropToolsCallId,
    handleClaudeMessage,
    startClaudeReader,
    recordCallEvent,
};
