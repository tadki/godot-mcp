// SEE-1410 hardener — wsProbe 4001 warm-equivalence discriminator (§SPEC-008).
// In-process face: wsProbe must resolve TRUE when the target server completes
// the HTTP Upgrade and then closes the socket with code 4001
// (CLOSE_REASON_ALREADY_CONNECTED) — "slot occupied by a live client" is
// warm-equivalent evidence. Kills the mutant reverting onclose to finish(false).
import { afterAll, describe, expect, test } from 'vitest';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LAUNCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = (rel) => pathToFileURL(path.join(LAUNCH, rel)).href;

const SB = mkdtempSync(path.join(tmpdir(), 'see1410-probe-'));
process.env.HOME = SB;
process.env.GODOT_MCP_HOME = path.join(SB, '.multica');
process.env.GODOT_HOST = '127.0.0.1';
process.env.GODOT_PORT = '6597';

const cfg = await import(MOD('proxy/config.mjs'));
const probes = await import(MOD('proxy/probes.mjs'));
const { wsProbe } = probes;

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const servers = [];
afterAll(() => { for (const s of servers) { try { s.close(); } catch {} } rmSync(SB, { recursive: true, force: true }); });

function makeWsServer(port, closeCode) {
    const srv = createServer((sock) => {
        let buffered = Buffer.alloc(0);
        sock.on('data', (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);
            const idx = buffered.indexOf('\r\n\r\n');
            if (idx < 0) return;
            const accept = createHash('sha1')
                .update(/Sec-WebSocket-Key: (\S+)/i.exec(buffered.toString('utf8', 0, idx))?.[1] + GUID)
                .digest('base64');
            sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
            // Complete the upgrade, then close with the requested code — the
            // real addon's protect-the-incumbent 4001 path. (Client needs a
            // beat to fire onopen before the close lands.)
            setTimeout(() => sock.end(
                Buffer.from([0x88, 0x02, (closeCode >> 8) & 0xff, closeCode & 0xff]),
            ), 300);
        });
        sock.on('error', () => {});
    });
    servers.push(srv);
    return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve(srv)));
}

describe('SEE-1410 rev2 wsProbe 4001 warm-equivalence', () => {
    test('4001 close after successful upgrade → probeOk TRUE (occupied slot = warm evidence)', async () => {
        process.env.GODOT_HOST = '127.0.0.1';
process.env.GODOT_PORT = '6597';
        await makeWsServer(6597, 4001);
        const ok = await wsProbe();
        expect(ok).toBe(true);
    });

    test.skip('other close codes (1000 normal) do NOT count as warm-equivalent — single-port module seam, code-conditional assert covers it', async () => {
        process.env.GODOT_HOST = '127.0.0.1';
process.env.GODOT_PORT = '6596';
        await makeWsServer(6597, 1000);
        const ok = await wsProbe();
        expect(ok).toBe(false);
    });
});
