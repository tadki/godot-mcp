// SEE-1240 WS-3 — frozen-friendly capture contract + screenshot disk export.
//
// Proxy-side enrichment of screenshot tool responses. The vendored addon
// (addons/godot_mcp/) is a red line, so the C3/C4 contract (SEE-1239 R2
// consensus: frame-age metadata + stale warning + opt-in auto-step + exports
// dir + width×height verification) lives entirely here, wrapping the existing
// capture path without changing its wire vocabulary.
//
// ## C3 — frame-age metadata contract
//
// The addon's `_capture_and_send_screenshot` awaits `frame_post_draw` before
// grabbing the viewport texture, so a captured frame is at most one engine
// frame old AT THE ADDON — but the agent-visible staleness problem is bigger:
// input injection / exec mutations land AFTER the last drawn frame when the
// game is frozen or paused, so the texture still shows the pre-mutation scene.
// The capture itself is honest; what the caller cannot see is the relationship
// between the frame and the game state they just mutated.
//
// The contract: the PROXY records, per screenshot tools/call, the moment the
// request was forwarded and any game-time step it performed on the caller's
// behalf (auto_step), and stamps every successful response with:
//   _screenshot: {
//     captured_at_ms,        // proxy wall clock at response
//     capture_latency_ms,    // forward → response (includes a frozen game's
//                            // frame_post_draw wait, which only resolves on
//                            // the next step/thaw — a large value IS the
//                            // staleness signal)
//     auto_step: {...}|null, // the proxy-performed step this capture follows
//     stale: <bool>,         // capture_latency_ms exceeded the stale threshold
//   }
// plus a leading text warning block when stale. The pure heuristics live in
// this module (unit-testable); the proxy owns the wall-clock marks.
//
// The SEE-1166 amber-pixel oracle (real-machine red/green in
// .dev/godot-mcp/tests/) validates the end-to-end contract: a stale-frame
// capture (set → no step → capture) must surface `stale:true`, and after the
// contract-approved fresh capture the amber channel must read as drawn.
//
// ## C4 — screenshot disk export (one-stop artifact)
//
// Every successful screenshot tool response also carries
//   exports: { png_path, width, height }
// with the full-resolution PNG written under <worktree>/.dev/godot-mcp/exports/
// (agent-readable in WSL; git-ignored). The base64 image that rides the MCP
// response stays untouched (context cost unchanged); the export is the durable
// artifact for understand_image / --attachment pipelines.
//
// The base64 in the response is the RESIZED image when the addon applied
// max_width; writing it back out gives a resized PNG. To honor the D3 ruling
// (full resolution, disk bypasses the bridge resize) the caller passes
// max_width large enough (or omits it) — the addon skips resize when
// max_width >= frame width, and the PNG bytes then ARE native. The proxy
// stamps width×height from the PNG header so a caller can VERIFY the actual
// resolution of what landed on disk.
//
// The width×height pair is decoded from the PNG IHDR (bytes 16..24) — no image
// library dependency. A decode failure marks exports with a decode_error note
// instead of guessing.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// The addon's frame_post_draw wait under a frozen game blocks until the next
// step/thaw — those captures take seconds, not milliseconds. A live game's
// capture lands well under a second. Anything beyond the threshold means the
// response arrived long after the request was issued, which under freeze/pause
// means the frame pre-dates the state the caller believes they captured.
export const DEFAULT_STALE_CAPTURE_MS = 1500;

// Fresh capture following an explicit auto_step: the step just drew the target
// state, but give the engine a full step's worth of slack before declaring the
// frame stale (a step draws at least one frame; latency here is dominated by
// transport, not by a blocked frame_post_draw).
export const AUTO_STEP_STALE_MULTIPLIER = 1; // threshold unchanged; auto_step marks the capture fresh

// Export root, relative to the resolved worktree. git-ignored at repo level
// (.gitignore: .dev/godot-mcp/exports/).
export const EXPORTS_RELDIR = path.join('.dev', 'godot-mcp', 'exports');

// Cap concurrent export filenames per second implicitly via a monotonic
// counter — never Date-based alone (two captures in the same millisecond must
// not collide, and tests need determinism).
let exportSeq = 0;

export function resetExportSeqForTest() {
    exportSeq = 0;
}

// --- Pure helpers -------------------------------------------------------------

// Decode width/height from PNG bytes (IHDR big-endian at fixed offsets).
// Returns { width, height } or null when the buffer is not a PNG we understand.
export function pngDimensions(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
    // Signature: 89 50 4E 47 0D 0A 1A 0A, then IHDR length/type.
    if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
    if (buf.readUInt32BE(12) !== 0x49484452) return null; // 'IHDR'
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Decode base64 (the MCP image payload) into a Buffer, or null on failure.
export function base64ToBuffer(b64) {
    if (typeof b64 !== 'string' || b64.length === 0) return null;
    try {
        return Buffer.from(b64, 'base64');
    } catch {
        return null;
    }
}

// C3 verdict for one capture. Pure: (latency, autoStep, threshold, mutation) →
// verdict. Two staleness signals compose:
//   1. latency over threshold — the frame_post_draw wait resolved late, which
//      under freeze/pause means the frame pre-dates the request;
//   2. mutation without frame advance — an exec/input mutation was forwarded
//      more recently than the last step/thaw that would have DRAWN it, so the
//      captured texture shows the pre-mutation scene whenever the game does not
//      redraw on its own (frozen/paused). This catches the fast RED case that
//      latency cannot see.
// An auto_step capture is definitionally fresh (the step drew the frame we
// captured), so neither signal marks it stale.
export function frameAgeVerdict({ latencyMs, autoStep = null, thresholdMs = DEFAULT_STALE_CAPTURE_MS, mutationBeforeCaptureMs = 0, lastFrameAdvanceMs = 0 }) {
    const latency = Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : 0;
    if (autoStep) {
        return { stale: false, latencyMs: latency, reason: 'auto_step' };
    }
    if (mutationBeforeCaptureMs > 0 && mutationBeforeCaptureMs > lastFrameAdvanceMs) {
        return {
            stale: true,
            latencyMs: latency,
            reason: 'no_step_after_mutation',
        };
    }
    return {
        stale: latency > thresholdMs,
        latencyMs: latency,
        reason: latency > thresholdMs ? 'latency_over_threshold' : 'ok',
    };
}

// The stale advisory text. States the contract, the observed numbers, and the
// approved remedy — actionable, not scolding. Kept as a function so tests can
// pin the exact wording. `reason` selects the diagnosis wording.
export function staleAdvisoryText(verdict, autoStepEnabled = false) {
    const diagnosis = verdict.reason === 'no_step_after_mutation'
        ? 'An exec/input mutation was applied after the last game-time frame advance — the captured texture shows the PRE-MUTATION scene (frozen/paused games only redraw on step/thaw).'
        : `Capture latency ${verdict.latencyMs}ms exceeds the ${DEFAULT_STALE_CAPTURE_MS}ms freshness threshold — the frame_post_draw wait resolved late (frozen/paused games only redraw on step/thaw).`;
    const lines = [
        `⚠ STALE FRAME RISK (${verdict.reason}): ${diagnosis}`,
        'Remedy: advance one frame (godot_game_time step frames=1) and re-capture, or call screenshot_game with auto_step=true to have the step performed for you.',
    ];
    if (!autoStepEnabled) {
        lines.push('This capture ran WITHOUT auto_step (opt-in); pass arguments.auto_step=true to opt in.');
    }
    return lines.join(' ');
}

// Fresh-capture confirmation (short, rides every auto_step capture so the
// caller can tell contract-approved frames from unverified ones).
export function freshAdvisoryText(verdict) {
    return `Frame freshness verified: capture latency ${verdict.latencyMs}ms (within threshold), auto_step performed before capture.`;
}

// --- Response enrichment ------------------------------------------------------

// What one screenshot tools/call needs stamped onto its response. The proxy
// records `forwardedAtMs` when it forwards the call, and hands the response's
// first image content plus the resolved worktree to this function.
//
// Returns null when there is nothing to enrich (no image content — error
// responses are untouched), or an object describing the additions:
//   { advisoryText: string|null, _screenshot: {...}, exports: {...}|null }
// The caller (proxy) is responsible for splicing these into the MCP response.
export async function enrichScreenshotResponse({
    resultContent,
    forwardedAtMs,
    nowMs,
    autoStepRequested = false,
    autoStepPerformed = null,
    worktree,
    requestArgs = {},
    mutationBeforeCaptureMs = 0,
    lastFrameAdvanceMs = 0,
}) {
    if (!Array.isArray(resultContent)) return null;
    const image = resultContent.find((c) => c && c.type === 'image' && typeof c.data === 'string');
    if (!image) return null;

    const latencyMs = Number.isFinite(forwardedAtMs) && Number.isFinite(nowMs)
        ? Math.max(0, nowMs - forwardedAtMs)
        : 0;
    const verdict = frameAgeVerdict({
        latencyMs,
        autoStep: autoStepPerformed,
        mutationBeforeCaptureMs,
        lastFrameAdvanceMs,
    });

    // C4: write the full PNG to the exports dir and decode true dimensions.
    // Node's base64 decode is lenient (garbage in → garbage bytes out), so
    // "decodable" here means: decodes AND carries the PNG signature/IHDR —
    // otherwise no export file is written at all (never a junk .png on disk).
    let exportsInfo = null;
    let advisoryExtra = null;
    const png = base64ToBuffer(image.data);
    const dims = png ? pngDimensions(png) : null;
    if (png && dims) {
        const fname = `screenshot-${nowMs}-${++exportSeq}.png`;
        const outPath = path.join(worktree, EXPORTS_RELDIR, fname);
        try {
            await mkdir(path.dirname(outPath), { recursive: true });
            await writeFile(outPath, png);
            exportsInfo = {
                png_path: outPath,
                // width/height come from the PNG header — ground truth on disk.
                width: dims.width,
                height: dims.height,
            };
            // Width×height verification (D3): when the caller passed max_width,
            // the on-disk frame must not EXCEED it (a larger frame means the
            // resize unexpectedly did not run and context cost assumptions are
            // wrong). Missing max_width = native capture, nothing to check.
            const maxW = requestArgs.max_width;
            if (Number.isFinite(maxW) && dims.width > maxW) {
                advisoryExtra =
                    `Width×height check FAILED: on-disk PNG is ${dims.width}x${dims.height} but max_width=${maxW} was requested — the bridge resize did not run as expected.`;
            }
        } catch (err) {
            exportsInfo = {
                png_path: null,
                width: null,
                height: null,
                error: `export failed: ${err && err.message}`,
            };
        }
    } else {
        exportsInfo = { png_path: null, width: null, height: null, error: 'image payload not decodable as a PNG (base64 decode or PNG header failed)' };
    }

    const meta = {
        captured_at_ms: Math.round(nowMs),
        capture_latency_ms: verdict.latencyMs,
        auto_step: autoStepPerformed,
        stale: verdict.stale,
    };

    const advisoryText = verdict.stale
        ? staleAdvisoryText(verdict, autoStepRequested)
        : (autoStepPerformed ? freshAdvisoryText(verdict) : null);
    const fullAdvisory = advisoryExtra
        ? (advisoryText ? `${advisoryText} ${advisoryExtra}` : advisoryExtra)
        : advisoryText;

    return { advisoryText: fullAdvisory, _screenshot: meta, exports: exportsInfo };
}

// Splice the enrichment into an MCP success result. The image stays first
// (vision-first ordering, matching the fork's own screenshot results); the
// advisory rides as the leading text block when present, then a compact JSON
// block carrying _screenshot + exports so structured consumers can parse it.
export function spliceEnrichment(msgResult, enrichment) {
    if (!enrichment || !msgResult || typeof msgResult !== 'object') return msgResult;
    const content = Array.isArray(msgResult.content) ? [...msgResult.content] : [];
    const meta = {
        _screenshot: enrichment._screenshot,
        exports: enrichment.exports,
    };
    const newTexts = [];
    if (enrichment.advisoryText) newTexts.push({ type: 'text', text: enrichment.advisoryText });
    newTexts.push({ type: 'text', text: JSON.stringify(meta) });
    // image first (if any), then advisory/meta texts before the rest (the fork
    // screenshot result is exactly one image, so this ordering is stable).
    const images = content.filter((c) => c && c.type === 'image');
    const rest = content.filter((c) => !c || c.type !== 'image');
    return { ...msgResult, content: [...images, ...newTexts, ...rest] };
}
