// proxy/ui-inspect.mjs — proxy-provided godot_ui_inspect tool, answered
// in-band by composing godot_exec through the internal call channel (extracted
// from godot-mcp-proxy.mjs, SEE-1334 Phase 0a).
import { S } from './state.mjs';
import { forwardToNpx } from './protocol.mjs';
import {
    UI_INSPECT_TOOL, UI_INSPECT_SNIPPETS, UNRELIABLE_FIELDS,
    validateUiInspectArgs, normalizeNodePath,
} from '../see1240-ui-tools.mjs';

// SEE-1240 WS-3: detect the proxy-provided godot_ui_inspect tool. Answered
// in-band by composing godot_exec runs (the D1-era ruling: exec-based first),
// so its responses never transit npx.
function isUiInspectToolsCall(msg) {
    const params = msg && msg.params;
    return params && typeof params === 'object' && params.name === UI_INSPECT_TOOL.name;
}

// SEE-1240 WS-3: answer a godot_ui_inspect call by running one composed
// godot_exec snippet against the running game, then replying in-band. The
// helper returns an MCP response object; null means the call could not be
// answered (never happens for well-formed calls — all failures become
// structured error results so the agent sees actionable text).
async function answerUiInspectCall(msg) {
    const id = msg.id;
    const args = (msg.params && msg.params.arguments) || {};
    const v = validateUiInspectArgs(args);
    if (!v.ok) {
        return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: `Error: ${v.error}` }] },
        };
    }
    const snippet = (v.action === 'inspect_node')
        ? UI_INSPECT_SNIPPETS.inspect(normalizeNodePath(v.nodePath))
        : UI_INSPECT_SNIPPETS.uiTree(normalizeNodePath(v.nodePath));
    const out = await forwardGodotExecAndAwait({ action: 'run', source: snippet, budget_ms: 25000 });
    const unreliableNote = {
        field_trust: {
            hover: UNRELIABLE_FIELDS.hover,
            mouse_position: UNRELIABLE_FIELDS.mouse_position,
            window_focus: UNRELIABLE_FIELDS.window_focus,
        },
    };
    if (out.error !== undefined) {
        return {
            jsonrpc: '2.0',
            id,
            result: {
                content: [{
                    type: 'text',
                    text: `Error: godot_ui_inspect underlying exec failed: ${out.error.message || JSON.stringify(out.error)}`,
                }],
            },
        };
    }
    // The exec result text carries {completed,result,...}; the game-side
    // snippet JSON-stringified its payload into `result`.
    let payload = null;
    try {
        const outer = JSON.parse((out.content || []).map((c) => (c && c.text) || '').join(''));
        payload = typeof outer.result === 'string' ? JSON.parse(outer.result) : outer.result;
    } catch {
        payload = null;
    }
    if (payload === null) {
        return {
            jsonrpc: '2.0',
            id,
            result: {
                content: [{
                    type: 'text',
                    text: `Error: godot_ui_inspect could not parse the underlying exec result (game responded: ${(out.content || []).map((c) => (c && c.text) || '').join('').slice(0, 400)})`,
                }],
            },
        };
    }
    if (payload.ok === false) {
        return {
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: `Error: ${payload.error} (${payload.node_path || payload.root_path || ''})` }] },
        };
    }
    const lines = [JSON.stringify({ ...payload, field_trust: unreliableNote.field_trust })];
    lines.push(`[reliability] hover/mouse-position/focus fields: ${UNRELIABLE_FIELDS.hover} | ${UNRELIABLE_FIELDS.mouse_position}`);
    lines.push('[semantics] node paths resolve against the RUNNING GAME scene root (/root/...), unified SEE-1240; headless contexts: treat hover/mouse fields as advisory only.');
    return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: lines.join('\n') }] },
    };
}

// SEE-1240 WS-3: run one godot_exec tools/call through npx and resolve with
// the parsed MCP result object (or { error } with an Error). Used only by the
// ui_inspect composition — a single fixed-shape internal call, distinct id
// space so it cannot collide with client ids.
async function forwardGodotExecAndAwait(execArgs) {
    const internalId = `see1240-ui-inspect-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const line = JSON.stringify({
        jsonrpc: '2.0',
        id: internalId,
        method: 'tools/call',
        params: { name: 'godot_exec', arguments: execArgs },
    });
    return new Promise((resolve) => {
        S.internalExecWaiters.set(internalId, resolve);
        // Safety timeout well under the CLI's QUICK_TIMEOUT cascade for a
        // 10s-budget exec: a hung game answers nothing, and the caller gets a
        // structured error instead of an infinite await.
        const timer = setTimeout(() => {
            if (S.internalExecWaiters.has(internalId)) {
                S.internalExecWaiters.delete(internalId);
                resolve({ error: { message: 'internal exec timed out (game unresponsive?)' } });
            }
        }, 45000);
        S.internalExecTimers.set(internalId, timer);
        forwardToNpx(line);
    });
}

export {
    isUiInspectToolsCall,
    answerUiInspectCall,
    forwardGodotExecAndAwait,
};
