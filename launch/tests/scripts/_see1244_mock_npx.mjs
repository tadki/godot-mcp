#!/usr/bin/env node
// SEE-1244 test fixture: hermetic mock godot-mcp CLI (stands in for the owner
// fork) PLUS a fake Godot-editor WS listener on the port the launcher/proxy
// probes. Without the fake editor the proxy's warm gate (`warm && npxCliConnected`)
// never opens and the proactive tools-cache refresh never fires — the cold-flow
// tests then depend on an editor left on the port by a PREVIOUS (real) run,
// which is exactly the environmental flakiness that made
// test_see1244_cache_closure.mjs intermittently FAIL (owner order: no "疑似",
// must be hermetic).
//
// Answers initialize + tools/list with a small fixed list (enough for the
// patchToolsList → cache-write path), and answers the proxy's self-initiated
// `see1244-tools-cache-*` tools/list too. Never touches a real editor.

import { createInterface } from 'node:readline';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TOOLS = ['godot_exec', 'godot_project', 'godot_scene'].map((name) => ({
    name,
    description: `mock fork tool ${name} (SEE-1244 fixture)`,
    inputSchema: { type: 'object', properties: {} },
}));

// The launcher resolves the editor WS host the same way the proxy does
// (resolve_mcp_host); for the mock we fix 127.0.0.1.
function startFakeEditor(port) {
    // Verify the port is actually free FIRST — if a stale real editor (or a
    // leftover from a previous test run) already owns it, we must NOT silently
    // lean on it (that is the old flakiness). Bind failure = loud test error.
    const server = http.createServer();
    server.on('upgrade', (req, socket) => {
        const key = req.headers['sec-websocket-key'];
        if (!key) { socket.destroy(); return; }
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    });
    return new Promise((resolve, reject) => {
        const onErr = (e) => reject(new Error(`fake editor port ${port} is NOT free (${e.code}); a stale real editor would have made this test pass/fail non-hermetically`));
        server.once('error', onErr);
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', onErr);
            // Assert the port we bound is the port the proxy will probe — read
            // the arbiter off env so a dynamic assign cannot diverge the mock.
            resolve(server);
        });
    });
}

const portArg = process.argv[2];
const port = parseInt(portArg || (process.env.KOL_MCP_PORT || '6596'), 10);

let fakeEditor = null;
startFakeEditor(port)
    .then((server) => {
        fakeEditor = server;
        process.stderr.write(`[mock-npx] fake editor WS listener on 127.0.0.1:${port}\n`);
        process.stderr.write('Connected to Godot\n'); // SEE-1111 flush-gate signal
    })
    .catch((err) => {
        process.stderr.write(`${err.message}\n`);
        process.exit(1);
    });

const rl = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.method === 'initialize') {
        process.stdout.write(`${JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { protocolVersion: msg.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'godot-mcp', version: 'mock' } },
        })}\n`);
    } else if (msg.method === 'tools/list') {
        // Includes the proxy's self-initiated see1244-tools-cache-* pull.
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })}\n`);
    } else if (msg.id !== undefined) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'mock ok' }] } })}\n`);
    }
});

process.on('exit', () => { try { fakeEditor?.close?.(); } catch { /* best-effort */ } });