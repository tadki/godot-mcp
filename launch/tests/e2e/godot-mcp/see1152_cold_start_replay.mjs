// SEE-1152 cold-start replay harness (goal 1 + goal 4).
//
// Drives a REAL cold start through the same stdio MCP shape the Multica
// platform uses: spawn godot-mcp-proxy.mjs as the stdio server, then fire the
// first godot_project.get_info call. Captures the proxy's [stage=...] stderr
// lines with absolute timestamps, measures end-to-end first-call latency, and
// then walks the editor log (~/.multica/godot-editor/<label>-<runtime>.log)
// to extract the addon's own [stage=...] lines (IDLE_GATE / WS_BIND) so the
// report joins proxy-side and editor-side spans on one timeline.
//
// Usage:
//   node .dev/godot-mcp/tests/e2e/godot-mcp/see1152_cold_start_replay.mjs \
//        [--port 6553] [--agent Bachi] [--label bachi] \
//        [--timeout-ms 400000] [--out /tmp/replay.json]
//
// Exit 0 if first call succeeded, 1 otherwise. Prints a JSON summary to
// stdout (and --out file) for later diffing (pre vs post optimization).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../../../..');
const proxy = resolve(repoRoot, 'launch/godot-mcp-proxy.mjs');

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const PORT = arg('port', '6553');
const AGENT = arg('agent', 'Bachi');
const LABEL = arg('label', 'bachi');
const TIMEOUT_MS = parseInt(arg('timeout-ms', '400000'), 10);
const OUT = arg('out', '');

// SEE-1152 goal-4 finding: the proxy's wsProbe hits `ws://${GODOT_HOST}:${PORT}`
// where GODOT_HOST defaults to 127.0.0.1. On WSL the addon binds ONLY the
// Windows host's WSL-facing interface (172.17.192.1) — a WSL-local 127.0.0.1
// never reaches it, so wsProbe fails forever and warmup never completes even
// though the editor bound the leased port and the godot-mcp CLI (which
// auto-detects the gateway IP itself) connected fine. The real Multica
// platform passes GODOT_HOST explicitly; the replay must do the same or it
// measures a harness artifact, not cold-start behavior. Resolve the gateway
// from /proc/net/route the same way the godot-mcp CLI does: the gateway field
// is a hex DWORD in host byte order, so the dotted quad reads the hex byte
// pairs LAST-to-FIRST (hex "AC11C001" -> 172.17.192.1).
function detectWslGateway() {
    try {
        const route = readFileSync('/proc/net/route', 'utf8');
        for (const line of route.split('\n').slice(1)) {
            const cols = line.trim().split(/\s+/);
            if (cols.length < 3 || cols[1] !== '00000000') continue;
            const hex = cols[2];
            if (!/^[0-9A-Fa-f]{8}$/.test(hex)) continue;
            // Little-endian: pair order in the dotted quad is reversed.
            const p0 = parseInt(hex.slice(6, 8), 16);
            const p1 = parseInt(hex.slice(4, 6), 16);
            const p2 = parseInt(hex.slice(2, 4), 16);
            const p3 = parseInt(hex.slice(0, 2), 16);
            return `${p0}.${p1}.${p2}.${p3}`;
        }
    } catch { /* not WSL or unreadable */ }
    return '';
}
const GODOT_HOST = arg('host', '') || process.env.GODOT_HOST || detectWslGateway() || '127.0.0.1';

// Stage-line regex shared by proxy stderr and editor log tails.
const STAGE_RE = /\[stage=([A-Z_0-9]+)\]\s+\[t=\+(\d+)ms\]\s+\[ts=([^\]]+)\]/;

const proxyStages = [];
let proxyStderrTail = '';

const client = new Client({ name: 'see1152-replay', version: '1.0.0' });
const transport = new StdioClientTransport({
    command: 'node',
    args: [proxy],
    env: {
        ...process.env,
        GODOT_HOST,
        GODOT_PORT: PORT,
        KOL_AGENT_NAME: AGENT,
        KOL_STAGE_LOG: 'on',
    },
});

const t0 = Date.now();
const wall = (ms) => new Date(ms).toISOString();
const rel = (ms) => `${ms - t0}ms`;

// Tap proxy stderr: the StdioClientTransport exposes the child via .process?
// The SDK transport does not expose stderr directly; instead we capture via
// spawn env — the proxy writes stage lines to ITS stderr, which the transport
// pipes to OUR stderr. We additionally re-emit into proxyStages by listening
// on the transport's stderr stream when available.
const childStderr = transport?.process?.stderr ?? transport?.stderr ?? null;

let firstCallOk = false;
let firstCallMs = -1;
let firstCallErr = '';
let getInfoText = '';

try {
    await client.connect(transport);
    const connectMs = Date.now();
    console.error(`[replay] stdio connect done at ${rel(connectMs)} (${wall(connectMs)})`);

    // Try to attach a stderr listener now that the process exists.
    const proc = transport.process ?? transport._process ?? null;
    if (proc && proc.stderr) {
        proc.stderr.on('data', (chunk) => {
            const s = chunk.toString();
            proxyStderrTail += s;
            if (proxyStderrTail.length > 200000) proxyStderrTail = proxyStderrTail.slice(-200000);
            for (const line of s.split('\n')) {
                const m = line.match(STAGE_RE);
                if (m) proxyStages.push({ stage: m[1], t_ms: parseInt(m[2], 10), ts: m[3], src: 'proxy' });
            }
        });
    }

    const callStart = Date.now();
    try {
        const result = await client.callTool(
            { name: 'godot_project', arguments: { action: 'get_info' } },
            undefined,
            { timeout: TIMEOUT_MS }
        );
        firstCallMs = Date.now() - callStart;
        firstCallOk = true;
        const c = result?.content?.[0];
        getInfoText = c && c.text ? c.text.slice(0, 400) : '';
    } catch (e) {
        firstCallMs = Date.now() - callStart;
        firstCallErr = e && e.message ? e.message : String(e);
    }
} catch (e) {
    firstCallErr = `connect failed: ${e && e.message ? e.message : e}`;
}

// Give proxy stderr a beat to flush trailing stage lines.
await new Promise((r) => setTimeout(r, 1500));

// Harvest any stage lines in the captured stderr tail not yet recorded
// (covers transports where the stream handle differed).
for (const line of proxyStderrTail.split('\n')) {
    const m = line.match(STAGE_RE);
    if (m && !proxyStages.some((p) => p.stage === m[1] && p.ts === m[3])) {
        proxyStages.push({ stage: m[1], t_ms: parseInt(m[2], 10), ts: m[3], src: 'proxy' });
    }
}

// Editor-side stages from the addon log. Path convention (runtime.lib.sh
// kol_lifecycle_path): ${HOME}/.multica/godot-editor/<runtime_id>.log when a
// runtime_id is active, else legacy ${HOME}/.multica/godot-editor-<label>.log.
const RUNTIME_ID = process.env.KOL_RUNTIME_ID || `${AGENT}-257ad782`;
const editorStages = [];
let editorLogPath = '';
const candidates = [
    `${homedir()}/.multica/godot-editor/${RUNTIME_ID}.log`,
    `${homedir()}/.multica/godot-editor-${LABEL}.log`,
];
for (const p of candidates) {
    if (existsSync(p)) { editorLogPath = p; break; }
}
// Fallback: newest file in the godot-editor dir matching label.
if (!editorLogPath) {
    try {
        const dir = `${homedir()}/.multica/godot-editor`;
        const { readdirSync, statSync } = await import('node:fs');
        const files = readdirSync(dir)
            .filter((f) => f.includes(LABEL))
            .map((f) => ({ f, m: statSync(`${dir}/${f}`).mtimeMs }))
            .sort((a, b) => b.m - a.m);
        if (files.length) editorLogPath = `${dir}/${files[0].f}`;
    } catch {}
}
if (editorLogPath) {
    try {
        const content = readFileSync(editorLogPath, 'utf8');
        for (const line of content.split('\n')) {
            const m = line.match(STAGE_RE);
            if (m) editorStages.push({ stage: m[1], t_ms: parseInt(m[2], 10), ts: m[3], src: 'editor' });
        }
    } catch (e) {
        console.error(`[replay] editor log read failed: ${e.message}`);
    }
}

const summary = {
    ok: firstCallOk,
    first_call_ms: firstCallMs,
    first_call_err: firstCallErr,
    timeout_ms: TIMEOUT_MS,
    port: PORT,
    host: GODOT_HOST,
    agent: AGENT,
    started_at: wall(t0),
    finished_at: wall(Date.now()),
    editor_log: editorLogPath || null,
    proxy_stages: proxyStages,
    editor_stages: editorStages,
    get_info_excerpt: getInfoText,
};

console.log(JSON.stringify(summary, null, 2));
if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2));

try { await client.close(); } catch {}
process.exit(firstCallOk ? 0 : 1);
