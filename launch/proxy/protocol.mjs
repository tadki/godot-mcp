// proxy/protocol.mjs — JSON-RPC stdio plumbing (extracted from
// godot-mcp-proxy.mjs, SEE-1334 Phase 0a): client/npx writers, error frames,
// pre-open write buffer, handshake replay after an npx respawn.
import { EOL } from 'node:os';
import { S } from './state.mjs';
import { log } from './log.mjs';

function sendToClaude(obj) {
    const line = JSON.stringify(obj) + EOL;
    process.stdout.write(line);
}

function flushNpxWriteBuffer() {
    if (!S.npx || !S.npx.stdin || S.npx.stdin.destroyed || !S.npxStdinReady) return;
    while (S.npxWriteBuffer.length > 0) {
        const line = S.npxWriteBuffer.shift();
        S.npx.stdin.write(line);
        log(`DEBUG: flushed buffered npx write (${line.length} bytes)`);
    }
}

function makeErrorResponse(id, message, code = -32000, data = undefined) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    return {
        jsonrpc: '2.0',
        id,
        error,
    };
}

function forwardToNpx(line) {
    if (S.npx && S.npx.stdin && !S.npx.stdin.destroyed) {
        if (S.npxStdinReady) {
            S.npx.stdin.write(line + EOL);
            log(`DEBUG: forwarded to npx stdin: ${line.slice(0, 120)}`);
        } else {
            S.npxWriteBuffer.push(line + EOL);
            log(`DEBUG: npx stdin not yet writable; buffered message (${line.slice(0, 80)})`);
        }
    } else {
        log('WARNING: npx stdin not available; dropping message.');
    }
}

// Re-send warmup-phase handshake requests the previous npx instance died without
// answering, so the client still receives its initialize/tools/list result after
// an npx respawn instead of stalling on a request that vanished with the child.
function replayHandshake() {
    if (S.pendingHandshake.size === 0) return;
    log(`replaying ${S.pendingHandshake.size} handshake request(s) to respawned npx.`);
    for (const line of S.pendingHandshake.values()) {
        forwardToNpx(line);
    }
}

export {
    sendToClaude,
    flushNpxWriteBuffer,
    makeErrorResponse,
    forwardToNpx,
    replayHandshake,
};
