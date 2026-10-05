// SEE-1356 hardener — proxy-state.mjs branch-completion unit face (vitest,
// in-process). Complements the exit-code harness test_see1356_proxy_units.mjs
// (kept untouched): THIS file is the StrykerJS mutation-test face for the L5
// module, so every assertion here names the mutant class it kills.
//
// Sandbox: HOME / GODOT_MCP_HOME / runtime-id / worktree redirected to a
// mkdtemp BEFORE any proxy-module import (config.mjs reads env at import).
// Runner contract (SEE-1370 hardener): this suite belongs to the SEE-1356 StrykerJS face —
// run it via `npx vitest run --config launch/vitest.see1356.config.ts` (root=launch/). The
// relative imports resolve against launch/ ONLY under that config; plain `node --test`
// or the main vitest config will NOT resolve them (misdiagnosed as env failure 2026-10-05).
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const TEE_PATH = () => path.join(process.env.GODOT_MCP_HOME, 'godot-editor', 'Units-111122223333.proxy.log');

const SB = mkdtempSync(path.join(tmpdir(), 'see1356-ps-unit-'));
process.env.HOME = SB;
process.env.GODOT_MCP_HOME = path.join(SB, '.multica');
process.env.KOL_AGENT_NAME = 'Units';
process.env.GODOT_MCP_RUNTIME_ID = 'Units-111122223333';
const SLOT_WT = path.join(SB, 'multica_workspaces', 'seed-a1b2c3d4e5f6', 'see-u1-111122223333', 'workdir', 'KingOfLikes-Godot');
mkdirSync(path.join(SLOT_WT, 'launch'), { recursive: true });
process.env.GODOT_MCP_WORKTREE = SLOT_WT;
mkdirSync(path.join(process.env.GODOT_MCP_HOME, 'godot-editor'), { recursive: true });

const { S } = await import('../../../proxy/state.mjs');
const {
    PROXY_STATE_SCHEMA, SNAPSHOT_MAX_BYTES, TRANSITION_HISTORY_MAX, HEARTBEAT_PERSIST_MS,
    proxyStatePathFor, proxyCoarseState, rememberWorkdirSnapshot,
    recordProxyTransition, noteProxyCallSummary, fitSnapshotWithin,
    persistProxyState, maybePersistProxyHeartbeat, readProxyStateSnapshot,
    workdirEchoForGetInfo,
} = await import('../../../proxy/proxy-state.mjs');

const STATE_DIR = path.join(process.env.GODOT_MCP_HOME, 'godot-editor');
const SLOT_FILE = path.join(STATE_DIR, 'Units-111122223333.proxy-state.json');
const LEGACY_FILE = path.join(STATE_DIR, 'godot-editor-units.proxy-state.json');
const RECENT_CAP = 10;

beforeEach(() => {
    S.workdirSnapshot = null;
    S.lastTransitions = [];
    S.recentProxyCalls = [];
    S.lastProxyStatePersistMs = 0;
    S.warm = false; S.recovering = false; S.warmupTimedOut = false;
    S.spawnTriggered = false; S.spawnInFlight = null;
    // SEE-1356 D2: the coarse-state vocabulary face also flips the terminal
    // family flags — reset them with the rest or tests leak state.
    S.spawnTerminal = false; S.giveUpArmedAt = 0;
    for (const k of Object.keys(S.stageTimestamps)) S.stageTimestamps[k] = null;
});

afterEach(() => {
    // restore the shared-S flags each test may have flipped
    S.warm = false; S.recovering = false; S.warmupTimedOut = false;
    S.spawnTriggered = false; S.spawnInFlight = null;
    S.spawnTerminal = false; S.giveUpArmedAt = 0;
});

// ——— dual-form naming contract (runtime_id 键, port 键否决) ————————————————
describe('proxyStatePathFor dual-form naming boundary matrix', () => {
    // kills: {8,12}→{8,} (13-hex would land slot form), {8,12}→{8} (12-hex
    // giveup-fix regression), hex-class → [0-9a-fA-F], ^[A-Za-z] → \w,
    // '-solo' guard removal, '*' guard removal.
    const cases = [
        ['Units-111122223333', `${STATE_DIR}/Units-111122223333.proxy-state.json`, 'slot 12-hex (giveup-fix twin)'],
        ['Units-11112222', `${STATE_DIR}/Units-11112222.proxy-state.json`, 'slot 8-hex legacy layout'],
        ['units-111122223333', `${STATE_DIR}/units-111122223333.proxy-state.json`, 'lowercase first letter still slot form'],
        ['Bo_chi-111122223333', `${STATE_DIR}/Bo_chi-111122223333.proxy-state.json`, 'underscore in name part is legal ([A-Za-z0-9_-])'],
        ['Units-1111222', LEGACY_FILE, '7-hex tail below the {8,} floor → legacy'],
        ['Units-1111222233334', LEGACY_FILE, '13-hex tail above the {8,12} cap → legacy'],
        ['Units-zzzz', LEGACY_FILE, 'non-hex tail → legacy'],
        ['1Units-111122223333', LEGACY_FILE, 'digit-first name → legacy'],
        ['Units-solo', LEGACY_FILE, '-solo → legacy (F3 lifecycle exemption)'],
        ['*', LEGACY_FILE, 'bare star → legacy'],
        ['', LEGACY_FILE, 'empty id → legacy'],
    ];
    for (const [rid, expected, why] of cases) {
        test(`naming: ${why}`, () => {
            expect(proxyStatePathFor(rid)).toBe(path.normalize(expected));
        });
    }
    test('mutual exclusion: slot form and legacy form never collide', () => {
        for (const rid of ['Units-111122223333', 'Units-11112222', 'units-111122223333']) {
            expect(proxyStatePathFor(rid)).not.toBe(LEGACY_FILE);
        }
        expect(proxyStatePathFor('Units-solo')).not.toBe(SLOT_FILE);
    });
    test('defaults to the runtime env id', () => {
        expect(proxyStatePathFor()).toBe(SLOT_FILE);
    });
});

// ——— coarse-state vocabulary (godot-status/doctor consumer contract) ————————
// SEE-1356 D2 corrected vocabulary: failed_exit (terminal family: T4 latch OR
// armed give-up) > recovering > warm > warming > cold_idle. The T2 warm-branch
// form (S.warm && S.recovering) must read `recovering` — the doctor
// (recovering,*) arbitration rows were unreachable under the old warm-first
// priority (QA FAIL defect D2②).
describe('proxyCoarseState transition vocabulary', () => {
    // kills: branch deletion in the precedence chain — each mutant reorders or
    // removes one arm and exactly one pin flips.
    test('recovering over warm (D2②: T2 warm branch reads recovering)', () => { S.warm = true; S.recovering = true; expect(proxyCoarseState()).toBe('recovering'); });
    test('failed_exit over recovering+warm (terminal family wins)', () => { S.warm = true; S.recovering = true; S.warmupTimedOut = true; expect(proxyCoarseState()).toBe('failed_exit'); });
    test('armed give-up reads failed_exit (D2①: spawn-terminal FAILED_CLEAN)', () => { S.warmupTimedOut = false; S.spawnTerminal = false; S.giveUpArmedAt = Date.now(); S.warm = true; S.recovering = true; expect(proxyCoarseState()).toBe('failed_exit'); });
    test('legacy spawn-terminal reads failed_exit', () => { S.giveUpArmedAt = 0; S.spawnTerminal = true; expect(proxyCoarseState()).toBe('failed_exit'); });
    test('warm alone', () => { S.warm = true; S.spawnTerminal = false; S.recovering = false; expect(proxyCoarseState()).toBe('warm'); });
    test('failed_exit over warming', () => { S.warm = false; S.warmupTimedOut = true; S.spawnTriggered = true; expect(proxyCoarseState()).toBe('failed_exit'); });
    test('spawnTriggered → warming', () => { S.warmupTimedOut = false; S.spawnTriggered = true; expect(proxyCoarseState()).toBe('warming'); });
    test('spawnInFlight → warming', () => { S.spawnInFlight = {}; expect(proxyCoarseState()).toBe('warming'); });
    test('cold_idle default', () => { S.warm = false; S.spawnTriggered = false; S.spawnInFlight = null; expect(proxyCoarseState()).toBe('cold_idle'); });
});

// ——— workdir snapshot (§SPEC-L2-03) ————————————————————————————————————————
describe('rememberWorkdirSnapshot', () => {
    test('memoizes: second call returns the SAME object, no re-resolve', () => {
        const a = rememberWorkdirSnapshot();
        const b = rememberWorkdirSnapshot();
        expect(b).toBe(a);
        expect(a).toEqual({ runtime_id: 'Units-111122223333', worktree: SLOT_WT, workdir_hash: '111122223333', hash_source: 'slot' });
    });
    test('empty worktree → null hash + null source (never a local re-derivation)', () => {
        delete S.workdirSnapshot;
        const wt = process.env.GODOT_MCP_WORKTREE;
        delete process.env.GODOT_MCP_WORKTREE;
        delete process.env.KOL_WORKTREE;
        try {
            const snap = rememberWorkdirSnapshot();
            expect(snap.worktree).toBeNull();
            expect(snap.workdir_hash).toBeNull();
            expect(snap.hash_source).toBeNull();
        } finally {
            process.env.GODOT_MCP_WORKTREE = wt;
            delete S.workdirSnapshot;
        }
    });
});

// ——— transition ledger + call summaries ————————————————————————————————————
describe('recordProxyTransition / noteProxyCallSummary', () => {
    test('entry without detail carries NO detail key', () => {
        recordProxyTransition('T1_warming_enter');
        const last = S.lastTransitions.at(-1);
        expect(last.trigger).toBe('T1_warming_enter');
        expect('detail' in last).toBe(false);
        expect(readProxyStateSnapshot().last_transitions.at(-1).trigger).toBe('T1_warming_enter');
    });
    test('detail longer than 200 chars is sliced (bounded artifact)', () => {
        recordProxyTransition('T4_give_up_rearm', 'x'.repeat(500));
        expect(S.lastTransitions.at(-1).detail).toHaveLength(200);
    });
    test('history capped at 10, oldest dropped', () => {
        for (let i = 0; i < TRANSITION_HISTORY_MAX + 4; i++) recordProxyTransition('T1_warming_enter', `n=${i}`);
        expect(S.lastTransitions).toHaveLength(TRANSITION_HISTORY_MAX);
        expect(S.lastTransitions[0].detail).toBe(`n=4`);
        expect(S.lastTransitions.at(-1).detail).toBe(`n=${TRANSITION_HISTORY_MAX + 3}`);
    });
    test('call summary: held/rejected kinds, arg_lens by type, cap 10, values never present', () => {
        noteProxyCallSummary({ params: { name: 'read_data', arguments: { p: 'abcd', q: null, u: undefined, r: { z: 1 } } } }, 'held');
        noteProxyCallSummary({ params: { name: 'screenshot_game', arguments: {} } }, 'anything-else');
        noteProxyCallSummary(null, 'held');
        noteProxyCallSummary({ params: { name: 42 } }, 'held');
        const first = S.recentProxyCalls.find((c) => c.tool === 'read_data');
        expect(first).toMatchObject({ kind: 'held', arg_keys: ['p', 'q', 'u', 'r'], arg_lens: [4, 0, 0, 7] });
        noteProxyCallSummary({ params: { name: 'wide', arguments: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`k${i}`, i])) } }, 'held');
        expect(S.recentProxyCalls.find((c) => c.tool === 'wide').arg_keys).toHaveLength(12); // keys capped at 12
        expect(S.recentProxyCalls.find((c) => c.tool === 'screenshot_game').kind).toBe('rejected');
        expect(S.recentProxyCalls.find((c) => c.tool === '<unknown>')).toBeTruthy();
        for (let i = 0; i < RECENT_CAP + 2; i++) {
            noteProxyCallSummary({ params: { name: `t${i}`, arguments: { a: 'x' } } }, 'held');
        }
        expect(S.recentProxyCalls).toHaveLength(10);
        expect(S.recentProxyCalls.at(-1).tool).toBe(`t${RECENT_CAP + 1}`);
        expect(S.recentProxyCalls[0].tool).toBe('t2');
        const raw = JSON.stringify(S.recentProxyCalls);
        expect(raw).not.toContain('"abcd"');
        expect(raw).not.toContain('z":1');
    });
});

// ——— 8KB budget (§SPEC-L5-01 截断逐级降档) ——————————————————————————————————
describe('fitSnapshotWithin size budget', () => {
    test('under budget → no drops, truncated=false', () => {
        const small = { schema: PROXY_STATE_SCHEMA, runtime_id: 'r', state: 'warm', last_transitions: [] };
        const { doc, truncated } = fitSnapshotWithin(small);
        expect(truncated).toBe(false);
        expect(doc.dropped_fields).toBeUndefined();
        expect(doc).toEqual(small);
    });
    test('exact budget boundary does NOT drop', () => {
        const skeleton = JSON.stringify({ schema: 'x', blob: '' });
        const exact = { schema: 'x', blob: 'a'.repeat(SNAPSHOT_MAX_BYTES - skeleton.length) };
        expect(Buffer.byteLength(JSON.stringify(exact))).toBe(SNAPSHOT_MAX_BYTES);
        const { doc, truncated } = fitSnapshotWithin(exact);
        expect(truncated).toBe(false);
        expect(doc.blob).toBe(exact.blob);
    });
    test('one byte over budget drops exactly ONE field (the least-diagnostic present one)', () => {
        // self-calibrated: the POST-drop shape fits the budget exactly, the
        // PRE-drop shape (recent_calls entry > dropped_fields bookkeeping
        // overhead) exceeds it — so exactly one drop happens.
        const postDropSkeleton = JSON.stringify({ schema: 'x', blob: '', dropped_fields: ['recent_calls'] });
        const blobLen = SNAPSHOT_MAX_BYTES - postDropSkeleton.length;
        const over = {
            schema: 'x',
            blob: 'a'.repeat(blobLen),
            recent_calls: [{ tool: 'x'.repeat(60) }],
        };
        expect(Buffer.byteLength(JSON.stringify(over))).toBeGreaterThan(SNAPSHOT_MAX_BYTES);
        const { doc, truncated } = fitSnapshotWithin(over);
        expect(truncated).toBe(true);
        expect(doc.recent_calls).toBeUndefined();
        expect(doc.dropped_fields).toEqual(['recent_calls']);
        expect(doc.blob).toBe(over.blob);
    });
    test('drop order: stageTimestamps → recent_calls → warmupDiagnostic → last_transitions', () => {
        // self-calibrated: blob (NOT in the drop order) is sized so the doc
        // stays over budget until ALL FOUR fields are dropped, then fits —
        // pinning the exact drop sequence without hand-computed sizes.
        const identity = { schema: 'x', runtime_id: 'r', state: 'warm' };
        const lt = [{ at: 't', trigger: 'x'.repeat(200) }];
        const identitySize = JSON.stringify(identity).length;
        const ltSize = JSON.stringify(lt).length;
        const big = {
            ...identity,
            blob: 'z'.repeat(SNAPSHOT_MAX_BYTES - identitySize - ltSize + 50),
            stageTimestamps: { A: 'y'.repeat(4000) },
            recent_calls: [{ tool: 't'.repeat(4000) }],
            warmupDiagnostic: { hint: 'h'.repeat(4000) },
            last_transitions: lt,
        };
        expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(SNAPSHOT_MAX_BYTES);
        const { doc, truncated } = fitSnapshotWithin(big);
        expect(truncated).toBe(true);
        expect(doc.dropped_fields).toEqual([
            'stageTimestamps', 'recent_calls', 'warmupDiagnostic', 'last_transitions',
        ]);
        expect(doc.state).toBe('warm');
        expect(doc.blob).toBe(big.blob);
    });
    test('all four drops still over → hard-slice identity fields + overflow marker', () => {
        // blob is NOT in the drop order, so it survives every drop and forces
        // the loop to exhaust all four fields before hard-slicing.
        const big = {
            schema: 'x', runtime_id: 'r', state: 'warm',
            stageTimestamps: { A: 'y'.repeat(3000) },
            recent_calls: [{ tool: 't'.repeat(3000) }],
            warmupDiagnostic: { hint: 'h'.repeat(3000) },
            last_transitions: [{ at: 't', trigger: 'x'.repeat(200) }],
            blob: 'z'.repeat(8200),
        };
        const { doc, truncated } = fitSnapshotWithin(big);
        expect(truncated).toBe(true);
        expect(doc.truncated).toBe(true);
        expect(doc.dropped_fields).toEqual([
            'stageTimestamps', 'recent_calls', 'warmupDiagnostic', 'last_transitions', 'overflow_hard_slice',
        ]);
        expect(Object.keys(doc).sort()).toEqual(['dropped_fields', 'runtime_id', 'schema', 'state', 'truncated']);
    });
    test('hard-slice keeps only the identity fields + explicit marker', () => {
        const hard = fitSnapshotWithin({ schema: 'x', runtime_id: 'r', state: 'warm', blob: 'z'.repeat(20000) });
        expect(hard.truncated).toBe(true);
        expect(hard.doc.truncated).toBe(true);
        expect(hard.doc.dropped_fields).toContain('overflow_hard_slice');
        expect(Object.keys(hard.doc).sort()).toEqual(['dropped_fields', 'runtime_id', 'schema', 'state', 'truncated']);
    });
});

// ——— zero-event-zero-write + heartbeat window (§SPEC-L5-01 单测部分) —————————
describe('persist/heartbeat write discipline', () => {
    test('first heartbeat persists (warming runtime lands an early snapshot)', () => {
        S.lastProxyStatePersistMs = 0;
        maybePersistProxyHeartbeat();
        const doc = readProxyStateSnapshot();
        expect(doc.trigger).toBe('heartbeat');
    });
    test('window expiry (≥30s) → heartbeat DOES write', () => {
        persistProxyState('seed');
        const before = readProxyStateSnapshot();
        S.lastProxyStatePersistMs = Date.now() - HEARTBEAT_PERSIST_MS - 1;
        maybePersistProxyHeartbeat();
        const after = readProxyStateSnapshot();
        expect(after.trigger).toBe('heartbeat');
        expect(after.heartbeat_at).not.toBe(before.heartbeat_at);
    });
    test('persist failure → null + no throw + previous snapshot intact', () => {
        persistProxyState('seed');
        const intact = readFileSync(SLOT_FILE, 'utf8');
        chmodSync(STATE_DIR, 0o500);
        try {
            expect(persistProxyState('doomed')).toBeNull();
        } finally {
            chmodSync(STATE_DIR, 0o700);
        }
        expect(readFileSync(SLOT_FILE, 'utf8')).toBe(intact);
    });
    test('snapshot doc field completeness + stderr_tail exclusion + 8KB fit', () => {
        recordProxyTransition('T2_recovering_enter', 'unit');
        noteProxyCallSummary({ params: { name: 't', arguments: { a: 1 } } }, 'held');
        const file = persistProxyState('unit_full');
        expect(file).toBe(SLOT_FILE);
        // the 8KB budget applies to the compact serialization (the file adds
        // indent-2 pretty-printing, so judge the parsed doc's compact size)
        expect(JSON.stringify(JSON.parse(readFileSync(SLOT_FILE, 'utf8'))).length).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
        const doc = JSON.parse(readFileSync(SLOT_FILE, 'utf8'));
        for (const k of ['schema', 'updated_at', 'trigger', 'runtime_id', 'worktree', 'workdir_hash',
            'hash_source', 'state', 'stage', 'port', 'pid', 'elapsed_ms', 'hold_queue_depth',
            'spawn_attempts', 'spawn_failed_streak', 'last_error_bucket', 'give_up_count',
            'warm', 'warmupDiagnostic', 'last_transitions', 'recent_calls', 'heartbeat_at']) {
            expect(doc, `missing field ${k}`).toHaveProperty(k);
        }
        expect(doc).not.toHaveProperty('stderr_tail');
        expect(doc.schema).toBe('see1356-l5-proxy-state/1');
        expect(doc.port).toBeNull(); // no GODOT_PORT in sandbox → strict null (not undefined)
    });
    test('persist without a trigger defaults to "unspecified"', () => {
        // kills: the `trigger = 'unspecified'` default-parameter literal
        const before = S.lastTransitions.length;
        persistProxyState();
        expect(readProxyStateSnapshot().trigger).toBe('unspecified');
        expect(S.lastTransitions.length).toBe(before); // no transition side effect
    });
    test('state counters ride the doc verbatim (strict-warm + buckets)', () => {
        // kills: `warm: S.warm === true` equality mutants (truthy non-true
        // must NOT read warm), bucket/count field mutants, elapsed anchor
        // fallback (spawnStartedAt=0 → startedAt).
        const before = { ...S };
        S.spawnFailedStreak = 3;
        S.spawnFailedBucket = 'editor_busy';
        S.giveUpCount = 2;
        S.spawnAttempts = 5;
        S.warm = 1; // truthy but NOT true — strict equality must say false
        S.pendingCalls = [{}, {}];
        S.spawnStartedAt = 0;
        try {
            persistProxyState('counters');
            const doc = readProxyStateSnapshot();
            expect(doc.warm).toBe(false);
            expect(doc.spawn_failed_streak).toBe(3);
            expect(doc.last_error_bucket).toBe('editor_busy');
            expect(doc.give_up_count).toBe(2);
            expect(doc.spawn_attempts).toBe(5);
            expect(doc.hold_queue_depth).toBe(2);
        } finally {
            Object.assign(S, before);
        }
        S.warm = true;
        persistProxyState('counters-warm');
        expect(readProxyStateSnapshot().warm).toBe(true);
    });
    test('elapsed_ms anchored to spawnStartedAt when present, startedAt otherwise', () => {
        // kills: `now - (S.spawnStartedAt || S.startedAt)` arithmetic and
        // fallback-order mutants (a wrong anchor yields a wildly different ms).
        S.spawnStartedAt = Date.now() - 1000;
        persistProxyState('elapsed-seeded');
        const seeded = readProxyStateSnapshot().elapsed_ms;
        expect(seeded).toBeGreaterThanOrEqual(990);
        expect(seeded).toBeLessThan(60000);
        S.spawnStartedAt = 0;
        persistProxyState('elapsed-fallback');
        const fallback = readProxyStateSnapshot().elapsed_ms;
        expect(fallback).toBeGreaterThanOrEqual(0);
        expect(fallback).toBeLessThan(60000);
        expect(Math.abs(fallback - seeded)).toBeLessThan(60000);
    });
    test('persist failure surfaces the structured WARNING into the tee', async () => {
        // kills: the catch-path log-message literals (post-hoc greppability
        // of "persist failed" is the observability contract). The state write
        // is sabotaged via the tmp path pre-created as a DIRECTORY (write
        // fails; the tee dir stays writable so the WARNING still lands).
        // resetProxyLogForTest clears a possibly-poisoned lazy-open cache
        // (the earlier chmod-500 case degrades the tee to stderr-only).
        const { resetProxyLogForTest } = await import('../../../proxy/log.mjs');
        resetProxyLogForTest();
        mkdirSync(`${SLOT_FILE}.tmp.${process.pid}`, { recursive: true });
        try {
            expect(persistProxyState('doomed')).toBeNull();
        } finally {
            rmSync(`${SLOT_FILE}.tmp.${process.pid}`, { recursive: true, force: true });
        }
        const tee = readFileSync(TEE_PATH(), 'utf8');
        expect(tee).toContain('WARNING: persistProxyState failed');
    });
    test('heartbeat throttle boundary: age < window throttles, age == window writes', () => {
        // kills: `< HEARTBEAT_PERSIST_MS` strictness mutants (<= would
        // throttle at exactly the window edge too).
        persistProxyState('seed');
        S.lastProxyStatePersistMs = Date.now() - HEARTBEAT_PERSIST_MS + 1;
        maybePersistProxyHeartbeat();
        expect(readProxyStateSnapshot().trigger).not.toBe('heartbeat'); // inside window → throttled
        S.lastProxyStatePersistMs = Date.now() - HEARTBEAT_PERSIST_MS;
        maybePersistProxyHeartbeat();
        expect(readProxyStateSnapshot().trigger).toBe('heartbeat'); // exact edge → writes (strict <)
    });
});

// ——— reader degradation (§SPEC-L2-03 null 语义) —————————————————————————————
describe('readProxyStateSnapshot / workdirEchoForGetInfo degradation', () => {
    test('corrupt snapshot JSON → null (not a throw)', () => {
        writeFileSync(SLOT_FILE, '{not json', 'utf8');
        expect(readProxyStateSnapshot()).toBeNull();
    });
    test('empty doc {} → snapshot_absent (no workdir evidence at all)', () => {
        writeFileSync(SLOT_FILE, '{}', 'utf8');
        expect(workdirEchoForGetInfo()).toEqual({ runtime_id: null, worktree: null, workdir_hash: null, hash_source: 'snapshot_absent' });
    });
    test('LOW1: doc missing EITHER schema key (workdir_hash XOR worktree) → snapshot_absent, no fabricated echo', () => {
        // The snapshot schema always writes BOTH keys; a doc carrying only one
        // is not a workdir snapshot — echoing its half-truth as evidence would
        // fabricate nulls, so the explicit contract classifies it absent.
        writeFileSync(SLOT_FILE, JSON.stringify({ worktree: '/wt', runtime_id: 'R-111122223333' }), 'utf8');
        expect(workdirEchoForGetInfo()).toEqual({ runtime_id: null, worktree: null, workdir_hash: null, hash_source: 'snapshot_absent' });
        writeFileSync(SLOT_FILE, JSON.stringify({ workdir_hash: 'ab12cd34' }), 'utf8');
        expect(workdirEchoForGetInfo()).toEqual({ runtime_id: null, worktree: null, workdir_hash: null, hash_source: 'snapshot_absent' });
    });
    test('both schema keys present → triple echoes (hash may be the stored null-degradation)', () => {
        writeFileSync(SLOT_FILE, JSON.stringify({ worktree: '/wt', workdir_hash: null, hash_source: 'slot', runtime_id: 'R-111122223333' }), 'utf8');
        expect(workdirEchoForGetInfo()).toEqual({
            runtime_id: 'R-111122223333', worktree: '/wt', workdir_hash: null, hash_source: 'slot',
        });
    });
    test('absent → snapshot_absent; legacy-named rid reads by its own name when the schema is complete', () => {
        rmSync(SLOT_FILE, { force: true });
        expect(workdirEchoForGetInfo('Nobody-99998888')).toEqual({ runtime_id: null, worktree: null, workdir_hash: null, hash_source: 'snapshot_absent' });
        // LOW1 contract: only a COMPLETE schema doc echoes — the legacy file
        // gains a worktree key so the both-keys-present gate passes.
        writeFileSync(LEGACY_FILE, JSON.stringify({ workdir_hash: 'ab12cd34', worktree: '/legacy-wt' }), 'utf8');
        const echo = workdirEchoForGetInfo('Weird#Name-1');
        expect(echo).toEqual({ runtime_id: null, worktree: '/legacy-wt', workdir_hash: 'ab12cd34', hash_source: null });
        rmSync(LEGACY_FILE, { force: true });
    });
});
