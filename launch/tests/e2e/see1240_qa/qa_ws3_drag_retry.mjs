#!/usr/bin/env node
// SEE-1240 QA (Revy) — R6 drag 原语合同复测（数组坐标形态 + malformed 拒绝 + 事件展开计数）。
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { appendFileSync } from 'node:fs';

const PORT = process.env.QA_PORT || '6555';
const HOST = process.env.QA_HOST || '172.17.192.1';
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
const OUT = 'launch/tests/e2e/see1240_qa/qa-drag2.log';

const proxy = spawn('node', [PROXY], {
    env: { ...process.env, GODOT_HOST: HOST, GODOT_PORT: PORT, KOL_WORKTREE: WORKTREE,
        KOL_PROJECT_GODOT: `${WORKTREE}/project.godot`, KOL_AGENT_NAME: 'Revy',
        KOL_WARMUP_TIMEOUT_MS: '90000', KOL_FAILED_EXIT_MS: '180000' },
    stdio: ['pipe', 'pipe', 'pipe'],
});
proxy.stderr.on('data', (c) => { try { appendFileSync(OUT, `[proxy-err] ${c}`); } catch {} });
let nextId = 1;
const pending = new Map();
const rl = readline.createInterface({ input: proxy.stdout, terminal: false, crlfDelay: Infinity });
rl.on('line', (line) => {
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
const ok = (n) => { pass++; console.log(`  [PASS] ${n}`); };
const ko = (n) => { fail++; console.log(`  [FAIL] ${n}`); };

const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'see1240-qa-drag', version: '1.0.0' } }, 120000);
if (!init || init.timedOut || !init.result) { console.log('FATAL: no init'); proxy.kill('SIGTERM'); process.exit(2); }
try { proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); } catch {}

const warm = await call('tools/call', { name: 'godot_project', arguments: { action: 'get_info' } }, 120000);
console.log('warm:', text(warm).slice(0, 60).replace(/\n/g, ' '));
if (!text(warm) || text(warm).startsWith('Error:')) { proxy.kill('SIGTERM'); process.exit(2); }

// 1) 合法 drag（数组坐标合同 from:[x,y] to:[x,y]）→ 期望执行并展开 4 events
const good = await call('tools/call', { name: 'godot_input', arguments: { action: 'sequence', inputs: [ { drag: { from: [200, 200], to: [400, 300] } } ] } }, 90000);
const goodText = text(good);
console.log('good drag resp:', goodText.slice(0, 200).replace(/\n/g, ' '));
if (!good?.error && goodText && !goodText.startsWith('Error:')) {
    ok('R6a: 数组坐标 drag 执行');
    const evCount = (goodText.match(/mouse|press|release|motion|button/gi) || []).length;
    console.log(`  [note] 事件词汇计数≈${evCount}`);
    if (evCount >= 4) ok('R6b: drag 展开为多事件序列（≥4 事件词汇）'); else ko('R6b: 事件展开不足');
} else ko(`R6a: 数组坐标 drag 被拒 (${(good?.error?.message || goodText).slice(0, 100)})`);

// 2) malformed drag（缺 to）→ 期望 JSON-RPC -32602 拒绝
const bad = await call('tools/call', { name: 'godot_input', arguments: { action: 'sequence', inputs: [ { drag: { from: [1, 1] } } ] } }, 60000);
if (bad?.error && bad.error.code === -32602) ok('R6c: malformed drag 以 -32602 具名拒绝'); else ko('R6c: malformed drag 未按 -32602 拒绝');
if (bad?.error && !text(bad)) ok('R6d: malformed 不透传到 fork（in-band 拒绝）'); else ko('R6d: malformed 可能透传');

// 3) drag + waypoint 扩展形态（合同可选字段）
const wp = await call('tools/call', { name: 'godot_input', arguments: { action: 'sequence', inputs: [ { drag: { from: [100, 100], to: [300, 200], waypoints: [[200, 150]] } } ] } }, 90000);
if (!wp?.error && text(wp) && !text(wp).startsWith('Error:')) ok('R6e: waypoints 扩展形态执行'); else ko(`R6e: waypoints 形态被拒 (${(wp?.error?.message || text(wp)).slice(0, 80)})`);

proxy.kill('SIGTERM');
console.log(`\nR6 drag 复测: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
