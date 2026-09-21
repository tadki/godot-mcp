// proxy/lease.mjs — independent editor-log lease monitor + stage-milestone
// tail scanner (extracted from godot-mcp-proxy.mjs, SEE-1334 Phase 0a):
// offset-tracked tail, exact lease-death line fast-fail, SEE-1110 milestones.
import { readFile, stat } from 'node:fs/promises';
import { S } from './state.mjs';
import {
    EDITOR_LOG_FILE, GIVEUP_REARM_ENABLED, KOL_PROGRESS_PROTOCOL,
    LEASE_EXITING_LINE, LEASE_POLL_INTERVAL_MS,
} from './config.mjs';
import { STAGE_ENUM, scanStageLines } from '../warmup-stage-parser.mjs';
import { log, stageLog } from './log.mjs';
import { maybeNotifyStageChange, warmupDiagnostic } from './diagnostics.mjs';
import { rejectQueue } from './router.mjs';
import { beginWarmEditorRespawn, giveUpAndRearm } from './spawn.mjs';

// SEE-1077: independent lease monitor. Watches EDITOR_LOG_FILE for the exact
// "exiting editor to release the port" line; on match, takes the existing T4
// path (rejectQueue + warmupDiagnostic('failed_exit') + process.exit(1)) to
// bypass the 360s RECOVERING window.
//
// Decoupled from startRenderStableMonitor (which clearInterval's at WARM): a
// lease self-exit can fire AFTER the editor went warm. Tracks a file offset so
// stale lines from a previous editor run cannot false-positive a fresh proxy.
// No-op when EDITOR_LOG_FILE is empty — keeps existing SEE-1070 tests (which
// never pass this env) GREEN without modification.

function startLeaseMonitor() {
    if (S.leaseTimer) { clearInterval(S.leaseTimer); S.leaseTimer = null; }
    if (!EDITOR_LOG_FILE) return;
    // Seed offset to the current file size on start. Lines that pre-date this
    // proxy run (a prior editor's death, e.g. a crashed previous session)
    // must NOT fast-fail us — that's the whole point of offset tracking.
    S.leaseOffset = 0;
    stat(EDITOR_LOG_FILE)
        .then((st) => { S.leaseOffset = st.size; })
        .catch(() => { S.leaseOffset = 0; })
        .finally(() => {
            S.leaseTimer = setInterval(() => {
                if (S.shutdownRequested || S.warmupTimedOut) {
                    clearInterval(S.leaseTimer);
                    S.leaseTimer = null;
                    return;
                }
                checkLeaseTail();
            }, LEASE_POLL_INTERVAL_MS);
        });
}

// eslint-disable-next-line sonarjs/cognitive-complexity -- SEE-1334 baseline: legacy function, complexity gate applies to new code only (plan §5)
async function checkLeaseTail() {
    if (!EDITOR_LOG_FILE || S.shutdownRequested || S.warmupTimedOut) return;
    let st;
    try {
        st = await stat(EDITOR_LOG_FILE);
    } catch {
        // File missing or unreadable — log not yet created by the launcher.
        // Stay quiet; the warmup timeout / TCP probe will catch a truly dead
        // editor on its own. Reset offset so a fresh file (size shrinks, e.g.
        // rotation) doesn't make us scan from byte 0 in the middle of old data.
        S.leaseOffset = 0;
        // SEE-1110 §6: sticky degradation signal. The log is unreadable for the
        // whole run (never became available), so hint text explains the stage
        // track is incomplete and other hints don't overstate log-based facts.
        if (KOL_PROGRESS_PROTOCOL !== 'off' && !S.logTailUnavailableSince) {
            S.logTailUnavailableSince = Date.now();
        }
        return;
    }
    if (KOL_PROGRESS_PROTOCOL !== 'off') S.logTailAvailable = true;
    if (st.size < S.leaseOffset) {
        // File was truncated/rotated; reset and scan only the new content.
        S.leaseOffset = 0;
    }
    if (st.size === S.leaseOffset) return;
    let fd;
    try {
        fd = await readFile(EDITOR_LOG_FILE, 'utf-8');
    } catch {
        return;
    }
    const slice = fd.slice(S.leaseOffset);
    S.leaseOffset = st.size;
    if (KOL_PROGRESS_PROTOCOL !== 'off') scanTailStages(slice);
    if (slice.indexOf(LEASE_EXITING_LINE) !== -1) {
        // Editor lease self-exit detected. Take the T4 FAILED_EXIT path so the
        // buffered calls get a structured retry error. SEE-1240 WS-5: under the
        // default rearm policy the proxy survives and re-arms in-band (legacy
        // process.exit(1) under KOL_GIVEUP_REARM=0). Same T3 drop-no-replay
        // semantics as a sustained-probe FAILED_EXIT: drop buffered w/ retry.
        clearInterval(S.leaseTimer);
        S.leaseTimer = null;
        if (KOL_PROGRESS_PROTOCOL !== 'off') S.leaseExitDetected = true;
        log(`ERROR: lease death detected in editor log ('${LEASE_EXITING_LINE}'); rejecting ${S.pendingCalls.length} buffered call(s) and ${GIVEUP_REARM_ENABLED ? 're-arming in-band (WS-5)' : 'exiting'}.`);
        rejectQueue(`editor lease expired; exiting to release port`, warmupDiagnostic('failed_exit'));
        if (GIVEUP_REARM_ENABLED) {
            S.warmupTimedOut = false;
            beginWarmEditorRespawn();
            giveUpAndRearm('lease_exit', LEASE_EXITING_LINE);
        } else {
            S.warmupTimedOut = true;
            process.exit(1);
        }
    }
}

// SEE-1110 B1 (§2.2/§2.3): stage-milestone parser mounted on the SAME
// lease/render-stable tail (stat + offset, no new polling). Scans only the new
// lines since the last read — strictly post-spawn content, so stale lines from a
// previous editor run can never advance the stage. Patterns are anchored at line
// start `^\[godot-mcp\] ` (with `m` flag — slices are multi-line, §2.3); each
// stage fires once and records its first-seen timestamp. A second TCP_RECEIVED
// is the slot-competition fingerprint (§3.3) — it indicates the first handshake
// was swallowed by the incumbent client.
// The scan itself is delegated to the pure module (warmup-stage-parser.mjs,
// unit-tested in isolation); the proxy just diffs the returned snapshot against
// its mutable state and fires notifications on stage advance.
function scanTailStages(slice) {
    const next = scanStageLines(
        { stage: S.stage, timestamps: S.stageTimestamps, tcpReceivedCount: S.tcpReceivedCount },
        slice,
        Date.now()
    );
    const stageAdvanced = next.stage !== S.stage;
    // Copy any newly-observed milestone timestamps (fire-once: only fill nulls).
    for (const s of STAGE_ENUM) {
        if (next.timestamps[s] !== null && S.stageTimestamps[s] === null) {
            S.stageTimestamps[s] = next.timestamps[s];
            // SEE-1152: machine-greppable first-observation log per milestone.
            // PLUGIN_INIT/SERVER_LISTENING/TCP_CONNECTED/WS_HANDSHAKE all land here.
            if (s !== 'WARM' && s !== 'LAUNCHER_EXEC' && s !== 'EDITOR_SPAWNED') {
                stageLog(`MILESTONE_${s}`, `elapsed_ms=${S.stageTimestamps[s] - (S.spawnStartedAt || S.startedAt)}`);
            }
        }
    }
    if (stageAdvanced) {
        S.stage = next.stage;
        maybeNotifyStageChange();
    }
    S.tcpReceivedCount = next.tcpReceivedCount;
}

export {
    startLeaseMonitor,
    checkLeaseTail,
    scanTailStages,
};
