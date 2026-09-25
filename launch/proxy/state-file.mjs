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
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { GODOT_MCP_HOME } from './config.mjs';

// SEE-1348 WP4 (§SPEC-008): 2→3 — editor_pid becomes a POPULATED field
// (backfilled at the start-godot-editor PID-resolution site + heartbeat
// fallback) with an explicit editor_pid_source. v2 records invalidate to
// NO STATE (cold start) — the designed degradation; every field is
// reconstructable on the next spawn/handoff.
export const STATE_SCHEMA_VERSION = 3;

// Full per-record field set (spec §3.1). Unknown/extra fields survive
// round-trips (readState keeps them; writeState merges).
export const STATE_FIELDS = [
    'schema_version', 'state', 'port', 'editor_pid', 'editor_pid_started_at',
    'editor_pid_source', 'proxy_pid', 'proxy_pid_started_at', 'agent',
    'issue_id', 'worktree', 'lease_id', 'heartbeat_at', 'spawn_attempts',
    'last_error', 'warm_at', 'updated_at',
];

// editor_pid_source values (SEE-1348 WP4, carried EXPLICITLY with the write —
// a bare kill(0) from WSL misjudges Windows PIDs as dead, so every consumer
// must know which side the number belongs to before probing):
//   'wsl'     — a WSL-side pid (interop wrapper); kill(pid,0) is authoritative
//   'windows' — a Windows pid resolved via CIM; Get-Process count probe
//   'pending' — launch triggered, real PID not yet resolved (schema keeps the
//               numeric slot null in this case; the source marks the intent)
export const EDITOR_PID_SOURCES = new Set(['wsl', 'windows', 'pending']);

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
// staleness: a lock whose recorded owner pid is dead is stealable.
//
// SEE-1338 P1 QA 缺陷 #1 (HIGH, Revy 复测): this was `async` with no await —
// the startup handoff call site read `lock.locked` off the raw Promise
// (always undefined) and every start degraded to read-only, silently
// bypassing the whole D2/D3 handoff. Real-machine-only failure: the mock
// suite awaited the same fn, masking the missed await at the production call
// site. Fixed by making it SYNCHRONOUS (all IO below is sync fs) — an async
// signature can no longer lie to future call sites.

function resolveLockContention(dir, ownerPid) {
    // Returns null when the lock is free (or stolen from a dead owner);
    // otherwise a rejection result for the live holder. mkdir {recursive:true}
    // never throws EEXIST — the contention probe is this explicit existsSync
    // + owner check (a live holder was previously never excluded).
    if (!existsSync(dir)) return null;
    try {
        const owner = Number(readFileSync(path.join(dir, 'owner'), 'utf-8').trim());
        if (Number.isInteger(owner) && owner > 0 && owner !== ownerPid && !pidAlive(owner)) {
            rmSync(dir, { recursive: true, force: true });
            return null;
        }
        if (owner !== ownerPid) {
            return { locked: false, holder: Number.isInteger(owner) ? owner : null };
        }
        return null;
    } catch {
        return { locked: false, holder: null };
    }
}

export function acquireRuntimeLock(runtimeId, { ownerPid = process.pid } = {}) {
    const dir = heldRuntimeDirFor(runtimeId);
    const contention = resolveLockContention(dir, ownerPid);
    if (contention) return contention;
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
function validateStateDoc(o) {
    if (!o || typeof o !== 'object') return { ok: false, reason: 'not-object' };
    const sv = Number(o.schema_version);
    if (sv !== STATE_SCHEMA_VERSION) {
        return { ok: false, reason: 'schema-mismatch', schema_version: sv };
    }
    if (!VALID_STATES.has(o.state)) {
        return { ok: false, reason: 'unknown-state', state: String(o.state) };
    }
    if (o.editor_pid_source && !EDITOR_PID_SOURCES.has(String(o.editor_pid_source))) {
        return { ok: false, reason: 'unknown-editor-pid-source', editor_pid_source: String(o.editor_pid_source) };
    }
    return null;
}

export function readRuntimeState(runtimeId) {
    if (!runtimeId) return { ok: false, reason: 'no-runtime-id' };
    let raw;
    try {
        raw = readFileSync(statePathFor(runtimeId), 'utf-8');
    } catch (e) {
        return { ok: false, reason: e && e.code === 'ENOENT' ? 'no-file' : 'unreadable' };
    }
    let o;
    try {
        o = JSON.parse(raw);
    } catch (e) {
        return { ok: false, reason: 'unparseable', error: e && e.message };
    }
    return validateStateDoc(o) || { ok: true, state: o };
}

// ---- write ----------------------------------------------------------------------

// writeRuntimeState(runtimeId, patch, { event, fromState, detail }): merge
// patch over the CURRENT on-disk doc (read-merge-write inside the caller's
// held-runtime lock), bump updated_at, tmp + fsync + atomic rename. Returns
// the merged doc. Fire-and-forget by contract: a write failure is logged by
// the caller but must never block the allocation path.

function readStateDocOrEmpty(runtimeId) {
    try {
        const doc = JSON.parse(readFileSync(statePathFor(runtimeId), 'utf-8'));
        return { doc, prev: doc.state || null };
    } catch {
        return { doc: {}, prev: null };
    }
}

function mergeStateDoc(doc, patch) {
    const merged = Object.assign({}, doc, patch, {
        schema_version: STATE_SCHEMA_VERSION,
        updated_at: new Date().toISOString(),
    });
    for (const k of Object.keys(merged)) {
        if (merged[k] === undefined) delete merged[k];
    }
    return merged;
}

function atomicWriteJson(pathName, payload) {
    const tmp = `${pathName}.tmp.${process.pid}`;
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
    renameSync(tmp, pathName);
}

export function writeRuntimeState(runtimeId, patch = {}, { event = null, fromState = null, detail = '' } = {}) {
    if (!runtimeId) return null;
    try { mkdirSync(stateDir(), { recursive: true }); } catch { /* exists */ }
    const { doc, prev } = readStateDocOrEmpty(runtimeId);
    const merged = mergeStateDoc(doc, patch);
    atomicWriteJson(statePathFor(runtimeId), JSON.stringify(merged, null, 2) + '\n');
    if (event) appendStateEvent(runtimeId, { event, fromState, prev, toState: merged.state, detail });
    return merged;
}

function appendStateEvent(runtimeId, { event, fromState, prev, toState, detail }) {
    appendEvent(runtimeId, {
        event,
        from_state: fromState || prev,
        to_state: toState || null,
        detail,
    });
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

// editorPidAlive(pid, source): SEE-1348 WP4 (§SPEC-008) split-source liveness
// probe — the .state twin of the reaper's pid_alive (reap-stale-leases.sh).
// A bare kill(pid,0) from WSL answers "No such process" for LIVE Windows
// PIDs, so the probe is chosen by the recorded source, never guessed:
//   'wsl'     → kill(pid,0) (EPERM counts as alive: the process exists but is
//               owned by another user)
//   'windows' → Get-Process count probe (windowsPidAlive — name-checked, so a
//               reused PID belonging to a non-Godot process reads dead — the
//               Windows-side twin of the launcher's /proc/<pid>/exe check)
//   any other → false (an unknown SOURCE must not fall back to a wrong probe)
// Return contract (SEE-1348 F-QA-3): true = positively alive, false =
// positively dead, null = PROBE UNAVAILABLE (powershell unresolvable or
// errored). Callers must treat null as unknown and never as dead — a live
// editor on a PATH-less WSL host (appendWindowsPath off) used to read as
// dead here and got cold_start-preempted by the WP7 veto (Revy QA, pid
// 21756 ground-truth alive).
export function editorPidAlive(pid, source) {
    const p = Number(pid);
    if (!Number.isInteger(p) || p <= 0) return false;
    if (source === 'wsl') {
        try {
            process.kill(p, 0);
            return true;
        } catch (e) {
            return e && e.code === 'EPERM';
        }
    }
    if (source === 'windows') return windowsPidAlive(p);
    return false;
}

// powershell resolution chain (F-QA-3): env override → bare PATH name →
// the well-known System32 absolute path. A WSL PATH with appendWindowsPath
// off never resolves the bare name, so the absolute fallback is what keeps
// the probe working on those hosts.
const POWERSHELL_SYSTEM32 = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

function powershellCandidates() {
    const out = [];
    if (process.env.GODOT_MCP_POWERSHELL_PATH) out.push(process.env.GODOT_MCP_POWERSHELL_PATH);
    out.push('powershell.exe');
    out.push(POWERSHELL_SYSTEM32);
    return out;
}

// Get-Process count probe (the reaper's D5b shape): $? is unusable with
// -ErrorAction SilentlyContinue, so the "1 <name>" / "0" count is the probe.
// Degrades to count-only when the process name is unreadable (Access Denied
// on a real editor), so a live editor is never false-negatived.
// Returns true/false for a completed probe, null when no powershell could be
// launched or the probe errored — UNKNOWN, never "dead".
function windowsPidAlive(p) {
    const args = ['-NoProfile', '-Command',
        '$p = Get-Process -Id ' + p + ' -ErrorAction SilentlyContinue; '
        + 'if ($p) { Write-Output ("1 " + $p.ProcessName) } else { Write-Output "0" }'];
    let out = null;
    for (const cand of powershellCandidates()) {
        try {
            out = execFileSync(cand, args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
            break;
        } catch (e) {
            if (e && e.code === 'ENOENT') continue; // candidate unresolvable → next in chain
            return null; // powershell ran but failed (non-zero/timeout) — no verdict
        }
    }
    if (out === null) return null; // no candidate resolvable — unknown
    const line = String(out).trim().split(/\r?\n/)[0] || '';
    const [n, ...nameParts] = line.split(' ');
    if (n !== '1') return false;
    const name = nameParts.join(' ').trim();
    if (name) return /^godot/i.test(name);
    return true; // count=1, name unreadable — trust the count probe
}

export {
    statePathFor,
    eventsPathFor,
    heldRuntimeDirFor,
    existsSync,
};
