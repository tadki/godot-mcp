// warmup-stage-parser.mjs
//
// SEE-1110 B1 (§2.2/§2.3) stage-milestone parser, extracted from the proxy into
// a pure module so it can be unit-tested in isolation (no proxy boot / live
// editor). The proxy calls scanStageLines() with each post-spawn slice of the
// editor log tail and receives a FRESH state snapshot back — the parser never
// mutates shared state, so callers stay immutable (common/coding-style.md).
//
// StageEnum: 8 ordinals, monotonic, never regresses. WARM(7) is set by the
// proxy's warm flag (not from the log); the parser only ever observes ordinal
// 2..6 plus counts TCP_RECEIVED occurrences.
//
// Pattern semantics (SSOT §2.3): the editor log is scanned in multi-line
// slices, so every `^...` / `$...` anchor MUST use the `m` (multiline) flag —
// without it `^` only matches the slice's absolute start and `$` its absolute
// end, and a trailing newline makes an anchored `$` never match a mid-slice
// line. TCP_RECEIVED is deliberately NOT fire-once: its SECOND occurrence is
// the slot-competition fingerprint that drives the §3.3 `stalled` substate.

export const STAGE_ENUM = [
    'LAUNCHER_EXEC',   // 0: proxy process started (launcher exec complete)
    'EDITOR_SPAWNED',  // 1: spawn helper returned (spawnStartedAt set)
    'PLUGIN_INIT',     // 2: addon _enter_tree done (addon plugin.gd:64)
    'SERVER_LISTENING',// 3: addon WS server bound (addon plugin.gd:293)
    'TCP_CONNECTED',   // 4: addon received proxy TCP (websocket_server.gd:140)
    'WS_HANDSHAKE',    // 5: WS handshake complete (websocket_server.gd:216 / Client connected from)
    'MCP_INITIALIZED', // 6: initialize JSON-RPC success after WS established
    'WARM',            // 7: proxy warm flag set (tcpProbe && renderStable)
];
export const STAGE_TOTAL = STAGE_ENUM.length; // 8

// §2.2 milestone patterns. The `m` flag is REQUIRED: slices are multi-line.
export const STAGE_PATTERNS = [
    null, // LAUNCHER_EXEC: proxy itself (t0), never a log line
    null, // EDITOR_SPAWNED: proxy spawn helper return, never a log line
    { stage: 'PLUGIN_INIT', re: /^\[godot-mcp\] Plugin initialized$/m },
    { stage: 'SERVER_LISTENING', re: /^\[godot-mcp\] Server listening on /m },
    null, // TCP_CONNECTED — handled via TCP_RECEIVED_RE (counted, not fire-once)
    { stage: 'WS_HANDSHAKE', re: /^\[godot-mcp\] (?:WebSocket handshake complete|Client connected from)/m },
];
// Tracked separately (not fire-once) so the SECOND occurrence — a previous
// client's swallowed handshake competing for the single slot — is counted even
// after the milestone timestamp is set.
export const TCP_RECEIVED_RE = /^\[godot-mcp\] TCP connection received from .* awaiting WebSocket handshake/mg;

export function stageOrdinal(stageName) {
    return STAGE_ENUM.indexOf(stageName);
}

// Create a fresh parser state. `startedAt` seeds LAUNCHER_EXEC's timestamp
// (t0 = proxy start, §2.1); every other milestone starts null (= unreached).
export function createStageState(startedAt) {
    const timestamps = {};
    for (const s of STAGE_ENUM) timestamps[s] = null;
    timestamps.LAUNCHER_EXEC = startedAt;
    return { stage: 'LAUNCHER_EXEC', timestamps, tcpReceivedCount: 0 };
}

// Scan a post-spawn log slice against the milestone patterns. `now` is injected
// so the parser stays deterministic under test; each matched milestone records
// its first-seen timestamp and `stage` advances monotonically. Returns a fresh
// state object (the previous state is never mutated).
// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
export function scanStageLines(state, slice, now) {
    const next = {
        stage: state.stage,
        timestamps: { ...state.timestamps },
        tcpReceivedCount: state.tcpReceivedCount,
    };
    if (!slice || typeof slice !== 'string' || slice.length === 0) return next;

    for (const entry of STAGE_PATTERNS) {
        if (!entry) continue;
        if (next.timestamps[entry.stage] !== null) continue;
        if (entry.re.test(slice)) {
            next.timestamps[entry.stage] = now;
            if (stageOrdinal(entry.stage) > stageOrdinal(next.stage)) next.stage = entry.stage;
        }
    }

    const tcpMatches = slice.match(TCP_RECEIVED_RE) || [];
    if (tcpMatches.length > 0) {
        if (next.timestamps.TCP_CONNECTED === null) {
            next.timestamps.TCP_CONNECTED = now;
            if (stageOrdinal('TCP_CONNECTED') > stageOrdinal(next.stage)) next.stage = 'TCP_CONNECTED';
        }
        next.tcpReceivedCount += tcpMatches.length;
    }
    return next;
}

export const HANDSHAKE_STALL_THRESHOLD_MS = 15000;

// §3.3 handshake classification, derived purely from the parser state. Returns
// 'n/a' before TCP is observed, 'pending' after TCP, 'complete' once the WS
// handshake milestone fired, and 'stalled' on the two fingerprint signals:
// a second TCP_RECEIVED (slot competition) or the pending window exceeding
// HANDSHAKE_STALL_THRESHOLD_MS. Classification only — never changes timeouts.
export function handshakeSubstate(state, now) {
    const ord = stageOrdinal(state.stage);
    if (ord < stageOrdinal('TCP_CONNECTED')) return 'n/a';
    if (state.timestamps.WS_HANDSHAKE !== null) return 'complete';
    if (state.tcpReceivedCount > 1) return 'stalled';
    if (now - state.timestamps.TCP_CONNECTED > HANDSHAKE_STALL_THRESHOLD_MS) return 'stalled';
    return 'pending';
}

// Milliseconds the WS handshake has been pending, 0 unless we're between TCP
// and WS with a known TCP timestamp.
export function handshakePendingMs(state, now) {
    if (stageOrdinal(state.stage) < stageOrdinal('TCP_CONNECTED')) return 0;
    if (state.timestamps.WS_HANDSHAKE !== null) return 0;
    return now - state.timestamps.TCP_CONNECTED;
}

