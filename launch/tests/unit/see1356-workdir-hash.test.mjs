// SEE-1356 hardener — workdir-hash.mjs (L2 SSOT consumer) branch-completion
// unit face. The module shells out to launch/runtime.lib.sh kol_workdir_hash;
// the happy paths are covered by test_see1356_proxy_units.mjs U4 (untouched).
// THIS file drives the degrade branches that U4 cannot reach, via a PATH-
// stubbed `bash` (the only seam the module exposes — no production change).
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SB = mkdtempSync(path.join(tmpdir(), 'see1356-wdh-unit-'));
process.env.HOME = SB;
process.env.GODOT_MCP_HOME = path.join(SB, '.multica');
const SLOT_WT = path.join(SB, 'multica_workspaces', 'seed-a1b2c3d4e5f6', 'see-w1-111122223333', 'workdir', 'KingOfLikes-Godot');
mkdirSync(path.join(SLOT_WT, 'launch'), { recursive: true });

const { resolveWorkdirHash } = await import('../../../proxy/workdir-hash.mjs');
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

const STUB_DIR = path.join(SB, 'stubbin');
let savedPath = '';

function stubBash(script) {
    mkdirSync(STUB_DIR, { recursive: true });
    const stub = path.join(STUB_DIR, 'bash');
    writeFileSync(stub, `#!/bin/bash\n${script}\n`);
    chmodSync(stub, 0o755);
}

beforeEach(() => {
    savedPath = process.env.PATH;
    rmSync(STUB_DIR, { recursive: true, force: true });
});

afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(STUB_DIR, { recursive: true, force: true });
});

describe('resolveWorkdirHash happy paths (SSOT contract)', () => {
    test('slot form → slot hash + slot provenance', () => {
        expect(resolveWorkdirHash(SLOT_WT)).toEqual({ workdir_hash: '111122223333', hash_source: 'slot' });
    });
    test('non-slot path → sha256(realpath)[:8] + path provenance', () => {
        const r = resolveWorkdirHash(REPO);
        expect(r.workdir_hash).toMatch(/^[0-9a-f]{8}$/);
        expect(r.hash_source).toBe('path');
    });
    test('empty input short-circuits before any exec', () => {
        expect(resolveWorkdirHash('')).toBeNull();
    });
});

describe('resolveWorkdirHash degrade branches (PATH-stubbed bash)', () => {
    // kills: the helper-output regex deletion/loosening (L25), the slot|path
    // provenance whitelist removal (L26), and the exec-failure catch (L27).
    test('helper prints a NON-HEX hash → null (no fabricated identity)', () => {
        stubBash('echo "ZZZZ4444 slot"');
        process.env.PATH = `${STUB_DIR}:${process.env.PATH}`;
        expect(resolveWorkdirHash(SLOT_WT)).toBeNull();
    });
    test('helper prints no hash at all (empty output) → null', () => {
        stubBash('echo ""');
        process.env.PATH = `${STUB_DIR}:${process.env.PATH}`;
        expect(resolveWorkdirHash(SLOT_WT)).toBeNull();
    });
    test('helper prints a 1-hex hash (regex floor boundary) → rejected', () => {
        // kills: /^[0-9a-f]{1,64}$/ floor-widening mutants ({1,64}→{2,64}).
        stubBash('echo "a slot"');
        process.env.PATH = `${STUB_DIR}:${process.env.PATH}`;
        expect(resolveWorkdirHash(SLOT_WT)).toEqual({ workdir_hash: 'a', hash_source: 'slot' });
    });
    test('helper prints a 65-hex hash (regex ceiling boundary) → rejected', () => {
        // kills: /^[0-9a-f]{1,64}$/ ceiling-widening mutants ({1,64}→{1,65}).
        stubBash('echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa slot"');
        process.env.PATH = `${STUB_DIR}:${process.env.PATH}`;
        expect(resolveWorkdirHash(SLOT_WT)).toBeNull();
    });
    test('helper prints a 64-hex hash (exact ceiling) → accepted', () => {
        stubBash('echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa slot"');
        process.env.PATH = `${STUB_DIR}:${process.env.PATH}`;
        expect(resolveWorkdirHash(SLOT_WT)).toEqual({
            workdir_hash: 'a'.repeat(64), hash_source: 'slot',
        });
    });
    test('helper prints an UNKNOWN provenance → hash kept, hash_source null', () => {
        stubBash('echo "abc123d4 mystery_source"');
        process.env.PATH = `${STUB_DIR}:${process.env.PATH}`;
        expect(resolveWorkdirHash(SLOT_WT)).toEqual({ workdir_hash: 'abc123d4', hash_source: null });
    });
    test('helper fails to exec (exit 7) → null (best-effort, never throws)', () => {
        stubBash('exit 7');
        process.env.PATH = `${STUB_DIR}:${process.env.PATH}`;
        expect(resolveWorkdirHash(SLOT_WT)).toBeNull();
    });
    // Runs ONLY under SEE1356_UNIT_SLOW=1: the 10s stall is the production
    // execFileSync timeout, which cannot be shrunk from the test side — and
    // the Stryker face re-runs the whole suite PER MUTANT, where this case
    // would multiply the whitelist run by ~3x for zero additional kill class
    // (the timeout kill lands in the SAME catch as the exit-7 case above).
    test.runIf(process.env.SEE1356_UNIT_SLOW === '1')('helper times out → null (never hang the caller)', () => {
        stubBash('sleep 30');
        process.env.PATH = `${STUB_DIR}:${process.env.PATH}`;
        expect(resolveWorkdirHash(SLOT_WT)).toBeNull();
    }, 20000);
});
