// test_see1110_stage_parser.mjs
//
// SEE-1110 B1/B2 — warmup stage-milestone parser unit test.
//
// Exercises warmup-stage-parser.mjs in isolation (no proxy boot, no live
// editor). Regression guard for the HIGH-severity §2.3 multiline bug: the
// editor log tail is scanned in multi-line slices, so every `^...`/`$...`
// anchor MUST carry the `m` flag — without it PLUGIN_INIT/SERVER_LISTENING/
// WS_HANDSHAKE never match a real slice and the whole progress protocol
// silently degrades (stages stay null, handshakeSubstate never reaches
// `complete`, the §7 timeline shows `plugin→?`/`ws→?`).
//
// Run: node .dev/godot-mcp/tests/scripts/test_see1110_stage_parser.mjs

import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';

const PARSER_PATH = join(
    dirname(new URL(import.meta.url).pathname),
    '..', '..', 'warmup-stage-parser.mjs'
);
const {
    STAGE_ENUM,
    STAGE_TOTAL,
    createStageState,
    scanStageLines,
    stageOrdinal,
    handshakeSubstate,
    handshakePendingMs,
} = await import(PARSER_PATH);

const RESULTS = [];
function record(name, fn) {
    try {
        fn();
        RESULTS.push({ name, ok: true });
        console.log(`  [PASS] ${name}`);
    } catch (err) {
        RESULTS.push({ name, ok: false, err });
        console.error(`  [FAIL] ${name}: ${err.message}`);
    }
}

// A realistic cold-start slice: one multi-line blob, exactly what
// checkLeaseTail passes to scanStageLines (§6 primary channel).
const T0 = 1_700_000_000_000;
const COLD_SLICE = [
    '[godot-mcp] Plugin initialized',
    '[godot-mcp] Server listening on 127.0.0.1:6551 [localhost]',
    '[godot-mcp] TCP connection received from 127.0.0.1:50123, awaiting WebSocket handshake...',
    '[godot-mcp] WebSocket handshake complete',
].join('\n') + '\n';

console.log(`\n--- SEE-1110 stage parser unit (${PARSER_PATH}) ---\n`);

// 1. Enum invariants: 8 ordinals, monotonic, WARM last.
record('enum: 8 stages, WARM(7) last, monotonic ordinals', () => {
    assert.equal(STAGE_TOTAL, 8);
    assert.equal(STAGE_ENUM[7], 'WARM');
    for (let i = 0; i < STAGE_ENUM.length; i++) assert.equal(stageOrdinal(STAGE_ENUM[i]), i);
});

// 2. HIGH #1 regression: a multi-line slice must fire every milestone.
record('multiline slice fires PLUGIN_INIT/SERVER_LISTENING/TCP_CONNECTED/WS_HANDSHAKE', () => {
    const st = scanStageLines(createStageState(T0), COLD_SLICE, T0 + 1000);
    assert.equal(st.timestamps.PLUGIN_INIT, T0 + 1000);
    assert.equal(st.timestamps.SERVER_LISTENING, T0 + 1000);
    assert.equal(st.timestamps.TCP_CONNECTED, T0 + 1000);
    assert.equal(st.timestamps.WS_HANDSHAKE, T0 + 1000);
});

// 3. Stage advances monotonically to WS_HANDSHAKE(5) on that slice.
record('stage advances monotonically to WS_HANDSHAKE', () => {
    const st = scanStageLines(createStageState(T0), COLD_SLICE, T0 + 1000);
    assert.equal(st.stage, 'WS_HANDSHAKE');
});

// 4. Fire-once: a second identical slice must NOT move timestamps.
record('milestones fire once (second scan is a no-op)', () => {
    let st = createStageState(T0);
    st = scanStageLines(st, COLD_SLICE, T0 + 1000);
    st = scanStageLines(st, COLD_SLICE, T0 + 9999);
    assert.equal(st.timestamps.PLUGIN_INIT, T0 + 1000);
    assert.equal(st.timestamps.WS_HANDSHAKE, T0 + 1000);
    assert.equal(st.stage, 'WS_HANDSHAKE');
});

// 5. TCP_CONNECTED is counted, not fire-once: a second TCP line (the slot-
// competition fingerprint) increments the counter even after the milestone set.
record('second TCP_RECEIVED increments count (stall fingerprint preserved)', () => {
    let st = createStageState(T0);
    st = scanStageLines(st, COLD_SLICE, T0 + 1000);
    const second = '[godot-mcp] TCP connection received from 127.0.0.1:51234, awaiting WebSocket handshake...\n';
    st = scanStageLines(st, second, T0 + 2000);
    assert.equal(st.tcpReceivedCount, 2);
    assert.equal(st.timestamps.TCP_CONNECTED, T0 + 1000); // first-seen unchanged
});

// 6. handshakeSubstate: complete once WS_HANDSHAKE fired.
record('handshakeSubstate complete after WS_HANDSHAKE', () => {
    const st = scanStageLines(createStageState(T0), COLD_SLICE, T0 + 1000);
    assert.equal(handshakeSubstate(st, T0 + 2000), 'complete');
});

// 7. handshakeSubstate: pending between TCP and WS (within stall threshold).
record('handshakeSubstate pending between TCP and WS', () => {
    let st = createStageState(T0);
    const tcpOnly = '[godot-mcp] TCP connection received from 127.0.0.1:50123, awaiting WebSocket handshake...\n';
    st = scanStageLines(st, tcpOnly, T0 + 1000);
    assert.equal(st.stage, 'TCP_CONNECTED');
    assert.equal(handshakeSubstate(st, T0 + 2000), 'pending');
    assert.equal(handshakePendingMs(st, T0 + 2000), 1000);
});

// 8. handshakeSubstate: stalled when a second TCP competes for the slot.
record('handshakeSubstate stalled on second TCP (slot competition)', () => {
    let st = createStageState(T0);
    const tcpOnly = '[godot-mcp] TCP connection received from 127.0.0.1:50123, awaiting WebSocket handshake...\n';
    st = scanStageLines(st, tcpOnly, T0 + 1000);
    st = scanStageLines(st, tcpOnly, T0 + 1500);
    assert.equal(handshakeSubstate(st, T0 + 2000), 'stalled');
});

// 9. handshakeSubstate: stalled when the pending window exceeds 15s.
record('handshakeSubstate stalled past 15s pending window', () => {
    let st = createStageState(T0);
    const tcpOnly = '[godot-mcp] TCP connection received from 127.0.0.1:50123, awaiting WebSocket handshake...\n';
    st = scanStageLines(st, tcpOnly, T0 + 1000);
    assert.equal(handshakeSubstate(st, T0 + 16_500), 'stalled');
});

// 10. handshakeSubstate: n/a before TCP is ever observed.
record('handshakeSubstate n/a before TCP observed', () => {
    const st = createStageState(T0);
    assert.equal(handshakeSubstate(st, T0 + 500), 'n/a');
});

// 11. The scan is pure: it never mutates the input state.
record('scanStageLines returns a fresh state (immutability)', () => {
    const before = createStageState(T0);
    const frozen = JSON.parse(JSON.stringify(before));
    const st = scanStageLines(before, COLD_SLICE, T0 + 1000);
    assert.deepEqual(before, frozen);
    assert.notEqual(before, st);
});

console.log(`\n--- Summary ---`);
const ok = RESULTS.filter((r) => r.ok).length;
const fail = RESULTS.length - ok;
console.log(`PASS=${ok} FAIL=${fail}`);
if (fail > 0) {
    for (const r of RESULTS.filter((r) => !r.ok)) console.error(`  - ${r.name}: ${r.err.message}`);
    process.exit(1);
}
process.exit(0);
