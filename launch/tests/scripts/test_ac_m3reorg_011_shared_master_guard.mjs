#!/usr/bin/env node
// SEE-1273 AC-M3REORG-011: isSharedMasterWorktree empty-guard unit test.
//
// Extracts the REAL function + its env-const from the split proxy module
// (launch/proxy/config.mjs — SEE-1334 Phase 0a moved both out of the monolith
// entry; eval, no re-implementation) and drives it under both env shapes:
//   (a) GODOT_MCP_SHARED_MASTER='' → guard must return false for every path
//       (pre-fix bug: startsWith('' + '/') was true for all absolute paths)
//   (b) GODOT_MCP_SHARED_MASTER=<real path> → matches that path + children only
// Run: node launch/tests/scripts/test_ac_m3reorg_011_shared_master_guard.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.resolve(HERE, '..', '..', 'proxy', 'config.mjs');
const src = fs.readFileSync(PROXY, 'utf8');

let PASS = 0, FAIL = 0;
const ok = (name) => { PASS++; console.log(`  ok: ${name}`); };
const bad = (name) => { FAIL++; console.log(`  FAIL: ${name}`); };

// Eval the const assignment + the full function verbatim from the proxy, then
// return the live function — the test must exercise the REAL body, not a copy.
function bindGuard(sharedMaster) {
    const constLine = src.match(/const SHARED_MASTER_WORKTREE = [^;]+;/);
    if (!constLine) throw new Error('SHARED_MASTER_WORKTREE const not found');
    const fnStart = src.indexOf('function isSharedMasterWorktree');
    if (fnStart === -1) throw new Error('function not found');
    let depth = 0, fnEnd = -1;
    for (let i = src.indexOf('{', fnStart); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
    }
    const fnBody = src.slice(fnStart, fnEnd);
    return (new Function('process', `${constLine[0]}\n${fnBody}\nreturn isSharedMasterWorktree;`))({
        env: { GODOT_MCP_SHARED_MASTER: sharedMaster },
    });
}

console.log('== AC-M3REORG-011.1: empty-string env → guard returns false for every path ==');
const guardEmpty = bindGuard('');
['/mnt/d/GodotProjects/king-of-likes', '/home/x/multica_workspaces/seed-ws/see-1-aaaa/workdir/KingOfLikes-Godot', '/tmp/anywhere', '/'].forEach((wt) => {
    guardEmpty(wt) === false ? ok(`'' env: ${wt} → false`) : bad(`'' env: ${wt} misjudged as shared master`);
});

console.log('== AC-M3REORG-011.2: undefined env → guard returns false ==');
const guardUndef = bindGuard(undefined);
guardUndef('/mnt/d/GodotProjects/king-of-likes') === false ? ok('undefined env → false') : bad('undefined env misjudged');

console.log('== AC-M3REORG-011.3: real KOL env → correct matching ==');
const guardReal = bindGuard('/mnt/d/GodotProjects/king-of-likes');
guardReal('/mnt/d/GodotProjects/king-of-likes') === true ? ok('exact match → true') : bad('exact match missed');
guardReal('/mnt/d/GodotProjects/king-of-likes/sub/dir') === true ? ok('child path → true') : bad('child path missed');
guardReal('/mnt/d/GodotProjects/king-of-likes-other') === false ? ok('sibling prefix (no slash boundary) → false') : bad('sibling prefix misjudged');
guardReal('/home/x/multica_workspaces/seed-ws/see-1-aaaa/workdir/KingOfLikes-Godot') === false ? ok('agent worktree → false') : bad('agent worktree misjudged');
guardReal('') === false ? ok('empty worktree input → false') : bad('empty worktree misjudged');

console.log(`\n==== AC-M3REORG-011: PASS=${PASS} FAIL=${FAIL} ====`);
process.exit(FAIL === 0 ? 0 : 1);
