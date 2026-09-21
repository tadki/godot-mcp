// proxy/screenshot.mjs — screenshot call classification, capture-contract
// gating, fallback-hint augmentation, opt-in auto-step (extracted from
// godot-mcp-proxy.mjs, SEE-1334 Phase 0a; contract itself lives in
// ../see1240-screenshot-contract.mjs).
import { S } from './state.mjs';
import { forwardToNpx } from './protocol.mjs';

// SEE-1070 #7: detect a tools/call that targets a screenshot, so its error
// response can carry a fallback hint. The addon exposes screenshots as WS
// commands capture_game_screenshot / capture_editor_screenshot; in this
// deployment they surface as godot_editor_read action=screenshot_game|
// screenshot_editor (there is no top-level "screenshot" tool). Match all
// plausible forms so the hint fires regardless of how upstream names them.
// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
function isScreenshotToolsCall(msg) {
    const params = msg && msg.params;
    if (!params || typeof params !== 'object') return false;
    const name = params.name;
    if (typeof name !== 'string') return false;
    if (name === 'screenshot'
        || name === 'capture_game_screenshot'
        || name === 'capture_editor_screenshot') return true;
    if (name.startsWith('screenshot_')) return true;
    if (name === 'godot_editor_read') {
        const action = params.arguments && params.arguments.action;
        return typeof action === 'string' && action.startsWith('screenshot');
    }
    // SEE-1328 §SPEC-014: godot_input carries sequence-frame captures via the
    // screenshot_at_ms entry (per-input and top-level) — those responses ride
    // the same fallback-hint + freshness contract as plain screenshots.
    if (name === 'godot_input') {
        const args = params.arguments;
        if (!args || typeof args !== 'object') return false;
        if (typeof args.screenshot_at_ms !== 'undefined') return true;
        if (Array.isArray(args.inputs)
            && args.inputs.some((e) => e && typeof e === 'object' && typeof e.screenshot_at_ms !== 'undefined')) return true;
        return false;
    }
    return false;
}

// §SPEC-014: two-state capture-contract gate. The enrichment machinery
// (freshness metadata + PNG export + opt-in auto_step) is only meaningful
// against a WARM chain. During the shim-placeholder window (chain not yet
// warm / transport not ready) the call is heading for the hold/warmup paths —
// running auto_step or stamping a forwardedAtMs then would enrich a capture
// that has not been issued (placeholder-era bypass). 'auto_step' and 'enrich'
// both flow through the contract; 'bypass' skips the contract state entirely
// (fallback-hint error tracking is unaffected — it keys off screenshotCallIds).
function screenshotCaptureMode({ warm: warmLocal, transportReady, autoStepRequested = false }) {
    if (!warmLocal || !transportReady) return 'bypass';
    return autoStepRequested ? 'auto_step' : 'enrich';
}

// Hint appended to a screenshot error response. The original error is fully
// preserved (message prepended, existing data spread) — nothing is swallowed.
// §SPEC-014: path fixed to the post-T4 KOL layout (the fallback script lives
// inside the addon submodule; the legacy .dev/godot-mcp/launch path no longer
// exists in a current checkout).
const SCREENSHOT_FALLBACK_HINT =
    ' [hint: screenshot 失败，可调 addons/godot_mcp/launch/screenshot-fallback.sh 兜底抓主屏 → PNG]';
function augmentScreenshotError(error) {
    if (!error || typeof error !== 'object') return error;
    const out = { ...error };
    out.message = typeof out.message === 'string'
        ? out.message + SCREENSHOT_FALLBACK_HINT
        : SCREENSHOT_FALLBACK_HINT.trim();
    const fallback = 'addons/godot_mcp/launch/screenshot-fallback.sh';
    out.data = (out.data && typeof out.data === 'object')
        ? { ...out.data, screenshotFallback: fallback }
        : { screenshotFallback: fallback };
    return out;
}

// SEE-1240 WS-3: screenshot calls awaiting their proxy-performed auto_step.
// id → { line, msg } (the ORIGINAL capture line, forwarded once the step drew).

// Opt-in auto-step for a tracked screenshot call (arguments.auto_step=true):
// run godot_game_time step frames=1 through the internal-exec channel, then
// forward the ORIGINAL capture call. The step result decides the metadata:
// success → autoStepPerformed stamped onto the response's _screenshot block;
// failure → the capture still proceeds (best-effort step), with the failure
// noted in _screenshot.auto_step so the caller can see why freshness is not
// contract-approved.
async function runAutoStepThenForward(screenshotId) {
    const held = S.pendingAutoStepCalls.get(screenshotId);
    if (!held) return;
    const info = S.screenshotContract.get(screenshotId);
    try {
        const stepLine = JSON.stringify({
            jsonrpc: '2.0',
            id: `see1240-ui-inspect-${Date.now()}-autostep`,
            method: 'tools/call',
            params: { name: 'godot_game_time', arguments: { action: 'step', frames: 1 } },
        });
        const stepResult = await new Promise((resolve) => {
            const stepId = JSON.parse(stepLine).id;
            S.internalExecWaiters.set(stepId, resolve);
            const timer = setTimeout(() => {
                if (S.internalExecWaiters.has(stepId)) {
                    S.internalExecWaiters.delete(stepId);
                    resolve({ error: { message: 'auto_step timed out' } });
                }
            }, 45000);
            S.internalExecTimers.set(stepId, timer);
            forwardToNpx(stepLine);
        });
        if (info) {
            info.autoStepPerformed = (stepResult.error !== undefined)
                ? { error: (stepResult.error.message || String(stepResult.error)).slice(0, 200) }
                : { frames: 1, ok: true };
        }
    } catch (err) {
        if (info) info.autoStepPerformed = { error: `auto_step failed: ${err && err.message}` };
    } finally {
        S.pendingAutoStepCalls.delete(screenshotId);
        forwardToNpx(held.line);
    }
}

export {
    isScreenshotToolsCall,
    screenshotCaptureMode,
    augmentScreenshotError,
    runAutoStepThenForward,
};
