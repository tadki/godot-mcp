#!/usr/bin/env node
// SEE-1328 阶段二 B-hardener — 截图链路新增面判别力审计对抗性用例
// （补 §SPEC-014/015 单测部分/§SPEC-016 现有 18 用例测不出的分支与边界）。
// Run:
//   node --test --test-reporter=junit launch/tests/scripts/test_see1328_b_screenshot_link_hardener.mjs
//
// 审计口径："默认代码是错误的"——每用例钉死一个既有套件未覆盖的分支：
//   HK1-HK6  isScreenshotToolsCall 键控边界（null 帧、inputs 非数组、元素混合
//            null、arguments 缺失、startsWith 分支、畸形消息）
//   HM1-HM2  screenshotCaptureMode 显式 false 与 3×2 完备矩阵
//   HR1-HR3  resolveStaleCaptureMs 容错（env=null / 前导零 / 超大整数）+
//            frameAgeVerdict 默认阈值接线 process.env 的真实分支
//   HF1-HF2  augmentScreenshotError 容错（无 message / data 非对象）

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.resolve(HERE, '..', '..', 'proxy', 'screenshot.mjs'); // SEE-1334 Phase 0a: 截图契约函数落在 proxy/screenshot.mjs
const src = fs.readFileSync(PROXY, 'utf8');

function extractFunction(name) {
    const fnStart = src.indexOf(`function ${name}`);
    if (fnStart === -1) throw new Error(`function ${name} not found in proxy`);
    const closeParen = src.indexOf(')', fnStart);
    if (closeParen === -1) throw new Error(`function ${name} has no parameter close paren`);
    let depth = 0, fnEnd = -1;
    for (let i = src.indexOf('{', closeParen); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
    }
    return src.slice(fnStart, fnEnd);
}

function bindIsScreenshotToolsCall() {
    return (new Function(`\n${extractFunction('isScreenshotToolsCall')}\nreturn isScreenshotToolsCall;`))();
}
function bindAugmentScreenshotError() {
    const hintMatch = src.match(/const SCREENSHOT_FALLBACK_HINT =[\s\S]*?;\n/);
    const fnBody = extractFunction('augmentScreenshotError');
    return (new Function(`\n${hintMatch[0]}\n${fnBody}\nreturn augmentScreenshotError;`))();
}
function bindScreenshotCaptureMode() {
    return (new Function(`\n${extractFunction('screenshotCaptureMode')}\nreturn screenshotCaptureMode;`))();
}

const { resolveStaleCaptureMs, DEFAULT_STALE_CAPTURE_MS, frameAgeVerdict } =
    await import(path.resolve(HERE, '..', '..', 'see1240-screenshot-contract.mjs'));

// ---- HK: 键控边界 ---------------------------------------------------------------
test('HK1 键控：screenshot_at_ms:null 视为帧条目命中（钉死现行为；LOW 观察见报告）', () => {
    const isCall = bindIsScreenshotToolsCall();
    assert.equal(isCall({
        params: { name: 'godot_input', arguments: { inputs: [{ screenshot_at_ms: null }] } },
    }), true, 'current semantics: any defined screenshot_at_ms key counts as a frame (typeof !== undefined)');
});

test('HK2 键控：inputs 非数组（对象/字符串）→ 不误伤不崩溃', () => {
    const isCall = bindIsScreenshotToolsCall();
    assert.equal(isCall({ params: { name: 'godot_input', arguments: { inputs: { 0: { screenshot_at_ms: [1] } } } } }), false);
    assert.equal(isCall({ params: { name: 'godot_input', arguments: { inputs: 'screenshot_at_ms' } } }), false);
});

test('HK3 键控：inputs 混入 null 元素 → 守卫生效且真实帧仍命中', () => {
    const isCall = bindIsScreenshotToolsCall();
    assert.equal(isCall({
        params: { name: 'godot_input', arguments: { inputs: [null, false, { mouse_move: [1, 1] }, { screenshot_at_ms: [50] }] } },
    }), true);
    assert.equal(isCall({ params: { name: 'godot_input', arguments: { inputs: [null, false] } } }), false);
});

test('HK4 键控：godot_input arguments 缺失/null → false（不抛 TypeError）', () => {
    const isCall = bindIsScreenshotToolsCall();
    assert.equal(isCall({ params: { name: 'godot_input' } }), false);
    assert.equal(isCall({ params: { name: 'godot_input', arguments: null } }), false);
});

test('HK5 键控：startsWith("screenshot_") 前缀分支（screenshot_editor 形态）', () => {
    const isCall = bindIsScreenshotToolsCall();
    assert.equal(isCall({ params: { name: 'screenshot_editor' } }), true);
    assert.equal(isCall({ params: { name: 'screenshots' } }), false, 'prefix must be exact "screenshot_"');
});

test('HK6 键控：畸形消息（无 params / params 无 name / name 非字符串）→ false', () => {
    const isCall = bindIsScreenshotToolsCall();
    assert.equal(isCall({}), false);
    assert.equal(isCall({ params: {} }), false);
    assert.equal(isCall({ params: { name: 42 } }), false);
});

// ---- HM: 两态三值完备矩阵 --------------------------------------------------------
test('HM1 两态：显式 autoStepRequested:false → enrich（非 bypass）', () => {
    const mode = bindScreenshotCaptureMode();
    assert.equal(mode({ warm: true, transportReady: true, autoStepRequested: false }), 'enrich');
});

test('HM2 两态：warm/transportReady × autoStepRequested 六组合完备矩阵', () => {
    const mode = bindScreenshotCaptureMode();
    const m = (w, t, a) => mode({ warm: w, transportReady: t, autoStepRequested: a });
    assert.equal(m(true, true, false), 'enrich');
    assert.equal(m(true, true, true), 'auto_step');
    assert.equal(m(false, true, false), 'bypass');
    assert.equal(m(false, true, true), 'bypass');
    assert.equal(m(true, false, false), 'bypass');
    assert.equal(m(true, false, true), 'bypass');
});

// ---- HR: 参数化容错 + env 默认接线 -----------------------------------------------
test('HR1 resolveStaleCaptureMs：env=null / env 缺键 → 默认（API 容错不抛）', () => {
    assert.equal(resolveStaleCaptureMs(null), DEFAULT_STALE_CAPTURE_MS);
    assert.equal(resolveStaleCaptureMs(undefined), DEFAULT_STALE_CAPTURE_MS);
    assert.equal(resolveStaleCaptureMs({ OTHER: '3000' }), DEFAULT_STALE_CAPTURE_MS);
});

test('HR2 resolveStaleCaptureMs：前导零合法（"01500"→1500）；严格十进制拒绝 0x/+号', () => {
    assert.equal(resolveStaleCaptureMs({ GODOT_MCP_STALE_CAPTURE_MS: '01500' }), 1500);
    assert.equal(resolveStaleCaptureMs({ GODOT_MCP_STALE_CAPTURE_MS: '0x10' }), DEFAULT_STALE_CAPTURE_MS);
    assert.equal(resolveStaleCaptureMs({ GODOT_MCP_STALE_CAPTURE_MS: '+50' }), DEFAULT_STALE_CAPTURE_MS);
});

test('HR3 frameAgeVerdict 默认阈值接线 process.env（真实分支，非显式 thresholdMs）', () => {
    process.env.GODOT_MCP_STALE_CAPTURE_MS = '5000';
    try {
        const wired = frameAgeVerdict({ latencyMs: 2000 });
        assert.equal(wired.thresholdMs, 5000);
        assert.equal(wired.stale, false, '2000ms under a 5000ms env threshold must be fresh');
        const over = frameAgeVerdict({ latencyMs: 6000 });
        assert.equal(over.stale, true);
        assert.equal(over.thresholdMs, 5000);
    } finally {
        delete process.env.GODOT_MCP_STALE_CAPTURE_MS;
    }
    const fallback = frameAgeVerdict({ latencyMs: 2000 });
    assert.equal(fallback.thresholdMs, DEFAULT_STALE_CAPTURE_MS, 'without env, default 1500 applies');
    assert.equal(fallback.stale, true);
});

// ---- HF: fallback hint 容错 ------------------------------------------------------
test('HF1 augmentScreenshotError：error 无 message → hint 文本独立成 message', () => {
    const augment = bindAugmentScreenshotError();
    const out = augment({ code: -32001 });
    assert.ok(out.message.includes('addons/godot_mcp/launch/screenshot-fallback.sh'));
    assert.equal(out.data.screenshotFallback, 'addons/godot_mcp/launch/screenshot-fallback.sh');
});

test('HF2 augmentScreenshotError：data 非对象 → 整体替换为 {screenshotFallback}（不崩不污染）', () => {
    const augment = bindAugmentScreenshotError();
    const out = augment({ message: 'x', data: 'not-an-object' });
    assert.deepEqual(out.data, { screenshotFallback: 'addons/godot_mcp/launch/screenshot-fallback.sh' });
    const out2 = augment({ message: 'y', data: null });
    assert.deepEqual(out2.data, { screenshotFallback: 'addons/godot_mcp/launch/screenshot-fallback.sh' });
});

// ---- 观察项钉死：STALE env 无上限（opt-in 语义，LOW 观察不判缺陷）----------------
test('HR4 观察钉死：STALE env 超大整数按字面生效（opt-in 无上限，报告列观察）', () => {
    assert.equal(resolveStaleCaptureMs({ GODOT_MCP_STALE_CAPTURE_MS: '999999999999' }), 999999999999);
});
