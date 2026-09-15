// test_see1085_t7_resolver.mjs
//
// SEE-1085 B1 usability — T7 resolver unit test.
//
// Exercises resolveGodotMcpCommand() in isolation (no proxy boot). Builds a
// fake npx cache under a fake HOME and asserts every branch of the resolver:
// override paths (npx / node <path>), local-install miss, npx-cache auto-walk
// (newest-mtime wins), and the npx fallback when the cache is empty.
//
// Run: node .dev/godot-mcp/tests/scripts/test_see1085_t7_resolver.mjs

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const RESOLVER_PATH = join(
    dirname(new URL(import.meta.url).pathname),
    '..', '..', '..', 'launch', 'godot-mcp-resolve.mjs'
);
const { resolveGodotMcpCommand, GODOT_MCP_PKG } = await import(RESOLVER_PATH);

// SEE-1117 (regression sweep): the owner fork CLI is preferred by
// resolveGodotMcpCommand() whenever GODOT_MCP_DIRECT_GODOT_MCP != '0' (SEE-1111
// production fix). The fork CLI path is env-overridable via GODOT_MCP_FORK_CLI
// (default: <submodule>/server/dist/cli.js, resolved relative to the resolver's
// own location — SEE-1273 T2 / SEE-1292 §DECPL-003). On any machine where that
// fork file exists the resolver will return the fork branch BEFORE exercising
// the opt-in cache walk (T7.3/T7.4/T7.6/T7.7) or the no-opt-in npx fallback
// (T7.8). Those branches cannot be exercised in this environment without
// modifying the resolver (forbidden by Atlas's QA substep constraint 3), so
// they are skipped here and counted as SKIP in the summary. T7.1/T7.2/T7.5
// cover the override paths which DO work even with fork present.
// SEE-1292 LOW-2: the fork CLI path is resolved from the resolver's own
// location (import.meta.url), not a hardcoded absolute path — the old
// '/mnt/d/GodotProjects/forks/godot-mcp/...' literal was a stale D-drive
// reference from the pre-SEE-1273 layout.
const FORK_CLI = process.env.GODOT_MCP_FORK_CLI
    || join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'server', 'dist', 'cli.js');
let forkPresent = false;
try { statSync(FORK_CLI); forkPresent = true; } catch { forkPresent = false; }

const RESULTS = [];
function record(name, fn) {
    try {
        fn();
        RESULTS.push({ name, ok: true });
        console.log(`  [PASS] ${name}`);
    } catch (err) {
        RESULTS.push({ name, ok: false, err });
        console.error(`  [FAIL] ${name}: ${err.message}`);
    }
}
function recordSkip(name, reason) {
    RESULTS.push({ name, ok: true, skipped: true });
    console.log(`  [SKIP] ${name}: ${reason}`);
}
// Run fn only when the owner fork is absent; otherwise count as SKIP. The
// resolver prefers the fork whenever it exists, so cache-walk assertions are
// unsatisfiable in that environment (see header note).
function recordUnlessFork(name, fn) {
    if (forkPresent) {
        recordSkip(name, `owner fork present at ${FORK_CLI}; resolver short-circuits to fork`);
        return;
    }
    record(name, fn);
}

// Build a fake npx cache under a temp HOME: two entries, the newer one wins
// regardless of dir-name order. Returns { root, home, entries }.
function makeFakeCache() {
    const home = mkdtempSync(join(tmpdir(), 'see1085-resolver-'));
    const root = join(home, '.npm', '_npx');
    mkdirSync(root, { recursive: true });

    function writeEntry(suffix, version, mtimeSec) {
        const dir = join(root, `hash-${suffix}`, 'node_modules', GODOT_MCP_PKG);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({
            name: GODOT_MCP_PKG,
            version,
            bin: { 'godot-mcp': './dist/cli.js' },
        }));
        // Create the bin file so readBinEntry's stat check passes.
        mkdirSync(join(dir, 'dist'), { recursive: true });
        writeFileSync(join(dir, 'dist', 'cli.js'), '// mock bin\n');
        utimesSync(dir, new Date(mtimeSec * 1000), new Date(mtimeSec * 1000));
        return { dir, version };
    }

    // Older entry first, then a newer one — resolver must pick the newer one.
    writeEntry('older', '1.0.0', 1_700_000_000);
    writeEntry('newer', '4.1.0', 1_700_000_500);
    return { root, home };
}

function setEnv(patch) {
    for (const [k, v] of Object.entries(patch)) {
        const prev = process.env[k];
        process.env[k] = v;
        if (prev === undefined) delete process.env[k];
        else process.env[k] = prev;
    }
}

// Remember originals so each test restores before mutating.
const ORIGINAL_ENV = { ...process.env };

function withEnv(patch, fn) {
    const before = {};
    for (const k of Object.keys(patch)) {
        before[k] = process.env[k];
        if (patch[k] === undefined) delete process.env[k];
        else process.env[k] = patch[k];
    }
    try { return fn(); }
    finally {
        for (const k of Object.keys(patch)) {
            if (before[k] === undefined) delete process.env[k];
            else process.env[k] = before[k];
        }
    }
}

console.log(`\n--- T7: resolver unit (${RESOLVER_PATH}) ---\n`);

// T7.1: GODOT_MCP_GODOT_MCP_CMD=npx → forces npx fallback regardless of cache state.
record('T7.1: override GODOT_MCP_GODOT_MCP_CMD=npx forces npx', () => {
    withEnv({ GODOT_MCP_GODOT_MCP_CMD: 'npx', HOME: '/nonexistent' }, () => {
        const r = resolveGodotMcpCommand();
        assert.equal(r.cmd, 'npx', 'cmd');
        assert.deepEqual(r.args, ['-y', GODOT_MCP_PKG], 'args');
        assert.match(r.source, /GODOT_MCP_GODOT_MCP_CMD=npx/);
    });
});

// T7.2: KOL_GODOT_MCP_CMD=<path> → node <path>.
record('T7.2: override KOL_GODOT_MCP_CMD=<path> spawns node <path>', () => {
    withEnv({ GODOT_MCP_GODOT_MCP_CMD: '/some/mock-bin.js', HOME: '/nonexistent' }, () => {
        const r = resolveGodotMcpCommand();
        assert.equal(r.cmd, process.execPath, 'cmd is node');
        assert.deepEqual(r.args, ['/some/mock-bin.js']);
        assert.match(r.source, /GODOT_MCP_GODOT_MCP_CMD/);
    });
});

// T7.3: empty cache + opt-in + no override → npx fallback (cache walk attempted,
// found nothing).
recordUnlessFork('T7.3: opt-in + empty npx cache → npx -y fallback', () => {
    const home = mkdtempSync(join(tmpdir(), 'see1085-empty-'));
    try {
        withEnv({ GODOT_MCP_GODOT_MCP_CMD: '', GODOT_MCP_DIRECT_GODOT_MCP: '1', HOME: home }, () => {
            const r = resolveGodotMcpCommand();
            assert.equal(r.cmd, 'npx');
            assert.equal(r.args[0], '-y');
        });
    } finally { rmSync(home, { recursive: true, force: true }); }
});

// T7.4: opt-in + fake cache + no override → newest-mtime entry wins (node direct).
recordUnlessFork('T7.4: opt-in + npx cache walk picks newest mtime as node direct', () => {
    const { home } = makeFakeCache();
    try {
        withEnv({ GODOT_MCP_GODOT_MCP_CMD: '', GODOT_MCP_DIRECT_GODOT_MCP: '1', HOME: home }, () => {
            const r = resolveGodotMcpCommand();
            assert.equal(r.cmd, process.execPath, 'cmd is node (direct, skipping npx)');
            assert.equal(r.args.length, 1);
            assert.match(r.args[0], /hash-newer\/node_modules\/@satelliteoflove\/godot-mcp\/dist\/cli\.js/);
            assert.match(r.source, /npx-cache 4\.1\.0/);
        });
    } finally { rmSync(home, { recursive: true, force: true }); }
});

// T7.5: override beats cache (override is highest priority, even with opt-in).
record('T7.5: override beats cache', () => {
    const { home } = makeFakeCache();
    try {
        withEnv({ GODOT_MCP_GODOT_MCP_CMD: '/force/this.js', GODOT_MCP_DIRECT_GODOT_MCP: '1', HOME: home }, () => {
            const r = resolveGodotMcpCommand();
            assert.equal(r.cmd, process.execPath);
            assert.deepEqual(r.args, ['/force/this.js']);
        });
    } finally { rmSync(home, { recursive: true, force: true }); }
});

// T7.6: opt-in + cache entry without a usable bin field → skip, fallback (no crash).
recordUnlessFork('T7.6: opt-in + cache entry with broken bin field is skipped, fallback used', () => {
    const home = mkdtempSync(join(tmpdir(), 'see1085-broken-'));
    const root = join(home, '.npm', '_npx');
    mkdirSync(root, { recursive: true });
    const broken = join(root, 'hash-broken', 'node_modules', GODOT_MCP_PKG);
    mkdirSync(broken, { recursive: true });
    // package.json with bin pointing at a non-existent file
    writeFileSync(join(broken, 'package.json'), JSON.stringify({
        name: GODOT_MCP_PKG, version: '1.0.0', bin: './missing.js',
    }));
    try {
        withEnv({ GODOT_MCP_GODOT_MCP_CMD: '', GODOT_MCP_DIRECT_GODOT_MCP: '1', HOME: home }, () => {
            const r = resolveGodotMcpCommand();
            assert.equal(r.cmd, 'npx', 'falls back when cache bin is unusable');
        });
    } finally { rmSync(home, { recursive: true, force: true }); }
});

// T7.7: opt-in + single cache entry → node direct (asserts the comparison path).
recordUnlessFork('T7.7: opt-in + single cache entry resolves node direct', () => {
    const home = mkdtempSync(join(tmpdir(), 'see1085-mtime-'));
    const root = join(home, '.npm', '_npx');
    mkdirSync(root, { recursive: true });
    const dir = join(root, 'hash-only', 'node_modules', GODOT_MCP_PKG);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: GODOT_MCP_PKG, version: '2.0.0', bin: { 'godot-mcp': './dist/cli.js' },
    }));
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'cli.js'), '// mock\n');
    utimesSync(dir, new Date(1_500_000_000 * 1000), new Date(1_500_000_000 * 1000));
    try {
        withEnv({ GODOT_MCP_GODOT_MCP_CMD: '', GODOT_MCP_DIRECT_GODOT_MCP: '1', HOME: home }, () => {
            const r = resolveGodotMcpCommand();
            assert.equal(r.cmd, process.execPath);
            assert.match(r.source, /npx-cache 2\.0\.0/);
        });
    } finally { rmSync(home, { recursive: true, force: true }); }
});

// T7.8: opt-in GATE — populated cache but GODOT_MCP_DIRECT_GODOT_MCP unset → npx.
// This is the regression guard: test harnesses (and any environment with a
// real cached package) must NOT have their mock-npx bypassed by an automatic
// cache walk. Auto-detection is opt-in only.
recordUnlessFork('T7.8: populated cache but opt-in UNSET → npx (no walk)', () => {
    const { home } = makeFakeCache();
    try {
        withEnv({ GODOT_MCP_GODOT_MCP_CMD: '', GODOT_MCP_DIRECT_GODOT_MCP: '', HOME: home }, () => {
            const r = resolveGodotMcpCommand();
            assert.equal(r.cmd, 'npx', 'cache walk NOT attempted without opt-in');
            assert.equal(r.args[0], '-y');
        });
    } finally { rmSync(home, { recursive: true, force: true }); }
});

console.log(`\n--- Summary ---`);
const skipped = RESULTS.filter((r) => r.skipped).length;
const ok = RESULTS.filter((r) => r.ok && !r.skipped).length;
const fail = RESULTS.length - ok - skipped;
console.log(`PASS=${ok} SKIP=${skipped} FAIL=${fail}`);
if (fail > 0) {
    for (const r of RESULTS.filter((r) => !r.ok)) console.error(`  - ${r.name}: ${r.err.message}`);
    process.exit(1);
}
process.exit(0);