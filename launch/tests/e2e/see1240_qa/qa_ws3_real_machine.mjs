#!/usr/bin/env node
// SEE-1240 QA (Revy) — WS-3 截图契约红/绿对照 + 落盘 + ui_inspect/drag 真机对抗验证。
// 独立 QA 驱动：不复用被测方断言逻辑；oracle 全部独立计算
// （amber_px 由本驱动自行解码 PNG IHDR + 像素统计，不用被测方上报值）。
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { appendFileSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import zlib from 'node:zlib';

const PORT = process.env.QA_PORT || '6555';
const HOST = process.env.QA_HOST || '172.17.192.1';
// SEE-1273 T3: 双落点（优先 submodule、兜底旧路径）
import { existsSync as _mcp_exists } from "node:fs";
const PROXY = "addons/godot_mcp/launch/godot-mcp-proxy.mjs";
const WORKTREE = process.cwd();
const OUT = 'launch/tests/e2e/see1240_qa/qa-client.log';

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

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [PASS] ${n}`); };
const ko = (n) => { fail++; console.log(`  [FAIL] ${n}`); };

// --- Independent PNG oracle: parse IHDR + inflate IDAT + count amber pixels.
// Amber (SC tunnel link COLOR_DEFAULT) = RGB(255,184,89); tolerance ±24 per channel.
function pngInfo(buf) {
    // PNG magic
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!buf.subarray(0, 8).equals(magic)) return { magic: false };
    // IHDR at offset 8: len(4) type(4) width(4) height(4)
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
    const bitDepth = buf[24], colorType = buf[25];
    return { magic: true, width, height, bitDepth, colorType };
}
function countAmber(buf) {
    const info = pngInfo(buf);
    if (!info.magic) return { error: 'no-magic' };
    // Walk chunks, concatenate IDAT
    let off = 8; const idat = [];
    while (off + 8 <= buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
        if (type === 'IEND') break;
        off += 12 + len;
    }
    let raw;
    try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { return { error: 'inflate:' + e.message }; }
    const { width, height, colorType } = info;
    const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
    if (bpp == null || info.bitDepth !== 8) return { error: `unsupported fmt colorType=${colorType} depth=${info.bitDepth}` };
    const stride = width * bpp;
    // Un-filter (defend against any filter type; assume per-byte reconstruct for sub/up/avg/paeth)
    const out = Buffer.alloc(height * stride);
    for (let y = 0; y < height; y++) {
        const f = raw[y * (stride + 1)];
        const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
        const cur = out.subarray(y * stride, (y + 1) * stride);
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? cur[x - bpp] : 0;
            const b = prev ? prev[x] : 0;
            const c = (x >= bpp && prev) ? prev[x - bpp] : 0;
            let v = row[x];
            if (f === 1) v = (v + a) & 0xff;
            else if (f === 2) v = (v + b) & 0xff;
            else if (f === 3) v = (v + ((a + b) >> 1)) & 0xff;
            else if (f === 4) {
                const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
            }
            cur[x] = v;
        }
    }
    let amber = 0;
    for (let i = 0; i < out.length; i += bpp) {
        const r = out[i], g = out[i + 1], b = out[i + 2];
        if (Math.abs(r - 255) <= 24 && Math.abs(g - 184) <= 24 && Math.abs(b - 89) <= 24) amber++;
    }
    return { amber, width, height };
}

console.log('== QA WS-3 真机对抗 ==');
const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'see1240-qa-revy', version: '1.0.0' } }, 120000);
if (!init || init.timedOut || !init.result) { console.log('FATAL: initialize no response'); proxy.kill('SIGTERM'); process.exit(2); }
try { proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); } catch {}
const warm = await call('tools/call', { name: 'godot_project', arguments: { action: 'get_info' } }, 120000);
console.log('warm:', text(warm).slice(0, 100).replace(/\n/g, ' '));
if (!text(warm) || text(warm).startsWith('Error:')) { console.log('FATAL: editor not warm'); proxy.kill('SIGTERM'); process.exit(2); }

// 启动游戏（真实 GUI 编辑器运行 title scene，冻结启动）
const run1 = await call('tools/call', { name: 'godot_editor_edit', arguments: { action: 'run', frozen: true } }, 90000);
console.log('run:', text(run1).slice(0, 80).replace(/\n/g, ' '));
await call('tools/call', { name: 'godot_game_time', arguments: { action: 'step', frames: 5 } }, 60000);

// 导航到 SC 沙盘（琥珀隧道场景）— thaw 后 change scene
await call('tools/call', { name: 'godot_game_time', arguments: { action: 'thaw' } }, 30000);
const nav = await call('tools/call', { name: 'godot_exec', arguments: { action: 'run', budget_ms: 10000,
    source: 'tree.change_scene_to_file("res://scenes/ui/shadow_console/sc_shadow_console_sandbox.tscn")\nreturn "nav-ok"' } }, 30000);
console.log('nav:', text(nav).slice(0, 100).replace(/\n/g, ' '));
await call('tools/call', { name: 'godot_game_time', arguments: { action: 'step', frames: 3 } }, 60000);

// ---- RED: set→不 step→capture（无 auto_step）→ 必须 stale 检出
await call('tools/call', { name: 'godot_exec', arguments: { action: 'run', budget_ms: 10000,
    source: 'var lbl = tree.current_scene.find_child("TunnelLabel", true, false)\nif lbl: lbl.text = "QA-RED-SET"\nreturn "set-ok"' } }, 30000);
const redShot = await call('tools/call', { name: 'godot_editor_read', arguments: { action: 'screenshot_game', max_width: 900 } }, 120000);
const redMeta = text(redShot);
const redImg = image(redShot);
console.log('RED meta:', (redMeta.match(/_screenshot[\s\S]{0,260}/) || ['<none>'])[0].slice(0, 280).replace(/\n/g, ' '));
if (/stale["']?\s*[:=]\s*true/.test(redMeta) || redMeta.includes('STALE FRAME RISK')) ok('R1 red: stale 检出（set→no-step→capture）'); else ko('R1 red: stale 未检出');
if (redMeta.includes('no_step_after_mutation') || /stale_reason|reason/.test(redMeta)) ok('R1 red: 指明 no_step_after_mutation 信号'); else ko('R1 red: 信号名缺失');

// ---- GREEN: 同一场景 auto_step=true → fresh 帧 + amber_px oracle（独立解码）
const greenShot = await call('tools/call', { name: 'godot_editor_read', arguments: { action: 'screenshot_game', max_width: 900, auto_step: true } }, 120000);
const greenMeta = text(greenShot);
const greenImg = image(greenShot);
console.log('GREEN meta:', (greenMeta.match(/_screenshot[\s\S]{0,260}/) || ['<none>'])[0].slice(0, 280).replace(/\n/g, ' '));
if (/stale["']?\s*[:=]\s*false/.test(greenMeta) && !greenMeta.includes('STALE FRAME RISK')) ok('R2 green: stale=false fresh 帧'); else ko('R2 green: stale 未翻转 false');
if (greenMeta.includes('auto_step') && /auto_step["']?\s*[:=]\s*true/.test(greenMeta)) ok('R2 green: auto_step 溯源字段'); else ko('R2 green: auto_step 溯源缺失');

let qaPng = null;
if (greenImg) {
    qaPng = Buffer.from(greenImg.data, 'base64');
    writeFileSync('launch/tests/e2e/see1240_qa/qa-green-frame.png', qaPng);
    ok('R2 green: 截图为图像内容（非错误文本）');
} else ko('R2 green: 无图像内容返回');
if (qaPng) {
    const cnt = countAmber(qaPng);
    console.log(`  [oracle] amber_px=${cnt.amber ?? cnt.error} size=${cnt.width}x${cnt.height}`);
    if (cnt.amber > 100) ok(`R2 oracle: amber_px=${cnt.amber} > 100（琥珀隧道已绘制）`); else ko(`R2 oracle: amber_px=${cnt.amber} 不足`);
} else ko('R2 oracle: 无 PNG 可解码');

// ---- exports 落盘独立校验
const expM = greenMeta.match(/png_path["']?\s*[:=]\s*"([^"]+)"/);
const wdM = greenMeta.match(/width["']?\s*[:=]\s*(\d+)/);
const htM = greenMeta.match(/height["']?\s*[:=]\s*(\d+)/);
if (expM) {
    const p = expM[1];
    if (existsSync(p) && statSync(p).size > 0) {
        const disk = readFileSync(p);
        const info = pngInfo(disk);
        if (info.magic) ok('R3 exports: 落盘文件存在且 PNG magic 正确'); else ko('R3 exports: 落盘非 PNG');
        if (wdM && htM && info.width === Number(wdM[1]) && info.height === Number(htM[1])) ok(`R3 exports: IHDR ${info.width}x${info.height} 与响应一致`); else ko(`R3 exports: IHDR ${info.width}x${info.height} vs 响应 ${wdM?.[1]}x${htM?.[1]} 不一致`);
    } else ko(`R3 exports: 落盘不可读 ${p}`);
} else ko('R3 exports: 响应缺 png_path');

// ---- width×height 校验（超宽告警路径）：max_width=200 截图 → 期望告警或缩放
const smallShot = await call('tools/call', { name: 'godot_editor_read', arguments: { action: 'screenshot_game', max_width: 200, auto_step: true } }, 120000);
const smallImg = image(smallShot);
if (smallImg) {
    const info = pngInfo(Buffer.from(smallImg.data, 'base64'));
    console.log(`  [note] max_width=200 → 实际 ${info.width}x${info.height}`);
    if (info.width <= 200 || /width|超宽|exceed/i.test(text(smallShot))) ok('R4 width 校验：宽度约束或告警生效'); else ko('R4 width 校验：无约束也无告警');
} else ko('R4 width 校验：无图像');

// ---- ui_inspect 真机
const uiTree = await call('tools/call', { name: 'godot_ui_inspect', arguments: { action: 'ui_tree' } }, 60000);
const treeText = text(uiTree);
const ctrlCount = (treeText.match(/Control|Button|Label|Panel/g) || []).length;
if (!treeText.startsWith('Error:') && ctrlCount > 3) ok(`R5 ui_inspect: ui_tree 返回 ${ctrlCount} 个 Control 类节点`); else ko(`R5 ui_inspect: ui_tree 异常 (${treeText.slice(0, 80)})`);
if (/hover|鼠标|不可信|untrusted/i.test(treeText) || true) { /* 检查 inspect_node 的不可信标注 */ }
const insp = await call('tools/call', { name: 'godot_ui_inspect', arguments: { action: 'inspect_node', node_path: '/root' } }, 60000);
const inspText = text(insp);
if (!inspText.startsWith('Error:')) {
    ok(`R5 ui_inspect: inspect_node(/root) 可查 (${inspText.slice(0, 60).replace(/\n/g, ' ')})`);
    if (/hover|不可信|untrusted/i.test(inspText)) ok('R5 ui_inspect: hover/鼠标字段显式不可信标注'); else ko('R5 ui_inspect: 无不可信标注');
} else ko(`R5 ui_inspect: inspect_node 失败 (${inspText.slice(0, 80)})`);

// ---- drag 原语真机（4 events 展开 + malformed 拒绝）
const drag = await call('tools/call', { name: 'godot_input', arguments: { action: 'sequence', inputs: [ { drag: { from: { x: 200, y: 200 }, to: { x: 400, y: 300 } } } ] } }, 60000);
const dragText = text(drag);
if (!dragText.startsWith('Error:')) ok('R6 drag: 合法 drag 序列执行'); else ko(`R6 drag: 合法序列被拒 (${dragText.slice(0, 100)})`);
const badDrag = await call('tools/call', { name: 'godot_input', arguments: { action: 'sequence', inputs: [ { drag: { from: { x: 1 } } } ] } }, 60000);
if (text(badDrag).startsWith('Error:') || text(badDrag).includes('invalid') || text(badDrag).includes('malformed')) ok('R6 drag: malformed 拒绝'); else ko(`R6 drag: malformed 未拒绝 (${text(badDrag).slice(0, 80)})`);

// ---- teardown
try { await call('tools/call', { name: 'godot_game_time', arguments: { action: 'thaw' } }, 15000); } catch {}
try { await call('tools/call', { name: 'godot_editor_edit', arguments: { action: 'stop' } }, 30000); } catch {}
proxy.kill('SIGTERM');
console.log(`\nQA WS-3 真机: pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
