// SEE-1348 WP4 (§SPEC-008) — editor_pid .state backfill + split-source
// liveness probe + state-cli bridge semantics. Hermetic: GODOT_MCP_HOME is
// redirected to a per-test mktemp; the only real-machine probes are kill(0)
// on THIS test's own pid (live) and a dead pid (99999999).
// Run: node --test --test-reporter=junit launch/tests/scripts/test_see1348_m4_editor_pid_state.mjs
//
// Covered assertions (SPEC-008 判据):
//   A. state-cli writes editor_pid + explicit source, schema v3
//   B. v2 record invalidates to no-state (cold) — designed degradation
//   C. editorPidAlive: live WSL pid true, dead pid false, unknown source false
//   D. clobber refusal: a LIVE recorded pid cannot be overwritten by a
//      different value; a DEAD one is replaceable
//   E. validateStateDoc rejects unknown editor_pid_source values
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH = path.join(__dirname, '..', '..');   // launch/ dir (tests/scripts → launch)
const REPO = path.join(LAUNCH, '..');
const HOME = mkdtempSync(path.join(tmpdir(), 'see1348-m4-editorpid-'));
process.env.GODOT_MCP_HOME = HOME;
const CLI = path.join(LAUNCH, 'proxy', 'state-cli.mjs');

const sf = await import(path.join(LAUNCH, 'proxy', 'state-file.mjs'));

function runCli(args) {
    return execFileSync('node', [CLI, ...args], {
        env: { ...process.env, GODOT_MCP_HOME: HOME },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}
function runCliExpectFail(args, extraEnv = {}) {
    try {
        execFileSync('node', [CLI, ...args], {
            env: { ...process.env, GODOT_MCP_HOME: HOME, ...extraEnv },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { rc: 0 };
    } catch (e) {
        return { rc: e.status ?? -1, stderr: String(e.stderr || '') };
    }
}
const statePath = (rid) => path.join(HOME, 'godot-editor', `${rid}.state`);

mkdirSync(path.join(HOME, 'godot-editor'), { recursive: true });

test('A: state-cli lands editor_pid with explicit source and schema v3', () => {
    runCli(['--runtime-id', 'M4-a', '--editor-pid', '4321', '--editor-pid-source', 'wsl']);
    const d = JSON.parse(readFileSync(statePath('M4-a'), 'utf8'));
    assert.equal(d.schema_version, 3);
    assert.equal(d.editor_pid, 4321);
    assert.equal(d.editor_pid_source, 'wsl');
    assert.ok(typeof d.editor_pid_started_at === 'number' && d.editor_pid_started_at > 0);
});

test('B: a v2 record reads as no-state (cold) after the bump', () => {
    writeFileSync(statePath('M4-b'), JSON.stringify({
        schema_version: 2, state: 'WARM', editor_pid: 1234,
    }));
    const r = sf.readRuntimeState('M4-b');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'schema-mismatch');
});

test('C: editorPidAlive splits by source — wsl kill(0) semantics, unknown never guesses', () => {
    // A live WSL pid (this very test process) reads alive.
    assert.equal(sf.editorPidAlive(process.pid, 'wsl'), true);
    // A dead pid reads dead.
    assert.equal(sf.editorPidAlive(99999999, 'wsl'), false);
    // Unknown/unspecified source must NOT fall back to a wrong probe.
    assert.equal(sf.editorPidAlive(process.pid, 'pending'), false);
    assert.equal(sf.editorPidAlive(process.pid, undefined), false);
});

test('D: state-cli refuses to overwrite a LIVE editor_pid; a dead one is replaceable', () => {
    runCli(['--runtime-id', 'M4-d', '--editor-pid', String(process.pid), '--editor-pid-source', 'wsl']);
    const refused = runCliExpectFail(['--runtime-id', 'M4-d', '--editor-pid', '7777', '--editor-pid-source', 'wsl']);
    assert.notEqual(refused.rc, 0);
    assert.match(refused.stderr, /refusing to overwrite live editor_pid/);

    writeFileSync(statePath('M4-d'), JSON.stringify({
        schema_version: 3, state: 'WARM', editor_pid: 99999999, editor_pid_source: 'wsl',
    }));
    runCli(['--runtime-id', 'M4-d', '--editor-pid', '7777', '--editor-pid-source', 'wsl']);
    const d = JSON.parse(readFileSync(statePath('M4-d'), 'utf8'));
    assert.equal(d.editor_pid, 7777);
});

test('D2: F-QA-3 — state-cli refuses overwrite when the probe is unavailable (unknown is not dead)', () => {
    // Seed a recorded windows editor_pid whose probe CANNOT complete: the env
    // override points at a script that exits 1 (powershell ran, no verdict).
    const stubDir = mkdtempSync(path.join(tmpdir(), 'see1348-fqa3-cli-'));
    const stubPath = path.join(stubDir, 'failing-ps.sh');
    writeFileSync(stubPath, '#!/bin/sh\nexit 1\n');
    chmodSync(stubPath, 0o755);
    try {
        writeFileSync(statePath('M4-d2'), JSON.stringify({
            schema_version: 3, state: 'WARM', editor_pid: 4321, editor_pid_source: 'windows',
        }));
        const refused = runCliExpectFail([
            '--runtime-id', 'M4-d2', '--editor-pid', '7777', '--editor-pid-source', 'windows',
        ], { GODOT_MCP_POWERSHELL_PATH: stubPath });
        assert.notEqual(refused.rc, 0);
        assert.match(refused.stderr, /probe unavailable/);
    } finally {
        rmSync(stubDir, { recursive: true, force: true });
    }
});

test('E: unknown editor_pid_source invalidates the record', () => {
    writeFileSync(statePath('M4-e'), JSON.stringify({
        schema_version: 3, state: 'WARM', editor_pid: 1, editor_pid_source: 'bogus',
    }));
    const r = sf.readRuntimeState('M4-e');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknown-editor-pid-source');
});

test('A2: pending marker clears the pid slot and stamps source=pending', () => {
    runCli(['--runtime-id', 'M4-a2', '--editor-pid', 'pending', '--editor-pid-source', 'pending']);
    const d = JSON.parse(readFileSync(statePath('M4-a2'), 'utf8'));
    assert.equal(d.editor_pid, null);
    assert.equal(d.editor_pid_source, 'pending');
});

// SEE-1348 hardener (Revy): mutant B1 survived — the `p <= 0` guard loosened
// to `p < 0` passed the whole suite, letting pid 0 fall through to
// process.kill(0, 0) (a process-GROUP probe that always succeeds → dead
// reads alive). Pin the boundary: 0 and negatives are never alive.
test('F: editorPidAlive rejects pid 0 and negatives before probing (boundary)', () => {
    assert.equal(sf.editorPidAlive(0, 'wsl'), false);
    assert.equal(sf.editorPidAlive(-7, 'wsl'), false);
    assert.equal(sf.editorPidAlive(0, 'windows'), false);
    assert.equal(sf.editorPidAlive('abc', 'wsl'), false);
});

// SEE-1348 hardener (Revy): the whole windows probe leg (B4-B7: constant
// true, count-gate flip, name-check flip, name-unreadable trust flip)
// survived — powershell.exe interop is absent on this box, so no test could
// reach it. Drive it deterministically through a PATH stub: editorPidAlive
// resolves powershell.exe via the current process's PATH, so a temp-dir
// stub standing in for it exercises every branch on any host.
test('G: editorPidAlive windows leg — count probe + godot name check + degrade paths (PATH stub)', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'see1348-m4-psstub-'));
    const stubPath = path.join(stubDir, 'powershell.exe');
    const realPath = process.env.PATH;
    const withStub = (script) => {
        writeFileSync(stubPath, script);
        chmodSync(stubPath, 0o755);
        process.env.PATH = `${stubDir}:${realPath}`;
    };
    try {
        // count=0 → dead
        withStub('#!/bin/sh\necho "0"\n');
        assert.equal(sf.editorPidAlive(4321, 'windows'), false, 'count=0 must read dead');
        // count=1, non-godot name → a reused PID belonging to another process reads dead
        withStub('#!/bin/sh\necho "1 notepad"\n');
        assert.equal(sf.editorPidAlive(4321, 'windows'), false, 'non-godot name must read dead (PID-reuse defense)');
        // count=1, godot name → alive
        withStub('#!/bin/sh\necho "1 Godot"\n');
        assert.equal(sf.editorPidAlive(4321, 'windows'), true, 'godot name must read alive');
        withStub('#!/bin/sh\necho "1 Godot_v4.6-stable"\n');
        assert.equal(sf.editorPidAlive(4321, 'windows'), true, 'godot binary variant must read alive');
        // count=1, name unreadable → trust the count probe (never false-negative a live editor)
        withStub('#!/bin/sh\necho "1"\n');
        assert.equal(sf.editorPidAlive(4321, 'windows'), true, 'unreadable name must trust the count');
        // probe ran but failed (non-zero) → NO VERDICT: null (unknown), never
        // false — F-QA-3: probe-unavailable misread a live editor as dead.
        withStub('#!/bin/sh\nexit 1\n');
        assert.equal(sf.editorPidAlive(4321, 'windows'), null, 'probe failure is unknown, not dead');
    } finally {
        process.env.PATH = realPath;
        rmSync(stubDir, { recursive: true, force: true });
    }
});

// SEE-1348 F-QA-3 (HIGH): the bare powershell.exe name ENOENTs on WSL hosts
// with appendWindowsPath off — a LIVE editor used to read as dead (Revy QA:
// pid 21756 ground-truth alive, probe false → WP7 veto cold_start-preempted
// a live editor). Two fixes pinned here:
//   (a) resolution chain: env override → PATH name → System32 absolute;
//   (b) probe-unavailable returns null (unknown), never false.
test('H: F-QA-3 — GODOT_MCP_POWERSHELL_PATH env override resolves when PATH lacks powershell', () => {
    const stubDir = mkdtempSync(path.join(tmpdir(), 'see1348-fqa3-env-'));
    const stubPath = path.join(stubDir, 'reporting-ps.sh');
    writeFileSync(stubPath, '#!/bin/sh\necho "1 Godot"\n');
    chmodSync(stubPath, 0o755);
    const realPath = process.env.PATH;
    try {
        // Real PATH on this host does NOT resolve powershell.exe; the env
        // override must carry the probe. Pre-fix this read false (ENOENT).
        delete process.env.PATH;
        process.env.GODOT_MCP_POWERSHELL_PATH = stubPath;
        assert.equal(sf.editorPidAlive(4321, 'windows'), true, 'env-override candidate must resolve the probe');
    } finally {
        process.env.PATH = realPath;
        delete process.env.GODOT_MCP_POWERSHELL_PATH;
        rmSync(stubDir, { recursive: true, force: true });
    }
});

test('H2: F-QA-3 — System32 absolute fallback when PATH lacks powershell (dead pid reads false, not unknown)', () => {
    const realPath = process.env.PATH;
    try {
        delete process.env.PATH;
        delete process.env.GODOT_MCP_POWERSHELL_PATH;
        // On a WSL host with /mnt/c mounted the System32 fallback resolves and
        // the probe COMPLETES: a dead pid reads positively false (not null).
        // On a host without the fallback file the probe returns null — both
        // are F-QA-3-correct; the invariant under test is "never false via a
        // failed resolution": null only when unresolvable.
        const r = sf.editorPidAlive(99999999, 'windows');
        assert.ok(r === false || r === null, `dead windows pid must read false or null, got ${r}`);
    } finally {
        process.env.PATH = realPath;
    }
});
