// proxy/stale-proxy.mjs — SEE-1338 §SPEC-GM1b stale-proxy takeover IO.
// Detects a leftover godot-mcp proxy from a previous session holding our
// port's arbitration slot (the held dir ~/.multica/godot-mcp-held/<port>/),
// verifies its identity via /proc (cmdline = the proxy script, environ port
// = our port), and kills its process tree so the editor's single WS slot
// frees WITHOUT touching the editor or any unverified process.
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { S } from './state.mjs';
import { GODOT_MCP_HOME, GODOT_PORT, RUNTIME_ID } from './config.mjs';
import { log } from './log.mjs';
import { pidAlive } from './worktree.mjs';
import { decideStaleProxyTakeover } from '../see1338-stale-takeover.mjs';

const STALE_KILL_GRACE_MS = 5000;

function heldDirFor(port) {
    const base = process.env.KOL_PORT_HELD_DIR || path.join(GODOT_MCP_HOME, 'godot-mcp-held');
    return path.join(base, String(port));
}

async function readHeldProxy(port) {
    const held = heldDirFor(port);
    let pid = null;
    let rid = '';
    try {
        const pidRaw = await readFile(path.join(held, 'pid'), 'utf-8');
        pid = Number(pidRaw.trim());
    } catch { /* no held dir / no pid — nothing held by the arbiter */ }
    try {
        const meta = await readFile(path.join(held, 'meta'), 'utf-8');
        rid = (meta.match(/^runtime_id=(.*)$/m) || ['', ''])[1].trim();
    } catch { /* meta absent — legacy holder */ }
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, runtimeId: rid };
}

async function readProcCmdline(pid) {
    try {
        const raw = await readFile(`/proc/${pid}/cmdline`, 'utf-8');
        return raw.replace(/\0/g, ' ');
    } catch {
        return '';
    }
}

async function readProcPort(pid) {
    try {
        const raw = await readFile(`/proc/${pid}/environ`, 'utf-8');
        for (const kv of raw.split('\0')) {
            const m = kv.match(/^(?:GODOT_MCP_PORT|GODOT_PORT|KOL_MCP_PORT)=(\d+)$/);
            if (m) return Number(m[1]);
        }
    } catch { /* environ unreadable */ }
    return null;
}

function scanProcParents() {
    const parentOf = new Map();
    let entries = [];
    try { entries = readdirSync('/proc'); } catch { return parentOf; }
    for (const e of entries) {
        if (!/^\d+$/.test(e)) continue;
        try {
            const statRaw = readStatSync(Number(e));
            const m = statRaw.match(/\) \w+ (\d+) /);
            if (m) parentOf.set(Number(e), Number(m[1]));
        } catch { /* process vanished mid-sweep */ }
    }
    return parentOf;
}

function readStatSync(pid) {
    return readFileSync(`/proc/${pid}/stat`, 'utf-8');
}

function descendantsOf(parentOf, pid) {
    const out = [];
    for (const [child, parent] of parentOf) {
        if (parent === pid) {
            out.push(child, ...descendantsOf(parentOf, child));
        }
    }
    return out;
}

async function killProxyTree(pid) {
    const parentOf = scanProcParents();
    const targets = [pid, ...collectDescendants(parentOf, pid)];
    for (const t of targets) {
        try { process.kill(t, 'SIGTERM'); } catch { /* already gone */ }
    }
    const deadline = Date.now() + STALE_KILL_GRACE_MS;
    while (Date.now() < deadline && targets.some((t) => pidAlive(t))) {
        await new Promise((r) => setTimeout(r, 200));
    }
    for (const t of targets) {
        if (pidAlive(t)) {
            try { process.kill(t, 'SIGKILL'); } catch { /* already gone */ }
        }
    }
    return true;
}

// Take over the stale proxy holding our port's held dir, if and only if it
// is verifiably a leftover godot-mcp proxy for OUR port (see
// see1338-stale-takeover.mjs). allowSameRuntime may be passed ONLY after a
// proven non-release (e.g. the takeover wait expired with the slot held).
async function attemptStaleProxyTakeover({ allowSameRuntime = false } = {}) {
    const held = await readHeldProxy(GODOT_PORT);
    if (!held) return { tookOver: false, reason: 'NO_HELD_PROXY' };
    if (!pidAlive(held.pid)) return { tookOver: false, reason: 'HOLDER_PID_DEAD' };
    const holderCmdline = await readProcCmdline(held.pid);
    const holderPort = await readProcPort(held.pid);
    const decision = decideStaleProxyTakeover({
        holderPid: held.pid,
        holderRuntimeId: held.runtimeId,
        ourRuntimeId: RUNTIME_ID,
        holderCmdline,
        holderPort,
        ourPort: GODOT_PORT,
        allowSameRuntime,
    });
    if (!decision.takeover) {
        log(`stale-proxy takeover declined (${decision.reason}) for held pid=${held.pid} on port ${GODOT_PORT}.`);
        return { tookOver: false, reason: decision.reason, pid: held.pid };
    }
    log(`WARNING: stale proxy takeover (SEE-1338 §GM1b): held pid=${held.pid} (runtime '${held.runtimeId || '?'}') verified as a godot-mcp proxy for port ${GODOT_PORT} (${decision.reason}); killing its tree to free the editor's WS slot.`);
    await killProxyTree(held.pid);
    S.staleProxyTakeovers += 1;
    log(`stale proxy tree killed (pid=${held.pid}); its shutdown path releases the held dir and its CLI's WS slot.`);
    return { tookOver: true, reason: decision.reason, pid: held.pid };
}

function collectDescendants(parentOf, pid) {
    return descendantsOf(parentOf, pid);
}

export {
    readHeldProxy,
    readProcCmdline,
    readProcPort,
    collectDescendants,
    scanProcParents,
    descendantsOf,
    killProxyTree,
    attemptStaleProxyTakeover,
};
