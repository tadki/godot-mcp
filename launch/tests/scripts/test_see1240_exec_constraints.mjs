#!/usr/bin/env node
// SEE-1240 WS-6 (C11 一期) — pure unit tests for the exec constraint SSOT.
//
// Covers:
//   - precheckExecSource: denylist hit (names violated entries), await
//     SYNC_ONLY, NO_CODE, comment/string false-positive immunity, dot-spacing
//     and line-continuation normalization, word-boundary precision
//     (MyOS.executed / OS.execute_with_pipe), multi-violation ordering
//   - lexer parity spot-checks against MCPExecGuard documented behavior
//     (escaped char never ends the string; raw-string miss accepted)
//   - SSOT parity with the vendored addon's MCPExecGuard.DENYLIST (the drift
//     guard — parsing the .gd source; skipped when the addon file is absent)
//   - description patch: anchor present in the RUNNING fork's emitted
//     godot_exec description when the fork dist is available; replacement
//     carries every SSOT token
//   - digest consistency: description replacement tokens == digest tokens ==
//     EXEC_CONSTRAINTS
//
// Run: node .dev/godot-mcp/tests/scripts/test_see1240_exec_constraints.mjs
// (addon/fork-aware checks are skipped when those files are absent)

import { statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    EXEC_CONSTRAINTS,
    EXEC_SYNC_ONLY,
    precheckExecSource,
    execConstraintDigest,
    execDescriptionReplacement,
    EXEC_DESCRIPTION_ANCHOR,
} from '../../../launch/see1240-exec-constraints.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADDON_GUARD = join(__dirname, '../../../addons/godot_mcp/game_bridge/mcp_exec_guard.gd');
const FORK_EXEC = '/mnt/d/GodotProjects/forks/godot-mcp/server/dist/tools/exec.js';

let PASS = 0, FAIL = 0;
const failures = [];
function ok(name, cond, detail = '') {
    if (cond) { PASS++; console.log(`  [PASS] ${name}`); }
    else { FAIL++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(t) { console.log(`\n== ${t} ==`); }

section('precheckExecSource — DENIED_TOKEN names violated entries');
{
    const r = precheckExecSource('OS.execute("ls")');
    ok('OS.execute denied', r.ok === false && r.kind === 'DENIED_TOKEN', JSON.stringify(r));
    ok('names the entry', r.violations.length === 1 && r.violations[0] === 'OS.execute');
    ok('message names the entry', r.message.includes('OS.execute'));

    const multi = precheckExecSource('OS.kill(1)\nResourceSaver.save("res://x")\nDirAccess.open("res://")');
    ok('multi-violation names all in SSOT order', !multi.ok
        && JSON.stringify(multi.violations) === JSON.stringify(['OS.kill', 'DirAccess', 'ResourceSaver']),
        JSON.stringify(multi.violations));

    const exact = precheckExecSource('OS.execute_with_pipe(1)');
    ok('longer token matches its own entry only', !exact.ok
        && exact.violations.length === 1 && exact.violations[0] === 'OS.execute_with_pipe');

    const editor = precheckExecSource('EditorInterface.get_selection()');
    ok('EditorInterface denied', !editor.ok && editor.violations[0] === 'EditorInterface');
}

section('precheckExecSource — SYNC_ONLY + NO_CODE');
{
    const a = precheckExecSource('await get_tree().process_frame');
    ok('await banned', a.ok === false && a.kind === 'SYNC_ONLY' && a.violations[0] === EXEC_SYNC_ONLY.banned);
    ok('await advice present', a.message.includes('godot_game_time'));

    const n = precheckExecSource('# only a comment');
    ok('comments-only → NO_CODE', n.ok === false && n.kind === 'NO_CODE');
    ok('empty string → NO_CODE', precheckExecSource('').ok === false);
    ok('non-string → NO_CODE', precheckExecSource(undefined).ok === false);

    const awaitInString = precheckExecSource('print("please await the results")\nreturn 1');
    ok('await inside string passes', awaitInString.ok === true, JSON.stringify(awaitInString));
}

section('precheckExecSource — false-positive immunity (lexer parity)');
{
    ok('token in string passes', precheckExecSource('print("OS.execute is banned")\nreturn 1').ok === true);
    ok('token in comment passes', precheckExecSource('# OS.execute\nreturn 1').ok === true);
    ok('token in triple-string passes', precheckExecSource('var s = """multi\nline OS.execute doc"""\nreturn 1').ok === true);
    ok("word boundary: MyOS.executed passes", precheckExecSource('var x = MyOS.executed').ok === true);
    ok("word boundary: OS.execute_with_pipe not hit by OS.execute entry", (() => {
        const r = precheckExecSource('OS.execute_with_pipe(1)');
        return !r.ok && r.violations.length === 1 && r.violations[0] === 'OS.execute_with_pipe';
    })());
    ok('dot-spacing normalized: OS . execute denied', (() => {
        const r = precheckExecSource('var y = OS . execute(1)');
        return !r.ok && r.violations[0] === 'OS.execute';
    })());
    ok('line continuation normalized: OS.\\<nl>execute denied', (() => {
        const r = precheckExecSource('var z = OS.\\\nexecute(1)');
        return !r.ok && r.violations[0] === 'OS.execute';
    })());
    ok('escaped quote never ends string (addon parity)',
        precheckExecSource('var t = "a\\"; var u = OS.execute(1)').ok === true,
        'addon treats the escaped quote as non-terminating too — matching over-block-free behavior');
    ok('clean source passes', precheckExecSource('return 1 + 1').ok === true);
    ok('autoload access passes', precheckExecSource('G.wave = 5\nreturn G.wave').ok === true);
}

section('SSOT parity with the vendored addon DENYLIST (drift guard)');
{
    let addonAvailable = false;
    try { statSync(ADDON_GUARD); addonAvailable = true; } catch { /* absent */ }
    if (!addonAvailable) {
        console.log('  [SKIP] addon source not present on this machine');
    } else {
        const gd = readFileSync(ADDON_GUARD, 'utf8');
        const block = gd.match(/const DENYLIST: Array\[String\] = \[([\s\S]*?)\n\]/);
        ok('addon DENYLIST block found', !!block);
        if (block) {
            const addonTokens = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
            const ssotTokens = EXEC_CONSTRAINTS.map((c) => c.token);
            ok('token count matches', addonTokens.length === ssotTokens.length,
                `addon=${addonTokens.length} ssot=${ssotTokens.length}`);
            ok('token sequence identical (order-stable parity)', JSON.stringify(addonTokens) === JSON.stringify(ssotTokens),
                `addon=${JSON.stringify(addonTokens)} ssot=${JSON.stringify(ssotTokens)}`);
        }
        ok('addon SYNC_ONLY await rule mirrored', gd.includes('"await"') && EXEC_SYNC_ONLY.banned === 'await');
    }
}

section('three surfaces render from one SSOT (description == digest == list)');
{
    const tokens = EXEC_CONSTRAINTS.map((c) => c.token);
    const digest = execConstraintDigest();
    const repl = execDescriptionReplacement();
    ok('digest carries every token', tokens.every((t) => digest.includes(t)));
    ok('digest carries the await rule', digest.includes(EXEC_SYNC_ONLY.banned));
    ok('digest carries usage guidance', digest.includes('{action:"help"}') && digest.includes('budget_ms'));
    ok('description replacement carries every token', tokens.every((t) => repl.includes(t)));
    ok('description replacement documents help action', repl.includes("action:'help'"));
    ok('guard note present in both', digest.includes('NOT a security boundary') && repl.includes('NOT a security boundary'));
}

section('description anchor vs RUNNING fork tools/list');
{
    let forkAvailable = false;
    let forkDesc = '';
    try {
        forkDesc = readFileSync(FORK_EXEC, 'utf8');
        forkAvailable = true;
    } catch { /* absent */ }
    if (!forkAvailable) {
        console.log('  [SKIP] fork dist not present on this machine — anchor validated against recorded text only');
    } else {
        // Reconstruct the description the fork emits: concatenate the adjacent
        // string literals of the description: '...' + '...' assignment.
        const m = forkDesc.match(/description:\s*((?:'[^']*'\s*\+\s*)*'[^']*')/);
        ok('fork description literal found', !!m);
        if (m) {
            const emitted = eval(m[1]);
            ok('anchor present in the RUNNING fork description', emitted.includes(EXEC_DESCRIPTION_ANCHOR),
                JSON.stringify(EXEC_DESCRIPTION_ANCHOR.slice(0, 60)));
        }
    }
    // Anchor shape sanity even without the fork: the abbreviated sentence.
    ok('anchor carries the abbreviated denylist sentence', EXEC_DESCRIPTION_ANCHOR.includes('A static denylist rejects accidental process/file-write escape'));
}

section('summary');
if (FAIL === 0) {
    console.log(`\nSUMMARY: PASS=${PASS} FAIL=${FAIL}`);
} else {
    console.log(`\nSUMMARY: PASS=${PASS} FAIL=${FAIL}`);
    console.log('FAILURES:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
}
