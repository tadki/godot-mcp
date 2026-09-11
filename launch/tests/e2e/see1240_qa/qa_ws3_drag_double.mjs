#!/usr/bin/env node
// SEE-1240 QA drag stability double-run
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { existsSync as _mcp_exists } from "node:fs";
const PORT = '6555', HOST = '172.17.192.1';
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
const proxy = spawn('node', [PROXY], { env: { ...process.env, GODOT_HOST: HOST, GODOT_PORT: PORT,
  KOL_WORKTREE: process.cwd(), KOL_PROJECT_GODOT: `${process.cwd()}/project.godot`, KOL_AGENT_NAME: 'Revy',
  KOL_WARMUP_TIMEOUT_MS: '90000', KOL_FAILED_EXIT_MS: '180000' }, stdio: ['pipe', 'pipe', 'pipe'] });
let nextId = 1; const pending = new Map();
readline.createInterface({ input: proxy.stdout, terminal: false, crlfDelay: Infinity }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && pending.has(m.id)) { const { resolve } = pending.get(m.id); pending.delete(m.id); resolve(m); }
});
function call(method, params, timeoutMs = 90000) { const id = nextId++; return new Promise((resolve) => {
  pending.set(id, { resolve }); proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ timedOut: true, id }); } }, timeoutMs); }); }
const text = (r) => (r?.result?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'qa-drag4', version: '1.0.0' } }, 120000);
if (!init || init.timedOut || !init.result) { console.log('FATAL init'); proxy.kill('SIGTERM'); process.exit(2); }
try { proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); } catch {}
const warm = await call('tools/call', { name: 'godot_project', arguments: { action: 'get_info' } }, 120000);
console.log('warm:', text(warm).slice(0, 50).replace(/\n/g, ' '));
if (!text(warm) || text(warm).startsWith('Error:')) { proxy.kill('SIGTERM'); process.exit(2); }
const run = await call('tools/call', { name: 'godot_editor_edit', arguments: { action: 'run', frozen: false } }, 90000);
console.log('run:', text(run).slice(0, 60).replace(/\n/g, ' '));
await new Promise(r => setTimeout(r, 4000));
const nav = await call('tools/call', { name: 'godot_exec', arguments: { action: 'run', budget_ms: 10000, source: 'tree.change_scene_to_file("res://scenes/ui/shadow_console/sc_shadow_console_sandbox.tscn")\nreturn "ok"' } }, 30000);
console.log('nav:', text(nav).slice(0, 60).replace(/\n/g, ' '));
await new Promise(r => setTimeout(r, 1500));
const d1 = await call('tools/call', { name: 'godot_input', arguments: { action: 'sequence', inputs: [ { drag: { from: [200, 200], to: [400, 300] } } ] } }, 120000);
console.log('drag1:', text(d1).slice(0, 260).replace(/\n/g, ' '));
const d2 = await call('tools/call', { name: 'godot_input', arguments: { action: 'sequence', inputs: [ { drag: { from: [150, 250], to: [350, 150] } } ] } }, 120000);
console.log('drag2:', text(d2).slice(0, 260).replace(/\n/g, ' '));
try { await call('tools/call', { name: 'godot_editor_edit', arguments: { action: 'stop' } }, 30000); } catch {}
proxy.kill('SIGTERM');
