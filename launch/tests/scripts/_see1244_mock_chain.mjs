#!/usr/bin/env node
// SEE-1244 test fixture: mock godot-mcp chain standing in for
// bash godot-mcp-launcher.sh in handoff tests (test_see1244_shim_handoff.mjs).
// Speaks newline-delimited JSON-RPC on stdio; echoes every request line back
// with a MOCK_CHAIN_ECHO marker so the test can prove the shim forwarded it.
//
// Flags:
//   --emit-frame      emit one probe JSON frame immediately on stdout
//                     (exercises T2 proxy_ready handoff + pre-handoff drain)
//   --die-after-echo  exit(1) after answering the first request
//                     (exercises D4 post-handoff chain death)
//
// Boot sequence mirrors the real launcher→proxy pair: the shim's handoff gate
// requires proof the proxy is exec'd (LAUNCHER_EXEC stderr line — the real
// proxy emits NO stdout frame until it first receives the claude-forwarded
// initialize, so a frame-only gate would deadlock the real chain).
//
// IMPORTANT: the notifications/ready frame here is GATED on --emit-frame.
// D3 (--die-after-echo) relies on the chain being ALIVE-but-not-yet-proven
// when the tools/call lands so the call is transient-answered (state tag
// asserted); an unconditional boot frame would flip the shim into handoff
// before D3's call arrives, making D3 assert a different code path. --emit-
// frame stays the explicit T2 exercise flag.

let echoCount = 0;
process.stderr.write('[godot-mcp-launcher] stage=LAUNCHER_EXEC msg="exec godot-mcp-proxy.mjs (mock)"\n');
process.stdin.setEncoding('utf8');
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.trim()) return;
    echoCount++;
    let id = null;
    try { id = JSON.parse(line).id; } catch { /* keep null */ }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { MOCK_CHAIN_ECHO: true, line } })}\n`);
    if (process.argv.includes('--die-after-echo') && echoCount >= 1) {
        process.exit(1);
    }
});
if (process.argv.includes('--emit-frame')) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/ready' })}\n`);
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/probe', params: { probe: true } })}\n`);
}
