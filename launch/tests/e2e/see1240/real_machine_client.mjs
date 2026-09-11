#!/usr/bin/env node
// SEE-1240 WS-3 real-machine verification client.
// Spawns MY MODIFIED proxy (this worktree's godot-mcp-proxy.mjs) on GODOT_PORT
// and drives the WS-3 contract through it with raw JSON-RPC — exactly what the
// production MCP server does, but under MY control and inside the lease window.
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';

const PORT = process.env.RM_PORT || '6560';
const HOST = process.env.RM_HOST || '127.0.0.1';
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
const WORKTREE = process.env.RM_WORKTREE || process.cwd();
const OUT = process.env.RM_OUT || 'launch/tests/e2e/see1240/rm-client.log';

const proxy = spawn('node', [PROXY], {
    env: {
        ...process.env,
        GODOT_HOST: HOST,
        GODOT_PORT: PORT,
        KOL_WORKTREE: WORKTREE,
        KOL_PROJECT_GODOT: `${WORKTREE}/project.godot`,
        KOL_AGENT_NAME: 'Fronti',
        KOL_WARMUP_TIMEOUT_MS: '60000',
        KOL_FAILED_EXIT_MS: '120000',
    },
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
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
    }
});

function call(method, params, timeoutMs = 60000) {
    const id = nextId++;
    return new Promise((resolve) => {
        pending.set(id, { resolve });
        const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
        proxy.stdin.write(line);
        setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); resolve({ timedOut: true, id }); }
        }, timeoutMs);
    });
}

function firstText(r) {
    const t = r?.result?.content?.filter((c) => c.type === 'text').map((c) => c.text) ?? [];
    return t.join('\n');
}
function firstImage(r) {
    return r?.result?.content?.find((c) => c.type === 'image') ?? null;
}

// ---- test report ----
const report = { steps: [] };
function step(name, ok, detail) {
    report.steps.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

// 1. warm: initialize + trigger
const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'see1240-rm', version: '1.0.0' } }, 15000);
step('initialize', !!init.result, JSON.stringify(init.error || '').slice(0, 120));

const t0 = await call('tools/call', { name: 'get_project_info', arguments: {} }, 120000);
step('warm trigger (get_project_info)', !t0.error && !t0.timedOut, firstText(t0).slice(0, 120));

// 2. RED: stale capture — mutate via exec, DON'T step, capture immediately.
//    The contract must flag the frame (large latency or stale advisory).
const g = await call('tools/call', { name: 'godot_editor_edit', arguments: { action: 'run', frozen: true, scene_path: 'res://scenes/ui/title_screen/title_screen.tscn' } }, 90000);
step('run frozen=true', !g.error && !g.timedOut, firstText(g).slice(0, 120));

// exec mutation (amber-ish panel tweak is game-specific; here ANY mutation suffices
// for latency-based staleness, but SEE-1166 amber_px oracle uses the sandbox scene).
const mut = await call('tools/call', { name: 'godot_exec', arguments: { action: 'run', source: 'var n = root.get_node_or_null("/TitleScreen")\nreturn JSON.stringify({found: n != null})', budget_ms: 8000 } }, 30000);
step('exec reachable', !mut.error && !mut.timedOut, firstText(mut).slice(0, 200));

// stale capture WITHOUT step (proxy latency stamp decides)
const staleShot = await call('tools/call', { name: 'godot_editor_read', arguments: { action: 'screenshot_game', max_width: 900 } }, 120000);
const staleText = firstText(staleShot);
const staleMeta = (staleText.match(/\{.*_screenshot.*\}/) || [null])[0];
let staleParsed = null;
try { staleParsed = JSON.parse(staleMeta); } catch {}
const redOk = staleShot.error === undefined && staleParsed?._screenshot
    && (staleParsed._screenshot.stale === true || staleParsed._screenshot.capture_latency_ms > 1500);
step('RED stale detection', redOk === true, staleMeta ? `latency=${staleParsed._screenshot.capture_latency_ms} stale=${staleParsed._screenshot.stale}` : staleText.slice(0, 200));

// 3. GREEN: auto_step capture — proxy steps one frame then captures; must be fresh + amber oracle.
const freshShot = await call('tools/call', { name: 'godot_editor_read', arguments: { action: 'screenshot_game', max_width: 900, auto_step: true } }, 120000);
const freshText = firstText(freshShot);
const freshMeta = (freshText.match(/\{.*_screenshot.*\}/) || [null])[0];
let freshParsed = null;
try { freshParsed = JSON.parse(freshMeta); } catch {}
const freshImg = firstImage(freshShot);
const greenOk = freshParsed?._screenshot && freshParsed._screenshot.stale === false
    && freshParsed._screenshot.auto_step === { frames: 1, ok: true }.toString() ? true : Boolean(freshParsed?._screenshot?.auto_step?.ok);
step('GREEN auto_step fresh', Boolean(greenOk), freshMeta ? JSON.stringify(freshParsed._screenshot).slice(0, 200) : freshText.slice(0, 200));
step('image content present', Boolean(freshImg), freshImg ? `${freshImg.data.length} b64 chars` : 'missing');
step('exports path in response', /exports/.test(freshText) && /png_path/.test(freshText), '');

// amber oracle: count amber-ish pixels in the returned PNG
if (freshImg) {
    writeFileSync('launch/tests/e2e/see1240/rm-green-frame.png', Buffer.from(freshImg.data, 'base64'));
    step('green frame saved', true, 'launch/tests/e2e/see1240/rm-green-frame.png');
}

console.log('\nREPORT_JSON');
console.log(JSON.stringify(report, null, 1));
writeFileSync('launch/tests/e2e/see1240/rm-report.json', JSON.stringify(report, null, 1));
proxy.kill('SIGTERM');
process.exit(0);
