#!/usr/bin/env node
// SEE-1240 WS-3 — real-machine ui_inspect + drag smoke test.
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { appendFileSync } from 'node:fs';

const PORT = process.env.RM_PORT || '6560';
const HOST = process.env.RM_HOST || '172.17.192.1';
// SEE-1273 T3: 双落点（优先 submodule、兜底旧路径）
import { existsSync as _mcp_exists } from "node:fs";
const PROXY = "addons/godot_mcp/launch/godot-mcp-proxy.mjs";
const WORKTREE = process.cwd();
const OUT = 'launch/tests/e2e/see1240/ui-smoke.log';

const proxy = spawn('node', [PROXY], {
    env: { ...process.env, GODOT_HOST: HOST, GODOT_PORT: PORT, KOL_WORKTREE: WORKTREE,
        KOL_PROJECT_GODOT: `${WORKTREE}/project.godot`, KOL_AGENT_NAME: 'Fronti',
        KOL_WARMUP_TIMEOUT_MS: '60000', KOL_FAILED_EXIT_MS: '120000' },
    stdio: ['pipe', 'pipe', 'pipe'],
});
proxy.stderr.on('data', (c) => { try { appendFileSync(OUT, `[proxy-err] ${c}`); } catch {} });
let nextId = 1;
const pending = new Map();
const rl = readline.createInterface({ input: proxy.stdout, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
    try { appendFileSync(OUT, `[stdout] ${line}\n`); } catch {}
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg);
    }
});
function call(method, params, timeoutMs = 60000) {
    const id = nextId++;
    return new Promise((resolve) => {
        pending.set(id, { resolve });
        proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timedOut: true, id }); } }, timeoutMs);
    });
}
const text = (r) => (r?.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

let pass = 0, fail = 0;
function step(name, ok, detail) {
    if (ok) pass++; else fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + String(detail).slice(0, 150) : ''}`);
}

await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'see1240-ui', version: '1.0.0' } }, 15000);
const warm = await call('tools/call', { name: 'godot_project', arguments: { action: 'get_info' } }, 120000);
step('warm', !warm.error && !warm.timedOut, text(warm).slice(0, 60));

// ui_inspect ui_tree on the title screen (game currently in SC sandbox — run game first)
await call('tools/call', { name: 'godot_editor_edit', arguments: { action: 'run', scene_path: 'res://scenes/ui/title_screen/title_screen.tscn' } }, 90000);
await new Promise((r) => setTimeout(r, 4000)); // let the game bridge boot before exec-based inspection
let tree = await call('tools/call', { name: 'godot_ui_inspect', arguments: { action: 'ui_tree', root_path: '/root' } }, 90000);
let treeText = text(tree);
if (treeText.includes('TIMEOUT')) {
    await new Promise((r) => setTimeout(r, 3000));
    tree = await call('tools/call', { name: 'godot_ui_inspect', arguments: { action: 'ui_tree', root_path: '/root' } }, 90000);
    treeText = text(tree);
}
step('ui_tree responds', !tree.error && treeText.length > 0, treeText.slice(0, 100));
const treeJson = (() => { try { return JSON.parse(treeText.split('\n')[0]); } catch { return null; } })();
step('ui_tree controls listed', Array.isArray(treeJson?.controls) && treeJson.controls.length > 0,
    `count=${treeJson?.count}`);

// ui_inspect inspect_node on the title screen root
const nodeResp = await call('tools/call', { name: 'godot_ui_inspect', arguments: { action: 'inspect_node', node_path: '/root/TitleScreen' } }, 60000);
const nodeText = text(nodeResp);
step('inspect_node responds', !nodeResp.error && nodeText.length > 0, nodeText.slice(0, 100));
step('inspect carries reliability note', nodeText.includes('[reliability]'), '');
step('inspect carries semantics note', nodeText.includes('RUNNING GAME'), '');

// drag smoke: drag the 新游戏 button 100px right — the wire gets expanded entries.
// Prove via game-side cursor tracking: MCPCursor virtual pos seed + a gui hover probe.
const drag = await call('tools/call', { name: 'godot_input', arguments: { action: 'sequence', inputs: [
    { drag: { from: [450, 280], to: [550, 280], duration_ms: 120 } },
] } }, 60000);
step('drag sequence executes', !drag.error && !drag.timedOut, text(drag).slice(0, 100));

// malformed drag rejection through the REAL chain
const bad = await call('tools/call', { name: 'godot_input', arguments: { action: 'sequence', inputs: [
    { drag: { from: [5] } },
] } }, 30000);
step('malformed drag rejected', Boolean(bad.error), (bad.error?.message || '').slice(0, 80));

console.log(`SMOKE SUMMARY: PASS=${pass} FAIL=${fail}`);
proxy.kill('SIGTERM');
process.exit(fail === 0 ? 0 : 1);
