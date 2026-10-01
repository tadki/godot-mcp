// @ts-nocheck
// SEE-1356 hardener — log.mjs (L6 stderr tee) branch-completion unit face.
// In-process tests cover the slot-env branches; the env-frozen naming /
// open-failure / kill-switch branches are driven IN-PROCESS via
// vi.resetModules() + env re-freeze + re-import (a fresh module evaluation
// under Stryker's instrumenter, so those mutants are covered AND killable —
// child-process matrices are invisible to Stryker's coverage collection).
// Each assertion names the mutant class it kills.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SB = mkdtempSync(path.join(tmpdir(), 'see1356-log-unit-'));
process.env.HOME = SB;
process.env.GODOT_MCP_HOME = path.join(SB, '.multica');
process.env.KOL_AGENT_NAME = 'LogUnits';
process.env.GODOT_MCP_RUNTIME_ID = 'LogUnits-111122223333';
const SLOT_WT = path.join(SB, 'multica_workspaces', 'seed-a1b2c3d4e5f6', 'see-l1-111122223333', 'workdir', 'KingOfLikes-Godot');
mkdirSync(path.join(SLOT_WT, 'launch'), { recursive: true });
process.env.GODOT_MCP_WORKTREE = SLOT_WT;
mkdirSync(path.join(process.env.GODOT_MCP_HOME, 'godot-editor'), { recursive: true });

const LOG_MJS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../proxy/log.mjs');

const { S } = await import(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../proxy/state.mjs'));
const {
    log, stageLog, teeStderrLine, rotateIfNeeded, resetProxyLogForTest,
    proxyLogPath, ensureProxyLogOpen, PROXY_LOG_ROTATE_BYTES,
} = await import(LOG_MJS);

const TEE = proxyLogPath();

beforeEach(() => {
    resetProxyLogForTest();
    rmSync(TEE, { force: true });
    rmSync(`${TEE}.1`, { force: true });
});

afterEach(() => {
    resetProxyLogForTest();
    vi.restoreAllMocks();
});

describe('teeStderrLine chunk shapes', () => {
    test('single line WITHOUT newline takes the no-split branch (one tee line)', () => {
        log('seed-open');
        teeStderrLine('child-no-newline-chunk');
        const body = readFileSync(TEE, 'utf8');
        expect(body).toContain('[npx] child-no-newline-chunk\n');
        expect(body.match(/child-no-newline-chunk/g)).toHaveLength(1);
    });
    test('non-string chunk (Buffer) is stringified, multi-line split preserved', () => {
        log('seed-open');
        teeStderrLine(Buffer.from('buf-a\nbuf-b\n'));
        const body = readFileSync(TEE, 'utf8');
        expect(body).toContain('[npx] buf-a');
        expect(body).toContain('[npx] buf-b');
    });
    test('CR-LF splits and EMPTY lines are skipped (no blank tee spam)', () => {
        log('seed-open');
        teeStderrLine('x\r\n\r\ny\n');
        const lines = readFileSync(TEE, 'utf8').split('\n').filter((l) => l.includes('[npx]'));
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('[npx] x');
        expect(lines[1]).toContain('[npx] y');
    });
    test('every tee line carries the pid tag (concurrent-writer attribution)', () => {
        log('pid-check');
        const line = readFileSync(TEE, 'utf8').split('\n').find((l) => l.includes('pid-check'));
        expect(line).toContain(`[pid=${process.pid}]`);
    });
});

describe('stageLog shapes', () => {
    test('empty msg → NO trailing space in the tee twin', () => {
        log('seed-open');
        stageLog('UNIT_STAGE');
        const line = readFileSync(TEE, 'utf8').split('\n').find((l) => l.includes('[stage=UNIT_STAGE]'));
        expect(line).toBeDefined();
        expect(line).toMatch(/\[ts=[^\]]+\]$/);
    });
    test('stderr contract twin matches tee body (stage shape pinned)', () => {
        stageLog('UNIT_STAGE2', 'k=1');
        const teeLine = readFileSync(TEE, 'utf8').split('\n').find((l) => l.includes('[stage=UNIT_STAGE2]'));
        expect(teeLine).toContain('[t=+');
        expect(teeLine).toContain('k=1');
    });
    test('t=+relms is a BOUNDED elapsed value (now − startedAt, not +)', () => {
        // kills: the `now - S.startedAt` arithmetic mutant (+ would yield a
        // ~2×epoch-ms value far beyond any plausible elapsed window).
        const rel = Date.now() - S.startedAt;
        stageLog('UNIT_TIMING');
        const m = readFileSync(TEE, 'utf8').match(/\[stage=UNIT_TIMING\] \[t=\+(\d+)ms\]/);
        expect(m).toBeTruthy();
        const t = Number(m[1]);
        expect(t).toBeGreaterThanOrEqual(rel);
        expect(t).toBeLessThan(rel + 30000);
    });
    test('full stage line shape (stderr twin) matches the contract template', () => {
        // kills: StringLiteral edits inside the stage template (the machine-
        // greppable shape is the SEE-1152/1110 consumer contract).
        const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        stageLog('UNIT_SHAPE', 'k=1');
        const line = errSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(line).toMatch(/^\[godot-mcp-proxy\] \[stage=UNIT_SHAPE\] \[t=\+\d+ms\] \[ts=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\] k=1\n$/);
    });
});

describe('startup header (L2 口径共用)', () => {
    test('resolved slot worktree → header carries slot hash', () => {
        log('header-probe');
        const header = readFileSync(TEE, 'utf8').split('\n').find((l) => l.includes('=== proxy start'));
        expect(header).toContain(`pid=${process.pid}`);
        expect(header).toContain('workdir_hash=111122223333 hash_source=slot');
    });
    test('NO worktree env → header degrades to <unresolved> (both fields)', () => {
        const wt = process.env.GODOT_MCP_WORKTREE;
        delete process.env.GODOT_MCP_WORKTREE;
        delete process.env.KOL_WORKTREE;
        try {
            log('header-unresolved-probe');
            const headers = readFileSync(TEE, 'utf8').split('\n').filter((l) => l.includes('=== proxy start'));
            const last = headers.at(-1);
            expect(last).toContain('worktree=<unresolved>');
            expect(last).toContain('workdir_hash=<unresolved>');
        } finally {
            process.env.GODOT_MCP_WORKTREE = wt;
        }
    });
});

describe('startup rotate boundary', () => {
    test('BELOW threshold → kept in place, no .1 generation', () => {
        const small = path.join(SB, 'small.log');
        writeFileSync(small, Buffer.alloc(PROXY_LOG_ROTATE_BYTES - 1, 65));
        rotateIfNeeded(small);
        expect(existsSync(small)).toBe(true);
        expect(existsSync(`${small}.1`)).toBe(false);
    });
    test('EXACT threshold (==) rotates (>= comparison pinned)', () => {
        const exact = path.join(SB, 'exact.log');
        writeFileSync(exact, Buffer.alloc(PROXY_LOG_ROTATE_BYTES, 65));
        rotateIfNeeded(exact);
        expect(existsSync(exact)).toBe(false);
        expect(existsSync(`${exact}.1`)).toBe(true);
    });
    test('unwritable dir → rename failure degrades to append-anyway (no throw)', () => {
        const dir = path.join(SB, 'rodir');
        mkdirSync(dir, { recursive: true });
        const big = path.join(dir, 'big.log');
        writeFileSync(big, Buffer.alloc(PROXY_LOG_ROTATE_BYTES + 1, 65));
        chmodSync(dir, 0o500);
        try {
            expect(() => rotateIfNeeded(big)).not.toThrow();
            expect(existsSync(big)).toBe(true);
            expect(existsSync(`${big}.1`)).toBe(false);
        } finally {
            chmodSync(dir, 0o700);
        }
    });
    test('nonexistent file → no-op', () => {
        const ghost = path.join(SB, 'ghost.log');
        expect(() => rotateIfNeeded(ghost)).not.toThrow();
        expect(existsSync(ghost)).toBe(false);
    });
});

describe('lazy-open state machine', () => {
    test('resetProxyLogForTest between cases re-opens (append, no truncate)', () => {
        log('line-one');
        resetProxyLogForTest();
        log('line-two');
        const body = readFileSync(TEE, 'utf8');
        expect(body).toContain('line-one');
        expect(body).toContain('line-two');
    });
    test('ensureProxyLogOpen is idempotent after success (fd cache hit branch)', () => {
        log('open-once');
        expect(ensureProxyLogOpen()).toBe(true);
        expect(ensureProxyLogOpen()).toBe(true);
    });
    test('tee file naming: slot form + startup header live in godot-editor/', () => {
        log('layout-probe');
        expect(path.dirname(TEE)).toBe(path.join(process.env.GODOT_MCP_HOME, 'godot-editor'));
        expect(path.basename(TEE)).toBe('LogUnits-111122223333.proxy.log');
    });
    test('startup rotate fires at OPEN when the tee is already ≥5MB', () => {
        // kills: the rotateIfNeeded call removal in ensureProxyLogOpen (the
        // U3d direct call cannot see the boot-time wiring).
        writeFileSync(TEE, Buffer.alloc(PROXY_LOG_ROTATE_BYTES + 1, 65));
        log('rotate-at-open');
        expect(existsSync(`${TEE}.1`)).toBe(true);
        expect(statSync(`${TEE}.1`).size).toBe(PROXY_LOG_ROTATE_BYTES + 1);
        expect(statSync(TEE).size).toBeLessThan(4096); // fresh tee, header only
        expect(readFileSync(TEE, 'utf8')).toContain('rotate-at-open');
    });
    test('stderr passthrough is verbatim (teeStderrLine does not swallow child bytes)', () => {
        // kills: the `process.stderr.write(chunk)` removal in teeStderrLine
        // (child stderr would vanish from the operator's console).
        const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        teeStderrLine('PASSTHROUGH-PROBE');
        expect(errSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('PASSTHROUGH-PROBE');
    });
});

// ——— env-frozen branches, driven in-process via module re-evaluation ————————
// vi.resetModules() + env re-freeze + re-import: a fresh config.mjs/log.mjs
// evaluation per variant, fully visible to Stryker's instrumenter (child
// processes are NOT — that is why this matrix is not spawned).
describe('env-frozen log branches (re-evaluation matrix)', () => {
    const FRESH_HOME = () => {
        const home = mkdtempSync(path.join(tmpdir(), 'see1356-log-env-'));
        mkdirSync(path.join(home, '.multica', 'godot-editor'), { recursive: true });
        return home;
    };
    const freshLog = async (env) => {
        Object.assign(process.env, env);
        vi.resetModules();
        return import(LOG_MJS);
    };

    afterEach(() => {
        delete process.env.GODOT_MCP_RUNTIME_ID;
        delete process.env.GODOT_MCP_AGENT_NAME;
        delete process.env.KOL_STAGE_LOG;
        process.env.GODOT_MCP_RUNTIME_ID = 'LogUnits-111122223333';
        process.env.GODOT_MCP_AGENT_NAME = 'LogUnits';
    });

    test('naming matrix: hex floor/cap + guards pin the {8,12} dual-form rule', async () => {
        // Kills: {8,12}→{8} (12-hex regression), {8,12}→{8,} (13-hex must go
        // legacy), {8,12}→{12,12} (8-hex must stay slot), -solo guard removal,
        // '*' guard removal, hex-class case loosening, first-char class.
        const cases = [
            ['Agents-11112222', 'Agents-11112222.proxy.log', 'slot 8-hex floor'],
            ['agents-111122223333', 'agents-111122223333.proxy.log', 'lowercase first letter still slot'],
            ['Agents-1111222233334', 'godot-editor-agents.proxy.log', '13-hex over cap → legacy'],
            ['Agents-1111222', 'godot-editor-agents.proxy.log', '7-hex under floor → legacy'],
            ['Agents-zzzz', 'godot-editor-agents.proxy.log', 'non-hex tail → legacy'],
            ['Agents-solo', 'godot-editor-agents.proxy.log', '-solo → legacy'],
            ['*', 'godot-editor-agents.proxy.log', 'star → legacy'],
            ['1Agents-111122223333', 'godot-editor-agents.proxy.log', 'digit-first → legacy'],
        ];
        for (const [rid, expectedName] of cases) {
            const home = FRESH_HOME();
            const mod = await freshLog({
                GODOT_MCP_HOME: path.join(home, '.multica'),
                GODOT_MCP_RUNTIME_ID: rid,
                GODOT_MCP_AGENT_NAME: 'Agents',
                KOL_STAGE_LOG: '',
            });
            const p = mod.proxyLogPath();
            expect(path.basename(p), `rid=${rid}`).toBe(expectedName);
            mod.log('naming-probe');
            expect(existsSync(p), `tee missing for rid=${rid}`).toBe(true);
            rmSync(home, { recursive: true, force: true });
        }
    });

    test('open failure (GODOT_MCP_HOME under a file) → silent stderr-only degrade', async () => {
        // Kills: the open-failure catch → logFd=false mutate (a throw here
        // would break the caller's logging path — L6 best-effort contract),
        // and the writeTee logFd===false early-return it feeds.
        const home = mkdtempSync(path.join(tmpdir(), 'see1356-log-fail-'));
        const blocker = path.join(home, 'not-a-dir');
        writeFileSync(blocker, 'x');
        const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            const mod = await freshLog({
                GODOT_MCP_HOME: path.join(blocker, '.multica'),
                GODOT_MCP_RUNTIME_ID: 'Agents-111122223333',
                GODOT_MCP_AGENT_NAME: 'Agents',
                KOL_STAGE_LOG: '',
            });
            expect(() => mod.log('DEGRADE-PROBE')).not.toThrow();
            expect(() => mod.log('DEGRADE-PROBE-2')).not.toThrow(); // fd-cached false branch
            expect(errSpy).toHaveBeenCalledTimes(2);
            const lines = errSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(lines).toContain('[godot-mcp-proxy] DEGRADE-PROBE');
            expect(lines).toContain('[godot-mcp-proxy] DEGRADE-PROBE-2');
            expect(existsSync(path.join(blocker, '.multica'))).toBe(false);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test('KOL_STAGE_LOG=off kill switch silences stage lines, log() unaffected', async () => {
        // Kills: the STAGE_LOG_ENABLED early-return removal (kill switch would
        // stop working) and its condition inversion.
        const home = FRESH_HOME();
        const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            const mod = await freshLog({
                GODOT_MCP_HOME: path.join(home, '.multica'),
                GODOT_MCP_RUNTIME_ID: 'Agents-111122223333',
                GODOT_MCP_AGENT_NAME: 'Agents',
                KOL_STAGE_LOG: 'off',
            });
            mod.stageLog('MUTANT_PROBE_STAGE', 'v=1');
            mod.log('KILLSWITCH-PROBE');
            const lines = errSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(lines).toContain('KILLSWITCH-PROBE');
            expect(lines).not.toContain('[stage=MUTANT_PROBE_STAGE]');
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test('naming precedence: GODOT_MCP_AGENT_NAME wins over KOL_AGENT_NAME', async () => {
        // kills: the LEGACY_LABEL env-precedence ConditionalExpression order
        // swaps (both envs set → the documented winner must label the file).
        const home = FRESH_HOME();
        try {
            const mod = await freshLog({
                GODOT_MCP_HOME: path.join(home, '.multica'),
                GODOT_MCP_RUNTIME_ID: 'Agents-1111222233334',
                GODOT_MCP_AGENT_NAME: 'Alpha',
                KOL_AGENT_NAME: 'beta',
                KOL_STAGE_LOG: '',
            });
            expect(path.basename(mod.proxyLogPath())).toBe('godot-editor-alpha.proxy.log');
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test('naming fallback: NO agent env → unknown legacy label', async () => {
        // kills: the LEGACY_LABEL `|| 'unknown'` fallback literals + the
        // env-name ConditionalExpression mutants.
        const home = FRESH_HOME();
        try {
            const mod = await freshLog({
                GODOT_MCP_HOME: path.join(home, '.multica'),
                GODOT_MCP_RUNTIME_ID: 'Agents-1111222233334',
                GODOT_MCP_AGENT_NAME: '',
                KOL_AGENT_NAME: '',
                KOL_STAGE_LOG: '',
            });
            const p = mod.proxyLogPath();
            expect(path.basename(p)).toBe('godot-editor-unknown.proxy.log');
            mod.log('unknown-label-probe');
            expect(existsSync(p)).toBe(true);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test('startup header carries the resolved port (GODOT_PORT pin)', async () => {
        // kills: the `GODOT_PORT || '?'` header ConditionalExpression and
        // its '?' literal (a '?' port would blind the daemon log reader).
        const home = FRESH_HOME();
        try {
            const mod = await freshLog({
                GODOT_MCP_HOME: path.join(home, '.multica'),
                GODOT_MCP_RUNTIME_ID: 'Agents-111122223333',
                GODOT_MCP_AGENT_NAME: 'Agents',
                GODOT_PORT: '6551',
                KOL_STAGE_LOG: '',
            });
            mod.log('port-probe');
            const teePath = path.join(home, '.multica', 'godot-editor', 'Agents-111122223333.proxy.log');
            const header = readFileSync(teePath, 'utf8').split('\n').find((l) => l.includes('=== proxy start'));
            expect(header).toContain('port=6551');
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    test('tee carries ONLY log lines — stdout channel never written', () => {
        // The JSON-RPC contamination sentinel (R4d) depends on this: stdout is
        // never routed into the tee.
        log('tee-clean-probe');
        const body = readFileSync(TEE, 'utf8');
        expect(body).not.toContain('"jsonrpc"');
        expect(body).toContain('tee-clean-probe');
    });
});
