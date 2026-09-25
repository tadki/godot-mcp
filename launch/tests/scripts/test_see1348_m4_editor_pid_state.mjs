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
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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
function runCliExpectFail(args) {
    try {
        execFileSync('node', [CLI, ...args], {
            env: { ...process.env, GODOT_MCP_HOME: HOME },
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
