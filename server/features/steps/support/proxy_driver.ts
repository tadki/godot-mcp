// Shared protocol-driver for the gherkin scenarios (SEE-1334 Phase 3).
//
// Same methodology as launch/tests/scripts/_see1085_helpers.sh (the SSOT
// mock seams for the proxy's spawn path): counting mock configure/start
// helpers, a PATH-shimmed mock npx, and the WS-completing mock editor
// listener (launch/tests/scripts/ws-mock-listener.mjs — reused verbatim as
// the SSOT mock editor; the proxy's warmup probe is a real WS handshake, so
// a raw TCP destroy cannot signal warm). Everything is protocol-level: real
// stdio JSON-RPC against the real proxy entry, no real Godot editor.
//
// Composition: openSandbox() → writeMockHelpers() → startProxyOn(sandbox, env)
// so every seam the scenario needs exists BEFORE the proxy spawns (a single
// proxy spawn per scenario — no restart churn, no orphaned proxies).
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { deflateSync } from 'node:zlib';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const PROXY = path.join(REPO, 'launch', 'godot-mcp-proxy.mjs');
const WS_MOCK_LISTENER = path.join(REPO, 'launch', 'tests', 'scripts', 'ws-mock-listener.mjs');

export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address() as net.AddressInfo;
            srv.close(() => resolve(port));
        });
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export { sleep };

export async function until(cond: () => boolean, budgetMs: number, explain: () => string): Promise<void> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (cond()) return;
        await sleep(50);
    }
    throw new Error(`${explain()} (budget ${budgetMs}ms)`);
}

// Mock npx: answers initialize; any other id'd request is answered from
// MOCK_NPX_REPLY_FILE (toolName → raw result JSON) when present, else a
// generic "mock-ok". Inbound lines are logged for forward-assertions.
const MOCK_NPX_SRC = `\
import * as readline from 'node:readline';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
const LOG = process.env.MOCK_NPX_LOG || '';
const rl = readline.createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
    if (!line.trim()) return;
    if (LOG) { try { appendFileSync(LOG, line + '\\n'); } catch (e) {} }
    try {
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
                result: { name: 'mock-godot-mcp', protocolVersion: '2024-11-05', capabilities: {} } }) + '\\n');
            return;
        }
        const replyFile = process.env.MOCK_NPX_REPLY_FILE;
        if (replyFile && msg.method === 'tools/call' && existsSync(replyFile)) {
            const spec = JSON.parse(readFileSync(replyFile, 'utf8'));
            const r = spec[msg.params && msg.params.name];
            if (r !== undefined) {
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: r }) + '\\n');
                return;
            }
        }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
            result: { content: [{ type: 'text', text: 'mock-ok' }] } }) + '\\n');
    } catch (e) {}
});
`;

export type IdResult = {
    id: number;
    error?: { message: string; code: number; data?: Record<string, unknown> | null };
    result?: { content?: Array<{ type: string; text?: string; data?: string }> } | null;
};

export interface Sandbox {
    path: string;
    home: string;
    worktree: string;
    configureCounter: string;
    startCounter: string;
    repliesFile: string;
    listenerScript: string;
    configureMock: string;
    configureFailMock: string;
    startMock: string;
    startFailMock: string;
    heldDir: string;
}

// Create a disposable sandbox (home, worktree, counters) — no proxy yet.
export function openSandbox(): Sandbox {
    const p = mkdtempSync(path.join(tmpdir(), 'gherkin-scenario-'));
    const home = path.join(p, 'home');
    mkdirSync(home, { recursive: true });
    const worktree = path.join(p, 'worktree');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, 'project.godot'),
        'config_version=5\n\n[godot_mcp]\n\nport_override_enabled=false\nport_override=6550\n');
    // Per-sandbox listener copy: kill-by-cmdline cleanup stays scoped to this
    // scenario's sockets (mirrors _see1085_helpers.sh lib_init).
    cpSync(WS_MOCK_LISTENER, path.join(p, 'ws-mock-listener.mjs'));

    const configureCounter = path.join(p, 'cfg.count');
    const startCounter = path.join(p, 'start.count');
    writeFileSync(configureCounter, '');
    writeFileSync(startCounter, '');
    const repliesFile = path.join(p, 'replies.json');
    writeFileSync(repliesFile, '{}');
    const heldDir = path.join(p, 'held-port');

    const mockScript = (kind: 'configure' | 'start', rc: number) => {
        const counter = kind === 'configure' ? configureCounter : startCounter;
        const body =
            `#!/usr/bin/env bash\n` +
            `echo x >> "\${KOL_${kind === 'configure' ? 'CONFIGURE' : 'START'}_COUNTER:-${counter}}"\n` +
            (kind === 'start' && rc === 0
                ? `nohup env "LISTEN_PORT=\${GODOT_PORT}" node "${path.join(p, 'ws-mock-listener.mjs')}" </dev/null >/dev/null 2>"${p}/listener-start.err" &\ndisown || true\n`
                : '') +
            (kind === 'start' && rc !== 0
                ? `echo "=== 启动失败诊断（结构化） ===" >&2\necho "bucket=spawn_failed_start rc=${rc} godot_editor=/nonexistent/Godot.exe" >&2\n`
                : '') +
            `exit ${rc}\n`;
        const f = path.join(p, `mock-${kind}${rc !== 0 ? '-fail' : ''}.sh`);
        writeFileSync(f, body, { mode: 0o755 });
        return f;
    };

    return {
        path: p,
        home,
        worktree,
        configureCounter,
        startCounter,
        repliesFile,
        heldDir,
        configureMock: mockScript('configure', 0),
        configureFailMock: mockScript('configure', 1),
        startMock: mockScript('start', 0),
        startFailMock: mockScript('start', 1),
    };
}

// Spawn the proxy exactly as production does with the sandbox seams wired in.
export function startProxyOn(sandbox: Sandbox, env: Record<string, string>): ProxySession {
    const npxBin = path.join(sandbox.path, 'mock_npx_bin');
    mkdirSync(npxBin, { recursive: true });
    writeFileSync(path.join(sandbox.path, 'mock-npx-stable.mjs'), MOCK_NPX_SRC);
    writeFileSync(path.join(npxBin, 'npx'),
        `#!/usr/bin/env bash\nexec node "${path.join(sandbox.path, 'mock-npx-stable.mjs')}" "$@"\n`, { mode: 0o755 });

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const npxLog = path.join(sandbox.path, 'npx.log');

    const baseEnv: Record<string, string> = {
        GODOT_HOST: '127.0.0.1',
        PATH: `${npxBin}:${process.env.PATH}`,
        MOCK_NPX_SCRIPT_DIR: sandbox.path,
        MOCK_NPX_LOG: npxLog,
        MOCK_NPX_REPLY_FILE: sandbox.repliesFile,
        KOL_DIRECT_GODOT_MCP: '0',      // resolve to THIS mock npx (SEE-1111 opt-out)
        KOL_WORKTREE: sandbox.worktree,
        GODOT_MCP_HOME: path.join(sandbox.home, '.config', 'godot-mcp'),
    };
    const child = spawn('node', [PROXY], {
        cwd: REPO,
        env: { ...process.env, ...baseEnv, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const read = (s: NodeJS.ReadableStream, sink: string[]) =>
        createInterface({ input: s, terminal: false }).on('line', (l) => sink.push(l));
    read(child.stdout!, stdoutLines);
    read(child.stderr!, stderrLines);
    // Track the proxy child: its open stdio pipes keep the test process's
    // event loop alive, so every session MUST be torn down at scenario end.
    tracks.push(() => {
        try { child.stdin!.end(); } catch (e) {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 800);
    });

    return {
        stdoutLines,
        stderrLines,
        npxLog,
        configureCounter: sandbox.configureCounter,
        startCounter: sandbox.startCounter,
        sandbox: sandbox.path,
        send: (line) => { child.stdin!.write(line + '\n'); },
        async waitForIdResult(id: number, budgetMs: number): Promise<IdResult> {
            const deadline = Date.now() + budgetMs;
            while (Date.now() < deadline) {
                const hit = resultOf(stdoutLines, id);
                if (hit) return hit;
                await sleep(50);
            }
            throw new Error(`no JSON-RPC result for id=${id} within ${budgetMs}ms — out: ${head(stdoutLines)} err: ${head(stderrLines)}`);
        },
        async waitForErr(substr: string, budgetMs: number): Promise<void> {
            await until(
                () => stderrLines.some((l) => l.includes(substr)),
                budgetMs,
                () => `stderr never contained "${substr}" — err: ${stderrLines.slice(0, 10).join(' | ')}`);
        },
        stdinClose: () => { child.stdin!.end(); },
        alive: () => child.exitCode === null && !child.killed,
    };
}

const head = (lines: string[]) => lines.slice(0, 10).join(' | ');
const readLines = (stream: NodeJS.ReadableStream, sink: string[]) => {
    createInterface({ input: stream, terminal: false }).on('line', (l) => sink.push(l));
};
function resultOf(lines: string[], id: number): IdResult | null {
    for (const l of lines) {
        if (!l.startsWith('{')) continue;
        try {
            const m = JSON.parse(l);
            if (m && m.id === id && (m.error !== undefined || m.result !== undefined)) return m;
        } catch (e) { /* non-JSON stdout line — skip */ }
    }
    return null;
}
const rx = (s?: string) => s ?? '';

export interface ProxySession {
    stdoutLines: string[];
    stderrLines: string[];
    npxLog: string;
    configureCounter: string;
    startCounter: string;
    sandbox: string;
    send(line: string): void;
    waitForErr(substr: string, budgetMs: number): Promise<void>;
    waitForIdResult(id: number, budgetMs: number): Promise<IdResult>;
    stdinClose(): void;
    alive(): boolean;
}

const RESULT_START = /^\{/;

// Port-conflict holder: a mock editor listener bound to the port (probe and
// arbiter both see it bound) + a held-dir entry naming a foreign runtime with
// a LIVE pid (the sleeper plays the holder proxy) → arbiter ⇒ busy_foreign.
export function holdPortForForeignRuntime(sandbox: Sandbox, port: number, holderRuntimeId: string): void {
    mkdirSync(path.join(sandbox.heldDir, String(port)), { recursive: true });
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(()=>{},1<<30)'], { stdio: 'ignore' });
    writeFileSync(path.join(sandbox.heldDir, String(port), 'meta'), `runtime_id=${holderRuntimeId}\n`);
    writeFileSync(path.join(sandbox.heldDir, String(port), 'pid'), `${sleeper.pid}\n`);
    const listener = spawn(process.execPath, [path.join(sandbox.path, 'ws-mock-listener.mjs')], {
        env: { ...process.env, LISTEN_PORT: String(port) },
        stdio: 'ignore',
    });
    tracks.push(() => { try { sleeper.kill('SIGKILL'); } catch (e) {} }, () => { try { listener.kill('SIGKILL'); } catch (e) {} });
}

const RESULT_PIPE = /\{/;
// Session teardown queue — filled by startProxyOn and the holders.
const tracks: Array<() => void> = [];
export function disposeAll(): void {
    for (const stop of tracks.splice(0)) {
        try { stop(); } catch (e) { /* already gone */ }
    }
}
export function disposeSandbox(sandbox: Sandbox): void {
    spawn('pkill', ['-f', path.join(sandbox.path, 'ws-mock-listener.mjs')], { stdio: 'ignore' });
    setTimeout(() => rmSync(sandbox.path, { recursive: true, force: true }), 200);
}

// --- single-client mock editor (4001 rejection) ------------------------------

// Mimics websocket_server.gd's single-client semantics: the FIRST WS client
// completes the HTTP Upgrade; any further connection gets WS close code 4001
// (server→client close frames are unmasked per RFC 6455).
export function startSingleClientEditor(port: number, events: string[]): void {
    const socketRefs: net.Socket[] = [];
    const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    let firstTaken = false;
    const srv = net.createServer((sock) => {
        socketRefs.push(sock);
        let buffered = Buffer.alloc(0);
        sock.on('data', (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);
            const idx = buffered.indexOf('\r\n\r\n');
            if (idx < 0) return;                       // request head incomplete
            const headText = buffered.subarray(0, idx).toString('utf8');
            if (!/upgrade/i.test(headText)) { sock.destroy(); return; }
            if (!firstTaken) {
                firstTaken = true;
                const key = /sec-websocket-key:\s*(\S+)/i.exec(headText)?.[1] ?? '';
                const accept = createHash('sha1').update(key.trim() + GUID).digest('base64');
                sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
                events.push('upgraded');
            } else {
                // Slot owned: complete the upgrade with a CORRECT accept (a
                // bogus accept makes the ws client abort at 1006 before it can
                // parse the close frame), then send close code 4001 — the
                // addon's documented single-slot rejection.
                const key = /sec-websocket-key:\s*(\S+)/i.exec(headText)?.[1] ?? '';
                const accept = createHash('sha1').update(key.trim() + GUID).digest('base64');
                sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
                sock.write(Buffer.from([0x88, 0x02, 0x0f, 0xa1])); // WS close(4001)
                events.push('closed_4001');
            }
        });
        sock.on('error', () => {});
    });
    srv.listen(port, '127.0.0.1');
    tracks.push(() => {
        srv.close();
        // srv.close() alone leaves live upgraded sockets keeping the event
        // loop alive — destroy them so the run can exit.
        for (const sock of socketRefs.splice(0)) { try { sock.destroy(); } catch (e) {} }
    });
}

// --- PNG construction --------------------------------------------------------
// Minimal 8-bit RGB PNG (same technique as test_see1240_screenshot_contract.mjs).
let crcTable: number[] | null = null;
function buildCrcTable(): number[] {
    const t: number[] = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
}
function crc32(buf: Buffer): number {
    crcTable ??= buildCrcTable();
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crcBuf]);
}
export function makePng(width: number, height: number): Buffer {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 2;  // color type: RGB
    ihdr[10] = 0; // compression: deflate
    ihdr[11] = 0; // filter: adaptive per-row
    ihdr[12] = 0; // interlace: none
    const rowBytes = width * 3 + 1;
    const raw = Buffer.alloc(rowBytes * height);
    for (let y = 0; y < height; y++) {
        const off = y * rowBytes;
        raw[off] = 0; // filter: none per row
        for (let x = 0; x < width * 3; x++) raw[off + 1 + x] = (x + y) & 0x7f;
    }
    return Buffer.concat([
        signature,
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// Common JSON-RPC lines (mirror _see1085_helpers.sh init/call lines).
export const INIT_LINE: string = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
        protocolVersion: '2024-11-05', capabilities: {},
        clientInfo: { name: 'gherkin', version: '0' },
    },
});
export const jsonRpcCall: (id: number, name?: string, args?: Record<string, unknown>) => string =
    (id, name = 'get_project_info', args = {}) =>
        JSON.stringify({
            jsonrpc: '2.0', id, method: 'tools/call',
            params: { name, arguments: args, _meta: { progressToken: `pk-${id}` } },
        });
