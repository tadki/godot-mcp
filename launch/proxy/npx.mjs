// proxy/npx.mjs — godot-mcp child lifecycle (extracted from
// godot-mcp-proxy.mjs, SEE-1334 Phase 0a): command resolution, fork-CLI
// detection, spawn/respawn with cold+hot budgets, stdout response interception
// (cache, hints, takeover, restart ack, timeline echo).
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import path from 'node:path';
import { S } from './state.mjs';
import {
    FORK_CLI_PATH, HOT_NPX_RESTART_DEADLINE_MS, KOL_PROGRESS_PROTOCOL,
    NPX_RESTART_BACKOFF_MS, TAKEOVER_RETRY_MS, TAKEOVER_TIMEOUT_MS,
} from './config.mjs';
import { log, stageLog } from './log.mjs';
import { flushNpxWriteBuffer, forwardToNpx, replayHandshake } from './protocol.mjs';
import { markNpxTransportReady, rejectQueue } from './router.mjs';
import {
    maybeRefreshToolsCache, patchToolsList, resolveToolsCacheRefresh, writeToolsCache,
} from './tools-cache.mjs';
import { augmentScreenshotError } from './screenshot.mjs';
import { augmentExecResult, execHintsForText } from './exec.mjs';
import {
    augmentEditorBusyError, augmentToolsCallError, isEditorBusyError, isEditorGoneError,
} from './errors.mjs';
import {
    attemptTakeoverProbe, drainTakeoverWaiters, enterTakeoverWaiter, failTakeover,
} from './takeover.mjs';
import { driveRestartRespawn, finishRestartHold } from './restart.mjs';
import { beginWarmEditorRespawn } from './spawn.mjs';
import { buildWarmupTimeline } from './diagnostics.mjs';
import { resolveWorktreeForSpawn } from './worktree.mjs';
import { enrichScreenshotResponse, spliceEnrichment } from '../see1240-screenshot-contract.mjs';
import { resolveGodotMcpCommand } from '../godot-mcp-resolve.mjs';
import { stageOrdinal } from '../warmup-stage-parser.mjs';

// SEE-1085 usability: resolve how to launch godot-mcp once (override → local
// install → npx cache → npx fallback). Direct `node <bin>` skips npx's ~2.9s
// cold overhead (measured) when the package is cached, cutting the cold MCP
// handshake from ~6s toward ~0.6s. Cached at first use so an npx respawn reuses
// the same resolution (the cache does not move during a proxy run).

function getGodotMcpCommand() {
    if (!S.resolvedGodotMcpCmd) {
        S.resolvedGodotMcpCmd = resolveGodotMcpCommand();
        log(`launching godot-mcp via ${S.resolvedGodotMcpCmd.source}`);
    }
    return S.resolvedGodotMcpCmd;
}

// SEE-1111: the WARM flush gate waits for the CLI's stderr 'Connected to Godot'
// ONLY when the CLI is the owner fork — the only server that (a) emits that
// line and (b) needs the slot-free connect window. Test harnesses inject a MOCK
// npx (PATH) or a stub via KOL_GODOT_MCP_CMD that never logs 'Connected to
// Godot' — waiting for it would hang the flush forever. Detect the fork by the
// resolved command path so mocks flush at WARM as before (pre-fix behavior).
// SEE-1292 AC-DECPL-010 regression fix: the old args.includes('forks/godot-mcp')
// probe went stale when SEE-1273 T2 moved the fork CLI to <submodule>/server/dist/cli.js
// (relative to the submodule itself, no 'forks/' segment). Detection now matches
// the resolved CLI path against the fork CLI identity (the env-overridable
// GODOT_MCP_FORK_CLI / its default submodule-relative path), so the gate holds
// regardless of whether the fork arrived via launcher env wiring or the resolver's
// own default-fork path.
function cliConnectSignalExpected() {
    try {
        const { args } = getGodotMcpCommand();
        if (!Array.isArray(args)) return false;
        const forkCliNorm = path.resolve(FORK_CLI_PATH);
        return args.some((a) => typeof a === 'string' && path.resolve(a) === forkCliNorm);
    } catch {
        return false;
    }
}

function startNpx() {
    // Variable named `npx` for historical continuity; it is the godot-mcp child
    // process regardless of whether it is launched via npx or direct node.
    const { cmd, args } = getGodotMcpCommand();
    stageLog('NPX_SPAWN', `cmd=${cmd}`);
    S.npx = spawn(cmd, args, {
        // stderr piped (not inherited) so the proxy can observe the CLI's own
        // 'Connected to Godot' log line — the direct signal that the CLI's
        // WebSocket to the addon is OPEN. The WARM flush gate keys on this so
        // the held first tools/call is forwarded only once the CLI's sendCommand
        // has a live connection (SEE-1111 cold-start one-shot).
        stdio: ['pipe', 'pipe', 'pipe'],
        // SEE-1111: force the fork's verbose logging on for the child so its
        // 'Connected to Godot' (an info-level line, otherwise gated behind
        // GODOT_MCP_VERBOSE) is emitted to stderr and the flush gate can see it.
        // The proxy forwards every stderr line onward, so the operator-visible
        // stream is unchanged in content (just no longer silent at info level).
        env: { ...process.env, GODOT_MCP_VERBOSE: process.env.GODOT_MCP_VERBOSE || '1' },
    });
    S.npxRunning = true;
    // NOTE: npxTransportReady is NOT set here. spawn() returns before the child
    // has started; the transport is only ready once the child's stdin pipe is
    // actually writable (npxStdinReady=true, set in the 'open'/'drain'/immediate
    // paths below). Until then a tools/call is held by the 缺陷 #9 gate.
    log(`DEBUG: godot-mcp child spawned via ${cmd} (pid=${S.npx.pid || 'unknown'})`);

    // SEE-1111: watch the CLI's stderr for its WS lifecycle. 'Connected to
    // Godot' (the fork logs this on WS open) marks the CLI connected; a
    // 'Disconnected'/'Reconnecting' marks it not-connected again. Every line is
    // forwarded to OUR stderr so nothing seen via 'inherit' is lost.
    if (S.npx.stderr) {
        S.npxCliConnected = false;
        S.toolsCacheRefreshedForSpawn = false; // SEE-1244: each new CLI gets a fresh cache pull
        let errBuf = '';
        S.npx.stderr.on('data', (chunk) => {
            const s = chunk.toString();
            try { process.stderr.write(s); } catch { /* ignore */ }
            errBuf += s;
            let idx;
            while ((idx = errBuf.indexOf('\n')) !== -1) {
                const line = errBuf.slice(0, idx);
                errBuf = errBuf.slice(idx + 1);
                if (/Connected to Godot/.test(line)) {
                    S.npxCliConnected = true;
                    stageLog('NPX_CLI_CONNECTED', `elapsed_ms=${Date.now() - (S.spawnStartedAt || S.startedAt)}`);
                    // SEE-1244 §6.2 (Revy QA defect #1): earliest point where warm
                    // + CLI-connected can both hold → the only reliable moment to
                    // pull the real list and close the cache. Idempotent per spawn.
                    maybeRefreshToolsCache();
                }
                else if (/Disconnected from Godot|Reconnecting to Godot/.test(line)) S.npxCliConnected = false;
            }
        });
    }

    S.npx.stdin.on('error', (err) => {
        log(`ERROR: npx stdin error: ${err.message}`);
        S.npxStdinReady = false;
    });
    S.npx.stdin.on('finish', () => {
        log('DEBUG: npx stdin finished');
        S.npxStdinReady = false;
    });
    S.npx.stdin.on('open', () => {
        log('DEBUG: npx stdin opened');
        S.npxStdinReady = true;
        markNpxTransportReady();
        flushNpxWriteBuffer();
    });
    S.npx.stdin.on('drain', () => {
        if (!S.npxStdinReady) {
            log('DEBUG: npx stdin became drainable');
            S.npxStdinReady = true;
            markNpxTransportReady();
        }
        flushNpxWriteBuffer();
    });
    // Writable streams are created ready; if write() returns true we can treat it
    // as open. Use an immediate probe to set the initial state.
    try {
        const writable = S.npx.stdin.writable && !S.npx.stdin.destroyed;
        if (writable) {
            S.npxStdinReady = true;
            markNpxTransportReady();
            log('DEBUG: npx stdin writable immediately');
        }
    } catch (err) {
        log(`DEBUG: npx stdin writable check error: ${err.message}`);
    }

    S.npx.on('error', (err) => {
        log(`ERROR: npx process failed to start: ${err.message}`);
        S.npxRunning = false;
    });

    S.npx.on('exit', (code, signal) => {
        S.npxRunning = false;
        S.npxStdinReady = false;
        S.npxTransportReady = false;
        S.npxWriteBuffer.length = 0;
        if (!S.shutdownRequested) {
            log(`WARNING: npx exited unexpectedly (code=${code}, signal=${signal}).`);
        }

        // Cold path: still waiting for warmup. Respawn npx with backoff and replay
        // any handshake requests the dead instance never answered, so a transient
        // npx death during a cold boot cannot strand the MCP handshake or take the
        // proxy down. Unbounded until the warmup timeout (separate cold counter so
        // cold churn never eats the small hot-restart budget).
        if (!S.warm && !S.warmupTimedOut && !S.shutdownRequested) {
            S.coldNpxRestarts += 1;
            const backoff = NPX_RESTART_BACKOFF_MS * Math.min(S.coldNpxRestarts, 5);
            log(`npx died during warmup; respawning in ${backoff}ms (cold attempt ${S.coldNpxRestarts}).`);
            setTimeout(() => {
                if (S.warm || S.warmupTimedOut || S.shutdownRequested) return;
                startNpx();
                replayHandshake();
            }, backoff);
            return;
        }

        // Hot path: warmup already succeeded. A dying npx is a real failure; give it
        // a bounded restart budget, then exit so Claude restarts the server against
        // a genuinely dead editor.
        if (S.warm && !S.shutdownRequested) {
            const hotElapsed = Date.now() - S.warmAt;
            if (S.hotNpxRestarts < 3 && hotElapsed < HOT_NPX_RESTART_DEADLINE_MS) {
                S.hotNpxRestarts += 1;
                log(`npx died after warmup; hot-restarting (attempt ${S.hotNpxRestarts}).`);
                setTimeout(() => {
                    if (!S.shutdownRequested) startNpx();
                }, NPX_RESTART_BACKOFF_MS);
                return;
            }
            rejectQueue('npx process exited after editor became warm');
            process.exit(code ?? 0);
        }

        // Warmup timed out / shutdown: drain and exit cleanly.
        rejectQueue('npx process exited before editor became warm');
        process.exit(code ?? 0);
    });

    // npx stdout -> Claude stdout, line-buffered. JSON-RPC over stdio is
    // newline-delimited, so reading line-by-line is safe and gives a single
    // interception point. Drop answered handshake ids so a later npx respawn
    // only replays requests the dead instance never served. SEE-1070 #7: when
    // a response is an error for a tracked screenshot tools/call, append a
    // hint pointing at screenshot-fallback.sh (the proxy's ONLY side-effect
    // exception; Archi ca665f75). All other lines forward verbatim.
    const npxOut = readline.createInterface({
        input: S.npx.stdout,
        terminal: false,
        crlfDelay: Infinity,
    });
    // eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
    npxOut.on('line', async (line) => {
        if (!line.trim()) return;
        log(`DEBUG: npx stdout line: ${line.slice(0, 200)}`);
        let out = line;
        try {
            const msg = JSON.parse(line);
            // SEE-1244 §6.2: the proactive tools-cache refresh response (own id
            // namespace) is consumed here — patch + cache write + list_changed —
            // never forwarded to claude (its id is a shim-side internal).
            if (msg.id !== undefined && typeof msg.id === 'string' && msg.id.startsWith('see1244-tools-cache-')) {
                resolveToolsCacheRefresh(msg);
                return;
            }
            // SEE-1240 WS-3: responses to the ui_inspect internal exec calls
            // are consumed here, never forwarded to Claude (ids are namespaced
            // strings; client ids stay numeric).
            if (msg.id !== undefined && typeof msg.id === 'string' && msg.id.startsWith('see1240-ui-inspect-')) {
                const waiter = S.internalExecWaiters.get(msg.id);
                if (waiter) {
                    S.internalExecWaiters.delete(msg.id);
                    const timer = S.internalExecTimers.get(msg.id);
                    if (timer) { clearTimeout(timer); S.internalExecTimers.delete(msg.id); }
                    waiter(msg.error !== undefined ? { error: msg.error } : msg.result);
                }
                return;
            }
            // SEE-1240 WS-3: patch tools/list results — append godot_ui_inspect,
            // apply the D1 description updates, and surface the appendix note.
            if (msg.result !== undefined && Array.isArray(msg.result.tools)
                && msg.result.tools.some((t) => t && typeof t.name === 'string' && t.name.startsWith('godot_'))) {
                try {
                    msg.result = patchToolsList(msg.result);
                    out = JSON.stringify(msg);
                    // SEE-1244 §6.2: the shim's registration window reads this
                    // cache on the NEXT session's tools/list. Fire-and-forget —
                    // a write failure here must not affect the forwarded reply.
                    writeToolsCache(msg.result.tools);
                } catch (err) {
                    log(`WARNING: tools/list patch failed (forwarding unpatched): ${err && err.message}`);
                }
            }
            if (msg.id !== undefined) {
                S.pendingHandshake.delete(msg.id);
            }
            if (msg.id !== undefined && S.screenshotCallIds.has(msg.id)) {
                S.screenshotCallIds.delete(msg.id); // one response per id
                if (msg.error !== undefined) {
                    msg.error = augmentScreenshotError(msg.error);
                    out = JSON.stringify(msg);
                } else if (S.screenshotContract.has(msg.id)) {
                    // SEE-1240 WS-3: successful capture — stamp freshness
                    // metadata, export the PNG, run the width×height check.
                    // All additions; the original image content is preserved.
                    const info = S.screenshotContract.get(msg.id);
                    S.screenshotContract.delete(msg.id);
                    try {
                        const worktree = await resolveWorktreeForSpawn();
                        const enrichment = worktree
                            ? await enrichScreenshotResponse({
                                resultContent: msg.result && msg.result.content,
                                forwardedAtMs: info.forwardedAtMs,
                                nowMs: Date.now(),
                                autoStepRequested: info.autoStepRequested,
                                autoStepPerformed: info.autoStepPerformed,
                                worktree,
                                requestArgs: info.requestArgs,
                                mutationBeforeCaptureMs: S.lastMutationAtMs,
                                lastFrameAdvanceMs: S.lastFrameAdvanceAtMs,
                            })
                            : null;
                        if (enrichment) {
                            msg.result = spliceEnrichment(msg.result, enrichment);
                            out = JSON.stringify(msg);
                        }
                    } catch (err) {
                        // Enrichment must never break the capture itself —
                        // forward the unmodified success on any failure.
                        log(`WARNING: screenshot contract enrichment failed: ${err && err.message}`);
                    }
                }
            }
            // SEE-1070 #8: exec responses carry hints for known GDScript pitfalls
            // and str()-truncated container returns. Handles both MCP-level errors
            // and the common case where exec errors live inside the result text.
            if (msg.id !== undefined && S.execCallIds.has(msg.id)) {
                S.execCallIds.delete(msg.id); // one response per id
                if (msg.error !== undefined) {
                    const hints = execHintsForText(msg.error.message || '');
                    if (hints) {
                        msg.error = { ...msg.error, message: (msg.error.message || '') + hints };
                        out = JSON.stringify(msg);
                    }
                } else if (msg.result !== undefined) {
                    const aug = augmentExecResult(msg.result);
                    if (aug) {
                        msg.result = aug;
                        out = JSON.stringify(msg);
                    }
                }
            }
            // SEE-1085 usability + §1 takeover: intercept tools/call responses.
            // editor_busy (a concurrent same-agent session holds the addon's single
            // WS slot) is NOT failed immediately when takeover is enabled — the
            // call is withheld and re-dispatched on a backoff, racing to take the
            // slot when the holder releases it (SEE-1070 lease self-exit on the
            // holder is one legitimate release path). On takeover timeout the
            // waiter set is drained with a retryable editor_busy diagnostic.
            // editor_gone and all other errors still get the §2 retryable wrap.
            // One response per id; entries are dropped so a long session cannot
            // leak ids.
            if (msg.id !== undefined && S.toolsCallIds.has(msg.id)) {
                // SEE-1134 Q1: the restart ack (the fork CLI folded the addon's
                // {restarting:true} into a TEXT result) has arrived. Consume it —
                // it is NOT forwarded to Claude; the held restart call is answered
                // only once the relaunched editor is warm and the CLI reconnected.
                if (S.restartHold && S.restartHold.id === msg.id) {
                    S.toolsCallIds.delete(msg.id);
                    S.toolsCallLines.delete(msg.id);
                    S.screenshotCallIds.delete(msg.id);
                    S.execCallIds.delete(msg.id);
                    S.pendingHandshake.delete(msg.id);
                    if (msg.error !== undefined) {
                        const reason = (msg.error && typeof msg.error.message === 'string')
                            ? msg.error.message
                            : 'addon rejected the restart command';
                        log(`WARNING: restart call id=${msg.id} errored (${reason}); no restart in progress — answering {restarted:false, reason}.`);
                        finishRestartHold(S.restartHold, { restarted: false, reason });
                    } else {
                        S.restartHold.phase = 'waiting';
                        log(`restart: addon acknowledged restart id=${msg.id}; pre-positioning respawn watch.`);
                        driveRestartRespawn(S.restartHold).then((ok) => {
                            finishRestartHold(S.restartHold, ok
                                ? { restarted: true }
                                : { restarted: false, reason: 'timeout' });
                        }).catch((err) => {
                            log(`ERROR: restart respawn watch failed: ${err && err.message}`);
                            finishRestartHold(S.restartHold, {
                                restarted: false,
                                reason: String((err && err.message) || err),
                            });
                        });
                    }
                    return;
                }
                const isBusy = msg.error !== undefined && isEditorBusyError(msg.error);
                if (isBusy) {
                    if (TAKEOVER_TIMEOUT_MS > 0) {
                        const wasProbe = S.takeover && S.takeover.probeId === msg.id;
                        S.toolsCallIds.delete(msg.id);
                        // keep toolsCallLines[msg.id] — needed to re-dispatch the probe
                        if (wasProbe) {
                            // Probe lost the slot again; clear probe and reschedule
                            // (or fail if the deadline has passed).
                            S.takeover.probeId = null;
                            if (S.takeover.timer) { clearTimeout(S.takeover.timer); S.takeover.timer = null; }
                            if (Date.now() >= S.takeover.deadline) {
                                failTakeover();
                            } else {
                                S.takeover.timer = setTimeout(attemptTakeoverProbe, TAKEOVER_RETRY_MS);
                            }
                        } else {
                            enterTakeoverWaiter(msg.id);
                        }
                        return; // withhold this busy response from Claude
                    }
                    // Takeover disabled (KOL_TAKEOVER_TIMEOUT_MS=0): immediate §2 diagnostic.
                    S.toolsCallIds.delete(msg.id);
                    S.toolsCallLines.delete(msg.id);
                    msg.error = augmentEditorBusyError(msg.error);
                    out = JSON.stringify(msg);
                } else {
                    // Non-busy response (success, editor_gone, or any other error).
                    S.toolsCallIds.delete(msg.id);
                    S.toolsCallLines.delete(msg.id);
                    if (msg.error !== undefined) {
                        const wrapped = augmentToolsCallError(msg.error);
                        if (wrapped !== msg.error) {
                            msg.error = wrapped;
                            out = JSON.stringify(msg);
                        }
                        // SEE-1111 缺陷 #7: a post-warm editor_gone means the editor's
                        // WebSocket died after warmup. Reset the warm state so the
                        // next call re-spawns the editor instead of the old behavior
                        // of serving retryable editor_gone forever. The call itself
                        // is NOT replayed (drop-with-retry, matching T3).
                        if (S.warm && isEditorGoneError(msg.error)) {
                            beginWarmEditorRespawn();
                        }
                    }
                    // SEE-1110 §2.2: MCP_INITIALIZED(6) — a successful JSON-RPC
                    // response after the WS handshake proves end-to-end MCP over
                    // WebSocket (the addon never logs initialize itself). Marked
                    // once; WARM(7) set by warmupLoop.
                    if (KOL_PROGRESS_PROTOCOL !== 'off'
                        && msg.error === undefined
                        && S.stageTimestamps.WS_HANDSHAKE !== null
                        && stageOrdinal(S.stage) < 6) {
                        if (S.stageTimestamps.MCP_INITIALIZED === null) S.stageTimestamps.MCP_INITIALIZED = Date.now();
                        if (stageOrdinal('MCP_INITIALIZED') > stageOrdinal(S.stage)) S.stage = 'MCP_INITIALIZED';
                    }
                    // If this id was a takeover waiter that just resolved, npx now
                    // holds the WS — re-dispatch any remaining waiters through the
                    // normal flow (they will succeed without re-competition).
                    if (S.takeover && (S.takeover.waiters.has(msg.id) || S.takeover.probeId === msg.id)) {
                        drainTakeoverWaiters(msg.id);
                    }
                }
            }
            // SEE-1110 B5 (§7): once WARM, the FIRST response that completes the
            // warmup-triggering tools/call appends the one-line stage timeline to
            // its result.content. warmupJustCompleted is a one-shot gate — exactly
            // one call carries the echo (E5: subsequent calls stay clean). A
            // warmup-triggered call that ERRORS is echoed via error.data instead
            // (augment path above), so the gate is consumed only on success.
            if (S.warmupJustCompleted && msg.error === undefined && msg.result !== undefined) {
                S.warmupJustCompleted = false;
                if (KOL_PROGRESS_PROTOCOL !== 'off') {
                    const tl = buildWarmupTimeline();
                    const result = msg.result;
                    const newContent = Array.isArray(result.content)
                        ? [...result.content, { type: 'text', text: tl }]
                        : [{ type: 'text', text: tl }];
                    msg.result = { ...result, content: newContent };
                    out = JSON.stringify(msg);
                }
            }
        } catch (err) {
            // Not valid JSON — forward the original line verbatim rather than drop it.
        }
        process.stdout.write(out + '\n');
    });
}

export {
    getGodotMcpCommand,
    cliConnectSignalExpected,
    startNpx,
};
