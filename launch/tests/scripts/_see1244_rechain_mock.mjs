#!/usr/bin/env node
// SEE-1244 rechain test fixture: a chain mock that dies exactly once (first
// spawn) and then serves normally — exercises the shim's revival state machine
// (test_see1244_rechain.mjs R2). Uses a fixed marker file to record that the
// first spawn already happened; the test harness cleans it between runs.

import { createInterface } from 'node:readline';
import fs from 'node:fs';

const FLAG = '/tmp/see1244-rechain-flag';
if (!fs.existsSync(FLAG)) {
    fs.writeFileSync(FLAG, '1');
    process.stderr.write('[rechain-mock] first spawn: dying (simulated transient failure)\n');
    process.exit(1);
}
createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity }).on('line', (line) => {
    if (!line.trim()) return;
    let id = null;
    try { id = JSON.parse(line).id; } catch { /* keep null */ }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result: { RECHAIN_REVIVED: true } })}\n`);
});
// Shim handoff gate requires proxy-exec proof (decision 01a08100): emit the
// launcher's exec signal, then a first stdout frame (which also triggers T2).
process.stderr.write('[godot-mcp-launcher] stage=LAUNCHER_EXEC msg="exec godot-mcp-proxy.mjs (mock)"\n');
process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/ready' })}\n`);
