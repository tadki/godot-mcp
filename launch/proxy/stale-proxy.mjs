// proxy/stale-proxy.mjs — SEE-1338 spec v2.1 §4.2 takeover prototype: read the
// port's held record and classify it via the pure decision fn
// (see1338-stale-takeover.mjs). AMEND-1: classification NEVER kills a live
// proxy or its editor — a live holder is always 'busy' (clean editor_busy);
// only a DEAD holder's orphaned editor is evictable.
import { readFile } from 'node:fs/promises';
import { readlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { GODOT_MCP_HOME, GODOT_PORT } from './config.mjs';
import { log } from './log.mjs';
import { pidAlive } from './worktree.mjs';
import { decideStaleProxyAction } from '../see1338-stale-takeover.mjs';

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

// AMEND-1 三重校验（P0 雏形）: kill -0 + /proc/<pid>/exe node（仲裁器既有的
// anti-PID-reuse 标准，port-arbiter.lib.sh 同源）; started_at 比对随 P1 .state
// 落盘到位后并入。校验失败一律判 DEAD——宁可保守接管，不冒误杀活 holder。
function proxyAliveCheck(pid) {
    if (!pidAlive(pid)) return false;
    try {
        return String(readlinkSync(`/proc/${pid}/exe`)).includes('node');
    } catch {
        return false;
    }
}

async function classifyHeldProxy(port = GODOT_PORT) {
    const held = await readHeldProxy(port);
    if (!held) return decideStaleProxyAction({ holderPid: null });
    const holderAlive = held.pid === process.pid ? null : proxyAliveCheck(held.pid);
    const d = decideStaleProxyAction({ holderPid: held.pid, ourPid: process.pid, holderAlive });
    d.runtimeId = held.runtimeId;
    return d;
}

// Evict the held editor ONLY when the classification proves the holder is a
// dead residue (takeover) or our own wedged editor (own). A live foreign
// holder ('busy') is never touched — the caller keeps the clean editor_busy
// diagnostic. `evict` is the caller-provided eviction fn (injected to keep
// this module free of spawn.mjs cycles).
async function maybeEvictStaleHeld(evict, port = GODOT_PORT) {
    const cls = await classifyHeldProxy(port);
    if (cls.action === 'busy') {
        log(`stale-holder guard (AMEND-1): held pid=${cls.pid} alive (runtime '${cls.runtimeId || '?'}') — 前任在管，不清理不接管; clean editor_busy stays.`);
        return { evicted: false, ...cls };
    }
    if (cls.action === 'free') {
        return { evicted: false, ...cls };
    }
    log(`stale-holder guard: held pid=${cls.pid} classified ${cls.action} (${cls.reason}) — evicting orphaned editor for a clean cold start.`);
    await evict();
    return { evicted: true, ...cls };
}

export {
    readHeldProxy,
    proxyAliveCheck,
    classifyHeldProxy,
    maybeEvictStaleHeld,
};
