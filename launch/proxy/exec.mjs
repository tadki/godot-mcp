// proxy/exec.mjs — godot_exec call classification, GDScript pitfall
// hints, str()-truncation detection (extracted from godot-mcp-proxy.mjs,
// SEE-1334 Phase 0a; the constraint SSOT lives in
// ../see1240-exec-constraints.mjs and is consumed by the router).

// SEE-1070 #8: detect a godot_exec tools/call so its responses can carry
// targeted GDScript-pitfall hints. exec surfaces as the `godot_exec` tool name.
function isExecToolsCall(msg) {
    const params = msg && msg.params;
    return params && typeof params === 'object' && params.name === 'godot_exec';
}

// SEE-1240 WS-3: mutation trackers feeding the frame-age contract. A screenshot
// capture whose worktree saw an exec mutation or input sequence since the last
// game-time step / thaw is flagged `stale` (the classic set→不 step→capture RED
// case): the viewport texture still shows the pre-mutation frame whenever the
// game is frozen/paused, and the addon's frame_post_draw wait cannot detect it
// on a healthy draw loop. Wall-clock latency alone catches only the SLOW case
// (blocked frame_post_draw), so both signals compose in frameAgeVerdict.

function isGameTimeToolsCall(msg) {
    const params = msg && msg.params;
    const args = params && params.arguments;
    if (!params || params.name !== 'godot_game_time') return false;
    const action = args && args.action;
    return action === 'step' || action === 'step_until' || action === 'thaw';
}

function isInputSequenceToolsCall(msg) {
    const params = msg && msg.params;
    const args = params && params.arguments;
    return Boolean(params && params.name === 'godot_input'
        && args && args.action === 'sequence' && Array.isArray(args.inputs));
}

// Common GDScript exec pitfalls matched against the response text. Each hint is
// appended verbatim (original message preserved). Patterns are intentionally
// narrow: they fire only on the specific signature of each pitfall so unrelated
// errors pass through untouched.
const EXEC_HINTS = [
    {
        // GDScript has no bare dict shorthand for string keys (`{name: "x"}` is
        // a Lua-style error) — keys must be quoted: `{"name": "x"}`.
        match: /Dictionary|dict[\s\S]{0,80}(shorthand|bare key|unquoted)/i,
        hint: ' [hint: GDScript 字典键必须加引号（`{name: "x"}` 不可用）；写成 `{"name": "x"}`]',
    },
    {
        // A `func` statement at top level of the exec body — the source is
        // compiled as a FUNCTION BODY, so nested declarations are illegal.
        match: /Parse Error:.*\bfunc\b|\bfunc\b[\s\S]{0,40}(top-level|function body|nested|cannot declare)/i,
        hint: ' [hint: exec source 是函数体，不能声明顶层 func/class；回调用 lambda `func(x): ...`，持久行为用 GDScript.new() 挂到 holder]',
    },
    {
        match: /\bawait\b/,
        hint: ' [hint: exec 是同步执行的（SYNC_ONLY），await 会让脚本挂起；等待游戏状态用 godot_game_time step/step_until，持续行为挂 holder 子节点]',
    },

    {
        // `[x for x in arr]` — GDScript has no list/dict comprehensions.
        match: /\[[^\]]*\bfor\b[^\]]*\bin\b/,
        hint: ' [hint: GDScript 无列表推导式（`[x for x in arr]` 不可用）；改用 `arr.map(func(x): return ...)` 或普通 for 循环]',
    },
    {
        // override return type conflicts with parent signature — e.g. parent
        // `-> bool`, override declared `-> void` (or any non-void/void mismatch).
        match: /->\s*void\b[\s\S]{0,160}->\s*(bool|int|float|String|string|Variant|Object|Node2D|Node)\b|->\s*(bool|int|float|String|string|Variant|Object|Node2D|Node)\b[\s\S]{0,160}->\s*void\b|(return type|signature)[\s\S]{0,60}(parent|override|mismatch|conflict)/i,
        hint: ' [hint: GDScript override 的返回类型必须与父类签名完全一致（父类 `-> bool` 时子类不可 `-> void`）；统一签名或改父类]',
    },
];

// Godot's str() truncates non-primitive return values to ~200 chars. A return
// that parses as the outer envelope's `result` field, looks like a container
// (`[`/`{`), and sits near the cap is almost certainly truncated — the proxy
// can't recover the full value (truncation is server-side), so it points the
// caller at JSON.stringify instead.
const STR_TRUNCATION_CAP = 200;
const TRUNCATION_HINT =
    ' [hint: 返回 Array/Dictionary 被 Godot `str()` 截断至 ~200 字符；在 GDScript 内 `return JSON.stringify(value)` 可拿回完整结构]';

function looksTruncatedContainer(resultVal) {
    if (typeof resultVal !== 'string') return false;
    const s = resultVal.trim();
    if (s.length < STR_TRUNCATION_CAP - 10) return false;
    return s.startsWith('[') || s.startsWith('{');
}

// Build the concatenated hint string for an exec response text. Parses the
// {completed,result,runtime_errors} envelope when present so runtime_errors are
// scanned alongside the raw text; falls back to scanning raw text otherwise.
function execHintsForText(text) {
    if (typeof text !== 'string' || text.length === 0) return '';
    let probe = text;
    let resultVal;
    try {
        const outer = JSON.parse(text);
        if (Array.isArray(outer.runtime_errors) && outer.runtime_errors.length) {
            probe = [text, ...outer.runtime_errors.map(String)].join('\n');
        }
        if (typeof outer.result === 'string') resultVal = outer.result;
    } catch {
        // not the exec JSON envelope — scan raw text only
    }
    let hints = '';
    for (const h of EXEC_HINTS) {
        if (h.match.test(probe)) hints += h.hint;
    }
    if (looksTruncatedContainer(resultVal)) hints += TRUNCATION_HINT;
    return hints;
}

// Append exec hints to each text item of an MCP `result` (the common exec
// path: errors live inside the result text, not as an MCP error). Returns the
// new result object when something changed, or null when nothing was touched
// (so the caller avoids needless re-serialization of the happy path).
function augmentExecResult(resultObj) {
    if (!resultObj || typeof resultObj !== 'object' || !Array.isArray(resultObj.content)) return null;
    let changed = false;
    const newContent = resultObj.content.map((c) => {
        if (!c || c.type !== 'text' || typeof c.text !== 'string') return c;
        const hints = execHintsForText(c.text);
        if (!hints) return c;
        changed = true;
        return { ...c, text: c.text + hints };
    });
    return changed ? { ...resultObj, content: newContent } : null;
}

export {
    isExecToolsCall,
    isGameTimeToolsCall,
    isInputSequenceToolsCall,
    looksTruncatedContainer,
    execHintsForText,
    augmentExecResult,
};
