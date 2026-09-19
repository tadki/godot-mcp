#!/usr/bin/env node
// SEE-1328 阶段二 H3 / B-code — 截图链路验收补差（§SPEC-014 / §SPEC-015 单测部分）。
// Run:
//   node --test --test-reporter=junit launch/tests/scripts/test_see1328_b_screenshot_link.mjs
//
// 覆盖（TDD RED 先行，全部对准真实源码）：
//   §SPEC-014:
//   - isScreenshotToolsCall 键控扩展：godot_input 的 screenshot_at_ms 序列帧
//     路径（inputs[].screenshot_at_ms 与顶层 screenshot_at_ms）必须命中；
//     纯 drag / 纯 input 序列（无截图帧）不得误伤
//   - fallback hint 路径漂移：hint 文本与 data.screenshotFallback 必须指向
//     addons/godot_mcp/launch/screenshot-fallback.sh（post-T4 真实布局），
//     不得再指向已漂移的 .dev/godot-mcp/launch/...
//   - 死导入清理：proxy 不得再导入 TOOLS_LIST_APPENDIX_NOTE（ui-tools 侧
//     导出保留——防误删 SSOT）
//   - shim-placeholder 期 enrichment 绕过：screenshotCaptureMode 纯判定，
//     warm+transportReady → enrich/auto_step；placeholder 态（未 warm）→ bypass
//   §SPEC-015（单测部分）:
//   - GODOT_MCP_STALE_CAPTURE_MS 参数化（默认 1500；合法值生效；非法值回退默认）
//   - staleAdvisoryText 文案携带生效阈值
//   - DESCRIPTION_PATCHES godot_editor_read 通道注明 env 名与默认值

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.resolve(HERE, '..', '..', 'godot-mcp-proxy.mjs');
const src = fs.readFileSync(PROXY, 'utf8');

// 提取 proxy 内真实函数体（eval，不重实现——沿用 test_ac_m3reorg_011 模式）。
function extractFunction(name) {
    const fnStart = src.indexOf(`function ${name}`);
    if (fnStart === -1) throw new Error(`function ${name} not found in proxy`);
    let depth = 0, fnEnd = -1;
    for (let i = src.indexOf('{', fnStart); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
    }
    return src.slice(fnStart, fnEnd);
}

function bindIsScreenshotToolsCall() {
    const fnBody = extractFunction('isScreenshotToolsCall');
    return (new Function(`\n${fnBody}\nreturn isScreenshotToolsCall;`))();
}

function bindAugmentScreenshotError() {
    const hintMatch = src.match(/const SCREENSHOT_FALLBACK_HINT =[\s\S]*?;\n/);
    if (!hintMatch) throw new Error('SCREENSHOT_FALLBACK_HINT not found');
    const fnBody = extractFunction('augmentScreenshotError');
    return (new Function(`\n${hintMatch[0]}\n${fnBody}\nreturn augmentScreenshotError;`))();
}

function bindScreenshotCaptureMode() {
    const fnBody = extractFunction('screenshotCaptureMode');
    return (new Function(`\n${fnBody}\nreturn screenshotCaptureMode;`))();
}

// --- §SPEC-014.1: isScreenshotToolsCall 键控扩展 -------------------------------

test('§SPEC-014 isScreenshotToolsCall: godot_input screenshot_at_ms 序列帧命中（inputs[]）', () => {
    const isCall = bindIsScreenshotToolsCall();
    assert.equal(isCall({
        params: { name: 'godot_input', arguments: { inputs: [{ mouse_move: [10, 10] }, { screenshot_at_ms: [120, 480] }] } },
    }), true);
});

test('§SPEC-014 isScreenshotToolsCall: godot_input 顶层 screenshot_at_ms 命中', () => {
    const isCall = bindIsScreenshotToolsCall();
    assert.equal(isCall({
        params: { name: 'godot_input', arguments: { sequence: [], screenshot_at_ms: [300] } },
    }), true);
});

test('§SPEC-014 isScreenshotToolsCall: godot_input 无截图帧（纯 drag/序列）不误伤', () => {
    const isCall = bindIsScreenshotToolsCall();
    assert.equal(isCall({
        params: { name: 'godot_input', arguments: { inputs: [{ drag: { from: [0, 0], to: [9, 9] } }, { action_name: 'ui_accept' }] } },
    }), false);
    assert.equal(isCall({ params: { name: 'godot_input', arguments: {} } }), false);
});

test('§SPEC-014 isScreenshotToolsCall: 既有键控回归（screenshot*/editor_read action）不丢', () => {
    const isCall = bindIsScreenshotToolsCall();
    assert.equal(isCall({ params: { name: 'screenshot' } }), true);
    assert.equal(isCall({ params: { name: 'capture_game_screenshot' } }), true);
    assert.equal(isCall({ params: { name: 'godot_editor_read', arguments: { action: 'screenshot_game' } } }), true);
    assert.equal(isCall({ params: { name: 'godot_editor_read', arguments: { action: 'get_state' } } }), false);
    assert.equal(isCall({ params: { name: 'godot_exec', arguments: { action: 'run', source: 'pass' } } }), false);
});

// --- §SPEC-014.2: fallback hint 路径漂移 ----------------------------------------

test('§SPEC-014 SCREENSHOT_FALLBACK_HINT 指向 addons/godot_mcp/launch 真实布局', () => {
    assert.match(src, /addons\/godot_mcp\/launch\/screenshot-fallback\.sh/);
    assert.doesNotMatch(src, /\.dev\/godot-mcp\/launch\/screenshot-fallback\.sh/);
});

test('§SPEC-014 augmentScreenshotError 的 data.screenshotFallback 同步指向真实布局', () => {
    const augment = bindAugmentScreenshotError();
    const out = augment({ message: 'boom', data: { keep: 1 } });
    assert.equal(out.data.screenshotFallback, 'addons/godot_mcp/launch/screenshot-fallback.sh');
    assert.equal(out.data.keep, 1); // 原 data 保留
    assert.match(out.message, /^boom/); // 原错误消息保留（仅追加）
    assert.match(out.message, /addons\/godot_mcp\/launch\/screenshot-fallback\.sh/);
});

// --- §SPEC-014.3: 死导入清理 ------------------------------------------------------

test('§SPEC-014 proxy 不再死导入 TOOLS_LIST_APPENDIX_NOTE（ui-tools 导出保留）', () => {
    const importBlock = src.slice(src.indexOf("from './see1240-ui-tools.mjs'") - 1200, src.indexOf("from './see1240-ui-tools.mjs'"));
    assert.ok(importBlock.includes('DESCRIPTION_PATCHES')); // sanity: 抓对了 import 块
    assert.doesNotMatch(importBlock, /TOOLS_LIST_APPENDIX_NOTE/);
});

// --- §SPEC-014.4: shim-placeholder 期 enrichment 绕过（warm/placeholder 两态） ----

test('§SPEC-014 screenshotCaptureMode: warm+transportReady → enrich', () => {
    const mode = bindScreenshotCaptureMode();
    assert.equal(mode({ warm: true, transportReady: true }), 'enrich');
});

test('§SPEC-014 screenshotCaptureMode: warm+transportReady+auto_step → auto_step', () => {
    const mode = bindScreenshotCaptureMode();
    assert.equal(mode({ warm: true, transportReady: true, autoStepRequested: true }), 'auto_step');
});

test('§SPEC-014 screenshotCaptureMode: placeholder 态（未 warm）→ bypass（enrichment 绕过）', () => {
    const mode = bindScreenshotCaptureMode();
    assert.equal(mode({ warm: false, transportReady: false }), 'bypass');
    assert.equal(mode({ warm: false, transportReady: true }), 'bypass');
    assert.equal(mode({ warm: true, transportReady: false }), 'bypass');
});

// --- §SPEC-015（单测部分）: STALE_CAPTURE_MS 参数化 + DESCRIPTION_PATCHES ----------

test('§SPEC-015 resolveStaleCaptureMs: 默认 1500', async () => {
    const { resolveStaleCaptureMs, DEFAULT_STALE_CAPTURE_MS } = await import('../../../launch/see1240-screenshot-contract.mjs');
    assert.equal(DEFAULT_STALE_CAPTURE_MS, 1500);
    assert.equal(resolveStaleCaptureMs({}), 1500);
    assert.equal(resolveStaleCaptureMs({ GODOT_MCP_STALE_CAPTURE_MS: undefined }), 1500);
    assert.equal(resolveStaleCaptureMs({ GODOT_MCP_STALE_CAPTURE_MS: '' }), 1500);
});

test('§SPEC-015 resolveStaleCaptureMs: 合法 env 值生效（含边界 1）', async () => {
    const { resolveStaleCaptureMs } = await import('../../../launch/see1240-screenshot-contract.mjs');
    assert.equal(resolveStaleCaptureMs({ GODOT_MCP_STALE_CAPTURE_MS: '3000' }), 3000);
    assert.equal(resolveStaleCaptureMs({ GODOT_MCP_STALE_CAPTURE_MS: '1' }), 1);
});

test('§SPEC-015 resolveStaleCaptureMs: 非法值（NaN/0/负数/浮点/非数字）回退默认', async () => {
    const { resolveStaleCaptureMs, DEFAULT_STALE_CAPTURE_MS } = await import('../../../launch/see1240-screenshot-contract.mjs');
    for (const bad of ['abc', '0', '-5', '1.5', '12e2', ' 800 ']) {
        assert.equal(resolveStaleCaptureMs({ GODOT_MCP_STALE_CAPTURE_MS: bad }), DEFAULT_STALE_CAPTURE_MS, `bad value: ${JSON.stringify(bad)}`);
    }
});

test('§SPEC-015 frameAgeVerdict 尊重参数化阈值（3000ms 下 2000ms 延迟不判 stale）', async () => {
    const { frameAgeVerdict } = await import('../../../launch/see1240-screenshot-contract.mjs');
    assert.equal(frameAgeVerdict({ latencyMs: 2000, thresholdMs: 3000 }).stale, false);
    assert.equal(frameAgeVerdict({ latencyMs: 2000, thresholdMs: 1500 }).stale, true);
});

test('§SPEC-015 staleAdvisoryText 携带生效阈值而非硬编码默认', async () => {
    const { staleAdvisoryText } = await import('../../../launch/see1240-screenshot-contract.mjs');
    const text = staleAdvisoryText({ stale: true, latencyMs: 2400, reason: 'latency_over_threshold' });
    assert.match(text, /2400ms/);
    assert.match(text, /1500ms/); // 默认阈值下文案与默认一致
    const custom = staleAdvisoryText({ stale: true, latencyMs: 2400, reason: 'latency_over_threshold', thresholdMs: 5000 });
    assert.match(custom, /5000ms/);
});

test('§SPEC-015 DESCRIPTION_PATCHES godot_editor_read 通道注明 env 名与默认值', async () => {
    const { DESCRIPTION_PATCHES } = await import('../../../launch/see1240-ui-tools.mjs');
    const patch = DESCRIPTION_PATCHES.find((p) => p.tool === 'godot_editor_read');
    assert.ok(patch, 'godot_editor_read patch exists');
    assert.match(patch.replace, /GODOT_MCP_STALE_CAPTURE_MS/);
    assert.match(patch.replace, /1500/);
});
