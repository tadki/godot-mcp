// proxy/takeover.mjs — editor_busy wait/retry takeover coordinator
// (extracted from godot-mcp-proxy.mjs, SEE-1334 Phase 0a): single-probe slot
// race, waiter set, bounded self-heal eviction after repeated timeouts.
import { S } from './state.mjs';
import {
    GODOT_HOST, GODOT_PORT, KOL_PROGRESS_PROTOCOL, TAKEOVER_TIMEOUT_MS,
    TAKEOVER_RETRY_MS, TAKEOVER_SELF_HEAL_THRESHOLD, TAKEOVER_SELF_HEAL_ENABLED,
} from './config.mjs';
import { stageOrdinal } from '../warmup-stage-parser.mjs';
import { log } from './log.mjs';
import { forwardToNpx, makeErrorResponse, sendToClaude } from './protocol.mjs';
import { readHolderWorktree } from './worktree.mjs';
import { evictStaleHolder } from './spawn.mjs';
import { maybeEvictStaleHeld } from './stale-proxy.mjs';

// ---- SEE-1085 §1 (Revy §4.3): editor_busy wait/retry takeover ----------------
// When a tools/call comes back as editor_busy (a concurrent same-agent session
// holds the addon's single WS slot), do NOT fail the call immediately. Instead
// re-dispatch it on a short backoff, racing to take the slot when the holder
// releases it (its proxy disconnects, or the editor's SEE-1070 lease self-exits).
// npx holds a persistent WS once it connects, so a single winning probe lets
// normal flow resume. Bounded by KOL_TAKEOVER_TIMEOUT_MS; on expiry the call
// returns a retryable editor_busy diagnostic so the agent can retry the whole
// turn instead of giving up on what it thinks is a dead editor.
//
// One probe at a time: the addon is single-client, so concurrent probes would
// all be rejected together and waste npx round-trips. A waiter set + single
// probeId deduplicates concurrent busy calls.
//
// Set KOL_TAKEOVER_TIMEOUT_MS=0 to disable takeover entirely (fall back to the
// immediate editor_busy diagnostic — the §2-only behavior, used by test seams
// that want the diagnostic without the wait).

// Active takeover coordinator, or null when idle. Shape:
//   { deadline, waiters: Set<id>, probeId: id|null, timer: NodeJS.Timeout|null }

function editorBusyTakeoverDiagnostic() {
    const diag = {
        state: 'editor_busy',
        host: GODOT_HOST,
        port: GODOT_PORT,
        retryable: true,
        hint: `same-agent concurrent session holding port ${GODOT_PORT}, waiting for takeover — timed out after ${TAKEOVER_TIMEOUT_MS}ms; retry the turn. If it persists, ensure only one proxy runs per agent port.`,
    };
    // SEE-1110 §4.2: same rejected-4001 view as editorBusyDiagnostic.
    if (KOL_PROGRESS_PROTOCOL !== 'off') {
        diag.stage = S.stage === 'WARM' ? 'MCP_INITIALIZED' : (stageOrdinal(S.stage) < 5 ? 'WS_HANDSHAKE' : S.stage);
        diag.handshakeSubstate = 'rejected_4001';
        diag.leaseExitDetected = S.leaseExitDetected;
    }
    return diag;
}

// Add a tools/call id to the waiter set and arm the coordinator if it is the
// first waiter. Idempotent: re-adding an existing waiter is a no-op.
function enterTakeoverWaiter(id) {
    if (!S.takeover) {
        S.takeover = {
            deadline: Date.now() + TAKEOVER_TIMEOUT_MS,
            waiters: new Set(),
            probeId: null,
            probeAt: 0,
            timer: null,
        };
        log(`editor_busy takeover armed (timeout ${TAKEOVER_TIMEOUT_MS}ms, retry every ${TAKEOVER_RETRY_MS}ms) — waiting for the holder to release port ${GODOT_PORT}`);
        S.takeover.timer = setTimeout(attemptTakeoverProbe, TAKEOVER_RETRY_MS);
    } else if (S.takeover.probeId === null && S.takeover.timer === null) {
        // Defensive: a new waiter arrived while the coordinator is idle (no probe
        // in flight, no timer pending). Re-arm so the waiter is not stranded.
        S.takeover.timer = setTimeout(attemptTakeoverProbe, TAKEOVER_RETRY_MS);
    }
    S.takeover.waiters.add(id);
}

// Pick the oldest waiter and re-dispatch its original line to npx as the slot
// probe. Only one probe at a time (single-client addon → concurrent probes all
// lose together). If a probe is in flight, re-arm and wait — unless it has hung
// past 2x the retry interval (npx unresponsive without exiting), in which case
// reclaim the slot probe so the coordinator is not stranded.
function attemptTakeoverProbe() {
    if (!S.takeover) return;
    if (Date.now() >= S.takeover.deadline) {
        failTakeover();
        return;
    }
    if (S.takeover.probeId !== null) {
        const stuckMs = Date.now() - (S.takeover.probeAt || 0);
        if (stuckMs < TAKEOVER_RETRY_MS * 2) {
            S.takeover.timer = setTimeout(attemptTakeoverProbe, TAKEOVER_RETRY_MS);
            return;
        }
        log(`takeover: probe id=${S.takeover.probeId} appears lost (no response in ${stuckMs}ms); reclaiming slot probe`);
        S.takeover.probeId = null;
        S.takeover.probeAt = 0;
    }
    const id = S.takeover.waiters.values().next().value;
    if (id === undefined) {
        endTakeover();
        return;
    }
    const line = S.toolsCallLines.get(id);
    if (!line) {
        // Line vanished (shouldn't happen) — drop the waiter and keep probing.
        S.takeover.waiters.delete(id);
        S.takeover.timer = setTimeout(attemptTakeoverProbe, TAKEOVER_RETRY_MS);
        return;
    }
    S.takeover.probeId = id;
    S.takeover.probeAt = Date.now();
    S.toolsCallIds.add(id); // re-track so the forwarder recognizes the probe response
    log(`takeover: probing WS slot by re-dispatching tools/call id=${id} (${S.takeover.waiters.size} waiter(s))`);
    forwardToNpx(line);
}

// Takeover timed out: deliver the retryable editor_busy diagnostic to every
// waiter and clear the coordinator. Respects the SEE-1070 lease by simply
// giving up at the deadline — the lease's own self-exit on the holder is one
// legitimate way the slot would have freed (we just did not win in time).
function failTakeover() {
    if (!S.takeover) return;
    const t = S.takeover;
    S.takeover = null;
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    log(`takeover: timed out after ${TAKEOVER_TIMEOUT_MS}ms — ${t.waiters.size} waiter(s) return editor_busy`);
    for (const id of t.waiters) {
        S.toolsCallIds.delete(id);
        S.toolsCallLines.delete(id);
        sendToClaude(makeErrorResponse(
            id,
            `editor busy: another session holds the godot_mcp WebSocket slot on port ${GODOT_PORT}; gave up waiting for takeover after ${TAKEOVER_TIMEOUT_MS}ms`,
            -32000,
            { warmupDiagnostic: editorBusyTakeoverDiagnostic() },
        ));
    }
    // SEE-1338 spec v2.1 §4.2 (AMEND-1): a timed-out takeover means the slot
    // holder is NOT releasing — classify the held record. A LIVE holder stays
    // untouchable (前任在管; clean editor_busy already went out above); ONLY a
    // DEAD holder's orphaned editor is evictable below.
    if (!S.staleTakeoverInFlight) {
        S.staleTakeoverInFlight = true;
        maybeEvictStaleHeld(() => evictStaleHolder(null))
            .then((r) => {
                if (r.evicted) log(`post-timeout stale holder evicted (pid=${r.pid}); next tools/call re-runs against the freed slot.`);
            })
            .catch((err) => log(`stale-holder classification after takeover timeout failed (non-fatal): ${err && err.message}`))
            .finally(() => { S.staleTakeoverInFlight = false; });
    }
    // SEE-1316 (hardener) — bounded self-heal for a stuck-holder 4001 loop:
    // TAKEOVER_TIMEOUT_MS waits are designed for a HEALTHY holder that will
    // release shortly (its proxy disconnects / lease self-exits). When they
    // fail repeatedly, the likely holder is a dead session's orphaned editor
    // (the incumbent WS client is a ghost npx) — the addon's 45s
    // stale-connection replacement should free it, but a half-open TCP peer
    // can hold the slot past that window with no packets to age it out.
    // After N consecutive timed-out takeovers, run ONE eviction pass scoped
    // to THIS slot's recorded holder (stop-godot-editor + holder-scoped reap),
    // then re-arm the warmup state machine so the next tools/call re-spawns.
    // Bounded and conservative: a live foreign-runtime holder is untouched —
    // evictStaleHolder's stop helper pins to the holder's own worktree, and
    // the arbiter's busy_foreign verdict at spawn time remains the authority
    // for cross-runtime contention.
    S.takeoverFailStreak += 1;
    if (TAKEOVER_SELF_HEAL_ENABLED && S.takeoverFailStreak >= TAKEOVER_SELF_HEAL_THRESHOLD && !S.takeoverSelfHealInFlight) {
        S.takeoverFailStreak = 0;
        S.takeoverSelfHealInFlight = true;
        log(`WARNING: ${TAKEOVER_SELF_HEAL_THRESHOLD} consecutive takeover timeouts on port ${GODOT_PORT}; holder is likely an orphaned editor — evicting (bounded self-heal, SEE-1316) then re-arming warmup.`);
        (async () => {
            try {
                await evictStaleHolder(await readHolderWorktree());
            } catch (err) {
                log(`takeover self-heal: non-fatal eviction failure: ${err && err.message ? err.message : err}`);
            } finally {
                // Re-arm: next tools/call walks the spawn/arbiter path against
                // the (hopefully) freed port instead of hammering a stuck slot.
                // SEE-1338: this self-heal used to assign an UNDECLARED
                // `warmFlushed` (the monolith's closure `let` never made it
                // into this extracted module) — a strict-mode ReferenceError
                // that killed the finally block and stuck the in-flight flag.
                // The flag lives only inside warmupLoop's probe scope; there is
                // nothing to reset here.
                S.warm = false;
                S.warmEditorDead = false;
                S.spawnTriggered = false;
                S.takeoverSelfHealInFlight = false;
                log('takeover self-heal: warmup re-armed — next tools/call re-runs the spawn/arbiter path.');
            }
        })();
    }
}

// The probe won the slot (or hit a non-busy outcome). Forward this response to
// Claude normally and re-dispatch any remaining waiters — npx now holds the WS,
// so they will succeed without re-competition. Clears the coordinator.
function drainTakeoverWaiters(readyId) {
    if (!S.takeover) return;
    S.takeover.waiters.delete(readyId);
    if (S.takeover.probeId === readyId) S.takeover.probeId = null;
    if (S.takeover.waiters.size === 0) {
        endTakeover();
        return;
    }
    // npx connected on the winning probe — flush remaining waiters through normal
    // flow. They will be answered by the forwarder directly now that takeover is
    // ended and their ids are re-tracked.
    const rest = Array.from(S.takeover.waiters);
    endTakeover();
    for (const id of rest) {
        const line = S.toolsCallLines.get(id);
        if (!line) { S.toolsCallLines.delete(id); continue; }
        S.toolsCallIds.add(id);
        log(`takeover: slot acquired; re-dispatching queued tools/call id=${id}`);
        forwardToNpx(line);
    }
}

function endTakeover() {
    if (!S.takeover) return;
    if (S.takeover.timer) { clearTimeout(S.takeover.timer); S.takeover.timer = null; }
    S.takeover = null;
    // SEE-1316: a successful takeover proves the holder released the slot —
    // the self-heal streak measures STUCK holders only.
    S.takeoverFailStreak = 0;
    log('takeover: ended (slot acquired or no waiters)');
}

export {
    editorBusyTakeoverDiagnostic,
    enterTakeoverWaiter,
    attemptTakeoverProbe,
    failTakeover,
    drainTakeoverWaiters,
    endTakeover,
};
