// @ts-nocheck
// test_see1356_proxy_units.mjs — SEE-1356 L3段2/L5/L2 unit harness (exit-code
// contract, run as a plain node script by the vitest FAST_NODE wrapper).
//
//   U1  L3 段2 (§SPEC-L3-01): enrichScreenshotResponse IHDR deep check —
//       empty_base64 / bad_png_header classification + fallback hint
//   U2  L5 (§SPEC-L5-01): transition cap, field completeness, 8KB budget,
//       heartbeat throttle (零事件零写入), get_info echo present/absent
//   U3  L6 (§SPEC-L6-01): log tee single-point write + pid prefix + rotate
//   U4  L2 (§SPEC-L2-01): resolveWorkdirHash SSOT consumer slot/path forms
//
// Sandbox: HOME / GODOT_MCP_HOME redirected to a mkdtemp before ANY import
// (config.mjs reads env at import time).

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SB = mkdtempSync(path.join(tmpdir(), 'see1356-units-'));
process.env.HOME = SB;
process.env.GODOT_MCP_HOME = path.join(SB, '.multica');
process.env.KOL_AGENT_NAME = 'Units';
process.env.GODOT_MCP_RUNTIME_ID = 'Units-111122223333';
// Fixture slot worktree so the workdir hash resolves via the slot 主口径.
const CONTAINER = 'seed-a1b2c3d4e5f6';
const SLOT = 'see-u1-111122223333';
const WT = path.join(SB, 'multica_workspaces', CONTAINER, SLOT, 'workdir', 'KingOfLikes-Godot');
mkdirSync(path.join(WT, 'launch'), { recursive: true });
process.env.GODOT_MCP_WORKTREE = WT;
mkdirSync(path.join(process.env.GODOT_MCP_HOME, 'godot-editor'), { recursive: true });

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
let PASS = 0; let FAIL = 0;
function ok(name, fn) {
    try { fn(); PASS++; console.log(`  [PASS] ${name}`); } catch (e) { FAIL++; console.log(`  [FAIL] ${name} — ${e.message}`); }
}
const REPO_URL = () => `file://${REPO}`;

// ---- U1: L3 段2 IHDR deep check ---------------------------------------------
const contract = await import(`${REPO_URL()}/launch/see1240-screenshot-contract.mjs`);
const WORKTREE = mkdtempSync(path.join(tmpdir(), 'see1356-exp-'));
const imgContent = (data) => [{ type: 'image', data }];
// A real 1x1 PNG.
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

ok('U1a empty base64 → decode_error=empty_base64 + fallback hint', async () => {});
// enrich is async — wrap awaits manually below instead of the sync ok() body.
async function u1() {
    const hint = ' [hint: FALLBACK-MARKER]';
    const r1 = await contract.enrichScreenshotResponse({
        resultContent: imgContent(''), nowMs: 1000, forwardedAtMs: 500,
        worktree: WORKTREE, fallbackHint: hint,
    });
    assert.equal(r1._screenshot.decode_error, 'empty_base64', `got ${r1._screenshot.decode_error}`);
    assert.ok(r1.advisoryText.includes('FALLBACK-MARKER'), 'fallback hint missing from advisory');
    assert.equal(r1.exports.decode_error, 'empty_base64');
    assert.equal(r1.exports.png_path, null, 'no junk export file for empty payload');

    const r2 = await contract.enrichScreenshotResponse({
        resultContent: imgContent(Buffer.from('not a png at all').toString('base64')),
        nowMs: 1000, forwardedAtMs: 500, worktree: WORKTREE, fallbackHint: hint,
    });
    assert.equal(r2._screenshot.decode_error, 'bad_png_header', `got ${r2._screenshot.decode_error}`);
    assert.ok(r2.advisoryText.includes('decode_error=bad_png_header'));

    const r3 = await contract.enrichScreenshotResponse({
        resultContent: imgContent(PNG_1PX.toString('base64')),
        nowMs: 1000, forwardedAtMs: 500, worktree: WORKTREE,
    });
    assert.equal(r3._screenshot.decode_error, undefined);
    assert.ok(r3.exports.png_path && existsSync(r3.exports.png_path), 'valid PNG exported');
    assert.equal(r3.exports.width, 1); assert.equal(r3.exports.height, 1);
}
await u1();

// ---- U2: L5 proxy-state module ----------------------------------------------
const { recordProxyTransition, persistProxyState, fitSnapshotWithin,
    maybePersistProxyHeartbeat, readProxyStateSnapshot, workdirEchoForGetInfo,
    TRANSITION_HISTORY_MAX, SNAPSHOT_MAX_BYTES, proxyStatePathFor } =
    await import(`${REPO_URL()}/launch/proxy/proxy-state.mjs`);

ok('U2a rememberWorkdirSnapshot → SSOT slot hash + provenance', () => {
    persistProxyState('u2a_seed'); // land the snapshot first
    const snap = workdirEchoForGetInfo();
    assert.equal(snap.workdir_hash, '111122223333');
    assert.equal(snap.hash_source, 'slot');
    assert.equal(snap.runtime_id, 'Units-111122223333');
});
ok('U2b transition history capped at 10 + snapshot fields complete', () => {
    for (let i = 0; i < TRANSITION_HISTORY_MAX + 3; i++) recordProxyTransition('T1_warming_enter', `n=${i}`);
    const doc = readProxyStateSnapshot();
    assert.equal(doc.last_transitions.length, TRANSITION_HISTORY_MAX);
    for (const k of ['schema', 'runtime_id', 'worktree', 'workdir_hash', 'hash_source', 'state', 'stage',
        'elapsed_ms', 'hold_queue_depth', 'spawn_attempts', 'last_error_bucket', 'warmupDiagnostic',
        'last_transitions', 'recent_calls', 'heartbeat_at']) {
        assert.ok(k in doc, `missing field ${k}`);
    }
    assert.ok(!('stderr_tail' in doc), 'stderr_tail must NOT enter the snapshot (证据链归 L6)');
});
ok('U2c get_info echo: snapshot present → triple; absent → snapshot_absent', () => {
    const present = workdirEchoForGetInfo();
    assert.equal(present.hash_source, 'slot');
    const absent = workdirEchoForGetInfo('Nobody-99998888');
    assert.equal(absent.workdir_hash, null);
    assert.equal(absent.hash_source, 'snapshot_absent');
});
ok('U2d fitSnapshotWithin 8KB budget → drops in order, hard-slice marker', () => {
    const big = {
        schema: 'x', runtime_id: 'r', state: 'warm',
        stageTimestamps: { A: Array(2000).fill('x').join('') },
        recent_calls: Array(50).fill({ tool: 't', arg_keys: ['a'.repeat(80)] }),
        warmupDiagnostic: { hint: 'h'.repeat(3000) },
        last_transitions: Array(60).fill({ at: 't', trigger: 'x'.repeat(120) }),
    };
    const { doc, truncated } = fitSnapshotWithin(big, SNAPSHOT_MAX_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(doc)) <= SNAPSHOT_MAX_BYTES, 'fitted doc over budget');
    assert.equal(truncated, true);
    assert.ok(Array.isArray(doc.dropped_fields) && doc.dropped_fields.length > 0, 'dropped_fields recorded');
    const hard = fitSnapshotWithin({ schema: 'x', runtime_id: 'r', state: 'warm', blob: 'z'.repeat(20000) }, SNAPSHOT_MAX_BYTES);
    assert.equal(hard.doc.truncated, true);
    assert.ok(hard.doc.dropped_fields.includes('overflow_hard_slice'));
});
ok('U2e 零事件零写入: heartbeat throttle skips writes within 30s window', () => {
    const p = proxyStatePathFor();
    persistProxyState('u2e_seed'); // sets the 30s throttle anchor
    const m1 = statSync(p).mtimeMs;
    maybePersistProxyHeartbeat(); // no new event + window open → NO write
    const m2 = statSync(p).mtimeMs;
    assert.equal(m1, m2, 'heartbeat within the window must not rewrite');
});

// ---- U3: L6 log tee -----------------------------------------------------------
const { log, stageLog, teeStderrLine, rotateIfNeeded, resetProxyLogForTest, proxyLogPath, PROXY_LOG_ROTATE_BYTES } =
    await import(`${REPO_URL()}/launch/proxy/log.mjs`);

ok('U3a log() tee lands in <rid>.proxy.log with pid prefix', () => {
    resetProxyLogForTest();
    log('UNIT-MARKER-1 hello');
    const p = proxyLogPath();
    assert.ok(p.endsWith('Units-111122223333.proxy.log'), `bad path ${p}`);
    const body = readFileSync(p, 'utf8');
    assert.ok(body.includes('UNIT-MARKER-1'), 'log line missing from tee');
    assert.ok(body.includes(`[pid=${process.pid}]`), 'pid prefix missing');
    assert.ok(body.includes('=== proxy start'), 'startup header missing');
    assert.ok(body.includes(`workdir_hash=111122223333`), 'L2 workdir_hash missing from header');
});
ok('U3b stageLog emits machine-greppable stage line into tee', () => {
    stageLog('UNIT_STAGE', 'x=1');
    const body = readFileSync(proxyLogPath(), 'utf8');
    assert.ok(body.includes('[stage=UNIT_STAGE]'), 'stage line missing');
});
ok('U3c teeStderrLine splits multi-line child chunks', () => {
    teeStderrLine('child-a\nchild-b\n');
    const body = readFileSync(proxyLogPath(), 'utf8');
    assert.ok(body.includes('[npx] child-a') && body.includes('[npx] child-b'));
});
ok('U3d rotateIfNeeded: ≥5MB → .1 generation', () => {
    const fake = path.join(SB, 'rotate.log');
    writeFileSync(fake, Buffer.alloc(PROXY_LOG_ROTATE_BYTES + 1, 65));
    rotateIfNeeded(fake);
    assert.ok(!existsSync(fake), 'original rotated away');
    assert.ok(existsSync(`${fake}.1`), '.1 generation exists');
    assert.equal(statSync(`${fake}.1`).size, PROXY_LOG_ROTATE_BYTES + 1);
});

// ---- U4: L2 workdir-hash SSOT consumer ---------------------------------------
const { resolveWorkdirHash } = await import(`${REPO_URL()}/launch/proxy/workdir-hash.mjs`);
ok('U4a slot form + path fallback via the bash SSOT', () => {
    const a = resolveWorkdirHash(WT);
    assert.deepEqual(a, { workdir_hash: '111122223333', hash_source: 'slot' });
    const b = resolveWorkdirHash(REPO);
    assert.ok(/^[0-9a-f]{8}$/.test(b.workdir_hash) && b.hash_source === 'path', JSON.stringify(b));
    assert.equal(resolveWorkdirHash(''), null);
});

console.log(`\nSUMMARY: PASS=${PASS} FAIL=${FAIL}`);
rmSync(SB, { recursive: true, force: true });
rmSync(WORKTREE, { recursive: true, force: true });
process.exit(FAIL === 0 ? 0 : 1);
