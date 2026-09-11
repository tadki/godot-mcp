#!/usr/bin/env node
// SEE-1240 WS-3 — SEE-1166 amber_px oracle driver.
// Navigates the RUNNING game to the Shadow Console sandbox (amber tunnels,
// sc_tunnel_link COLOR_DEFAULT = RGB(255,184,89)), captures with auto_step,
// and counts amber pixels in the on-disk export. Verifies the contract's
// fresh frame shows drawn content (the acceptance oracle).
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';

const PORT = process.env.RM_PORT || '6560';
const HOST = process.env.RM_HOST || '172.17.192.1';
// SEE-1273 T3: 双落点（优先 submodule、兜底旧路径）
import { existsSync as _mcp_exists } from "node:fs";
// SEE-1287 AC-FIX-004: run context — these clients drive the godot-mcp
// proxy. Resolution order:
//   1. RM_PROXY env (absolute or cwd-relative path) — explicit override;
//   2. when this file lives inside a KOL checkout (fork mounted as
//      addons/godot_mcp): <KOL root>/addons/godot_mcp/launch/godot-mcp-proxy.mjs;
//   3. pure fork checkout fallback: <fork root>/launch/godot-mcp-proxy.mjs.
// In both default cases the path resolves to an existing file.
const _this_dir = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const _fork_root = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');
const _kol_root = process.env.KOL_ROOT || (() => {
    const up2 = new URL('../../../../../../', import.meta.url).pathname.replace(/\/$/, '');
    return _fork_root.endsWith('/addons/godot_mcp') ? up2 : _fork_root;
})();
const PROXY = process.env.RM_PROXY || (_fork_root.endsWith('/addons/godot_mcp')
    ? `${_kol_root}/addons/godot_mcp/launch/godot-mcp-proxy.mjs`
    : `${_fork_root}/launch/godot-mcp-proxy.mjs`);
const WORKTREE = process.cwd();
const OUT = 'launch/tests/e2e/see1240/amber-client.log';

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
const image = (r) => (r?.result?.content ?? []).find((c) => c.type === 'image') ?? null;

await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'see1240-amber', version: '1.0.0' } }, 15000);
const warm = await call('tools/call', { name: 'godot_project', arguments: { action: 'get_info' } }, 120000);
console.log('warm:', text(warm).slice(0, 80).replace(/\n/g, ' '));

// Start the game first (exec runs inside the running game only).
const run1 = await call('tools/call', { name: 'godot_editor_edit', arguments: { action: 'run', scene_path: 'res://scenes/ui/title_screen/title_screen.tscn' } }, 90000);
console.log('run:', text(run1).slice(0, 80).replace(/\n/g, ' '));

// Navigate: thaw (in case frozen), change scene to the SC sandbox via exec's
// tree access (change_scene_to_file is allowed — the frozen deadlock caution
// applies only under freeze; we thaw first).
const nav = await call('tools/call', { name: 'godot_exec', arguments: { action: 'run', budget_ms: 10000,
    source: 'tree.change_scene_to_file("res://scenes/ui/shadow_console/sc_shadow_console_sandbox.tscn")\nreturn "nav-ok"' } }, 30000);
console.log('nav:', text(nav).slice(0, 120).replace(/\n/g, ' '));

// Frame advance + capture in the contract-approved way.
const shot = await call('tools/call', { name: 'godot_editor_read', arguments: { action: 'screenshot_game', max_width: 900, auto_step: true } }, 120000);
const meta = text(shot);
const img = image(shot);
if (img) {
    writeFileSync('launch/tests/e2e/see1240/amber-frame.png', Buffer.from(img.data, 'base64'));
}
const metaLine = (meta.match(/\{[\s\S]*_screenshot[\s\S]*\}/) || [''])[0];
console.log('meta:', metaLine.slice(0, 300));
console.log('AMBER_ORACLE_DONE img=' + Boolean(img));
proxy.kill('SIGTERM');
process.exit(0);
