// @ts-nocheck
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
// ## Retention (SEE-1328 §SPEC-016 定稿) — report-only, zero automatic cleanup
//
// Exports accumulate under .dev/godot-mcp/exports/ and this module NEVER
// deletes anything: no automatic cleanup, no size/age cap, no unlink/rm on
// exports at any point in the capture path. The directory is git-ignored, so
// retention cost is local disk only. Cleanup is MANUAL, on demand — e.g.
//   find <worktree>/.dev/godot-mcp/exports -name 'screenshot-*.png' \
//     -mtime +30 -delete
// Agents should treat exports as append-only evidence artifacts.
//
// The width×height pair is decoded from the PNG IHDR (bytes 16..24) — no image
// library dependency. A decode failure marks exports with a decode_error note
// instead of guessing.
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// The addon's frame_post_draw wait under a frozen game blocks until the next
// step/thaw — those captures take seconds, not milliseconds. A live game's
// capture lands well under a second. Anything beyond the threshold means the
// response arrived long after the request was issued, which under freeze/pause
// means the frame pre-dates the state the caller believes they captured.
export const DEFAULT_STALE_CAPTURE_MS = 1500;

// §SPEC-015: the freshness threshold is parameterized via
// GODOT_MCP_STALE_CAPTURE_MS (integer ms ≥ 1). Any invalid value (absent,
// empty, non-numeric, zero, negative, fractional) silently falls back to the
// documented default so a typo'd env can never disable the contract.
export function resolveStaleCaptureMs(env = process.env) {
  if (stryMutAct_9fa48("407")) {
    {}
  } else {
    stryCov_9fa48("407");
    const raw = stryMutAct_9fa48("410") ? env || env.GODOT_MCP_STALE_CAPTURE_MS : stryMutAct_9fa48("409") ? false : stryMutAct_9fa48("408") ? true : (stryCov_9fa48("408", "409", "410"), env && env.GODOT_MCP_STALE_CAPTURE_MS);
    if (stryMutAct_9fa48("413") ? typeof raw === 'string' : stryMutAct_9fa48("412") ? false : stryMutAct_9fa48("411") ? true : (stryCov_9fa48("411", "412", "413"), typeof raw !== (stryMutAct_9fa48("414") ? "" : (stryCov_9fa48("414"), 'string')))) return DEFAULT_STALE_CAPTURE_MS;
    // Strict decimal-integer form only: no floats, no exponent notation, no
    // surrounding whitespace — a sloppy value falls back to the default.
    return (stryMutAct_9fa48("417") ? /^\d+$/.test(raw) || Number(raw) >= 1 : stryMutAct_9fa48("416") ? false : stryMutAct_9fa48("415") ? true : (stryCov_9fa48("415", "416", "417"), (stryMutAct_9fa48("421") ? /^\D+$/ : stryMutAct_9fa48("420") ? /^\d$/ : stryMutAct_9fa48("419") ? /^\d+/ : stryMutAct_9fa48("418") ? /\d+$/ : (stryCov_9fa48("418", "419", "420", "421"), /^\d+$/)).test(raw) && (stryMutAct_9fa48("424") ? Number(raw) < 1 : stryMutAct_9fa48("423") ? Number(raw) > 1 : stryMutAct_9fa48("422") ? true : (stryCov_9fa48("422", "423", "424"), Number(raw) >= 1)))) ? Number(raw) : DEFAULT_STALE_CAPTURE_MS;
  }
}

// Fresh capture following an explicit auto_step: the step just drew the target
// state, but give the engine a full step's worth of slack before declaring the
// frame stale (a step draws at least one frame; latency here is dominated by
// transport, not by a blocked frame_post_draw).
export const AUTO_STEP_STALE_MULTIPLIER = 1; // threshold unchanged; auto_step marks the capture fresh

// Export root, relative to the resolved worktree. git-ignored at repo level
// (.gitignore: .dev/godot-mcp/exports/).
export const EXPORTS_RELDIR = path.join(stryMutAct_9fa48("425") ? "" : (stryCov_9fa48("425"), '.dev'), stryMutAct_9fa48("426") ? "" : (stryCov_9fa48("426"), 'godot-mcp'), stryMutAct_9fa48("427") ? "" : (stryCov_9fa48("427"), 'exports'));

// Cap concurrent export filenames per second implicitly via a monotonic
// counter — never Date-based alone (two captures in the same millisecond must
// not collide, and tests need determinism).
let exportSeq = 0;
export function resetExportSeqForTest() {
  if (stryMutAct_9fa48("428")) {
    {}
  } else {
    stryCov_9fa48("428");
    exportSeq = 0;
  }
}

// --- Pure helpers -------------------------------------------------------------

// Decode width/height from PNG bytes (IHDR big-endian at fixed offsets).
// Returns { width, height } or null when the buffer is not a PNG we understand.
export function pngDimensions(buf) {
  if (stryMutAct_9fa48("429")) {
    {}
  } else {
    stryCov_9fa48("429");
    if (stryMutAct_9fa48("432") ? !Buffer.isBuffer(buf) && buf.length < 24 : stryMutAct_9fa48("431") ? false : stryMutAct_9fa48("430") ? true : (stryCov_9fa48("430", "431", "432"), (stryMutAct_9fa48("433") ? Buffer.isBuffer(buf) : (stryCov_9fa48("433"), !Buffer.isBuffer(buf))) || (stryMutAct_9fa48("436") ? buf.length >= 24 : stryMutAct_9fa48("435") ? buf.length <= 24 : stryMutAct_9fa48("434") ? false : (stryCov_9fa48("434", "435", "436"), buf.length < 24)))) return null;
    // Signature: 89 50 4E 47 0D 0A 1A 0A, then IHDR length/type.
    if (stryMutAct_9fa48("439") ? buf.readUInt32BE(0) !== 0x89504e47 && buf.readUInt32BE(4) !== 0x0d0a1a0a : stryMutAct_9fa48("438") ? false : stryMutAct_9fa48("437") ? true : (stryCov_9fa48("437", "438", "439"), (stryMutAct_9fa48("441") ? buf.readUInt32BE(0) === 0x89504e47 : stryMutAct_9fa48("440") ? false : (stryCov_9fa48("440", "441"), buf.readUInt32BE(0) !== 0x89504e47)) || (stryMutAct_9fa48("443") ? buf.readUInt32BE(4) === 0x0d0a1a0a : stryMutAct_9fa48("442") ? false : (stryCov_9fa48("442", "443"), buf.readUInt32BE(4) !== 0x0d0a1a0a)))) return null;
    if (stryMutAct_9fa48("446") ? buf.readUInt32BE(12) === 0x49484452 : stryMutAct_9fa48("445") ? false : stryMutAct_9fa48("444") ? true : (stryCov_9fa48("444", "445", "446"), buf.readUInt32BE(12) !== 0x49484452)) return null; // 'IHDR'
    return stryMutAct_9fa48("447") ? {} : (stryCov_9fa48("447"), {
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20)
    });
  }
}

// Decode base64 (the MCP image payload) into a Buffer, or null on failure.
export function base64ToBuffer(b64) {
  if (stryMutAct_9fa48("448")) {
    {}
  } else {
    stryCov_9fa48("448");
    if (stryMutAct_9fa48("451") ? typeof b64 !== 'string' && b64.length === 0 : stryMutAct_9fa48("450") ? false : stryMutAct_9fa48("449") ? true : (stryCov_9fa48("449", "450", "451"), (stryMutAct_9fa48("453") ? typeof b64 === 'string' : stryMutAct_9fa48("452") ? false : (stryCov_9fa48("452", "453"), typeof b64 !== (stryMutAct_9fa48("454") ? "" : (stryCov_9fa48("454"), 'string')))) || (stryMutAct_9fa48("456") ? b64.length !== 0 : stryMutAct_9fa48("455") ? false : (stryCov_9fa48("455", "456"), b64.length === 0)))) return null;
    try {
      if (stryMutAct_9fa48("457")) {
        {}
      } else {
        stryCov_9fa48("457");
        return Buffer.from(b64, stryMutAct_9fa48("458") ? "" : (stryCov_9fa48("458"), 'base64'));
      }
    } catch {
      if (stryMutAct_9fa48("459")) {
        {}
      } else {
        stryCov_9fa48("459");
        return null;
      }
    }
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
export function frameAgeVerdict({
  latencyMs,
  autoStep = null,
  thresholdMs = resolveStaleCaptureMs(),
  mutationBeforeCaptureMs = 0,
  lastFrameAdvanceMs = 0
}) {
  if (stryMutAct_9fa48("460")) {
    {}
  } else {
    stryCov_9fa48("460");
    const latency = Number.isFinite(latencyMs) ? stryMutAct_9fa48("461") ? Math.min(0, Math.round(latencyMs)) : (stryCov_9fa48("461"), Math.max(0, Math.round(latencyMs))) : 0;
    if (stryMutAct_9fa48("463") ? false : stryMutAct_9fa48("462") ? true : (stryCov_9fa48("462", "463"), autoStep)) {
      if (stryMutAct_9fa48("464")) {
        {}
      } else {
        stryCov_9fa48("464");
        return stryMutAct_9fa48("465") ? {} : (stryCov_9fa48("465"), {
          stale: stryMutAct_9fa48("466") ? true : (stryCov_9fa48("466"), false),
          latencyMs: latency,
          reason: stryMutAct_9fa48("467") ? "" : (stryCov_9fa48("467"), 'auto_step')
        });
      }
    }
    if (stryMutAct_9fa48("470") ? mutationBeforeCaptureMs > 0 || mutationBeforeCaptureMs > lastFrameAdvanceMs : stryMutAct_9fa48("469") ? false : stryMutAct_9fa48("468") ? true : (stryCov_9fa48("468", "469", "470"), (stryMutAct_9fa48("473") ? mutationBeforeCaptureMs <= 0 : stryMutAct_9fa48("472") ? mutationBeforeCaptureMs >= 0 : stryMutAct_9fa48("471") ? true : (stryCov_9fa48("471", "472", "473"), mutationBeforeCaptureMs > 0)) && (stryMutAct_9fa48("476") ? mutationBeforeCaptureMs <= lastFrameAdvanceMs : stryMutAct_9fa48("475") ? mutationBeforeCaptureMs >= lastFrameAdvanceMs : stryMutAct_9fa48("474") ? true : (stryCov_9fa48("474", "475", "476"), mutationBeforeCaptureMs > lastFrameAdvanceMs)))) {
      if (stryMutAct_9fa48("477")) {
        {}
      } else {
        stryCov_9fa48("477");
        return stryMutAct_9fa48("478") ? {} : (stryCov_9fa48("478"), {
          stale: stryMutAct_9fa48("479") ? false : (stryCov_9fa48("479"), true),
          latencyMs: latency,
          reason: stryMutAct_9fa48("480") ? "" : (stryCov_9fa48("480"), 'no_step_after_mutation')
        });
      }
    }
    return stryMutAct_9fa48("481") ? {} : (stryCov_9fa48("481"), {
      stale: stryMutAct_9fa48("485") ? latency <= thresholdMs : stryMutAct_9fa48("484") ? latency >= thresholdMs : stryMutAct_9fa48("483") ? false : stryMutAct_9fa48("482") ? true : (stryCov_9fa48("482", "483", "484", "485"), latency > thresholdMs),
      latencyMs: latency,
      thresholdMs,
      reason: (stryMutAct_9fa48("489") ? latency <= thresholdMs : stryMutAct_9fa48("488") ? latency >= thresholdMs : stryMutAct_9fa48("487") ? false : stryMutAct_9fa48("486") ? true : (stryCov_9fa48("486", "487", "488", "489"), latency > thresholdMs)) ? stryMutAct_9fa48("490") ? "" : (stryCov_9fa48("490"), 'latency_over_threshold') : stryMutAct_9fa48("491") ? "" : (stryCov_9fa48("491"), 'ok')
    });
  }
}

// The stale advisory text. States the contract, the observed numbers, and the
// approved remedy — actionable, not scolding. Kept as a function so tests can
// pin the exact wording. `reason` selects the diagnosis wording.
export function staleAdvisoryText(verdict, autoStepEnabled = stryMutAct_9fa48("492") ? true : (stryCov_9fa48("492"), false)) {
  if (stryMutAct_9fa48("493")) {
    {}
  } else {
    stryCov_9fa48("493");
    const diagnosis = (stryMutAct_9fa48("496") ? verdict.reason !== 'no_step_after_mutation' : stryMutAct_9fa48("495") ? false : stryMutAct_9fa48("494") ? true : (stryCov_9fa48("494", "495", "496"), verdict.reason === (stryMutAct_9fa48("497") ? "" : (stryCov_9fa48("497"), 'no_step_after_mutation')))) ? stryMutAct_9fa48("498") ? "" : (stryCov_9fa48("498"), 'An exec/input mutation was applied after the last game-time frame advance — the captured texture shows the PRE-MUTATION scene (frozen/paused games only redraw on step/thaw).') : stryMutAct_9fa48("499") ? `` : (stryCov_9fa48("499"), `Capture latency ${verdict.latencyMs}ms exceeds the ${stryMutAct_9fa48("500") ? verdict.thresholdMs && DEFAULT_STALE_CAPTURE_MS : (stryCov_9fa48("500"), verdict.thresholdMs ?? DEFAULT_STALE_CAPTURE_MS)}ms freshness threshold — the frame_post_draw wait resolved late (frozen/paused games only redraw on step/thaw).`);
    const lines = stryMutAct_9fa48("501") ? [] : (stryCov_9fa48("501"), [stryMutAct_9fa48("502") ? `` : (stryCov_9fa48("502"), `⚠ STALE FRAME RISK (${verdict.reason}): ${diagnosis}`), stryMutAct_9fa48("503") ? "" : (stryCov_9fa48("503"), 'Remedy: advance one frame (godot_game_time step frames=1) and re-capture, or call screenshot_game with auto_step=true to have the step performed for you.')]);
    if (stryMutAct_9fa48("506") ? false : stryMutAct_9fa48("505") ? true : stryMutAct_9fa48("504") ? autoStepEnabled : (stryCov_9fa48("504", "505", "506"), !autoStepEnabled)) {
      if (stryMutAct_9fa48("507")) {
        {}
      } else {
        stryCov_9fa48("507");
        lines.push(stryMutAct_9fa48("509") ? "" : (stryCov_9fa48("509"), 'This capture ran WITHOUT auto_step (opt-in); pass arguments.auto_step=true to opt in.'));
      }
    }
    return lines.join(stryMutAct_9fa48("510") ? "" : (stryCov_9fa48("510"), ' '));
  }
}

// Fresh-capture confirmation (short, rides every auto_step capture so the
// caller can tell contract-approved frames from unverified ones).
export function freshAdvisoryText(verdict) {
  if (stryMutAct_9fa48("511")) {
    {}
  } else {
    stryCov_9fa48("511");
    return stryMutAct_9fa48("512") ? `` : (stryCov_9fa48("512"), `Frame freshness verified: capture latency ${verdict.latencyMs}ms (within threshold), auto_step performed before capture.`);
  }
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
// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
export async function enrichScreenshotResponse({
  resultContent,
  forwardedAtMs,
  nowMs,
  autoStepRequested = stryMutAct_9fa48("513") ? true : (stryCov_9fa48("513"), false),
  autoStepPerformed = null,
  worktree,
  requestArgs = {},
  mutationBeforeCaptureMs = 0,
  lastFrameAdvanceMs = 0,
  fallbackHint = null
}) {
  if (stryMutAct_9fa48("514")) {
    {}
  } else {
    stryCov_9fa48("514");
    if (stryMutAct_9fa48("517") ? false : stryMutAct_9fa48("516") ? true : stryMutAct_9fa48("515") ? Array.isArray(resultContent) : (stryCov_9fa48("515", "516", "517"), !Array.isArray(resultContent))) return null;
    const image = resultContent.find(stryMutAct_9fa48("518") ? () => undefined : (stryCov_9fa48("518"), c => stryMutAct_9fa48("521") ? c && c.type === 'image' || typeof c.data === 'string' : stryMutAct_9fa48("520") ? false : stryMutAct_9fa48("519") ? true : (stryCov_9fa48("519", "520", "521"), (stryMutAct_9fa48("523") ? c || c.type === 'image' : stryMutAct_9fa48("522") ? true : (stryCov_9fa48("522", "523"), c && (stryMutAct_9fa48("525") ? c.type !== 'image' : stryMutAct_9fa48("524") ? true : (stryCov_9fa48("524", "525"), c.type === (stryMutAct_9fa48("526") ? "" : (stryCov_9fa48("526"), 'image')))))) && (stryMutAct_9fa48("528") ? typeof c.data !== 'string' : stryMutAct_9fa48("527") ? true : (stryCov_9fa48("527", "528"), typeof c.data === (stryMutAct_9fa48("529") ? "" : (stryCov_9fa48("529"), 'string')))))));
    if (stryMutAct_9fa48("532") ? false : stryMutAct_9fa48("531") ? true : stryMutAct_9fa48("530") ? image : (stryCov_9fa48("530", "531", "532"), !image)) return null;
    const latencyMs = (stryMutAct_9fa48("535") ? Number.isFinite(forwardedAtMs) || Number.isFinite(nowMs) : stryMutAct_9fa48("534") ? false : stryMutAct_9fa48("533") ? true : (stryCov_9fa48("533", "534", "535"), Number.isFinite(forwardedAtMs) && Number.isFinite(nowMs))) ? stryMutAct_9fa48("536") ? Math.min(0, nowMs - forwardedAtMs) : (stryCov_9fa48("536"), Math.max(0, stryMutAct_9fa48("537") ? nowMs + forwardedAtMs : (stryCov_9fa48("537"), nowMs - forwardedAtMs))) : 0;
    const verdict = frameAgeVerdict(stryMutAct_9fa48("538") ? {} : (stryCov_9fa48("538"), {
      latencyMs,
      autoStep: autoStepPerformed,
      mutationBeforeCaptureMs,
      lastFrameAdvanceMs
    }));

    // C4: write the full PNG to the exports dir and decode true dimensions.
    // Node's base64 decode is lenient (garbage in → garbage bytes out), so
    // "decodable" here means: decodes AND carries the PNG signature/IHDR —
    // otherwise no export file is written at all (never a junk .png on disk).
    let exportsInfo = null;
    let advisoryExtra = null;
    // SEE-1356 L3 段2 (§SPEC-L3-01): IHDR deep check on the proxy contract
    // module — a decode failure is CLASSIFIED (empty base64 / bad PNG header)
    // and stamped onto _screenshot.decode_error with the existing fallback
    // hint attached. The addon-side format fix (L3 段1, batch 2) owns the
    // root cause; this proxy-side gate is the defensive layer that makes
    // "empty payload" VISIBLE instead of a silent export skip — the "偶发自愈"
    // blind spot the capture contract cannot see.
    //
    // SEE-1356 batch-2 cleanup (hardener observation ①): the `bad_base64`
    // classification was unreachable — enrich's find() above already
    // guarantees a non-empty string payload, and Buffer.from on a string
    // never returns null. Only two classifications remain.
    let decodeError = null;
    if (stryMutAct_9fa48("541") ? image.data.length !== 0 : stryMutAct_9fa48("540") ? false : stryMutAct_9fa48("539") ? true : (stryCov_9fa48("539", "540", "541"), image.data.length === 0)) {
      if (stryMutAct_9fa48("542")) {
        {}
      } else {
        stryCov_9fa48("542");
        decodeError = stryMutAct_9fa48("543") ? "" : (stryCov_9fa48("543"), 'empty_base64');
      }
    }
    const png = decodeError ? null : base64ToBuffer(image.data);
    const dims = png ? pngDimensions(png) : null;
    if (stryMutAct_9fa48("546") ? !decodeError || !dims : stryMutAct_9fa48("545") ? false : stryMutAct_9fa48("544") ? true : (stryCov_9fa48("544", "545", "546"), (stryMutAct_9fa48("547") ? decodeError : (stryCov_9fa48("547"), !decodeError)) && (stryMutAct_9fa48("548") ? dims : (stryCov_9fa48("548"), !dims)))) decodeError = stryMutAct_9fa48("549") ? "" : (stryCov_9fa48("549"), 'bad_png_header');
    if (stryMutAct_9fa48("552") ? png || dims : stryMutAct_9fa48("551") ? false : stryMutAct_9fa48("550") ? true : (stryCov_9fa48("550", "551", "552"), png && dims)) {
      if (stryMutAct_9fa48("553")) {
        {}
      } else {
        stryCov_9fa48("553");
        const fname = stryMutAct_9fa48("554") ? `` : (stryCov_9fa48("554"), `screenshot-${nowMs}-${stryMutAct_9fa48("555") ? --exportSeq : (stryCov_9fa48("555"), ++exportSeq)}.png`);
        const outPath = path.join(worktree, EXPORTS_RELDIR, fname);
        try {
          if (stryMutAct_9fa48("556")) {
            {}
          } else {
            stryCov_9fa48("556");
            await mkdir(path.dirname(outPath), stryMutAct_9fa48("557") ? {} : (stryCov_9fa48("557"), {
              recursive: stryMutAct_9fa48("558") ? false : (stryCov_9fa48("558"), true)
            }));
            await writeFile(outPath, png);
            exportsInfo = stryMutAct_9fa48("559") ? {} : (stryCov_9fa48("559"), {
              png_path: outPath,
              // width/height come from the PNG header — ground truth on disk.
              width: dims.width,
              height: dims.height
            });
            // Width×height verification (D3): when the caller passed max_width,
            // the on-disk frame must not EXCEED it (a larger frame means the
            // resize unexpectedly did not run and context cost assumptions are
            // wrong). Missing max_width = native capture, nothing to check.
            const maxW = requestArgs.max_width;
            if (stryMutAct_9fa48("562") ? Number.isFinite(maxW) || dims.width > maxW : stryMutAct_9fa48("561") ? false : stryMutAct_9fa48("560") ? true : (stryCov_9fa48("560", "561", "562"), Number.isFinite(maxW) && (stryMutAct_9fa48("565") ? dims.width <= maxW : stryMutAct_9fa48("564") ? dims.width >= maxW : stryMutAct_9fa48("563") ? true : (stryCov_9fa48("563", "564", "565"), dims.width > maxW)))) {
              if (stryMutAct_9fa48("566")) {
                {}
              } else {
                stryCov_9fa48("566");
                advisoryExtra = stryMutAct_9fa48("567") ? `` : (stryCov_9fa48("567"), `Width×height check FAILED: on-disk PNG is ${dims.width}x${dims.height} but max_width=${maxW} was requested — the bridge resize did not run as expected.`);
              }
            }
          }
        } catch (err) {
          if (stryMutAct_9fa48("568")) {
            {}
          } else {
            stryCov_9fa48("568");
            exportsInfo = stryMutAct_9fa48("569") ? {} : (stryCov_9fa48("569"), {
              png_path: null,
              width: null,
              height: null,
              error: stryMutAct_9fa48("570") ? `` : (stryCov_9fa48("570"), `export failed: ${stryMutAct_9fa48("573") ? err || err.message : stryMutAct_9fa48("572") ? false : stryMutAct_9fa48("571") ? true : (stryCov_9fa48("571", "572", "573"), err && err.message)}`)
            });
          }
        }
      }
    } else {
      if (stryMutAct_9fa48("574")) {
        {}
      } else {
        stryCov_9fa48("574");
        exportsInfo = stryMutAct_9fa48("575") ? {} : (stryCov_9fa48("575"), {
          png_path: null,
          width: null,
          height: null,
          decode_error: decodeError,
          error: (stryMutAct_9fa48("578") ? decodeError !== 'empty_base64' : stryMutAct_9fa48("577") ? false : stryMutAct_9fa48("576") ? true : (stryCov_9fa48("576", "577", "578"), decodeError === (stryMutAct_9fa48("579") ? "" : (stryCov_9fa48("579"), 'empty_base64')))) ? stryMutAct_9fa48("580") ? "" : (stryCov_9fa48("580"), 'capture payload is EMPTY base64 — the addon produced no decodable image (non-8-bit viewport format is the known root cause; L3 段1 fixes it in-batch)') : stryMutAct_9fa48("581") ? "" : (stryCov_9fa48("581"), 'image payload not decodable as a PNG (PNG header check failed)')
        });
        if (stryMutAct_9fa48("583") ? false : stryMutAct_9fa48("582") ? true : (stryCov_9fa48("582", "583"), fallbackHint)) {
          if (stryMutAct_9fa48("584")) {
            {}
          } else {
            stryCov_9fa48("584");
            advisoryExtra = advisoryExtra ? stryMutAct_9fa48("585") ? `` : (stryCov_9fa48("585"), `${advisoryExtra} CAPTURE decode_error=${decodeError}.${stryMutAct_9fa48("586") ? fallbackHint : (stryCov_9fa48("586"), fallbackHint.trim())}`) : stryMutAct_9fa48("587") ? `` : (stryCov_9fa48("587"), `CAPTURE decode_error=${decodeError}.${stryMutAct_9fa48("588") ? fallbackHint : (stryCov_9fa48("588"), fallbackHint.trim())}`);
          }
        }
      }
    }
    const meta = stryMutAct_9fa48("589") ? {} : (stryCov_9fa48("589"), {
      captured_at_ms: Math.round(nowMs),
      capture_latency_ms: verdict.latencyMs,
      auto_step: autoStepPerformed,
      stale: verdict.stale
    });
    if (stryMutAct_9fa48("591") ? false : stryMutAct_9fa48("590") ? true : (stryCov_9fa48("590", "591"), decodeError)) meta.decode_error = decodeError;
    const advisoryText = verdict.stale ? staleAdvisoryText(verdict, autoStepRequested) : autoStepPerformed ? freshAdvisoryText(verdict) : null;
    const fullAdvisory = advisoryExtra ? advisoryText ? stryMutAct_9fa48("592") ? `` : (stryCov_9fa48("592"), `${advisoryText} ${advisoryExtra}`) : advisoryExtra : advisoryText;
    return stryMutAct_9fa48("593") ? {} : (stryCov_9fa48("593"), {
      advisoryText: fullAdvisory,
      _screenshot: meta,
      exports: exportsInfo
    });
  }
}

// Splice the enrichment into an MCP success result. The image stays first
// (vision-first ordering, matching the fork's own screenshot results); the
// advisory rides as the leading text block when present, then a compact JSON
// block carrying _screenshot + exports so structured consumers can parse it.
export function spliceEnrichment(msgResult, enrichment) {
  if (stryMutAct_9fa48("594")) {
    {}
  } else {
    stryCov_9fa48("594");
    if (stryMutAct_9fa48("597") ? (!enrichment || !msgResult) && typeof msgResult !== 'object' : stryMutAct_9fa48("596") ? false : stryMutAct_9fa48("595") ? true : (stryCov_9fa48("595", "596", "597"), (stryMutAct_9fa48("599") ? !enrichment && !msgResult : stryMutAct_9fa48("598") ? false : (stryCov_9fa48("598", "599"), (stryMutAct_9fa48("600") ? enrichment : (stryCov_9fa48("600"), !enrichment)) || (stryMutAct_9fa48("601") ? msgResult : (stryCov_9fa48("601"), !msgResult)))) || (stryMutAct_9fa48("603") ? typeof msgResult === 'object' : stryMutAct_9fa48("602") ? false : (stryCov_9fa48("602", "603"), typeof msgResult !== (stryMutAct_9fa48("604") ? "" : (stryCov_9fa48("604"), 'object')))))) return msgResult;
    const content = Array.isArray(msgResult.content) ? stryMutAct_9fa48("605") ? [] : (stryCov_9fa48("605"), [...msgResult.content]) : stryMutAct_9fa48("606") ? ["Stryker was here"] : (stryCov_9fa48("606"), []);
    const meta = stryMutAct_9fa48("607") ? {} : (stryCov_9fa48("607"), {
      _screenshot: enrichment._screenshot,
      exports: enrichment.exports
    });
    const newTexts = stryMutAct_9fa48("608") ? ["Stryker was here"] : (stryCov_9fa48("608"), []);
    if (stryMutAct_9fa48("610") ? false : stryMutAct_9fa48("609") ? true : (stryCov_9fa48("609", "610"), enrichment.advisoryText)) newTexts.push(stryMutAct_9fa48("612") ? {} : (stryCov_9fa48("612"), {
      type: stryMutAct_9fa48("613") ? "" : (stryCov_9fa48("613"), 'text'),
      text: enrichment.advisoryText
    }));
    newTexts.push(stryMutAct_9fa48("615") ? {} : (stryCov_9fa48("615"), {
      type: stryMutAct_9fa48("616") ? "" : (stryCov_9fa48("616"), 'text'),
      text: JSON.stringify(meta)
    }));
    // image first (if any), then advisory/meta texts before the rest (the fork
    // screenshot result is exactly one image, so this ordering is stable).
    const images = stryMutAct_9fa48("617") ? content : (stryCov_9fa48("617"), content.filter(stryMutAct_9fa48("618") ? () => undefined : (stryCov_9fa48("618"), c => stryMutAct_9fa48("621") ? c || c.type === 'image' : stryMutAct_9fa48("620") ? false : stryMutAct_9fa48("619") ? true : (stryCov_9fa48("619", "620", "621"), c && (stryMutAct_9fa48("623") ? c.type !== 'image' : stryMutAct_9fa48("622") ? true : (stryCov_9fa48("622", "623"), c.type === (stryMutAct_9fa48("624") ? "" : (stryCov_9fa48("624"), 'image'))))))));
    const rest = stryMutAct_9fa48("625") ? content : (stryCov_9fa48("625"), content.filter(stryMutAct_9fa48("626") ? () => undefined : (stryCov_9fa48("626"), c => stryMutAct_9fa48("629") ? !c && c.type !== 'image' : stryMutAct_9fa48("628") ? false : stryMutAct_9fa48("627") ? true : (stryCov_9fa48("627", "628", "629"), (stryMutAct_9fa48("630") ? c : (stryCov_9fa48("630"), !c)) || (stryMutAct_9fa48("632") ? c.type === 'image' : stryMutAct_9fa48("631") ? false : (stryCov_9fa48("631", "632"), c.type !== (stryMutAct_9fa48("633") ? "" : (stryCov_9fa48("633"), 'image'))))))));
    return stryMutAct_9fa48("634") ? {} : (stryCov_9fa48("634"), {
      ...msgResult,
      content: stryMutAct_9fa48("635") ? [] : (stryCov_9fa48("635"), [...images, ...newTexts, ...rest])
    });
  }
}