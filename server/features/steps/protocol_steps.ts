// Step definitions for the SEE-1334 Phase 3 gherkin scenarios.
//
// Every step binds a DETERMINISTIC assertion (gqt rule: a step that would be
// observe-only asserts a specific contract fact; pending/unimplemented steps
// fail under --strict). Behaviors run through the proxy's REAL stdio
// JSON-RPC path with the existing harness seams (see support/proxy_driver.ts
// — mock npx on PATH, counting spawn helpers, WS-completing mock editor).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { After, Given, Then, When } from '@cucumber/cucumber';
import WebSocket from 'ws';
import { isEditorBusyError } from '../../../launch/proxy/errors.mjs';
import {
    INIT_LINE, disposeAll, disposeSandbox, freePort, holdPortForForeignRuntime,
    jsonRpcCall, makePng, openSandbox, startProxyOn, startSingleClientEditor,
    until,
} from './support/proxy_driver.ts';
import type { IdResult, ProxySession, Sandbox } from './support/proxy_driver.ts';

const BUDGET = 20_000; // cold warm handshake through the counting seams + margins

interface World {
    sandbox?: Sandbox;
    session?: ProxySession;
    port?: number;
    result?: IdResult;
    pngWidth?: number;
    pngHeight?: number;
    screenshotResponse?: IdResult;
    wsEvents?: string[];
    wsSecondCloseCode?: number;
}

const baseEnv = (port: number, extra: Record<string, string> = {}): Record<string, string> => ({
    GODOT_PORT: String(port),
    KOL_AGENT_NAME: 'GherkinAgent',
    KOL_RUNTIME_ID: 'gherkin-ours-1111',
    KOL_WARMUP_TIMEOUT_MS: '15000',
    KOL_HOT_WARMUP_TIMEOUT_MS: '5000',
    KOL_PROBE_INTERVAL_MS: '200',
    ...extra,
});

After(function () {
    disposeAll();
    const { lastSandbox } = this as { lastSandbox?: Sandbox };
    if (lastSandbox) disposeSandbox(lastSandbox);
});

// ============ B1 lazy-load ====================================================

When('a proxy with counting spawn seams starts on a free port', async function () {
    (this as World).sandbox = openSandbox();
    (this as unknown as { port: number }).port = await freePort();
    (this as unknown as { lastSandbox?: Sandbox }).lastSandbox = (this as World).sandbox;
    (this as World).session = startProxyOn((this as World).sandbox as Sandbox, {
        ...baseEnv((this as World).port as number),
        KOL_CONFIGURE_SH: (this as World).sandbox!.configureMock,
        KOL_START_SH: (this as World).sandbox!.startMock,   // mock start binds the WS editor port
    });
});

Then('initialize is answered without spawning the editor', async function () {
    const s = (this as World).session as ProxySession;
    s.send(INIT_LINE);
    await until(
        () => s.stdoutLines.some((l) => l.includes('"id":1')),
        5000,
        () => `initialize not answered — out: ${s.stdoutLines.slice(0, 6).join(' | ')}`);
    assert.equal(readFileSync(s.configureCounter, 'utf8'), '', 'configure ran — B1 lazy-load broken');
    assert.equal(readFileSync(s.startCounter, 'utf8'), '', 'start ran — B1 lazy-load broken');
});

Then('the first tools\\/call spawns the editor exactly once', async function () {
    const s = (this as World).session as ProxySession;
    s.send(jsonRpcCall(2));
    await until(
        () => readFileSync(s.startCounter, 'utf8').split('\n').filter(Boolean).length === 1,
        8000,
        () => `start did not run exactly once — out: ${s.stdoutLines.slice(0, 6).join(' | ')} err: ${s.stderrLines.slice(0, 6).join(' | ')}`);
});

Then('the held call is flushed after WARM and answered', async function () {
    const s = (this as World).session as ProxySession;
    const resp = await s.waitForIdResult(2, BUDGET);
    assert.ok(!resp.error, `held call errored instead of flushing: ${JSON.stringify(resp.error)}`);
    const npxLog = readFileSync(s.npxLog, 'utf8');
    assert.ok(npxLog.includes('"id":2'), 'held call id=2 never reached npx — hold-to-warm flush broken');
});

// ============ port conflict → fail-fast with diagnostics ======================

Given('the editor port {int} is held by a live foreign runtime', async function (port: number) {
    const w = this as World;
    w.sandbox = openSandbox();
    w.port = port;
    w.lastSandbox = w.sandbox;
    holdPortForForeignRuntime(w.sandbox, port, 'holder-foreign-9999');
});

When('a proxy of ours starts on that port and receives the first tools\\/call', async function () {
    const w = this as World;
    const s = startProxyOn(w.sandbox as Sandbox, {
        ...baseEnv(w.port as number),
        GODOT_MCP_PORT_ARBITER: 'on',
        KOL_PORT_HELD_DIR: w.sandbox!.heldDir,
    });
    w.session = s;
    s.send(jsonRpcCall(2, 'get_project_info'));
    w.result = await s.waitForIdResult(2, BUDGET);
});

Then('the call is answered in-band with a retryable editor_busy diagnostic', function () {
    const resp = (this as World).result as IdResult;
    assert.ok(resp.error, `expected in-band error, got result: ${JSON.stringify(resp.result)}`);
    const data = (resp.error!.data ?? {}) as Record<string, unknown>;
    assert.match(resp.error!.message, /editor spawn failed: editor_busy/);
    assert.equal(data.bucket, 'editor_busy');
    assert.equal(data.state, 'spawn_failed');
    assert.equal(data.retryable, true);
});

Then('no editor spawn ran on the occupied port \\(fail-fast\\)', function () {
    const s = (this as World).session as ProxySession;
    assert.equal(readFileSync(s.configureCounter, 'utf8'), '', 'configure ran on an occupied port');
    assert.equal(readFileSync(s.startCounter, 'utf8'), '', 'start ran on an occupied port');
});

// ============ single-client exclusive rejection (4001) ========================

Given('a single-client mock editor listening on port {int}', async function (port: number) {
    const w = this as World;
    w.port = port;
    w.wsEvents = [];
    startSingleClientEditor(port, w.wsEvents as string[]);
});

When('the first client connects', function () {
    const w = this as World & { firstWs?: WebSocket };
    w.firstWs = new WebSocket(`ws://127.0.0.1:${w.port}`);
});

Then('the first client holds the single slot', async function () {
    await until(
        () => ((this as World).wsEvents ?? []).includes('upgraded'),
        4000,
        () => 'first client never completed the upgrade');
});

When('a second client attempts to connect', async function () {
    const w = this as World;
    const ws = new WebSocket(`ws://127.0.0.1:${w.port}`);
    const closeCode: number = await new Promise<number>((resolve) => {
        const timer = setTimeout(() => resolve(-1), 3000);
        ws.on('close', (code: number) => {
            clearTimeout(timer);
            resolve(code);
        });
        ws.on('error', () => { /* the close event still surfaces */ });
    });
    // Client-side close code (parsed from the mock editor's wire frame).
    w.wsSecondCloseCode = closeCode;
});

Then('the second client is rejected with close code 4001', function () {
    // Wire fact on both sides: the mock editor emitted the close-4001 frame,
    // and the second client parsed exactly that close code.
    assert.ok(((this as World).wsEvents ?? []).includes('closed_4001'));
    assert.equal((this as World).wsSecondCloseCode, 4001);
});

Then('the proxy-side classifier maps the 4001 wire text to a retryable editor_busy diagnostic', function () {
    // Contract: a wire error naming the single-slot close must hit
    // errors.mjs EDITOR_BUSY_PATTERNS (retryable editor_busy, never dead-editor).
    const err = new Error('ws close code 4001 from another client');
    assert.equal(isEditorBusyError(err), true, 'classifier missed the 4001 wire text');
});

// ============ screenshot contract ============================================

Given('a warm proxy session', async function () {
    const w = this as World;
    w.sandbox = openSandbox();
    w.port = await freePort();
    (this as unknown as { lastSandbox?: Sandbox }).lastSandbox = w.sandbox;
    const s = startProxyOn(w.sandbox as Sandbox, {
        ...baseEnv(w.port as number),
        KOL_CONFIGURE_SH: w.sandbox!.configureMock,
        KOL_START_SH: w.sandbox!.startMock,
    });
    w.session = s;
    s.send(INIT_LINE);
    // PRIME call drives the B1 spawn+warm path; only after this are warm-time
    // semantics (screenshot enrichment, flat forwards) in effect downstream.
    s.send(jsonRpcCall(2, 'get_project_info'));
    await until(
        () => s.stdoutLines.some((l) => l.includes('"id":1')),
        5000,
        () => `initialize not answered — out: ${s.stdoutLines.slice(0, 6).join(' | ')}`);
    const primed = await s.waitForIdResult(2, BUDGET);
    assert.ok(!primed.error, `priming call failed: ${JSON.stringify(primed.error)}`);
});

Given('the mock editor answers capture_game_screenshot with a PNG of width {int} height {int}', function (width: number, height: number) {
    const w = this as World;
    const png = makePng(width, height);
    // The mock npx consults the sandbox replies file (mock-npx-stable.mjs);
    // stage the real capture result for capture_game_screenshot there.
    writeFileSync(w.sandbox!.repliesFile, JSON.stringify({
        capture_game_screenshot: { content: [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }] },
    }));
    w.pngWidth = width;
    w.pngHeight = height;
});

When('the agent calls capture_game_screenshot', async function () {
    const s = (this as World).session as ProxySession;
    s.send(jsonRpcCall(3, 'capture_game_screenshot'));
    (this as World).screenshotResponse = await s.waitForIdResult(3, BUDGET);
});

Then('the response carries a _screenshot block with capture metadata', function () {
    const resp = (this as World).screenshotResponse as IdResult;
    assert.ok(!resp.error, `call errored: ${JSON.stringify(resp.error)}`);
    const meta = metaOf(resp);
    assert.ok(meta && '_screenshot' in meta, `no _screenshot metadata in: ${JSON.stringify(resp.result ?? {}).slice(0, 200)}`);
    const shot = meta._screenshot as Record<string, unknown>;
    assert.ok((shot.captured_at_ms as number) > 0);
    assert.ok(typeof shot.capture_latency_ms === 'number');
    assert.equal(shot.stale, false);
});

Then('the full-resolution export lands on disk with the PNG header dimensions', function () {
    const w = this as World;
    const meta = metaOf(w.screenshotResponse as IdResult);
    const pngPath = meta?.exports?.png_path as string | null;
    assert.ok(pngPath, `no export path: ${JSON.stringify(meta)}`);
    assert.ok(existsSync(pngPath), 'export file missing on disk');
    // D3: width/height declared in the response ARE the PNG header facts.
    const buf = readFileSync(pngPath);
    assert.equal(buf.readUInt32BE(16), w.pngWidth as number);
    assert.equal(buf.readUInt32BE(20), w.pngHeight as number);
});

When('the agent calls capture_game_screenshot with max_width {int}', async function (maxWidth: number) {
    const s = (this as World).session as ProxySession;
    s.send(jsonRpcCall(3, 'capture_game_screenshot', { max_width: maxWidth }));
    (this as World).screenshotResponse = await s.waitForIdResult(3, BUDGET);
});

Then('the width×height check fails on the oversized on-disk frame', function () {
    const resp = (this as World).screenshotResponse as IdResult;
    const all = JSON.stringify(resp);
    assert.ok(all.includes('Width×height check FAILED'), `no width×height breach text in: ${all.slice(0, 240)}`);
});

// ============ exec constraints ===============================================

When('the agent calls godot_exec with source {string}', async function (source: string) {
    const s = (this as World).session as ProxySession;
    s.send(jsonRpcCall(3, 'godot_exec', { action: 'run', source }));
    (this as World).result = await s.waitForIdResult(3, BUDGET);
});

When('the agent calls godot_exec with action help', async function () {
    const s = (this as World).session as ProxySession;
    s.send(jsonRpcCall(3, 'godot_exec', { action: 'help' }));
    (this as World).result = await s.waitForIdResult(3, BUDGET);
});

Then('the response names the violated constraint {string}', function (token: string) {
    const resp = (this as World).result as IdResult;
    assert.ok(resp.error, `expected error response, got: ${JSON.stringify(resp.result)}`);
    assert.ok((resp.error!.message ?? '').includes(token), `message lacks ${token}: ${resp.error!.message}`);
});

Then('the call never reached the mock npx \\(in-band interception\\)', function () {
    const s = (this as World).session as ProxySession;
    const npxLog = readFileSync(s.npxLog, 'utf8');
    assert.ok(!npxLog.includes('"id":3'), `godot_exec leaked to npx: ${npxLog.slice(0, 200)}`);
});

Then('the response carries the full SSOT constraint digest', function () {
    const resp = (this as World).result as IdResult;
    assert.ok(!resp.error, `help errored: ${JSON.stringify(resp.error)}`);
    const text = resp.result?.content?.map((c) => c.text ?? '').join('\n') ?? '';
    assert.ok(text.includes('godot_exec constraints'), 'digest header missing');
    assert.ok(text.includes('OS.execute'), 'denylist entry missing from digest');
    assert.ok(text.includes('SYNC ONLY'), 'SYNC ONLY note missing from digest');
});

function metaOf(resp: IdResult): Record<string, unknown> | null {
    if (!resp.result?.content) return null;
    for (const c of resp.result.content) {
        if (c.type !== 'text' || !c.text) continue;
        try {
            const parsed = JSON.parse(c.text) as Record<string, unknown>;
            if (parsed && ('_screenshot' in parsed || 'exports' in parsed)) return parsed;
        } catch (e) { /* not the meta block */ }
    }
    return null;
}
