// proxy/tools-cache.mjs — tools/list patching + the shim registration
// cache (extracted from godot-mcp-proxy.mjs, SEE-1334 Phase 0a): appends
// godot_ui_inspect, applies DESCRIPTION_PATCHES, persists the post-patch list,
// proactively refreshes once warm+CLI-connected.
import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { S } from './state.mjs';
import { FORK_CLI_PATH, TOOLS_CACHE_DIR, TOOLS_CACHE_FILE } from './config.mjs';
import { log } from './log.mjs';
import { forwardToNpx, sendToClaude } from './protocol.mjs';
import { UI_INSPECT_TOOL, DESCRIPTION_PATCHES } from '../see1240-ui-tools.mjs';

// SEE-1240 WS-3: tools/list response patch. Pure (unit-tested):
//   1. append the proxy-provided godot_ui_inspect tool (unless already present
//      — idempotent across npx respawns replaying tools/list),
//   2. apply DESCRIPTION_PATCHES (string-anchored; a changed anchor skips the
//      patch so a future fork that ships the truth natively is left alone),
//   3. note the proxy surface in the first line of... no — in a dedicated
//      trailing entry is noisy; instead the note rides godot_ui_inspect's own
//      description (already explicit) and each patch mentions SEE-1240.
export function patchToolsListForTest(result) { return patchToolsList(result); }
function patchToolsList(result) {
    const tools = result.tools;
    if (!Array.isArray(tools)) return result;
    if (!tools.some((t) => t && t.name === UI_INSPECT_TOOL.name)) {
        tools.push(UI_INSPECT_TOOL);
    }
    for (const patch of DESCRIPTION_PATCHES) {
        const idx = tools.findIndex((t) => t && t.name === patch.tool && typeof t.description === 'string');
        if (idx < 0) continue;
        if (tools[idx].description.includes(patch.anchor)) {
            tools[idx] = {
                ...tools[idx],
                description: tools[idx].description.replace(patch.anchor, patch.replace),
            };
        }
    }
    return { ...result, tools };
}

function writeToolsCache(tools) {
    try {
        if (!Array.isArray(tools) || tools.length === 0) return;
        const payload = JSON.stringify({
            schema: 1,
            fork: (() => { try { return String(statSync(FORK_CLI_PATH).mtimeMs); } catch { return null; } })(),
            updated_at: new Date().toISOString(),
            tools,
        });
        mkdirSync(TOOLS_CACHE_DIR, { recursive: true });
        const tmp = `${TOOLS_CACHE_FILE}.tmp-${process.pid}`;
        writeFileSync(tmp, payload);
        renameSync(tmp, TOOLS_CACHE_FILE);
        log(`tools cache written: ${TOOLS_CACHE_FILE} tools=${tools.length}`);
    } catch (err) {
        log(`WARNING: tools cache write failed (ignored): ${err && err.message}`);
    }
}

// SEE-1244 §6.2 (Revy QA defect #1 fix, option a): the shim intercepts claude's
// registration-window tools/list, so the patchToolsList→writeToolsCache hook on
// claude's forwarded requests can NEVER fire in the real cold-start flow (claude
// does not re-pull after handoff despite listChanged; the proxy never emitted
// notifications/tools/list_changed). Closure therefore cannot depend on any
// client behavior: once WARM (editor live) AND the CLI's WS is connected
// (npxCliConnected — a fresh CLI cannot answer yet, same gate as WARM_FLUSH),
// the proxy ACTIVELY pulls tools/list from the fork on its own id space (same
// pattern as forwardGodotExecAndAwait, SEE-1240 WS-3), patches the response,
// and writes the cache. One-shot per spawn round: npx respawns re-trigger it,
// keeping the cache fresh across CLI restarts. Failure is log-only — the cache
// stays an acceleration layer, never a registration gate.

// MEDIUM-1 (Atlas Final Review): the 45s timeout branch must EXPLICITLY reset
// both latches and leave an audit line — previously it only cleared the waiter,
// so if a stalled request was re-armed by a respawn the inFlight flag could
// stall a later retry. Fork-unresponsive is now: flush failed id, reset both
// flags, audit — the next spawn round retries cleanly.
function abortToolsCacheRefresh(internalId, reason) {
    const timer = S.toolsCacheWaiters.get(internalId);
    if (!timer) return;
    S.toolsCacheWaiters.delete(internalId);
    clearTimeout(timer);
    S.toolsCacheRefreshInFlight = false;
    S.toolsCacheRefreshedForSpawn = false;
    log(`WARNING: tools cache refresh aborted (${reason}); flags reset — next spawn round retries. id=${internalId}`);
}
function maybeRefreshToolsCache() {
    if (!S.warm || !S.npxCliConnected) return;
    if (S.toolsCacheRefreshInFlight || S.toolsCacheRefreshedForSpawn) return;
    S.toolsCacheRefreshInFlight = true;
    const internalId = `see1244-tools-cache-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const line = JSON.stringify({ jsonrpc: '2.0', id: internalId, method: 'tools/list' });
    const timer = setTimeout(() => abortToolsCacheRefresh(internalId, 'timeout_45s_fork_unresponsive'), 45000);
    S.toolsCacheWaiters.set(internalId, timer);
    log(`tools cache refresh: pulling tools/list from fork (id=${internalId}).`);
    forwardToNpx(line);
}

// SEE-1244 §6.2: consume the refresh response — patch + cache write, then emit
// notifications/tools/list_changed so any listChanged-aware client (claude
// declared support in the shim's initialize) re-pulls the REAL list within the
// same session. Best-effort; the closure never depends on the client acting.
function resolveToolsCacheRefresh(msg) {
    const timer = S.toolsCacheWaiters.get(msg.id);
    if (!timer) return false;
    S.toolsCacheWaiters.delete(msg.id);
    clearTimeout(timer);
    S.toolsCacheRefreshInFlight = false;
    S.toolsCacheRefreshedForSpawn = true;
    try {
        const patched = patchToolsList(msg.result);
        writeToolsCache(patched.tools);
        log(`tools cache refresh complete: tools=${patched.tools.length} (post-patch).`);
        // Protocol-legal channel declared in the shim's initialize capabilities;
        // claude re-pulls tools/list (which this time flows to the warm proxy
        // and gets the REAL patched list — closing the description drift window).
        sendToClaude({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    } catch (err) {
        log(`WARNING: tools cache refresh handling failed (ignored): ${err && err.message}`);
    }
    return true;
}

export {
    patchToolsList,
    writeToolsCache,
    abortToolsCacheRefresh,
    maybeRefreshToolsCache,
    resolveToolsCacheRefresh,
};
