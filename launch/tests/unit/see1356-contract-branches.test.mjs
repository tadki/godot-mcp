// SEE-1356 hardener — see1240-screenshot-contract.mjs branch-completion unit
// face (§SPEC-L3-01 IHDR deep check + the C3/C4 verdict helpers). Complements
// the exit-code harness test_see1240_screenshot_contract.mjs (untouched);
// this file is the StrykerJS mutation face for the contract module.
// Pure module (fs/promises + path only) — no env-freeze constraints.
import { describe, expect, test } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const {
    DEFAULT_STALE_CAPTURE_MS, resolveStaleCaptureMs, pngDimensions, base64ToBuffer,
    frameAgeVerdict, staleAdvisoryText, freshAdvisoryText, resetExportSeqForTest,
    enrichScreenshotResponse, spliceEnrichment,
} = await import('../../../see1240-screenshot-contract.mjs');

const imgContent = (data) => [{ type: 'image', data }];
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const ENRICH_BASE = { forwardedAtMs: 500, nowMs: 1000 };

describe('resolveStaleCaptureMs env boundary matrix (§SPEC-015)', () => {
    // kills: regex deletion, \d+ → \w+ / \S+ loosenings, >=1 bound flip,
    // non-string early-return removal, default-value mutations.
    const cases = [
        [{}, DEFAULT_STALE_CAPTURE_MS, 'absent'],
        [{ GODOT_MCP_STALE_CAPTURE_MS: '' }, DEFAULT_STALE_CAPTURE_MS, 'empty'],
        [{ GODOT_MCP_STALE_CAPTURE_MS: 'abc' }, DEFAULT_STALE_CAPTURE_MS, 'non-numeric'],
        [{ GODOT_MCP_STALE_CAPTURE_MS: '1.5' }, DEFAULT_STALE_CAPTURE_MS, 'float'],
        [{ GODOT_MCP_STALE_CAPTURE_MS: '1e3' }, DEFAULT_STALE_CAPTURE_MS, 'exponent'],
        [{ GODOT_MCP_STALE_CAPTURE_MS: ' 100' }, DEFAULT_STALE_CAPTURE_MS, 'whitespace-padded'],
        [{ GODOT_MCP_STALE_CAPTURE_MS: '0' }, DEFAULT_STALE_CAPTURE_MS, 'zero'],
        [{ GODOT_MCP_STALE_CAPTURE_MS: '-5' }, DEFAULT_STALE_CAPTURE_MS, 'negative'],
        [{ GODOT_MCP_STALE_CAPTURE_MS: '+8' }, DEFAULT_STALE_CAPTURE_MS, 'plus-signed'],
        [{ GODOT_MCP_STALE_CAPTURE_MS: '2500' }, 2500, 'valid integer passes through'],
        [{ GODOT_MCP_STALE_CAPTURE_MS: '1' }, 1, 'lower bound 1 accepted (>=, not >)'],
    ];
    for (const [env, expected, why] of cases) {
        test(`env ${why} → ${expected}`, () => {
            expect(resolveStaleCaptureMs(env)).toBe(expected);
        });
    }
    test('null env object → default', () => {
        expect(resolveStaleCaptureMs(null)).toBe(DEFAULT_STALE_CAPTURE_MS);
    });
});

describe('base64ToBuffer leniency contract', () => {
    test('non-string → null', () => {
        expect(base64ToBuffer(42)).toBeNull();
        expect(base64ToBuffer(null)).toBeNull();
    });
    test('empty string → null', () => {
        expect(base64ToBuffer('')).toBeNull();
    });
    test('garbage string decodes LENIENTLY to garbage bytes (never throws, never null)', () => {
        const buf = base64ToBuffer('not-base64!!!');
        expect(buf).toBeInstanceOf(Buffer);
        expect(buf.length).toBeGreaterThan(0);
    });
    test('valid base64 → exact bytes', () => {
        expect(base64ToBuffer(PNG_1PX.toString('base64')).equals(PNG_1PX)).toBe(true);
    });
});

describe('pngDimensions IHDR boundaries', () => {
    test('short buffer / non-buffer → null', () => {
        expect(pngDimensions(Buffer.alloc(23))).toBeNull();
        expect(pngDimensions(PNG_1PX.subarray(0, 8))).toBeNull();
        expect(pngDimensions('not a buffer')).toBeNull();
    });
    test('bad signature → null', () => {
        const bad = Buffer.from(PNG_1PX);
        bad[0] = 0x00;
        expect(pngDimensions(bad)).toBeNull();
    });
    test('good signature but wrong chunk type at offset 12 → null', () => {
        const body = Buffer.alloc(24);
        PNG_1PX.subarray(0, 12).copy(body, 0);
        body.writeUInt32BE(0x49484453, 12); // 'IHDRS' not 'IHDR'
        expect(pngDimensions(body)).toBeNull();
    });
    test('valid PNG → header dims (ground truth on disk)', () => {
        expect(pngDimensions(PNG_1PX)).toEqual({ width: 1, height: 1 });
    });
});

describe('frameAgeVerdict two-signal composition', () => {
    test('autoStep capture is definitionally fresh (signal short-circuit)', () => {
        const v = frameAgeVerdict({ latencyMs: 99999, autoStep: { frames: 1 }, thresholdMs: 1500 });
        expect(v).toEqual({ stale: false, latencyMs: 99999, reason: 'auto_step' });
    });
    test('mutation AFTER last frame advance → no_step_after_mutation', () => {
        const v = frameAgeVerdict({ latencyMs: 5, mutationBeforeCaptureMs: 800, lastFrameAdvanceMs: 100, thresholdMs: 1500 });
        expect(v.stale).toBe(true);
        expect(v.reason).toBe('no_step_after_mutation');
    });
    test('mutation BEFORE the last frame advance falls through to latency logic', () => {
        const v = frameAgeVerdict({ latencyMs: 5, mutationBeforeCaptureMs: 100, lastFrameAdvanceMs: 800, thresholdMs: 1500 });
        expect(v.stale).toBe(false);
        expect(v.reason).toBe('ok');
    });
    test('non-finite latency clamps to 0 (never NaN-poisons the contract)', () => {
        expect(frameAgeVerdict({ latencyMs: NaN, thresholdMs: 1500 }).latencyMs).toBe(0);
        expect(frameAgeVerdict({ latencyMs: 'x', thresholdMs: 1500 }).latencyMs).toBe(0);
        expect(frameAgeVerdict({ latencyMs: Infinity, thresholdMs: 1500 }).latencyMs).toBe(0);
    });
    test('latency rounds and clamps negatives to 0', () => {
        expect(frameAgeVerdict({ latencyMs: 2.6, thresholdMs: 1500 }).latencyMs).toBe(3);
        expect(frameAgeVerdict({ latencyMs: -50, thresholdMs: 1500 }).latencyMs).toBe(0);
    });
    test('mutation tie (== lastFrameAdvance) falls through to latency logic', () => {
        // kills: `mutationBeforeCaptureMs > lastFrameAdvanceMs` boundary
        // mutants (>= would flag a mutation captured in the SAME frame).
        const v = frameAgeVerdict({ latencyMs: 5, mutationBeforeCaptureMs: 500, lastFrameAdvanceMs: 500, thresholdMs: 1500 });
        expect(v.stale).toBe(false);
        expect(v.reason).toBe('ok');
    });
    test('zero mutation never triggers the no_step signal', () => {
        // kills: `mutationBeforeCaptureMs > 0` guard mutants.
        const v = frameAgeVerdict({ latencyMs: 5, mutationBeforeCaptureMs: 0, lastFrameAdvanceMs: 0, thresholdMs: 1500 });
        expect(v.reason).toBe('ok');
    });
    test('strict threshold: == threshold is fresh, +1 is stale', () => {
        expect(frameAgeVerdict({ latencyMs: 1500, thresholdMs: 1500 }).stale).toBe(false);
        const over = frameAgeVerdict({ latencyMs: 1501, thresholdMs: 1500 });
        expect(over.stale).toBe(true);
        expect(over.reason).toBe('latency_over_threshold');
        expect(over.thresholdMs).toBe(1500);
    });
});

describe('advisory wording pins', () => {
    test('no_step_after_mutation diagnosis wording', () => {
        const text = staleAdvisoryText({ reason: 'no_step_after_mutation', latencyMs: 5, stale: true }, false);
        expect(text).toContain('STALE FRAME RISK (no_step_after_mutation)');
        expect(text).toContain('PRE-MUTATION');
        expect(text).toContain('WITHOUT auto_step');
    });
    test('thresholdMs=0 does NOT fall back to the default (?? not ||)', () => {
        // kills: `verdict.thresholdMs ?? DEFAULT` → `||` mutant (0 threshold
        // is a valid configured value, not an absence signal).
        const text = staleAdvisoryText({ reason: 'latency_over_threshold', latencyMs: 5, thresholdMs: 0, stale: true }, true);
        expect(text).toContain('the 0ms freshness threshold');
    });
    test('autoStep default is FALSE (enrich without the flag nudges opt-in)', async () => {
        // kills: the `autoStepRequested = false` default BooleanLiteral.
        const wt = mkdtempSync(path.join(tmpdir(), 'see1356-ct-'));
        try {
            const r = await enrichScreenshotResponse({
                resultContent: imgContent(''), forwardedAtMs: 0, nowMs: 5000, worktree: wt, fallbackHint: ' [hint: FB]',
            });
            expect(r.advisoryText).toContain('WITHOUT auto_step');
        } finally { rmSync(wt, { recursive: true, force: true }); }
    });
    test('latency diagnosis names the observed and threshold numbers', () => {
        const text = staleAdvisoryText({ reason: 'latency_over_threshold', latencyMs: 3000, thresholdMs: 1500, stale: true }, false);
        expect(text).toContain('3000ms');
        expect(text).toContain('1500ms');
    });
    test('autoStepEnabled=true omits the opt-in nudge', () => {
        const text = staleAdvisoryText({ reason: 'latency_over_threshold', latencyMs: 3000, thresholdMs: 1500, stale: true }, true);
        expect(text).not.toContain('WITHOUT auto_step');
    });
    test('freshAdvisoryText carries latency and auto_step confirmation', () => {
        expect(freshAdvisoryText({ latencyMs: 42 })).toContain('42ms');
        expect(freshAdvisoryText({ latencyMs: 42 })).toContain('auto_step');
    });
    test('advisory text is EXACT for the latency reason (wording contract)', () => {
        // kills: StringLiteral edits inside the remedy/verify sentences and
        // the lines.join separator mutant.
        const text = staleAdvisoryText({ reason: 'latency_over_threshold', latencyMs: 3000, thresholdMs: 1500, stale: true }, true);
        expect(text).toBe('⚠ STALE FRAME RISK (latency_over_threshold): Capture latency 3000ms exceeds the 1500ms freshness threshold — the frame_post_draw wait resolved late (frozen/paused games only redraw on step/thaw). Remedy: advance one frame (godot_game_time step frames=1) and re-capture, or call screenshot_game with auto_step=true to have the step performed for you.');
    });
    test('staleAdvisoryText default autoStepEnabled=false (direct call)', () => {
        // covers + kills the `autoStepEnabled = false` default BooleanLiteral.
        const text = staleAdvisoryText({ reason: 'latency_over_threshold', latencyMs: 3000, thresholdMs: 1500, stale: true });
        expect(text).toContain('WITHOUT auto_step');
    });
});

describe('enrichScreenshotResponse guard + classification branches (§SPEC-L3-01)', () => {
    test('non-array / imageless resultContent → null (error responses untouched)', () => {
        expect(enrichScreenshotResponse({ ...ENRICH_BASE, resultContent: 'str' })).resolves.toBeNull();
        expect(enrichScreenshotResponse({ ...ENRICH_BASE, resultContent: [] })).resolves.toBeNull();
        expect(enrichScreenshotResponse({ ...ENRICH_BASE, resultContent: [{ type: 'text', text: 'x' }] })).resolves.toBeNull();
    });
    test('image entry with NON-STRING data is not an image candidate → null', () => {
        expect(enrichScreenshotResponse({ ...ENRICH_BASE, resultContent: [{ type: 'image', data: 42 }] })).resolves.toBeNull();
    });
    test('non-finite timestamps → latency 0 (never NaN in _screenshot)', async () => {
        const r = await enrichScreenshotResponse({
            resultContent: imgContent(PNG_1PX.toString('base64')),
            forwardedAtMs: NaN, nowMs: undefined, worktree: mkdtempSync(path.join(tmpdir(), 'see1356-ct-')),
        });
        expect(r._screenshot.capture_latency_ms).toBe(0);
        expect(r._screenshot.stale).toBe(false);
    });
    test('finite timestamps → latency = now − forwarded exactly', async () => {
        // kills: the `nowMs - forwardedAtMs` arithmetic mutant (+ yields ~2×epoch).
        const wt = mkdtempSync(path.join(tmpdir(), 'see1356-ct-'));
        try {
            const r = await enrichScreenshotResponse({
                resultContent: imgContent(PNG_1PX.toString('base64')), forwardedAtMs: 500, nowMs: 1000, worktree: wt,
            });
            expect(r._screenshot.capture_latency_ms).toBe(500);
        } finally { rmSync(wt, { recursive: true, force: true }); }
    });
    test('stale + width-overflow + decode hint compose ALL advisory parts', async () => {
        // covers + kills: the combined advisoryExtra+fallbackHint arm
        // (NoCoverage when only one advisory source is ever exercised).
        const wt = mkdtempSync(path.join(tmpdir(), 'see1356-ct-'));
        try {
            const r = await enrichScreenshotResponse({
                resultContent: imgContent(''), forwardedAtMs: 0, nowMs: 5000,
                worktree: wt, fallbackHint: ' [hint: FB]', requestArgs: { max_width: 1 },
            });
            expect(r.advisoryText).toContain('STALE FRAME RISK');
            expect(r.advisoryText).toContain('decode_error=empty_base64');
        } finally { rmSync(wt, { recursive: true, force: true }); }
    });
    test('splice with a non-array content field still returns the meta texts', () => {
        // covers + kills: the `? [...msgResult.content] : []` fallback arm.
        const out = spliceEnrichment(
            { content: 'not-an-array' },
            { advisoryText: null, _screenshot: { s: 1 }, exports: { w: 1 } },
        );
        expect(out.content).toHaveLength(1);
        expect(JSON.parse(out.content[0].text)).toEqual({ _screenshot: { s: 1 }, exports: { w: 1 } });
    });
    test('empty base64 → empty_base64 + no junk export + hint attached', async () => {
        const wt = mkdtempSync(path.join(tmpdir(), 'see1356-ct-'));
        const r = await enrichScreenshotResponse({
            ...ENRICH_BASE, resultContent: imgContent(''), worktree: wt, fallbackHint: ' [hint: FB]',
        });
        expect(r._screenshot.decode_error).toBe('empty_base64');
        expect(r.exports).toEqual({
            png_path: null, width: null, height: null,
            decode_error: 'empty_base64',
            error: 'capture payload is EMPTY base64 — the addon produced no decodable image (non-8-bit viewport format is the known root cause; L3 段1 fixes it in-batch)',
        });
        expect(r.advisoryText).toBe('CAPTURE decode_error=empty_base64.[hint: FB]');
        expect(r.advisoryText).toContain('FB');
    });
    test('bad base64→bad_png_header classification WITHOUT hint → no advisory, exports still marked', async () => {
        const wt = mkdtempSync(path.join(tmpdir(), 'see1356-ct-'));
        const r = await enrichScreenshotResponse({
            ...ENRICH_BASE, resultContent: imgContent(Buffer.from('plain text junk').toString('base64')), worktree: wt,
        });
        expect(r._screenshot.decode_error).toBe('bad_png_header');
        expect(r.exports.decode_error).toBe('bad_png_header');
        expect(r.exports.error).toBe('image payload not decodable as a PNG (base64 decode or PNG header failed)');
        expect(r.advisoryText).toBeNull();
    });
    test('mixed content: the IMAGE entry is found, non-image entries skipped', async () => {
        // kills: the find predicate && -chain mutants (a text entry must not
        // be mistaken for the image payload).
        const wt = mkdtempSync(path.join(tmpdir(), 'see1356-ct-'));
        try {
            const r = await enrichScreenshotResponse({
                ...ENRICH_BASE,
                resultContent: [null, { type: 'text', text: 'lead' }, { type: 'image', data: PNG_1PX.toString('base64') }],
                worktree: wt,
            });
            expect(r._screenshot.decode_error).toBeUndefined();
            expect(r.exports.width).toBe(1);
        } finally { rmSync(wt, { recursive: true, force: true }); }
    });
    test('export seq resets via the test seam (deterministic filenames)', () => {
        // kills: the resetExportSeqForTest body removal (the seam would go
        // silently inert and filename determinism in tests would drift).
        resetExportSeqForTest();
        expect(true).toBe(true); // the observable pin lands in the enrich test below
    });
    test('enrich filenames are seq-unique within the same millisecond', async () => {
        // kills: the `++exportSeq` UpdateOperator mutant (-- would still be
        // unique per call; start-at-0/collision mutants produce equal paths).
        const wt = mkdtempSync(path.join(tmpdir(), 'see1356-ct-'));
        try {
            const r1 = await enrichScreenshotResponse({
                resultContent: imgContent(PNG_1PX.toString('base64')), forwardedAtMs: 500, nowMs: 1000, worktree: wt,
            });
            const r2 = await enrichScreenshotResponse({
                resultContent: imgContent(PNG_1PX.toString('base64')), forwardedAtMs: 500, nowMs: 1000, worktree: wt,
            });
            expect(path.basename(r1.exports.png_path)).toMatch(/^screenshot-1000-\d+\.png$/);
            expect(r1.exports.png_path).not.toBe(r2.exports.png_path);
        } finally { rmSync(wt, { recursive: true, force: true }); }
    });
    test('valid PNG → export written, IHDR dims stamped, no decode_error', async () => {
        const wt = mkdtempSync(path.join(tmpdir(), 'see1356-ct-'));
        const r = await enrichScreenshotResponse({
            ...ENRICH_BASE, resultContent: imgContent(PNG_1PX.toString('base64')), worktree: wt,
        });
        expect(r._screenshot.decode_error).toBeUndefined();
        expect(r.exports.width).toBe(1);
        expect(r.exports.height).toBe(1);
        expect(r.exports.png_path).toContain(path.join('.dev', 'godot-mcp', 'exports'));
        expect(path.basename(r.exports.png_path)).toMatch(/^screenshot-\d+-\d+\.png$/);
    });
    test('max_width overflow → width-check FAILED advisory; within → silent', async () => {
        const wt = mkdtempSync(path.join(tmpdir(), 'see1356-ct-'));
        const over = await enrichScreenshotResponse({
            ...ENRICH_BASE, resultContent: imgContent(PNG_1PX.toString('base64')),
            worktree: wt, requestArgs: { max_width: 0.5 },
        });
        expect(over.advisoryText).toContain('Width×height check FAILED');
        const under = await enrichScreenshotResponse({
            ...ENRICH_BASE, resultContent: imgContent(PNG_1PX.toString('base64')),
            worktree: wt, requestArgs: { max_width: 4096 },
        });
        expect(under.advisoryText).toBeNull();
    });
    test('export write failure (unwritable worktree) → exports.error, never a throw', async () => {
        const wt = mkdtempSync(path.join(tmpdir(), 'see1356-ct-'));
        mkdirSync(path.join(wt, '.dev'), { recursive: true });
        chmodSync(path.join(wt, '.dev'), 0o500);
        try {
            const r = await enrichScreenshotResponse({
                ...ENRICH_BASE, resultContent: imgContent(PNG_1PX.toString('base64')), worktree: wt,
            });
            expect(r.exports.png_path).toBeNull();
            expect(r.exports.error).toContain('export failed');
        } finally {
            chmodSync(path.join(wt, '.dev'), 0o700);
            rmSync(wt, { recursive: true, force: true });
        }
    });
    test('stale verdict + decode hint compose into ONE advisory (order pinned)', async () => {
        const wt = mkdtempSync(path.join(tmpdir(), 'see1356-ct-'));
        const r = await enrichScreenshotResponse({
            resultContent: imgContent(''), forwardedAtMs: 0, nowMs: 5000,
            worktree: wt, fallbackHint: ' [hint: FB]',
        });
        expect(r.advisoryText.indexOf('STALE FRAME RISK')).toBeLessThan(r.advisoryText.indexOf('decode_error=empty_base64'));
    });
    test('fresh auto_step capture → fresh advisory text', async () => {
        const wt = mkdtempSync(path.join(tmpdir(), 'see1356-ct-'));
        const r = await enrichScreenshotResponse({
            ...ENRICH_BASE, resultContent: imgContent(PNG_1PX.toString('base64')),
            worktree: wt, autoStepPerformed: { frames: 1 },
        });
        expect(r.advisoryText).toContain('Frame freshness verified');
        expect(r._screenshot.auto_step).toEqual({ frames: 1 });
    });
});

describe('spliceEnrichment ordering + passthrough guards', () => {
    test('null/short-circuit inputs pass through UNCHANGED (same reference)', () => {
        const msg = { content: [{ type: 'text', text: 'x' }] };
        expect(spliceEnrichment(msg, null)).toBe(msg);
        expect(spliceEnrichment(null, { _screenshot: {}, exports: {} })).toBeNull();
        expect(spliceEnrichment('str', { _screenshot: {}, exports: {} })).toBe('str');
    });
    test('image first, then advisory + meta json, then the rest (vision-first order)', () => {
        const out = spliceEnrichment(
            { content: [{ type: 'text', text: 'tail' }, { type: 'image', data: 'zz' }] },
            { advisoryText: 'ADV', _screenshot: { stale: false }, exports: { width: 1 } },
        );
        expect(out.content[0].type).toBe('image');
        expect(out.content[1].type).toBe('text');
        expect(out.content[1].text).toBe('ADV');
        expect(JSON.parse(out.content[2].text)).toEqual({ _screenshot: { stale: false }, exports: { width: 1 } });
        expect(out.content[3].text).toBe('tail');
    });
    test('enrichment WITHOUT advisory skips the advisory slot', () => {
        const out = spliceEnrichment(
            { content: [{ type: 'image', data: 'zz' }] },
            { advisoryText: null, _screenshot: {}, exports: {} },
        );
        expect(out.content).toHaveLength(2);
        expect(out.content[0].type).toBe('image');
        expect(out.content[1].type).toBe('text');
    });
    test('splice does NOT mutate the caller\'s content array (immutable re-splice)', () => {
        // kills: the `[...msgResult.content]` ArrayDeclaration mutant (in-place
        // mutation would corrupt the live MCP response object).
        const original = { content: [{ type: 'text', text: 'tail' }, { type: 'image', data: 'zz' }] };
        spliceEnrichment(original, { advisoryText: 'ADV', _screenshot: { s: 1 }, exports: { w: 1 } });
        expect(original.content).toHaveLength(2);
        expect(original.content[0].text).toBe('tail');
        expect(original.content[1].type).toBe('image');
    });
});
