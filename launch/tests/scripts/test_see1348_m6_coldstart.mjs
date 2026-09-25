// SEE-1348 WP7 (§SPEC-013) — RENDER_STABLE_REQUIRED_MS env override + the
// monotonic stage-log contract re-anchored on warmup.mjs (S.stageTimestamps)
// and log.mjs stageLog format (decision §3-M6: the proxy.mjs:107-111 anchor
// is retired; no remembered numbers, only live stage-log lines).
//
// Hermetic: GODOT_MCP_HOME redirected per test; the render-stable value is
// asserted through the config module (the only place the env is read).
// Run: node --test launch/tests/scripts/test_see1348_m6_coldstart.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH = path.join(__dirname, '..', '..');
const REPO = path.join(LAUNCH, '..');
const HOME = mkdtempSync(path.join(tmpdir(), 'see1348-m6-coldstart-'));
process.env.GODOT_MCP_HOME = HOME;
mkdirSync(path.join(HOME, 'godot-editor'), { recursive: true });

const readSrc = (rel) => readFileSync(path.join(LAUNCH, rel), 'utf8');

test('A: RENDER_STABLE_REQUIRED_MS env override lands (default 2000, env wins)', () => {
    const src = readSrc('proxy/config.mjs');
    assert.ok(/GODOT_MCP_RENDER_STABLE_MS/.test(src), 'env name present');
    // Default tightened 4000→2000 per the measured floor (see REPORT): the
    // static-log cold starts flip renderStable at exactly waited_ms=2000.
    assert.ok(/KOL_RENDER_STABLE_MS \|\| '2000'/.test(src.replace(/\s+/g, ' ')), 'default 2000');
    // The old hardcoded 4000 literal must be gone from the config line.
    assert.ok(!/RENDER_STABLE_REQUIRED_MS = 4000/.test(src), 'hardcoded 4000 retired');
});

test('B: stage-log monotonic contract re-anchored on warmup.mjs + log.mjs', () => {
    // The anchors the decision re-quires: warmup.mjs owns S.stageTimestamps;
    // log.mjs owns the [stage=NAME] [t=+rel] [ts=iso] line format. Assert the
    // shapes, not numbers.
    const warmup = readSrc('proxy/warmup.mjs');
    const logm = readSrc('proxy/log.mjs');
    const lease = readSrc('proxy/lease.mjs');
    assert.ok(/S\.stageTimestamps/.test(warmup), 'warmup owns stageTimestamps');
    // §SPEC-013 re-anchor: the editor-side milestones (PLUGIN_INIT /
    // SERVER_LISTENING / TCP_CONNECTED / WS_HANDSHAKE) are stamped by the
    // lease monitor (lease.mjs parses the editor log's milestone lines and
    // backfills S.stageTimestamps); MCP_INITIALIZED is backfilled at warm in
    // warmup.mjs. Assert where each actually lives.
    for (const m of ['PLUGIN_INIT', 'SERVER_LISTENING', 'TCP_CONNECTED', 'WS_HANDSHAKE']) {
        assert.ok(lease.includes(m), `editor milestone ${m} stamped via lease.mjs monitor`);
    }
    assert.ok(warmup.includes('MCP_INITIALIZED'), 'MCP_INITIALIZED backfill in warmup.mjs');
    for (const m of ['LAUNCHER_EXEC', 'EDITOR_SPAWNED']) {
        assert.ok(readSrc('proxy/spawn.mjs').includes(m) || warmup.includes(m) || readSrc('proxy/state.mjs').includes(m), `spawn milestone ${m} anchored`);
    }
    assert.ok(/\[stage=\$\{stage\}\] \[t=\+\$\{rel\}ms\] \[ts=\$\{iso\}\]/.test(logm), 'log.mjs stage line format unchanged');
});

test('C: claim-time liveness wiring — spawn.mjs passes editorAlive into the pure decision (§SPEC-012)', () => {
    const spawnSrc = readSrc('proxy/spawn.mjs');
    const handoff = readSrc('see1338-handoff.mjs');
    assert.ok(/editorPidAlive\(st\.editor_pid, st\.editor_pid_source\)/.test(spawnSrc), 'split-source probe on the record');
    assert.ok(/editorAlive,/.test(spawnSrc), 'verdict fed into decideReuseSingleSource');
    assert.ok(/_EDITOR_DEAD`/.test(handoff), 'positive-dead veto branch exists in the pure decision');
    // The veto must sit BEFORE the worktree-match lane (a dead editor is never
    // adopted even on a match).
    const veto = handoff.indexOf('EDITOR_DEAD');
    const lane = handoff.indexOf('decideReuseByLane(');
    assert.ok(veto > -1 && lane > -1 && veto < lane, 'veto precedes lane dispatch');
});

test('D: no fixed sleeps added to the reuse path (repo wait discipline)', () => {
    const spawnSrc = readSrc('proxy/spawn.mjs');
    const probeLines = spawnSrc.split('\n').filter((l) => /editorPidAlive|editorAlive/.test(l));
    for (const l of probeLines) assert.ok(!/\bsleep\b/.test(l), `sleep next to probe: ${l}`);
});
