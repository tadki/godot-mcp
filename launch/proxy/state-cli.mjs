// proxy/state-cli.mjs — SEE-1348 WP4 (§SPEC-008): bash→.state bridge.
// start-godot-editor.sh resolves the editor PID asynchronously (CIM probe on
// Windows) and must land it on the .state editor_pid slots with an explicit
// source. The .state module is ESM; bash callers invoke this entry point
// instead of re-implementing the merge/rename protocol.
//
// Usage:
//   node launch/proxy/state-cli.mjs --runtime-id <rid> --editor-pid <n>
//        --editor-pid-source <wsl|windows|pending> [--editor-pid-started-at <ms>]
//   node launch/proxy/state-cli.mjs --runtime-id <rid> --editor-pid pending
//        --editor-pid-source pending
// Exit 0 on success (or no-op), 2 on usage error. A write failure is printed
// on stderr and exits 1 so the caller can log it — the .state write is
// observability, never worth failing the editor spawn over.
import { writeRuntimeState, statePathFor, editorPidAlive, EDITOR_PID_SOURCES } from './state-file.mjs';
import { readFileSync } from 'node:fs';

// Raw read (NOT readRuntimeState): this CLI runs before/after the proxy may
// have written a full doc, and a backfill-only doc carries no `state` field —
// validation would report "no state" and silently disable the clobber guard.
function readRawDoc(runtimeId) {
    try {
        return JSON.parse(readFileSync(statePathFor(runtimeId), 'utf8'));
    } catch {
        return {};
    }
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i];
        if (!key.startsWith('--')) return null;
        out[key.slice(2).replace(/-/g, '_')] = argv[i + 1];
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args || !args.runtime_id) {
    console.error('state-cli: --runtime-id required; accepted: --editor-pid --editor-pid-source --editor-pid-started-at');
    process.exit(2);
}

const patch = {};
if (args.editor_pid !== undefined) {
    if (args.editor_pid === 'pending') {
        patch.editor_pid = null;
        patch.editor_pid_started_at = null;
        patch.editor_pid_source = 'pending';
    } else {
        const pid = Number(args.editor_pid);
        if (!Number.isInteger(pid) || pid <= 0) {
            console.error(`state-cli: --editor-pid must be a positive integer or 'pending', got '${args.editor_pid}'`);
            process.exit(2);
        }
        patch.editor_pid = pid;
        patch.editor_pid_started_at = args.editor_pid_started_at
            ? Number(args.editor_pid_started_at) : Date.now();
    }
}
if (args.editor_pid_source !== undefined) {
    if (!EDITOR_PID_SOURCES.has(String(args.editor_pid_source))) {
        console.error(`state-cli: unknown --editor-pid-source '${args.editor_pid_source}' (expected: wsl|windows|pending)`);
        process.exit(2);
    }
    patch.editor_pid_source = String(args.editor_pid_source);
}

// No clobber rule (SEE-1348 §SPEC-008 "异值不覆盖"): once a real editor_pid
// is on disk for this runtime, a later writer only replaces it when it passes
// the same liveness shape the reaper uses — a DEAD recorded pid is fair game,
// a LIVE one means a concurrent editor actually holds the bridge.
const existing = readRawDoc(args.runtime_id);
if (patch.editor_pid && existing.editor_pid
    && Number(existing.editor_pid) !== patch.editor_pid
    && existing.editor_pid_source) {
    // F-QA-3 alignment: overwrite requires a POSITIVELY dead predecessor.
    // true = live → refuse; null = probe unavailable → refuse (unknown is
    // not dead — a live editor on a PATH-less host must not be clobbered).
    const alive = editorPidAlive(existing.editor_pid, existing.editor_pid_source);
    if (alive === true) {
        console.error(`state-cli: refusing to overwrite live editor_pid ${existing.editor_pid} (source ${existing.editor_pid_source}) with ${patch.editor_pid}`);
        process.exit(1);
    }
    if (alive === null) {
        console.error(`state-cli: refusing to overwrite editor_pid ${existing.editor_pid} — probe unavailable (unknown, not dead); re-run on a host where the probe resolves`);
        process.exit(1);
    }
}

if (Object.keys(patch).length === 0) {
    console.error('state-cli: nothing to write; pass --editor-pid (and optionally --editor-pid-source/--editor-pid-started-at)');
    process.exit(2);
}

try {
    writeRuntimeState(args.runtime_id, patch, {
        event: 'EDITOR_PID_BACKFILL',
        detail: `editor_pid=${patch.editor_pid ?? 'pending'} source=${patch.editor_pid_source ?? '-'}`,
    });
} catch (e) {
    console.error(`state-cli: write failed: ${e && e.message ? e.message : e}`);
    process.exit(1);
}
