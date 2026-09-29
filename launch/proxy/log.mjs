// proxy/log.mjs — stderr logging helpers (extracted from godot-mcp-proxy.mjs,
// SEE-1334 Phase 0a). stageLog honors the KOL_STAGE_LOG kill switch and stamps
// [t=+Nms] against the proxy start time in shared state.
//
// SEE-1356 L6 (§SPEC-L6-01): daemon contexts swallow stderr ("stderr alone is
// swallowed", launcher 自评). log()/stageLog() are the SINGLE tee point: every
// line also appends to $GODOT_MCP_HOME/godot-editor/<runtime_id>.proxy.log.
//   - append-only file writes (the atomic-write family in state-file.mjs is a
//     different discipline — logs stream, state publishes);
//   - pid prefix on every line: a concurrent writer is attributable without
//     any file lock (bare-name, no locking);
//   - startup rotate: a log ≥5MB at proxy boot renames to `.1` (one
//     generation, keep-last) so long-lived daemons stay bounded;
//   - open failure → silent degrade to stderr-only (the tee must never break
//     the proxy);
//   - the tee carries ONLY log lines — stdout (the JSON-RPC channel) is never
//     written here, so no JSON-RPC can contaminate the file.
// Bare process.stderr.write audit (implementation-time checklist): the npx
// child-stream passthrough (npx.mjs) routes through teeStderrLine(); the
// config.mjs FATAL banner runs before this module is importable-by-state and
// stays stderr-only by design (no home/state dir may exist yet).
import { EOL } from 'node:os';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { S } from './state.mjs';
import { GODOT_MCP_HOME, GODOT_PORT, RUNTIME_ID, STAGE_LOG_ENABLED } from './config.mjs';
import { resolveWorkdirHash } from './workdir-hash.mjs';

export const PROXY_LOG_ROTATE_BYTES = 5 * 1024 * 1024;

const LEGACY_LABEL = (process.env.GODOT_MCP_AGENT_NAME || process.env.KOL_AGENT_NAME || 'unknown').toLowerCase();
const PID_TAG = `[pid=${process.pid}]`;

// Lazy single open: an append fd held for the process lifetime. null = not
// initialized yet; false = open failed (silent stderr-only degrade).
let logFd = null;
let logPath = null;

function proxyLogPath() {
    const dir = path.join(GODOT_MCP_HOME, 'godot-editor');
    const file = (RUNTIME_ID && RUNTIME_ID !== '*' && !RUNTIME_ID.endsWith('-solo') && /^[A-Za-z][A-Za-z0-9_-]*-[0-9a-f]{8,12}$/.test(RUNTIME_ID))
        ? path.join(dir, `${RUNTIME_ID}.proxy.log`)
        : path.join(dir, `godot-editor-${LEGACY_LABEL}.proxy.log`);
    return file;
}

// rotateIfNeeded(): startup-time one-generation rotation (≥5MB → `.1`).
function rotateIfNeeded(file) {
    try {
        if (existsSync(file) && statSync(file).size >= PROXY_LOG_ROTATE_BYTES) {
            try { renameSync(file, `${file}.1`); } catch { /* a concurrent rotator won; append anyway */ }
        }
    } catch { /* stat failure — append anyway */ }
}

function ensureProxyLogOpen() {
    if (logFd !== null) return logFd !== false;
    logPath = proxyLogPath();
    try {
        rotateIfNeeded(logPath);
        mkdirSync(path.dirname(logPath), { recursive: true });
        logFd = openSync(logPath, 'a');
        writeStartupHeader();
    } catch {
        logFd = false; // silent degrade — stderr-only logging continues
    }
    return logFd !== false;
}

// Startup header (§SPEC-L6-01): pid/port/worktree/workdir_hash — the hash via
// the L2 SSOT (workdir-hash.mjs), same 口径 as status/registry/get_info.
function writeStartupHeader() {
    const worktree = process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE || '';
    let hashPart = '';
    try {
        const resolved = worktree ? resolveWorkdirHash(worktree) : null;
        hashPart = resolved ? ` workdir_hash=${resolved.workdir_hash} hash_source=${resolved.hash_source}` : ' workdir_hash=<unresolved>';
    } catch {
        hashPart = ' workdir_hash=<unresolved>';
    }
    writeTee(`=== proxy start pid=${process.pid} port=${GODOT_PORT || '?'} worktree=${worktree || '<unresolved>'}${hashPart} ===`);
}

function writeTee(line) {
    if (logFd === null && !ensureProxyLogOpen()) return;
    if (logFd === false) return;
    try {
        writeSync(logFd, `${line}${EOL}`);
    } catch {
        // A write failure (disk full, rotated-away fd) degrades silently —
        // never break the caller's logging path.
    }
}

export function log(msg) {
    // stderr keeps the EXACT legacy line shape — the SEE-1152 stage-log
    // contract test pins `[godot-mcp-proxy] ...` byte-for-byte. The pid tag
    // (L6 归因) rides ONLY the tee artifact, whose format is new.
    process.stderr.write(`[godot-mcp-proxy] ${msg}${EOL}`);
    writeTee(`[godot-mcp-proxy] ${PID_TAG} ${msg}`);
}

// teeStderrLine(): the bare-stderr passthrough seams (npx child streams) use
// this so relayed child output lands in the tee too, with the same pid tag.
export function teeStderrLine(chunk) {
    process.stderr.write(chunk);
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    if (!text.includes('\n')) {
        writeTee(`[godot-mcp-proxy] ${PID_TAG} [npx] ${text}`);
        return;
    }
    for (const line of text.split(/\r?\n/)) {
        if (line) writeTee(`[godot-mcp-proxy] ${PID_TAG} [npx] ${line}`);
    }
}

// SEE-1152 (Owner): end-to-end cold-start stage timing. Every emit carries
//   [stage=<NAME>]           machine-greppable stage token
//   [t=+Nms]                 milliseconds since proxy start (startedAt)
//   [ts=<iso8601>]           absolute wall-clock (UTC)
// Default ON (KOL_STAGE_LOG=off to silence). The stage names mirror the
// SEE-1110 warmup enum plus finer-grained spawn-path events the protocol
// cannot see (arbiterDecide, helper scripts, render-stable gate, npx CLI).
// Emitted to stderr AND the L6 tee — never to stdout, so the JSON-RPC channel
// stays clean. Tests can grep stderr for `stage=` lines without parsing stdout.
export function stageLog(stage, msg = '') {
    if (!STAGE_LOG_ENABLED) return;
    const now = Date.now();
    const rel = now - S.startedAt;
    const iso = new Date(now).toISOString();
    const suffix = msg ? ` ${msg}` : '';
    // stderr = legacy contract shape verbatim; tee = pid-tagged twin (L6).
    const body = `[stage=${stage}] [t=+${rel}ms] [ts=${iso}]${suffix}`;
    process.stderr.write(`[godot-mcp-proxy] ${body}${EOL}`);
    writeTee(`[godot-mcp-proxy] ${PID_TAG} ${body}`);
}

// testSeams (unit use only): reset the lazy-open cache between cases.
export function resetProxyLogForTest() {
    if (logFd !== null && logFd !== false) {
        try { closeSync(logFd); } catch { /* already closed */ }
    }
    logFd = null;
    logPath = null;
}

export { proxyLogPath, ensureProxyLogOpen, rotateIfNeeded, writeTee };
