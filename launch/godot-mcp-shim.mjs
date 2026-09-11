#!/usr/bin/env node
// SEE-1244 thin-shim: millisecond MCP registration front for the godot-mcp
// chain (spec: .dev/godot-mcp/docs/see-1244-thin-shim-registration-design.md).
//
// claude spawns THIS process directly from the mcp-config entry. It answers
// initialize / tools/list / ping locally in <100ms (so the registration window
// can never race the launcher→proxy→fork chain), spawns the existing chain
// (bash godot-mcp-launcher.sh <agent>) in the background at T+0, and on the
// first tools/call (T1) or first JSON-RPC frame from the chain (T2) splices the
// four stdio pipes so the shim becomes a pure byte-forwarding thunk until
// session end.
//
// Zero-dependency by contract (§2.1): only node: builtins, no ./see*.mjs
// imports — the shim must sit outside the proxy's module graph so its startup
// cost can never be infected by proxy startup. Repo root is derived from
// import.meta.url ONLY (SEE-1128: claude's cwd is hostile); process.cwd() is
// never consulted.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const START_MS = Date.now();
const SHIM_PREFIX = '[godot-mcp-shim]';

// §2.1: HOME is required — the cache/log dir derives from it (F11 same-class
// constraint as the proxy: a wrong HOME would silently misplace cache files).
if (!process.env.HOME) {
    console.error(`${SHIM_PREFIX} FATAL: HOME is not set; cannot derive ~/.multica cache/log paths. dying.`);
    process.exit(1);
}

// --- repo root + launcher path (§2.1) ----------------------------------------
// Walk up from this file to the directory containing project.godot (the
// checkout root). Failing that, fall back to the fixed three-level walk
// (<repo>/.dev/godot-mcp/launch/) implied by this file's own location.
function findRepoRoot() {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(dir, 'project.godot'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // import.meta.url is <repo>/.dev/godot-mcp/launch/godot-mcp-shim.mjs
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}
const REPO_ROOT = findRepoRoot();
// SEE-1273 T4: the shim now lives INSIDE the submodule (addons/godot_mcp/launch/)
// after the T1 restructure, so its own directory holds the launcher. Prefer the
// sibling launcher (this file's dir), fall back to the legacy .dev/godot-mcp/
// launch layout for checkouts mounted differently during the transition window.
const LAUNCHER_PATH = (() => {
    const sibling = path.join(path.dirname(fileURLToPath(import.meta.url)), 'godot-mcp-launcher.sh');
    if (fs.existsSync(sibling)) return sibling;
    return path.join(REPO_ROOT, '.dev', 'godot-mcp', 'launch', 'godot-mcp-launcher.sh');
})();

// --- agent label (§2.1) -------------------------------------------------------
// Same resolution chain as the launcher: argv → env fallbacks. Used only for
// (a) launcher argv passthrough, (b) cache/log file names, (c) log label.
function resolveAgentName() {
    const argvName = process.argv[2];
    if (argvName && argvName.trim()) return argvName.trim();
    for (const k of ['KOL_AGENT_NAME', 'CLAUDE_AGENT_NAME', 'MULTICA_AGENT_NAME']) {
        const v = (process.env[k] || '').trim();
        if (v) return v;
    }
    return '';
}
const AGENT_NAME = resolveAgentName();
const LABEL = (AGENT_NAME || 'unknown').toLowerCase();

// --- logging (§2.3) ------------------------------------------------------------
const LOG_FILE = path.join(os.homedir(), '.multica', `godot-mcp-shim-${LABEL}.log`);
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch { /* best-effort, mirror launcher || true */ }
function log(event, fields = '') {
    const line = `${new Date().toISOString()} ${SHIM_PREFIX} ${event}${fields ? ' ' + fields : ''}`;
    process.stderr.write(`${line}\n`);
    try { fs.appendFileSync(LOG_FILE, `${line}\n`); } catch { /* || true */ }
}
// §4.1: chain stderr is forwarded WITH its [chain] prefix to OUR stderr AND
// appended to the shim log (Revy defect #4: log-only lines make the shim log
// unable to independently attribute launcher/proxy-side diagnostics).
function logChainLine(l) {
    process.stderr.write(`${SHIM_PREFIX} [chain] ${l}\n`);
    try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${SHIM_PREFIX} [chain] ${l}\n`); } catch { /* || true */ }
}
function die(reason, code = 1) {
    log('SHIM_DIE', `reason=${reason}`);
    process.exit(code);
}

// --- minimal placeholder tool list (§5) ---------------------------------------
// Code constant: no I/O dependency, so tools/list can ALWAYS be answered.
// Names are the real fork tool list (frozen at implementation time — the
// test test_see1244_shim_placeholder.mjs asserts the set matches the live
// fork and fails on drift, mirroring the DESCRIPTION_PATCHES anchor guard).
// godot_ui_inspect (proxy-provided, SEE-1240 WS-3) is included so the
// registered surface matches the post-patch real list.
const PLACEHOLDER_TOOL_NAMES = [
    'godot_animation_edit',
    'godot_animation_read',
    'godot_docs',
    'godot_editor_edit',
    'godot_editor_read',
    'godot_exec',
    'godot_game_time',
    'godot_gridmap_edit',
    'godot_gridmap_read',
    'godot_input',
    'godot_node_edit',
    'godot_node_read',
    'godot_profiler',
    'godot_project',
    'godot_resource',
    'godot_runtime_state',
    'godot_scene',
    'godot_scene3d',
    'godot_tilemap_edit',
    'godot_tilemap_read',
    'godot_ui_inspect',
    'godot_validate_meshes',
];
const PLACEHOLDER_TOOLS = PLACEHOLDER_TOOL_NAMES.map((name) => ({
    name,
    // Self-describing placeholder: an agent that calls a tool before the editor
    // chain is warm gets the proxy's structured warmup hint, and the description
    // already says why (§5.1 point 2).
    description: `[godot-mcp placeholder] Tool ${name} — full schema arrives once the editor chain is warm; call it after the first warmup completes. (SEE-1244 thin-shim)`,
    inputSchema: { type: 'object', properties: {} },
}));

// --- tools/list cache read side (§6.1) -----------------------------------------
// Written by the PROXY (post-patchToolsList real list), read here. Lives under
// ~/.multica keyed by agent label (NOT the worktree — a rebuilt worktree must
// not wipe the cross-session cache value, §6.1).
const CACHE_FILE = path.join(os.homedir(), '.multica', `godot-mcp-tools-cache-${LABEL}.json`);
// §4.5.3 T2 / K5: fork CLI path env-overridable; default relative to this
// library's own location (launch/ → ../server/dist/cli.js), no D-drive literal.
const DEFAULT_FORK_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'dist', 'cli.js');
const FORK_CLI = process.env.GODOT_MCP_FORK_CLI || DEFAULT_FORK_CLI;

function readToolsCache() {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch (err) {
        if (fs.existsSync(CACHE_FILE)) log('SHIM_CACHE_WARN', `reason=corrupt err=${err && err.message}`);
        return null;
    }
    if (!parsed || parsed.schema !== 1 || !Array.isArray(parsed.tools) || parsed.tools.length === 0) {
        log('SHIM_CACHE_WARN', 'reason=bad_shape');
        return null;
    }
    // Stale check (fork mtime drift): still ANSWER with the cache — non-empty
    // beats fresh (§6.1); only the log carries the staleness signal.
    let stale = false;
    try {
        const forkMtime = String(fs.statSync(FORK_CLI).mtimeMs);
        stale = parsed.fork !== forkMtime;
    } catch { /* fork absent: degrade to updated_at-only, no staleness verdict */ }
    if (stale) log('SHIM_CACHE_WARN', 'reason=fork_mtime_stale');
    const ageS = parsed.updated_at ? Math.max(0, Math.floor((Date.now() - Date.parse(parsed.updated_at)) / 1000)) : 'unknown';
    return { tools: parsed.tools, ageS, stale };
}

// --- state ---------------------------------------------------------------------
let initAnswered = false;
let handedOff = false;
let chainSpawned = false;      // a chain exists (alive OR mid-backoff respawn pending)
let chainProc = null;
const heldInbound = [];   // non-locally-answerable requests that arrived pre-handoff (§4.4)
let handoffTriggered = false;
let chainStdoutBufferedLines = [];
let chainStdoutOpen = false;
let chainExeced = false;    // proxy exec proven (LAUNCHER_EXEC stderr or a stdout frame) — writing chain.stdin is then safe
let chainLive = false;      // a spawned chain process is attached (survives nulling chainProc during / after stale events)
let refreshTimer = null;
// 修补 v2 (final decision 01a08100): chain/registration state machine, four
// states with a one-to-one mapping to the real process situation — every value
// must be reachable from at least one test path (state-reachability assertion):
//   'worktree_wait'    — launcher alive, waiting for the checkout to land
//                        (set from the chain's stderr WORKTREE_WAIT stage line)
//   'proxy_warming'    — launcher resolved + exec'd the proxy, first stdout
//                        frame not yet seen (the narrow fork-cold window)
//   'chain_restarting' — chain dead, backoff respawn scheduled
//   'chain_exhausted'  — rechain budget spent OR launcher missing (terminal;
//                        answers carry retryable:false + launcher log pointer)
// 'alive' is folded away: once the first stdout frame is seen the shim hands
// off, so no answer can ever be emitted in a state called 'alive' (the R2
// semantic-distortion counterexample).
let rechainAttempts = 0;
let rechainTimer = null;
let chainState = 'proxy_warming';
let chainMissing = false;      // launcher_missing: chain_exhausted is TERMINAL (mutual exclusion with rechain)
const RECHAIN_BACKOFF_MS = [10000, 20000];
const RECHAIN_MAX = parseInt(process.env.KOL_SHIM_RECHAIN_MAX || '2', 10);
const REFRESH_MS = parseInt(process.env.KOL_SHIM_REFRESH_MS || '30000', 10);
// 测试 seam 生产防御 (decision 01a08100 增量③): the launcher-substitution
// override must never leak into a production shim. It is honored only when
// KOL_SEE1244_ALLOW_TEST_OVERRIDE=1 is ALSO set (tests set both); a stray
// override without the allow flag is ignored loudly.
const TEST_OVERRIDE_ALLOWED = process.env.KOL_SEE1244_ALLOW_TEST_OVERRIDE === '1';

// --- local direct answers (§3) --------------------------------------------------
function answerInitialize(msg) {
    const requested = (msg.params && msg.params.protocolVersion) || '2024-11-05';
    process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
            protocolVersion: requested,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: 'godot-mcp', version: 'kol-proxy-shim-1.0' },
        },
    })}\n`);
    initAnswered = true;
    log('SHIM_ANSWER_INIT', `elapsed_ms=${Date.now() - START_MS} protocol=${requested}`);
    // §3.5 observation-only refresh timer; handoff clears it.
    if (!refreshTimer) {
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            if (!handedOff) log('SHIM_REFRESH_TICK', 'note=handoff_not_yet_occurred_noop');
        }, REFRESH_MS);
        refreshTimer.unref?.();
    }
}

function answerToolsList(msg) {
    const cache = readToolsCache();
    const source = cache ? 'cache' : 'placeholder';
    const tools = cache ? cache.tools : PLACEHOLDER_TOOLS;
    process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { tools },
    })}\n`);
    log('SHIM_ANSWER_TOOLS', `source=${source} tools=${tools.length} cache_age_s=${cache ? cache.ageS : 'n/a'}${cache && cache.stale ? ' stale=true' : ''}`);
}

function answerPing(msg) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`);
}

// --- background chain spawn (§4.1) ----------------------------------------------
function spawnChain() {
    if (chainSpawned) return;
    chainSpawned = true;
    // 测试 seam 生产防御 (decision 01a08100 增量③): the override is a test-only
    // seam — it is honored ONLY with the explicit allow flag (tests set both);
    // a stray override in production is ignored loudly, never silently used.
    const rawOverride = (process.env.KOL_SEE1244_LAUNCHER_OVERRIDE || '').trim();
    const testOverride = (TEST_OVERRIDE_ALLOWED && rawOverride) || '';
    if (rawOverride && !TEST_OVERRIDE_ALLOWED) {
        log('SHIM_OVERRIDE_REJECTED', 'reason=allow_flag_missing — KOL_SEE1244_LAUNCHER_OVERRIDE ignored outside tests');
    }
    if (!testOverride && !fs.existsSync(LAUNCHER_PATH)) {
        // D3: launcher truly missing — chain_exhausted is TERMINAL here and
        // mutually exclusive with rechain (增量②防振荡): no respawn is ever
        // scheduled for a launcher that does not exist on disk.
        log('SHIM_CHAIN_EXIT', 'code=spawn_skipped reason=launcher_missing');
        chainState = 'chain_exhausted';
        chainMissing = true;
        return;
    }
    let cmd, argv;
    if (testOverride) {
        // env-form "VAR=VALUE node script args…" (shell degrade tests) and the
        // plain "node script args…" form (mjs tests) are both accepted.
        const parts = testOverride.split(' ');
        let i = 0;
        while (i < parts.length && parts[i].includes('=')) i++;
        cmd = parts[i];
        argv = parts.slice(i + 1);
    } else {
        cmd = 'bash';
        argv = AGENT_NAME ? [LAUNCHER_PATH, AGENT_NAME] : [LAUNCHER_PATH];
    }
    chainProc = spawn(cmd, argv, {
        detached: false, // chain dies with the shim (§4.1: no orphan proxy chain)
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, KOL_FROM_SHIM: '1' },
    });
    log('SHIM_SPAWN_CHAIN', `cmd="${testOverride || `bash ${LAUNCHER_PATH}${AGENT_NAME ? ' ' + AGENT_NAME : ''}`}" pid=${chainProc.pid}`);
    chainState = 'proxy_warming'; // launcher up, proxy not yet proven (no stdout frame)
    chainLive = true;
    const spawnedPid = chainProc.pid;
    chainProc.on('error', (err) => {
        log('SHIM_CHAIN_EXIT', `code=spawn_error reason=${err && err.message}`);
        if (chainProc && chainProc.pid !== spawnedPid) return; // stale event from a replaced chain
        chainLive = false;
        chainProc = null;
        scheduleRechain('spawn_error');
    });
    chainProc.on('exit', (code) => {
        log('SHIM_CHAIN_EXIT', `code=${code === null ? 'signal' : code}`);
        if (handedOff) {
            // D4: post-handoff chain death == today's proxy-death semantics.
            die('chain_died');
        }
        if (chainProc && chainProc.pid !== spawnedPid) return; // stale event guard (增量①)
        chainLive = false;
        chainProc = null;
        scheduleRechain(`exit_${code === null ? 'signal' : code}`);
    });
    // Chain stderr (launcher/proxy diagnostics) → shim stderr with prefix AND
    // appended to the shim log (§4.1; Revy defect #4). The launcher's
    // stage=WORKTREE_WAIT / RUNTIME_WAIT / WORKTREE_READY / LAUNCHER_EXEC lines
    // drive the shim's state machine (修补 v2 ①: these subscriptions are the
    // ONLY sources of the wait states — without them the states are
    // unreachable and QA's state assertions are void).
    createInterface({ input: chainProc.stderr, terminal: false, crlfDelay: Infinity })
        .on('line', (l) => {
            logChainLine(l);
            if (chainProc && chainProc.pid !== spawnedPid) return; // stale stderr guard (增量①)
            // RUNTIME_WAIT = a live same-runtime holder is in its lease grace
            // window (连续验收轮次自愈缺口修复); the same retryable worktree_wait
            // state covers both wait phases.
            if (l.includes('stage=WORKTREE_WAIT') || l.includes('stage=RUNTIME_WAIT')) chainState = 'worktree_wait';
            else if (l.includes('stage=LAUNCHER_EXEC')) { chainState = 'proxy_warming'; chainExeced = true; }
            else if (l.includes('stage=WORKTREE_READY') || l.includes('stage=RUNTIME_READY')) chainState = 'proxy_warming';
        });
    // Chain stdout is the proxy's out-direction MCP frames. Do NOT forward to
    // claude before handoff (§4.1); buffer until the handoff flush (§4.3).
    // 增量① (cross-chain frame protection): frames are tagged with the pid of
    // the chain that produced them — a late frame from a dead chain is dropped
    // instead of polluting the next chain's buffered stream.
    createInterface({ input: chainProc.stdout, terminal: false, crlfDelay: Infinity })
        .on('line', (l) => {
            if (chainProc && chainProc.pid !== spawnedPid) return; // stale frame guard (增量①)
            if (!chainStdoutOpen) { chainStdoutOpen = true; chainExeced = true; log('SHIM_CHAIN_STDOUT_OPEN'); }
            if (handedOff) {
                process.stdout.write(`${l}\n`);
            } else {
                chainStdoutBufferedLines.push(l);
                // T2: any parseable JSON-RPC frame proves the proxy's stdio pipe
                // is live → trigger handoff (no method-name validation, §4.2).
                if (!handoffTriggered && isParseableJson(l)) triggerHandoff('proxy_ready');
            }
        });
    // Launcher stdin: writable pipe we NEVER write to (the launcher redirects
    // its own stdin from /dev/null; ownership unaffected, §4.1).
    chainProc.stdin.on('error', () => { /* EPIPE when chain dies pre-handoff; exit handler logs it */ });
}

function isParseableJson(line) {
    try { JSON.parse(line); return true; } catch { return false; }
}

// 改动 D (终版, decision 01a08100): schedule the next chain respawn. The
// rechain budget is measured in FULL launcher wait-window ATTEMPTS (default 2,
// KOL_SHIM_RECHAIN_MAX) — each respawned launcher runs its own complete
// KOL_WORKTREE_WAIT_S window. The 150s time ceiling is GONE: total upper bound
// = (1+N)×WAIT_S + backoff intervals, kept self-consistent with the 2-tier
// backoff (10s/20s). chain_exhausted is terminal and mutually exclusive with
// rechain (增量②): once reached, no respawn is ever scheduled again.
function scheduleRechain(reason) {
    if (handedOff) return; // post-handoff death → D4 path already taken by caller
    if (chainMissing) return; // 增量②: terminal — a missing launcher never respawns (no oscillation)
    if (rechainTimer) return; // already scheduled
    rechainAttempts += 1;
    if (rechainAttempts > RECHAIN_MAX) {
        chainState = 'chain_exhausted';
        log('SHIM_RECHAIN', `state=chain_exhausted reason=${reason} attempts=${rechainAttempts - 1} max=${RECHAIN_MAX}`);
        return;
    }
    chainState = 'chain_restarting';
    const delay = RECHAIN_BACKOFF_MS[Math.min(rechainAttempts - 1, RECHAIN_BACKOFF_MS.length - 1)];
    log('SHIM_RECHAIN', `state=chain_restarting reason=${reason} attempt=${rechainAttempts}/${RECHAIN_MAX} delay_ms=${delay}`);
    rechainTimer = setTimeout(() => {
        rechainTimer = null;
        chainSpawned = false;      // allow respawn
        chainLive = false;
        chainStdoutOpen = false;
        chainExeced = false;
        chainStdoutBufferedLines = [];
        spawnChain();
    }, delay);
    rechainTimer.unref?.();
}

// --- handoff (§4.3) ---------------------------------------------------------------
function transientErrorResponse(id, state) {
    // 修补 v2 (final decision 01a08100): structured transient error with the
    // FINAL four-state enum. retryable:false only for chain_exhausted; each
    // retryable state's retry_after_s aligns with its real readiness time
    // (proxy_warming: first frame arrives in ~1s → 1; others: next poll/backoff
    // → 5). data carries NO waited seconds (T3 裁定: shim has no worktree
    // awareness; seconds live in the launcher log for QA oracle).
    const retryAfter = state === 'proxy_warming' ? 1 : 5;
    const retryable = state !== 'chain_exhausted';
    const hint = retryable
        ? `godot-mcp chain is not ready yet (state=${state}); please retry shortly.`
        : `godot-mcp chain failed permanently (state=chain_exhausted after ${rechainAttempts} restart attempts). See ~/.multica/godot-mcp-launcher-${LABEL}.log — a session rerun is the recovery path.`;
    return {
        jsonrpc: '2.0', id,
        error: {
            code: -32000,
            message: hint,
            data: { state, retryable, retry_after_s: retryAfter, rechain_attempt: rechainAttempts },
        },
    };
}

function triggerHandoff(trigger) {
    if (handoffTriggered) return;
    // 修补 v2 CRITICAL (decision 01a08100 目标1): handoff requires PROOF the
    // proxy is exec'd — the launcher's stage=LAUNCHER_EXEC stderr line OR a
    // chain stdout frame. The old `chainProc.stdin.writable` check was the
    // /dev/null flush hole: during the launcher's wait window the pipe IS
    // writable but its stdin is /dev/null — flushing a call there loses it
    // silently. LAUNCHER_EXEC is the real-proxy exec signal (a stdout frame
    // alone can NEVER be it: the proxy emits nothing until it first receives
    // the claude-forwarded initialize, which only happens post-handoff — a
    // frame-only gate would deadlock the whole chain). Between exec and the
    // proxy's stdio readiness sits node module loading; calls flushed in that
    // sub-second window sit in the pipe kernel buffer until the reader is up
    // (stdin is a real pipe now, not /dev/null — nothing is lost). Otherwise:
    // transient answers only, never write chain.stdin, never latch.
    // The gate is two-part: a chain must be attached AND exec proven.
    // chainLive (not chainProc) carries liveness — a stale exit handler may
    // null chainProc while a fresh chain is already attached, and transient
    // answering must survive that overlap.
    if (!chainLive || !(chainExeced || chainStdoutOpen)) {
        for (const line of heldInbound.splice(0)) {
            try {
                const msg = JSON.parse(line);
                if (msg.id !== undefined) {
                    process.stdout.write(`${JSON.stringify(transientErrorResponse(msg.id, chainState))}\n`);
                }
            } catch { /* unparsable held line: drop (already logged at ingest) */ }
        }
        log('SHIM_TRANSIENT_ANSWERED', `state=${chainState} held_flushed=true`);
        // remain in direct-answer mode — rechain/checkout landing may still
        // bring the real proxy up and a later T2 completes handoff.
        return;
    }
    handoffTriggered = true;
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    log('SHIM_HANDOFF_BEGIN', `trigger=${trigger} waited_ms=${Date.now() - START_MS}`);
    // 1) flush held inbound in arrival order, then switch to pure forwarding.
    const toFlush = heldInbound.splice(0);
    handedOff = true;
    for (const line of toFlush) chainProc.stdin.write(`${line}\n`);
    // 2) drain chain stdout frames buffered pre-handoff. Safety note (§4.3.2):
    //    the proxy cannot have answered any request shim did not forward, so
    //    buffered frames can only be proxy-initiated notifications — writing
    //    them BEFORE the held inbound responses is the order-safe sequence.
    const buffered = chainStdoutBufferedLines.splice(0);
    for (const l of buffered) process.stdout.write(`${l}\n`);
    log('SHIM_HANDOFF_DONE', `elapsed_ms=${Date.now() - START_MS} flushed=${toFlush.length} drained=${buffered.length}`);
}

// --- inbound dispatch (§3.2) --------------------------------------------------------
const rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
        msg = JSON.parse(line);
    } catch (err) {
        process.stderr.write(`${SHIM_PREFIX} WARNING: invalid JSON from claude dropped: ${err && err.message}\n`);
        return;
    }
    if (handedOff) {
        // Pure thunk: no parsing decisions anymore (§4.3.1).
        chainProc?.stdin?.write(`${line}\n`);
        return;
    }
    const method = msg.method;
    if (method === 'initialize') {
        answerInitialize(msg); // params discarded (§3.2)
    } else if (method === 'notifications/initialized') {
        // Dropped: the proxy gets its own registration flow; forwarding would
        // produce a duplicate initialized notification (§3.2).
    } else if (method === 'tools/list') {
        answerToolsList(msg);
    } else if (method === 'ping') {
        answerPing(msg);
    } else if (method === 'tools/call') {
        holdAndTriggerHandoff(line); // T1: call flushed inside triggerHandoff
    } else if (method === undefined && msg.id === undefined) {
        // unknown notification: drop (no response channel, nothing to hold)
    } else {
        // prompts/*, resources/*, completion/* …: hold until handoff, then
        // flush in order (§3.2). Hold window is microsecond-scale because
        // tools/call triggers handoff synchronously in the same loop tick.
        holdAndTriggerHandoff(line);
    }
});

// MEDIUM-2 (Atlas Final Review): the tools/call and "other forwardable" paths
// duplicated spawn+hold+trigger — one helper keeps the T1 semantics identical
// (only the FIRST inbound forwardable request triggers the chain warm+handoff).
function holdAndTriggerHandoff(line) {
    spawnChain();
    heldInbound.push(line);
    if (!handoffTriggered) triggerHandoff('first_call');
}
rl.on('close', () => {
    // §3.2 stdin EOF: SIGTERM the un-handed-off chain (reaper/held-lock trap
    // recovers the orphan if the TERM races) and exit 0.
    if (chainProc && !handedOff) {
        try { chainProc.kill('SIGTERM'); } catch { /* already dead */ }
    }
    process.exit(0);
});

process.on('uncaughtException', (err) => die(`uncaught_exception: ${err && err.message}`));
process.on('unhandledRejection', (err) => die(`unhandled_rejection: ${err && (err.message || err)}`));

// LOW2 (Revy 复测 defect #4): a shim killed by an external signal used to die
// silently with no SHIM_DIE — log the signal, then re-raise with the default
// handler so the OS exit semantics (128+signum) are preserved for the parent.
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
    process.on(sig, () => {
        log('SHIM_DIE', `reason=signal:${sig}`);
        process.removeAllListeners(sig);
        process.kill(process.pid, sig);
    });
}

// T+0: warm the chain immediately — the launcher's ~3s前置解析 is independent of
// whether anyone calls a tool, and B1 lazy-load (editor spawn) still lives in
// the proxy (§4.1). SHIM_START is logged BEFORE spawnChain() so the §2.3/AC-6
// event order holds on disk (Revy defect #3: SPAWN_CHAIN's log raced ahead).
log('SHIM_START', `args=${JSON.stringify(process.argv.slice(2))} pid=${process.pid} repo_root=${REPO_ROOT}`);
spawnChain();
