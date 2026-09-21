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

import { spawn, execFile, execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { readFile, readdir, stat, writeFile, rename, unlink, appendFile, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync, existsSync } from 'node:fs';
import * as readline from 'node:readline';
import { EOL } from 'node:os';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolveGodotMcpCommand } from './godot-mcp-resolve.mjs';
// SEE-1240 WS-3: screenshot capture contract (frame-age metadata + opt-in
// auto-step + exports dir + width×height check) and UI observation tool family
// (drag sugar + ui_inspect + description patches). Proxy-side by ruling — the
// vendored addon is a red line and the fork needs no change for these.
import {
    enrichScreenshotResponse,
    spliceEnrichment,
} from './see1240-screenshot-contract.mjs';
import {
    expandDragInToolsCall,
    UI_INSPECT_TOOL,
    UI_INSPECT_SNIPPETS,
    UNRELIABLE_FIELDS,
    validateUiInspectArgs,
    normalizeNodePath,
    DESCRIPTION_PATCHES,
} from './see1240-ui-tools.mjs';
import {
    precheckExecSource,
    execConstraintDigest,
} from './see1240-exec-constraints.mjs';
import { decideReuse } from './see1129-reuse-predicate.mjs';
import { decideSidecarGuard } from './see1129-sidecar-guard-predicate.mjs';
// SEE-1325 H1（§SPEC-002/003/005/007）：恢复轮纯决策函数 + 预算记账口径 (a)。
import { decideRecoveryAction, planRecoveryBudget, attributeHolder, RECOVERY_ROUND_WORST_MS } from './see1325-recovery.mjs';
import {
    STAGE_ENUM,
    STAGE_TOTAL,
    stageOrdinal,
    scanStageLines,
    handshakeSubstate as modHandshakeSubstate,
    handshakePendingMs as modHandshakePendingMs,
} from './warmup-stage-parser.mjs';

// F11 (Atlas P1 FAIL 修订决策): no '/root' fallback. HOME unset is an
// environment anomaly — writing the registry to an unexpected path (e.g.
// /.multica as root) would make the whole toolchain read back nothing. Die
// loudly at startup before any other validation runs.
if (!process.env.HOME) {
    console.error('[godot-mcp-proxy] FATAL: HOME is unset; refusing to derive a registry path.');
    process.exit(1);
}

// SEE-1152 目标3: when GODOT_HOST is unset, auto-detect the WSL default
// gateway instead of falling back to 127.0.0.1 — the addon binds ONLY the
// Windows host's WSL-facing interface, so a WSL-local 127.0.0.1 never reaches
// it on a direct-spawn path that bypasses the launcher (which normally exports
// GODOT_HOST). Mirrors the launcher's resolve_mcp_host() (ip route show
// default -> via <gw>); the loopback fallback stays 127.0.0.1 to match the
// launcher. Sourced from tests/e2e/godot-mcp/see1152_cold_start_replay.mjs.
function detectWindowsHost() {
    try {
        const out = execFileSync('ip', ['route', 'show', 'default'], { encoding: 'utf8' });
        const m = out.match(/via\s+(\S+)/);
        if (m) return m[1];
    } catch { /* not WSL2 or ip unavailable */ }
    return '127.0.0.1';
}

const GODOT_HOST = process.env.GODOT_HOST || process.env.GODOT_HOSTNAME || detectWindowsHost();
const GODOT_PORT = parseInt(process.env.GODOT_PORT || '0', 10);
const EDITOR_LOG_FILE = process.env.GODOT_EDITOR_LOG_FILE || '';
const PROBE_INTERVAL_MS = parseInt(process.env.GODOT_MCP_PROBE_INTERVAL_MS || process.env.KOL_PROBE_INTERVAL_MS || '1000', 10);
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.GODOT_MCP_HEARTBEAT_INTERVAL_MS || process.env.KOL_HEARTBEAT_INTERVAL_MS || '2000', 10);
const PROGRESS_INTERVAL_MS = parseInt(process.env.GODOT_MCP_PROGRESS_INTERVAL_MS || process.env.KOL_PROGRESS_INTERVAL_MS || '5000', 10);
// SEE-1043: independent cold/hot budgets. Cold start (editor still booting) gets
// a long warmup window (default 180s per SEE-1110 §5: measured cold ~40s, 180s is
// 4x+ margin for D3D12 shader first-compile + WSL overhead, and stays well under
// the 300s lease grace so warmup never races the lease). Hot start (editor was
// already warm) gets a short window (default 30s) because the WS port should
// accept almost immediately. KOL_HOT_WARMUP_TIMEOUT_MS explicitly overrides the
// hot window (e.g. 0 in tests). Conservative rollback: KOL_WARMUP_TIMEOUT_MS=180000.
// SEE-1152: 180000 -> 300000. Post-SEE-1148 cold start measured at ~300s
// (configure reaper ~76s x2 + editor boot ~34s + idle gate ~114s), so the old
// 180s budget was exhausted before the editor ever bound its WS port. 300s
// covers the remaining pre-spawn path once the reaper is async (A) and the
// idle gate is capped at 30s (B), with ~50s of headroom for slower machines.
// Derived: FAILED_EXIT_MS defaults to 2 * COLD_WARMUP_TIMEOUT_MS -> 600s.
const COLD_WARMUP_TIMEOUT_MS = parseInt(process.env.GODOT_MCP_WARMUP_TIMEOUT_MS || process.env.KOL_WARMUP_TIMEOUT_MS || '300000', 10);
// SEE-1111 (cold-start one-shot): default the godot-mcp server's QUICK_TIMEOUT
// to 90s so a tools/call forwarded at WARM survives the fork's WS connect +
// initialize chain instead of erroring 'Not connected' at the upstream 30s
// default. The platform spawns this proxy directly (not via the launcher, which
// sets the same default), so the proxy must set it too. DEFAULT-ONLY: an
// explicit external value wins. Inherited by the spawned godot-mcp child.
process.env.GODOT_MCP_QUICK_TIMEOUT_MS = process.env.GODOT_MCP_QUICK_TIMEOUT_MS || '90000';
const HOT_WARMUP_TIMEOUT_MS = parseInt(
    process.env.GODOT_MCP_HOT_WARMUP_TIMEOUT_MS || process.env.KOL_HOT_WARMUP_TIMEOUT_MS || '30000',
    10
);
// SEE-1110 §9 R7: quick-disable switch for the whole progress protocol
// (stage tracking + extended warmupDiagnostic + progress notifications + success
// timeline). When 'off', the proxy behaves exactly as before this protocol: the
// extra fields are not appended and no progress notification is emitted.
const KOL_PROGRESS_PROTOCOL = process.env.GODOT_MCP_PROGRESS_PROTOCOL || process.env.KOL_PROGRESS_PROTOCOL || 'on';
// How long an already-warm proxy keeps respawning a dying npx before giving up
// and exiting (so Claude can restart us against a genuinely dead editor).
const HOT_NPX_RESTART_DEADLINE_MS = parseInt(process.env.GODOT_MCP_NPX_HOT_RESTART_MS || process.env.KOL_NPX_HOT_RESTART_MS || '30000', 10);
// Backoff between npx respawns while the editor is still warming.
const NPX_RESTART_BACKOFF_MS = parseInt(process.env.GODOT_MCP_NPX_RESTART_BACKOFF_MS || process.env.KOL_NPX_RESTART_BACKOFF_MS || '1500', 10);
const RENDER_STABLE_REQUIRED_MS = 4000; // same default as launcher
const RENDER_SAMPLE_MS = 2000;
const RENDER_STABLE_TIMEOUT_MS = 20000;
// SEE-1070 #2: FAILED_EXIT caps how long the proxy keeps probing after the
// warmup timeout (RECOVERING state) before giving up and exiting, so Claude can
// restart against a genuinely dead editor. Defaults to 2x the cold warmup window.
const FAILED_EXIT_MS = parseInt(process.env.GODOT_MCP_FAILED_EXIT_MS || process.env.KOL_FAILED_EXIT_MS || String(2 * COLD_WARMUP_TIMEOUT_MS), 10);
// SEE-1325 H1（§SPEC-002/003）：RECOVERING 内嵌恢复轮。复用 runScript/
// evictStaleHolder/ensureEditor 已有编排；判定全部走 see1325-recovery.mjs
// 纯函数。触发于冷（warmup timeout）与暖（editor_gone respawn）两分支入口；
// 预算口径 (a)：恢复轮在 FAILED_EXIT_MS 窗口内消耗，剩余不足单轮最坏耗时
// （RECOVERY_ROUND_WORST_MS）即记账前置终态，不再开轮。失败计入
// SPAWN_MAX_ATTEMPTS 连击通道（handleSpawnFailure 已统一计数）。
let recoveryRound = 0;
let recoveryWindowStart = null;

async function runRecoveryRound(trigger) {
    // 共用门：与 warmRespawnInFlight/spawnTriggered 互斥，防止恢复轮与
    // respawn 循环并发对同一端口做双 stop/double-spawn。
    if (warmRespawnInFlight) return false;
    warmRespawnInFlight = true;
    try {
        if (recoveryWindowStart === null) recoveryWindowStart = startedAt;
        const budget = planRecoveryBudget({ failedExitMs: FAILED_EXIT_MS, startedAt: recoveryWindowStart, now: Date.now() });
        if (!budget.canStartRound) {
            stageLog('RECOVERY_ROUND_SKIP', `reason=budget_exhausted remaining=${budget.remainingMs}ms round=${recoveryRound}`);
            log(`recovery: budget exhausted (remaining ${budget.remainingMs}ms < worst round ${RECOVERY_ROUND_WORST_MS}ms); giving up (记账前置终态).`);
            return false;
        }
        recoveryRound += 1;
        stageLog('RECOVERY_ROUND', `n=${recoveryRound}/${budget.maxRounds} remaining=${budget.remainingMs}ms trigger=${trigger}`);
        log(`recovery round ${recoveryRound}/${budget.maxRounds} (trigger=${trigger}, remaining=${budget.remainingMs}ms).`);
        // 归因先于二分（§SPEC-007）：文件 cross-check 主通道；PS 兜底 ≤2s。
        const lease = await readLeaseSidecar();
        const holderWorktree = await readHolderWorktree();
        const ourWorktree = await resolveWorktreeForSpawn();
        const holderPidAlive = lease?.proxy_pid ? pidAlive(Number(lease.proxy_pid)) : false;
        const psMatch = holderPidAlive ? await probeHolderCmdline(Number(lease.proxy_pid), ourWorktree) : null;
        const attr = attributeHolder({
            leaseRuntimeId: String(lease?.runtime_id || ''),
            // eslint-disable-next-line no-undef -- SEE-1334 baseline: KOL_RUNTIME_ID is not in scope here (suspected rename miss for RUNTIME_ID at L4509); flagged for drift triage
            ourRuntimeId: String(KOL_RUNTIME_ID || ''),
            registryWorktree: holderWorktree || '',
            holderWorktree: String(lease?.worktree || ''),
            ourWorktree,
            psCmdlineMatch: psMatch,
        });
        const portOpen = await tcpProbe();
        const decision = decideRecoveryAction({
            portOpen,
            holderProxyAlive: holderPidAlive,
            holderRuntimeId: attr.holderRuntimeId,
            // eslint-disable-next-line no-undef -- SEE-1334 baseline: KOL_RUNTIME_ID is not in scope here (suspected rename miss for RUNTIME_ID at L4509); flagged for drift triage
            ourRuntimeId: String(KOL_RUNTIME_ID || ''),
            leaseState: String(lease?.state || ''),
            releasedAt: lease?.released_at || null,
            holderIdentityReadable: attr.holderIdentityReadable,
        });
        stageLog('RECOVERY_DECISION', `action=${decision.action} reason=${decision.reason} channel=${attr.channel}`);
        if (decision.action === 'fail_fast') {
            log(`ERROR: recovery refused: ${decision.diagnostic}`);
            return false;
        }
        if (decision.action === 'takeover_wait') {
            // 活同 runtime proxy：沿用既有 takeover 等待语义，不做任何 stop。
            log('recovery: live same-runtime proxy holds the slot; deferring to takeover wait (no stop).');
            return false;
        }
        if (decision.action === 'stop_first') {
            stageLog('EMBEDDED_HEAL_BEGIN', `mode=stop_first port=${GODOT_PORT}`);
            await evictStaleHolder(holderWorktree);
            const stillOpen = await tcpProbe();
            stageLog('EMBEDDED_HEAL_CONFIRMED', `port_still_open=${stillOpen}`);
            if (stillOpen) {
                log('ERROR: recovery stop-first could not free the port after evict; refusing to double-spawn.');
                return false;
            }
            stageLog('EMBEDDED_HEAL_END', 'mode=stop_first ok=true');
        }
        // respawn（冷分支或 stop-first 清场后）：同端口重钉（GODOT_PORT 不变），
        // 走既有 ensureEditor 全链（prepare→configure→spawn 由其内部编排）。
        try {
            await ensureEditor(Date.now());
            return true;
        } catch (err) {
            // 自愈 spawn 失败同步计入 SPAWN_MAX_ATTEMPTS 连击通道。
            handleSpawnFailure(err);
            return false;
        }
    } finally {
        warmRespawnInFlight = false;
    }
}

// PS PID→cmdline 兜底（§SPEC-007，≤2s 超时由 runScript 竞速保证）：
// 只读探测，命中 = 该 PID 的命令行包含本 worktree 目录名。
const POWERSHELL_BIN = ['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe']
    .find((p) => { try { return existsSync(p); } catch { return false; } }) || null;

async function probeHolderCmdline(pid, ourWorktree) {
    if (!POWERSHELL_BIN) return null;
    const dirName = (ourWorktree || '').split('/').filter(Boolean).pop();
    if (!dirName) return null;
    const result = await Promise.race([
        new Promise((resolve) => {
            execFile(POWERSHELL_BIN, ['-NoProfile', '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], {
                env: { ...process.env }, timeout: 2000,
            }, (err, stdout) => resolve(err ? null : (typeof stdout === 'string' && stdout.includes(dirName))));
        }),
        new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    return result;
}

// Linux 侧 PID 存活判定（/proc 存在性即活进程；zombie 属罕见残余，恢复轮
// 保守视为活——错判活比误杀安全，§SPEC-006 健康度先行原则的 pid 侧体现）。
function pidAlive(pid) {
    try { return existsSync(`/proc/${pid}`); } catch { return false; }
}

// Lease sidecar 读取（恢复轮归因输入）。
async function readLeaseSidecar() {
    try {
        const pg = process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT
            || path.join(await resolveWorktreeForSpawn(), 'project.godot');
        const sidecar = pg.replace(/project\.godot$/, '.godot/mcp-lease.json');
        return JSON.parse(await readFile(sidecar, 'utf8'));
    } catch { return null; }
}

// already bound but the CLI never landed. After this many seconds the proxy
// kills the npx child so the existing npx.on('exit') respawn machinery brings
// up a fresh CLI (bounded by HOT_NPX_RESTART_DEADLINE_MS, hot-attempt budget).
// Without this, a CLI crashing during recovery spins forever: warmFlushed needs
// npxCliConnected=true which only the (now-dead) CLI could set.
const WARM_RECOVERING_CLI_TIMEOUT_MS = parseInt(process.env.GODOT_MCP_WARM_RECOVERING_CLI_TIMEOUT_MS || process.env.KOL_WARM_RECOVERING_CLI_TIMEOUT_MS || '15000', 10);
// SEE-1077: poll cadence for the independent lease monitor. Short enough that
// fast-fail latency stays in seconds; long enough not to spam stat() on the
// editor log on every iteration. Lease lines only appear on editor self-exit,
// so a tight poll is cheap.
const LEASE_POLL_INTERVAL_MS = parseInt(process.env.GODOT_MCP_LEASE_POLL_MS || process.env.KOL_LEASE_POLL_MS || '500', 10);
// The exact lease death line emitted by addons/godot_mcp/plugin.gd right
// before get_tree().quit() (plugin.gd:413). ONLY this line triggers fast-fail:
// "scheduled" (grace window start) and "cancelled" (client reconnected) must
// never trigger — otherwise an npx blip + immediate reconnect would falsely
// fast-fail a healthy editor.
const LEASE_EXITING_LINE = 'Lease: no MCP client for the grace window; exiting editor to release the port.';
// SEE-1134 Q1: how long the proxy holds the editor-restart call's response
// while the addon self-relaunches (port cold -> new editor warm -> CLI
// reconnected). 120s aligns with the lease grace window; the client's own
// timeout is a separate bound. KOL_RESTART_HOLD_TIMEOUT_MS overrides.
const RESTART_HOLD_TIMEOUT_MS = parseInt(process.env.GODOT_MCP_RESTART_HOLD_TIMEOUT_MS || process.env.KOL_RESTART_HOLD_TIMEOUT_MS || '120000', 10);

function log(msg) {
    process.stderr.write(`[godot-mcp-proxy] ${msg}${EOL}`);
}

// SEE-1152 (Owner): end-to-end cold-start stage timing. Every emit carries
//   [stage=<NAME>]           machine-greppable stage token
//   [t=+Nms]                 milliseconds since proxy start (startedAt)
//   [ts=<iso8601>]           absolute wall-clock (UTC)
// Default ON (KOL_STAGE_LOG=off to silence). The stage names mirror the
// SEE-1110 warmup enum plus finer-grained spawn-path events the protocol
// cannot see (arbiterDecide, helper scripts, render-stable gate, npx CLI).
// Emitted to stderr only — never to stdout, so the JSON-RPC channel stays
// clean. Tests can grep stderr for `stage=` lines without parsing stdout.
const STAGE_LOG_ENABLED = (process.env.GODOT_MCP_STAGE_LOG || process.env.KOL_STAGE_LOG || 'on') !== 'off';
function stageLog(stage, msg = '') {
    if (!STAGE_LOG_ENABLED) return;
    const now = Date.now();
    const rel = now - startedAt;
    const iso = new Date(now).toISOString();
    const suffix = msg ? ` ${msg}` : '';
    process.stderr.write(`[godot-mcp-proxy] [stage=${stage}] [t=+${rel}ms] [ts=${iso}]${suffix}${EOL}`);
}

function isValidPort(p) {
    return Number.isInteger(p) && p >= 6000 && p <= 65535;
}

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

const startedAt = Date.now();
let warm = false;
let warmupTimedOut = false; // terminal FAILED_EXIT only (set at T4, just before exit)
// SEE-1070 #2: RECOVERING state — warmup window exhausted but the editor may
// still come back. Buffered calls are held (not rejected); new tools/call are
// rejected immediately with a "recovering" diagnostic. Cleared on WARM (T3) or
// FAILED_EXIT (T4). Kept distinct from warmupTimedOut so the cold npx-respawn
// path and render-stable monitor keep running while we wait for recovery.
let recovering = false;
let recoveringEnteredAt = 0;
// SEE-1134 RECOVERING deadlock: timestamp of when the CLI was last seen
// UNconnected while we were already warm+recovering. Used to bound the
// CLI-kill-and-respawn attempt. Set on every iteration where recovering is
// true and npxCliConnected is still false; cleared the moment npxCliConnected
// flips true (the warmup branch reads it before deciding to kill).
let recoveringCliUnconnectedSince = 0;
const pendingCalls = [];
let lastProgressAt = 0;
let renderStable = false;
let npx = null;
let npxRunning = false;
let shutdownRequested = false;
// Editor warmup deadline, chosen cold vs hot at first use (see currentWarmupTimeout).
let warmupTimeoutMs = null;
// Independent respawn counters: cold-boot churn is unbounded (until the warmup
// timeout) and must not consume the small hot-restart budget.
let coldNpxRestarts = 0;
let hotNpxRestarts = 0;
let warmAt = 0;
// npx may exit early (e.g. spawn failure); while still waiting for warmup we
// respawn it rather than take the proxy down, so a cold-start transient cannot
// strand the MCP handshake.
// Buffered writes that arrive before the npx child has opened its stdin pipe.
// Prevents the MCP client from seeing an initialize timeout when the launcher
// path spawns npx a beat slower than the client sends the handshake.
let npxStdinReady = false;
const npxWriteBuffer = [];
// Warmup-phase handshake messages (initialize / tools/list / prompts|resources)
// we have forwarded to npx but not yet seen a result for. After an npx respawn we
// replay them so the client still gets its handshake response instead of a stall.
const pendingHandshake = new Map();
// SEE-1070 #7: ids of tools/call requests that target a screenshot, so the
// npx stdout forwarder can append a fallback-script hint to their error
// responses. This is the proxy's ONLY side-effect exception (Archi ca665f75):
// it does not open a general hook for business logic.
const screenshotCallIds = new Set();
// SEE-1240 WS-3: capture-contract state per in-flight screenshot call —
// { forwardedAtMs, autoStepRequested } — so the successful response can be
// stamped with freshness metadata and its PNG exported to disk. The C3/C4
// enrichment appends data (advisory/meta text, exports info) and never
// removes the original image payload; error responses keep the existing
// fallback-hint path untouched.
const screenshotContract = new Map();
// SEE-1240 WS-3: ids of held godot_ui_inspect calls (answered once warm —
// the flushQueue re-dispatch path recognizes them by call shape, so this set
// only marks that a queued ui_inspect exists; diagnostics future-proofing).
const uiInspectCallIds = new Set();
// SEE-1070 #8: ids of tools/call requests that target godot_exec. exec errors
// (compile/runtime) come back inside the success-result text as a
// {completed,result,runtime_errors} envelope, and non-primitive returns are
// str()-truncated to ~200 chars. The forwarder appends a targeted hint when it
// spots a known GDScript pitfall or a truncated container return. Same
// side-effect-exception family as screenshots: original payload is always
// preserved (hints are appended, nothing swallowed).
const execCallIds = new Set();
// SEE-1085 usability: ids of every tools/call, so the npx stdout forwarder can
// recognize a tools/call error caused by a concurrent client holding the
// addon's single WS slot (close 4001 / "another client is already connected")
// and wrap it with a retryable editor_busy diagnostic. Without this the agent
// sees a bare failure indistinguishable from a dead editor and gives up.
const toolsCallIds = new Set();
// SEE-1085 §1 (Revy §4.3): the original inbound JSON line for every tools/call
// id, so an editor_busy takeover can re-dispatch the exact request when probing
// whether the single-client WS slot has freed up. Cleared when the id is finally
// answered (success, non-busy error, or takeover timeout).
const toolsCallLines = new Map();

// ---- B1 lazy-load (SEE-1085): editor spawn ownership moved into the proxy ----
// Previously the launcher ran configure-mcp-port.sh + start-godot-editor.sh
// before exec'ing the proxy, requiring the worktree to exist at launch time.
// That made the multica daemon's timing bug (worktree created 5-6s after claude
// starts; SEE-1082) silently drop mcp__godot-mcp-<agent>__* tools. B1 moves
// the spawn here, lazily on the first tools/call, so the MCP handshake always
// succeeds even when the worktree does not yet exist. The editor is spawned
// only when an agent actually wants to use it.
let spawnTriggered = false;      // first tools/call has triggered ensureEditor
let spawnInFlight = null;        // in-flight ensureEditor() promise (concurrent dedup)
let spawnAttempts = 0;           // spawn attempts this process (backoff + diagnostics)
let spawnFailedBucket = null;    // last failure bucket (terminal streak detection)
let spawnFailedStreak = 0;       // consecutive failures of the same bucket
let spawnStartedAt = 0;          // warmup timeout basis (replaces startedAt for T2/T4)
let spawnTerminal = false;       // SPAWN_FAILED_TERMINAL: reject all tools/call
// SEE-1240 WS-5 (C9 give-up in-band recovery): give-up is no longer a dead end.
// When the spawn-streak terminal fires, the proxy records the give-up (count +
// reason + exponential-backoff cooldown), persists them to the status file the
// WS-4 data foundation reads, and RE-ARMS the warmup state machine. Calls that
// arrive during the cooldown get the original give-up error (fail-fast 首报:
// the first terminal failure's SpawnError stays in spawnLastError until a
// fresh spawn attempt clears it); a call arriving after the cooldown expires
// re-enters warmup (spawn re-triggered, call held by the FIFO as usual — never
// silently dropped). KOL_GIVEUP_REARM=0 restores the legacy permanent-terminal
// behavior (operator escape hatch / test seam).
let giveUpCount = 0;             // times the terminal streak fired this process
let giveUpArmedAt = 0;           // ms epoch of the last give-up (0 = not cooling)
let giveUpBackoffMs = 0;         // current exponential-backoff cooldown length
let giveUpLastReason = '';       // bucket + message of the last give-up
const GIVEUP_REARM_ENABLED = !['off', '0', 'false'].includes((process.env.GODOT_MCP_GIVEUP_REARM || process.env.KOL_GIVEUP_REARM || 'on').toLowerCase());
const GIVEUP_BASE_COOLDOWN_MS = parseInt(process.env.GODOT_MCP_GIVEUP_COOLDOWN_MS || process.env.KOL_GIVEUP_COOLDOWN_MS || '30000', 10);
const GIVEUP_MAX_COOLDOWN_MS = parseInt(process.env.GODOT_MCP_GIVEUP_MAX_COOLDOWN_MS || process.env.KOL_GIVEUP_MAX_COOLDOWN_MS || '480000', 10);
// SEE-1240 WS-7 (目标2): grace-race guard. The vendored addon arms its 300s
// initial lease grace at plugin init, BEFORE the port is bound; a first boot
// with a cold import cache can burn most of that grace before any client can
// connect. When the measured bind delay exceeds KOL_GRACE_RACE_BIND_S the
// proxy evicts the slow-bind editor and respawns against the now-warm import
// cache (one-shot per spawn round). KOL_GRACE_RACE_GUARD=0 disables (seam).
const GRACE_RACE_GUARD_ENABLED = !['off', '0', 'false'].includes((process.env.GODOT_MCP_GRACE_RACE_GUARD || process.env.KOL_GRACE_RACE_GUARD || 'on').toLowerCase());
const GRACE_RACE_BIND_MS = parseInt(process.env.GODOT_MCP_GRACE_RACE_BIND_S || process.env.KOL_GRACE_RACE_BIND_S || '150', 10) * 1000;
let graceRaceGuardFired = false;   // one-shot per spawn round
let graceRaceRespawn = false;      // set when the WARM gate bails for a grace-race respawn
let firstProbeOkAt = 0;            // WS-7: first successful probe this round (bind-time fallback when the editor log is unreadable)
// SEE-1111 预热提示 误报防护: the last spawn attempt FAILED (non-terminal). With
// no buffered call to reject, the failure would otherwise be invisible to the
// agent (every call would get a friendly "warming" hint forever). Latched on a
// failed ensureEditor, cleared on a successful spawn, and consumed by the first
// tools/call that arrives after the failure so the REAL spawn_failed diagnostic
// surfaces exactly once. Terminal failures use spawnTerminal (above) instead.
let spawnLastFailed = false;
let spawnLastError = null;      // the SpawnError that set spawnLastFailed (stderr for diagnostics)
let lastSpawnReused = false;     // last ensureEditor reused an existing port (orphan hint)
let firstCallProgressToken = null; // _meta.progressToken of the first tools/call

// ---- SEE-1110 warmup progress protocol (SSOT: .dev/godot-mcp/docs/warmup-progress-protocol.md) ----
// StageEnum: 8 ordinals, monotonic, never regresses. `stage` = highest reached
// ordinal (regressions such as lease self-exit are expressed via `state`, not
// stage). WARM(7) is set from the existing warm flag in warmupLoop, so a warm
// proxy already has the final stage without needing the editor log.
// The patterns + scanner live in warmup-stage-parser.mjs (pure module, unit
// tested in isolation); the proxy keeps a single mutable state object and
// treats it as read-only everywhere else.
let stage = 'LAUNCHER_EXEC';            // current highest stage name (read through the proxy's
                                        // own mutable vars so all existing sites stay unchanged)
const stageTimestamps = {};             // stage name -> ms epoch, null = unreached
for (const s of STAGE_ENUM) stageTimestamps[s] = null;
stageTimestamps.LAUNCHER_EXEC = startedAt; // t0 = proxy start (per §2.1)
let tcpReceivedCount = 0;               // second TCP_RECEIVED => slot-competition fingerprint
let logTailAvailable = false;           // editor log stat currently succeeding (§6)
let logTailUnavailableSince = 0;        // when the log first became unreadable (sticky flag)
let leaseExitDetected = false;          // §4.4 discriminator: lease self-exit hit
let warmupJustCompleted = false;        // §7 one-shot gate: first warmup-triggered call only
let coldMode = false;                   // cold=true / hot=false (set in warmupLoop)
let warmEditorDead = false;             // SEE-1111 缺陷 #7: post-warm editor death detected (editor_gone)
let warmRespawnInFlight = false;        // one respawn loop at a time (dedup concurrent editor_gone)
// SEE-1134 Q1: an in-flight editor restart whose response the proxy is holding.
//   { id, phase: 'ack-pending'|'waiting', timer }
// phase 'ack-pending' = restart call forwarded to npx, awaiting the addon ack;
// phase 'waiting'      = ack received, the relaunched editor is booting and we
//                        are holding both the response and any new tools/call.
// null when no restart is in flight. The fork CLI turns the addon's restart ack
// into a fire-and-forget TEXT result, so detection is by INBOUND call shape
// (godot_editor_edit action=restart), not by the ack payload.
let restartHold = null;
// SEE-1111 缺陷 #9: the FIRST tools/call of a proxy run, when the editor is cold,
// can land BEFORE npx's transport is ready. npx forwards every inbound line to
// the editor over WS; if its WS is not connected yet, the godot-mcp CLI's
// connect chain (~30s QUICK_TIMEOUT) starts ticking at first forward, and the
// request times out ~23s later while the editor is still cold-booting (~22s to
// Server listening + WS handshake). The proxy's warmup window holds the call at
// the pendingCalls queue, so a call that arrives BEFORE npx is ready must NOT be
// forwarded yet. This latch opens the moment npx's transport is ready; until
// then a tools/call is queued (it will be flushed when warm) instead of being
// handed to an npx whose WS connect timer is already running.
let npxTransportReady = false;
// SEE-1111 (cold-start one-shot): set when the godot-mcp CLI's stderr reports
// 'Connected to Godot' (its WS to the addon is open). The WARM flush gate waits
// for this so the held first tools/call is forwarded only once the CLI's
// sendCommand has a live connection. Reset on CLI respawn / disconnect.
let npxCliConnected = false;
// SEE-1111 缺陷 #9 (hard-hold fallback): if npx NEVER reports transport ready by
// the time the editor warms (its spawn/respawn is stalled or crashed) the first
// tools/call must not hang behind an unknown npx. At the WARM transition the
// held call is answered with a retryable diagnostic instead of being flushed
// into a broken transport. npxReadyDropped suppresses the one-shot log.
let npxReadyDropped = false;
const SPAWN_MAX_ATTEMPTS = 3;
const SPAWN_RETRY_BACKOFF_MS = 10000; // avoids agent hot-loop on persistent failure
const DIAGNOSTIC_STDERR_TAIL = 500;   // chars of child stderr kept for diagnostics

class SpawnError extends Error {
    constructor(bucket, message, extra = {}) {
        super(message);
        this.name = 'SpawnError';
        this.bucket = bucket;
        Object.assign(this, extra);
    }
}

// Resolve the launch helper scripts. Canonical GODOT_MCP_*_SH overrides the
// resolved path; the legacy KOL_*_SH alias is honored one round (SEE-1292
// §DECPL-002 backcompat — pre-②c test harnesses inject only the legacy name,
// and the proxy does not source env.sh, so the alias fallback lives here).
// Resolved lazily so a missing helper at proxy start does not crash; the
// spawn attempt itself reports worktree_unresolved / spawn_failed_exception.
function scriptDir() {
    return path.dirname(fileURLToPath(import.meta.url));
}
function resolveHelper(name, envVar) {
    const legacy = envVar.startsWith('GODOT_MCP_') ? `KOL_${envVar.slice('GODOT_MCP_'.length)}` : '';
    for (const v of [envVar, legacy]) {
        if (v && process.env[v] && process.env[v].length) return process.env[v];
    }
    return path.join(scriptDir(), name);
}

function sendToClaude(obj) {
    const line = JSON.stringify(obj) + EOL;
    process.stdout.write(line);
}

function flushNpxWriteBuffer() {
    if (!npx || !npx.stdin || npx.stdin.destroyed || !npxStdinReady) return;
    while (npxWriteBuffer.length > 0) {
        const line = npxWriteBuffer.shift();
        npx.stdin.write(line);
        log(`DEBUG: flushed buffered npx write (${line.length} bytes)`);
    }
}

function makeErrorResponse(id, message, code = -32000, data = undefined) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    return {
        jsonrpc: '2.0',
        id,
        error,
    };
}

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
        { stage, timestamps: stageTimestamps, tcpReceivedCount },
        Date.now()
    );
}

// SEE-1110 §3.2: accumulates only while stage >= TCP_CONNECTED(4) and WS_HANDSHAKE
// is still null; otherwise 0.
function handshakePendingMs() {
    return modHandshakePendingMs(
        { stage, timestamps: stageTimestamps, tcpReceivedCount },
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
    if (leaseExitDetected) {
        // §4.4 scenario D.
        return 'editor 因 lease grace 超时自退出（无 MCP client 的 grace window）以释放端口；请重试，proxy 会被 Claude 重启拉起新 editor。';
    }
    if (state === 'warming' || state === 'recovering') {
        if (hkSub === 'stalled' || hkSub === 'pending') {
            // §4.2 scenario B — TCP reachable but the WS handshake never finished.
            const pendingS = Math.floor(handshakePendingMs() / 1000);
            const tcpTs = stageTimestamps.TCP_CONNECTED;
            if (tcpTs !== null) {
                return `TCP 已连到 addon（${GODOT_HOST}:${GODOT_PORT}）但 WebSocket 握手 ${pendingS}s 未完成；疑似 addon 单客户端槽位被占（4001）或握手被吞。建议：等 editor lease 自退出释放槽位后重试，或确认无并发同端口 session（agent-ports.json）。`;
            }
        }
        if (state === 'recovering') {
            return `editor 冷启动中，已到 ${stage}（已等 ${Math.floor((now - (spawnStartedAt || startedAt)) / 1000)}s）；已超过 warmup 窗口进入 RECOVERING，仍在探测 editor 恢复（FAILED_EXIT 前最多 ${Math.floor(FAILED_EXIT_MS / 1000)}s）。`;
        }
        // §4.1 scenario A — still within the warmup window.
        return `editor 冷启动中，已到 ${stage}（已等 ${Math.floor((now - (spawnStartedAt || startedAt)) / 1000)}s）；仍在 warmup 窗口内（${Math.floor(currentWarmupTimeout() / 1000)}s），请稍候。`;
    }
    if (state === 'failed_exit' || state === 'editor_gone') {
        // §4.3 scenario C — addon genuinely unresponsive.
        return `editor/addon 无响应：最后到达 ${stage}，TCP 探测持续失败 ${Math.floor(FAILED_EXIT_MS / 1000)}s。建议：重启 MCP server 让 proxy 重新拉起 editor。`;
    }
    if (state === 'recovered') {
        return `editor 恢复：最后到达 ${stage}，端口 ${GODOT_PORT} 重新可连。请重试。`;
    }
    return `warmup 进行中（${stage}）。`;
}

// SEE-1070 #2 + SEE-1110 §3: structured warmup diagnostic attached to error.data
// so callers (and tests) can distinguish recovering vs failed-exit without
// parsing strings. The old fields are preserved exactly; SEE-1110 adds the
// stage/handshake/log-tail/lease dimensions at the END of the object (R3 —
// forward-compatible: 6-agent regression asserts only the old fields).
function warmupDiagnostic(forceState = undefined) {
    const now = Date.now();
    const state = forceState ?? (recovering ? 'recovering' : warmupTimedOut ? 'failed_exit' : 'warming');
    const diag = {
        state,
        host: GODOT_HOST,
        port: GODOT_PORT,
        renderStable,
        elapsedMs: now - startedAt,
        warmupTimeoutMs: currentWarmupTimeout(),
        failedExitMs: FAILED_EXIT_MS,
        recoveringForMs: recovering ? (now - recoveringEnteredAt) : 0,
    };
    if (KOL_PROGRESS_PROTOCOL !== 'off') {
        // §3.1 appended schema (kept after the legacy fields).
        const hkSub = handshakeSubstate();
        diag.stage = stage;
        diag.stageProgress = stageOrdinal(stage);
        diag.stageTotal = STAGE_TOTAL;
        diag.stageTimestamps = { ...stageTimestamps };
        diag.handshakeSubstate = hkSub;
        diag.handshakePendingMs = handshakePendingMs();
        diag.coldMode = coldMode;
        diag.logTailAvailable = logTailAvailable;
        diag.leaseExitDetected = leaseExitDetected;
        // §3.1: elapsedMs basis changes from startedAt to spawnStartedAt || startedAt.
        diag.elapsedMs = now - (spawnStartedAt || startedAt);
    }
    // SEE-1085 §6.3 orphan hint: if the port was ALREADY listening on the
    // first tools/call (lastSpawnReused) and we are now stuck in recovering
    // or failed_exit, the holder is an orphan / unhealthy editor we never
    // started. Surface a one-line hint so the operator (or Atlas QA) knows
    // the recovery is not our spawn — kill the orphan instead of waiting.
    if (lastSpawnReused && (state === 'recovering' || state === 'failed_exit')) {
        diag.hint = `port ${GODOT_PORT} was already listening at first tools/call; recovery is over a foreign holder (orphan editor), not our spawn.`;
    }
    // SEE-1170 通道 3: surface bare-repo-prune outcome so callers / QA can tell
    // "stale registration, recovered after prune" apart from "still failing,
    // cause unclear" without parsing stageLog strings. Only set when the
    // resolveWorktreeForSpawn anchor-failure path actually ran a prune attempt.
    if (lastBareRepoPruneDiag) {
        diag.bareRepoPrune = lastBareRepoPruneDiag;
    }
    if (diag.hint === undefined) {
        let hint = buildHint(state, now);
        if (!logTailAvailable) {
            hint += '（editor log 不可读，进度基于 TCP probe 降级，stage 可能不完整）';
        }
        diag.hint = hint;
    }
    return diag;
}

// SEE-1070 #7: detect a tools/call that targets a screenshot, so its error
// response can carry a fallback hint. The addon exposes screenshots as WS
// commands capture_game_screenshot / capture_editor_screenshot; in this
// deployment they surface as godot_editor_read action=screenshot_game|
// screenshot_editor (there is no top-level "screenshot" tool). Match all
// plausible forms so the hint fires regardless of how upstream names them.
// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
function isScreenshotToolsCall(msg) {
    const params = msg && msg.params;
    if (!params || typeof params !== 'object') return false;
    const name = params.name;
    if (typeof name !== 'string') return false;
    if (name === 'screenshot'
        || name === 'capture_game_screenshot'
        || name === 'capture_editor_screenshot') return true;
    if (name.startsWith('screenshot_')) return true;
    if (name === 'godot_editor_read') {
        const action = params.arguments && params.arguments.action;
        return typeof action === 'string' && action.startsWith('screenshot');
    }
    // SEE-1328 §SPEC-014: godot_input carries sequence-frame captures via the
    // screenshot_at_ms entry (per-input and top-level) — those responses ride
    // the same fallback-hint + freshness contract as plain screenshots.
    if (name === 'godot_input') {
        const args = params.arguments;
        if (!args || typeof args !== 'object') return false;
        if (typeof args.screenshot_at_ms !== 'undefined') return true;
        if (Array.isArray(args.inputs)
            && args.inputs.some((e) => e && typeof e === 'object' && typeof e.screenshot_at_ms !== 'undefined')) return true;
        return false;
    }
    return false;
}

// §SPEC-014: two-state capture-contract gate. The enrichment machinery
// (freshness metadata + PNG export + opt-in auto_step) is only meaningful
// against a WARM chain. During the shim-placeholder window (chain not yet
// warm / transport not ready) the call is heading for the hold/warmup paths —
// running auto_step or stamping a forwardedAtMs then would enrich a capture
// that has not been issued (placeholder-era bypass). 'auto_step' and 'enrich'
// both flow through the contract; 'bypass' skips the contract state entirely
// (fallback-hint error tracking is unaffected — it keys off screenshotCallIds).
function screenshotCaptureMode({ warm, transportReady, autoStepRequested = false }) {
    if (!warm || !transportReady) return 'bypass';
    return autoStepRequested ? 'auto_step' : 'enrich';
}

// Hint appended to a screenshot error response. The original error is fully
// preserved (message prepended, existing data spread) — nothing is swallowed.
// §SPEC-014: path fixed to the post-T4 KOL layout (the fallback script lives
// inside the addon submodule; the legacy .dev/godot-mcp/launch path no longer
// exists in a current checkout).
const SCREENSHOT_FALLBACK_HINT =
    ' [hint: screenshot 失败，可调 addons/godot_mcp/launch/screenshot-fallback.sh 兜底抓主屏 → PNG]';
function augmentScreenshotError(error) {
    if (!error || typeof error !== 'object') return error;
    const out = { ...error };
    out.message = typeof out.message === 'string'
        ? out.message + SCREENSHOT_FALLBACK_HINT
        : SCREENSHOT_FALLBACK_HINT.trim();
    const fallback = 'addons/godot_mcp/launch/screenshot-fallback.sh';
    out.data = (out.data && typeof out.data === 'object')
        ? { ...out.data, screenshotFallback: fallback }
        : { screenshotFallback: fallback };
    return out;
}

// SEE-1070 #8: detect a godot_exec tools/call so its responses can carry
// targeted GDScript-pitfall hints. exec surfaces as the `godot_exec` tool name.
function isExecToolsCall(msg) {
    const params = msg && msg.params;
    return params && typeof params === 'object' && params.name === 'godot_exec';
}

// SEE-1240 WS-3: mutation trackers feeding the frame-age contract. A screenshot
// capture whose worktree saw an exec mutation or input sequence since the last
// game-time step / thaw is flagged `stale` (the classic set→不 step→capture RED
// case): the viewport texture still shows the pre-mutation frame whenever the
// game is frozen/paused, and the addon's frame_post_draw wait cannot detect it
// on a healthy draw loop. Wall-clock latency alone catches only the SLOW case
// (blocked frame_post_draw), so both signals compose in frameAgeVerdict.
let lastMutationAtMs = 0;   // last exec / input-sequence forward
let lastFrameAdvanceAtMs = 0; // last game_time step/step_until/thaw that drew
function isGameTimeToolsCall(msg) {
    const params = msg && msg.params;
    const args = params && params.arguments;
    if (!params || params.name !== 'godot_game_time') return false;
    const action = args && args.action;
    return action === 'step' || action === 'step_until' || action === 'thaw';
}
function isInputSequenceToolsCall(msg) {
    const params = msg && msg.params;
    const args = params && params.arguments;
    return Boolean(params && params.name === 'godot_input'
        && args && args.action === 'sequence' && Array.isArray(args.inputs));
}

// SEE-1240 WS-3: detect the proxy-provided godot_ui_inspect tool. Answered
// in-band by composing godot_exec runs (the D1-era ruling: exec-based first),
// so its responses never transit npx.
function isUiInspectToolsCall(msg) {
    const params = msg && msg.params;
    return params && typeof params === 'object' && params.name === UI_INSPECT_TOOL.name;
}

// SEE-1240 WS-3: answer a godot_ui_inspect call by running one composed
// godot_exec snippet against the running game, then replying in-band. The
// helper returns an MCP response object; null means the call could not be
// answered (never happens for well-formed calls — all failures become
// structured error results so the agent sees actionable text).
async function answerUiInspectCall(msg) {
    const id = msg.id;
    const args = (msg.params && msg.params.arguments) || {};
    const v = validateUiInspectArgs(args);
    if (!v.ok) {
        return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: `Error: ${v.error}` }] },
        };
    }
    const snippet = (v.action === 'inspect_node')
        ? UI_INSPECT_SNIPPETS.inspect(normalizeNodePath(v.nodePath))
        : UI_INSPECT_SNIPPETS.uiTree(normalizeNodePath(v.nodePath));
    const out = await forwardGodotExecAndAwait({ action: 'run', source: snippet, budget_ms: 25000 });
    const unreliableNote = {
        field_trust: {
            hover: UNRELIABLE_FIELDS.hover,
            mouse_position: UNRELIABLE_FIELDS.mouse_position,
            window_focus: UNRELIABLE_FIELDS.window_focus,
        },
    };
    if (out.error !== undefined) {
        return {
            jsonrpc: '2.0',
            id,
            result: {
                content: [{
                    type: 'text',
                    text: `Error: godot_ui_inspect underlying exec failed: ${out.error.message || JSON.stringify(out.error)}`,
                }],
            },
        };
    }
    // The exec result text carries {completed,result,...}; the game-side
    // snippet JSON-stringified its payload into `result`.
    let payload = null;
    try {
        const outer = JSON.parse((out.content || []).map((c) => (c && c.text) || '').join(''));
        payload = typeof outer.result === 'string' ? JSON.parse(outer.result) : outer.result;
    } catch {
        payload = null;
    }
    if (payload === null) {
        return {
            jsonrpc: '2.0',
            id,
            result: {
                content: [{
                    type: 'text',
                    text: `Error: godot_ui_inspect could not parse the underlying exec result (game responded: ${(out.content || []).map((c) => (c && c.text) || '').join('').slice(0, 400)})`,
                }],
            },
        };
    }
    if (payload.ok === false) {
        return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: `Error: ${payload.error} (${payload.node_path || payload.root_path || ''})` }] },
        };
    }
    const lines = [JSON.stringify({ ...payload, field_trust: unreliableNote.field_trust })];
    lines.push(`[reliability] hover/mouse-position/focus fields: ${UNRELIABLE_FIELDS.hover} | ${UNRELIABLE_FIELDS.mouse_position}`);
    lines.push('[semantics] node paths resolve against the RUNNING GAME scene root (/root/...), unified SEE-1240; headless contexts: treat hover/mouse fields as advisory only.');
    return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: lines.join('\n') }] },
    };
}

// SEE-1240 WS-3: run one godot_exec tools/call through npx and resolve with
// the parsed MCP result object (or { error } with an Error). Used only by the
// ui_inspect composition — a single fixed-shape internal call, distinct id
// space so it cannot collide with client ids.
async function forwardGodotExecAndAwait(execArgs) {
    const internalId = `see1240-ui-inspect-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const line = JSON.stringify({
        jsonrpc: '2.0',
        id: internalId,
        method: 'tools/call',
        params: { name: 'godot_exec', arguments: execArgs },
    });
    return new Promise((resolve) => {
        internalExecWaiters.set(internalId, resolve);
        // Safety timeout well under the CLI's QUICK_TIMEOUT cascade for a
        // 10s-budget exec: a hung game answers nothing, and the caller gets a
        // structured error instead of an infinite await.
        const timer = setTimeout(() => {
            if (internalExecWaiters.has(internalId)) {
                internalExecWaiters.delete(internalId);
                resolve({ error: { message: 'internal exec timed out (game unresponsive?)' } });
            }
        }, 45000);
        internalExecTimers.set(internalId, timer);
        forwardToNpx(line);
    });
}
const internalExecWaiters = new Map();
const internalExecTimers = new Map();

// SEE-1240 WS-3: screenshot calls awaiting their proxy-performed auto_step.
// id → { line, msg } (the ORIGINAL capture line, forwarded once the step drew).
const pendingAutoStepCalls = new Map();

// Opt-in auto-step for a tracked screenshot call (arguments.auto_step=true):
// run godot_game_time step frames=1 through the internal-exec channel, then
// forward the ORIGINAL capture call. The step result decides the metadata:
// success → autoStepPerformed stamped onto the response's _screenshot block;
// failure → the capture still proceeds (best-effort step), with the failure
// noted in _screenshot.auto_step so the caller can see why freshness is not
// contract-approved.
async function runAutoStepThenForward(screenshotId) {
    const held = pendingAutoStepCalls.get(screenshotId);
    if (!held) return;
    const info = screenshotContract.get(screenshotId);
    try {
        const stepLine = JSON.stringify({
            jsonrpc: '2.0',
            id: `see1240-ui-inspect-${Date.now()}-autostep`,
            method: 'tools/call',
            params: { name: 'godot_game_time', arguments: { action: 'step', frames: 1 } },
        });
        const stepResult = await new Promise((resolve) => {
            const stepId = JSON.parse(stepLine).id;
            internalExecWaiters.set(stepId, resolve);
            const timer = setTimeout(() => {
                if (internalExecWaiters.has(stepId)) {
                    internalExecWaiters.delete(stepId);
                    resolve({ error: { message: 'auto_step timed out' } });
                }
            }, 45000);
            internalExecTimers.set(stepId, timer);
            forwardToNpx(stepLine);
        });
        if (info) {
            info.autoStepPerformed = (stepResult.error !== undefined)
                ? { error: (stepResult.error.message || String(stepResult.error)).slice(0, 200) }
                : { frames: 1, ok: true };
        }
    } catch (err) {
        if (info) info.autoStepPerformed = { error: `auto_step failed: ${err && err.message}` };
    } finally {
        pendingAutoStepCalls.delete(screenshotId);
        forwardToNpx(held.line);
    }
}

// SEE-1240 WS-3: tools/list response patch. Pure (unit-tested):
//   1. append the proxy-provided godot_ui_inspect tool (unless already present
//      — idempotent across npx respawns replaying tools/list),
//   2. apply DESCRIPTION_PATCHES (string-anchored; a changed anchor skips the
//      patch so a future fork that ships the truth natively is left alone),
//   3. note the proxy surface in the first line of... no — in a dedicated
//      trailing entry is noisy; instead the note rides godot_ui_inspect's own
//      description (already explicit) and each patch mentions SEE-1240.
export function patchToolsListForTest(result) { return patchToolsList(result); }
function patchToolsList(result) {
    const tools = result.tools;
    if (!Array.isArray(tools)) return result;
    if (!tools.some((t) => t && t.name === UI_INSPECT_TOOL.name)) {
        tools.push(UI_INSPECT_TOOL);
    }
    for (const patch of DESCRIPTION_PATCHES) {
        const idx = tools.findIndex((t) => t && t.name === patch.tool && typeof t.description === 'string');
        if (idx < 0) continue;
        if (tools[idx].description.includes(patch.anchor)) {
            tools[idx] = {
                ...tools[idx],
                description: tools[idx].description.replace(patch.anchor, patch.replace),
            };
        }
    }
    return { ...result, tools };
}

// SEE-1244 §6.2: persist the post-patch real tools/list for the shim's
// registration window. Fire-and-forget: a cache failure must NEVER delay or
// break the response forwarding (the cache is an observation/acceleration
// layer, not a latch). Atomic mktemp+rename, same discipline as the registry.
// Mirror of godot-mcp-resolve.mjs FORK_CLI (kept inline: proxy must not gain a
// dep on the shim/resolve path shape for a cache-mtime nicety; §7.1 D7).
// §4.5.3 T2: env-overridable; default resolves relative to this library's own location.
const FORK_CLI_PATH = process.env.GODOT_MCP_FORK_CLI
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'dist', 'cli.js');
// SEE-1292 §DECPL-001: all state under GODOT_MCP_HOME (default neutral path).
const GODOT_MCP_HOME = process.env.GODOT_MCP_HOME || path.join(os.homedir(), '.config', 'godot-mcp');
const TOOLS_CACHE_DIR = GODOT_MCP_HOME;
const TOOLS_CACHE_LABEL = (process.env.GODOT_MCP_AGENT_NAME || process.env.KOL_AGENT_NAME || 'unknown').toLowerCase();
const TOOLS_CACHE_FILE = path.join(TOOLS_CACHE_DIR, `godot-mcp-tools-cache-${TOOLS_CACHE_LABEL}.json`);
function writeToolsCache(tools) {
    try {
        if (!Array.isArray(tools) || tools.length === 0) return;
        const payload = JSON.stringify({
            schema: 1,
            fork: (() => { try { return String(statSync(FORK_CLI_PATH).mtimeMs); } catch { return null; } })(),
            updated_at: new Date().toISOString(),
            tools,
        });
        mkdirSync(TOOLS_CACHE_DIR, { recursive: true });
        const tmp = `${TOOLS_CACHE_FILE}.tmp-${process.pid}`;
        writeFileSync(tmp, payload);
        renameSync(tmp, TOOLS_CACHE_FILE);
        log(`tools cache written: ${TOOLS_CACHE_FILE} tools=${tools.length}`);
    } catch (err) {
        log(`WARNING: tools cache write failed (ignored): ${err && err.message}`);
    }
}

// SEE-1244 §6.2 (Revy QA defect #1 fix, option a): the shim intercepts claude's
// registration-window tools/list, so the patchToolsList→writeToolsCache hook on
// claude's forwarded requests can NEVER fire in the real cold-start flow (claude
// does not re-pull after handoff despite listChanged; the proxy never emitted
// notifications/tools/list_changed). Closure therefore cannot depend on any
// client behavior: once WARM (editor live) AND the CLI's WS is connected
// (npxCliConnected — a fresh CLI cannot answer yet, same gate as WARM_FLUSH),
// the proxy ACTIVELY pulls tools/list from the fork on its own id space (same
// pattern as forwardGodotExecAndAwait, SEE-1240 WS-3), patches the response,
// and writes the cache. One-shot per spawn round: npx respawns re-trigger it,
// keeping the cache fresh across CLI restarts. Failure is log-only — the cache
// stays an acceleration layer, never a registration gate.
let toolsCacheRefreshInFlight = false;
let toolsCacheRefreshedForSpawn = false;
const toolsCacheWaiters = new Map();
// MEDIUM-1 (Atlas Final Review): the 45s timeout branch must EXPLICITLY reset
// both latches and leave an audit line — previously it only cleared the waiter,
// so if a stalled request was re-armed by a respawn the inFlight flag could
// stall a later retry. Fork-unresponsive is now: flush failed id, reset both
// flags, audit — the next spawn round retries cleanly.
function abortToolsCacheRefresh(internalId, reason) {
    const timer = toolsCacheWaiters.get(internalId);
    if (!timer) return;
    toolsCacheWaiters.delete(internalId);
    clearTimeout(timer);
    toolsCacheRefreshInFlight = false;
    toolsCacheRefreshedForSpawn = false;
    log(`WARNING: tools cache refresh aborted (${reason}); flags reset — next spawn round retries. id=${internalId}`);
}
function maybeRefreshToolsCache() {
    if (!warm || !npxCliConnected) return;
    if (toolsCacheRefreshInFlight || toolsCacheRefreshedForSpawn) return;
    toolsCacheRefreshInFlight = true;
    const internalId = `see1244-tools-cache-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const line = JSON.stringify({ jsonrpc: '2.0', id: internalId, method: 'tools/list' });
    const timer = setTimeout(() => abortToolsCacheRefresh(internalId, 'timeout_45s_fork_unresponsive'), 45000);
    toolsCacheWaiters.set(internalId, timer);
    log(`tools cache refresh: pulling tools/list from fork (id=${internalId}).`);
    forwardToNpx(line);
}

// SEE-1244 §6.2: consume the refresh response — patch + cache write, then emit
// notifications/tools/list_changed so any listChanged-aware client (claude
// declared support in the shim's initialize) re-pulls the REAL list within the
// same session. Best-effort; the closure never depends on the client acting.
function resolveToolsCacheRefresh(msg) {
    const timer = toolsCacheWaiters.get(msg.id);
    if (!timer) return false;
    toolsCacheWaiters.delete(msg.id);
    clearTimeout(timer);
    toolsCacheRefreshInFlight = false;
    toolsCacheRefreshedForSpawn = true;
    try {
        const patched = patchToolsList(msg.result);
        writeToolsCache(patched.tools);
        log(`tools cache refresh complete: tools=${patched.tools.length} (post-patch).`);
        // Protocol-legal channel declared in the shim's initialize capabilities;
        // claude re-pulls tools/list (which this time flows to the warm proxy
        // and gets the REAL patched list — closing the description drift window).
        sendToClaude({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    } catch (err) {
        log(`WARNING: tools cache refresh handling failed (ignored): ${err && err.message}`);
    }
    return true;
}

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

// Common GDScript exec pitfalls matched against the response text. Each hint is
// appended verbatim (original message preserved). Patterns are intentionally
// narrow: they fire only on the specific signature of each pitfall so unrelated
// errors pass through untouched.
const EXEC_HINTS = [
    {
        // `[x for x in arr]` — GDScript has no list/dict comprehensions.
        match: /\[[^\]]*\bfor\b[^\]]*\bin\b/,
        hint: ' [hint: GDScript 无列表推导式（`[x for x in arr]` 不可用）；改用 `arr.map(func(x): return ...)` 或普通 for 循环]',
    },
    {
        // override return type conflicts with parent signature — e.g. parent
        // `-> bool`, override declared `-> void` (or any non-void/void mismatch).
        match: /->\s*void\b[\s\S]{0,160}->\s*(bool|int|float|String|string|Variant|Object|Node2D|Node)\b|->\s*(bool|int|float|String|string|Variant|Object|Node2D|Node)\b[\s\S]{0,160}->\s*void\b|(return type|signature)[\s\S]{0,60}(parent|override|mismatch|conflict)/i,
        hint: ' [hint: GDScript override 的返回类型必须与父类签名完全一致（父类 `-> bool` 时子类不可 `-> void`）；统一签名或改父类]',
    },
];

// Godot's str() truncates non-primitive return values to ~200 chars. A return
// that parses as the outer envelope's `result` field, looks like a container
// (`[`/`{`), and sits near the cap is almost certainly truncated — the proxy
// can't recover the full value (truncation is server-side), so it points the
// caller at JSON.stringify instead.
const STR_TRUNCATION_CAP = 200;
const TRUNCATION_HINT =
    ' [hint: 返回 Array/Dictionary 被 Godot `str()` 截断至 ~200 字符；在 GDScript 内 `return JSON.stringify(value)` 可拿回完整结构]';

function looksTruncatedContainer(resultVal) {
    if (typeof resultVal !== 'string') return false;
    const s = resultVal.trim();
    if (s.length < STR_TRUNCATION_CAP - 10) return false;
    return s.startsWith('[') || s.startsWith('{');
}

// Build the concatenated hint string for an exec response text. Parses the
// {completed,result,runtime_errors} envelope when present so runtime_errors are
// scanned alongside the raw text; falls back to scanning raw text otherwise.
function execHintsForText(text) {
    if (typeof text !== 'string' || text.length === 0) return '';
    let probe = text;
    let resultVal;
    try {
        const outer = JSON.parse(text);
        if (Array.isArray(outer.runtime_errors) && outer.runtime_errors.length) {
            probe = [text, ...outer.runtime_errors.map(String)].join('\n');
        }
        if (typeof outer.result === 'string') resultVal = outer.result;
    } catch {
        // not the exec JSON envelope — scan raw text only
    }
    let hints = '';
    for (const h of EXEC_HINTS) {
        if (h.match.test(probe)) hints += h.hint;
    }
    if (looksTruncatedContainer(resultVal)) hints += TRUNCATION_HINT;
    return hints;
}

// Append exec hints to each text item of an MCP `result` (the common exec
// path: errors live inside the result text, not as an MCP error). Returns the
// new result object when something changed, or null when nothing was touched
// (so the caller avoids needless re-serialization of the happy path).
function augmentExecResult(resultObj) {
    if (!resultObj || typeof resultObj !== 'object' || !Array.isArray(resultObj.content)) return null;
    let changed = false;
    const newContent = resultObj.content.map((c) => {
        if (!c || c.type !== 'text' || typeof c.text !== 'string') return c;
        const hints = execHintsForText(c.text);
        if (!hints) return c;
        changed = true;
        return { ...c, text: c.text + hints };
    });
    return changed ? { ...resultObj, content: newContent } : null;
}

// SEE-1085 usability: detect a tools/call error caused by a concurrent client
// holding the addon's single WebSocket slot. The godot_mcp addon accepts ONE WS
// client; a second connection is rejected with close code 4001
// (ALREADY_CONNECTED) and a "another client is already connected" line. npx
// godot-mcp surfaces this to the proxy as a tools/call error like
// "Not connected to Godot — Another client is already connected". Without
// wrapping the agent sees a bare failure indistinguishable from a dead editor.
// We attach a structured warmupDiagnostic {state:'editor_busy', retryable:true}
// so the agent retries shortly (the other session's proxy disconnect, or the
// editor's SEE-1070 lease self-exit, releases the slot) instead of giving up.
const EDITOR_BUSY_PATTERNS = [
    /another client is already connected/i,
    /already_?connected/i,
    /rejected new connection/i,
    /(?:websocket|ws[\s_-]?(?:close|code))[\s\S]{0,60}\b4001\b/i,
    /\b4001\b[\s\S]{0,60}(?:another client|already)/i,
];

function isEditorBusyError(error) {
    if (!error || typeof error !== 'object') return false;
    const m = typeof error.message === 'string' ? error.message : '';
    return m.length > 0 && EDITOR_BUSY_PATTERNS.some((re) => re.test(m));
}

function editorBusyDiagnostic() {
    const diag = {
        state: 'editor_busy',
        host: GODOT_HOST,
        port: GODOT_PORT,
        retryable: true,
        hint: `the godot_mcp addon accepts only one WebSocket client at a time; another session is holding port ${GODOT_PORT}. Retry after the other session releases the slot (its proxy disconnects, or the editor's SEE-1070 lease self-exits). If this persists, a concurrent same-agent run is likely holding the slot — only one proxy should connect per agent port.`,
    };
    // SEE-1110 §4.2: the occupying client is healthy and already past the WS
    // handshake, so stage reflects that (WS_HANDSHAKE or MCP_INITIALIZED) and the
    // substate is rejected_4001 (the addon rejects the newcomer with close 4001).
    if (KOL_PROGRESS_PROTOCOL !== 'off') {
        diag.stage = stage === 'WARM' ? 'MCP_INITIALIZED' : (stageOrdinal(stage) < 5 ? 'WS_HANDSHAKE' : stage);
        diag.handshakeSubstate = 'rejected_4001';
        diag.leaseExitDetected = leaseExitDetected;
    }
    return diag;
}

// Wrap a competition error with a retryable editor_busy diagnostic. The original
// message is preserved (a retryable suffix is appended so agents reading only
// the message — not data — still see it); warmupDiagnostic is attached to
// error.data alongside any existing data. Returns the SAME object reference when
// the error does not match, so the caller skips a needless re-serialize.
function augmentEditorBusyError(error) {
    if (!isEditorBusyError(error)) return error;
    const out = { ...error };
    const suffix = ` [editor_busy: retryable — another session holds the godot_mcp WebSocket slot on port ${GODOT_PORT}; retry shortly]`;
    out.message = typeof out.message === 'string' ? out.message + suffix : out.message;
    out.data = (out.data && typeof out.data === 'object')
        ? { ...out.data, warmupDiagnostic: editorBusyDiagnostic() }
        : { warmupDiagnostic: editorBusyDiagnostic() };
    return out;
}

// SEE-1085 usability: detect a tools/call error caused by the editor's WebSocket
// becoming unreachable AFTER warmup (the editor crashed, or its SEE-1070 lease
// self-exited without the lease monitor catching it — e.g. a hard crash with no
// exit line). npx surfaces this as a bare "Not connected to Godot" / "WebSocket
// closed" / connection-refused error the agent cannot distinguish from a config
// problem, so it gives up instead of retrying. We wrap it as a retryable
// editor_gone diagnostic. Patterns are disjoint from EDITOR_BUSY_PATTERNS (no
// "another client" / 4001), and the forwarder checks editor_busy first, so a
// competition error is never misclassified as editor_gone.
const EDITOR_GONE_PATTERNS = [
    /not connected to godot/i,
    /(?:websocket|ws[\s_-]?(?:close|closed|fail|failed|error))/i,
    /connection refused|econnrefused/i,
    /editor(?:[^.]{0,40})?(?:closed|exited|crashed|not responding|unreachable)/i,
];

function isEditorGoneError(error) {
    if (!error || typeof error !== 'object') return false;
    const m = typeof error.message === 'string' ? error.message : '';
    return m.length > 0 && EDITOR_GONE_PATTERNS.some((re) => re.test(m));
}

function editorGoneDiagnostic() {
    const diag = {
        state: 'editor_gone',
        host: GODOT_HOST,
        port: GODOT_PORT,
        retryable: true,
        hint: `the editor's WebSocket on port ${GODOT_PORT} became unreachable after warmup (it may have crashed, or its SEE-1070 lease self-exited). Retry shortly; if it persists, restart the MCP server so the proxy re-spawns the editor.`,
    };
    // SEE-1110 §4.3: editor_gone appends the stage dimension too.
    if (KOL_PROGRESS_PROTOCOL !== 'off') {
        diag.stage = stage;
        diag.leaseExitDetected = leaseExitDetected;
    }
    return diag;
}

// Wrap a post-warm unreachable-editor error with a retryable editor_gone
// diagnostic. Same preserve-the-original contract as augmentEditorBusyError;
// returns the SAME reference when the error does not match.
function augmentEditorGoneError(error) {
    if (!isEditorGoneError(error)) return error;
    const out = { ...error };
    const suffix = ` [editor_gone: retryable — editor WebSocket on port ${GODOT_PORT} unreachable after warmup; retry shortly]`;
    out.message = typeof out.message === 'string' ? out.message + suffix : out.message;
    out.data = (out.data && typeof out.data === 'object')
        ? { ...out.data, warmupDiagnostic: editorGoneDiagnostic() }
        : { warmupDiagnostic: editorGoneDiagnostic() };
    return out;
}

// Combined tools/call error augmentation: editor_busy first (concurrent slot
// holder), then editor_gone (post-warm unreachable). Returns the SAME reference
// when neither matches. Order matters — a competition error contains "not
// connected" too, so editor_busy must take precedence.
function augmentToolsCallError(error) {
    const busy = augmentEditorBusyError(error);
    if (busy !== error) return busy;
    return augmentEditorGoneError(error);
}

function forwardToNpx(line) {
    if (npx && npx.stdin && !npx.stdin.destroyed) {
        if (npxStdinReady) {
            npx.stdin.write(line + EOL);
            log(`DEBUG: forwarded to npx stdin: ${line.slice(0, 120)}`);
        } else {
            npxWriteBuffer.push(line + EOL);
            log(`DEBUG: npx stdin not yet writable; buffered message (${line.slice(0, 80)})`);
        }
    } else {
        log('WARNING: npx stdin not available; dropping message.');
    }
}

// ---- SEE-1085 §1 (Revy §4.3): editor_busy wait/retry takeover ----------------
// When a tools/call comes back as editor_busy (a concurrent same-agent session
// holds the addon's single WS slot), do NOT fail the call immediately. Instead
// re-dispatch it on a short backoff, racing to take the slot when the holder
// releases it (its proxy disconnects, or the editor's SEE-1070 lease self-exits).
// npx holds a persistent WS once it connects, so a single winning probe lets
// normal flow resume. Bounded by KOL_TAKEOVER_TIMEOUT_MS; on expiry the call
// returns a retryable editor_busy diagnostic so the agent can retry the whole
// turn instead of giving up on what it thinks is a dead editor.
//
// One probe at a time: the addon is single-client, so concurrent probes would
// all be rejected together and waste npx round-trips. A waiter set + single
// probeId deduplicates concurrent busy calls.
//
// Set KOL_TAKEOVER_TIMEOUT_MS=0 to disable takeover entirely (fall back to the
// immediate editor_busy diagnostic — the §2-only behavior, used by test seams
// that want the diagnostic without the wait).
const TAKEOVER_TIMEOUT_MS = parseInt(process.env.GODOT_MCP_TAKEOVER_TIMEOUT_MS || process.env.KOL_TAKEOVER_TIMEOUT_MS || '30000', 10);
const TAKEOVER_RETRY_MS = parseInt(process.env.GODOT_MCP_TAKEOVER_RETRY_MS || process.env.KOL_TAKEOVER_RETRY_MS || '2000', 10);
// SEE-1316 (hardener): bounded self-heal after repeated takeover timeouts.
// Threshold 3 ≈ 90s of proven-stuck holder (3 × 30s wait); disable with
// GODOT_MCP_TAKEOVER_SELF_HEAL=off (test seam / operator escape hatch).
const TAKEOVER_SELF_HEAL_THRESHOLD = parseInt(process.env.GODOT_MCP_TAKEOVER_SELF_HEAL_THRESHOLD || '3', 10);
const TAKEOVER_SELF_HEAL_ENABLED = (process.env.GODOT_MCP_TAKEOVER_SELF_HEAL || 'on') !== 'off';
let takeoverFailStreak = 0;
let takeoverSelfHealInFlight = false;
// Active takeover coordinator, or null when idle. Shape:
//   { deadline, waiters: Set<id>, probeId: id|null, timer: NodeJS.Timeout|null }
let takeover = null;

function editorBusyTakeoverDiagnostic() {
    const diag = {
        state: 'editor_busy',
        host: GODOT_HOST,
        port: GODOT_PORT,
        retryable: true,
        hint: `same-agent concurrent session holding port ${GODOT_PORT}, waiting for takeover — timed out after ${TAKEOVER_TIMEOUT_MS}ms; retry the turn. If it persists, ensure only one proxy runs per agent port.`,
    };
    // SEE-1110 §4.2: same rejected-4001 view as editorBusyDiagnostic.
    if (KOL_PROGRESS_PROTOCOL !== 'off') {
        diag.stage = stage === 'WARM' ? 'MCP_INITIALIZED' : (stageOrdinal(stage) < 5 ? 'WS_HANDSHAKE' : stage);
        diag.handshakeSubstate = 'rejected_4001';
        diag.leaseExitDetected = leaseExitDetected;
    }
    return diag;
}

// Add a tools/call id to the waiter set and arm the coordinator if it is the
// first waiter. Idempotent: re-adding an existing waiter is a no-op.
function enterTakeoverWaiter(id) {
    if (!takeover) {
        takeover = {
            deadline: Date.now() + TAKEOVER_TIMEOUT_MS,
            waiters: new Set(),
            probeId: null,
            probeAt: 0,
            timer: null,
        };
        log(`editor_busy takeover armed (timeout ${TAKEOVER_TIMEOUT_MS}ms, retry every ${TAKEOVER_RETRY_MS}ms) — waiting for the holder to release port ${GODOT_PORT}`);
        takeover.timer = setTimeout(attemptTakeoverProbe, TAKEOVER_RETRY_MS);
    } else if (takeover.probeId === null && takeover.timer === null) {
        // Defensive: a new waiter arrived while the coordinator is idle (no probe
        // in flight, no timer pending). Re-arm so the waiter is not stranded.
        takeover.timer = setTimeout(attemptTakeoverProbe, TAKEOVER_RETRY_MS);
    }
    takeover.waiters.add(id);
}

// Pick the oldest waiter and re-dispatch its original line to npx as the slot
// probe. Only one probe at a time (single-client addon → concurrent probes all
// lose together). If a probe is in flight, re-arm and wait — unless it has hung
// past 2x the retry interval (npx unresponsive without exiting), in which case
// reclaim the slot probe so the coordinator is not stranded.
function attemptTakeoverProbe() {
    if (!takeover) return;
    if (Date.now() >= takeover.deadline) {
        failTakeover();
        return;
    }
    if (takeover.probeId !== null) {
        const stuckMs = Date.now() - (takeover.probeAt || 0);
        if (stuckMs < TAKEOVER_RETRY_MS * 2) {
            takeover.timer = setTimeout(attemptTakeoverProbe, TAKEOVER_RETRY_MS);
            return;
        }
        log(`takeover: probe id=${takeover.probeId} appears lost (no response in ${stuckMs}ms); reclaiming slot probe`);
        takeover.probeId = null;
        takeover.probeAt = 0;
    }
    const id = takeover.waiters.values().next().value;
    if (id === undefined) {
        endTakeover();
        return;
    }
    const line = toolsCallLines.get(id);
    if (!line) {
        // Line vanished (shouldn't happen) — drop the waiter and keep probing.
        takeover.waiters.delete(id);
        takeover.timer = setTimeout(attemptTakeoverProbe, TAKEOVER_RETRY_MS);
        return;
    }
    takeover.probeId = id;
    takeover.probeAt = Date.now();
    toolsCallIds.add(id); // re-track so the forwarder recognizes the probe response
    log(`takeover: probing WS slot by re-dispatching tools/call id=${id} (${takeover.waiters.size} waiter(s))`);
    forwardToNpx(line);
}

// Takeover timed out: deliver the retryable editor_busy diagnostic to every
// waiter and clear the coordinator. Respects the SEE-1070 lease by simply
// giving up at the deadline — the lease's own self-exit on the holder is one
// legitimate way the slot would have freed (we just did not win in time).
function failTakeover() {
    if (!takeover) return;
    const t = takeover;
    takeover = null;
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    log(`takeover: timed out after ${TAKEOVER_TIMEOUT_MS}ms — ${t.waiters.size} waiter(s) return editor_busy`);
    for (const id of t.waiters) {
        toolsCallIds.delete(id);
        toolsCallLines.delete(id);
        sendToClaude(makeErrorResponse(
            id,
            `editor busy: another session holds the godot_mcp WebSocket slot on port ${GODOT_PORT}; gave up waiting for takeover after ${TAKEOVER_TIMEOUT_MS}ms`,
            -32000,
            { warmupDiagnostic: editorBusyTakeoverDiagnostic() },
        ));
    }
    // SEE-1316 (hardener) — bounded self-heal for a stuck-holder 4001 loop:
    // TAKEOVER_TIMEOUT_MS waits are designed for a HEALTHY holder that will
    // release shortly (its proxy disconnects / lease self-exits). When they
    // fail repeatedly, the likely holder is a dead session's orphaned editor
    // (the incumbent WS client is a ghost npx) — the addon's 45s
    // stale-connection replacement should free it, but a half-open TCP peer
    // can hold the slot past that window with no packets to age it out.
    // After N consecutive timed-out takeovers, run ONE eviction pass scoped
    // to THIS slot's recorded holder (stop-godot-editor + holder-scoped reap),
    // then re-arm the warmup state machine so the next tools/call re-spawns.
    // Bounded and conservative: a live foreign-runtime holder is untouched —
    // evictStaleHolder's stop helper pins to the holder's own worktree, and
    // the arbiter's busy_foreign verdict at spawn time remains the authority
    // for cross-runtime contention.
    takeoverFailStreak += 1;
    if (TAKEOVER_SELF_HEAL_ENABLED && takeoverFailStreak >= TAKEOVER_SELF_HEAL_THRESHOLD && !takeoverSelfHealInFlight) {
        takeoverFailStreak = 0;
        takeoverSelfHealInFlight = true;
        log(`WARNING: ${TAKEOVER_SELF_HEAL_THRESHOLD} consecutive takeover timeouts on port ${GODOT_PORT}; holder is likely an orphaned editor — evicting (bounded self-heal, SEE-1316) then re-arming warmup.`);
        (async () => {
            try {
                await evictStaleHolder(await readHolderWorktree());
            } catch (err) {
                log(`takeover self-heal: non-fatal eviction failure: ${err && err.message ? err.message : err}`);
            } finally {
                // Re-arm: next tools/call walks the spawn/arbiter path against
                // the (hopefully) freed port instead of hammering a stuck slot.
                warm = false;
                warmEditorDead = false;
                // eslint-disable-next-line no-undef -- SEE-1334 baseline: warmFlushed is not declared in this scope (its `let` lives in another function at L3525); suspected latent bug, flagged for drift triage
                warmFlushed = false;
                spawnTriggered = false;
                takeoverSelfHealInFlight = false;
                log('takeover self-heal: warmup re-armed — next tools/call re-runs the spawn/arbiter path.');
            }
        })();
    }
}

// The probe won the slot (or hit a non-busy outcome). Forward this response to
// Claude normally and re-dispatch any remaining waiters — npx now holds the WS,
// so they will succeed without re-competition. Clears the coordinator.
function drainTakeoverWaiters(readyId) {
    if (!takeover) return;
    takeover.waiters.delete(readyId);
    if (takeover.probeId === readyId) takeover.probeId = null;
    if (takeover.waiters.size === 0) {
        endTakeover();
        return;
    }
    // npx connected on the winning probe — flush remaining waiters through normal
    // flow. They will be answered by the forwarder directly now that takeover is
    // ended and their ids are re-tracked.
    const rest = Array.from(takeover.waiters);
    endTakeover();
    for (const id of rest) {
        const line = toolsCallLines.get(id);
        if (!line) { toolsCallLines.delete(id); continue; }
        toolsCallIds.add(id);
        log(`takeover: slot acquired; re-dispatching queued tools/call id=${id}`);
        forwardToNpx(line);
    }
}

function endTakeover() {
    if (!takeover) return;
    if (takeover.timer) { clearTimeout(takeover.timer); takeover.timer = null; }
    takeover = null;
    // SEE-1316: a successful takeover proves the holder released the slot —
    // the self-heal streak measures STUCK holders only.
    takeoverFailStreak = 0;
    log('takeover: ended (slot acquired or no waiters)');
}

function currentWarmupTimeout() {
    // Classified once at the start of warmupLoop by probing the editor TCP port:
    // already listening => hot reuse (short window); not yet => cold boot (long
    // window). Falls back to the cold window if read before classification.
    return warmupTimeoutMs ?? COLD_WARMUP_TIMEOUT_MS;
}

function maybeProgressLog(force = false) {
    const now = Date.now();
    if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    const elapsed = Math.floor((now - startedAt) / 1000);
    const count = pendingCalls.length;
    const status = warm ? 'warm' : recovering ? 'recovering' : warmupTimedOut ? 'failed-exit' : 'waiting';
    log(`waiting for editor warmup... ${elapsed}s elapsed, ${count} call(s) queued (${status})`);
}

function flushQueue() {
    while (pendingCalls.length > 0) {
        const line = pendingCalls.shift();
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
    npxTransportReady = true;
    if (warm) {
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
    if (npxTransportReady) return;
    if (npxReadyDropped) return;
    npxReadyDropped = true;
    log('WARNING: npx transport never became ready before the first warm; rejecting held first call as retryable.');
    rejectQueue('editor warmup completed but the godot-mcp transport never became ready; please retry', warmupDiagnostic('recovering'));
}

function rejectQueue(reason, data = undefined) {
    while (pendingCalls.length > 0) {
        const line = pendingCalls.shift();
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
    screenshotCallIds.delete(id);
    execCallIds.delete(id);
    toolsCallIds.delete(id);
    toolsCallLines.delete(id);
    pendingHandshake.delete(id);
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
        if (id !== undefined && !warm && !warmupTimedOut) {
            pendingHandshake.set(id, line);
        }
        forwardToNpx(line);
        return;
    }

    if (method === 'tools/call') {
        // SEE-1240 WS-3: the proxy-provided godot_ui_inspect tool. Valid only
        // against a warm chain (it composes godot_exec); otherwise fall through
        // to the normal warmup paths so the caller sees the standard diagnostics.
        if (isUiInspectToolsCall(msg)) {
            if (warm && npxTransportReady) {
                if (id !== undefined) {
                    toolsCallIds.add(id);
                    toolsCallLines.set(id, line);
                }
                answerUiInspectCall(msg)
                    .then((response) => {
                        if (id !== undefined) {
                            toolsCallIds.delete(id);
                            toolsCallLines.delete(id);
                        }
                        sendToClaude(response);
                    })
                    .catch((err) => {
                        if (id !== undefined) {
                            toolsCallIds.delete(id);
                            toolsCallLines.delete(id);
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
            if (id !== undefined) uiInspectCallIds.add(id);
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
            screenshotCallIds.add(id);
            const args = (msg.params && msg.params.arguments) || {};
            const mode = screenshotCaptureMode({
                warm,
                transportReady: npxTransportReady,
                autoStepRequested: args.auto_step === true,
            });
            if (mode === 'auto_step') {
                screenshotContract.set(id, {
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
                pendingAutoStepCalls.set(id, { line, msg });
                runAutoStepThenForward(id);
                return;
            } else if (mode === 'enrich') {
                screenshotContract.set(id, {
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
            execCallIds.add(id);
            // SEE-1240 WS-3: an exec run may mutate game state — record it for
            // the screenshot frame-age contract (set→不 step→capture detection).
            if (((msg.params.arguments || {}).action) === 'run') lastMutationAtMs = Date.now();
        }
        // SEE-1240 WS-3: a game_time step/step_until/thaw draws at least one
        // frame — anything captured after it is definitionally post-advance.
        if (isGameTimeToolsCall(msg)) {
            lastFrameAdvanceAtMs = Date.now();
        }
        // SEE-1240 WS-3: an input sequence can also change what the next drawn
        // frame shows (button states, hover). Same mutation tracking applies.
        if (isInputSequenceToolsCall(msg)) {
            lastMutationAtMs = Date.now();
        }
        // SEE-1085 usability: track every tools/call id so the forwarder can
        // wrap concurrent-client competition errors with editor_busy.
        if (id !== undefined) {
            toolsCallIds.add(id);
            toolsCallLines.set(id, line); // SEE-1085 §1: original line for takeover re-dispatch
        }
        if (warm) {
            // SEE-1134 Q1: an editor-restart call is intercepted at the proxy.
            // The fork CLI consumes the addon's {restarting:true} ack and returns
            // a fire-and-forget TEXT, so detection is by INBOUND call shape, and
            // the response is HELD (never forwarded to Claude) until the relaunched
            // editor is warm and the CLI reconnected — the old "fire-and-forget"
            // contract becomes a blocking, immediately-usable restart.
            if (isRestartToolsCall(msg)) {
                if (restartHold) {
                    // A second restart while one is in flight: queue it; it runs
                    // after the current restart completes.
                    pendingCalls.push(line);
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
            if (restartHold) {
                pendingCalls.push(line);
                maybeProgressLog(true);
                return;
            }
            // 缺陷 #9: never forward to an npx whose transport is not ready. The
            // godot-mcp CLI's WS connect chain starts ticking at first forward;
            // handing a call to a just-spawned npx (or one mid-restart) starts a
            // ~23s request timeout while the editor is still cold-booting. Hold it
            // in the pending queue instead — the warmup gate flushes it once warm.
            if (!npxTransportReady) {
                pendingCalls.push(line);
                maybeProgressLog(true);
                return;
            }
            forwardToNpx(line);
            return;
        }
        // SEE-1134 Q1: restart in flight and the editor is not warm yet (cold
        // path). Hold the call — never trigger a fresh spawn (the restarted
        // editor rebinds the port itself; spawning here would double-bind 6550)
        // and never reject with a warmup diagnostic (the editor is restarting,
        // not failing). The calls are flushed/rejected when the restart resolves.
        if (restartHold) {
            pendingCalls.push(line);
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
        if (spawnTerminal || giveUpArmedAt > 0) {
            const cooldownLeft = giveUpArmedAt > 0 ? (giveUpArmedAt + giveUpBackoffMs) - Date.now() : 0;
            if (GIVEUP_REARM_ENABLED && spawnTerminal === false && cooldownLeft <= 0) {
                // Cooldown expired → re-arm the warmup state machine. Clear only
                // the cooldown WINDOW (giveUpArmedAt); giveUpBackoffMs stays as
                // the exponential base — the next give-up must double FROM it
                // (WS-5 目标2: 退避加深), not restart from the floor.
                giveUpArmedAt = 0;
                spawnFailedStreak = 0;
                spawnFailedBucket = null;
                spawnAttempts = 0;
                warm = false;
                recovering = false;
                spawnLastFailed = false;   // first-report already consumed by the cooldown-era call(s)
                spawnLastError = null;
                persistGiveUpStatus('rearm', spawnFailedBucket || 'cleared', 'cooldown expired; warmup re-armed');
                log(`give-up cooldown expired (count=${giveUpCount}); warmup re-armed — this call re-triggers the spawn (WS-5).`);
                // fall through to the normal trigger path below.
            } else {
                if (id !== undefined) {
                    dropToolsCallId(id);
                    if (spawnTerminal) {
                        sendToClaude(makeErrorResponse(
                            id,
                            `editor spawn kept failing (${spawnFailedBucket}); giving up this run — restart the MCP server to retry`,
                            -32000,
                            spawnFailedDiagnostic(spawnFailedBucket, null, true),
                        ));
                    } else {
                        // In-band give-up cooldown: surface the ORIGINAL first-report
                        // error (首报保留) plus the recovery plan so the agent can
                        // decide to retry after the cooldown instead of restarting
                        // the MCP server.
                        sendToClaude(makeErrorResponse(
                            id,
                            `editor spawn kept failing (give-up #${giveUpCount}): ${giveUpLastReason}; in-band recovery armed — retry after ${Math.ceil(cooldownLeft / 1000)}s cooldown (retryable, no MCP restart needed)`,
                            -32000,
                            Object.assign(spawnFailedDiagnostic(spawnFailedBucket, spawnLastError, true), {
                                state: 'give_up_cooldown',
                                giveup_count: giveUpCount,
                                cooldown_until_ms: giveUpArmedAt + giveUpBackoffMs,
                                backoff_ms: giveUpBackoffMs,
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
        if (!spawnTriggered && !recovering && !warmupTimedOut) {
            if (firstCallProgressToken == null) {
                const meta = msg.params && msg.params._meta;
                if (meta && Object.prototype.hasOwnProperty.call(meta, 'progressToken')) {
                    firstCallProgressToken = meta.progressToken;
                }
            }
            spawnTriggered = true;
            triggerEnsureEditor();
        }
        // SEE-1111 预热提示 误报防护: the last spawn attempt FAILED (non-terminal).
        // The warmup loop has returned to COLD_EMPTY idle (spawnTriggered reset
        // false), so this call is about to re-trigger spawn — but the agent must
        // first see the REAL spawn_failed diagnostic for the attempt that just
        // broke, never a friendly "warming" hint. One-shot: cleared when a fresh
        // spawn attempt begins (triggerEnsureEditor above would set it false only
        // on success, so re-arming is handled by the next failure latch).
        if (spawnLastFailed) {
            spawnLastFailed = false;
            const lastErr = spawnLastError;
            spawnLastError = null;
            if (id !== undefined) {
                dropToolsCallId(id);
                sendToClaude(makeErrorResponse(
                    id,
                    `editor spawn failed: ${spawnFailedBucket}; will retry on next call`,
                    -32000,
                    spawnFailedDiagnostic(spawnFailedBucket, lastErr, false),
                ));
            }
            return;
        }
        // SEE-1111 缺陷 #7/#8: a post-warm editor death means a respawn round is
        // in flight. The editor is NOT cold-warming (it was warm and died) — a
        // generic "冷启动预热" hint would be wrong. Give the distinct restart
        // hint so the agent retries (the retry will re-trigger the spawn).
        if (warmEditorDead) {
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
        if (recovering) {
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
        if (warmupTimedOut) {
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
        pendingCalls.push(line);
        maybeProgressLog(true);
        return;
    }

    // Unknown methods: forward to npx rather than silently drop.
    forwardToNpx(line);
}

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
    if (restartHold) {
        // fall through to real WS handshake below
    } else if (warm && npxCliConnected) {
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

let renderStableTimer = null;
function startRenderStableMonitor() {
    // SEE-1070 #2: clear any prior monitor before starting a fresh one, so the
    // T2 (WARMING -> RECOVERING) transition can re-prove render stability
    // without leaving a stale interval running.
    if (renderStableTimer) { clearInterval(renderStableTimer); renderStableTimer = null; }
    if (!EDITOR_LOG_FILE) {
        renderStable = true;
        return;
    }
    renderStable = false;
    let prev = 0;
    let stableMs = 0;
    let waitedMs = 0;
    renderStableTimer = setInterval(async () => {
        if (warm || warmupTimedOut || shutdownRequested) {
            clearInterval(renderStableTimer);
            renderStableTimer = null;
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
            renderStable = true;
            stageLog('RENDER_STABLE_PASS', `waited_ms=${waitedMs}`);
            clearInterval(renderStableTimer);
            renderStableTimer = null;
            return;
        }
        if (waitedMs >= RENDER_STABLE_TIMEOUT_MS) {
            // Render-stable gate failed; do not block forever. TCP probe is the
            // final signal, but we note the failure on stderr.
            log(`WARNING: editor log keeps producing D3D12 swap_chain_resize errors; render-stable gate failed. Warmup will rely on TCP probe only.`);
            stageLog('RENDER_STABLE_FAIL', `waited_ms=${waitedMs} (gate bypassed, falling back to TCP probe)`);
            renderStable = true; // unblock warmup; npx will fail if the editor is truly dead
            clearInterval(renderStableTimer);
            renderStableTimer = null;
        }
    }, RENDER_SAMPLE_MS);
}

// SEE-1077: independent lease monitor. Watches EDITOR_LOG_FILE for the exact
// "exiting editor to release the port" line; on match, takes the existing T4
// path (rejectQueue + warmupDiagnostic('failed_exit') + process.exit(1)) to
// bypass the 360s RECOVERING window.
//
// Decoupled from startRenderStableMonitor (which clearInterval's at WARM): a
// lease self-exit can fire AFTER the editor went warm. Tracks a file offset so
// stale lines from a previous editor run cannot false-positive a fresh proxy.
// No-op when EDITOR_LOG_FILE is empty — keeps existing SEE-1070 tests (which
// never pass this env) GREEN without modification.
let leaseTimer = null;
let leaseOffset = 0;
function startLeaseMonitor() {
    if (leaseTimer) { clearInterval(leaseTimer); leaseTimer = null; }
    if (!EDITOR_LOG_FILE) return;
    // Seed offset to the current file size on start. Lines that pre-date this
    // proxy run (a prior editor's death, e.g. a crashed previous session)
    // must NOT fast-fail us — that's the whole point of offset tracking.
    leaseOffset = 0;
    stat(EDITOR_LOG_FILE)
        .then((st) => { leaseOffset = st.size; })
        .catch(() => { leaseOffset = 0; })
        .finally(() => {
            leaseTimer = setInterval(() => {
                if (shutdownRequested || warmupTimedOut) {
                    clearInterval(leaseTimer);
                    leaseTimer = null;
                    return;
                }
                checkLeaseTail();
            }, LEASE_POLL_INTERVAL_MS);
        });
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
async function checkLeaseTail() {
    if (!EDITOR_LOG_FILE || shutdownRequested || warmupTimedOut) return;
    let st;
    try {
        st = await stat(EDITOR_LOG_FILE);
    } catch {
        // File missing or unreadable — log not yet created by the launcher.
        // Stay quiet; the warmup timeout / TCP probe will catch a truly dead
        // editor on its own. Reset offset so a fresh file (size shrinks, e.g.
        // rotation) doesn't make us scan from byte 0 in the middle of old data.
        leaseOffset = 0;
        // SEE-1110 §6: sticky degradation signal. The log is unreadable for the
        // whole run (never became available), so hint text explains the stage
        // track is incomplete and other hints don't overstate log-based facts.
        if (KOL_PROGRESS_PROTOCOL !== 'off' && !logTailUnavailableSince) {
            logTailUnavailableSince = Date.now();
        }
        return;
    }
    if (KOL_PROGRESS_PROTOCOL !== 'off') logTailAvailable = true;
    if (st.size < leaseOffset) {
        // File was truncated/rotated; reset and scan only the new content.
        leaseOffset = 0;
    }
    if (st.size === leaseOffset) return;
    let fd;
    try {
        fd = await readFile(EDITOR_LOG_FILE, 'utf-8');
    } catch {
        return;
    }
    const slice = fd.slice(leaseOffset);
    leaseOffset = st.size;
    if (KOL_PROGRESS_PROTOCOL !== 'off') scanTailStages(slice);
    if (slice.indexOf(LEASE_EXITING_LINE) !== -1) {
        // Editor lease self-exit detected. Take the T4 FAILED_EXIT path so the
        // buffered calls get a structured retry error. SEE-1240 WS-5: under the
        // default rearm policy the proxy survives and re-arms in-band (legacy
        // process.exit(1) under KOL_GIVEUP_REARM=0). Same T3 drop-no-replay
        // semantics as a sustained-probe FAILED_EXIT: drop buffered w/ retry.
        clearInterval(leaseTimer);
        leaseTimer = null;
        if (KOL_PROGRESS_PROTOCOL !== 'off') leaseExitDetected = true;
        log(`ERROR: lease death detected in editor log ('${LEASE_EXITING_LINE}'); rejecting ${pendingCalls.length} buffered call(s) and ${GIVEUP_REARM_ENABLED ? 're-arming in-band (WS-5)' : 'exiting'}.`);
        rejectQueue(`editor lease expired; exiting to release port`, warmupDiagnostic('failed_exit'));
        if (GIVEUP_REARM_ENABLED) {
            warmupTimedOut = false;
            beginWarmEditorRespawn();
            giveUpAndRearm('lease_exit', LEASE_EXITING_LINE);
        } else {
            warmupTimedOut = true;
            process.exit(1);
        }
    }
}

// SEE-1110 B1 (§2.2/§2.3): stage-milestone parser mounted on the SAME
// lease/render-stable tail (stat + offset, no new polling). Scans only the new
// lines since the last read — strictly post-spawn content, so stale lines from a
// previous editor run can never advance the stage. Patterns are anchored at line
// start `^\[godot-mcp\] ` (with `m` flag — slices are multi-line, §2.3); each
// stage fires once and records its first-seen timestamp. A second TCP_RECEIVED
// is the slot-competition fingerprint (§3.3) — it indicates the first handshake
// was swallowed by the incumbent client.
// The scan itself is delegated to the pure module (warmup-stage-parser.mjs,
// unit-tested in isolation); the proxy just diffs the returned snapshot against
// its mutable state and fires notifications on stage advance.
function scanTailStages(slice) {
    const next = scanStageLines(
        { stage, timestamps: stageTimestamps, tcpReceivedCount },
        slice,
        Date.now()
    );
    const stageAdvanced = next.stage !== stage;
    // Copy any newly-observed milestone timestamps (fire-once: only fill nulls).
    for (const s of STAGE_ENUM) {
        if (next.timestamps[s] !== null && stageTimestamps[s] === null) {
            stageTimestamps[s] = next.timestamps[s];
            // SEE-1152: machine-greppable first-observation log per milestone.
            // PLUGIN_INIT/SERVER_LISTENING/TCP_CONNECTED/WS_HANDSHAKE all land here.
            if (s !== 'WARM' && s !== 'LAUNCHER_EXEC' && s !== 'EDITOR_SPAWNED') {
                stageLog(`MILESTONE_${s}`, `elapsed_ms=${stageTimestamps[s] - (spawnStartedAt || startedAt)}`);
            }
        }
    }
    if (stageAdvanced) {
        stage = next.stage;
        maybeNotifyStageChange();
    }
    tcpReceivedCount = next.tcpReceivedCount;
}

// Resolve the worktree the proxy should spawn the editor against. The launcher
// (godot-mcp-launcher.sh) runs the marker resolution layer (resolve_worktree_root
// → _resolve_via_runtime_registry, PR #496-#499) and exports its result as
// KOL_WORKTREE / KOL_PROJECT_GODOT. That env value IS the marker layer's output
// (路径 A). The proxy must treat it as the SOLE authoritative worktree source.
//
// SEE-1129 路径 B 统一 (sub-step b3c94ed8): the prior version of this resolver
// silently fell back to a cwd down-search / script-dir up-walk when KOL_WORKTREE
// was unset or its stat failed. That fallback was the dual worktree-resolution
// path (路径 B) that drifted off the marker result: on Archi's real machine the
// spawn target landed on a residual same-agent slot (c508560b) instead of this
// task's marker-resolved slot (7a634b21). The marker layer never agreed to
// that — the proxy just independently re-resolved and could land elsewhere.
//
// Fix: when the launcher handed us a marker-derived worktree, trust it as
// mandatory. If its path does not (yet) exist on disk (daemon lazy-provision
// race), surface worktree_unresolved loudly so the operator sees the gap —
// never silently substitute a different worktree found by walking the fs. The
// cwd/script-dir walk is now a LAST-RESORT used only when NO env anchor exists
// (direct/manual proxy run with no launcher in the parent chain).
// SEE-1170 通道 3: proxy-side stale-registration prune. When the mandatory
// anchor stat fails, the cause is often a bare-repo worktree registration whose
// target directory no longer exists (daemon Defect 2 residue) — `git worktree
// prune` on the bare repo clears exactly those. Bounded: at most ONE prune per
// proxy process (hasPrunedBareRepo) so a daemon retry storm cannot cascade prune
// calls; 5s timeout, non-fatal (any non-zero exit / timeout only logs).
// Observability goes into the warmupDiagnostic structured field (proxy stderr is
// occupied by MCP JSON-RPC under the B1 lazy-load architecture).
// Explicitly NOT a claim to prevent the Defect 1 first failure — this only
// shortens the residue window after a failure has already happened.
let hasPrunedBareRepo = false;
let lastBareRepoPruneDiag = null;

function deriveBareRepoFromAnchor(anchorPath) {
    // anchor = <...>/workdir/<repo>[/<nested>] — the .git file next to the repo
    // root points at <bare>/worktrees/<slot>. Walk up looking for a .git FILE
    // (worktree marker), read its gitdir, strip /worktrees/<name>.
    let dir = anchorPath;
    for (let i = 0; i < 5 && dir && dir !== path.dirname(dir); i++) {
        const gitFile = path.join(dir, '.git');
        try {
            const raw = readFileSync(gitFile, 'utf8').trim();
            const m = raw.match(/^gitdir:\s*(.+)$/);
            if (m) {
                const gitdir = m[1];
                // gitdir = <bare>/worktrees/<name>; we want <bare>.
                const wtIdx = gitdir.lastIndexOf('/worktrees/');
                if (wtIdx > 0) return gitdir.slice(0, wtIdx);
                if (gitdir.endsWith('.git')) return gitdir;
            }
        } catch { /* not here — keep walking */ }
        dir = path.dirname(dir);
    }
    return null;
}

async function tryPruneBareRepo(bareRepo) {
    if (!bareRepo) {
        lastBareRepoPruneDiag = { attempted: false, reason: 'bare_repo_unresolved' };
        stageLog('b0Prune', 'prune skipped: bare repo unresolved');
        return;
    }
    if (hasPrunedBareRepo) {
        lastBareRepoPruneDiag = { attempted: false, reason: 'already_pruned' };
        return;
    }
    hasPrunedBareRepo = true;
    const startedAt = Date.now();
    const outcome = await new Promise((resolve) => {
        const child = spawn('git', ['-C', bareRepo, 'worktree', 'prune'], {
            stdio: ['ignore', 'ignore', 'ignore'],
            detached: false,
        });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve('timeout');
        }, 5000);
        child.on('error', () => { clearTimeout(timer); resolve('spawn_error'); });
        child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? 'ok' : `exit_${code}`); });
    });
    lastBareRepoPruneDiag = {
        attempted: true,
        bareRepo,
        outcome,
        durationMs: Date.now() - startedAt,
    };
    stageLog('b0Prune', `git worktree prune (${bareRepo}) -> ${outcome} in ${lastBareRepoPruneDiag.durationMs}ms`);
}

// SEE-1170 通道 3: on anchor stat failure, prune the bare repo once, then
// retry the stat before giving up. Returns { recovered, anchor }:
//   recovered=true  — stat succeeded after prune (对症: stale registration was
//                     the cause; keep this fact for the diagnostic)
//   recovered=false — still failing after prune (病因不明: explicitly recorded)
async function pruneThenRestat(anchorPath) {
    const bareRepo = deriveBareRepoFromAnchor(anchorPath);
    await tryPruneBareRepo(bareRepo);
    try {
        await stat(anchorPath);
        lastBareRepoPruneDiag = { ...lastBareRepoPruneDiag, statAfterPrune: 'recovered' };
        stageLog('b0Prune', `stat recovered after prune (${anchorPath})`);
        return { recovered: true, anchor: anchorPath };
    } catch (e) {
        lastBareRepoPruneDiag = {
            ...lastBareRepoPruneDiag,
            statAfterPrune: 'still_failing',
            statError: e.code || e.message,
        };
        stageLog('b0Prune', `stat still failing after prune (${anchorPath}: ${e.code || e.message}) — cause unclear`);
        return { recovered: false, anchor: null };
    }
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
async function resolveWorktreeForSpawn() {
    // Marker anchor (KOL_PROJECT_GODOT wins — it also anchors the lease sidecar
    // path, so the two can never diverge). stat() must succeed; on failure we do
    // NOT fall through to fs discovery — that is exactly the 路径 B drift.
    if (process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT) {
        try { await stat(process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT); return path.dirname(process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT); }
        catch (e) {
            log(`resolveWorktreeForSpawn: marker anchor KOL_PROJECT_GODOT=${process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT} stat failed (${e.code || e.message}); attempting SEE-1170 bare-repo prune before giving up.`);
            const r = await pruneThenRestat(process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT);
            if (r.recovered) return path.dirname(process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT);
            log(`resolveWorktreeForSpawn: KOL_PROJECT_GODOT stat still failing after prune; refusing to drift to another worktree.`);
            return null;
        }
    }
    if (process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE) {
        try { await stat(process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE); return process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE; }
        catch (e) {
            log(`resolveWorktreeForSpawn: marker anchor KOL_WORKTREE=${process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE} stat failed (${e.code || e.message}); attempting SEE-1170 bare-repo prune before giving up.`);
            const r = await pruneThenRestat(process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE);
            if (r.recovered) return process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE;
            log(`resolveWorktreeForSpawn: KOL_WORKTREE stat still failing after prune; refusing to drift to another worktree.`);
            return null;
        }
    }

    // No env anchor at all (direct proxy run, no launcher parent). Only then is
    // fs discovery justified — and it still refuses the shared master checkout.
    const cwd = process.cwd();
    try {
        for (const entry of await readdir(cwd)) {
            if (entry.startsWith('.')) continue;
            const sub = path.join(cwd, entry);
            let st;
            try { st = await stat(sub); } catch { continue; }
            if (!st.isDirectory()) continue;
            if (await isGodotWorktree(sub)) return sub;
        }
    } catch { /* cwd unreadable — fall through */ }

    let dir = scriptDir();
    for (let i = 0; i < 16 && dir && dir !== path.dirname(dir); i++) {
        if (await isGodotWorktree(dir)) return dir;
        dir = path.dirname(dir);
    }
    return null;
}

// SEE-1111 §7.1 防线 3: the SHARED D-drive master checkout is read-only for
// agents. If worktree resolution still lands there (a misconfigured launcher,
// a manual run, or a regression), fail fast with a structured diagnostic so the
// agent never rewrites the shared project.godot. Mirrors the write-target guard
// in configure-mcp-port.sh at resolution time.
// §4.5.3 T2 / K5: env-overridable; empty default = probe-failure fallback.
const SHARED_MASTER_WORKTREE = process.env.GODOT_MCP_SHARED_MASTER || '';

function isSharedMasterWorktree(worktree) {
    // AC-M3REORG-011: empty SHARED_MASTER_WORKTREE (K5 probe-failure default)
    // must guard NOTHING — '' + '/' makes startsWith('/') true for every
    // absolute path, fail-closing every worktree as "shared master" (the JS
    // twin of the shell _is_shared_master empty-guard added in T2-M1; this
    // copy was missed in that sync — Revy 串行测 1/3 caught it).
    if (!worktree || !SHARED_MASTER_WORKTREE) return false;
    return worktree === SHARED_MASTER_WORKTREE
        || worktree.startsWith(SHARED_MASTER_WORKTREE + '/');
}

// True when `dir` is a Godot project root: has project.godot AND the
// godot-mcp launch toolchain (proving it is the agent's KingOfLikes-Godot
// checkout, not an unrelated Godot project).
//
// §4.5.3 T2 / K3 multi-location probe — accept every real layout the toolchain
// can run from, so worktree resolution never falls through onto the shared
// master:
//   (a) repo-root launch/   — standalone install / fork-as-addon at project root
//   (b) .dev/godot-mcp/launch — legacy KOL layout (transition window)
//   (c) addons/godot_mcp/launch — post-T4 KOL: addon+launch mounted as a
//       submodule under <project>/addons/godot_mcp
// Each is a separate marker; the probe is Monotone (any one suffices, none =
// not a godot-mcp worktree).
async function isGodotWorktree(dir) {
    try {
        await stat(path.join(dir, 'project.godot'));
        const inRepo = await stat(path.join(dir, 'launch')).catch(() => null);
        const legacy = await stat(path.join(dir, '.dev', 'godot-mcp', 'launch')).catch(() => null);
        const submod = await stat(path.join(dir, 'addons', 'godot_mcp', 'launch')).catch(() => null);
        return Boolean(inRepo || legacy || submod);
    } catch {
        return false;
    }
}

// SEE-1129 (instance selection layer): the worktree sidecar written by
// start-godot-editor.sh at spawn time. Ports are allocated per agent NAME
// (agent-ports.json), so a same-agent concurrent session slot resolves to the
// SAME port+LABEL. When this proxy's ensureEditor() finds the port busy it
// would otherwise adopt the holder's Godot instance — which has the HOLDER's
// project open — and serve the wrong worktree (godot_project get_info returns
// the holder's path, not this slot's). The sidecar records the exact worktree
// the holder editor opened, so the reuse path can detect a foreign holder.
// Returns the trimmed path string, or null when the sidecar is absent/empty
// (older holder, manual launch, or the editor self-exited and cleaned up).
function holderWorktreeSidecarPath() {
    // GODOT_EDITOR_LOG_FILE is `${dir}/godot-editor-<LABEL>.log`; the sidecar
    // mirrors that basename with a .worktree suffix. When the env is unset
    // (direct proxy run) there is no sidecar to consult — reuse proceeds.
    if (!EDITOR_LOG_FILE) return null;
    return EDITOR_LOG_FILE.replace(/\.log$/, '.worktree');
}

async function readHolderWorktree() {
    const sidecar = holderWorktreeSidecarPath();
    if (!sidecar) return null;
    try {
        const raw = await readFile(sidecar, 'utf8');
        const v = raw.trim();
        return v.length > 0 ? v : null;
    } catch {
        return null;
    }
}

// SEE-1129 principle #1/#2 (Owner's three principles): the reuse decision is
// AGENT-scoped, not worktree-scoped. Ports are allocated per agent NAME, so a
// holder on this proxy's GODOT_PORT is, by construction, the SAME agent — and
// same-agent MUST reuse (principle #1/#2), never error. Cross-agent contention
// (principle #5) only arises on a misconfigured/duplicate port mapping. The
// holder's agent name lives in ITS worktree's lease sidecar
// (<holderWorktree>/.godot/mcp-lease.json field "agent"). Resolve the holder
// worktree via the MULTICA_DIR .worktree sidecar, then read its lease. Returns
// null when unverifiable (no .worktree sidecar, holder worktree missing, lease
// absent/malformed) — the predicate treats null as "reuse" for back-compat.
async function readHolderAgent() {
    const holderWorktree = await readHolderWorktree();
    if (!holderWorktree) return null;
    try {
        const raw = await readFile(path.join(holderWorktree, '.godot', 'mcp-lease.json'), 'utf8');
        const lease = JSON.parse(raw);
        const a = typeof lease.agent === 'string' ? lease.agent.trim() : '';
        return a.length > 0 ? a : null;
    } catch {
        return null;
    }
}

// Build args for configure / start helpers: [agent-name?] --port <GODOT_PORT>
// <extra...>. Passing --port explicitly makes the port deterministic even when
// the launcher was driven by --port override rather than KOL_AGENT_NAME.
function buildHelperArgs(extra) {
    const args = [];
    const agentName = process.env.GODOT_MCP_AGENT_NAME || process.env.KOL_AGENT_NAME || '';
    if (agentName) args.push(agentName);
    args.push('--port', String(GODOT_PORT));
    args.push(...extra);
    return args;
}

// SEE-1292 respawn fix: read {state, port} from a worktree's lease sidecar
// (.godot/mcp-lease.json). Returns null when absent/unreadable — the caller
// treats that as "not active" and reactivates via configure.
async function readWorktreeLeaseState(worktree) {
    try {
        const raw = await readFile(path.join(worktree, '.godot', 'mcp-lease.json'), 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return { state: parsed.state, port: parsed.port };
    } catch {
        return null;
    }
}

// Run a bash helper script fully detached from the MCP stdio pipes. The proxy's
// stdin/stdout carry JSON-RPC; any stray byte from a child corrupts the
// handshake (SEE-1045). stdin/stdout are ignored; stderr is captured (tail
// kept) for spawn_failed diagnostics. env inherits KOL_AGENT_NAME / KOL_WORKTREE
// / KOL_PROJECT_GODOT / GODOT_PORT from the launcher. Returns
// { rc, stderrTail, stderrFull }. stderrTail is truncated to
// DIAGNOSTIC_STDERR_TAIL for the JSON payload; stderrFull is the complete
// stream (no truncation) and is what gets persisted to disk by
// persistSpawnStderr — the truncation exists only because the daemon does not
// store the tool_result payload, so a fat stderr there is wasted anyway.
function runScript(scriptPath, args) {
    return new Promise((resolve) => {
        let stderrTail = '';
        let captured = 0;
        const child = spawn('bash', [scriptPath, ...args], {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: { ...process.env },
        });
        if (child.stderr) {
            child.stderr.on('data', (chunk) => {
                const s = typeof chunk === 'string' ? chunk : chunk.toString();
                stderrTail += s;
                captured += s.length;
                // SEE-1152: forward child-script stage lines (configure/start/prepare)
                // onto the proxy's own stderr so a single log captures the whole
                // cold-start timeline. Lines already carry their own [component]
                // prefix (e.g. [configure-mcp-port]) and [stage=...] tokens, so
                // we pass them through untouched rather than re-wrapping.
                if (STAGE_LOG_ENABLED && s.includes('[stage=')) {
                    for (const line of s.split('\n')) {
                        if (line.includes('[stage=')) process.stderr.write(line + '\n');
                    }
                }
            });
        }
        child.on('error', (err) => {
            const msg = `spawn error: ${err.message}`;
            resolve({ rc: -1, stderrTail: msg, stderrFull: msg });
        });
        child.on('close', (code) => {
            const tail = captured > DIAGNOSTIC_STDERR_TAIL
                ? stderrTail.slice(-DIAGNOSTIC_STDERR_TAIL)
                : stderrTail;
            resolve({ rc: code ?? -1, stderrTail: tail, stderrFull: stderrTail });
        });
    });
}

// SEE-1164 改进 1: persist the FULL (un-truncated) stderr of a failing helper
// to ~/.multica/godot-editor/<runtime_id>.stderr.log so post-mortem analysis
// can read the exact die message + stage lines (PORT_PROBE_BEGIN/END etc.) that
// the daemon's `tool_result observed` line never stores. Path mirrors
// kol_lifecycle_path (runtime.lib.sh §L68): non-solo runtime_ids resolve to
// the per-slot directory form; an empty KOL_RUNTIME_ID (manual invocation)
// falls back to `unknown.stderr.log` rather than writing into the shared flat
// name (per-slot isolation beats conflation). Best-effort: any fs error is
// logged to proxy stderr, never thrown — the SpawnError must still propagate
// to the agent.
async function persistSpawnStderr(source, rc, stderrFull) {
    if (!stderrFull) return;
    try {
        const dir = path.join(GODOT_MCP_HOME, 'godot-editor');
        await mkdir(dir, { recursive: true });
        const rid = process.env.GODOT_MCP_RUNTIME_ID || process.env.KOL_RUNTIME_ID || 'unknown';
        const file = path.join(dir, `${rid}.stderr.log`);
        const iso = new Date().toISOString();
        const block = `\n===== [${iso}] source=${source} rc=${rc} runtime_id=${rid} port=${GODOT_PORT} =====\n${stderrFull}\n`;
        await appendFile(file, block, 'utf8');
        log(`persisted helper stderr to ${file} (source=${source} rc=${rc}, ${stderrFull.length} chars)`);
    } catch (err) {
        console.error(`[godot-mcp-proxy] persistSpawnStderr failed (source=${source}): ${err && err.message}`);
    }
}

// Trigger the editor spawn at most once; concurrent callers share the promise.
// The trigger fires on the first tools/call after COLD_EMPTY. Spawn success/
// failure is handled here (not at the call site) so the call site stays sync.
function triggerEnsureEditor() {
    if (spawnInFlight) return spawnInFlight;
    const t0 = Date.now();
    stageLog('ENSURE_EDITOR_BEGIN', `attempt=${spawnAttempts + 1}`);
    spawnInFlight = ensureEditor(t0)
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
        .finally(() => { spawnInFlight = null; });
    return spawnInFlight;
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
    if (warmRespawnInFlight) return;
    warmRespawnInFlight = true;
    warmEditorDead = true;
    warm = false;
    recovering = false;
    renderStable = false;
    spawnTriggered = false;
    warmupTimeoutMs = null;
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
    renderStable = false;
    warmupTimeoutMs = null;
    lastSpawnReused = false;
    for (const s of STAGE_ENUM) stageTimestamps[s] = null;
    stageTimestamps.LAUNCHER_EXEC = startedAt;
    tcpReceivedCount = 0;
    firstProbeOkAt = 0;   // WS-7: fresh round re-measures the bind delay
    // 缺陷 #8: a fresh spawn round gets a fresh liveness-failure counter (the
    // probe fires again only once the new editor re-warms).
    warmProbeFailures = 0;
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
    restartHold = hold;
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
    if (restartHold === hold) restartHold = null;
    sendToClaude({
        jsonrpc: '2.0',
        id: hold.id,
        result: {
            content: [{ type: 'text', text: JSON.stringify(result) }],
        },
    });
    log(`restart: answered held restart id=${hold.id} -> ${JSON.stringify(result)}.`);
    if (result.restarted) {
        if (pendingCalls.length > 0) {
            log(`restart: flushing ${pendingCalls.length} call(s) held during the restart window.`);
            flushQueue();
        }
    } else {
        // Reject each held call with a retryable diagnostic and drop its per-id
        // trackers (the call was never forwarded during the window, so no npx
        // response will come to clear them).
        while (pendingCalls.length > 0) {
            const heldLine = pendingCalls.shift();
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
    while (!shutdownRequested && Date.now() < hold.deadline) {
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
                warm = true;
                warmAt = Date.now();
                warmEditorDead = false;
                log(`restart: relaunched editor detected warm on ${GODOT_HOST}:${GODOT_PORT}; waiting for godot-mcp CLI to reconnect.`);
                // Stop probing (the slot belongs to the CLI now) and wait for the
                // CLI's own reconnect signal, exactly like the warmup flush gate.
                while (!shutdownRequested && Date.now() < hold.deadline) {
                    if (npxCliConnected || !cliConnectSignalExpected()) {
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

// SEE-1148 P2 (§2.3 reuse/evict decision tree): when a port is busy, the
// ACTION the proxy takes is decided by the port-arbiter bash lib — the single
// source of truth for the OS-level probe (/dev/tcp / PowerShell) + the PID
// liveness rule (kill -0 + /proc/<pid>/exe node, anti PID-reuse). The lib
// prints ONE verdict; the proxy maps it to the decision-tree action:
//   free         → fall through to spawn (port actually grantable)
//   reuse        → PID alive, same runtime → hot takeover (probe ESTABLISHED /
//                  QUIT_DELAY, bounded by PORT_TAKEOVER_TIMEOUT_MS)
//   respawn      → PID dead, same runtime id → wait-for-release within the
//                  respawn window (backoff×2); evict only if the window
//                  expires — never mis-kill our own re-appearing editor
//   evict        → PID dead, runtime id mismatch/missing → immediate evict
//                  (kill editor, cold-start), NO 300s wait
//   busy_foreign → PID alive, different runtime → editor_busy retryable
// KOL_PORT_ARBITER=off disables the tree and restores the legacy SEE-1129
// sidecar-guard behavior (operator escape hatch / test seam).
const PORT_ARBITER_ENABLED = (process.env.GODOT_MCP_PORT_ARBITER || process.env.KOL_PORT_ARBITER || 'on') !== 'off';
const PORT_ARBITER_LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'port-arbiter.lib.sh');
const PORT_RESPAWN_WINDOW_MS = parseInt(process.env.GODOT_MCP_RESPAWN_WINDOW_MS || process.env.KOL_RESPAWN_WINDOW_MS || '8000', 10);
const PORT_TAKEOVER_TIMEOUT_MS = parseInt(process.env.GODOT_MCP_TAKEOVER_TIMEOUT_MS || process.env.KOL_TAKEOVER_TIMEOUT_MS || '300000', 10);
const PORT_PROBE_INTERVAL_MS = parseInt(process.env.GODOT_MCP_PORT_PROBE_INTERVAL_MS || process.env.KOL_PORT_PROBE_INTERVAL_MS || '1000', 10);

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
    spawnAttempts += 1;
    // (1) probe short-circuit: port already listening => someone (a prior
    //     editor, a concurrent proxy) holds it; do NOT spawn (design §6/T2).
    //     The warmupLoop then classifies hot and reuses it. SEE-1091: even on
    //     the reuse path the agent port must be re-pinned in project.godot (the
    //     stop hook sanitized it), so configure runs here too — idempotent fast
    //     path, non-fatal on failure since the editor is already live.
    if (await tcpProbe()) {
        stageLog('TCP_PROBE_SHORTCIRCUIT', `port=${GODOT_PORT}`);
        // SEE-1148 P2 (§2.3): consult the reuse/evict decision tree FIRST. The
        // arbiter verdict (PID liveness + runtime-id match, /dev/tcp probed)
        // selects the action; the legacy SEE-1129 sidecar guard is the
        // fallback when the arbiter is unavailable ('legacy').
        const arbT0 = Date.now();
        const verdict = await arbiterDecide(GODOT_PORT);
        stageLog('ARBITER_VERDICT', `verdict=${verdict} dt_ms=${Date.now() - arbT0}`);
        if (verdict === 'evict') {
            // PID dead + runtime id mismatch/missing: cross-runtime stale
            // holder. Immediate evict (kill editor, cold-start), NO wait.
            log(`port ${GODOT_PORT} held by a DEAD cross-runtime proxy (runtime id mismatch); immediate evict then cold-start (no 300s wait).`);
            await evictStaleHolder(await readHolderWorktree());
            // fall through to spawn below.
        } else if (verdict === 'respawn') {
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
                await evictStaleHolder(await readHolderWorktree());
                // fall through to spawn below.
            }
        } else if (verdict === 'reuse') {
            // PID alive + SAME runtime: hot takeover. Wait for the holder to
            // release (ESTABLISHED change / QUIT_DELAY), bounded by the 300s
            // takeover timeout, then spawn if freed.
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
            // runtime legitimately owns the port; do NOT evict a live holder.
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
            lastSpawnReused = true;
            spawnLastFailed = false; // a successful port reuse clears the failure latch too
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
    lastSpawnReused = false;
    spawnLastFailed = false; // a successful spawn clears the failure latch (预热提示 误报防护)
    return { spawned: true, worktree, configureRc: configureRes.rc, startRc: startRes.rc };
}

// Map a SpawnError to the warmupDiagnostic-style data object attached to the
// spawn_failed error response. retryable is always true for non-terminal (the
// failure is usually transient: port clash, transient binary miss); false for
// terminal (streak exhausted). See design §7.
function spawnFailedDiagnostic(bucket, err, terminal) {
    const now = Date.now();
    const e = err || {};
    return {
        state: terminal ? 'spawn_failed_terminal' : 'spawn_failed',
        bucket,
        host: GODOT_HOST,
        port: GODOT_PORT,
        spawnAttempts,
        configureRc: e.configureRc ?? null,
        startRc: e.startRc ?? null,
        spawnStderr: e.startStderr || e.configureStderr || (e.message ? String(e.message) : ''),
        worktree: e.worktree !== undefined ? e.worktree : null,
        elapsedMs: now - startedAt,
        retryable: !terminal,
    };
}

// Handle a spawn failure: count the bucket streak; on terminal streak reject
// all buffered calls and lock the proxy into SPAWN_FAILED_TERMINAL; otherwise
// reject the calls buffered during this attempt with a spawn_failed diagnostic
// and reset spawnTriggered so the next tools/call re-triggers. warmupLoop's
// main loop sees spawnTriggered flip false and returns to COLD_EMPTY idle.
function handleSpawnFailure(err) {
    const bucket = (err && err.bucket) || 'spawn_failed_exception';
    spawnFailedStreak = (bucket === spawnFailedBucket)
        ? spawnFailedStreak + 1
        : 1;
    spawnFailedBucket = bucket;
    log(`ERROR: editor spawn failed (bucket=${bucket}, attempt=${spawnAttempts}, streak=${spawnFailedStreak}): ${err.message}`);
    spawnLastError = err;
    if (spawnFailedStreak >= SPAWN_MAX_ATTEMPTS) {
        // Give-up (terminal streak). The fail-fast first-report: held calls are
        // answered with the terminal diagnostic (shape unchanged from B1).
        rejectQueue(
            `editor spawn kept failing (${bucket}); giving up this run — restart the MCP server to retry`,
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
            spawnTerminal = true;
            spawnLastFailed = true;
        }
        return;
    }
    // SEE-1111 预热提示: non-terminal failure. Latched so the next tools/call
    // surfaces the real spawn_failed diagnostic (误报防护) instead of a friendly
    // "warming" hint — the agent must learn the spawn broke, not that the editor
    // is merely booting. Cleared on the next successful spawn attempt.
    spawnLastFailed = true;
    rejectQueue(
        `editor spawn failed: ${bucket}; will retry on next call`,
        spawnFailedDiagnostic(bucket, err, false),
    );
    spawnTriggered = false;
    spawnInFlight = null;
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
    spawnTerminal = false;
    giveUpCount += 1;
    giveUpBackoffMs = giveUpCount === 1
        ? GIVEUP_BASE_COOLDOWN_MS
        : Math.min(giveUpBackoffMs * 2, GIVEUP_MAX_COOLDOWN_MS);
    giveUpArmedAt = Date.now();
    giveUpLastReason = `${bucket}: ${message}`;
    spawnLastFailed = true;    // 首报保留: next call sees the real terminal error
    spawnTriggered = false;    // re-arm: next call re-enters warmup (after cooldown)
    spawnInFlight = null;
    recovering = false;        // T4 callers enter from RECOVERING; the re-armed round must not inherit it
    warmupTimedOut = false;    // ditto — the FAILED_EXIT latch must not block the re-armed round's tools/call
    warmupTimeoutMs = null;    // fresh spawn round re-classifies cold/hot
    // The re-armed round continues INSIDE the current warmupLoop invocation (the
    // T4 sites break the probe loop, not the function), so the render-stable
    // monitor must be restarted here — its interval was cleared at WARM/exit and
    // renderStable must be re-proven before the next flush gate opens.
    renderStable = false;
    startRenderStableMonitor();
    persistGiveUpStatus('give_up', bucket, message);
    log(`give-up #${giveUpCount} recorded (bucket=${bucket}); re-armed — cooldown ${Math.floor(giveUpBackoffMs / 1000)}s before the next attempt (WS-5).`);
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
            updated_at: new Date().toISOString(),
            giveup_count: giveUpCount,
            last_event: event,
            last_bucket: bucket,
            last_reason: message,
            last_giveup_at: giveUpArmedAt ? new Date(giveUpArmedAt).toISOString() : null,
            backoff_ms: giveUpBackoffMs,
            cooldown_until: giveUpArmedAt ? new Date(giveUpArmedAt + giveUpBackoffMs).toISOString() : null,
        };
        const tmp = `${file}.tmp.${process.pid}`;
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
        renameSync(tmp, file);
        log(`persisted give-up status to ${file} (event=${event} count=${giveUpCount})`);
    } catch (err) {
        log(`WARNING: persistGiveUpStatus failed: ${err && err.message}`);
    }
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
        progressToken: firstCallProgressToken,
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
    if (firstCallProgressToken == null) return;
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
let stageNotified = '';
function maybeNotifyStageChange() {
    if (stageNotified === stage) return;
    stageNotified = stage;
    notifyStageChange();
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
async function warmupLoop() {
    startRenderStableMonitor();

    // SEE-1085 (B1): the editor is NOT spawned at proxy start. Until the first
    // tools/call flips spawnTriggered, an empty port is EXPECTED, not a failure
    // — so no timeout clock runs in COLD_EMPTY. initialize / tools/list are
    // answered by npx immediately and never enter this loop's body. The outer
    // loop lets a non-terminal spawn failure (spawnTriggered reset to false)
    // return to idle so the next tools/call re-triggers the spawn.
    while (!warm && !warmupTimedOut && !shutdownRequested && !spawnTerminal) {
        // COLD_EMPTY: idle-probe until the first tools/call triggers spawn.
        while (!spawnTriggered && !shutdownRequested && !spawnTerminal) {
            maybeProgressLog();
            await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
        }
        if (shutdownRequested || spawnTerminal) break;

        // The first call just flipped spawnTriggered. Start the warmup clock
        // here (not at proxy start) so a cold boot gets the full window.
        if (spawnStartedAt === 0) {
            spawnStartedAt = Date.now();
            // SEE-1110 §7: EDITOR_SPAWNED(1) is proxy-set at first spawn (the
            // addon is not running yet, so no log line exists for this stage).
            stageTimestamps.EDITOR_SPAWNED = spawnStartedAt;
        }

        // Classify cold vs hot AFTER spawn is triggered: if the port is already
        // listening a prior/concurrent editor holds it (hot, short window); else
        // cold boot (long window, 50-60s Godot start). Independent budgets so a
        // cold boot is not cut short by the hot window.
        if (warmupTimeoutMs === null && !shutdownRequested) {
            const initiallyReachable = await tcpProbe();
            warmupTimeoutMs = initiallyReachable ? HOT_WARMUP_TIMEOUT_MS : COLD_WARMUP_TIMEOUT_MS;
            if (KOL_PROGRESS_PROTOCOL !== 'off') coldMode = !initiallyReachable;
            stageLog('WARM_MODE', `mode=${initiallyReachable ? 'hot' : 'cold'} timeout_ms=${warmupTimeoutMs}`);
            log(
                `warmup mode: ${initiallyReachable ? 'hot' : 'cold'} `
                + `(editor ${initiallyReachable ? 'already listening' : 'not yet listening'}; `
                + `timeout ${Math.floor(warmupTimeoutMs / 1000)}s).`
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
        let lastTcpOkAt = spawnStartedAt;

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
        while (spawnTriggered && !warmFlushed && !warmupTimedOut && !shutdownRequested && !spawnTerminal) {
            if (warm) {
                // Editor warm, probe stopped (slot free). Wait for the CLI to
                // connect; bound the wait with the warmup timeout, then flush.
                const nowWait = Date.now();
                if (!recovering && (nowWait - spawnStartedAt) >= currentWarmupTimeout()) {
                    recovering = true;
                    recoveringEnteredAt = nowWait;
                    lastTcpOkAt = nowWait;
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
                if (recovering && (nowWait - recoveringEnteredAt) >= FAILED_EXIT_MS) {
                    log(`ERROR: warm+recovering did not recover within ${Math.floor(FAILED_EXIT_MS / 1000)}s (FAILED_EXIT); rejecting ${pendingCalls.length} buffered call(s).`);
                    rejectQueue(
                        `warm+recovering did not recover within ${Math.floor(FAILED_EXIT_MS / 1000)}s (FAILED_EXIT)`,
                        warmupDiagnostic('failed_exit'),
                    );
                    // SEE-1240 WS-5: in-band give-up + cooldown rearm (legacy exit
                    // under KOL_GIVEUP_REARM=0). Same flow as the cold T4 below.
                    if (GIVEUP_REARM_ENABLED) {
                        warmupTimedOut = false;
                        beginWarmEditorRespawn();
                        giveUpAndRearm('warm_recovering_failed_exit', 'warm+recovering FAILED_EXIT');
                        break;   // exit the warmFlushed loop; outer loop re-arms
                    }
                    warmupTimedOut = true;
                    process.exit(1);
                }
                // SEE-1134 RECOVERING deadlock fix #2: when the CLI dies while we
                // are warm+recovering, kill it so the existing npx.on('exit')
                // respawn machinery brings up a fresh one (bounded by the hot
                // restart budget). Without a kill we would wait forever on
                // npxCliConnected=true from a dead child.
                if (recovering && cliConnectSignalExpected() && !npxCliConnected) {
                    if (recoveringCliUnconnectedSince === 0) {
                        recoveringCliUnconnectedSince = nowWait;
                    } else if ((nowWait - recoveringCliUnconnectedSince) >= WARM_RECOVERING_CLI_TIMEOUT_MS
                        && npx && npxRunning && !npx.killed) {
                        log(`WARNING: warm+recovering CLI unconnected for ${Math.floor(WARM_RECOVERING_CLI_TIMEOUT_MS / 1000)}s; killing npx so the hot-respawn path can land one.`);
                        try { npx.kill('SIGTERM'); } catch (err) { log(`DEBUG: npx.kill raised ${err && err.message}`); }
                        recoveringCliUnconnectedSince = nowWait; // reset; the respawn gets another full window
                    }
                } else if (npxCliConnected) {
                    recoveringCliUnconnectedSince = 0;
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
                if (!cliConnectSignalExpected() || npxCliConnected) {
                    const now2 = Date.now();
                    if (recovering) {
                        log(`editor warm detected on ${GODOT_HOST}:${GODOT_PORT} after recovery; dropping ${pendingCalls.length} buffered call(s) with retry guidance.`);
                        rejectQueue('editor recovered after warmup timeout; please retry', warmupDiagnostic('recovered'));
                    } else {
                        maybeRejectUnreadyHeld();
                        log(`editor warm detected on ${GODOT_HOST}:${GODOT_PORT} and godot-mcp CLI connected; releasing ${pendingCalls.length} queued call(s).`);
                        stageLog('WARM_FLUSH', `path=recovering_connected queued=${pendingCalls.length} elapsed_ms=${Date.now() - (spawnStartedAt || startedAt)}`);
                        flushQueue();
                    }
                    recovering = false;
                    if (KOL_PROGRESS_PROTOCOL !== 'off') {
                        if (stageTimestamps.WARM === null) stageTimestamps.WARM = now2;
                        stage = 'WARM';
                        if (stageTimestamps.WS_HANDSHAKE !== null && stageTimestamps.MCP_INITIALIZED === null) {
                            stageTimestamps.MCP_INITIALIZED = now2;
                        }
                        warmupJustCompleted = true;
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
            const probeOk = await wsProbe();
            const now = Date.now();

            if (probeOk) {
                lastTcpOkAt = now;
                // WS-7: when the editor log is unavailable the SERVER_LISTENING
                // milestone never lands, so the grace-race guard would measure
                // nothing — record the FIRST successful probe as the bind time
                // proxy-side equivalent (a handshake probe proves the port is
                // bound RIGHT NOW).
                if (firstProbeOkAt === 0) firstProbeOkAt = now;
                if (renderStable) {
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
                    const gateOpen = lastSpawnReused
                        || !logTailAvailable
                        || (stageTimestamps.SERVER_LISTENING !== null
                            && stageTimestamps.WS_HANDSHAKE !== null);
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
                        const bindStart = stageTimestamps.SERVER_LISTENING ?? firstProbeOkAt ?? 0;
                        const bindDelayMs = (bindStart > 0 && stageTimestamps.EDITOR_SPAWNED !== null)
                            ? bindStart - stageTimestamps.EDITOR_SPAWNED
                            : (bindStart > 0 ? bindStart - (spawnStartedAt || startedAt) : 0);
                        if (GRACE_RACE_GUARD_ENABLED
                            && !lastSpawnReused
                            && !graceRaceGuardFired
                            && bindDelayMs > GRACE_RACE_BIND_MS
                            && spawnAttempts < SPAWN_MAX_ATTEMPTS) {
                            graceRaceGuardFired = true;
                            stageLog('GRACE_RACE_GUARD', `bind_delay_ms=${bindDelayMs} > ${GRACE_RACE_BIND_MS}; evicting slow-bind editor for a warm-cache respawn`);
                            log(`WARNING: editor bound after ${Math.floor(bindDelayMs / 1000)}s (addon grace would leave <${Math.max(0, 300 - Math.floor((now - (stageTimestamps.EDITOR_SPAWNED || now)) / 1000))}s for the client); evicting and respawning against the now-warm import cache (WS-7).`);
                            warm = false;          // undo the WARM transition above
                            warmFlushed = false;
                            graceRaceRespawn = true;
                            break;                 // exit the probe loop → grace-race respawn below
                        }
                        warm = true;
                        warmAt = now;
                        warmEditorDead = false; // post-warm respawn round re-proven live
                        // WS-7: a completed WARM re-arms the guard so a later
                        // post-warm respawn round (fresh editor, possibly cold
                        // import again) still gets race protection — while the
                        // one-shot within a single round still prevents loops.
                        graceRaceGuardFired = false;
                        pendingHandshake.clear();
                        stageLog('WARM', `elapsed_ms=${now - (spawnStartedAt || startedAt)} reused=${lastSpawnReused === true}`);
                        // SEE-1110 §2.1: WARM(7) is the final stage, reached exactly here.
                        if (KOL_PROGRESS_PROTOCOL !== 'off') {
                            if (stageTimestamps.WARM === null) stageTimestamps.WARM = now;
                            stage = 'WARM';
                            if (stageTimestamps.WS_HANDSHAKE !== null
                                && stageTimestamps.MCP_INITIALIZED === null) {
                                stageTimestamps.MCP_INITIALIZED = now;
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
                        if (!cliConnectSignalExpected() || (lastSpawnReused && npxCliConnected)) {
                            maybeRejectUnreadyHeld();
                            log(`editor warm detected on ${GODOT_HOST}:${GODOT_PORT} (hot reuse); releasing ${pendingCalls.length} queued call(s).`);
                            stageLog('WARM_FLUSH', `path=hot_reuse queued=${pendingCalls.length} elapsed_ms=${Date.now() - (spawnStartedAt || startedAt)}`);
                            if (recovering) {
                                rejectQueue('editor recovered after warmup timeout; please retry', warmupDiagnostic('recovered'));
                            } else {
                                flushQueue();
                            }
                            recovering = false;
                            warmupJustCompleted = KOL_PROGRESS_PROTOCOL !== 'off' ? true : warmupJustCompleted;
                            notifyWarmupProgress(Math.floor(COLD_WARMUP_TIMEOUT_MS / 1000));
                            warmFlushed = true;
                            // SEE-1244 §6.2 (defect #1): hot-reuse flush path — same
                            // first warm&&connected closure point as above.
                            maybeRefreshToolsCache();
                            break;
                        }
                        log(`editor warm detected on ${GODOT_HOST}:${GODOT_PORT}; slot freed, waiting for godot-mcp CLI to connect before releasing ${pendingCalls.length} queued call(s).`);
                    }
                    // Holding: the inner loop re-probes next tick. Do NOT enter
                    // RECOVERING — the cold window is still open and the editor is
                    // still booting normally.
                }
            } else {
                if (!recovering && (now - spawnStartedAt) >= currentWarmupTimeout()) {
                    // T2: warmup window exhausted. SEE-1111 目标2 (180s-window
                    // fallback): answer the held first call(s) NOW with a retryable
                    // timeout diagnostic instead of hanging them until FAILED_EXIT —
                    // the client has already waited the full warmup window, so it
                    // gets a "please retry" rather than silence. The held calls are
                    // drained here (rejectQueue); a NEW call during RECOVERING is
                    // rejected immediately by the recovering branch, and if the
                    // editor comes back (T3) the client's next retry succeeds.
                    // Reset render-stable so a recovery must re-prove it.
                    recovering = true;
                    recoveringEnteredAt = now;
                    lastTcpOkAt = now; // seed the FAILED_EXIT window from RECOVERING entry
                    rejectQueue(
                        `editor warmup timed out after ${Math.floor(currentWarmupTimeout() / 1000)}s; please retry`,
                        warmupDiagnostic('recovering'),
                    );
                    renderStable = false;
                    startRenderStableMonitor();
                    if (KOL_PROGRESS_PROTOCOL !== 'off') maybeNotifyStageChange();
                    log(`WARNING: warmup timed out after ${Math.floor(currentWarmupTimeout() / 1000)}s; entering RECOVERING (held call(s) answered with retryable timeout; will retry for ${Math.floor(FAILED_EXIT_MS / 1000)}s before FAILED_EXIT).`);
                } else if (recovering && (now - lastTcpOkAt) >= FAILED_EXIT_MS) {
                    // T4: sustained probe failure. SEE-1325 H1（§SPEC-002）：先跑
                    // 内嵌恢复轮（预算口径 (a)，剩余不足单轮最坏耗时即终态），
                    // 恢复轮拿不到端口/身份不可读才走 FAILED_EXIT 终态。
                    const healed = await runRecoveryRound('cold_failed_exit');
                    if (!healed) {
                        log(`ERROR: editor did not recover within ${Math.floor(FAILED_EXIT_MS / 1000)}s (FAILED_EXIT); rejecting ${pendingCalls.length} buffered call(s).`);
                        rejectQueue(`editor did not recover within ${Math.floor(FAILED_EXIT_MS / 1000)}s (FAILED_EXIT)`, warmupDiagnostic('failed_exit'));
                        if (GIVEUP_REARM_ENABLED) {
                            warmupTimedOut = false;
                            giveUpAndRearm('recovering_failed_exit', 'sustained probe failure (FAILED_EXIT)');
                            break;   // exit the warmFlushed loop; outer loop re-arms
                        }
                        warmupTimedOut = true;
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
        if (graceRaceRespawn) {
            graceRaceRespawn = false;
            warmupTimeoutMs = null;      // fresh round re-classifies cold/hot
            lastSpawnReused = false;
            tcpReceivedCount = 0;
            firstProbeOkAt = 0;          // fresh round re-measures the bind delay
            for (const s of STAGE_ENUM) stageTimestamps[s] = null;
            stageTimestamps.LAUNCHER_EXEC = startedAt;
            stage = 'EDITOR_SPAWNED';    // spawn is about to re-run; milestones re-derive
            renderStable = false;
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
            spawnAttempts = 0;           // the re-spawn is a fresh round, not a failure retry
            triggerEnsureEditor();
        }
        // If the inner loop exited because spawnTriggered flipped false (a
        // non-terminal spawn failure), the outer loop returns to COLD_EMPTY
        // idle for the next tools/call. render-stable monitor keeps running.
    }
}

// SEE-1085 usability: resolve how to launch godot-mcp once (override → local
// install → npx cache → npx fallback). Direct `node <bin>` skips npx's ~2.9s
// cold overhead (measured) when the package is cached, cutting the cold MCP
// handshake from ~6s toward ~0.6s. Cached at first use so an npx respawn reuses
// the same resolution (the cache does not move during a proxy run).
let resolvedGodotMcpCmd = null;
function getGodotMcpCommand() {
    if (!resolvedGodotMcpCmd) {
        resolvedGodotMcpCmd = resolveGodotMcpCommand();
        log(`launching godot-mcp via ${resolvedGodotMcpCmd.source}`);
    }
    return resolvedGodotMcpCmd;
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

// SEE-1110 §7: build the one-line success-path timeline appended to the first
// warmup-triggered tools/call's result.content. Values are seconds relative to
// the warmup start (spawnStartedAt || startedAt), cumulative; `?` when the stage
// was never reached (log unavailable, §6 degradation) OR its timestamp predates
// this spawn round's start (a stale timestamp from a prior round survives while
// spawnStartedAt was reset forward — 缺陷 B, SEE-1111). The WARM anchor is
// warmAt (proxy-set) so the final interval reflects when the editor became usable.
function buildWarmupTimeline() {
    const start = spawnStartedAt || startedAt;
    const warmTs = warmAt || Date.now();
    const sec = (ts) => (ts && (ts - start) >= 0 ? ((ts - start) / 1000).toFixed(1) : '?');
    const segs = [
        ['spawn', stageTimestamps.EDITOR_SPAWNED],
        ['plugin', stageTimestamps.PLUGIN_INIT],
        ['listen', stageTimestamps.SERVER_LISTENING],
        ['tcp', stageTimestamps.TCP_CONNECTED],
        ['ws', stageTimestamps.WS_HANDSHAKE],
        ['init', stageTimestamps.MCP_INITIALIZED],
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
    const start = spawnStartedAt || startedAt;
    const now = Date.now();
    const sec = (ts) => (ts && (ts - start) >= 0 ? ((ts - start) / 1000).toFixed(1) : '?');
    const segs = [
        ['spawn', stageTimestamps.EDITOR_SPAWNED],
        ['plugin', stageTimestamps.PLUGIN_INIT],
        ['listen', stageTimestamps.SERVER_LISTENING],
        ['ws', stageTimestamps.WS_HANDSHAKE],
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
    if (firstCallProgressToken != null) {
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

function startNpx() {
    // Variable named `npx` for historical continuity; it is the godot-mcp child
    // process regardless of whether it is launched via npx or direct node.
    const { cmd, args } = getGodotMcpCommand();
    stageLog('NPX_SPAWN', `cmd=${cmd}`);
    npx = spawn(cmd, args, {
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
    npxRunning = true;
    // NOTE: npxTransportReady is NOT set here. spawn() returns before the child
    // has started; the transport is only ready once the child's stdin pipe is
    // actually writable (npxStdinReady=true, set in the 'open'/'drain'/immediate
    // paths below). Until then a tools/call is held by the 缺陷 #9 gate.
    log(`DEBUG: godot-mcp child spawned via ${cmd} (pid=${npx.pid || 'unknown'})`);

    // SEE-1111: watch the CLI's stderr for its WS lifecycle. 'Connected to
    // Godot' (the fork logs this on WS open) marks the CLI connected; a
    // 'Disconnected'/'Reconnecting' marks it not-connected again. Every line is
    // forwarded to OUR stderr so nothing seen via 'inherit' is lost.
    if (npx.stderr) {
        npxCliConnected = false;
        toolsCacheRefreshedForSpawn = false; // SEE-1244: each new CLI gets a fresh cache pull
        let errBuf = '';
        npx.stderr.on('data', (chunk) => {
            const s = chunk.toString();
            try { process.stderr.write(s); } catch { /* ignore */ }
            errBuf += s;
            let idx;
            while ((idx = errBuf.indexOf('\n')) !== -1) {
                const line = errBuf.slice(0, idx);
                errBuf = errBuf.slice(idx + 1);
                if (/Connected to Godot/.test(line)) {
                    npxCliConnected = true;
                    stageLog('NPX_CLI_CONNECTED', `elapsed_ms=${Date.now() - (spawnStartedAt || startedAt)}`);
                    // SEE-1244 §6.2 (Revy QA defect #1): earliest point where warm
                    // + CLI-connected can both hold → the only reliable moment to
                    // pull the real list and close the cache. Idempotent per spawn.
                    maybeRefreshToolsCache();
                }
                else if (/Disconnected from Godot|Reconnecting to Godot/.test(line)) npxCliConnected = false;
            }
        });
    }

    npx.stdin.on('error', (err) => {
        log(`ERROR: npx stdin error: ${err.message}`);
        npxStdinReady = false;
    });
    npx.stdin.on('finish', () => {
        log('DEBUG: npx stdin finished');
        npxStdinReady = false;
    });
    npx.stdin.on('open', () => {
        log('DEBUG: npx stdin opened');
        npxStdinReady = true;
        markNpxTransportReady();
        flushNpxWriteBuffer();
    });
    npx.stdin.on('drain', () => {
        if (!npxStdinReady) {
            log('DEBUG: npx stdin became drainable');
            npxStdinReady = true;
            markNpxTransportReady();
        }
        flushNpxWriteBuffer();
    });
    // Writable streams are created ready; if write() returns true we can treat it
    // as open. Use an immediate probe to set the initial state.
    try {
        const writable = npx.stdin.writable && !npx.stdin.destroyed;
        if (writable) {
            npxStdinReady = true;
            markNpxTransportReady();
            log('DEBUG: npx stdin writable immediately');
        }
    } catch (err) {
        log(`DEBUG: npx stdin writable check error: ${err.message}`);
    }

    npx.on('error', (err) => {
        log(`ERROR: npx process failed to start: ${err.message}`);
        npxRunning = false;
    });

    npx.on('exit', (code, signal) => {
        npxRunning = false;
        npxStdinReady = false;
        npxTransportReady = false;
        npxWriteBuffer.length = 0;
        if (!shutdownRequested) {
            log(`WARNING: npx exited unexpectedly (code=${code}, signal=${signal}).`);
        }

        // Cold path: still waiting for warmup. Respawn npx with backoff and replay
        // any handshake requests the dead instance never answered, so a transient
        // npx death during a cold boot cannot strand the MCP handshake or take the
        // proxy down. Unbounded until the warmup timeout (separate cold counter so
        // cold churn never eats the small hot-restart budget).
        if (!warm && !warmupTimedOut && !shutdownRequested) {
            coldNpxRestarts += 1;
            const backoff = NPX_RESTART_BACKOFF_MS * Math.min(coldNpxRestarts, 5);
            log(`npx died during warmup; respawning in ${backoff}ms (cold attempt ${coldNpxRestarts}).`);
            setTimeout(() => {
                if (warm || warmupTimedOut || shutdownRequested) return;
                startNpx();
                replayHandshake();
            }, backoff);
            return;
        }

        // Hot path: warmup already succeeded. A dying npx is a real failure; give it
        // a bounded restart budget, then exit so Claude restarts the server against
        // a genuinely dead editor.
        if (warm && !shutdownRequested) {
            const hotElapsed = Date.now() - warmAt;
            if (hotNpxRestarts < 3 && hotElapsed < HOT_NPX_RESTART_DEADLINE_MS) {
                hotNpxRestarts += 1;
                log(`npx died after warmup; hot-restarting (attempt ${hotNpxRestarts}).`);
                setTimeout(() => {
                    if (!shutdownRequested) startNpx();
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
        input: npx.stdout,
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
                const waiter = internalExecWaiters.get(msg.id);
                if (waiter) {
                    internalExecWaiters.delete(msg.id);
                    const timer = internalExecTimers.get(msg.id);
                    if (timer) { clearTimeout(timer); internalExecTimers.delete(msg.id); }
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
                pendingHandshake.delete(msg.id);
            }
            if (msg.id !== undefined && screenshotCallIds.has(msg.id)) {
                screenshotCallIds.delete(msg.id); // one response per id
                if (msg.error !== undefined) {
                    msg.error = augmentScreenshotError(msg.error);
                    out = JSON.stringify(msg);
                } else if (screenshotContract.has(msg.id)) {
                    // SEE-1240 WS-3: successful capture — stamp freshness
                    // metadata, export the PNG, run the width×height check.
                    // All additions; the original image content is preserved.
                    const info = screenshotContract.get(msg.id);
                    screenshotContract.delete(msg.id);
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
                                mutationBeforeCaptureMs: lastMutationAtMs,
                                lastFrameAdvanceMs: lastFrameAdvanceAtMs,
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
            if (msg.id !== undefined && execCallIds.has(msg.id)) {
                execCallIds.delete(msg.id); // one response per id
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
            if (msg.id !== undefined && toolsCallIds.has(msg.id)) {
                // SEE-1134 Q1: the restart ack (the fork CLI folded the addon's
                // {restarting:true} into a TEXT result) has arrived. Consume it —
                // it is NOT forwarded to Claude; the held restart call is answered
                // only once the relaunched editor is warm and the CLI reconnected.
                if (restartHold && restartHold.id === msg.id) {
                    toolsCallIds.delete(msg.id);
                    toolsCallLines.delete(msg.id);
                    screenshotCallIds.delete(msg.id);
                    execCallIds.delete(msg.id);
                    pendingHandshake.delete(msg.id);
                    if (msg.error !== undefined) {
                        const reason = (msg.error && typeof msg.error.message === 'string')
                            ? msg.error.message
                            : 'addon rejected the restart command';
                        log(`WARNING: restart call id=${msg.id} errored (${reason}); no restart in progress — answering {restarted:false, reason}.`);
                        finishRestartHold(restartHold, { restarted: false, reason });
                    } else {
                        restartHold.phase = 'waiting';
                        log(`restart: addon acknowledged restart id=${msg.id}; pre-positioning respawn watch.`);
                        driveRestartRespawn(restartHold).then((ok) => {
                            finishRestartHold(restartHold, ok
                                ? { restarted: true }
                                : { restarted: false, reason: 'timeout' });
                        }).catch((err) => {
                            log(`ERROR: restart respawn watch failed: ${err && err.message}`);
                            finishRestartHold(restartHold, {
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
                        const wasProbe = takeover && takeover.probeId === msg.id;
                        toolsCallIds.delete(msg.id);
                        // keep toolsCallLines[msg.id] — needed to re-dispatch the probe
                        if (wasProbe) {
                            // Probe lost the slot again; clear probe and reschedule
                            // (or fail if the deadline has passed).
                            takeover.probeId = null;
                            if (takeover.timer) { clearTimeout(takeover.timer); takeover.timer = null; }
                            if (Date.now() >= takeover.deadline) {
                                failTakeover();
                            } else {
                                takeover.timer = setTimeout(attemptTakeoverProbe, TAKEOVER_RETRY_MS);
                            }
                        } else {
                            enterTakeoverWaiter(msg.id);
                        }
                        return; // withhold this busy response from Claude
                    }
                    // Takeover disabled (KOL_TAKEOVER_TIMEOUT_MS=0): immediate §2 diagnostic.
                    toolsCallIds.delete(msg.id);
                    toolsCallLines.delete(msg.id);
                    msg.error = augmentEditorBusyError(msg.error);
                    out = JSON.stringify(msg);
                } else {
                    // Non-busy response (success, editor_gone, or any other error).
                    toolsCallIds.delete(msg.id);
                    toolsCallLines.delete(msg.id);
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
                        if (warm && isEditorGoneError(msg.error)) {
                            beginWarmEditorRespawn();
                        }
                    }
                    // SEE-1110 §2.2: MCP_INITIALIZED(6) — a successful JSON-RPC
                    // response after the WS handshake proves end-to-end MCP over
                    // WebSocket (the addon never logs initialize itself). Marked
                    // once; WARM(7) set by warmupLoop.
                    if (KOL_PROGRESS_PROTOCOL !== 'off'
                        && msg.error === undefined
                        && stageTimestamps.WS_HANDSHAKE !== null
                        && stageOrdinal(stage) < 6) {
                        if (stageTimestamps.MCP_INITIALIZED === null) stageTimestamps.MCP_INITIALIZED = Date.now();
                        if (stageOrdinal('MCP_INITIALIZED') > stageOrdinal(stage)) stage = 'MCP_INITIALIZED';
                    }
                    // If this id was a takeover waiter that just resolved, npx now
                    // holds the WS — re-dispatch any remaining waiters through the
                    // normal flow (they will succeed without re-competition).
                    if (takeover && (takeover.waiters.has(msg.id) || takeover.probeId === msg.id)) {
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
            if (warmupJustCompleted && msg.error === undefined && msg.result !== undefined) {
                warmupJustCompleted = false;
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

// Re-send warmup-phase handshake requests the previous npx instance died without
// answering, so the client still receives its initialize/tools/list result after
// an npx respawn instead of stalling on a request that vanished with the child.
function replayHandshake() {
    if (pendingHandshake.size === 0) return;
    log(`replaying ${pendingHandshake.size} handshake request(s) to respawned npx.`);
    for (const line of pendingHandshake.values()) {
        forwardToNpx(line);
    }
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

function shutdown() {
    shutdownRequested = true;
    if (leaseTimer) { clearInterval(leaseTimer); leaseTimer = null; }
    // SEE-1134 Q1: a held restart call must not leak into a client hang when the
    // proxy shuts down mid-restart.
    if (restartHold) {
        finishRestartHold(restartHold, { restarted: false, reason: 'shutdown' });
    }
    if (npx && npxRunning && !npx.killed) {
        npx.kill('SIGTERM');
    }
    // Do not kill the editor; the godot_mcp addon uses a lease and exits when
    // the WS client disconnects.
    rejectQueue('proxy shutting down');
    markIntentionalRelease();
    releaseArbiterPort();
    setTimeout(() => process.exit(0), 500);
}

// SEE-1148 P3 (§2.5 第二层 proxy 主动): on a NORMAL shutdown, stamp this
// runtime's lease sidecar with `intentional_release=true`. The editor stays
// alive (the addon's own 120s disconnect-suicide still runs) — the marker is
// only a "I left deliberately" credential. The resident reaper reads it and
// SKIPS the 120s fresh-lease grace, reclaiming the idle editor on its next
// 5min sweep instead of waiting out a grace that was designed to protect a
// still-starting editor. Without this, a cleanly-exited proxy leaves an editor
// nobody is using sitting idle until the disconnect timer + grace elapse.
//
// Guarded to THIS runtime: the sidecar is only marked when its recorded
// runtime_id matches ours (or is absent/legacy — we then also match on port),
// so a clean shutdown of runtime A never marks a lease that concurrent
// runtime B just wrote on the same worktree.
//
// Synchronous (execFileSync) because shutdown() runs just before
// process.exit — an async mark would be abandoned. Best-effort: a mark
// failure only means the reaper falls back to the normal grace path.
function markIntentionalRelease() {
    if (!RUNTIME_ID) return;
    const projectGodot = process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT;
    if (!projectGodot) return;
    try {
        execFileSync('bash', ['-c', `
            set -euo pipefail
            sidecar="$(dirname "$1")/.godot/mcp-lease.json"
            [[ -f "$sidecar" ]] || exit 0
            RID="$2" SIDE="$sidecar" node -e '
                const fs = require("fs");
                let o;
                try { o = JSON.parse(fs.readFileSync(process.env.SIDE, "utf8")); } catch (e) { process.exit(0); }
                const rid = process.env.RID;
                // Only mark OUR runtime's lease. A legacy/absent runtime_id is
                // acceptable only when it is empty (never set); a DIFFERENT
                // runtime_id means a concurrent slot owns this lease — do not touch.
                if (o.runtime_id && o.runtime_id !== rid) process.exit(0);
                if (o.state !== "active") process.exit(0);
                o.intentional_release = true;
                o.intentional_release_at = new Date().toISOString();
                const tmp = process.env.SIDE + ".tmp." + process.pid;
                fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + "\\n", "utf8");
                fs.renameSync(tmp, process.env.SIDE);
            '
        `, 'mark', projectGodot, RUNTIME_ID],
            { env: { ...process.env }, timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'] });
        log(`marked intentional_release on lease for runtime ${RUNTIME_ID} on shutdown.`);
    } catch (e) {
        log(`markIntentionalRelease: non-fatal mark failure for runtime ${RUNTIME_ID}: ${e && e.message ? e.message : e}`);
    }
}

// SEE-1148 P2 (release path): on a clean proxy exit, release this runtime's
// dynamically-granted port so a DIFFERENT runtime can re-grant it after the
// 60s cooldown. Synchronous (execFileSync) because shutdown() runs just before
// process.exit — an async release would be abandoned. Best-effort: a release
// failure only leaves a stale held dir, which the reaper backstop sweeps.
// Same-runtime respawn re-grabs instantly (cooldown skipped), so releasing on
// a same-slot restart does NOT cost the respawn its port.
function releaseArbiterPort() {
    if (!PORT_ARBITER_ENABLED || !RUNTIME_ID || !GODOT_PORT) return;
    // Only release ports in the dynamic pool — the legacy per-agent table
    // ports (6551-6556) are not arbiter-granted and must never be released
    // (a concurrent same-agent legacy holder could be using one).
    if (GODOT_PORT < 6560 || GODOT_PORT > 6609) return;
    try {
        execFileSync('bash', ['-c',
            'source "$1" && port_arbiter_release "$2"',
            'rel', PORT_ARBITER_LIB, String(GODOT_PORT)],
            { env: { ...process.env }, timeout: 5000, stdio: ['ignore', 'ignore', 'ignore'] });
        log(`released dynamic port ${GODOT_PORT} for runtime ${RUNTIME_ID} on shutdown.`);
    } catch (e) {
        log(`releaseArbiterPort: non-fatal release failure for port ${GODOT_PORT}: ${e && e.message ? e.message : e}`);
    }
}

process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });

// SEE-1148 P1 (steady-state heartbeat → registry): refresh
// ~/.multica/godot-port-registry.json heartbeat_at while the proxy is alive
// AND post-WARM. Gated on stage === 'WARM' so warmup-phase transients (npx
// restarts, RC gate bounces) don't pollute the registry with a "this slot is
// healthy" signal that an early-running reader would trust. Refreshing only
// in steady state matches the brief: "挂到现有 steady-state 监控循环（非
// warmup 循环）". On any non-fatal upsert error we stay quiet — the registry
// is observability, not a gate.
const RUNTIME_ID = process.env.GODOT_MCP_RUNTIME_ID || process.env.KOL_RUNTIME_ID || '';
const REGISTRY_PATH = path.join(GODOT_MCP_HOME, 'godot-port-registry.json');
const REGISTRY_LOCK_PATH = `${REGISTRY_PATH}.lock`;
let lastRegistryRefreshMs = 0;
async function refreshRegistryHeartbeat() {
    if (!RUNTIME_ID) return;
    if (stage !== 'WARM') return;
    // Throttle to ~HEARTBEAT_INTERVAL_MS so we don't fan out a write per poll.
    const now = Date.now();
    if (now - lastRegistryRefreshMs < HEARTBEAT_INTERVAL_MS) return;
    lastRegistryRefreshMs = now;
    const tmp = `${REGISTRY_PATH}.tmp.${process.pid}.${now}`;
    try {
        // F6 (Atlas P2): the heartbeat is a recurring writer on the SAME rid the
        // launcher's port_registry_upsert writes. Without a shared lock the two
        // read-modify-write interleave and the launcher's upsert can overwrite a
        // fresher heartbeat_at (heartbeat regresses → the reaper reads the slot
        // as stale → mis-kill). Serialize on the SAME flock the P1 registry lib
        // uses (godot-port-registry.json.lock) so heartbeat and launcher upsert
        // share one critical section — the P1 lock primitive, not a new lock.
        // flock -w 5 bounds the wait; a contended write is skipped (the next 2s
        // heartbeat re-attempts), never blocks the proxy. `flock <lock> node -e`
        // holds the fd for exactly the child read-modify-write — no fd crosses
        // an exec, no long-lived spawn inside the section.
        const mergeScript = `
            const fs = require("fs");
            const now = Number(process.env.REG_NOW);
            let cur = { schema_version: 1, updated_at: new Date(now).toISOString(), entries: {} };
            try { cur = JSON.parse(fs.readFileSync(process.env.REG_PATH, "utf8")); } catch (e) {}
            if (!cur.entries || typeof cur.entries !== "object") cur.entries = {};
            const rid = process.env.REG_RID;
            const prev = (cur.entries[rid] && typeof cur.entries[rid] === "object") ? cur.entries[rid] : {};
            cur.entries[rid] = Object.assign({}, prev, {
                heartbeat_at: new Date(now).toISOString(),
                proxy_pid: process.env.REG_PID ? Number(process.env.REG_PID) : process.pid,
            });
            cur.updated_at = new Date(now).toISOString();
            fs.writeFileSync(process.env.REG_TMP, JSON.stringify(cur, null, 2) + "\n", "utf8");
        `;
        execFileSync('flock', ['-w', '5', REGISTRY_LOCK_PATH, 'node', '-e', mergeScript], {
            env: Object.assign({}, process.env, {
                // eslint-disable-next-line no-undef -- SEE-1334 baseline: REG_PATH shorthand is not in scope (the reader at L4537 uses process.env.REG_PATH); suspected latent bug, flagged for drift triage
                REG_PATH, REG_TMP: tmp, REG_RID: RUNTIME_ID,
                REG_PID: String(process.pid), REG_NOW: String(now),
            }),
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        await rename(tmp, REGISTRY_PATH);
    } catch {
        // Best-effort: drop the tmp file if anything went wrong so we don't
        // leak state. Registry writes are not a correctness gate; a lost lock
        // just defers the heartbeat to the next interval.
        try { await unlink(tmp); } catch { /* ignore */ }
    }
}

function startHeartbeat() {
    // Heartbeat here means logging that the proxy is still alive and waiting.
    // We do NOT perform a WebSocket handshake to avoid stealing the addon's
    // single WS-client slot (constraint 2).
    setInterval(() => {
        if (shutdownRequested) return;
        maybeProgressLog();
        refreshRegistryHeartbeat().catch(() => {});
        selfRegisterProxyPid().catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
}

// SEE-1316 (hardener) — reaper contract closure, proxy self-registration: stamp
// this proxy's PID onto its own runtime's ACTIVE lease sidecar. The reaper's
// proxy_pid_dead branch (reap-stale-leases.sh) needs an attributable,
// killable owner PID: configured_by_pid is the short-lived configure shell
// (always dead post-exit) and nothing else in the sidecar names the proxy, so
// a SIGKILLed proxy used to strand the editor until the addon's internal
// 45s/120s windows ran out with no reaper backstop. Best-effort and idempotent
// (sidecar_set_proxy_pid skips foreign-runtime / non-active sidecars and never
// clobbers a live different proxy_pid); retried on the heartbeat cadence until
// it lands, so a race with configure's sidecar write resolves itself.
let proxyPidRegistered = false;
async function selfRegisterProxyPid() {
    if (proxyPidRegistered || !RUNTIME_ID || stage !== 'WARM') return;
    if (!GODOT_PORT) return;
    const worktree = process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE;
    if (!worktree) return;
    const projectGodot = process.env.GODOT_MCP_PROJECT_GODOT || process.env.KOL_PROJECT_GODOT
        || `${worktree}/project.godot`;
    const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-sidecar.lib.sh');
    try {
        await new Promise((resolve, reject) => {
            execFile('bash', ['-c',
                'source "$1" && sidecar_set_proxy_pid "$2" "$3"',
                'regpid', lib, projectGodot, String(process.pid)],
            { env: { ...process.env }, timeout: 5000 }, (err) => err ? reject(err) : resolve());
        });
        proxyPidRegistered = true;
        log(`self-registered proxy_pid=${process.pid} on lease sidecar (runtime ${RUNTIME_ID}).`);
    } catch (e) {
        // Non-fatal: the next heartbeat retries; a sidecar without proxy_pid
        // simply falls back to the pre-fix reaper behavior.
        log(`selfRegisterProxyPid: non-fatal failure (will retry on heartbeat): ${e && e.message ? e.message : e}`);
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
const WARM_LIVENESS_ENABLED = (process.env.GODOT_MCP_WARM_LIVENESS || process.env.KOL_WARM_LIVENESS || 'on') !== 'off';
const WARM_LIVENESS_FAILURES = parseInt(
    process.env.GODOT_MCP_WARM_LIVENESS_FAILURES || process.env.KOL_WARM_LIVENESS_FAILURES || '3',
    10
);
let warmProbeFailures = 0;
async function warmLivenessProbe() {
    if (shutdownRequested || spawnTerminal || !warm || warmEditorDead || !WARM_LIVENESS_ENABLED) {
        return;
    }
    // SEE-1134 Q1: when a restart_hold is in flight, the editor is INTENTIONALLY
    // going away (port → cold during the restart window). driveRestartRespawn is
    // the sole authority on whether the editor came back; the warm liveness
    // probe must NOT race it and pre-empt it with a "presumed dead" respawn
    // (which would land in a fresh spawn while the relaunched editor is also
    // booting → "Already in use" or 3-editor coexistence — Q2 symptom).
    if (restartHold) {
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
    if (npxCliConnected) {
        return;
    }
    const ok = await wsProbe();
    if (ok) {
        warmProbeFailures = 0;
        return;
    }
    warmProbeFailures += 1;
    if (warmProbeFailures < WARM_LIVENESS_FAILURES) {
        log(`WARNING: warm liveness probe failed ${warmProbeFailures}/${WARM_LIVENESS_FAILURES} (editor may be dying); continuing.`);
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
    while (!shutdownRequested && !spawnTerminal) {
        await warmupLoop();
        if (shutdownRequested || spawnTerminal) return;
        // WARM reached. Idle until the editor dies (or the proxy shuts down),
        // then reset and re-enter so the next tools/call re-spawns. While
        // idling, the 缺陷 #8 warm liveness probe actively watches the editor so
        // a death that never reaches npx still triggers the respawn.
        while (!shutdownRequested && !spawnTerminal && !warmEditorDead) {
            await warmLivenessProbe();
            if (shutdownRequested || spawnTerminal || warmEditorDead) break;
            await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
        }
        if (shutdownRequested || spawnTerminal) return;
        resetForRespawn();
        // SEE-1325 H1（§SPEC-002 暖分支入口）：editor_gone respawn 再入前先跑
        // 内嵌恢复轮（归因→判定→stop-first/respawn），确保下一次 tools/call
        // 落在已恢复链上而非再次 editor_gone。
        await runRecoveryRound('warm_editor_gone');
        warmRespawnInFlight = false;
        log(`respawn loop: re-entering warmup after post-warm editor death (warmEditorDead=${warmEditorDead}). Next tools/call will re-spawn the editor.`);
        // Loop back; the outer COLD_EMPTY idle waits for the next tools/call.
    }
}

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
