// proxy/warmup.mjs — warmup state machine + resident respawn loop
// (extracted from godot-mcp-proxy.mjs, SEE-1334 Phase 0a): cold/hot
// classification, WARM/RECOVERING/FAILED_EXIT transitions, grace-race guard,
// warm liveness probe, post-warm death re-entry.
import { S } from './state.mjs';
import {
    COLD_WARMUP_TIMEOUT_MS, FAILED_EXIT_MS, GIVEUP_REARM_ENABLED, GODOT_HOST, GODOT_PORT,
    GRACE_RACE_BIND_MS,
    GRACE_RACE_GUARD_ENABLED, HOT_WARMUP_TIMEOUT_MS, KOL_PROGRESS_PROTOCOL,
    PROBE_INTERVAL_MS, RECOVERING_HARD_CAP_MS, SPAWN_MAX_ATTEMPTS, WARM_LIVENESS_ENABLED,
    WARM_LIVENESS_FAILURES, WARM_RECOVERING_CLI_TIMEOUT_MS,
} from './config.mjs';
import { STAGE_ENUM } from '../warmup-stage-parser.mjs';
import { log, stageLog } from './log.mjs';
import {
    currentWarmupTimeout, maybeNotifyStageChange, notifyWarmupProgress, warmupDiagnostic,
} from './diagnostics.mjs';
import { flushQueue, maybeProgressLog, maybeRejectUnreadyHeld, rejectQueue } from './router.mjs';
import {
    beginWarmEditorRespawn, evictStaleHolder, forceColdRestart, giveUpAndRearm,
    resetForRespawn,
    triggerEnsureEditor, waitForPortRelease,
} from './spawn.mjs';
import { runRecoveryRound } from './heal.mjs';
import { cliConnectSignalExpected } from './npx.mjs';
import { startRenderStableMonitor, tcpProbe, wsProbe } from './probes.mjs';
import { maybeRefreshToolsCache } from './tools-cache.mjs';
import { resolveWorktreeForSpawn } from './worktree.mjs';
import { writeRuntimeState } from './state-file.mjs';
import { RUNTIME_ID, GODOT_PORT as SOT_PORT } from './config.mjs';

// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
async function warmupLoop() {
    startRenderStableMonitor();

    // SEE-1085 (B1): the editor is NOT spawned at proxy start. Until the first
    // tools/call flips spawnTriggered, an empty port is EXPECTED, not a failure
    // — so no timeout clock runs in COLD_EMPTY. initialize / tools/list are
    // answered by npx immediately and never enter this loop's body. The outer
    // loop lets a non-terminal spawn failure (spawnTriggered reset to false)
    // return to idle so the next tools/call re-triggers the spawn.
    while (!S.warm && !S.warmupTimedOut && !S.shutdownRequested && !S.spawnTerminal) {
        // COLD_EMPTY: idle-probe until the first tools/call triggers spawn.
        while (!S.spawnTriggered && !S.shutdownRequested && !S.spawnTerminal) {
            maybeProgressLog();
            await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
        }
        if (S.shutdownRequested || S.spawnTerminal) break;

        // The first call just flipped spawnTriggered. Start the warmup clock
        // here (not at proxy start) so a cold boot gets the full window.
        if (S.spawnStartedAt === 0) {
            S.spawnStartedAt = Date.now();
            // SEE-1110 §7: EDITOR_SPAWNED(1) is proxy-set at first spawn (the
            // addon is not running yet, so no log line exists for this stage).
            S.stageTimestamps.EDITOR_SPAWNED = S.spawnStartedAt;
        }

        // Classify cold vs hot AFTER spawn is triggered: if the port is already
        // listening a prior/concurrent editor holds it (hot, short window); else
        // cold boot (long window, 50-60s Godot start). Independent budgets so a
        // cold boot is not cut short by the hot window.
        if (S.warmupTimeoutMs === null && !S.shutdownRequested) {
            const initiallyReachable = await tcpProbe();
            S.warmupTimeoutMs = initiallyReachable ? HOT_WARMUP_TIMEOUT_MS : COLD_WARMUP_TIMEOUT_MS;
            if (KOL_PROGRESS_PROTOCOL !== 'off') S.coldMode = !initiallyReachable;
            stageLog('WARM_MODE', `mode=${initiallyReachable ? 'hot' : 'cold'} timeout_ms=${S.warmupTimeoutMs}`);
            log(
                `warmup mode: ${initiallyReachable ? 'hot' : 'cold'} `
                + `(editor ${initiallyReachable ? 'already listening' : 'not yet listening'}; `
                + `timeout ${Math.floor(S.warmupTimeoutMs / 1000)}s).`
            );
            notifyWarmupProgress(0);
        }

        // SEE-1070 #2: warmup state machine (Archi 189be0a2), with the timeout
        // basis changed from startedAt to spawnStartedAt (B1 §4.3).
        //   WARMING    --tcpProbe && renderStable && listening--> WARM (T1: flush buffered forward)
        //              --warmup timeout-->                        RECOVERING (T2: hold buffered calls)
        //   RECOVERING --tcpProbe && renderStable && listening--> WARM (T3: drop buffered w/ retry)
        //              --no TCP for FAILED_EXIT_MS-->             FAILED_EXIT (T4: reject + exit)
        //
        // 缺陷 A (SEE-1111): the WARM transition additionally requires the
        // editor's WS server to be BOUND (`Server listening` stage). Previously
        // TCP reachability + renderStable flushed the first tools/call to npx
        // while the addon was still initializing — the npx godot-mcp CLI's ws
        // connect chain (~30s QUICK_TIMEOUT + reconnect) then failed before the
        // editor bound the port (~22s cold boot), passing a bogus "Not connected"
        // through. Gating on SERVER_LISTENING (when the editor log is available)
        // holds the first call until the editor actually accepts the WS client.
        // Degradation: when the log is unreadable (§6) we cannot observe the
        // stage, so we fall back to the TCP-only signal.
        //
        // 缺陷 #10 (SEE-1111, owner-chosen 方案 1 / proxy-side hold): the first
        // tools/call must additionally wait for the editor's WS HANDSHAKE to be
        // COMPLETE before the flush. The npx godot-mcp CLI's ws-connect chain
        // (QUICK_TIMEOUT_MS=30s hardcoded) starts ticking the moment the first
        // call reaches it; a call flushed while the editor has bound its port but
        // not yet completed a WS handshake can still blow the CLI's short window.
        // Holding the first call until the `WS_HANDSHAKE` milestone is observed
        // (the addon logging `WebSocket handshake complete`) extends the usable
        // first-call window from the CLI's 30s to the proxy's 180s COLD window.
        // MCP_INITIALIZED is proxy-derived: the initialize response from npx (or
        // the §2.2 backfill at WARM) sets it once the handshake is observed, so
        // the gate keys on the WS_HANDSHAKE milestone itself. Degradations match
        // 缺陷 A: hot reuse (lastSpawnReused) provably handshook long ago, and an
        // unreadable log cannot observe the milestone — both bypass the gate.
        let lastTcpOkAt = S.spawnStartedAt;

        // Probe until warm, timeout, or spawn failure resets spawnTriggered.
        // 缺陷 #6 (SEE-1111): the probe is a real WebSocket handshake (wsProbe),
        // NOT a raw TCP connect. A raw connect is accepted by the addon's
        // single-slot WS server as a `_ws_peer` stuck in STATE_CONNECTING (no
        // timeout there), poisoning the slot for the real CLI. wsProbe success
        // additionally proves the addon can complete a handshake RIGHT NOW —
        // the gate opens only when the editor's WS stack is functional, not just
        // bound. KOL_WS_PROBE_DISABLE=1 falls back to the raw TCP probe (test
        // seams whose mock listener only binds a TCP port).
        // SEE-1111 (cold-start one-shot): the addon accepts ONE WebSocket client.
        // Each wsProbe completes a handshake and HOLDS that single slot while the
        // probe socket is open, so probing on every tick makes the addon reject
        // the godot-mcp CLI with 'another client is already connected' (4001) —
        // the CLI never lands. Once the editor is WARM we STOP probing (the
        // probe already proved the addon handshakes) and free the slot for the
        // CLI, then keep looping only until the CLI reports 'Connected to Godot'.
        // `warmFlushed` (not `warm`) is the exit condition so the loop keeps
        // running after warm until the flush actually happens.
        let warmFlushed = false;
        while (S.spawnTriggered && !warmFlushed && !S.warmupTimedOut && !S.shutdownRequested && !S.spawnTerminal) {
            if (S.warm) {
                // Editor warm, probe stopped (slot free). Wait for the CLI to
                // connect; bound the wait with the warmup timeout, then flush.
                const nowWait = Date.now();
                if (!S.recovering && (nowWait - S.spawnStartedAt) >= currentWarmupTimeout()) {
                    S.recovering = true;
                    S.recoveringEnteredAt = nowWait;
                    lastTcpOkAt = nowWait;
                    if (RUNTIME_ID) {
                        writeRuntimeState(RUNTIME_ID, {
                            state: 'RECOVERING',
                            port: SOT_PORT,
                            last_error: 'warmup timed out; entering RECOVERING',
                        }, { event: 'STATE_TRANSITION', fromState: 'WARMING', detail: 'warmup timeout' });
                    }
                    rejectQueue(
                        `editor warmup timed out after ${Math.floor(currentWarmupTimeout() / 1000)}s; please retry`,
                        warmupDiagnostic('recovering'),
                    );
                    log(`WARNING: editor warm but godot-mcp CLI never connected within ${Math.floor(currentWarmupTimeout() / 1000)}s; entering RECOVERING.`);
                }
                // SEE-1134 RECOVERING deadlock fix #1: bound the warm+recovering
                // wait by FAILED_EXIT_MS. The cold branch has its own T4 timeout
                // (recovering && (now - lastTcpOkAt) >= FAILED_EXIT_MS, ~line 2399),
                // but the warm branch had NO equivalent — a CLI that died during
                // recovery spun forever. Symmetric exit so Claude restarts us
                // against a genuinely dead editor.
                // SEE-1338 spec v2.1 §6 (R2 hard-cap backstop): the RECOVERING
                // ABSOLUTE cap (2× cold timeout from entry) overrides every
                // self-heal window inside the state — whichever expires first
                // forces the cold restart. form-B 根治点.
                if (S.recovering && (nowWait - S.recoveringEnteredAt) >= RECOVERING_HARD_CAP_MS) {
                    log(`ERROR: RECOVERING absolute hard cap ${Math.floor(RECOVERING_HARD_CAP_MS / 1000)}s reached (2× cold timeout); forcing cold restart (R2).`);
                    rejectQueue(
                        `RECOVERING hard cap (${Math.floor(RECOVERING_HARD_CAP_MS / 1000)}s) reached; forcing cold restart — please retry`,
                        warmupDiagnostic('failed_exit'),
                    );
                    if (S.forceRestartCount < SPAWN_MAX_ATTEMPTS) {
                        await forceColdRestart('recovering_hard_cap');
                    } else {
                        giveUpAndRearm('recovering_hard_cap', 'RECOVERING hard cap; forced restarts exhausted');
                    }
                    break;   // exit the warmFlushed loop; outer loop re-arms
                }
                if (S.recovering && (nowWait - S.recoveringEnteredAt) >= FAILED_EXIT_MS) {
                    log(`ERROR: warm+recovering did not recover within ${Math.floor(FAILED_EXIT_MS / 1000)}s (FAILED_EXIT); rejecting ${S.pendingCalls.length} buffered call(s).`);
                    rejectQueue(
                        `warm+recovering did not recover within ${Math.floor(FAILED_EXIT_MS / 1000)}s (FAILED_EXIT)`,
                        warmupDiagnostic('failed_exit'),
                    );
                    // SEE-1240 WS-5: in-band give-up + cooldown rearm (legacy exit
                    // under KOL_GIVEUP_REARM=0). Same flow as the cold T4 below.
                    if (GIVEUP_REARM_ENABLED) {
                        S.warmupTimedOut = false;
                        beginWarmEditorRespawn();
                        giveUpAndRearm('warm_recovering_failed_exit', 'warm+recovering FAILED_EXIT');
                        break;   // exit the warmFlushed loop; outer loop re-arms
                    }
                    S.warmupTimedOut = true;
                    process.exit(1);
                }
                // SEE-1134 RECOVERING deadlock fix #2: when the CLI dies while we
                // are warm+recovering, kill it so the existing npx.on('exit')
                // respawn machinery brings up a fresh one (bounded by the hot
                // restart budget). Without a kill we would wait forever on
                // npxCliConnected=true from a dead child.
                if (S.recovering && cliConnectSignalExpected() && !S.npxCliConnected) {
                    if (S.recoveringCliUnconnectedSince === 0) {
                        S.recoveringCliUnconnectedSince = nowWait;
                    } else if ((nowWait - S.recoveringCliUnconnectedSince) >= WARM_RECOVERING_CLI_TIMEOUT_MS
                        && S.npx && S.npxRunning && !S.npx.killed) {
                        log(`WARNING: warm+recovering CLI unconnected for ${Math.floor(WARM_RECOVERING_CLI_TIMEOUT_MS / 1000)}s; killing npx so the hot-respawn path can land one.`);
                        try { S.npx.kill('SIGTERM'); } catch (err) { log(`DEBUG: npx.kill raised ${err && err.message}`); }
                        S.recoveringCliUnconnectedSince = nowWait; // reset; the respawn gets another full window
                    }
                } else if (S.npxCliConnected) {
                    S.recoveringCliUnconnectedSince = 0;
                }
                notifyWarmupProgress();
                maybeProgressLog();
                await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
                // SEE-1117 (Atlas review): align with the line-1993 gateOpen
                // flush condition. `lastSpawnReused` alone must NOT flush here —
                // a fresh proxy that reused a port whose editor is still
                // cold-booting sets lastSpawnReused=true but npxCliConnected is
                // still false (the freshly-spawned npx is racing the cold boot);
                // flushing then forwards the held call to an unconnected npx
                // ("Not connected to Godot", the T+27s fail-fast). The original
                // intent (running proxy reusing a warm editor whose CLI
                // reconnects in <1s) is covered by npxCliConnected itself, so
                // lastSpawnReused is redundant on this branch. Non-fork CLI
                // (!cliConnectSignalExpected()) flushes immediately, unchanged.
                if (!cliConnectSignalExpected() || S.npxCliConnected) {
                    const now2 = Date.now();
                    if (S.recovering) {
                        log(`editor warm detected on ${GODOT_HOST}:${GODOT_PORT} after recovery; dropping ${S.pendingCalls.length} buffered call(s) with retry guidance.`);
                        rejectQueue('editor recovered after warmup timeout; please retry', warmupDiagnostic('recovered'));
                    } else {
                        maybeRejectUnreadyHeld();
                        log(`editor warm detected on ${GODOT_HOST}:${GODOT_PORT} and godot-mcp CLI connected; releasing ${S.pendingCalls.length} queued call(s).`);
                        stageLog('WARM_FLUSH', `path=recovering_connected queued=${S.pendingCalls.length} elapsed_ms=${Date.now() - (S.spawnStartedAt || S.startedAt)}`);
                        flushQueue();
                    }
                    S.recovering = false;
                    if (KOL_PROGRESS_PROTOCOL !== 'off') {
                        if (S.stageTimestamps.WARM === null) S.stageTimestamps.WARM = now2;
                        S.stage = 'WARM';
                        if (S.stageTimestamps.WS_HANDSHAKE !== null && S.stageTimestamps.MCP_INITIALIZED === null) {
                            S.stageTimestamps.MCP_INITIALIZED = now2;
                        }
                        S.warmupJustCompleted = true;
                    }
                    notifyWarmupProgress(Math.floor(COLD_WARMUP_TIMEOUT_MS / 1000));
                    warmFlushed = true;
                    // SEE-1244 §6.2 (defect #1): first moment warm && npxCliConnected
                    // hold together on the recovering_connected flush path — the
                    // NPX_CLI_CONNECTED hook alone races warm=false on cold boots.
                    maybeRefreshToolsCache();
                    break;
                }
                continue;
            }
            // SEE-1338 QA defect #1 (Revy real-machine FAIL, HIGH): the fork CLI
            // connects to the editor at CLI BOOT — it does not wait for warm.
            // Once our OWN CLI owns the addon's single WS slot, every wsProbe is
            // rejected with 4001 ("another client is already connected") and the
            // probe loop never sees probeOk — so the gate below (whose milestone
            // conditions were ALL satisfied: SERVER_LISTENING + WS_HANDSHAKE in
            // the editor log, renderStable passed) is never even EVALUATED. The
            // session grinds to the full warmup timeout → RECOVERING grind while
            // a perfectly warm editor serves our CLI (s3x: CLI connected +141s,
            // every gate milestone present, still timed out at +300s). SEE-1111's
            // own contract resolves it: "once the CLI is connected it owns the
            // slot and IS the liveness signal" — a successful CLI connection
            // proves the editor's WS stack handshakes, which is exactly what
            // probeOk exists to prove. So bypass the probe while the FORK CLI
            // (the one that holds the slot — cliConnectSignalExpected gates out
            // mock seams that emit the line without holding anything, keeping
            // the SEE-1111 defect-6 probe contract untouched) is connected;
            // npx.mjs clears the flag on 'Disconnected from Godot', so a dead
            // editor can't keep the bypass alive beyond the CLI's own detection.
            const probeOk = (cliConnectSignalExpected() && S.npxCliConnected)
                ? true
                : await wsProbe();
            const now = Date.now();

            if (probeOk) {
                lastTcpOkAt = now;
                // WS-7: when the editor log is unavailable the SERVER_LISTENING
                // milestone never lands, so the grace-race guard would measure
                // nothing — record the FIRST successful probe as the bind time
                // proxy-side equivalent (a handshake probe proves the port is
                // bound RIGHT NOW).
                if (S.firstProbeOkAt === 0) S.firstProbeOkAt = now;
                if (S.renderStable) {
                    // 缺陷 A (SEE-1111): the WARM transition additionally requires the
                    // editor's WS server to be BOUND before buffered calls are flushed.
                    // Previously TCP reachability + renderStable forwarded the first
                    // tools/call to npx while the addon was still initializing — the
                    // npx godot-mcp CLI's ws connect chain (~30s QUICK_TIMEOUT +
                    // reconnect) then failed before the editor bound the port (~22s
                    // cold boot), passing a bogus "Not connected" through. Holding the
                    // first call until `Server listening` lands lets the CLI connect to
                    // an accepting port. Degradation (§6): when the editor log is
                    // unreadable we cannot observe the stage, so we fall back to the
                    // TCP-only signal. A hot-reuse editor (port already listening when
                    // the spawn round began, `lastSpawnReused`) provably bound its WS
                    // server long ago, so its `Server listening` line predates the
                    // lease offset and is never scanned — bypass the gate for it.
                    // 缺陷 A gate (SERVER_LISTENING): while the log is being tailed
                    // and the editor has not logged `Server listening`, keep holding
                    // the buffered calls — npx's ws connect would fail against an
                    // unbound port. do NOT enter RECOVERING here: the cold window is
                    // still open and the editor is still booting normally. Hot reuse
                    // (lastSpawnReused) provably bound its WS server long ago — its
                    // `Server listening` line predates the lease offset and is never
                    // scanned, so the gate is bypassed for it.
                    //
                    // 缺陷 #10 (SEE-1111): the flush additionally requires the WS
                    // handshake to be COMPLETE (`WS_HANDSHAKE` milestone), not merely
                    // the port bound. The npx godot-mcp CLI's ws-connect chain starts
                    // ticking at flush; a bound-but-not-yet-handshook editor can still
                    // blow the CLI's 30s window, so the first call is held until the
                    // addon logs the handshake (and, via the initialize response, MCP
                    // is initialized). When the log is tailed, `bound` alone no longer
                    // opens the gate: the WS handshake must ALSO be observed.
                    // Degradations bypass: hot reuse (lastSpawnReused) and unreadable
                    // log (!logTailAvailable) — the same seams as 缺陷 A.
                    // SEE-1338 spec v2.1: a HANDOFF-reused editor (the disk
                    // said a prior record served this slot; our CLI may
                    // already be connected) provably bound long ago — bypass
                    // the milestone gate exactly like hot reuse.
                    const handoffWarm = process.env.GODOT_MCP_HANDOFF_WARM === '1';
                    const gateOpen = S.lastSpawnReused
                        || handoffWarm
                        || !S.logTailAvailable
                        || (S.stageTimestamps.SERVER_LISTENING !== null
                            && S.stageTimestamps.WS_HANDSHAKE !== null);
                    // 缺陷 #6 (SEE-1111): a real WS handshake must be proven
                    // reachable before buffered calls are flushed. With the
                    // production wsProbe, probeOk ALREADY means a full HTTP Upgrade
                    // handshake completed in this tick — that is the proof the
                    // editor's WS stack is functional, not merely bound. (Under
                    // KOL_WS_PROBE_DISABLE=1 — test seams whose mock listener only
                    // binds a TCP port — probeOk is the weaker TCP-reachability
                    // signal, the pre-fix behavior.) `gateOpen` is the 缺陷 A/#10 gate.
                    if (gateOpen) {
                        // SEE-1240 WS-7 (目标2 宽限窗口协调): the addon arms its
                        // 300s INITIAL_GRACE at plugin init (≈ editor process
                        // start) — before the port is even bound. On a first
                        // boot with a cold import cache the editor can take
                        // 200s+ to bind, leaving <100s of grace for the client
                        // whose WS connect chain itself needs up to 30s — if
                        // that尾巴 is missed the editor self-exits and the
                        // slow-client loop (bind → grace burnt → self-exit →
                        // retry) begins. Layer-2 coordination (addon is
                        // vendored): when the measured bind delay
                        // (SERVER_LISTENING − EDITOR_SPAWNED) exceeds
                        // KOL_GRACE_RACE_BIND_S (default 150s — leaves 150s of
                        // addon grace vs the client's 30s connect chain), evict
                        // THIS editor and spawn a fresh one: the import cache is
                        // now warm, so the new editor binds fast and the client
                        // lands with full grace. One-shot per spawn round
                        // (graceRaceGuardFired) so a genuinely slow machine
                        // cannot loop.
                        const bindStart = S.stageTimestamps.SERVER_LISTENING ?? S.firstProbeOkAt ?? 0;
                        const bindDelayMs = (bindStart > 0 && S.stageTimestamps.EDITOR_SPAWNED !== null)
                            ? bindStart - S.stageTimestamps.EDITOR_SPAWNED
                            : (bindStart > 0 ? bindStart - (S.spawnStartedAt || S.startedAt) : 0);
                        if (GRACE_RACE_GUARD_ENABLED
                            && !S.lastSpawnReused
                            && !S.graceRaceGuardFired
                            && bindDelayMs > GRACE_RACE_BIND_MS
                            && S.spawnAttempts < SPAWN_MAX_ATTEMPTS) {
                            S.graceRaceGuardFired = true;
                            stageLog('GRACE_RACE_GUARD', `bind_delay_ms=${bindDelayMs} > ${GRACE_RACE_BIND_MS}; evicting slow-bind editor for a warm-cache respawn`);
                            log(`WARNING: editor bound after ${Math.floor(bindDelayMs / 1000)}s (addon grace would leave <${Math.max(0, 300 - Math.floor((now - (S.stageTimestamps.EDITOR_SPAWNED || now)) / 1000))}s for the client); evicting and respawning against the now-warm import cache (WS-7).`);
                            S.warm = false;          // undo the WARM transition above
                            warmFlushed = false;
                            S.graceRaceRespawn = true;
                            break;                 // exit the probe loop → grace-race respawn below
                        }
                        S.warm = true;
                        S.warmAt = now;
                        S.warmEditorDead = false; // post-warm respawn round re-proven live
                        // WS-7: a completed WARM re-arms the guard so a later
                        // post-warm respawn round (fresh editor, possibly cold
                        // import again) still gets race protection — while the
                        // one-shot within a single round still prevents loops.
                        S.graceRaceGuardFired = false;
                        S.pendingHandshake.clear();
                        // SEE-1338 spec v2.1 §3.3 STATE_TRANSITION: WARM lands on
                        // disk so a future successor reads a live record (盘上
                        // 状态 = 决策唯一依据). Fire-and-forget — never blocks.
                        if (RUNTIME_ID) {
                            writeRuntimeState(RUNTIME_ID, {
                                state: 'WARM',
                                port: SOT_PORT,
                                warm_at: new Date(now).toISOString(),
                                heartbeat_at: new Date(now).toISOString(),
                                last_error: null,
                            }, { event: 'STATE_TRANSITION', fromState: 'WARMING', detail: 'warm gate opened' });
                        }
                        stageLog('WARM', `elapsed_ms=${now - (S.spawnStartedAt || S.startedAt)} reused=${S.lastSpawnReused === true}`);
                        // SEE-1110 §2.1: WARM(7) is the final stage, reached exactly here.
                        if (KOL_PROGRESS_PROTOCOL !== 'off') {
                            if (S.stageTimestamps.WARM === null) S.stageTimestamps.WARM = now;
                            S.stage = 'WARM';
                            if (S.stageTimestamps.WS_HANDSHAKE !== null
                                && S.stageTimestamps.MCP_INITIALIZED === null) {
                                S.stageTimestamps.MCP_INITIALIZED = now;
                            }
                        }
                        // SEE-1111 (cold-start one-shot): do NOT flush here. The
                        // CLI connects its WebSocket only AFTER the editor warms,
                        // so the held first tools/call must wait for the CLI's
                        // 'Connected to Godot'. From the next iteration the
                        // `if (warm)` branch stops probing (freeing the WS slot)
                        // and flushes once the CLI connects. Hot reuse bypasses
                        // the wait ONLY when the CLI is already connected (the
                        // original intent: a running proxy reusing a warm editor
                        // whose CLI reconnects in <1s). A FRESH proxy that reuses
                        // a port whose editor is still cold-booting (fresh
                        // auto-checkout + explicit start-godot-editor.sh before
                        // the first tools/call) has a CLI that has NOT connected
                        // yet — flushing here forwards the call to an npx whose
                        // WS connect chain is still racing the cold boot, and the
                        // first call fails "Not connected to Godot" (the cold-start
                        // fail-fast window Revy measured, T+26s..T+52s). Require
                        // the CLI's own handshake before the hot-reuse flush.
                        if (!cliConnectSignalExpected() || (S.lastSpawnReused && S.npxCliConnected)) {
                            maybeRejectUnreadyHeld();
                            log(`editor warm detected on ${GODOT_HOST}:${GODOT_PORT} (hot reuse); releasing ${S.pendingCalls.length} queued call(s).`);
                            stageLog('WARM_FLUSH', `path=hot_reuse queued=${S.pendingCalls.length} elapsed_ms=${Date.now() - (S.spawnStartedAt || S.startedAt)}`);
                            if (S.recovering) {
                                rejectQueue('editor recovered after warmup timeout; please retry', warmupDiagnostic('recovered'));
                            } else {
                                flushQueue();
                            }
                            S.recovering = false;
                            S.warmupJustCompleted = KOL_PROGRESS_PROTOCOL !== 'off' ? true : S.warmupJustCompleted;
                            notifyWarmupProgress(Math.floor(COLD_WARMUP_TIMEOUT_MS / 1000));
                            warmFlushed = true;
                            // SEE-1244 §6.2 (defect #1): hot-reuse flush path — same
                            // first warm&&connected closure point as above.
                            maybeRefreshToolsCache();
                            break;
                        }
                        log(`editor warm detected on ${GODOT_HOST}:${GODOT_PORT}; slot freed, waiting for godot-mcp CLI to connect before releasing ${S.pendingCalls.length} queued call(s).`);
                    }
                    // Holding: the inner loop re-probes next tick. Do NOT enter
                    // RECOVERING — the cold window is still open and the editor is
                    // still booting normally.
                }
            } else {
                if (!S.recovering && (now - S.spawnStartedAt) >= currentWarmupTimeout()) {
                    // T2: warmup window exhausted. SEE-1111 目标2 (180s-window
                    // fallback): answer the held first call(s) NOW with a retryable
                    // timeout diagnostic instead of hanging them until FAILED_EXIT —
                    // the client has already waited the full warmup window, so it
                    // gets a "please retry" rather than silence. The held calls are
                    // drained here (rejectQueue); a NEW call during RECOVERING is
                    // rejected immediately by the recovering branch, and if the
                    // editor comes back (T3) the client's next retry succeeds.
                    // Reset render-stable so a recovery must re-prove it.
                    S.recovering = true;
                    S.recoveringEnteredAt = now;
                    lastTcpOkAt = now; // seed the FAILED_EXIT window from RECOVERING entry
                    rejectQueue(
                        `editor warmup timed out after ${Math.floor(currentWarmupTimeout() / 1000)}s; please retry`,
                        warmupDiagnostic('recovering'),
                    );
                    S.renderStable = false;
                    startRenderStableMonitor();
                    if (KOL_PROGRESS_PROTOCOL !== 'off') maybeNotifyStageChange();
                    log(`WARNING: warmup timed out after ${Math.floor(currentWarmupTimeout() / 1000)}s; entering RECOVERING (held call(s) answered with retryable timeout; will retry for ${Math.floor(FAILED_EXIT_MS / 1000)}s before FAILED_EXIT).`);
                } else if (S.recovering && (now - S.recoveringEnteredAt) >= RECOVERING_HARD_CAP_MS) {
                    // SEE-1338 spec v2.1 §6 (R2 hard-cap backstop): the
                    // RECOVERING ABSOLUTE cap (2× cold timeout from entry) —
                    // regardless of any probe blips ("自愈迹象") inside the
                    // window, expiry forces a COLD RESTART: kill our editor
                    // clue, clear the round, respawn. Bounded by
                    // forceRestartCount; after K restarts FAILED_CLEAN owns
                    // the retry loop (form-B 根治点).
                    log(`ERROR: RECOVERING absolute hard cap ${Math.floor(RECOVERING_HARD_CAP_MS / 1000)}s reached (2× cold timeout); forcing cold restart (R2).`);
                    rejectQueue(
                        `RECOVERING hard cap (${Math.floor(RECOVERING_HARD_CAP_MS / 1000)}s) reached; forcing cold restart — please retry`,
                        warmupDiagnostic('failed_exit'),
                    );
                    if (S.forceRestartCount < SPAWN_MAX_ATTEMPTS) {
                        await forceColdRestart('recovering_hard_cap');
                    } else {
                        giveUpAndRearm('recovering_hard_cap', 'RECOVERING hard cap; forced restarts exhausted');
                    }
                    break;   // exit the probe loop; the layer above re-arms
                } else if (S.recovering && (now - lastTcpOkAt) >= FAILED_EXIT_MS) {
                    // T4: sustained probe failure. SEE-1325 H1（§SPEC-002）：先跑
                    // 内嵌恢复轮（预算口径 (a)，剩余不足单轮最坏耗时即终态），
                    // 恢复轮拿不到端口/身份不可读才走 FAILED_EXIT 终态。
                    const healed = await runRecoveryRound('cold_failed_exit');
                    if (!healed) {
                        log(`ERROR: editor did not recover within ${Math.floor(FAILED_EXIT_MS / 1000)}s (FAILED_EXIT); rejecting ${S.pendingCalls.length} buffered call(s).`);
                        rejectQueue(`editor did not recover within ${Math.floor(FAILED_EXIT_MS / 1000)}s (FAILED_EXIT)`, warmupDiagnostic('failed_exit'));
                        if (GIVEUP_REARM_ENABLED) {
                            S.warmupTimedOut = false;
                            giveUpAndRearm('recovering_failed_exit', 'sustained probe failure (FAILED_EXIT)');
                            break;   // exit the warmFlushed loop; outer loop re-arms
                        }
                        S.warmupTimedOut = true;
                        process.exit(1);
                    }
                    // healed=true：恢复轮已重开 spawn（同端口重钉），继续探 warm。
                }
            }

            notifyWarmupProgress();
            maybeProgressLog();
            await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
        }
        // SEE-1240 WS-7: the grace-race guard bailed out of the probe loop with
        // a slow-bind editor still holding the port. Evict it (frees the port;
        // its addon grace was about to self-exit it anyway) and fall through to
        // the outer loop, which re-enters the spawn section with
        // spawnTriggered still true — the import cache is warm now, so the
        // fresh editor binds fast and the held calls flush with full addon
        // grace. One-shot: graceRaceGuardFired prevents a slow-machine loop
        // (the second editor is accepted regardless of its bind delay).
        if (S.graceRaceRespawn) {
            S.graceRaceRespawn = false;
            S.warmupTimeoutMs = null;      // fresh round re-classifies cold/hot
            S.lastSpawnReused = false;
            S.tcpReceivedCount = 0;
            S.firstProbeOkAt = 0;          // fresh round re-measures the bind delay
            for (const s of STAGE_ENUM) S.stageTimestamps[s] = null;
            S.stageTimestamps.LAUNCHER_EXEC = S.startedAt;
            S.stage = 'EDITOR_SPAWNED';    // spawn is about to re-run; milestones re-derive
            S.renderStable = false;
            startRenderStableMonitor();
            // grace-race evicts THIS slot's own slow editor — pin the release
            // target to our own worktree (same reasoning as the foreign evict).
            await evictStaleHolder(await resolveWorktreeForSpawn());
            // evict kills the editor via stop-godot-editor.sh (async PID
            // resolution) — wait for the port to actually free before
            // re-spawning, or the fresh start mock/real schtasks would hit
            // "port already in use". Bounded by the respawn window; the
            // backstop is ensureEditor's own arbiter verdict on re-entry.
            if (await waitForPortRelease('respawn')) {
                log(`grace-race respawn: port freed; respawning against the warm import cache (held calls stay queued).`);
            } else {
                log(`WARNING: grace-race respawn — port still held after the respawn window; continuing (arbiter will verdict on re-spawn).`);
            }
            S.spawnAttempts = 0;           // the re-spawn is a fresh round, not a failure retry
            triggerEnsureEditor();
        }
        // If the inner loop exited because spawnTriggered flipped false (a
        // non-terminal spawn failure), the outer loop returns to COLD_EMPTY
        // idle for the next tools/call. render-stable monitor keeps running.
    }
}

// SEE-1111 缺陷 #7: run the warmup loop to completion, then STAY RESIDENT so a
// post-warm editor death can re-spawn. The plain warmupLoop() exits once warm is
// reached (the outer `while (!warm ...)` is false); without this resident
// wrapper a dead post-warm editor would never be re-spawned. After WARM we idle
// until beginWarmEditorRespawn() flips warmEditorDead (an editor_gone from a
// tools/call), then reset the warmup state and RE-ENTER the loop, so the next
// tools/call triggers a fresh spawn (spawnTriggered was reset false; the loop's
// outer COLD_EMPTY idle waits for the next call to flip it). warmRespawnInFlight
// is set by beginWarmEditorRespawn and cleared here on re-entry, so a burst of
// editor_gone errors re-enters once.
// SEE-1111 缺陷 #8: while the proxy sits warm and idle, actively probe the
// editor so a death that never reaches npx (hard kill, WSL network reset, lease
// self-exit without a log line) still triggers a respawn. The CLI's WS transport
// reports such deaths directly to Claude as "Connection to Godot was lost" — the
// npx JSON-RPC `msg.error` path (缺陷 #7's trigger) is never seen, so without
// this probe the proxy stays warm forever and every retry keeps failing against
// a dead port (Revy hard acceptance: kill editor -> 3 retries all failed, CLI
// stuck in SYN-SENT).
//
// Rules:
//   * Probe once per PROBE_INTERVAL_MS tick. wsProbe is a REAL WS handshake, so
//     it proves the addon's slot is servable right now (and releases the slot
//     immediately — SEE-1111 缺陷 #6).
//   * SUSTAINED_FAILURES consecutive failures prove death. A single transient
//     failure (a slow GC frame, a momentary network reset) must NOT kill a warm
//     session that the next tick may prove alive again. The editor's WS slot is
//     single-client; a probe that FAILS leaves no residue, so back-to-back
//     failures genuinely mean "nothing is answering on the port".
//   * A successful probe clears the failure counter (and a fresh warm state
//     starts at 0 — a stale counter from a previous round must not shorten the
//     next round's tolerance).
//   * On the threshold we do NOT hard-exit. We take the SAME beginWarmEditorRespawn
//     path as an editor_gone error: the flag wakes the resident loop, which resets
//     per-round state and re-enters warmup, so the next tools/call re-spawns the
//     editor. The current call (if any) is already answered by npx or stays in
//     flight — drop-with-retry semantics, matching the editor_gone path.
//
// KOL_WARM_LIVENESS=off disables the probe entirely (a test seam / operator
// escape hatch); default is on. KOL_WARM_LIVENESS_FAILURES overrides the
// sustained-failure threshold (default 3 — ~3s of silence at the default 1s
// probe interval, well under the 45s addon stale-connection window).

async function warmLivenessProbe() {
    if (S.shutdownRequested || S.spawnTerminal || !S.warm || S.warmEditorDead || !WARM_LIVENESS_ENABLED) {
        return;
    }
    // SEE-1134 Q1: when a restart_hold is in flight, the editor is INTENTIONALLY
    // going away (port → cold during the restart window). driveRestartRespawn is
    // the sole authority on whether the editor came back; the warm liveness
    // probe must NOT race it and pre-empt it with a "presumed dead" respawn
    // (which would land in a fresh spawn while the relaunched editor is also
    // booting → "Already in use" or 3-editor coexistence — Q2 symptom).
    if (S.restartHold) {
        return;
    }
    // SEE-1111 (cold-start one-shot): the addon accepts ONE WebSocket client,
    // and each wsProbe HOLDS that single slot while the probe socket is open.
    // Probing on a timer while the godot-mcp CLI is still connecting (or after
    // it has connected — the CLI then owns the slot) makes the addon reject the
    // CLI with 4001 forever. So the liveness probe runs ONLY before the CLI's
    // first connection of this run (npxCliConnected false). Once the CLI is
    // connected it owns the slot and IS the liveness signal; the editor's own
    // lease + the CLI's reconnect handle post-warm death.
    if (S.npxCliConnected) {
        return;
    }
    const ok = await wsProbe();
    if (ok) {
        S.warmProbeFailures = 0;
        return;
    }
    S.warmProbeFailures += 1;
    if (S.warmProbeFailures < WARM_LIVENESS_FAILURES) {
        log(`WARNING: warm liveness probe failed ${S.warmProbeFailures}/${WARM_LIVENESS_FAILURES} (editor may be dying); continuing.`);
        return;
    }
    log(`ERROR: warm liveness probe failed ${WARM_LIVENESS_FAILURES} consecutive times; editor presumed dead — triggering respawn (缺陷 #8).`);
    beginWarmEditorRespawn();
}

// SEE-1111 缺陷 #7: run the warmup loop to completion, then STAY RESIDENT so a
// post-warm editor death can re-spawn. The plain warmupLoop() exits once warm is
// reached (the outer `while (!warm ...)` is false); without this resident
// wrapper a dead post-warm editor would never be re-spawned. After WARM we idle
// until beginWarmEditorRespawn() flips warmEditorDead (an editor_gone from a
// tools/call — 缺陷 #7 — OR the warm liveness probe — 缺陷 #8), then reset the
// warmup state and RE-ENTER the loop, so the next tools/call triggers a fresh
// spawn (spawnTriggered was reset false; the loop's outer COLD_EMPTY idle waits
// for the next call to flip it). warmRespawnInFlight is set by
// beginWarmEditorRespawn and cleared here on re-entry, so a burst of editor_gone
// errors re-enters once.
async function runWarmupLoop() {
    while (!S.shutdownRequested && !S.spawnTerminal) {
        await warmupLoop();
        if (S.shutdownRequested || S.spawnTerminal) return;
        // WARM reached. Idle until the editor dies (or the proxy shuts down),
        // then reset and re-enter so the next tools/call re-spawns. While
        // idling, the 缺陷 #8 warm liveness probe actively watches the editor so
        // a death that never reaches npx still triggers the respawn.
        while (!S.shutdownRequested && !S.spawnTerminal && !S.warmEditorDead) {
            await warmLivenessProbe();
            if (S.shutdownRequested || S.spawnTerminal || S.warmEditorDead) break;
            await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
        }
        if (S.shutdownRequested || S.spawnTerminal) return;
        resetForRespawn();
        // SEE-1325 H1（§SPEC-002 暖分支入口）：editor_gone respawn 再入前先跑
        // 内嵌恢复轮（归因→判定→stop-first/respawn），确保下一次 tools/call
        // 落在已恢复链上而非再次 editor_gone。
        await runRecoveryRound('warm_editor_gone');
        S.warmRespawnInFlight = false;
        log(`respawn loop: re-entering warmup after post-warm editor death (warmEditorDead=${S.warmEditorDead}). Next tools/call will re-spawn the editor.`);
        // Loop back; the outer COLD_EMPTY idle waits for the next tools/call.
    }
}

export {
    warmupLoop,
    warmLivenessProbe,
    runWarmupLoop,
};
