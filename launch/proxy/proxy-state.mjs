// proxy/proxy-state.mjs — SEE-1356 L5 (§SPEC-L5-01): the proxy state machine
// snapshot, persisted to disk at state TRANSITION points so godot-status /
// doctor can aggregate without a second truth source.
//
//   $GODOT_MCP_HOME/godot-editor/<runtime_id>.proxy-state.json   (slot form)
//   $GODOT_MCP_HOME/godot-editor/godot-editor-<label>.proxy-state.json (legacy)
//
// Naming follows the persistGiveUpStatus dual-form rule (runtime_id 键，port
// 键被否决：rebind 后 port 键会留尸体文件，新 runtime 读到旧快照 — plan 终裁).
// Write discipline: tmp + rename atomic publish, append-only-free (distinct
// from the L6 log tee), best-effort — a write failure is logged and NEVER
// thrown (observability must not break the call path). stderr_tail is
// deliberately NOT part of the snapshot: the evidence chain for stderr lives
// in the L6 proxy log, not here.
import { mkdirSync, writeFileSync, renameSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { S } from './state.mjs';
import { GODOT_MCP_HOME, GODOT_PORT, RUNTIME_ID } from './config.mjs';
import { warmupDiagnostic } from './diagnostics.mjs';
import { resolveWorkdirHash } from './workdir-hash.mjs';
import { isSlotRuntimeId } from './runtime-id.mjs';
import { log } from './log.mjs';

export const PROXY_STATE_SCHEMA = 'see1356-l5-proxy-state/1';
export const SNAPSHOT_MAX_BYTES = 8 * 1024;
export const TRANSITION_HISTORY_MAX = 10;
export const RECENT_CALL_HISTORY_MAX = 10;
// Heartbeat refresh cadence (spec: heartbeat_at 30s 刷新) — decoupled from the
// 2s registry heartbeat so the snapshot write rate stays low.
export const HEARTBEAT_PERSIST_MS = 30000;

const LEGACY_LABEL = (process.env.GODOT_MCP_AGENT_NAME || process.env.KOL_AGENT_NAME || 'unknown').toLowerCase();

function proxyStateDir() {
    return path.join(GODOT_MCP_HOME, 'godot-editor');
}

// The giveup-file naming rule (SSOT: isSlotRuntimeId): a real slot runtime_id
// uses the per-slot directory form; -solo / manual runs fall back to the
// legacy flat name so the two families never collide.
export function proxyStatePathFor(runtimeId = RUNTIME_ID) {
    const dir = proxyStateDir();
    return isSlotRuntimeId(runtimeId)
        ? path.join(dir, `${runtimeId}.proxy-state.json`)
        : path.join(dir, `godot-editor-${LEGACY_LABEL}.proxy-state.json`);
}

// Current coarse state, same vocabulary godot-status/doctor consume.
// SEE-1356 D2 (批 1 QA FAIL 裁定) vocabulary/priority correction:
//   failed_exit = the TERMINAL family — the legacy T4 latch (S.warmupTimedOut)
//   OR an armed give-up (spawn-terminal FAILED_CLEAN, WS-5: S.spawnTerminal /
//   S.giveUpArmedAt > 0). Derived read-side only — the state-machine fields
//   stay the SSOT, no behavior delta at any write site.
//   recovering outranks warm: in the warm+recovering form (T2 warm branch —
//   editor bound but the CLI never connected) the operative warmup state IS
//   RECOVERING; the previous warm-first priority made the doctor
//   (recovering,*) arbitration rows unreachable on real chains.
export function proxyCoarseState() {
    if (S.warmupTimedOut || S.spawnTerminal || S.giveUpArmedAt > 0) return 'failed_exit';
    if (S.recovering) return 'recovering';
    if (S.warm) return 'warm';
    if (S.spawnTriggered || S.spawnInFlight) return 'warming';
    return 'cold_idle';
}

// rememberWorkdirSnapshot(): SEE-1356 L2 (§SPEC-L2-03) — the (runtime_id,
// worktree, workdir_hash) triple is computed ONCE per process at spawn time
// and stamped into every snapshot. The hash comes from the bash SSOT
// (kol_workdir_hash); a resolution failure stores the null + snapshot_absent
// degradation, never a locally-derived hash.
export function rememberWorkdirSnapshot() {
    if (S.workdirSnapshot) return S.workdirSnapshot;
    const worktree = process.env.GODOT_MCP_WORKTREE || process.env.KOL_WORKTREE || '';
    const resolved = worktree ? resolveWorkdirHash(worktree) : null;
    S.workdirSnapshot = {
        runtime_id: RUNTIME_ID || null,
        worktree: worktree || null,
        workdir_hash: resolved ? resolved.workdir_hash : null,
        hash_source: resolved ? resolved.hash_source : null,
    };
    return S.workdirSnapshot;
}

// recordProxyTransition(trigger, detail): one entry in last_transitions
// (capped) + an immediate snapshot persist — the transition point IS the
// write trigger (T1/T2/T4/spawn_terminal/lease_exit/rearm call sites).
export function recordProxyTransition(trigger, detail = '') {
    // S.lastTransitions is fully initialized by state.mjs — no fallback chain
    // here (SEE-1356 batch-2 cleanup, hardener observation ②: defensive
    // residues under the no-defensive-programming rule).
    const list = S.lastTransitions;
    list.push({
        at: new Date().toISOString(),
        trigger,
        state: proxyCoarseState(),
        stage: S.stage,
        ...(detail ? { detail: String(detail).slice(0, 200) } : {}),
    });
    if (list.length > TRANSITION_HISTORY_MAX) list.splice(0, list.length - TRANSITION_HISTORY_MAX);
    persistProxyState(trigger);
}

// noteProxyCallSummary(msg, kind): held/rejected call summaries — tool name +
// argument KEY NAMES + value lengths only; values never enter the snapshot.
export function noteProxyCallSummary(msg, kind) {
    try {
        const params = msg && msg.params;
        const name = typeof (params && params.name) === 'string' ? params.name : '<unknown>';
        const args = (params && params.arguments) || {};
        const keys = Object.keys(args).slice(0, 12);
        const list = S.recentProxyCalls;
        list.push({
            at: new Date().toISOString(),
            kind: kind === 'held' ? 'held' : 'rejected',
            tool: name,
            arg_keys: keys,
            arg_lens: keys.map((k) => {
                const v = args[k];
                if (typeof v === 'string') return v.length;
                if (v === null || v === undefined) return 0;
                return JSON.stringify(v).length;
            }),
        });
        if (list.length > RECENT_CALL_HISTORY_MAX) list.splice(0, list.length - RECENT_CALL_HISTORY_MAX);
    } catch { /* summary is best-effort; never surface */ }
}

// fitSnapshotWithin(doc, maxBytes): pure size budget — drop order is chosen
// so the evidence value degrades from the least to the most diagnostic:
// stageTimestamps → recent call summaries → warmupDiagnostic → transitions.
// A doc that STILL exceeds the budget after all drops is hard-sliced with an
// explicit truncated marker (never silently under-reported).
export function fitSnapshotWithin(doc, maxBytes = SNAPSHOT_MAX_BYTES) {
    const dropOrder = ['stageTimestamps', 'recent_calls', 'warmupDiagnostic', 'last_transitions'];
    let out = { ...doc };
    const size = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
    for (const key of dropOrder) {
        if (size(out) <= maxBytes) break;
        if (!(key in out)) continue;
        const rest = { ...out };
        delete rest[key];
        out = { ...rest, dropped_fields: [...(out.dropped_fields || []), key] };
    }
    if (size(out) <= maxBytes) return { doc: out, truncated: out.dropped_fields?.length > 0 };
    return {
        doc: {
            schema: out.schema,
            runtime_id: out.runtime_id,
            state: out.state,
            truncated: true,
            dropped_fields: [...(out.dropped_fields || []), 'overflow_hard_slice'],
        },
        truncated: true,
    };
}

// persistProxyState(trigger): build the full snapshot doc and publish it.
// Fire-and-forget by contract: any failure is logged, never thrown.
export function persistProxyState(trigger = 'unspecified') {
    try {
        const now = Date.now();
        const snap = rememberWorkdirSnapshot();
        const doc = {
            schema: PROXY_STATE_SCHEMA,
            updated_at: new Date(now).toISOString(),
            trigger: String(trigger),
            runtime_id: snap.runtime_id,
            worktree: snap.worktree,
            workdir_hash: snap.workdir_hash,
            hash_source: snap.hash_source,
            state: proxyCoarseState(),
            stage: S.stage,
            port: GODOT_PORT || null,
            pid: process.pid,
            elapsed_ms: now - (S.spawnStartedAt || S.startedAt),
            hold_queue_depth: S.pendingCalls.length,
            spawn_attempts: S.spawnAttempts,
            spawn_failed_streak: S.spawnFailedStreak,
            last_error_bucket: S.spawnFailedBucket || null,
            give_up_count: S.giveUpCount,
            warm: S.warm === true,
            warmupDiagnostic: warmupDiagnostic(),
            last_transitions: [...S.lastTransitions],
            recent_calls: [...S.recentProxyCalls],
            heartbeat_at: new Date(now).toISOString(),
        };
        const { doc: fitted } = fitSnapshotWithin(doc);
        const file = proxyStatePathFor();
        mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp.${process.pid}`;
        writeFileSync(tmp, JSON.stringify(fitted, null, 2) + '\n', 'utf8');
        renameSync(tmp, file);
        S.lastProxyStatePersistMs = now;
        return file;
    } catch (err) {
        log(`WARNING: persistProxyState failed: ${err && err.message}`);
        return null;
    }
}

// maybePersistProxyHeartbeat(): 30s-throttled heartbeat refresh. Called from
// the steady-state heartbeat interval; the FIRST call persists too, so a
// warming runtime still lands an early snapshot even before its first
// transition-triggered write.
export function maybePersistProxyHeartbeat() {
    const now = Date.now();
    if (S.lastProxyStatePersistMs && (now - S.lastProxyStatePersistMs) < HEARTBEAT_PERSIST_MS) return;
    persistProxyState('heartbeat');
}

// readProxyStateSnapshot(): reader for the get_info echo (§SPEC-L2-03) and
// tests. Returns the parsed doc, or null when the snapshot is absent or
// unparseable — the CALLER (not this module) turns null into the
// { workdir_hash: null, hash_source: 'snapshot_absent' } wire semantics.
export function readProxyStateSnapshot(runtimeId = RUNTIME_ID) {
    const file = proxyStatePathFor(runtimeId);
    try {
        statSync(file);
    } catch {
        return null;
    }
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

// get_info echo payload (§SPEC-L2-03): snapshot present → the stored triple;
// absent → workdir_hash null + hash_source 'snapshot_absent' (null = unknown,
// never "no hash").
export function workdirEchoForGetInfo(runtimeId = RUNTIME_ID) {
    const snap = readProxyStateSnapshot(runtimeId);
    if (snap && (snap.workdir_hash !== undefined || snap.worktree)) {
        return {
            runtime_id: snap.runtime_id ?? null,
            worktree: snap.worktree ?? null,
            workdir_hash: snap.workdir_hash ?? null,
            hash_source: snap.hash_source ?? null,
        };
    }
    return { runtime_id: null, worktree: null, workdir_hash: null, hash_source: 'snapshot_absent' };
}
