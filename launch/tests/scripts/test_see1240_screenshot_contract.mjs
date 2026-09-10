#!/usr/bin/env node
// SEE-1240 WS-3 — pure unit tests for the screenshot capture contract module.
//
// Covers (C3/C4 + D3):
//   - pngDimensions: IHDR decode, garbage rejection, short-buffer rejection
//   - frameAgeVerdict: stale threshold, auto_step override, non-finite latency
//   - enrichScreenshotResponse: exports write + width×height check (D3 —
//     on-disk PNG exceeding max_width must FAIL the check; omitting max_width
//     = native capture, nothing to check), stale advisory text, fresh
//     (auto_step) advisory, undecodable payload handling, write failure path
//   - spliceEnrichment: image-first ordering, advisory + meta texts injected,
//     original content preserved
//
// Run: node .dev/godot-mcp/tests/scripts/test_see1240_screenshot_contract.mjs

import { mkdtempSync, mkdirSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import {
    pngDimensions,
    frameAgeVerdict,
    enrichScreenshotResponse,
    spliceEnrichment,
    staleAdvisoryText,
    freshAdvisoryText,
    DEFAULT_STALE_CAPTURE_MS,
    resetExportSeqForTest,
} from '../../../launch/see1240-screenshot-contract.mjs';

let PASS = 0, FAIL = 0;
const failures = [];
function ok(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  [PASS] ${name}`); }
    else { FAIL++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

// --- minimal PNG builder (W×H, 8-bit RGB) -------------------------------------
function crc32(buf) {
    let c; const table = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
    let crc = 0xFFFFFFFF;
    for (const b of buf) crc = table[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function makePng(w, h) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]);
}

section('pngDimensions');
{
    const d = pngDimensions(makePng(3, 2));
    ok('decodes 3x2', d && d.width === 3 && d.height === 2, JSON.stringify(d));
    const big = pngDimensions(makePng(1920, 1080));
    ok('decodes 1920x1080', big && big.width === 1920 && big.height === 1080);
    ok('rejects non-png', pngDimensions(Buffer.from('hello, not a png')) === null);
    ok('rejects short buffer', pngDimensions(Buffer.alloc(10)) === null);
    ok('rejects png without IHDR first', pngDimensions(
        Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IDAT', Buffer.alloc(4)), chunk('IEND', Buffer.alloc(0))])
    ) === null);
}

section('frameAgeVerdict (C3)');
{
    ok('fresh below threshold', frameAgeVerdict({ latencyMs: 200 }).stale === false);
    ok('exactly at threshold is fresh', frameAgeVerdict({ latencyMs: DEFAULT_STALE_CAPTURE_MS }).stale === false);
    ok('over threshold is stale', frameAgeVerdict({ latencyMs: 3000 }).stale === true
        && frameAgeVerdict({ latencyMs: 3000 }).reason === 'latency_over_threshold');
    ok('auto_step overrides latency', (() => {
        const v = frameAgeVerdict({ latencyMs: 9000, autoStep: { frames: 1, ok: true } });
        return v.stale === false && v.reason === 'auto_step';
    })());
    ok('non-finite latency clamps to 0/fresh', frameAgeVerdict({ latencyMs: NaN }).stale === false
        && frameAgeVerdict({ latencyMs: NaN }).latencyMs === 0);
    const mut = frameAgeVerdict({ latencyMs: 100, mutationBeforeCaptureMs: 5000, lastFrameAdvanceMs: 0 });
    ok('mutation without step → stale (fast RED case)', mut.stale === true && mut.reason === 'no_step_after_mutation');
    const stepped = frameAgeVerdict({ latencyMs: 100, mutationBeforeCaptureMs: 5000, lastFrameAdvanceMs: 6000 });
    ok('mutation before step → fresh', stepped.stale === false && stepped.reason === 'ok');
    const autoOverMut = frameAgeVerdict({ latencyMs: 100, autoStep: { frames: 1, ok: true }, mutationBeforeCaptureMs: 5000, lastFrameAdvanceMs: 0 });
    ok('auto_step overrides mutation staleness', autoOverMut.stale === false && autoOverMut.reason === 'auto_step');
    ok('negative latency clamps to 0', frameAgeVerdict({ latencyMs: -5 }).latencyMs === 0);
}

section('advisory texts');
{
    const v = frameAgeVerdict({ latencyMs: 4000 });
    const stale = staleAdvisoryText(v, false);
    ok('stale text names latency', stale.includes('4000ms'));
    ok('stale text names remedy (step frames=1)', stale.includes('godot_game_time step frames=1'));
    ok('stale text explains opt-in when not requested', stale.includes('WITHOUT auto_step'));
    ok('stale text omits opt-in nudge when requested', !staleAdvisoryText(v, true).includes('WITHOUT auto_step'));
    const mutText = staleAdvisoryText(frameAgeVerdict({ latencyMs: 100, mutationBeforeCaptureMs: 5000, lastFrameAdvanceMs: 0 }));
    ok('mutation stale text names the diagnosis', mutText.includes('no_step_after_mutation') && mutText.includes('PRE-MUTATION'));
    const fresh = freshAdvisoryText(frameAgeVerdict({ latencyMs: 120, autoStep: { frames: 1, ok: true } }));
    ok('fresh text confirms verification', fresh.includes('120ms') && fresh.includes('auto_step'));
}

resetExportSeqForTest();
const worktree = mkdtempSync(path.join(tmpdir(), 'see1240-test-'));
section('enrichScreenshotResponse (C4 + D3 width×height)');
{
    // Fresh capture, no max_width → native, exports present, no advisory.
    const png = makePng(320, 240);
    const content = [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }];
    const enr = await enrichScreenshotResponse({
        resultContent: content, forwardedAtMs: 1000, nowMs: 1500,
        autoStepRequested: false, autoStepPerformed: null, worktree, requestArgs: {},
    });
    ok('fresh capture: no advisory', enr.advisoryText === null, JSON.stringify(enr.advisoryText));
    ok('fresh capture: stale=false', enr._screenshot.stale === false);
    ok('fresh capture: latency recorded', enr._screenshot.capture_latency_ms === 500);
    ok('fresh capture: exports path set', typeof enr.exports.png_path === 'string' && enr.exports.png_path.includes('.dev/godot-mcp/exports/'));
    ok('fresh capture: dims decoded', enr.exports.width === 320 && enr.exports.height === 240);
    ok('exports file exists on disk', existsSync(enr.exports.png_path));
    const onDisk = pngDimensions(readFileSync(enr.exports.png_path));
    ok('disk PNG dims match response', onDisk && onDisk.width === 320 && onDisk.height === 240);

    // D3: on-disk frame wider than max_width → width×height check FAILS.
    const enrBad = await enrichScreenshotResponse({
        resultContent: content, forwardedAtMs: 0, nowMs: 100,
        autoStepRequested: false, autoStepPerformed: null, worktree, requestArgs: { max_width: 100 },
    });
    ok('width×height check catches oversized frame', enrBad.advisoryText && enrBad.advisoryText.includes('Width×height check FAILED'));

    // Stale capture → stale advisory with the contract wording.
    const enrStale = await enrichScreenshotResponse({
        resultContent: content, forwardedAtMs: 0, nowMs: 4000,
        autoStepRequested: false, autoStepPerformed: null, worktree, requestArgs: {},
    });
    ok('stale capture flagged', enrStale._screenshot.stale === true);
    ok('stale advisory actionable', enrStale.advisoryText.includes('STALE FRAME RISK'));

    // auto_step capture → fresh confirmation even at long latency.
    const enrStep = await enrichScreenshotResponse({
        resultContent: content, forwardedAtMs: 0, nowMs: 5000,
        autoStepRequested: true, autoStepPerformed: { frames: 1, ok: true }, worktree, requestArgs: {},
    });
    ok('auto_step capture fresh despite latency', enrStep._screenshot.stale === false);
    ok('auto_step provenance stamped', JSON.stringify(enrStep._screenshot.auto_step).includes('frames'));
    ok('auto_step fresh advisory present', enrStep.advisoryText && enrStep.advisoryText.includes('freshness verified'));

    // Undecodable payload → exports error, no crash. Two forms: non-PNG bytes
    // (Node base64 decode is lenient, so this MUST be caught by the PNG
    // signature check, not by a decode exception) and true garbage.
    const enrBad64 = await enrichScreenshotResponse({
        resultContent: [{ type: 'image', data: '!!!not-base64!!!', mimeType: 'image/png' }],
        forwardedAtMs: 0, nowMs: 10, autoStepRequested: false, autoStepPerformed: null, worktree, requestArgs: {},
    });
    ok('garbage payload → exports error noted', enrBad64.exports.error && enrBad64.exports.png_path === null);
    const enrNotPng = await enrichScreenshotResponse({
        resultContent: [{ type: 'image', data: Buffer.from('plain text, valid base64, not a png').toString('base64'), mimeType: 'image/png' }],
        forwardedAtMs: 0, nowMs: 10, autoStepRequested: false, autoStepPerformed: null, worktree, requestArgs: {},
    });
    ok('valid-base64 non-PNG → exports error noted', enrNotPng.exports.error && enrNotPng.exports.png_path === null);

    // No image content → null (error responses untouched).
    const enrNoImage = await enrichScreenshotResponse({
        resultContent: [{ type: 'text', text: 'Error: something' }],
        forwardedAtMs: 0, nowMs: 10, worktree, requestArgs: {},
    });
    ok('no image → null enrichment', enrNoImage === null);

    // Unwritable export dir → structured error, no throw.
    const ro = path.join(worktree, 'ro');
    mkdirSync(ro, { recursive: true });
    chmodSync(ro, 0o500);
    const enrRo = await enrichScreenshotResponse({
        resultContent: content, forwardedAtMs: 0, nowMs: 10,
        autoStepRequested: false, autoStepPerformed: null, worktree: path.join(ro, 'wt'), requestArgs: {},
    });
    ok('unwritable worktree → structured export error', enrRo && enrRo.exports && typeof enrRo.exports.error === 'string');
    chmodSync(ro, 0o700);
}

section('spliceEnrichment');
{
    resetExportSeqForTest();
    const png = makePng(8, 4);
    const content = [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }];
    const enr = await enrichScreenshotResponse({
        resultContent: content, forwardedAtMs: 0, nowMs: 4000,
        autoStepRequested: false, autoStepPerformed: null, worktree, requestArgs: {},
    });
    const original = { content: [...content, { type: 'text', text: 'trailing note' }] };
    const spliced = spliceEnrichment(original, enr);
    ok('image stays first', spliced.content[0].type === 'image');
    ok('image data byte-identical', spliced.content[0].data === content[0].data);
    ok('advisory + meta texts injected', spliced.content.length === 4
        && spliced.content[1].type === 'text' && spliced.content[1].text.includes('STALE FRAME RISK')
        && spliced.content[2].type === 'text' && spliced.content[2].text.includes('_screenshot')
        && spliced.content[2].text.includes('exports'));
    const meta = JSON.parse(spliced.content[2].text);
    ok('meta parses with _screenshot + exports', meta._screenshot && meta.exports && meta.exports.png_path);
    ok('original trailing note preserved', spliced.content[3].text === 'trailing note');
    ok('original array not mutated', original.content.length === 2);
    ok('null enrichment returns result unchanged', spliceEnrichment(original, null) === original);
}

console.log(`\nSUMMARY: PASS=${PASS} FAIL=${FAIL}`);
if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
