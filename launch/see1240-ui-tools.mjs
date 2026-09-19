// SEE-1240 WS-3 — UI interaction observation tool family (proxy side).
//
// Proposal #5 (narrowed, SEE-1239 R3) and the D1 ruling, implemented without
// touching the vendored addon or the fork:
//
//  1. drag primitive — proxy-side sequence sugar. The bridge (SEE-1141 Track D)
//     already compiles mouse_move/mouse_button entries with absolute
//     viewport-space coords and a guaranteed paired release, so a drag is a
//     well-formed timeline: move-to-start → press(hold) → move(s) → release.
//     The sugar expands ONE drag entry into that timeline client-side; the
//     wire vocabulary is unchanged and version-skew echo (input_kinds) still
//     reports the underlying kinds.
//  2. ui_inspect — a synthetic proxy tool that answers by composing
//     godot_exec runs against the RUNNING game (per the ruling: exec-based
//     first). Fields that lie in headless/headless-ish contexts (the polled
//     mouse position family) are marked trust:unreliable explicitly.
//  3. description updates — tools/list responses get surgical description
//     patches (see DESCRIPTION_PATCHES) so the running tool surface tells the
//     truth: absolute mouse entries exist, drag sugar exists, ui_inspect
//     exists, and the screenshot contract (SEE-1240) is discoverable.
//
// Everything here is pure-or-async standalone logic; the proxy supplies the
// transport (forwardToNpx) and id plumbing.

// --- drag sugar -----------------------------------------------------------

// Expand one drag entry into the bridge's sequence vocabulary. All coords are
// viewport/canvas space (the bridge maps through get_final_transform()).
//
//   { drag: { from: [x,y], to: [x,y], button?: 'left'|..., waypoints?: [[x,y],...],
//             start_ms?: 0, duration_ms?: N } }
//
// Timeline (relative to start_ms, spanning duration_ms, default 300ms):
//   t0            mouse_move to from              (cursor set — seeds the
//                                                 virtual cursor so the press
//                                                 has a sane position)
//   t0            mouse_button press+hold
//   t0..t1        mouse_move through waypoints    (default: straight-line
//                                                 midpoint; sampled every
//                                                 ~50ms so _gui_input motion
//                                                 handlers see a real sweep)
//   t1            mouse_button release (guaranteed paired by the bridge)
//
// Returns the expanded entries array, or { error } for invalid args (same
// error-strings contract as the bridge's compile errors).
export function expandDragEntry(entry) {
    const d = entry && entry.drag;
    if (!d || typeof d !== 'object') {
        return { error: 'drag entry expects {drag: {from: [x,y], to: [x,y], button?, waypoints?, start_ms?, duration_ms?}}' };
    }
    const from = d.from, to = d.to;
    const isPoint = (p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n));
    if (!isPoint(from)) return { error: 'drag.from expects [x, y] (two finite numbers)' };
    if (!isPoint(to)) return { error: 'drag.to expects [x, y] (two finite numbers)' };
    const button = d.button === undefined ? 'left' : d.button;
    if (!['left', 'right', 'middle'].includes(button)) {
        return { error: `drag.button must be left|right|middle, got ${JSON.stringify(button)} (wheel is not a drag)` };
    }
    const start = entry.start_ms === undefined ? 0 : entry.start_ms;
    const dur = entry.duration_ms === undefined ? 300 : entry.duration_ms;
    if (!Number.isFinite(start) || start < 0) return { error: 'drag.start_ms must be a non-negative number' };
    if (!Number.isFinite(dur) || dur < 0) return { error: 'drag.duration_ms must be a non-negative number' };

    let waypoints = [];
    if (d.waypoints !== undefined) {
        if (!Array.isArray(d.waypoints)) return { error: 'drag.waypoints expects an array of [x, y] points' };
        for (const w of d.waypoints) {
            if (!isPoint(w)) return { error: 'drag.waypoints entries must be [x, y] pairs' };
        }
        waypoints = d.waypoints;
    } else if (dur > 0) {
        // Straight-line midpoint sample so a fast drag still emits motion while
        // the button is held (GUI hover/motion handlers observe the sweep).
        waypoints = [[(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]];
    }

    const t1 = start + dur;
    const entries = [
        { mouse_move: from, start_ms: start, duration_ms: 0 },
        // press at start; the bridge emits the paired release at start+dur.
        // A short hold makes press→release ordering unambiguous even at dur=0.
        { mouse_button: { x: from[0], y: from[1], button }, start_ms: start, duration_ms: Math.max(dur, 1) },
    ];
    // Motion entries distributed across the hold window (never at t1 — the
    // release must be the last event of the drag).
    const n = waypoints.length;
    waypoints.forEach((w, i) => {
        const t = start + Math.round(((dur * (i + 1)) / (n + 1)));
        entries.push({ mouse_move: w, start_ms: Math.min(t, t1 - 1 >= start ? t1 - 1 : start), duration_ms: 0 });
    });
    entries.push({ mouse_move: to, start_ms: t1, duration_ms: 0 });
    // The button entry above already carries the paired release at t1; this
    // trailing move lands AFTER the release event (same start_ms) so the final
    // cursor position is where the release happened. Ordering within the same
    // ms: the bridge sorts stable by time, then fires in insertion order —
    // press/hold's release is queued at hold time, the trailing move after.
    return { entries };
}

// Rewrite one tools/call of godot_input (or godot_game_time step inputs),
// expanding drag entries. Returns { msg } unchanged when no drag entries are
// present, or the rewritten message; or { error } with a message for the
// response when the drag entry itself is malformed.
export function expandDragInToolsCall(msg) {
    const params = msg && msg.params;
    if (!params || typeof params !== 'object') return { msg };
    const name = params.name;
    const args = params.arguments;
    if (typeof name !== 'string' || !args || typeof args !== 'object') return { msg };

    let inputs = null;
    let container = null;
    let key = null;
    if (name === 'godot_input' && args.action === 'sequence' && Array.isArray(args.inputs)) {
        inputs = args.inputs; container = args; key = 'inputs';
    } else if (name === 'godot_game_time' && args.action === 'step' && Array.isArray(args.inputs)) {
        inputs = args.inputs; container = args; key = 'inputs';
    }
    if (!inputs) return { msg };
    if (!inputs.some((e) => e && typeof e === 'object' && 'drag' in e)) return { msg };

    const out = [];
    for (const e of inputs) {
        if (e && typeof e === 'object' && 'drag' in e) {
            const r = expandDragEntry(e);
            if (r.error) return { error: r.error };
            out.push(...r.entries);
        } else {
            out.push(e);
        }
    }
    const newArgs = { ...args, [key]: out };
    return { msg: { ...msg, params: { ...params, arguments: newArgs } } };
}

// --- ui_inspect (exec-based) ----------------------------------------------

// GDScript snippets the ui_inspect handler composes. The RUNNING GAME's tree
// is inspected (this is the UI-observation ask: hover, focus, draw state of
// the live scene). Kept as data so tests can pin the exec surface.
export const UI_INSPECT_SNIPPETS = {
    // One driver snippet computes everything in a single exec run (one
    // round-trip): node info, UI walk, focus/hover. JSON.stringify for
    // structure (the exec path str()-truncates containers).
    inspect: (nodePath) => `
var _target = root.get_node_or_null("${nodePath}")
if _target == null:
    return JSON.stringify({ "ok": false, "error": "NODE_NOT_FOUND", "node_path": "${nodePath}" })
var _info := {
    "ok": true,
    "node_path": str(_target.get_path()),
    "class": _target.get_class(),
    "visible": null,
    "visible_in_tree": null,
    "global_rect": null,
    "size": null,
    "disabled": null,
    "text": null,
    "tooltip_text": "",
}
if _target.get_script() != null:
    _info["script"] = str(_target.get_script().resource_path)
if _target is CanvasItem:
    _info["visible"] = _target.visible
    _info["visible_in_tree"] = _target.is_visible_in_tree()
if _target is Control:
    _info["global_rect"] = _target.get_global_rect()
    _info["size"] = _target.size
    var _tval = _target.get("text")
    if _tval != null:
        _info["text"] = str(_tval)
    var _tipval = _target.get("tooltip_text")
    if _tipval != null:
        _info["tooltip_text"] = str(_tipval)
if _target is BaseButton:
    _info["disabled"] = _target.disabled
var _focused = _target.get_viewport().gui_get_focus_owner()
_info["is_focus_owner"] = _focused == _target
if _focused != null:
    _info["focus_owner_path"] = str(_focused.get_path())
# hover: gui_get_hovered_control exists since 4.2; guard for portability.
var _hovered = null
if _target.get_viewport().has_method("gui_get_hovered_control"):
    _hovered = _target.get_viewport().gui_get_hovered_control()
_info["is_hovered"] = _hovered == _target and _hovered != null
# UNRELIABLE family (headless / unfocused-window contexts): the POLLED mouse
# position tracks the physical OS cursor, which the agent does not move.
_info["_mouse_position_note"] = "polled mouse position is the PHYSICAL OS cursor; injected events do not move it (see fork spike doc)"
return JSON.stringify(_info)
`.trim(),

    uiTree: (rootPath) => `
var _root = root.get_node_or_null("${rootPath}")
if _root == null:
    return JSON.stringify({ "ok": false, "error": "NODE_NOT_FOUND", "root_path": "${rootPath}" })
var _rows := []
var _stack := [[_root, 0]]
var MAX_NODES := 400
var MAX_DEPTH := 12
while not _stack.is_empty() and _rows.size() < MAX_NODES:
    var _top = _stack.pop_back()
    var _n: Node = _top[0]
    var _depth: int = _top[1]
    if _depth > MAX_DEPTH:
        continue
    if _n is Control:
        var _c := _n as Control
        _rows.append({
            "path": str(_n.get_path()),
            "class": _n.get_class(),
            "depth": _depth,
            "visible": _c.visible,
            "rect": _c.get_global_rect(),
        })
    var _children := _n.get_children()
    for i in range(_children.size() - 1, -1, -1):
        _stack.append([_children[i], _depth + 1])
return JSON.stringify({ "ok": true, "controls": _rows, "count": _rows.size() })
`.trim(),
};

// Fields that CANNOT be trusted when the game runs without a real focused
// window / in headless-ish sessions. Surfaced per-field in the response so a
// caller never mistakes them for ground truth (the ruling's explicit-labels
// requirement).
export const UNRELIABLE_FIELDS = {
    hover: 'hover state derives from injected motion events under the virtual cursor; with no physical pointer over the window the mapping can diverge from a human-user session',
    mouse_position: 'polled mouse positions track the PHYSICAL OS cursor; injected events never move it (fork spike doc ceiling)',
    window_focus: 'the editor holds OS focus in the MCP topology; the game window is usually unfocused, which changes some focus-follows behaviors',
};

// Build the ui_inspect tool schema + description as it should appear in the
// patched tools/list. Note the explicit headless-reliability labels.
export const UI_INSPECT_TOOL = {
    name: 'godot_ui_inspect',
    description:
        'Inspect the RUNNING game\'s UI tree and a node\'s live interaction state — computed via godot_exec against the game process (SEE-1240 WS-3, exec-based). ' +
        'Returns class, visibility (self + in-tree), global rect, size, text, disabled, and the focus/hover relationship for one node, or the whole visible Control subtree. ' +
        'RELIABILITY LABELS: hover and mouse-position-derived fields are marked unreliable — injected events drive the virtual cursor, while polled positions track the physical OS cursor; in headless or unfocused-window runs treat those fields as advisory only (each response carries per-field trust annotations). ' +
        'For the EDITOR-side scene tree use godot_node_read instead; for appearance judgments use the screenshot contract (godot_editor_read screenshot_game with the SEE-1240 freshness metadata).',
    inputSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['inspect_node', 'ui_tree'],
                description:
                    'inspect_node: full interaction-state report for one node. ui_tree: flat list of every visible Control under root_path with rect + visibility.',
            },
            node_path: {
                type: 'string',
                description:
                    'inspect_node: absolute path to the node, e.g. "/root/Main/UI/Panel". UNIFIED SEMANTICS: /root/X resolves against the RUNNING GAME\'s scene root (same convention as godot_exec `root`), NOT the editor\'s edited scene.',
            },
            root_path: {
                type: 'string',
                description: 'ui_tree: absolute path where the walk starts (default "/root" = the game\'s scene root autoload chain included).',
            },
        },
        required: ['action'],
    },
    annotations: { title: 'UI Inspect (game, exec-based)', readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

// Validate a ui_inspect call's arguments. Returns { ok:true, action, nodePath }
// or { ok:false, error }.
export function validateUiInspectArgs(args) {
    const action = args && args.action;
    if (action === 'inspect_node') {
        const p = args.node_path;
        if (typeof p !== 'string' || p.length === 0) {
            return { ok: false, error: 'inspect_node requires node_path (absolute path, e.g. "/root/Main/UI/Panel")' };
        }
        return { ok: true, action, nodePath: p };
    }
    if (action === 'ui_tree') {
        const p = typeof args.root_path === 'string' && args.root_path.length > 0 ? args.root_path : '/root';
        return { ok: true, action, nodePath: p };
    }
    return { ok: false, error: 'action must be "inspect_node" or "ui_tree"' };
}

// Normalize a caller-supplied node path into the snippet's get_node_or_null
// form. The game-side `root` binding is the root Window; "/root/X" works
// verbatim, bare "X" is resolved from root as well. Editor-scene-relative
// paths ("." / "UI/Panel") are rejected with guidance — that ambiguity is
// exactly what the unified-semantics ruling removes.
export function normalizeNodePath(p) {
    if (p === '/root' || p === '/') return '/root';
    if (p.startsWith('/root/')) return p;
    if (p.startsWith('/')) return p; // absolute-but-not-/root: pass through, Godot will report NOT_FOUND if wrong
    if (p === '.' || !p.includes('/')) {
        return `/root/${p}`.replace(/\/+$/, '');
    }
    return `/root/${p.replace(/^\.?\//, '')}`;
}

// --- description patches ----------------------------------------------------

// Surgical description updates (D1: "版本对齐 + description 更新"). Applied to
// tools/list responses by string-anchored replacement; a patch that does not
// match its anchor is SKIPPED silently (forward-compat: a future fork that
// ships these truths natively simply stops being patched — the anchor text
// will have changed).
import { EXEC_DESCRIPTION_ANCHOR, execDescriptionReplacement } from './see1240-exec-constraints.mjs';

export const DESCRIPTION_PATCHES = [
    {
        tool: 'godot_input',
        // The running fork's description still carries the pre-Track-D honesty
        // note; replace it with the version-aligned truth.
        anchor: 'absolute cursor positioning is not (see docs/design/mouse-input-spike.md)',
        replace: 'absolute mouse positioning IS supported (mouse_move / mouse_button entries, SEE-1141 Track D): coords are viewport/canvas space, injected through the event path (Control._gui_input, _input). The POLLED OS cursor does not move (get_mouse_position() in _process stays physical) — games can opt in via the MCPCursor/MousePos pattern. Drag: use the {drag: {from, to}} sequence sugar (proxy-expands to move→press→sweep→release, SEE-1240).',
    },
    {
        tool: 'godot_editor_read',
        anchor: 'screenshot_game needs a running game, while every other action works in the bare editor.',
        replace: 'screenshot_game needs a running game, while every other action works in the bare editor. SEE-1240 capture contract: every successful game screenshot carries _screenshot freshness metadata (capture_latency_ms, stale flag, auto_step provenance) and exports {png_path,width,height} written under .dev/godot-mcp/exports/ (full resolution when you omit max_width; max_width is an UPPER BOUND, not a target — omit it or pass ≥ native width for a byte-identical native frame, pass < native width for a proportional downsize). Freshness threshold is GODOT_MCP_STALE_CAPTURE_MS (default 1500ms). Pass arguments.auto_step=true to have one game-time frame stepped before capture (opt-in, frozen-friendly).',
    },
    // SEE-1240 WS-6: the godot_exec constraint sentence comes from the exec
    // SSOT (see1240-exec-constraints.mjs) — same render as the proxy pre-check
    // and the action:'help' digest, so the three surfaces cannot drift.
    {
        tool: 'godot_exec',
        anchor: EXEC_DESCRIPTION_ANCHOR,
        replace: execDescriptionReplacement(),
    },
];

// The ui_inspect tool is APPENDED to the tools/list result, and a one-line
// note is added to the top-level server information so the surface is
// discoverable without reading descriptions.
export const TOOLS_LIST_APPENDIX_NOTE =
    ' [SEE-1240] This server runs behind the KOL proxy: godot_ui_inspect (game UI observation, exec-based) is provided by the proxy, godot_input/godot_editor_read descriptions are proxy-patched, and screenshot responses carry freshness metadata + disk exports.';
