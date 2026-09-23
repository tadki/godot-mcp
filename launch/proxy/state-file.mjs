// proxy/state-file.mjs — SEE-1338 spec v2.1 §3 (D2): the on-disk runtime
// state, the single source of truth for handoff decisions.
//
//   $GODOT_MCP_HOME/godot-editor/<runtime_id>.state         (main, JSON)
//   $GODOT_MCP_HOME/godot-editor/<runtime_id>.events.jsonl  (audit trail)
//
// Writes are tmp-file + fsync + atomic rename (crash consistency: the disk
// always holds the old OR the new version, never a half-write — jerry 裁决
// "简单记不上库"; files + atomic rename are the standard). Readers never
// block writers and vice versa. A parse failure / version mismatch degrades
// to NO STATE (cold start) — a corrupt disk must never wedge the allocation
// path (spec §3.4).
//
// warm-gate 教训 (594ed1f): every signal a decision depends on must be
// recorded here — components must not each hold private judgments that no
// one else can read. The state file IS the shared record.
import { mkdirSync, openSync, closeSync, readFileSync, renameSync, writeFileSync, appendFileSync, existsSync, rmSync, readlinkSync, statSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { GODOT_MCP_HOME } from './config.mjs';

export const STATE_SCHEMA_VERSION = 2;

// Full per-record field set (spec §3.1). Unknown/extra fields survive
// round-trips (readState keeps them; writeState merges).
export const STATE_FIELDS = [
    'schema_version', 'state', 'port', 'editor_pid', 'editor_pid_started_at',
    'proxy_pid', 'proxy_pid_started_at', 'agent', 'issue_id', 'worktree',
    'lease_id', 'heartbeat_at', 'spawn_attempts', 'last_error',
    'warm_at', 'updated_at',
];

const VALID_STATES = new Set(['COLD', 'WARMING', 'WARM', 'RECOVERING', 'FAILED_CLEAN']);

function stateDir() {
    return path.join(GODOT_MCP_HOME, 'godot-editor');
}

function statePathFor(runtimeId) {
    return path.join(stateDir(), `${runtimeId}.state`);
}

function eventsPathFor(runtimeId) {
    return path.join(stateDir(), `${runtimeId}.events.jsonl`);
}

function heldRuntimeDirFor(runtimeId) {
    return path.join(GODOT_MCP_HOME, 'held-runtime', String(runtimeId || 'solo'));
}

// ---- held-runtime logical lock (spec §2.3/§3.2) ---------------------------------
// Arbitrates "who manages THIS runtime's editor" — separate layer from the
// per-port PHYSICAL lock (held-port). mkdir is the atomic primitive (B-6).
// staleness: a lock older than staleMs whose owner pid is dead is stealable.

export async function acquireRuntimeLock(runtimeId, { staleMs = 10 * 60 * 1000, ownerPid = process.pid } = {}) {
    const dir = heldRuntimeDirFor(runtimeId);
    // mkdir {recursive:true} never throws EEXIST — the contention probe is an
    // explicit existsSync + owner check (recursive mkdir succeeded silently
    // for a live holder, so a second acquirer was never excluded).
    if (existsSync(dir)) {
        try {
            const owner = Number(readFileSync(path.join(dir, 'owner'), 'utf-8').trim());
            if (Number.isInteger(owner) && owner > 0 && owner !== ownerPid && !pidAlive(owner)) {
                rmSync(dir, { recursive: true, force: true });
            } else if (owner !== ownerPid) {
                return { locked: false, holder: Number.isInteger(owner) ? owner : null };
            }
        } catch {
            return { locked: false, holder: null };
        }
    }
    try {
        mkdirSync(dir, { recursive: true });
    } catch {
        return { locked: false, holder: null };
    }
    try {
        writeFileSync(path.join(dir, 'owner'), String(ownerPid) + '\n', 'utf8');
        writeFileSync(path.join(dir, 'since'), String(Date.now()) + '\n', 'utf8');
    } catch { /* best-effort bookkeeping */ }
    return { locked: true, holder: ownerPid };
}

export function releaseRuntimeLock(runtimeId, ownerPid = process.pid) {
    const dir = heldRuntimeDirFor(runtimeId);
    try {
        const owner = Number(readFileSync(path.join(dir, 'owner'), 'utf-8').trim());
        if (Number.isInteger(owner) && owner !== ownerPid) return false;
    } catch { /* absent owner file — remove anyway (we hold the race) */ }
    try {
        rmSync(dir, { recursive: true, force: true });
        return true;
    } catch {
        return false;
    }
}

function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e && e.code === 'EPERM';
    }
}

// ---- read -----------------------------------------------------------------------

// readRuntimeState(runtimeId) → { ok, state, reason? }. Parse failure /
// schema mismatch / unknown state name → { ok:false } = "no state" (cold
// start); never throws (spec §3.4 读侧防御).
export function readRuntimeState(runtimeId) {
    if (!runtimeId) return { ok: false, reason: 'no-runtime-id' };
    const p = statePathFor(runtimeId);
    let raw;
    try {
        raw = readFileSync(p, 'utf-8');
    } catch (e) {
        return { ok: false, reason: e && e.code === 'ENOENT' ? 'no-file' : 'unreadable' };
    }
    let o;
    try {
        o = JSON.parse(raw);
    } catch (e) {
        return { ok: false, reason: 'unparseable', error: e && e.message };
    }
    if (!o || typeof o !== 'object') return { ok: false, reason: 'not-object' };
    const sv = Number(o.schema_version);
    if (sv !== STATE_SCHEMA_VERSION) {
        return { ok: false, reason: 'schema-mismatch', schema_version: sv };
    }
    if (!VALID_STATES.has(o.state)) {
        return { ok: false, reason: 'unknown-state', state: String(o.state) };
    }
    return { ok: true, state: o };
}

// ---- write ----------------------------------------------------------------------

// writeRuntimeState(runtimeId, patch, { event, fromState, detail }): merge
// patch over the CURRENT on-disk doc (read-merge-write inside the caller's
// held-runtime lock), bump updated_at, tmp + fsync + atomic rename. Returns
// the merged doc. Fire-and-forget by contract: a write failure is logged by
// the caller but must never block the allocation path.
export function writeRuntimeState(runtimeId, patch = {}, { event = null, fromState = null, detail = '' } = {}) {
    if (!runtimeId) return null;
    const dir = stateDir();
    try {
        mkdirSync(dir, { recursive: true });
    } catch { /* exists */ }
    let doc = {};
    try {
        doc = JSON.parse(readFileSync(statePathFor(runtimeId), 'utf-8'));
    } catch { /* fresh */ }
    const prev = doc.state || null;
    const merged = Object.assign({}, doc, patch, {
        schema_version: STATE_SCHEMA_VERSION,
        updated_at: new Date().toISOString(),
    });
    for (const k of Object.keys(merged)) {
        if (merged[k] === undefined) delete merged[k];
    }
    const tmp = `${statePathFor(runtimeId)}.tmp.${process.pid}`;
    const payload = JSON.stringify(merged, null, 2) + '\n';
    const fd = openSync(tmp, 'w');
    try {
        writeFileSync(fd, payload, 'utf8');
        // fsync BEFORE rename: the rename is the publish barrier; without the
        // fsync a crash can publish a directory entry whose data never hit
        // disk (the half-state this module exists to prevent).
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(tmp, statePathFor(runtimeId));
    if (event) {
        appendEvent(runtimeId, { event, from_state: fromState || prev, to_state: merged.state || null, detail });
    }
    return merged;
}

// appendEvent(runtimeId, {event, from_state, to_state, detail}): audit-only
// JSONL line; append failure NEVER blocks the main path (spec §3.2: 审计是
// 增强不是契约).
export function appendEvent(runtimeId, { event, from_state = null, to_state = null, detail = '' }) {
    if (!runtimeId || !event) return false;
    try {
        mkdirSync(stateDir(), { recursive: true });
        appendFileSync(eventsPathFor(runtimeId), JSON.stringify({
            ts: new Date().toISOString(), event, from_state, to_state, detail,
        }) + '\n', 'utf8');
        return true;
    } catch {
        return false;
    }
}

// ---- AMEND-1 triple liveness check ----------------------------------------------

// proxyAlive(pid, startedAtMs): kill-0 + /proc/<pid>/exe node + started_at
// comparison. startedAt mismatch (or pid reuse) → DEAD — spec §3.1 PID 复用
// 防御. A null startedAt (legacy record) degrades to the two-check form
// (arbiter precedent) and reports alive according to those checks.
export function proxyAlive(pid, startedAtMs = null) {
    const p = Number(pid);
    if (!Number.isInteger(p) || p <= 0) return false;
    try {
        process.kill(p, 0);
    } catch {
        return false;
    }
    try {
        return readlink_exe(p, startedAtMs);
    } catch {
        return false;
    }
}

function readlink_exe(pid, startedAtMs) {
    const exe = String(readlinkSync(`/proc/${pid}/exe`));
    if (!exe.includes('node')) return false;
    if (startedAtMs != null) {
        // /proc/<pid> directory mtime ≈ process start (tick-derived); compare
        // with 5s tolerance — started_at recorded by the previous writer is
        // Date.now() at ITS process start, and /proc mtime drifts by boot
        // clock skew only.
        let started;
        try {
            started = statSync(`/proc/${pid}`).mtimeMs;
        } catch {
            return false;
        }
        if (Math.abs(started - Number(startedAtMs)) > 5000) return false;
    }
    return true;
}

// heartbeatFresh(state, { maxAgeMs = 10 * 60 * 1000, nowMs }): spec §4.2
// freshness predicate on heartbeat_at.
export function heartbeatFresh(state, { maxAgeMs = 10 * 60 * 1000, nowMs = Date.now() } = {}) {
    if (!state || !state.heartbeat_at) return false;
    const t = Date.parse(state.heartbeat_at);
    if (!Number.isFinite(t)) return false;
    return (nowMs - t) <= maxAgeMs;
}

export {
    statePathFor,
    eventsPathFor,
    heldRuntimeDirFor,
    existsSync,
};
