// proxy/diagnostics.mjs — warmup diagnostics + progress protocol
// (extracted from godot-mcp-proxy.mjs, SEE-1334 Phase 0a): handshake substates,
// scenario hints, warmupDiagnostic schema, timeline/hint text, notifications.
import { S } from './state.mjs';
import {
    COLD_WARMUP_TIMEOUT_MS, FAILED_EXIT_MS, GODOT_HOST, GODOT_PORT,
    KOL_PROGRESS_PROTOCOL,
} from './config.mjs';
import {
    STAGE_TOTAL, stageOrdinal,
    handshakeSubstate as modHandshakeSubstate,
    handshakePendingMs as modHandshakePendingMs,
} from '../warmup-stage-parser.mjs';
import { log } from './log.mjs';
import { sendToClaude } from './protocol.mjs';

// SEE-1110 §3.2: stageTimestamps records only reach times (durations are derived
// from adjacent differences); null = unreached. stageProgress equals the stage's
// ordinal so a client can render a progress bar without a lookup table.
// stageOrdinal is imported from warmup-stage-parser.mjs.

// SEE-1110 §3.3 handshake substate. n/a below TCP_CONNECTED(4); pending once TCP
// is observed; complete once WS_HANDSHAKE is observed; stalled when the pending
// window exceeds HANDSHAKE_STALL_THRESHOLD_MS or a second TCP_RECEIVED signals a
// slot-competition swallow. rejected_4001 is set by the editor_busy path (§4.2)
// when npx surfaces close 4001 / "another client".
function handshakeSubstate() {
    return modHandshakeSubstate(
        { stage: S.stage, timestamps: S.stageTimestamps, tcpReceivedCount: S.tcpReceivedCount },
        Date.now()
    );
}

// SEE-1110 §3.2: accumulates only while stage >= TCP_CONNECTED(4) and WS_HANDSHAKE
// is still null; otherwise 0.
function handshakePendingMs() {
    return modHandshakePendingMs(
        { stage: S.stage, timestamps: S.stageTimestamps, tcpReceivedCount: S.tcpReceivedCount },
        Date.now()
    );
}

// SEE-1110 §4.1-§4.4: scenario hint text. `{var}` templates filled from live
// values; logTailAvailable=false appends the §6 degradation suffix.
function buildHint(state, now) {
    const hkSub = handshakeSubstate();
    if (state === 'editor_busy') {
        // §4.2 rejected-4001 view (Atlas MEDIUM #1): stage reflects the occupying
        // healthy client, so the hint explains the slot, not the editor's state.
        return `the godot_mcp addon accepts only one WebSocket client at a time; another session is holding port ${GODOT_PORT} (WS close 4001). Retry after the holder releases the slot (its proxy disconnects, or the editor's lease self-exits). If it persists, a concurrent same-agent run is likely holding the slot.`;
    }
    if (S.leaseExitDetected) {
        // §4.4 scenario D.
        return 'editor 因 lease grace 超时自退出（无 MCP client 的 grace window）以释放端口；请重试，proxy 会被 Claude 重启拉起新 editor。';
    }
    if (state === 'warming' || state === 'recovering') {
        if (hkSub === 'stalled' || hkSub === 'pending') {
            // §4.2 scenario B — TCP reachable but the WS handshake never finished.
            const pendingS = Math.floor(handshakePendingMs() / 1000);
            const tcpTs = S.stageTimestamps.TCP_CONNECTED;
            if (tcpTs !== null) {
                return `TCP 已连到 addon（${GODOT_HOST}:${GODOT_PORT}）但 WebSocket 握手 ${pendingS}s 未完成；疑似 addon 单客户端槽位被占（4001）或握手被吞。建议：等 editor lease 自退出释放槽位后重试，或确认无并发同端口 session（agent-ports.json）。`;
            }
        }
        if (state === 'recovering') {
            return `editor 冷启动中，已到 ${S.stage}（已等 ${Math.floor((now - (S.spawnStartedAt || S.startedAt)) / 1000)}s）；已超过 warmup 窗口进入 RECOVERING，仍在探测 editor 恢复（FAILED_EXIT 前最多 ${Math.floor(FAILED_EXIT_MS / 1000)}s）。`;
        }
        // §4.1 scenario A — still within the warmup window.
        return `editor 冷启动中，已到 ${S.stage}（已等 ${Math.floor((now - (S.spawnStartedAt || S.startedAt)) / 1000)}s）；仍在 warmup 窗口内（${Math.floor(currentWarmupTimeout() / 1000)}s），请稍候。`;
    }
    if (state === 'failed_exit' || state === 'editor_gone') {
        // §4.3 scenario C — addon genuinely unresponsive.
        return `editor/addon 无响应：最后到达 ${S.stage}，TCP 探测持续失败 ${Math.floor(FAILED_EXIT_MS / 1000)}s。建议：重启 MCP server 让 proxy 重新拉起 editor。`;
    }
    if (state === 'recovered') {
        return `editor 恢复：最后到达 ${S.stage}，端口 ${GODOT_PORT} 重新可连。请重试。`;
    }
    return `warmup 进行中（${S.stage}）。`;
}

// SEE-1070 #2 + SEE-1110 §3: structured warmup diagnostic attached to error.data
// so callers (and tests) can distinguish recovering vs failed-exit without
// parsing strings. The old fields are preserved exactly; SEE-1110 adds the
// stage/handshake/log-tail/lease dimensions at the END of the object (R3 —
// forward-compatible: 6-agent regression asserts only the old fields).
function warmupDiagnostic(forceState = undefined) {
    const now = Date.now();
    const state = forceState ?? (S.recovering ? 'recovering' : S.warmupTimedOut ? 'failed_exit' : 'warming');
    const diag = {
        state,
        host: GODOT_HOST,
        port: GODOT_PORT,
        renderStable: S.renderStable,
        elapsedMs: now - S.startedAt,
        warmupTimeoutMs: currentWarmupTimeout(),
        failedExitMs: FAILED_EXIT_MS,
        recoveringForMs: S.recovering ? (now - S.recoveringEnteredAt) : 0,
    };
    if (KOL_PROGRESS_PROTOCOL !== 'off') {
        // §3.1 appended schema (kept after the legacy fields).
        const hkSub = handshakeSubstate();
        diag.stage = S.stage;
        diag.stageProgress = stageOrdinal(S.stage);
        diag.stageTotal = STAGE_TOTAL;
        diag.stageTimestamps = { ...S.stageTimestamps };
        diag.handshakeSubstate = hkSub;
        diag.handshakePendingMs = handshakePendingMs();
        diag.coldMode = S.coldMode;
        diag.logTailAvailable = S.logTailAvailable;
        diag.leaseExitDetected = S.leaseExitDetected;
        // §3.1: elapsedMs basis changes from startedAt to spawnStartedAt || startedAt.
        diag.elapsedMs = now - (S.spawnStartedAt || S.startedAt);
    }
    // SEE-1085 §6.3 orphan hint: if the port was ALREADY listening on the
    // first tools/call (lastSpawnReused) and we are now stuck in recovering
    // or failed_exit, the holder is an orphan / unhealthy editor we never
    // started. Surface a one-line hint so the operator (or Atlas QA) knows
    // the recovery is not our spawn — kill the orphan instead of waiting.
    if (S.lastSpawnReused && (state === 'recovering' || state === 'failed_exit')) {
        diag.hint = `port ${GODOT_PORT} was already listening at first tools/call; recovery is over a foreign holder (orphan editor), not our spawn.`;
    }
    // SEE-1170 通道 3: surface bare-repo-prune outcome so callers / QA can tell
    // "stale registration, recovered after prune" apart from "still failing,
    // cause unclear" without parsing stageLog strings. Only set when the
    // resolveWorktreeForSpawn anchor-failure path actually ran a prune attempt.
    if (S.lastBareRepoPruneDiag) {
        diag.bareRepoPrune = S.lastBareRepoPruneDiag;
    }
    if (diag.hint === undefined) {
        let hint = buildHint(state, now);
        if (!S.logTailAvailable) {
            hint += '（editor log 不可读，进度基于 TCP probe 降级，stage 可能不完整）';
        }
        diag.hint = hint;
    }
    return diag;
}

function currentWarmupTimeout() {
    // Classified once at the start of warmupLoop by probing the editor TCP port:
    // already listening => hot reuse (short window); not yet => cold boot (long
    // window). Falls back to the cold window if read before classification.
    return S.warmupTimeoutMs ?? COLD_WARMUP_TIMEOUT_MS;
}

// Best-effort MCP progress notification for the first tools/call's warmup. The
// agent supplied a progressToken via params._meta; we send updates so it does
// not silently wait ~10-60s. SEE-1110 B3 (§1 Channel B + §3.1): stage-transition
// driven + heartbeat, payload carries the SAME ProgressPayload schema as the
// warmupDiagnostic (extra `progressToken`). If Claude ignores progress
// notifications (unverified) this is a no-op — the final guarantee against a
// silent 30s wait remains the Channel A response body. Callers pass the current
// elapsed seconds as a progress value; the schema payload reuses live state.
function progressPayload(forceState = undefined) {
    const diag = warmupDiagnostic(forceState);
    // Channel B adds the progressToken to the same schema.
    return {
        progressToken: S.firstCallProgressToken,
        progress: Math.floor(diag.elapsedMs / 1000),
        total: Math.floor(currentWarmupTimeout() / 1000),
        message: `editor 正在拉起; 已等 ${Math.floor(diag.elapsedMs / 1000)}s（${diag.stage}, ${diag.state}）`,
        stage: diag.stage,
        stageProgress: diag.stageProgress,
        stageTotal: diag.stageTotal,
        stageTimestamps: diag.stageTimestamps,
        handshakeSubstate: diag.handshakeSubstate,
        handshakePendingMs: diag.handshakePendingMs,
        state: diag.state,
        host: diag.host,
        port: diag.port,
        elapsedMs: diag.elapsedMs,
        warmupTimeoutMs: diag.warmupTimeoutMs,
        coldMode: diag.coldMode,
        logTailAvailable: diag.logTailAvailable,
        leaseExitDetected: diag.leaseExitDetected,
        renderStable: diag.renderStable,
        recoveringForMs: diag.recoveringForMs,
        hint: diag.hint,
    };
}

function notifyWarmupProgress(progressOverride = undefined) {
    if (KOL_PROGRESS_PROTOCOL === 'off') return; // §9 R7 quick-disable
    if (S.firstCallProgressToken == null) return;
    try {
        sendToClaude({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: progressPayload(progressOverride !== undefined ? 'warming' : undefined),
        });
    } catch (err) {
        log(`WARNING: progress notification failed: ${err.message}`);
    }
}

// SEE-1110 B3: stage-transition notifications. Fired exactly when a milestone
// first completes (from scanTailStages / warmupLoop / the forwarder), so a
// transition is never swallowed by the 5s heartbeat cadence. Best-effort only.
function notifyStageChange() {
    notifyWarmupProgress();
}

// Internal guard: stage changes must be notified without re-entrant recursion
// from notifyWarmupProgress -> warmupDiagnostic (which reads, never mutates).

function maybeNotifyStageChange() {
    if (S.stageNotified === S.stage) return;
    S.stageNotified = S.stage;
    notifyStageChange();
}

// SEE-1110 §7: build the one-line success-path timeline appended to the first
// warmup-triggered tools/call's result.content. Values are seconds relative to
// the warmup start (spawnStartedAt || startedAt), cumulative; `?` when the stage
// was never reached (log unavailable, §6 degradation) OR its timestamp predates
// this spawn round's start (a stale timestamp from a prior round survives while
// spawnStartedAt was reset forward — 缺陷 B, SEE-1111). The WARM anchor is
// warmAt (proxy-set) so the final interval reflects when the editor became usable.
function buildWarmupTimeline() {
    const start = S.spawnStartedAt || S.startedAt;
    const warmTs = S.warmAt || Date.now();
    const sec = (ts) => (ts && (ts - start) >= 0 ? ((ts - start) / 1000).toFixed(1) : '?');
    const segs = [
        ['spawn', S.stageTimestamps.EDITOR_SPAWNED],
        ['plugin', S.stageTimestamps.PLUGIN_INIT],
        ['listen', S.stageTimestamps.SERVER_LISTENING],
        ['tcp', S.stageTimestamps.TCP_CONNECTED],
        ['ws', S.stageTimestamps.WS_HANDSHAKE],
        ['init', S.stageTimestamps.MCP_INITIALIZED],
    ];
    return `[godot-mcp warmup ${((warmTs - start) / 1000).toFixed(1)}s | ${segs.map(([name, ts]) => `${name}→${sec(ts)}s`).join(' ')}]`;
}

// SEE-1111 预热提示: when a tools/call lands while the editor is genuinely
// warming (spawn triggered, not yet WARM), answer it IMMEDIATELY with a friendly
// SUCCESS result (not an error, not a silent wait) telling the agent to retry.
// This is the owner-chosen fix for "第一次 mcp 调用就 timeout": the agent learns
// the editor is cold-booting (~60s worst-case, owner-refined figure covering
// jitter/slow machines) and retries itself, instead of the proxy holding the
// call until the client's own timeout fires. The editor launch is ONE COORDINATED
// PIPELINE (configure → spawn → plugin → listen → WS handshake → warm, owner:
// "editor 拉起是一条龙的"), so the hint text reflects the CURRENT STAGE of that
// pipeline from stageTimestamps (SSOT §2) — the agent sees exactly how far the
// launch has progressed and how much is left. The timeline segment uses the SAME
// sec() degradation (`?` when a stage was never reached), but is deliberately NOT
// wrapped in the `[godot-mcp warmup ...]` bracket form reserved for the post-warm
// one-shot timeline echo (§7 B5 gate) — tests count that exact bracket to assert
// one-shot semantics, and a warmup hint must not collide.
function buildWarmupHintText() {
    const start = S.spawnStartedAt || S.startedAt;
    const now = Date.now();
    const sec = (ts) => (ts && (ts - start) >= 0 ? ((ts - start) / 1000).toFixed(1) : '?');
    const segs = [
        ['spawn', S.stageTimestamps.EDITOR_SPAWNED],
        ['plugin', S.stageTimestamps.PLUGIN_INIT],
        ['listen', S.stageTimestamps.SERVER_LISTENING],
        ['ws', S.stageTimestamps.WS_HANDSHAKE],
    ];
    return `editor 正在预热中（冷启动约需 60s），这是正常情况，请稍后再调用。当前进度：spawn→${sec(segs[0][1])}s plugin→${sec(segs[1][1])}s listen→${sec(segs[2][1])}s ws→${sec(segs[3][1])}s（已等 ${Math.floor((now - start) / 1000)}s）。`;
}

// SEE-1111 预热提示 (post-warm death): the editor was warm and then died; a
// respawn round is in flight. Same friendly SUCCESS shape, distinct wording so
// an agent does not confuse a death-restart with a first cold boot.
function buildRespawnHintText() {
    return 'editor 正在重启（warm 后 editor 掉线，proxy 正在重新拉起），这是正常情况，请稍后再调用。';
}

// SEE-1111 预热提示: build the friendly warmup-hint RESULT (id is never
// forwarded to npx). data carries the same warmupDiagnostic schema as the error
// paths so an agent (or the test harness) can distinguish the hint's state
// without parsing text — and a completion/init progress notification is sent
// under the call's own token so a progress-aware client sees live progress.
function warmupHintResponse(id, forceState = 'warming', hintText = undefined) {
    const hintText2 = hintText ?? (forceState === 'warming' ? buildWarmupHintText() : buildRespawnHintText());
    const diag = warmupDiagnostic(forceState);
    if (S.firstCallProgressToken != null) {
        try {
            sendToClaude({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: progressPayload(forceState),
            });
        } catch (err) {
            log(`WARNING: warmup hint progress notification failed: ${err.message}`);
        }
    }
    return {
        jsonrpc: '2.0',
        id,
        result: {
            content: [{ type: 'text', text: hintText2 }],
            isError: false,
            data: diag,
        },
    };
}

export {
    handshakeSubstate,
    handshakePendingMs,
    buildHint,
    warmupDiagnostic,
    currentWarmupTimeout,
    progressPayload,
    notifyWarmupProgress,
    notifyStageChange,
    maybeNotifyStageChange,
    buildWarmupTimeline,
    buildWarmupHintText,
    buildRespawnHintText,
    warmupHintResponse,
};
