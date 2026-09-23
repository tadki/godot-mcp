// proxy/spawn.mjs — editor spawn orchestration + failure bookkeeping
// (extracted from godot-mcp-proxy.mjs, SEE-1334 Phase 0a): B1 lazy-load
// ensureEditor chain (arbiter → prepare → configure → start), spawn-failure
// streaks, WS-5 give-up/rearm, eviction, port-release waits.
import { execFile } from 'node:child_process';
import { mkdirSync, readlinkSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { S } from './state.mjs';
import {
    GODOT_HOST, GODOT_MCP_HOME, GODOT_PORT, GIVEUP_BASE_COOLDOWN_MS, GIVEUP_MAX_COOLDOWN_MS,
    GIVEUP_REARM_ENABLED, PORT_ARBITER_ENABLED, PORT_ARBITER_LIB,
    PORT_PROBE_INTERVAL_MS, PORT_RESPAWN_WINDOW_MS, PORT_TAKEOVER_TIMEOUT_MS,
    RUNTIME_ID, SPAWN_MAX_ATTEMPTS, SPAWN_RETRY_BACKOFF_MS, SpawnError,
    isSharedMasterWorktree, resolveHelper,
} from './config.mjs';
import { STAGE_ENUM } from '../warmup-stage-parser.mjs';
import { log, stageLog } from './log.mjs';
import { notifyWarmupProgress } from './diagnostics.mjs';
import { startRenderStableMonitor, tcpProbe } from './probes.mjs';
import { rejectQueue } from './router.mjs';
import {
    buildHelperArgs, persistSpawnStderr, readHolderAgent, readHolderWorktree,
    readWorktreeLeaseState, resolveWorktreeForSpawn, runScript,
} from './worktree.mjs';
import { decideReuse } from '../see1129-reuse-predicate.mjs';
import { decideSidecarGuard } from '../see1129-sidecar-guard-predicate.mjs';
import { maybeEvictStaleHeld } from './stale-proxy.mjs';
import { writeRuntimeState, readRuntimeState } from './state-file.mjs';
import { decideReuseSingleSource } from '../see1338-handoff.mjs';

// Extract + verify the holder proxy record from a .state doc (triple check:
// kill-0 + /proc exe node + started_at). Returns { pid, alive }.
function holderProxyFromState(st) {
    const pid = Number(st && st.proxy_pid);
    if (!Number.isInteger(pid) || pid <= 0) return { pid: null, alive: false };
    const startedAt = st.proxy_pid_started_at ? Date.parse(st.proxy_pid_started_at) : null;
    return { pid, alive: proxyAliveCore(pid, startedAt) };
}

function proxyAliveCore(pid, startedAtMs) {
    try {
        process.kill(pid, 0);
    } catch {
        return false;
    }
    try {
        const exe = String(readlinkSync(`/proc/${pid}/exe`));
        if (!exe.includes('node')) return false;
    } catch {
        return false;
    }
    if (startedAtMs != null && Number.isFinite(startedAtMs)) {
        try {
            const started = statSync(`/proc/${pid}`).mtimeMs;
            if (Math.abs(started - startedAtMs) > 5000) return false;
        } catch {
            return false;
        }
    }
    return true;
}

// Trigger the editor spawn at most once; concurrent callers share the promise.
// The trigger fires on the first tools/call after COLD_EMPTY. Spawn success/
// failure is handled here (not at the call site) so the call site stays sync.
function triggerEnsureEditor() {
    if (S.spawnInFlight) return S.spawnInFlight;
    const t0 = Date.now();
    stageLog('ENSURE_EDITOR_BEGIN', `attempt=${S.spawnAttempts + 1}`);
    S.spawnInFlight = ensureEditor(t0)
        .then((result) => {
            stageLog('ENSURE_EDITOR_END', `spawned=${result.spawned} reused=${result.reused === true} dt_ms=${Date.now() - t0}`);
            if (result.spawned) {
                notifyWarmupProgress(0);
            }
            return result;
        })
        .catch((err) => {
            handleSpawnFailure(err);
        })
        .finally(() => { S.spawnInFlight = null; });
    return S.spawnInFlight;
}

// SEE-1111 缺陷 #7: post-warm editor death respawn. When a tools/call comes
// back editor_gone (the editor's WebSocket became unreachable AFTER warmup —
// crash, lease self-exit without an exit line, WSL network reset), the old
// behavior left the proxy warm with a dead editor: every subsequent call got a
// retryable editor_gone and nothing ever re-spawned the editor (Claude had to
// restart the whole MCP server). This resets the warmup state and re-enters the
// warmup loop so the next call triggers a FRESH spawn. The current call is NOT
// replayed (drop-with-retry semantics, matching T3): the agent sees one clear
// editor_gone error and retries on its own; the respawn happens in the
// background so the retry lands on a warming (not dead) editor.
//
// warmEditorDead is cleared by resetForRespawn() before the re-entry, so the
// flag only gates RE-entry while a respawn loop is running. The resident
// runWarmupLoop() idles on this flag after WARM; flipping it wakes the loop.
function beginWarmEditorRespawn() {
    if (S.warmRespawnInFlight) return;
    S.warmRespawnInFlight = true;
    S.warmEditorDead = true;
    S.warm = false;
    S.recovering = false;
    S.renderStable = false;
    S.spawnTriggered = false;
    S.warmupTimeoutMs = null;
    // SEE-1338 §GM1a: a post-warm respawn is a NEW recovery episode — fresh
    // recovery budget (same reasoning as the give-up re-arm reset).
    S.recoveryRound = 0;
    S.recoveryWindowStart = null;
    // SEE-1338 P1 线性单源 (Atlas 裁决): EDITOR_GONE → the on-disk record
    // becomes COLD here (the linear state machine made the death call; no
    // reaper self-judgment). A lingering record in WARM after the editor
    // died would mislead the next successor into adopting a dead port.
    if (RUNTIME_ID) {
        writeRuntimeState(RUNTIME_ID, {
            state: 'COLD',
            port: GODOT_PORT,
            editor_pid: null,
            editor_pid_started_at: null,
            last_error: 'editor gone after warmup; respawn armed',
            heartbeat_at: new Date().toISOString(),
        }, { event: 'EDITOR_GONE', fromState: 'WARM', detail: 'post-warm death; respawn armed' });
    }
    // NOTE: spawnStartedAt is NOT reset — the FAILED_EXIT window in the
    // RECOVERING path is seeded from lastTcpOkAt, and buildWarmupTimeline keeps
    // the original t0 for continuity. The respawn round re-enters the outer loop
    // and re-sets spawnTriggered on the next call.
    log(`editor gone after warmup; resetting warm state for respawn (缺陷 #7). Next tools/call will re-spawn the editor.`);
}

// Reset per-round warmup state so a fresh spawn round starts clean. Keeps
// warmEditorDead=true so the next editor_gone is not counted as a NEW death
// mid-round. warmRespawnInFlight is cleared by the caller after re-entry.
// spawnTriggered is NOT touched here: beginWarmEditorRespawn already set it
// false, and a retry call that lands in the window between that and this reset
// must keep its trigger (wiping it would strand the retry in pendingCalls).
function resetForRespawn() {
    S.renderStable = false;
    S.warmupTimeoutMs = null;
    S.lastSpawnReused = false;
    for (const s of STAGE_ENUM) S.stageTimestamps[s] = null;
    S.stageTimestamps.LAUNCHER_EXEC = S.startedAt;
    S.tcpReceivedCount = 0;
    S.firstProbeOkAt = 0;   // WS-7: fresh round re-measures the bind delay
    // 缺陷 #8: a fresh spawn round gets a fresh liveness-failure counter (the
    // probe fires again only once the new editor re-warms).
    S.warmProbeFailures = 0;
}

// SEE-1091 hot-reuse hardening: the port is ALREADY listening, so no spawn is
// needed, but the stop hook sanitizes project.godot back to
// port_override_enabled=false/6550 (by-design), so a new session MUST re-pin
// the agent port. configure-mcp-port.sh has an idempotent fast path (no-op when
// the section already matches), so this is ~free per call. The editor is
// already live on GODOT_PORT, so a configure failure here is non-fatal: the
// reuse is still valid, and the failure is logged so the operator knows the
// port pin may not survive the next editor restart.
//
// Return: { status, worktree, configureRc, configureError }
//   status = 'pinned'  — configure ran and rc=0, project.godot re-pinned.
//            'failed'  — configure ran and rc!=0; reuse continues (non-fatal).
//            'skipped' — worktree/helper unresolvable; configure never attempted.
//   configureRc is a numeric diagnostic (0 / non-zero / null when not run).
//   configureError is a short reason string (null on 'pinned').
async function ensureReusedWorktreeConfigured(t0) {
    const configureSh = resolveHelper('configure-mcp-port.sh', 'GODOT_MCP_CONFIGURE_SH');
    const worktree = await resolveWorktreeForSpawn();
    if (!configureSh || !worktree) {
        const reason = !configureSh ? 'configure helper not resolved' : 'worktree unresolved';
        log(`WARNING: hot-reuse port pin skipped (${reason}); editor already live on ${GODOT_PORT}, continuing.`);
        return { status: 'skipped', worktree, configureRc: null, configureError: reason };
    }
    // SEE-1111 §7.1 防线 3: even on the hot-reuse path, never re-pin the shared
    // master checkout. The editor is already live on GODOT_PORT, so this is
    // non-fatal — the reuse continues without re-pinning (same as a helper
    // failure), and the operator is told why.
    if (isSharedMasterWorktree(worktree)) {
        log(`WARNING: hot-reuse port pin skipped (worktree is the SHARED master checkout ${worktree}); editor already live on ${GODOT_PORT}, reuse continues without re-pin.`);
        return { status: 'skipped', worktree, configureRc: null, configureError: 'shared master worktree' };
    }
    const confT0 = Date.now();
    stageLog('CONFIGURE_SH_BEGIN', `path=hot_reuse project_godot=${worktree}/project.godot`);
    const configureRes = await runScript(configureSh,
        buildHelperArgs(['--project-godot', `${worktree}/project.godot`]));
    stageLog('CONFIGURE_SH_END', `path=hot_reuse rc=${configureRes.rc} dt_ms=${Date.now() - confT0}`);
    if (configureRes.rc !== 0) {
        const msg = `configure-mcp-port.sh rc=${configureRes.rc} on hot-reuse; editor already live on ${GODOT_PORT}, reuse continues.`;
        log(`WARNING: ${msg}`);
        return { status: 'failed', worktree, configureRc: configureRes.rc, configureError: msg };
    }
    log(`hot-reuse port pin confirmed for ${worktree}/project.godot (configure rc=0, t=${Date.now() - t0}ms).`);
    return { status: 'pinned', worktree, configureRc: 0, configureError: null };
}

// SEE-1129 sidecar-guard real-machine fix (sub-step e43cdc73). When the reuse
// short-circuit finds a holder that CANNOT be proven to serve this slot's
// worktree (no .worktree sidecar = pre-#499/manual holder, or the holder's
// recorded worktree differs from ours = a different same-agent slot's editor),
// that holder must be evicted so this slot can spawn its own editor with a
// fresh sidecar. Eviction runs BOTH release-layer companions, each non-fatal:
//   1. stop-godot-editor.sh — stops THIS label's live editor (Stop-Process on
//      the recorded Windows PID, port-listener fallback), releases its lease,
//      frees the port, removes its pid/.worktree sidecars. This handles the
//      Archi residual-holder case: a live pre-#499 editor still holding the
//      port with c508560b open — the liveness-based reaper alone would NOT
//      touch a live editor, so stop is what actually frees the port.
//   2. reap-stale-leases.sh — sweeps every mcp-lease.json and reaps any whose
//      owner PID is now dead (after stop killed the editor) or whose sidecar
//      is corrupt. This clears the dead-owner residue stop leaves behind, so
//      the fresh spawn's configure-mcp-port.sh (which also runs the reaper)
//      starts from a clean slate.
// Best-effort by design: a non-zero rc is logged but never blocks the spawn
// fall-through. If the port stays busy after eviction (e.g. a non-godot
// listener), the spawn path's configure/start fails fast with a clear
// spawn_failed diagnostic — which is the correct, attributable outcome.
// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
async function evictStaleHolder(holderWorktree) {
    const t0 = Date.now();
    stageLog('EVICT_BEGIN', `port=${GODOT_PORT}`);
    const agentName = process.env.GODOT_MCP_AGENT_NAME || process.env.KOL_AGENT_NAME || '';
    const stopSh = resolveHelper('stop-godot-editor.sh', 'GODOT_MCP_STOP_SH');
    if (stopSh) {
        const args = agentName ? [agentName, '--port', String(GODOT_PORT)] : ['--port', String(GODOT_PORT)];
        // SEE-1292 respawn fix: pin the lease-release target to the STALE
        // HOLDER's own worktree. The stop helper resolves its release target
        // from label-shared lifecycle files by default, and concurrent
        // same-agent slots share the label — without the pin, evicting a dead
        // holder released the LIVE foreign slot's active lease (its next
        // editor boot then read state=released and fell back to port 6550,
        // the respawn-round warmup-timeout root cause).
        if (holderWorktree) args.push('--project-godot', `${holderWorktree}/project.godot`);
        const r = await runScript(stopSh, args);
        stageLog('EVICT_STOP_SH', `rc=${r.rc} dt_ms=${Date.now() - t0}`);
        log(`evictStaleHolder: stop-godot-editor.sh rc=${r.rc}${holderWorktree ? ' release-pinned-to-holder' : ''}${r.stderrTail ? ` stderr=${r.stderrTail.slice(-200)}` : ''}`);
    } else {
        log('evictStaleHolder: stop-godot-editor.sh not resolved (stop helper unset + not found); skipping stop.');
    }
    const reapSh = resolveHelper('reap-stale-leases.sh', 'GODOT_MCP_REAP_SH');
    if (reapSh) {
        const reapT0 = Date.now();
        // SEE-1292 respawn fix: scope the reaper sweep to the holder worktree
        // when known. A global sweep here races a CONCURRENT slot's fresh
        // spawn: the fresh active lease's configured_by_pid is the (already
        // dead) configure shell, so only the 120s fresh-grace protects it —
        // a sweep arriving past that grace released a live slot's lease.
        const reapArgs = holderWorktree ? ['--root', holderWorktree] : [];
        const r = await runScript(reapSh, reapArgs);
        stageLog('EVICT_REAP_SH', `rc=${r.rc} dt_ms=${Date.now() - reapT0}`);
        log(`evictStaleHolder: reap-stale-leases.sh rc=${r.rc}${holderWorktree ? ' (holder-scoped)' : ' (global)'}${r.stderrTail ? ` stderr=${r.stderrTail.slice(-200)}` : ''}`);
    } else {
        log('evictStaleHolder: reap-stale-leases.sh not resolved (reap helper unset + not found); skipping reap.');
    }
    stageLog('EVICT_END', `dt_ms=${Date.now() - t0}`);
}

function arbiterDecide(port) {
    return new Promise((resolve) => {
        if (!PORT_ARBITER_ENABLED) return resolve('legacy');
        const script = `source "$1" && port_arbiter_decide "$2" "$3"`;
        execFile('bash', ['-c', script, 'arb', PORT_ARBITER_LIB, String(port), RUNTIME_ID], {
            env: { ...process.env },
            timeout: 15000,
        }, (err, stdout) => {
            if (err) return resolve('legacy');   // arbiter unavailable → legacy path
            const v = String(stdout).trim();
            resolve(['free', 'reuse', 'respawn', 'evict', 'busy_foreign'].includes(v) ? v : 'legacy');
        });
    });
}

// Wait for a same-runtime busy port to be released. `mode` is 'respawn'
// (bounded by the respawn window) or 'reuse' (hot takeover, bounded by the
// takeover timeout). Polls port liveness; resolves true when the port frees
// (or a QUIT_DELAY/ESTABLISHED release signal appears) so the caller can
// spawn, false on timeout. Never mis-kills: on respawn-window expiry the
// caller decides to evict, not this loop. The probed port is the module-level
// GODOT_PORT (tcpProbe binds it implicitly) — callers always pass GODOT_PORT,
// so no parameter is taken (Atlas Final Review LOW-1: a dead `port` param
// would mislead future callers into thinking an arbitrary port is probed).
async function waitForPortRelease(mode) {
    const t0 = Date.now();
    const budget = mode === 'respawn' ? PORT_RESPAWN_WINDOW_MS : PORT_TAKEOVER_TIMEOUT_MS;
    stageLog('WAIT_RELEASE_BEGIN', `mode=${mode} budget_ms=${budget}`);
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
        if (!(await tcpProbe())) {
            stageLog('WAIT_RELEASE_END', `mode=${mode} freed=true dt_ms=${Date.now() - t0}`);
            return true;    // port freed → caller may spawn
        }
        await new Promise((r) => setTimeout(r, PORT_PROBE_INTERVAL_MS));
    }
    stageLog('WAIT_RELEASE_END', `mode=${mode} freed=false dt_ms=${Date.now() - t0}`);
    return false;
}

// Spawn the editor: probe short-circuit (reuse) → configure → start. Throws
// SpawnError on any failure; the caller (triggerEnsureEditor) maps it to a
// spawn_failed diagnostic. `t0` is the spawn-trigger timestamp, kept so the
// warmup clock starts from the user's first call, not spawn completion.
// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
async function ensureEditor(t0) {
    S.spawnAttempts += 1;
    // (1) probe short-circuit: port already listening => someone (a prior
    //     editor, a concurrent proxy) holds it; do NOT spawn (design §6/T2).
    //     The warmupLoop then classifies hot and reuses it. SEE-1091: even on
    //     the reuse path the agent port must be re-pinned in project.godot (the
    //     stop hook sanitized it), so configure runs here too — idempotent fast
    //     path, non-fatal on failure since the editor is already live.
    if (await tcpProbe()) {
        stageLog('TCP_PROBE_SHORTCIRCUIT', `port=${GODOT_PORT}`);
        // SEE-1338 P1 (spec §4.2 + 线性单源裁决): when a readable .state record
        // exists for this runtime, THE DISK is the sole reuse decision input —
        // holder pid triple-check + worktree + state, all on-disk fields, one
        // pure-function branch (see1338-handoff decideReuseSingleSource). The
        // legacy four-flow stack (arbiter verdict → reuse predicate → sidecar
        // guard → HANDOFF downgrade) runs ONLY when no .state record exists
        // (legacy runtime / frozen lane). No live probes here: every condition
        // must already be on the record (warm-gate 教训).
        if (RUNTIME_ID) {
            const disk = readRuntimeState(RUNTIME_ID);
            if (disk.ok) {
                const st = disk.state;
                const holder = holderProxyFromState(st);
                const ourWorktree = await resolveWorktreeForSpawn();
                const reuse = decideReuseSingleSource({
                    state: st.state,
                    holderProxyAlive: holder.alive,
                    holderWorktree: st.worktree || '',
                    ourWorktree: ourWorktree || '',
                    samePort: String(st.port || '') === String(GODOT_PORT),
                });
                stageLog('SINGLE_SOURCE_REUSE', `action=${reuse.action} reason=${reuse.reason}`);
                if (reuse.action === 'handoff_reuse') {
                    S.lastSpawnReused = true;
                    S.spawnLastFailed = false;
                    const reused = await ensureReusedWorktreeConfigured(t0);
                    log(`single-source reuse (state=${st.state}, holder proxy ${holder.alive ? 'alive' : 'dead'}, worktree match): adopting the live editor (HANDOFF).`);
                    return { spawned: false, reused: true, staleHandoff: true, worktree: reused.worktree, reuseStatus: reused.status, configureRc: reused.configureRc, configureError: reused.configureError };
                }
                if (reuse.action === 'editor_busy') {
                    throw new SpawnError('editor_busy',
                        `port ${GODOT_PORT} is managed by a LIVE proxy of this runtime per the on-disk record (${reuse.reason}) — 前任在管, never double-managed. Retry later.`,
                        { worktree: null });
                }
                // cold_start (incl. record says WARMING→dead / FAILED_CLEAN /
                // worktree mismatch): fall through — the legacy lanes below own
                // the physical cleanup (stop the port holder it can attribute).
                log(`single-source decision: ${reuse.reason} → legacy cleanup lane.`);
            }
        }
        // SEE-1148 P2 (§2.3): consult the reuse/evict decision tree FIRST. The
        // arbiter verdict (PID liveness + runtime-id match, /dev/tcp probed)
        // selects the action; the legacy SEE-1129 sidecar guard is the
        // fallback when the arbiter is unavailable ('legacy').
        const arbT0 = Date.now();
        const verdict = await arbiterDecide(GODOT_PORT);
        stageLog('ARBITER_VERDICT', `verdict=${verdict} dt_ms=${Date.now() - arbT0}`);
        if (verdict === 'evict' || verdict === 'respawn') {
            // SEE-1338 QA defect #1 (real-machine s3y, HIGH): the arbiter
            // verdicts are PROXY-pid based — but the EDITOR outlives its proxy,
            // and the fork CLI connects to it at CLI boot. In the QA topology
            // (old session's proxy dead, same worktree) verdict=evict killed
            // the very editor OUR OWN CLI had already connected to, and the
            // follow-up spawn hit the async-stop "port already in use" → the
            // whole session ground down (162s evict + 600s RECOVERING). Spec
            // §4.2: 连上 = 接管，不拉新 editor. So before ANY kill: when the
            // holder editor provably serves THIS slot's worktree (SEE-1129
            // sidecar match — the same reuse standard the legacy lane uses),
            // ADOPT it (hot reuse) instead of evicting.
            const holderWorktree = await readHolderWorktree();
            const ourWorktree = await resolveWorktreeForSpawn();
            if (holderWorktree && ourWorktree
                && decideSidecarGuard(holderWorktree, ourWorktree) === 'reuse') {
                S.lastSpawnReused = true;
                S.spawnLastFailed = false;
                const reused = await ensureReusedWorktreeConfigured(t0);
                log(`arbiter verdict ${verdict} downgraded to HANDOFF reuse: the holder editor provably serves this slot (worktree=${holderWorktree}); adopting the live editor (our CLI may already be connected to it).`);
                return { spawned: false, reused: true, staleHandoff: true, worktree: reused.worktree, reuseStatus: reused.status, configureRc: reused.configureRc, configureError: reused.configureError };
            }
            if (verdict === 'evict') {
                // PID dead + runtime id mismatch/missing: cross-runtime stale
                // holder (different worktree — not ours to adopt). Immediate
                // evict (kill editor, cold-start), NO wait.
                log(`port ${GODOT_PORT} held by a DEAD cross-runtime proxy (runtime id mismatch); immediate evict then cold-start (no 300s wait).`);
                await evictStaleHolder(holderWorktree);
                // SEE-1338 QA (s3y root cause C): stop-godot-editor.sh rc=0 is
                // ASYNC on the Windows side — the dying editor held the port
                // for seconds after rc=0 and the follow-up spawn failed
                // "port already in use". Wait (bounded) before spawning.
                await waitForPortRelease('respawn');
                // fall through to spawn below.
            } else {
                // PID dead + SAME runtime id: our own editor is mid-respawn. Wait
                // for release within the respawn window; evict ONLY if the window
                // expires without the new proxy re-binding (never mis-kill).
                log(`port ${GODOT_PORT} busy but holder is THIS runtime (dead proxy, respawn in progress); waiting up to ${PORT_RESPAWN_WINDOW_MS}ms for release.`);
                const freed = await waitForPortRelease('respawn');
                if (freed) {
                    log(`port ${GODOT_PORT} freed within respawn window; spawning fresh editor.`);
                    // fall through to spawn below.
                } else {
                    log(`respawn window expired (${PORT_RESPAWN_WINDOW_MS}ms) with port still held; evicting stale holder then spawning.`);
                    await evictStaleHolder(holderWorktree);
                    await waitForPortRelease('respawn');
                    // fall through to spawn below.
                }
            }
        } else if (verdict === 'reuse') {
            // PID alive + SAME runtime: hot takeover. Wait for the holder to
            // release (ESTABLISHED change / QUIT_DELAY), bounded by the 300s
            // takeover timeout, then spawn if freed. SEE-1338 spec v2.1 AMEND-1:
            // the holder proxy is verifiably ALIVE — 前任在管，never killed; a
            // non-release past the window keeps the clean retryable
            // editor_busy (the R2 RECOVERING hard cap + FAILED_CLEAN backstop
            // own the recovery if the holder is wedged).
            log(`port ${GODOT_PORT} held by a LIVE proxy of THIS runtime; hot takeover — waiting up to ${PORT_TAKEOVER_TIMEOUT_MS}ms for release.`);
            const freed = await waitForPortRelease('reuse');
            if (freed) {
                log(`port ${GODOT_PORT} released by holder; spawning fresh editor.`);
                // fall through to spawn below.
            } else {
                throw new SpawnError('editor_busy',
                    `port ${GODOT_PORT} is held by a live same-runtime proxy that did not release within ${PORT_TAKEOVER_TIMEOUT_MS}ms (hot takeover timeout). Retry shortly.`,
                    { worktree: null });
            }
        } else if (verdict === 'busy_foreign') {
            // PID alive + DIFFERENT runtime: editor_busy retryable — the other
            // runtime legitimately owns the port; AMEND-1 (spec v2.1 §4.2):
            // a live holder is NEVER evicted or killed (前任在管). Its release
            // path is its own proxy disconnect / lease self-exit / the R1 reaper.
            throw new SpawnError('editor_busy',
                `port ${GODOT_PORT} is held by a live proxy of a DIFFERENT runtime (editor_busy). The holder owns the slot; retry after it releases (its proxy disconnects, or the editor's lease self-exits).`,
                { worktree: null });
        } else if (verdict === 'legacy') {
        // Legacy SEE-1129 path (arbiter disabled/unavailable): sidecar guard.
        // SEE-1129 (instance selection layer): ports are allocated per agent
        // NAME, so a same-agent concurrent session slot shares this port+LABEL.
        // Before adopting the holder's Godot instance, verify the holder is
        // THIS slot's editor (its recorded worktree matches the worktree this
        // proxy resolved). A foreign holder (a different same-agent slot's
        // editor, with that slot's project open) MUST NOT be silently reused —
        // doing so serves the wrong worktree (godot_project get_info returns the
        // holder's path).
        const holderWorktree = await readHolderWorktree();
        const ourWorktree = await resolveWorktreeForSpawn();
        const holderAgent = await readHolderAgent();
        const ourAgent = process.env.GODOT_MCP_AGENT_NAME || process.env.KOL_AGENT_NAME || '';

        // SEE-1129 Owner principle #5 (cross-agent contention): a holder on a
        // DIFFERENT agent means a duplicate/misconfigured port mapping — two
        // agents must never share one port. Refuse loudly (retryable).
        if (decideReuse(holderAgent, ourAgent, holderWorktree, ourWorktree) === 'foreign') {
            throw new SpawnError('instance_busy_foreign',
                `port ${GODOT_PORT} is held by a DIFFERENT agent (holder agent ${holderAgent || '?'}, this agent ${ourAgent || '?'}). Ports are allocated per agent name (agent-ports.json), so this indicates a duplicate/misconfigured port mapping — two agents must not share one port. Holder worktree ${holderWorktree}, this slot ${ourWorktree}. Refusing to hijack the holder (principle #5). Fix agent-ports.json so each agent has a unique port.`,
                { worktree: ourWorktree, holderWorktree, holderAgent, ourAgent });
        }

        // SEE-1129 sidecar-guard real-machine fix (sub-step e43cdc73). The reuse
        // short-circuit must NOT silently adopt a holder whose sidecar is absent
        // or whose recorded worktree differs from this slot's — that holder has
        // a DIFFERENT project open, so godot_project get_info would return the
        // holder's path, not this slot's. The earlier M3 back-compat branch
        // ("sidecar missing → reuse") was the design error Atlas confirmed: on
        // the real machine the absent-sidecar case is a pre-#499 spawned holder
        // (or a same-agent concurrent slot), and reusing it is exactly the path
        // misdirection Archi reproduced. Fix = plan C: when the holder cannot be
        // PROVEN to serve this slot's worktree, evict it (the startup reaper
        // releases its stale active lease + kills the orphaned editor) and fall
        // through to the spawn path, which writes a fresh sidecar for this slot.
        const sidecarGuard = decideSidecarGuard(holderWorktree, ourWorktree);
        if (sidecarGuard === 'evict') {
            const why = !holderWorktree
                ? `holder sidecar absent (pre-#499 or manual holder — untrusted)`
                : `holder worktree ${holderWorktree} != this slot ${ourWorktree}`;
            log(`port ${GODOT_PORT} busy but holder will not serve this slot (${why}); evicting stale holder then spawning our own editor.`);
            await evictStaleHolder(holderWorktree);
            // The eviction may have just freed the port; fall through to the
            // spawn path (which re-probes via configure/start). Do NOT return a
            // reuse result — this slot needs its own editor with its own sidecar.
        } else {
            // Holder is THIS slot's editor (sidecar present + worktree match):
            // safe to reuse. Same-agent different-worktree is impossible here
            // (the worktree match proves it). The single-client WS addon limit
            // means a concurrent same-agent proxy's connect still gets 4001 —
            // the editor_busy takeover path handles that wait.
            S.lastSpawnReused = true;
            S.spawnLastFailed = false; // a successful port reuse clears the failure latch too
            log(`port ${GODOT_PORT} already listening; holder confirmed for this slot (worktree=${holderWorktree}); skipping spawn (reuse).`);
            const reused = await ensureReusedWorktreeConfigured(t0);
            return { spawned: false, reused: true, worktree: reused.worktree, reuseStatus: reused.status, configureRc: reused.configureRc, configureError: reused.configureError };
        }
        } // end verdict === 'legacy'
    }

    const configureSh = resolveHelper('configure-mcp-port.sh', 'GODOT_MCP_CONFIGURE_SH');
    const startSh = resolveHelper('start-godot-editor.sh', 'GODOT_MCP_START_SH');
    if (!configureSh || !startSh) {
        throw new SpawnError('spawn_failed_exception',
            `helper scripts not resolved (configure=${configureSh} start=${startSh})`);
    }

    const worktree = await resolveWorktreeForSpawn();
    if (!worktree) {
        throw new SpawnError('worktree_unresolved',
            'KOL_WORKTREE/KOL_PROJECT_GODOT unset and no project.godot found walking up from the proxy',
            { worktree: null });
    }
    // SEE-1111 §7.1 防线 3: refuse to rewrite the shared master checkout.
    if (isSharedMasterWorktree(worktree)) {
        throw new SpawnError('worktree_shared_master',
            `worktree resolution landed on the SHARED master checkout (${worktree}); refusing to spawn the editor against it. ` +
            `Each agent must use its PRIVATE worktree (mcp-multi-port-usage.md §3.7/§7.1).`,
            { worktree });
    }

    // SEE-1111 (cold-start one-shot): generate project.godot when ABSENT before
    // configuring. project.godot is gitignored + untracked since PR#479, so a
    // worktree that already existed at deploy time (or whose checkout-time
    // prepare-worktree.sh self-location failed) has NO project.godot, and
    // configure-mcp-port.sh dies with `configure_failed` (non-existent file)
    // before the editor ever spawns. prepare-worktree.sh is idempotent: absent →
    // copy the clean file (D-drive working tree, fallback historical blob
    // e776b314) + pin this agent's port; present → re-pin no-op. Its write-target
    // guard refuses the shared master checkout, which we already rejected above.
    const prepareSh = resolveHelper('prepare-worktree.sh', 'GODOT_MCP_PREPARE_SH');
    const prepT0 = Date.now();
    stageLog('PREPARE_SH_BEGIN', `worktree=${worktree}`);
    const prepareRes = await runScript(prepareSh,
        buildHelperArgs(['--worktree', worktree]));
    stageLog('PREPARE_SH_END', `rc=${prepareRes.rc} dt_ms=${Date.now() - prepT0}`);
    if (prepareRes.rc !== 0) {
        await persistSpawnStderr('prepare-worktree.sh', prepareRes.rc, prepareRes.stderrFull);
        throw new SpawnError('configure_failed',
            `prepare-worktree.sh rc=${prepareRes.rc}`,
            { configureRc: prepareRes.rc, configureStderr: prepareRes.stderrTail, worktree });
    }

    // (2) configure project.godot port_override first (the editor reads the
    //     port from project.godot at boot). Failure => configure_failed bucket.
    const confT0 = Date.now();
    stageLog('CONFIGURE_SH_BEGIN', `path=spawn project_godot=${worktree}/project.godot`);
    let configureRes = await runScript(configureSh,
        buildHelperArgs(['--project-godot', `${worktree}/project.godot`]));
    stageLog('CONFIGURE_SH_END', `path=spawn rc=${configureRes.rc} dt_ms=${Date.now() - confT0}`);
    if (configureRes.rc !== 0) {
        await persistSpawnStderr('configure-mcp-port.sh', configureRes.rc, configureRes.stderrFull);
        throw new SpawnError('configure_failed',
            `configure-mcp-port.sh rc=${configureRes.rc}`,
            { configureRc: configureRes.rc, configureStderr: configureRes.stderrTail, worktree });
    }

    // SEE-1292 respawn fix (defense in depth): the editor binds its WS port
    // from the lease sidecar read AT BOOT — a lease that is not state=active
    // when START runs makes the addon fall back to the default port 6550 and
    // the whole warmup window is then spent probing the wrong port. Concurrent
    // same-agent slots (shim rechain racing an old proxy's respawn round, a
    // foreign evict's stop/reap sweep) can release OUR fresh lease between
    // configure's write and START. Assert-then-reactivate closes that race:
    // re-run configure (it clears stale release traces, lease_id preserved)
    // until the sidecar reads active@GODOT_PORT, bounded — a persistent
    // mismatch fails the spawn with the standard configure_failed bucket.
    const leaseVerifyT0 = Date.now();
    for (let leaseAttempt = 0; leaseAttempt < 3; leaseAttempt += 1) {
        const leaseState = await readWorktreeLeaseState(worktree);
        if (leaseState && leaseState.state === 'active' && String(leaseState.port) === String(GODOT_PORT)) {
            if (leaseAttempt > 0) {
                stageLog('LEASE_REACTIVATED', `attempts=${leaseAttempt + 1} dt_ms=${Date.now() - leaseVerifyT0}`);
                log(`lease sidecar re-activated after ${leaseAttempt} rewrite(s) (was released by a concurrent slot sweep).`);
            }
            break;
        }
        log(`WARNING: lease sidecar not active@${GODOT_PORT} before START (state=${leaseState ? leaseState.state : 'absent'}, port=${leaseState ? leaseState.port : 'n/a'}); re-running configure (attempt ${leaseAttempt + 1}/3).`);
        stageLog('CONFIGURE_SH_BEGIN', `path=spawn_reactivate project_godot=${worktree}/project.godot`);
        const reactivateRes = await runScript(configureSh,
            buildHelperArgs(['--project-godot', `${worktree}/project.godot`]));
        stageLog('CONFIGURE_SH_END', `path=spawn_reactivate rc=${reactivateRes.rc} dt_ms=${Date.now() - leaseVerifyT0}`);
        if (reactivateRes.rc !== 0) {
            await persistSpawnStderr('configure-mcp-port.sh', reactivateRes.rc, reactivateRes.stderrFull);
            throw new SpawnError('configure_failed',
                `configure-mcp-port.sh rc=${reactivateRes.rc} (lease reactivation)`,
                { configureRc: reactivateRes.rc, configureStderr: reactivateRes.stderrTail, worktree });
        }
    }

    // (3) spawn the editor; start-godot-editor.sh backgrounds the editor and
    //     returns quickly (the editor keeps booting; warmupLoop probes TCP).
    //     Failure => spawn_failed_start bucket (port clash, missing binary,
    //     schtasks + nohup both failed).
    const startT0 = Date.now();
    stageLog('START_SH_BEGIN', `worktree=${worktree}`);
    const startRes = await runScript(startSh,
        buildHelperArgs(['--worktree', worktree]));
    stageLog('START_SH_END', `rc=${startRes.rc} dt_ms=${Date.now() - startT0}`);
    if (startRes.rc !== 0) {
        await persistSpawnStderr('start-godot-editor.sh', startRes.rc, startRes.stderrFull);
        throw new SpawnError('spawn_failed_start',
            `start-godot-editor.sh rc=${startRes.rc}`,
            { startRc: startRes.rc, startStderr: startRes.stderrTail, configureRc: configureRes.rc, worktree });
    }

    log(`editor spawn launched (configure rc=${configureRes.rc}, start rc=${startRes.rc}, t=${Date.now() - t0}ms); waiting for port ${GODOT_PORT}.`);
    stageLog('SPAWN_RETURNED', `dt_ms=${Date.now() - t0}`);
    S.lastSpawnReused = false;
    S.spawnLastFailed = false; // a successful spawn clears the failure latch (预热提示 误报防护)
    // SEE-1338 spec v2.1 §3.3: SPAWN_ISSUED — the editor process is coming
    // up; record COLD + the spawn attempt count so a successor reads a
    // WARMING-shaped record (state transitions land at the probe loop).
    if (RUNTIME_ID) {
        writeRuntimeState(RUNTIME_ID, {
            state: 'WARMING',
            port: GODOT_PORT,
            spawn_attempts: S.spawnAttempts,
            last_error: null,
            heartbeat_at: new Date().toISOString(),
        }, { event: 'SPAWN_ISSUED', fromState: 'COLD', detail: `start rc=${startRes.rc}` });
    }
    return { spawned: true, worktree, configureRc: configureRes.rc, startRc: startRes.rc };
}

// Map a SpawnError to the warmupDiagnostic-style data object attached to the
// spawn_failed error response. `failedClean` switches the state name only —
// both variants are retryable (FAILED_CLEAN is reentrant per spec §6: the
// next tools/call retries the cold start after the backoff window — never a
// dead end). See design §7 + SEE-1338 spec v2.1 §6.
function spawnFailedDiagnostic(bucket, err, failedClean = false) {
    const now = Date.now();
    const e = err || {};
    return {
        state: failedClean ? 'FAILED_CLEAN' : 'spawn_failed',
        bucket,
        host: GODOT_HOST,
        port: GODOT_PORT,
        spawnAttempts: S.spawnAttempts,
        configureRc: e.configureRc ?? null,
        startRc: e.startRc ?? null,
        spawnStderr: e.startStderr || e.configureStderr || (e.message ? String(e.message) : ''),
        worktree: e.worktree !== undefined ? e.worktree : null,
        elapsedMs: now - S.startedAt,
        retryable: true,
        spawnBackoffUntilMs: S.spawnBackoffUntil > 0 ? S.spawnBackoffUntil : null,
    };
}

// Handle a spawn failure: count the bucket streak, arm the exponential
// backoff (spec §6: capped at 60s); at the streak limit enter FAILED_CLEAN —
// a REENTRANT state that answers the current call with a clean structured
// error and lets the NEXT tools/call (after the cooldown) retry the cold
// start in-band. Otherwise reject the calls buffered during this attempt
// with the spawn_failed diagnostic and reset spawnTriggered so the next
// tools/call re-triggers after the backoff window. warmupLoop's main loop
// sees spawnTriggered flip false and returns to COLD_EMPTY idle.
function handleSpawnFailure(err) {
    const bucket = (err && err.bucket) || 'spawn_failed_exception';
    S.spawnFailedStreak = (bucket === S.spawnFailedBucket)
        ? S.spawnFailedStreak + 1
        : 1;
    S.spawnFailedBucket = bucket;
    log(`ERROR: editor spawn failed (bucket=${bucket}, attempt=${S.spawnAttempts}, streak=${S.spawnFailedStreak}): ${err.message}`);
    S.spawnLastError = err;
    maybeEscalateDeadHolderEvict(bucket, S.spawnFailedStreak);
    if (S.spawnFailedStreak >= SPAWN_MAX_ATTEMPTS) {
        // spec §6: streak limit → FAILED_CLEAN (reentrant). The fail-fast
        // first-report: held calls are answered with the structured diagnostic.
        rejectQueue(
            `editor spawn kept failing (${bucket}); state=FAILED_CLEAN — the next tools/call retries the cold start automatically (no MCP restart needed)`,
            spawnFailedDiagnostic(bucket, err, true),
        );
        // SEE-1240 WS-5 (C9): the terminal no longer ends the road — record the
        // give-up, arm the exponential-backoff cooldown, and re-arm the warmup
        // state machine so the next tools/call (after the cooldown) re-enters
        // warmup in-band. KOL_GIVEUP_REARM=0 restores the legacy permanent
        // terminal (operator escape hatch / test seam).
        if (GIVEUP_REARM_ENABLED) {
            giveUpAndRearm(bucket, err.message);
        } else {
            S.spawnTerminal = true;
            S.spawnLastFailed = true;
        }
        return;
    }
    // spec §6: spawn failures are NEVER terminal — arm the exponential
    // backoff window (base × 2^(streak-1), capped at 60s). A tools/call
    // arriving inside the window is answered with the real diagnostic +
    // retry-after instead of hot-looping the spawn.
    S.spawnBackoffUntil = Date.now()
        + Math.min(SPAWN_RETRY_BACKOFF_MS * 2 ** (S.spawnFailedStreak - 1), GIVEUP_MAX_COOLDOWN_MS);
    // SEE-1111 预热提示: non-terminal failure. Latched so the next tools/call
    // surfaces the real spawn_failed diagnostic (误报防护) instead of a friendly
    // "warming" hint — the agent must learn the spawn broke, not that the editor
    // is merely booting. Cleared on the next successful spawn attempt.
    S.spawnLastFailed = true;
    rejectQueue(
        `editor spawn failed: ${bucket}; will retry after backoff on the next call`,
        spawnFailedDiagnostic(bucket, err, false),
    );
    S.spawnTriggered = false;
    S.spawnInFlight = null;
}

// SEE-1338 spec v2.1 §4.2 (AMEND-1): repeated spawn failures against a busy
// port may mean a DEAD holder's orphaned editor. On streak ≥ 2, classify the
// held record; ONLY a dead holder is evictable — a live holder is 前任在管
// (AMEND-1: never cleaned, never killed) and keeps the clean editor_busy.
function maybeEscalateDeadHolderEvict(bucket, streak) {
    if (streak < 2 || S.staleTakeoverInFlight) return;
    if (bucket !== 'editor_busy' && bucket !== 'instance_busy_foreign' && bucket !== 'spawn_failed_start') return;
    S.staleTakeoverInFlight = true;
    log(`WARNING: spawn bucket ${bucket} streak=${streak} — classifying held record; only a DEAD holder is evictable (AMEND-1).`);
    maybeEvictStaleHeld(() => evictStaleHolder(null))
        .catch((err) => log(`stale-holder evict escalation failed (non-fatal): ${err && err.message}`))
        .finally(() => { S.staleTakeoverInFlight = false; });
}

// SEE-1338 spec v2.1 §6 (R2 hard-cap backstop): the RECOVERING absolute cap
// (2× cold timeout, measured from RECOVERING entry) expired — FORCE a cold
// restart regardless of any self-heal blips inside the window: evict OUR OWN
// editor clue (pinned to our own worktree, never a foreign holder), wait for
// the port to release, reset the round clock, and re-spawn. The respawn's own
// outcome flows into the normal spawn-failure streak channel (→ FAILED_CLEAN
// after K attempts), so this can never loop an infinite RECOVERING fake-retry
// (形态 B 根治点). Caller-bounded by forceRestartCount: after K forced
// restarts the caller falls back to the FAILED_CLEAN path instead.
async function forceColdRestart(trigger) {
    if (S.warmRespawnInFlight) return false;
    S.warmRespawnInFlight = true;
    try {
        S.forceRestartCount += 1;
        stageLog('FORCE_COLD_RESTART', `trigger=${trigger} n=${S.forceRestartCount}/${SPAWN_MAX_ATTEMPTS}`);
        log(`RECOVERING hard cap (2× cold timeout) reached; forcing cold restart #${S.forceRestartCount}/${SPAWN_MAX_ATTEMPTS} — evicting our editor and respawning (R2, spec §6).`);
        // The editor being restarted is by construction OUR OWN spawn (we are
        // inside our own spawn round's RECOVERING) — pin the eviction to our
        // own worktree, exactly like the WS-7 grace-race respawn path. A
        // foreign holder is never the target; a port it squats on surfaces as
        // spawn_failed_start → streak → FAILED_CLEAN instead.
        const ourWorktree = await resolveWorktreeForSpawn();
        if (ourWorktree) await evictStaleHolder(ourWorktree);
        await waitForPortRelease('respawn');
        S.warm = false;
        S.recovering = false;
        S.warmEditorDead = false;
        S.renderStable = false;
        startRenderStableMonitor();
        S.warmupTimeoutMs = null;
        S.lastSpawnReused = false;
        S.tcpReceivedCount = 0;
        S.firstProbeOkAt = 0;
        for (const s of STAGE_ENUM) S.stageTimestamps[s] = null;
        S.stageTimestamps.LAUNCHER_EXEC = S.startedAt;
        S.stage = 'EDITOR_SPAWNED';
        S.spawnStartedAt = Date.now();
        S.spawnAttempts = 0;
        triggerEnsureEditor();  // failure → handleSpawnFailure → streak → FAILED_CLEAN
        return true;
    } finally {
        S.warmRespawnInFlight = false;
    }
}

// SEE-1240 WS-5 (C9 目标1/2): record one give-up event, arm the exponential-
// backoff cooldown, and RE-ARM the warmup state machine in-band. The proxy
// stays alive (no process.exit), so a post-cooldown tools/call re-triggers the
// spawn without an MCP restart. Backoff doubles per give-up (capped) so a
// persistently broken environment stops paying the ~270s cold-start cost per
// call. spawnLastError is intentionally NOT cleared here: the cooldown-era
// tools/call surfaces the ORIGINAL first-report error (fail-fast 首报保留 —
// "spawn failed NEVER show warming" holds; the rearm path below only clears
// the latch after the first report has been consumed by real calls).
function giveUpAndRearm(bucket, message) {
    S.spawnTerminal = false;
    S.giveUpCount += 1;
    S.giveUpBackoffMs = S.giveUpCount === 1
        ? GIVEUP_BASE_COOLDOWN_MS
        : Math.min(S.giveUpBackoffMs * 2, GIVEUP_MAX_COOLDOWN_MS);
    S.giveUpArmedAt = Date.now();
    S.giveUpLastReason = `${bucket}: ${message}`;
    S.spawnLastFailed = true;    // 首报保留: next call sees the real terminal error
    S.spawnTriggered = false;    // re-arm: next call re-enters warmup (after cooldown)
    S.spawnInFlight = null;
    S.recovering = false;        // T4 callers enter from RECOVERING; the re-armed round must not inherit it
    S.warmupTimedOut = false;    // ditto — the FAILED_EXIT latch must not block the re-armed round's tools/call
    S.warmupTimeoutMs = null;    // fresh spawn round re-classifies cold/hot
    // SEE-1338 §GM1a: the re-armed round is a NEW recovery episode — reset the
    // recovery-round budget (window + counter) or planRecoveryBudget measures
    // elapsed from the stale proxy-start anchor and every future recovery round
    // degrades to "budget exhausted → give up" with no respawn attempt.
    S.recoveryRound = 0;
    S.recoveryWindowStart = null;
    S.forceRestartCount = 0;   // FAILED_CLEAN reentry = fresh hard-cap budget
    S.spawnBackoffUntil = 0;
    if (RUNTIME_ID) {
        // SEE-1338 spec v2.1 §3.3 STATE_TRANSITION → FAILED_CLEAN: the
        // re-entrant failure state lands on disk so the NEXT proxy's startup
        // handoff reads it and cold-starts immediately (spec §4.2:
        // FAILED_CLEAN / 陈旧 / 无文件 → 清理 → 冷启动). P1 线性单源追加:
        // the retry-budget counters are ALSO on-disk state — a dead proxy
        // must not lose its budget (进程死了预算状态不丢, Atlas 裁决).
        writeRuntimeState(RUNTIME_ID, {
            state: 'FAILED_CLEAN',
            port: GODOT_PORT,
            spawn_attempts: S.spawnAttempts,
            spawn_failed_streak: S.spawnFailedStreak,
            spawn_backoff_until: S.spawnBackoffUntil || null,
            give_up_count: S.giveUpCount,
            give_up_backoff_ms: S.giveUpBackoffMs,
            give_up_armed_at: S.giveUpArmedAt || null,
            force_restart_count: S.forceRestartCount,
            recovery_round: S.recoveryRound,
            last_error: `${bucket}: ${message}`,
            heartbeat_at: new Date().toISOString(),
        }, { event: 'STATE_TRANSITION', detail: 'streak exhausted; FAILED_CLEAN armed' });
    }
    // SEE-1338 review MEDIUM-1: the re-armed round also gets a FRESH warmup
    // clock. The give-up cooldown consumed the old window — keeping the
    // original spawnStartedAt meant the next round's attempts raced a
    // long-expired warmup timer, instantly dropping into RECOVERING before
    // their pipeline finished (the give-up #2 never landed). A NEW episode
    // measures its warmup window from re-entry, same as forceColdRestart.
    S.spawnStartedAt = 0;
    // The re-armed round continues INSIDE the current warmupLoop invocation (the
    // T4 sites break the probe loop, not the function), so the render-stable
    // monitor must be restarted here — its interval was cleared at WARM/exit and
    // renderStable must be re-proven before the next flush gate opens.
    S.renderStable = false;
    startRenderStableMonitor();
    persistGiveUpStatus('give_up', bucket, message);
    log(`give-up #${S.giveUpCount} recorded (bucket=${bucket}); re-armed — cooldown ${Math.floor(S.giveUpBackoffMs / 1000)}s before the next attempt (WS-5).`);
}

// SEE-1240 WS-5 (C9 目标4): persist give-up/rearm counters to the WS-4 status
// file so godot-status.sh / doctor can query them. Mirrors kol_lifecycle_path:
// non-solo runtime_ids use the per-slot directory form; -solo/manual runs fall
// back to the legacy flat name. Best-effort: a write failure is logged, never
// thrown — the give-up path must not depend on observability.
function persistGiveUpStatus(event, bucket, message) {
    try {
        const dir = path.join(GODOT_MCP_HOME, 'godot-editor');
        const rid = process.env.GODOT_MCP_RUNTIME_ID || process.env.KOL_RUNTIME_ID || '';
        const legacyLabel = (process.env.GODOT_MCP_AGENT_NAME || process.env.KOL_AGENT_NAME || '').toLowerCase();
        const file = (rid && rid !== '*' && !rid.endsWith('-solo') && rid.match(/^[A-Za-z][A-Za-z0-9_-]*-[0-9a-f]{8}$/))
            ? path.join(dir, `${rid}.giveup.json`)
            : path.join(dir, `godot-editor-${legacyLabel || 'unknown'}.giveup.json`);
        const doc = {
            schema: 'see1240-ws5-giveup/1',
            state: 'FAILED_CLEAN',
            updated_at: new Date().toISOString(),
            giveup_count: S.giveUpCount,
            last_event: event,
            last_bucket: bucket,
            last_reason: message,
            last_giveup_at: S.giveUpArmedAt ? new Date(S.giveUpArmedAt).toISOString() : null,
            backoff_ms: S.giveUpBackoffMs,
            cooldown_until: S.giveUpArmedAt ? new Date(S.giveUpArmedAt + S.giveUpBackoffMs).toISOString() : null,
        };
        const tmp = `${file}.tmp.${process.pid}`;
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
        renameSync(tmp, file);
        log(`persisted give-up status to ${file} (event=${event} count=${S.giveUpCount})`);
    } catch (err) {
        log(`WARNING: persistGiveUpStatus failed: ${err && err.message}`);
    }
}

export {
    triggerEnsureEditor,
    beginWarmEditorRespawn,
    resetForRespawn,
    ensureEditor,
    spawnFailedDiagnostic,
    handleSpawnFailure,
    forceColdRestart,
    giveUpAndRearm,
    persistGiveUpStatus,
    ensureReusedWorktreeConfigured,
    evictStaleHolder,
    arbiterDecide,
    waitForPortRelease,
};
