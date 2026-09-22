// proxy/config.mjs — env-derived constants + startup side effects for the
// godot-mcp stdio proxy (extracted from godot-mcp-proxy.mjs, SEE-1334 Phase 0a).
// SIDE EFFECTS AT IMPORT TIME (the entry imports this module first): F11
// HOME-unset refusal, GODOT_MCP_QUICK_TIMEOUT_MS default, WSL gateway detect.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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

const POWERSHELL_BIN = ['/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe']
    .find((p) => { try { return existsSync(p); } catch { return false; } }) || null;

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

const STAGE_LOG_ENABLED = (process.env.GODOT_MCP_STAGE_LOG || process.env.KOL_STAGE_LOG || 'on') !== 'off';

function isValidPort(p) {
    return Number.isInteger(p) && p >= 6000 && p <= 65535;
}

const GIVEUP_REARM_ENABLED = !['off', '0', 'false'].includes((process.env.GODOT_MCP_GIVEUP_REARM || process.env.KOL_GIVEUP_REARM || 'on').toLowerCase());
const GIVEUP_BASE_COOLDOWN_MS = parseInt(process.env.GODOT_MCP_GIVEUP_COOLDOWN_MS || process.env.KOL_GIVEUP_COOLDOWN_MS || '30000', 10);
// SEE-1338 spec v2.1 §6: spawn failure backoff caps at 60s — FAILED_CLEAN is a
// REENTRANT state (the next tools/call retries cold start), so a longer cap
// only pads the retry loop without protecting anything.
const GIVEUP_MAX_COOLDOWN_MS = parseInt(process.env.GODOT_MCP_GIVEUP_MAX_COOLDOWN_MS || process.env.KOL_GIVEUP_MAX_COOLDOWN_MS || '60000', 10);
// SEE-1338 spec v2.1 §6 (R2 hard-cap backstop): once RECOVERING has lasted
// 2× the cold timeout ABSOLUTELY (measured from RECOVERING entry, regardless
// of any self-heal blip in between), the proxy FORCES a cold restart — evict
// its own editor, respawn against a clean slate. Kills the 形态-B "stuck in
// RECOVERING fake-retry forever" dead end. Derived from the cold window (not
// from FAILED_EXIT_MS) so an env-tuned FAILED_EXIT cannot push the cap past
// the spec bound; env-overridable for test seams.
const RECOVERING_HARD_CAP_MS = parseInt(process.env.GODOT_MCP_RECOVERING_HARD_CAP_MS || process.env.KOL_RECOVERING_HARD_CAP_MS || String(2 * COLD_WARMUP_TIMEOUT_MS), 10);
// SEE-1240 WS-7 (目标2): grace-race guard. The vendored addon arms its 300s
// initial lease grace at plugin init, BEFORE the port is bound; a first boot
// with a cold import cache can burn most of that grace before any client can
// connect. When the measured bind delay exceeds KOL_GRACE_RACE_BIND_S the
// proxy evicts the slow-bind editor and respawns against the now-warm import
// cache (one-shot per spawn round). KOL_GRACE_RACE_GUARD=0 disables (seam).
const GRACE_RACE_GUARD_ENABLED = !['off', '0', 'false'].includes((process.env.GODOT_MCP_GRACE_RACE_GUARD || process.env.KOL_GRACE_RACE_GUARD || 'on').toLowerCase());
const GRACE_RACE_BIND_MS = parseInt(process.env.GODOT_MCP_GRACE_RACE_BIND_S || process.env.KOL_GRACE_RACE_BIND_S || '150', 10) * 1000;

const SPAWN_MAX_ATTEMPTS = 3;
// SEE-1338 spec v2.1 §6: the per-attempt backoff base — attempt N waits
// base × 2^(N-1) (capped at GIVEUP_MAX_COOLDOWN_MS). env-overridable for
// fast test seams (the retry harness drives attempt 2 immediately).
const SPAWN_RETRY_BACKOFF_MS = parseInt(process.env.GODOT_MCP_SPAWN_RETRY_BACKOFF_MS || process.env.KOL_SPAWN_RETRY_BACKOFF_MS || '10000', 10);
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
    // SEE-1334: module lives in launch/proxy/; helper scripts are one level up in launch/
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}
function resolveHelper(name, envVar) {
    const legacy = envVar.startsWith('GODOT_MCP_') ? `KOL_${envVar.slice('GODOT_MCP_'.length)}` : '';
    for (const v of [envVar, legacy]) {
        if (v && process.env[v] && process.env[v].length) return process.env[v];
    }
    return path.join(scriptDir(), name);
}

// SEE-1244 §6.2: persist the post-patch real tools/list for the shim's
// registration window. Fire-and-forget: a cache failure must NEVER delay or
// break the response forwarding (the cache is an observation/acceleration
// layer, not a latch). Atomic mktemp+rename, same discipline as the registry.
// Mirror of godot-mcp-resolve.mjs FORK_CLI (kept inline: proxy must not gain a
// dep on the shim/resolve path shape for a cache-mtime nicety; §7.1 D7).
// §4.5.3 T2: env-overridable; default resolves relative to this library's own location.
const FORK_CLI_PATH = process.env.GODOT_MCP_FORK_CLI
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'dist', 'cli.js'); // SEE-1334: one level deeper
// SEE-1292 §DECPL-001: all state under GODOT_MCP_HOME (default neutral path).
const GODOT_MCP_HOME = process.env.GODOT_MCP_HOME || path.join(os.homedir(), '.config', 'godot-mcp');
const TOOLS_CACHE_DIR = GODOT_MCP_HOME;
const TOOLS_CACHE_LABEL = (process.env.GODOT_MCP_AGENT_NAME || process.env.KOL_AGENT_NAME || 'unknown').toLowerCase();
const TOOLS_CACHE_FILE = path.join(TOOLS_CACHE_DIR, `godot-mcp-tools-cache-${TOOLS_CACHE_LABEL}.json`);

const TAKEOVER_TIMEOUT_MS = parseInt(process.env.GODOT_MCP_TAKEOVER_TIMEOUT_MS || process.env.KOL_TAKEOVER_TIMEOUT_MS || '30000', 10);
const TAKEOVER_RETRY_MS = parseInt(process.env.GODOT_MCP_TAKEOVER_RETRY_MS || process.env.KOL_TAKEOVER_RETRY_MS || '2000', 10);
// SEE-1316 (hardener): bounded self-heal after repeated takeover timeouts.
// Threshold 3 ≈ 90s of proven-stuck holder (3 × 30s wait); disable with
// GODOT_MCP_TAKEOVER_SELF_HEAL=off (test seam / operator escape hatch).
const TAKEOVER_SELF_HEAL_THRESHOLD = parseInt(process.env.GODOT_MCP_TAKEOVER_SELF_HEAL_THRESHOLD || '3', 10);
const TAKEOVER_SELF_HEAL_ENABLED = (process.env.GODOT_MCP_TAKEOVER_SELF_HEAL || 'on') !== 'off';

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
const PORT_ARBITER_LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'port-arbiter.lib.sh'); // SEE-1334: one level deeper
const PORT_RESPAWN_WINDOW_MS = parseInt(process.env.GODOT_MCP_RESPAWN_WINDOW_MS || process.env.KOL_RESPAWN_WINDOW_MS || '8000', 10);
const PORT_TAKEOVER_TIMEOUT_MS = parseInt(process.env.GODOT_MCP_TAKEOVER_TIMEOUT_MS || process.env.KOL_TAKEOVER_TIMEOUT_MS || '300000', 10);
const PORT_PROBE_INTERVAL_MS = parseInt(process.env.GODOT_MCP_PORT_PROBE_INTERVAL_MS || process.env.KOL_PORT_PROBE_INTERVAL_MS || '1000', 10);

const RUNTIME_ID = process.env.GODOT_MCP_RUNTIME_ID || process.env.KOL_RUNTIME_ID || '';
const REGISTRY_PATH = path.join(GODOT_MCP_HOME, 'godot-port-registry.json');
const REGISTRY_LOCK_PATH = `${REGISTRY_PATH}.lock`;

const WARM_LIVENESS_ENABLED = (process.env.GODOT_MCP_WARM_LIVENESS || process.env.KOL_WARM_LIVENESS || 'on') !== 'off';
const WARM_LIVENESS_FAILURES = parseInt(
    process.env.GODOT_MCP_WARM_LIVENESS_FAILURES || process.env.KOL_WARM_LIVENESS_FAILURES || '3',
    10
);

export {
    GODOT_HOST,
    GODOT_PORT,
    EDITOR_LOG_FILE,
    PROBE_INTERVAL_MS,
    HEARTBEAT_INTERVAL_MS,
    PROGRESS_INTERVAL_MS,
    COLD_WARMUP_TIMEOUT_MS,
    HOT_WARMUP_TIMEOUT_MS,
    KOL_PROGRESS_PROTOCOL,
    HOT_NPX_RESTART_DEADLINE_MS,
    NPX_RESTART_BACKOFF_MS,
    RENDER_STABLE_REQUIRED_MS,
    RENDER_SAMPLE_MS,
    RENDER_STABLE_TIMEOUT_MS,
    FAILED_EXIT_MS,
    POWERSHELL_BIN,
    WARM_RECOVERING_CLI_TIMEOUT_MS,
    LEASE_POLL_INTERVAL_MS,
    LEASE_EXITING_LINE,
    RESTART_HOLD_TIMEOUT_MS,
    STAGE_LOG_ENABLED,
    isValidPort,
    GIVEUP_REARM_ENABLED,
    GIVEUP_BASE_COOLDOWN_MS,
    GIVEUP_MAX_COOLDOWN_MS,
    RECOVERING_HARD_CAP_MS,
    GRACE_RACE_GUARD_ENABLED,
    GRACE_RACE_BIND_MS,
    SPAWN_MAX_ATTEMPTS,
    SPAWN_RETRY_BACKOFF_MS,
    DIAGNOSTIC_STDERR_TAIL,
    SpawnError,
    scriptDir,
    resolveHelper,
    FORK_CLI_PATH,
    GODOT_MCP_HOME,
    TOOLS_CACHE_DIR,
    TOOLS_CACHE_LABEL,
    TOOLS_CACHE_FILE,
    TAKEOVER_TIMEOUT_MS,
    TAKEOVER_RETRY_MS,
    TAKEOVER_SELF_HEAL_THRESHOLD,
    TAKEOVER_SELF_HEAL_ENABLED,
    SHARED_MASTER_WORKTREE,
    isSharedMasterWorktree,
    PORT_ARBITER_ENABLED,
    PORT_ARBITER_LIB,
    PORT_RESPAWN_WINDOW_MS,
    PORT_TAKEOVER_TIMEOUT_MS,
    PORT_PROBE_INTERVAL_MS,
    RUNTIME_ID,
    REGISTRY_PATH,
    REGISTRY_LOCK_PATH,
    WARM_LIVENESS_ENABLED,
    WARM_LIVENESS_FAILURES,
};
