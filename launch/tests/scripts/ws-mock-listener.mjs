// ws-mock-listener.mjs — the SEE-1085/SEE-1110/SEE-1111 harness's mock editor
// WS listener.
//
// The proxy's warmup probe is a REAL WebSocket handshake (SEE-1111 缺陷 #6:
// wsProbe, a raw TCP connect would be accepted by the addon's single-slot WS
// server as a `_ws_peer` stuck in STATE_CONNECTING and poison the slot for the
// real CLI). The mock editor must therefore complete an HTTP Upgrade for the
// probe to observe `open` — a bare TCP listener that destroys sockets can no
// longer signal "editor is warm".
//
// Behavior:
//   - Binds 127.0.0.1:LISTEN_PORT (the simulated addon WS server).
//   - For every inbound socket, reads the HTTP request head and, if it is a
//     WebSocket Upgrade, replies 101 + the Sec-WebSocket-Accept handshake.
//     This satisfies the probe's `open` event (STATE_OPEN in the real addon).
//   - After the handshake the socket is left open until the client closes it
//     (the probe closes immediately on `open`, mirroring the real proxy), then
//     the socket is destroyed.
//
// The proxy never sends MCP frames to the mock editor — it forwards calls to
// the mock npx child, so the listener only needs the Upgrade to succeed.
//
// Optional WS_COUNT_FILE env: when set, each COMPLETED WebSocket handshake
// appends a marker line (SEE-1111 缺陷 #6 — proves the proxy's warmup probe is a
// real WS Upgrade, not a raw TCP connect that the addon would accept as a stuck
// STATE_CONNECTING peer). Default unset: no counting, current behavior.
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync } from 'node:fs';

const port = parseInt(process.env.LISTEN_PORT || '0', 10);
const countFile = process.env.WS_COUNT_FILE || '';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function tryUpgrade(sock, head) {
    const idx = head.indexOf('\r\n\r\n');
    if (idx < 0) return false; // request head incomplete — wait for more data
    const headerText = head.toString('utf8', 0, idx).split('\r\n');
    const requestLine = headerText.shift() || '';
    if (!/^GET \S+ HTTP\/1\.1$/.test(requestLine)) return false;
    const headers = {};
    for (const line of headerText) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    if (headers.upgrade !== 'websocket' || headers['sec-websocket-key'] === undefined) return false;
    const accept = createHash('sha1').update(headers['sec-websocket-key'] + GUID).digest('base64');
    sock.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n'
    );
    if (countFile) { try { appendFileSync(countFile, 'ws\n'); } catch (e) {} }
    return true;
}

const srv = createServer((sock) => {
    let buffered = Buffer.alloc(0);
    sock.on('data', (chunk) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (tryUpgrade(sock, buffered)) {
            // Handshake done — hold the socket until the probe closes it.
            buffered = Buffer.alloc(0);
            sock.on('end', () => sock.destroy());
            sock.on('error', () => {});
        }
    });
    sock.on('error', () => {});
});
srv.on('error', (e) => {
    process.stderr.write('listener error: ' + e.message + '\n');
    process.exit(1);
});
srv.listen(port, '127.0.0.1', () => process.stderr.write('listener up\n'));

// SEE-1134 Q1 self-test: the proxy's driveRestartRespawn probes for the port
// to go cold. The mock listener must therefore voluntarily release the port
// when a "drop" signal arrives. Two supported triggers:
//   1. DROP_ON_RESTART_FILE — when this file exists at startup OR appears while
//      listening, the server is closed and the process exits (mocks the editor
//      tearing down for restart).
//   2. SIGHUP — same effect, but synchronous (Node closes the listening socket
//      then exits). Convenient from a parent shell that knows the listener pid.
const DROP_ON_RESTART_FILE = process.env.DROP_ON_RESTART_FILE || '';
if (DROP_ON_RESTART_FILE) {
    let dropped = false;
    const drop = () => {
        if (dropped) return;
        dropped = true;
        process.stderr.write('listener dropping on signal/flag\n');
        try { srv.close(); } catch (e) {}
        setTimeout(() => process.exit(0), 30);
    };
    process.on('SIGHUP', drop);
    process.stderr.write('listener drop-watch armed: ' + DROP_ON_RESTART_FILE + '\n');
    setInterval(() => {
        try {
            if (existsSync(DROP_ON_RESTART_FILE)) drop();
        } catch (e) {}
    }, 80);
}
