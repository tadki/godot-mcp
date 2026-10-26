// SEE-1468 M-mcp: cucumber-js adapters for the launch-tree SEE-1356 faces.
//
// The bash harnesses remain the semantic SSOT. Each scenario executes the same
// face as the retired Python wrappers and keeps both machine facts: stdout has
// FAIL=0, and the harness exits 0. Diagnostics keep the last output line, a
// stderr tail, the exit code, and spawn failure text; there are no pending
// steps under --strict.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Given, Then, When } from '@cucumber/cucumber';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const GD_FACES_HARNESS = path.join(
    REPO, 'launch', 'tests', 'scripts', 'test_see1356_batch2_gd_faces.sh');
const L7_HARNESS = path.join(
    REPO, 'launch', 'tests', 'scripts', 'test_see1356_l7_seed_layout.sh');
// Match the gd-faces SSOT's own 300s worst case and keep the subprocess kill
// below the per-step Cucumber budget, so a hung harness reports its own
// spawn timeout instead of Cucumber's generic timeout.
const HARNESS_BUDGET_MS = 300_000;
const HARNESS_STEP_TIMEOUT_MS = 360_000;

type HarnessFace = 'capture' | 'node_commands' | 'l7';

interface HarnessWorld {
    harnessPath?: string;
    spawnError?: string;
    signal?: NodeJS.Signals | null;
    rc?: number;
    stdout?: string;
    stderrTail?: string;
}

function lastOutputLine(stdout: string | undefined): string {
    const text = stdout ?? '';
    const lines = text.trim().split('\n');
    return lines[lines.length - 1] || '(no output)';
}

function harnessFailure(w: HarnessWorld, reason: string): string {
    const spawnError = w.spawnError ? ` spawn_error=${w.spawnError}` : '';
    const signal = w.signal ? ` signal=${w.signal}` : '';
    return `${reason} — detail=${lastOutputLine(w.stdout)} `
        + `stderr_tail=${w.stderrTail ?? ''} rc=${w.rc ?? 'missing'}${signal}${spawnError}`;
}

Given('the SEE-1356 batch-2 gd-faces harness in the launch test tree', function () {
    assert.equal(
        existsSync(GD_FACES_HARNESS), true,
        `gd-faces harness script missing: ${GD_FACES_HARNESS}`);
    (this as HarnessWorld).harnessPath = GD_FACES_HARNESS;
});

Given('the SEE-1356 L7 harness script in the launch test tree', function () {
    assert.equal(
        existsSync(L7_HARNESS), true,
        `L7 harness script missing: ${L7_HARNESS}`);
    (this as HarnessWorld).harnessPath = L7_HARNESS;
});

function runHarness(w: HarnessWorld, face: HarnessFace): void {
    const script = w.harnessPath as string;
    const args = face === 'l7' ? [script] : [script, face];
    const result = spawnSync('bash', args, {
        encoding: 'utf8',
        timeout: HARNESS_BUDGET_MS,
        maxBuffer: 8 * 1024 * 1024,
        cwd: REPO,
    });
    w.spawnError = result.error?.message;
    w.signal = result.signal;
    w.rc = result.status ?? -1;
    w.stdout = result.stdout;
    w.stderrTail = (result.stderr ?? '').slice(-2000);
}

When('the harness runs the capture face against the current tree', { timeout: HARNESS_STEP_TIMEOUT_MS }, function () {
    runHarness(this as HarnessWorld, 'capture');
});

When('the harness runs the node_commands face against the current tree', { timeout: HARNESS_STEP_TIMEOUT_MS }, function () {
    runHarness(this as HarnessWorld, 'node_commands');
});

When('the harness runs against mock seed-<id12> fixtures', { timeout: HARNESS_STEP_TIMEOUT_MS }, function () {
    runHarness(this as HarnessWorld, 'l7');
});

// Shared assertion tail (SSOT stdout FAIL=0 + exit 0); the face label keeps
// failure messages scenario-specific.
function assertZeroFailures(w: HarnessWorld, face: string): void {
    assert.match(w.stdout ?? '', /FAIL=0/, harnessFailure(w, `${face} reported failures`));
    assert.equal(w.rc, 0, harnessFailure(w, `${face} harness exit code nonzero`));
}

Then('the capture face reports zero failures', function () {
    assertZeroFailures(this as HarnessWorld, 'capture face');
});

Then('the node_commands face reports zero failures', function () {
    assertZeroFailures(this as HarnessWorld, 'node_commands face');
});

Then('the harness reports zero failures across all groups', function () {
    assertZeroFailures(this as HarnessWorld, 'L7 harness');
});
