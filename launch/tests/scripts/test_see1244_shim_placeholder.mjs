#!/usr/bin/env node
// SEE-1244 §9.2 — placeholder list freeze test.
//
// The PLACEHOLDER_TOOLS name set must equal the RUNNING fork's real
// tools/list names (plus the proxy-provided godot_ui_inspect, SEE-1240 WS-3).
// Drift (fork adds/removes a tool) fails here and reminds us to re-freeze the
// constant — same protection philosophy as the DESCRIPTION_PATCHES anchors.

import { statSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = path.resolve(HERE, '../../../launch/godot-mcp-shim.mjs');

let PASS = 0, FAIL = 0;
const failures = [];
function ok(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  [PASS] ${name}`); }
    else { FAIL++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

// Extract the placeholder name list by answering tools/list from a shim with
// no cache (fresh temp HOME) — the real production surface, not an import.
async function getPlaceholderTools() {
    const home = mkdtempSync(path.join(os.tmpdir(), 'see1244-ph-'));
    return new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, [SHIM_PATH, 'PlaceholderTest'], {
            stdio: ['pipe', 'pipe', 'ignore'],
            env: { ...process.env, HOME: home },
        });
        let buf = '';
        const timer = setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 8000);
        proc.stdout.on('data', (d) => {
            buf += d.toString();
            for (const line of buf.split('\n')) {
                if (line.includes('"id":1') && line.includes('"tools"')) {
                    clearTimeout(timer);
                    proc.kill();
                    try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
                    resolve(JSON.parse(line).result.tools);
                }
            }
        });
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
    });
}

section('placeholder list invariants');
{
    const tools = await getPlaceholderTools();
    ok('placeholder list non-empty', Array.isArray(tools) && tools.length > 0);
    ok('every entry has name + description + inputSchema', tools.every((t) => t.name && typeof t.description === 'string' && t.inputSchema));
    ok('descriptions self-describe as placeholder', tools.every((t) => t.description.includes('[godot-mcp placeholder]') && t.description.includes('SEE-1244')));
    ok('inputSchema is the deliberate empty object shell', tools.every((t) => t.inputSchema.type === 'object' && Object.keys(t.inputSchema.properties ?? {}).length === 0));
    ok('no duplicate names', new Set(tools.map((t) => t.name)).size === tools.length);
}

section('placeholder names == running fork tools/list + godot_ui_inspect');
{
    const FORK_TOOLS_INDEX = '/mnt/d/GodotProjects/forks/godot-mcp/server/dist/tools/index.js';
    const FORK_REGISTRY = '/mnt/d/GodotProjects/forks/godot-mcp/server/dist/core/registry.js';
    let forkAvailable = false;
    try { statSync(FORK_TOOLS_INDEX); statSync(FORK_REGISTRY); forkAvailable = true; } catch { /* absent */ }

    const placeholderNames = new Set((await getPlaceholderTools()).map((t) => t.name));
    if (!forkAvailable) {
        console.log('  [SKIP] fork dist not present on this machine — asserting the frozen baseline set only');
        // Frozen baseline (2026-09-07 fork state, 21 fork tools + ui_inspect).
        const baseline = new Set([
            'godot_animation_edit', 'godot_animation_read', 'godot_docs',
            'godot_editor_edit', 'godot_editor_read', 'godot_exec', 'godot_game_time',
            'godot_gridmap_edit', 'godot_gridmap_read', 'godot_input', 'godot_node_edit',
            'godot_node_read', 'godot_profiler', 'godot_project', 'godot_resource',
            'godot_runtime_state', 'godot_scene', 'godot_scene3d', 'godot_tilemap_edit',
            'godot_tilemap_read', 'godot_ui_inspect', 'godot_validate_meshes',
        ]);
        ok('placeholder == frozen baseline set', placeholderNames.size === baseline.size && [...baseline].every((n) => placeholderNames.has(n)));
    } else {
        const { registry } = await import(FORK_REGISTRY);
        const { registerAllTools } = await import(FORK_TOOLS_INDEX);
        registerAllTools();
        const forkNames = new Set(registry.getToolList().map((t) => t.name));
        // godot_ui_inspect is proxy-provided (post-patchToolsList surface), so
        // placeholder = fork names + that one tool.
        forkNames.add('godot_ui_inspect');
        const missing = [...forkNames].filter((n) => !placeholderNames.has(n));
        const extra = [...placeholderNames].filter((n) => !forkNames.has(n));
        ok('placeholder names == fork real names + godot_ui_inspect', missing.length === 0 && extra.length === 0,
            `missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)} — re-freeze PLACEHOLDER_TOOL_NAMES in godot-mcp-shim.mjs`);
    }
}

console.log(`\nSUMMARY: PASS=${PASS} FAIL=${FAIL}`);
if (FAIL > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
