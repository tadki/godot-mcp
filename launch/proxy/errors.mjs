// proxy/errors.mjs — tools/call error classification + retryable
// augmentation (extracted from godot-mcp-proxy.mjs, SEE-1334 Phase 0a):
// editor_busy (WS-slot competition, 4001) and editor_gone (post-warm death).
import { S } from './state.mjs';
import { GODOT_HOST, GODOT_PORT, KOL_PROGRESS_PROTOCOL } from './config.mjs';
import { stageOrdinal } from '../warmup-stage-parser.mjs';

// SEE-1085 usability: detect a tools/call error caused by a concurrent client
// holding the addon's single WebSocket slot. The godot_mcp addon accepts ONE WS
// client; a second connection is rejected with close code 4001
// (ALREADY_CONNECTED) and a "another client is already connected" line. npx
// godot-mcp surfaces this to the proxy as a tools/call error like
// "Not connected to Godot — Another client is already connected". Without
// wrapping the agent sees a bare failure indistinguishable from a dead editor.
// We attach a structured warmupDiagnostic {state:'editor_busy', retryable:true}
// so the agent retries shortly (the other session's proxy disconnect, or the
// editor's SEE-1070 lease self-exit, releases the slot) instead of giving up.
const EDITOR_BUSY_PATTERNS = [
    /another client is already connected/i,
    /already_?connected/i,
    /rejected new connection/i,
    /(?:websocket|ws[\s_-]?(?:close|code))[\s\S]{0,60}\b4001\b/i,
    /\b4001\b[\s\S]{0,60}(?:another client|already)/i,
];

function isEditorBusyError(error) {
    if (!error || typeof error !== 'object') return false;
    const m = typeof error.message === 'string' ? error.message : '';
    return m.length > 0 && EDITOR_BUSY_PATTERNS.some((re) => re.test(m));
}

function editorBusyDiagnostic() {
    const diag = {
        state: 'editor_busy',
        host: GODOT_HOST,
        port: GODOT_PORT,
        retryable: true,
        hint: `the godot_mcp addon accepts only one WebSocket client at a time; another session is holding port ${GODOT_PORT}. Retry after the other session releases the slot (its proxy disconnects, or the editor's SEE-1070 lease self-exits). If this persists, a concurrent same-agent run is likely holding the slot — only one proxy should connect per agent port.`,
    };
    // SEE-1110 §4.2: the occupying client is healthy and already past the WS
    // handshake, so stage reflects that (WS_HANDSHAKE or MCP_INITIALIZED) and the
    // substate is rejected_4001 (the addon rejects the newcomer with close 4001).
    if (KOL_PROGRESS_PROTOCOL !== 'off') {
        diag.stage = S.stage === 'WARM' ? 'MCP_INITIALIZED' : (stageOrdinal(S.stage) < 5 ? 'WS_HANDSHAKE' : S.stage);
        diag.handshakeSubstate = 'rejected_4001';
        diag.leaseExitDetected = S.leaseExitDetected;
    }
    return diag;
}

// Wrap a competition error with a retryable editor_busy diagnostic. The original
// message is preserved (a retryable suffix is appended so agents reading only
// the message — not data — still see it); warmupDiagnostic is attached to
// error.data alongside any existing data. Returns the SAME object reference when
// the error does not match, so the caller skips a needless re-serialize.
function augmentEditorBusyError(error) {
    if (!isEditorBusyError(error)) return error;
    const out = { ...error };
    const suffix = ` [editor_busy: retryable — another session holds the godot_mcp WebSocket slot on port ${GODOT_PORT}; retry shortly]`;
    out.message = typeof out.message === 'string' ? out.message + suffix : out.message;
    out.data = (out.data && typeof out.data === 'object')
        ? { ...out.data, warmupDiagnostic: editorBusyDiagnostic() }
        : { warmupDiagnostic: editorBusyDiagnostic() };
    return out;
}

// SEE-1085 usability: detect a tools/call error caused by the editor's WebSocket
// becoming unreachable AFTER warmup (the editor crashed, or its SEE-1070 lease
// self-exited without the lease monitor catching it — e.g. a hard crash with no
// exit line). npx surfaces this as a bare "Not connected to Godot" / "WebSocket
// closed" / connection-refused error the agent cannot distinguish from a config
// problem, so it gives up instead of retrying. We wrap it as a retryable
// editor_gone diagnostic. Patterns are disjoint from EDITOR_BUSY_PATTERNS (no
// "another client" / 4001), and the forwarder checks editor_busy first, so a
// competition error is never misclassified as editor_gone.
const EDITOR_GONE_PATTERNS = [
    /not connected to godot/i,
    /(?:websocket|ws[\s_-]?(?:close|closed|fail|failed|error))/i,
    /connection refused|econnrefused/i,
    /editor(?:[^.]{0,40})?(?:closed|exited|crashed|not responding|unreachable)/i,
];

function isEditorGoneError(error) {
    if (!error || typeof error !== 'object') return false;
    const m = typeof error.message === 'string' ? error.message : '';
    return m.length > 0 && EDITOR_GONE_PATTERNS.some((re) => re.test(m));
}

function editorGoneDiagnostic() {
    const diag = {
        state: 'editor_gone',
        host: GODOT_HOST,
        port: GODOT_PORT,
        retryable: true,
        hint: `the editor's WebSocket on port ${GODOT_PORT} became unreachable after warmup (it may have crashed, or its SEE-1070 lease self-exited). Retry shortly; if it persists, restart the MCP server so the proxy re-spawns the editor.`,
    };
    // SEE-1110 §4.3: editor_gone appends the stage dimension too.
    if (KOL_PROGRESS_PROTOCOL !== 'off') {
        diag.stage = S.stage;
        diag.leaseExitDetected = S.leaseExitDetected;
    }
    return diag;
}

// Wrap a post-warm unreachable-editor error with a retryable editor_gone
// diagnostic. Same preserve-the-original contract as augmentEditorBusyError;
// returns the SAME reference when the error does not match.
function augmentEditorGoneError(error) {
    if (!isEditorGoneError(error)) return error;
    const out = { ...error };
    const suffix = ` [editor_gone: retryable — editor WebSocket on port ${GODOT_PORT} unreachable after warmup; retry shortly]`;
    out.message = typeof out.message === 'string' ? out.message + suffix : out.message;
    out.data = (out.data && typeof out.data === 'object')
        ? { ...out.data, warmupDiagnostic: editorGoneDiagnostic() }
        : { warmupDiagnostic: editorGoneDiagnostic() };
    return out;
}

// Combined tools/call error augmentation: editor_busy first (concurrent slot
// holder), then editor_gone (post-warm unreachable). Returns the SAME reference
// when neither matches. Order matters — a competition error contains "not
// connected" too, so editor_busy must take precedence.
function augmentToolsCallError(error) {
    const busy = augmentEditorBusyError(error);
    if (busy !== error) return busy;
    return augmentEditorGoneError(error);
}

export {
    isEditorBusyError,
    editorBusyDiagnostic,
    augmentEditorBusyError,
    isEditorGoneError,
    editorGoneDiagnostic,
    augmentEditorGoneError,
    augmentToolsCallError,
};
