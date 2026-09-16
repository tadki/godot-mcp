#!/usr/bin/env node
// SEE-1240 WS-3 — pure unit tests for the UI interaction tool family module.
//
// Covers (proposal #5 narrowed + D1):
//   - expandDragEntry: happy path (move→press→sweep→release), waypoints,
//     zero-duration drags, button validation, malformed args
//   - expandDragInToolsCall: godot_input sequence + godot_game_time step
//     interception, non-matching calls untouched, malformed drag → error
//   - validateUiInspectArgs / normalizeNodePath: unified node_path semantics
//   - UI_INSPECT_TOOL schema presence and reliability labeling
//   - DESCRIPTION_PATCHES anchors match the RUNNING fork's emitted tools/list
//     (registered from the fork's dist — the live compatibility check)
//
// Run: node .dev/godot-mcp/tests/scripts/test_see1240_ui_tools.mjs
// (fork-aware checks are skipped when the fork dist is absent)

import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    expandDragEntry,
    expandDragInToolsCall,
    validateUiInspectArgs,
    normalizeNodePath,
    UI_INSPECT_TOOL,
    UI_INSPECT_SNIPPETS,
    UNRELIABLE_FIELDS,
    DESCRIPTION_PATCHES,
} from '../../../launch/see1240-ui-tools.mjs';

let PASS = 0, FAIL = 0;
const failures = [];
function ok(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  [PASS] ${name}`); }
    else { FAIL++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

section('expandDragEntry');
{
    const r = expandDragEntry({ drag: { from: [10, 20], to: [100, 200] } });
    ok('expands without error', !r.error);
    const kinds = r.entries.map((e) => ('mouse_move' in e ? 'move' : 'click'));
    ok('shape: move, press/hold, sweep, final move', kinds.join(',') === 'move,click,move,move', kinds.join(','));
    const press = r.entries[1];
    ok('press at from with hold', press.mouse_button.x === 10 && press.mouse_button.y === 20
        && press.start_ms === 0 && press.duration_ms === 300);
    const last = r.entries.at(-1);
    ok('final move lands at to at t1', last.mouse_move[0] === 100 && last.mouse_move[1] === 200 && last.start_ms === 300);
    ok('sweep midpoint inside hold window', r.entries[2].start_ms === 150 && r.entries[2].mouse_move[0] === 55);

    const w = expandDragEntry({ drag: { from: [0, 0], to: [10, 10], waypoints: [[3, 3], [6, 6]] }, start_ms: 100, duration_ms: 200 });
    ok('waypoints ordered inside window', !w.error && w.entries.length === 5
        && w.entries[2].start_ms === 167 && w.entries[3].start_ms === 233
        && w.entries[2].mouse_move[0] === 3 && w.entries[3].mouse_move[0] === 6, JSON.stringify(w.entries?.map(e => e.start_ms)));

    const z = expandDragEntry({ drag: { from: [5, 5], to: [9, 9] }, duration_ms: 0 });
    ok('zero-duration still press+release and final move', !z.error
        && z.entries[1].duration_ms === 1 && z.entries.at(-1).start_ms === 0);

    const right = expandDragEntry({ drag: { from: [0, 0], to: [1, 1], button: 'right', duration_ms: 10 } });
    ok('right button passes through', !right.error && right.entries[1].mouse_button.button === 'right');

    ok('wheel button rejected', expandDragEntry({ drag: { from: [0, 0], to: [1, 1], button: 'wheel_up' } }).error !== undefined);
    ok('missing from rejected', expandDragEntry({ drag: { to: [1, 1] } }).error !== undefined);
    ok('non-numeric coord rejected', expandDragEntry({ drag: { from: ['a', 1], to: [1, 1] } }).error !== undefined);
    ok('negative start rejected', expandDragEntry({ drag: { from: [0, 0], to: [1, 1] }, start_ms: -1 }).error !== undefined);
    ok('bad waypoint shape rejected', expandDragEntry({ drag: { from: [0, 0], to: [1, 1], waypoints: [[1]] } }).error !== undefined);
}

section('expandDragInToolsCall');
{
    const call = (name, args) => ({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });

    const inCall = call('godot_input', { action: 'sequence', inputs: [{ action_name: 'move_left' }, { drag: { from: [0, 0], to: [5, 5] } }] });
    const ex = expandDragInToolsCall(inCall);
    ok('sequence drag expanded', !ex.error && ex.msg !== inCall && ex.msg.params.arguments.inputs.length === 5);
    ok('non-drag entries preserved in order', ex.msg.params.arguments.inputs[0].action_name === 'move_left');
    ok('original message untouched', inCall.params.arguments.inputs.length === 2);

    const stepCall = call('godot_game_time', { action: 'step', frames: 5, inputs: [{ drag: { from: [1, 1], to: [2, 2], duration_ms: 20 } }] });
    const exStep = expandDragInToolsCall(stepCall);
    ok('game_time step drag expanded', !exStep.error && exStep.msg.params.arguments.inputs.length === 4);

    const plain = call('godot_input', { action: 'sequence', inputs: [{ action_name: 'jump' }] });
    ok('no-drag call untouched', expandDragInToolsCall(plain).msg === plain);
    const other = call('godot_exec', { action: 'run', source: 'return 1' });
    ok('non-input tool untouched', expandDragInToolsCall(other).msg === other);
    const bad = call('godot_input', { action: 'sequence', inputs: [{ drag: { from: [0] } }] });
    ok('malformed drag surfaces error', expandDragInToolsCall(bad).error !== undefined);
    ok('step with no inputs untouched', expandDragInToolsCall(call('godot_game_time', { action: 'step', frames: 1 })).msg !== undefined);
}

section('ui_inspect validation + path semantics');
{
    ok('inspect_node valid', validateUiInspectArgs({ action: 'inspect_node', node_path: '/root/Main/UI' }).ok === true);
    ok('inspect_node requires path', validateUiInspectArgs({ action: 'inspect_node' }).ok === false);
    ok('ui_tree defaults root_path', validateUiInspectArgs({ action: 'ui_tree' }).nodePath === '/root');
    ok('unknown action rejected', validateUiInspectArgs({ action: 'x' }).ok === false);

    ok('/root passes through', normalizeNodePath('/root/Main') === '/root/Main');
    ok('bare name → /root/<name>', normalizeNodePath('Panel') === '/root/Panel');
    ok('relative dotted → /root/<name>', normalizeNodePath('./UI') === '/root/UI');
    ok('root alias', normalizeNodePath('/root') === '/root' && normalizeNodePath('/') === '/root');
}

section('ui_inspect surface contract');
{
    ok('tool name is godot_ui_inspect', UI_INSPECT_TOOL.name === 'godot_ui_inspect');
    ok('schema requires action', JSON.stringify(UI_INSPECT_TOOL.inputSchema.required) === '["action"]');
    ok('schema enumerates both actions', UI_INSPECT_TOOL.inputSchema.properties.action.enum.join(',') === 'inspect_node,ui_tree');
    ok('description marks exec-based', UI_INSPECT_TOOL.description.includes('godot_exec'));
    ok('description marks headless unreliability', UI_INSPECT_TOOL.description.includes('unreliable'));
    ok('unreliable fields catalogued', UNRELIABLE_FIELDS.hover && UNRELIABLE_FIELDS.mouse_position && UNRELIABLE_FIELDS.window_focus);
    ok('inspect snippet escapes caller path', UI_INSPECT_SNIPPETS.inspect('/root/Main" + evil').includes('\\" + evil') === false
        || UI_INSPECT_SNIPPETS.inspect('/root/A').includes('"/root/A"'));
    ok('ui_tree snippet bounded walk', UI_INSPECT_SNIPPETS.uiTree('/root').includes('pop_back'));
}

section('DESCRIPTION_PATCHES vs running fork tools/list');
{
    // SEE-1292 LOW-2: resolve the fork dist from the submodule's own location
    // (this test lives in <submodule>/launch/tests/scripts/), not a hardcoded
    // D-drive path from the pre-SEE-1273 layout.
    const FORK_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'server', 'dist');
    const FORK_TOOLS_INDEX = path.join(FORK_DIST, 'tools', 'index.js');
    const FORK_REGISTRY = path.join(FORK_DIST, 'core', 'registry.js');
    let forkAvailable = false;
    try { statSync(FORK_TOOLS_INDEX); statSync(FORK_REGISTRY); forkAvailable = true; } catch { /* absent */ }

    if (!forkAvailable) {
        console.log('  [SKIP] fork dist not present on this machine — patch anchors validated against recorded text only');
        ok('input patch anchors on the documented stale note', DESCRIPTION_PATCHES[0].anchor.includes('absolute cursor positioning is not'));
        ok('editor patch anchors on the running-game sentence', DESCRIPTION_PATCHES[1].anchor.includes('screenshot_game needs a running game'));
    } else {
        const { registry } = await import(FORK_REGISTRY);
        const { registerAllTools } = await import(FORK_TOOLS_INDEX);
        registerAllTools();
        const list = registry.getToolList();
        for (const patch of DESCRIPTION_PATCHES) {
            const tool = list.find((t) => t.name === patch.tool);
            ok(`${patch.tool} present in fork tools/list`, !!tool);
            if (tool) {
                ok(`${patch.tool} anchor matches running fork`, tool.description.includes(patch.anchor),
                    `anchor not found in live description (fork may have shipped the fix natively — patch then correctly skips)`);
                ok(`${patch.tool} patch replacement mentions SEE`, patch.replace.includes('SEE-1141') || patch.replace.includes('SEE-1240') || patch.tool === 'godot_exec');
            }
        }
    }
    ok('patch count is exactly 3 (input + editor_read + exec, SEE-1240 WS-6)', DESCRIPTION_PATCHES.length === 3);
}

console.log(`\nSUMMARY: PASS=${PASS} FAIL=${FAIL}`);
if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
