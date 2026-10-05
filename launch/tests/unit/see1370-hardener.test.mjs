// SEE-1370 hardener reopen — StrykerJS killer face for the batch-touched
// launch/proxy segments (stryker.see1370.json mutate list). Every mutant in
// the included ranges must be killed HERE, in-process: child-process faces
// (launch/tests/scripts/test_see1356_proxy_units.mjs, test_see1338_p1_sot.mjs)
// are invisible to the Stryker vitest runner.
//   SF  state-file.mjs exitAuditAndReleaseLock (SEE-1370 #6 helper, :138-154)
//   LC  lifecycle.mjs refreshStateHeartbeat (SEE-1370 #4 tick heartbeat, :202-211)
//   LE  lease.mjs checkLeaseTail incremental tail + legacy terminal exit
//       (SEE-1370 #5 + #6, :71-99 / :119-126 — the exit face drives a REAL
//       child process at KOL_GIVEUP_REARM=0; the mutated source is imported by
//       the child, so the parent's rc/event/lock asserts still kill mutants)
//   SP  spawn.mjs beginWarmEditorRespawn (§SPEC-003 T29 disk face, :107-139)
// warmup.mjs :193-197 / :526-530 are deliberately NOT in the mutate list —
// exemption rationale lives in stryker.see1370.json (conf-level registry; the
// failedExitTerminal seam proposal is on the Final Review leftover list).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LAUNCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = (rel) => pathToFileURL(path.join(LAUNCH, rel)).href;

const SB = mkdtempSync(path.join(tmpdir(), 'see1370-hardener-'));
const MCP_HOME = path.join(SB, '.multica');
const STATE_DIR = path.join(MCP_HOME, 'godot-editor');
const LOG_FILE = path.join(MCP_HOME, 'editor.log');
mkdirSync(STATE_DIR, { recursive: true });
process.env.HOME = SB;
process.env.GODOT_MCP_HOME = MCP_HOME;
process.env.GODOT_MCP_RUNTIME_ID = 'See1370-h';
process.env.GODOT_PORT = '6599';
process.env.GODOT_EDITOR_LOG_FILE = LOG_FILE;
// in-process face NEVER takes a terminal exit; the legacy-terminal face uses
// a dedicated child process (LE8) with GODOT_MCP_GIVEUP_REARM=0.
process.env.GODOT_MCP_GIVEUP_REARM = '1';

const sf = await import(MOD('proxy/state-file.mjs'));
const { S } = await import(MOD('proxy/state.mjs'));
const lifecycle = await import(MOD('proxy/lifecycle.mjs'));
const lease = await import(MOD('proxy/lease.mjs'));
const spawnMod = await import(MOD('proxy/spawn.mjs'));
const { LEASE_EXITING_LINE } = await import(MOD('proxy/config.mjs'));

const RID = 'See1370-h';
const EVENTS = path.join(STATE_DIR, `${RID}.events.jsonl`);
const STATE_FILE = path.join(STATE_DIR, `${RID}.state`);
const LOCK_DIR = path.join(MCP_HOME, 'held-runtime', RID);

const cleanDisk = () => {
    for (const f of [STATE_FILE, EVENTS, LOG_FILE]) rmSync(f, { force: true });
    rmSync(LOCK_DIR, { recursive: true, force: true });
};
const seedWarm = (over = {}) => sf.writeRuntimeState(RID, {
    schema_version: sf.STATE_SCHEMA_VERSION,
    state: 'WARM',
    port: 6599,
    heartbeat_at: new Date().toISOString(),
    editor_pid: 424242,
    editor_pid_source: 'wsl',
    ...over,
});
const events = () => (existsSync(EVENTS)
    ? readFileSync(EVENTS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []);

// ---- SF: exitAuditAndReleaseLock -------------------------------------------------

describe('SEE-1370 SF exitAuditAndReleaseLock (state-file.mjs:138-154)', () => {
    beforeEach(cleanDisk);

    test('SF1 empty runtime id → explicit no-op result', () => {
        expect(sf.exitAuditAndReleaseLock('', 'x')).toEqual({ audited: false, lockReleased: false });
    });

    test('SF2 warm record + held lock → audited + released; state field untouched', () => {
        seedWarm();
        expect(sf.acquireRuntimeLock(RID, { ownerPid: process.pid }).locked).toBe(true);
        expect(sf.exitAuditAndReleaseLock(RID, 'sf2 detail')).toEqual({ audited: true, lockReleased: true });
        expect(existsSync(LOCK_DIR)).toBe(false);
        const ev = events().filter((e) => e.event === 'PROXY_EXIT');
        expect(ev).toHaveLength(1);
        expect(ev[0].detail).toBe('sf2 detail');
        expect(sf.readRuntimeState(RID).state.state).toBe('WARM');
    });

    test('SF3 foreign-owner lock → lockReleased false, audit still lands', () => {
        seedWarm();
        sf.acquireRuntimeLock(RID, { ownerPid: 999_999_999 });
        expect(sf.exitAuditAndReleaseLock(RID, 'sf3')).toEqual({ audited: true, lockReleased: false });
        expect(events().some((e) => e.event === 'PROXY_EXIT' && e.detail === 'sf3')).toBe(true);
    });

    test('SF5 absent lock dir → rm-anyway semantics report lockReleased true', () => {
        seedWarm();
        expect(sf.exitAuditAndReleaseLock(RID, 'sf5')).toEqual({ audited: true, lockReleased: true });
    });

    test('SF4 detail defaults to empty string', () => {
        seedWarm();
        sf.exitAuditAndReleaseLock(RID);
        expect(events().some((e) => e.event === 'PROXY_EXIT' && e.detail === '')).toBe(true);
    });
});

// ---- LC: refreshStateHeartbeat ---------------------------------------------------

describe('SEE-1370 LC refreshStateHeartbeat (lifecycle.mjs:202-211)', () => {
    beforeEach(() => {
        cleanDisk();
        S.shutdownRequested = false;
        S.lastStateHeartbeatMs = 0;
    });
    afterEach(() => {
        S.shutdownRequested = false;
        vi.useRealTimers();
    });

    test('LC1 shutdown gate: requested → no disk write, throttle stamp untouched', () => {
        seedWarm();
        S.shutdownRequested = true;
        const before = readFileSync(STATE_FILE, 'utf8');
        lifecycle.refreshStateHeartbeat();
        expect(readFileSync(STATE_FILE, 'utf8')).toBe(before);
        expect(S.lastStateHeartbeatMs).toBe(0);
    });

    test('LC2 throttle: refreshed less than 30s ago → skip', () => {
        seedWarm();
        S.lastStateHeartbeatMs = Date.now();
        const before = readFileSync(STATE_FILE, 'utf8');
        lifecycle.refreshStateHeartbeat();
        expect(readFileSync(STATE_FILE, 'utf8')).toBe(before);
    });

    test('LC3 throttle boundary: exactly 30s elapsed refreshes; 1ms inside the window skips', () => {
        vi.useFakeTimers();
        seedWarm();
        const T = Date.now();
        S.lastStateHeartbeatMs = T - 30_000;
        lifecycle.refreshStateHeartbeat();
        expect(S.lastStateHeartbeatMs).toBe(T);
        S.lastStateHeartbeatMs = T - 29_999;
        lifecycle.refreshStateHeartbeat();
        expect(S.lastStateHeartbeatMs).toBe(T - 29_999);
    });

    test('LC4 no record → nothing written, stamp stays 0', () => {
        lifecycle.refreshStateHeartbeat();
        expect(existsSync(STATE_FILE)).toBe(false);
        expect(S.lastStateHeartbeatMs).toBe(0);
    });

    test('LC5 non-WARM record → untouched', () => {
        sf.writeRuntimeState(RID, { schema_version: sf.STATE_SCHEMA_VERSION, state: 'COLD', heartbeat_at: new Date().toISOString() });
        const before = readFileSync(STATE_FILE, 'utf8');
        lifecycle.refreshStateHeartbeat();
        expect(readFileSync(STATE_FILE, 'utf8')).toBe(before);
        expect(S.lastStateHeartbeatMs).toBe(0);
    });

    test('LC6 WARM → heartbeat_at bumped on disk, stamp set', () => {
        seedWarm();
        const before = sf.readRuntimeState(RID).state.heartbeat_at;
        lifecycle.refreshStateHeartbeat();
        const after = sf.readRuntimeState(RID);
        expect(after.ok).toBe(true);
        expect(after.state.state).toBe('WARM');
        expect(after.state.heartbeat_at > before).toBe(true);
        expect(S.lastStateHeartbeatMs).toBeGreaterThan(0);
    });
});

// ---- LE: checkLeaseTail ----------------------------------------------------------

describe('SEE-1370 LE checkLeaseTail (lease.mjs:71-99 incremental + :119-126 legacy terminal)', () => {
    beforeEach(() => {
        cleanDisk();
        S.leaseOffset = 0;
        S.leaseExitDetected = false;
        S.warmupTimedOut = false;
        S.warmRespawnInFlight = false;
        S.leaseTimer = null;
        S.logTailUnavailableSince = 0;
    });

    test('LE1 missing log → offset resets, degradation signal set', async () => {
        S.leaseOffset = 512;
        await lease.checkLeaseTail();
        expect(S.leaseOffset).toBe(0);
        expect(S.logTailUnavailableSince).toBeGreaterThan(0);
    });

    test('LE2 fresh scan: complete lines consumed, offset lands at last newline', async () => {
        const content = 'preamble line\nsecond line\n';
        writeFileSync(LOG_FILE, content);
        await lease.checkLeaseTail();
        expect(S.leaseOffset).toBe(Buffer.byteLength(content));
        expect(S.leaseExitDetected).toBe(false);
    });

    test('LE3 half line waits: no trailing newline → nothing consumed', async () => {
        writeFileSync(LOG_FILE, LEASE_EXITING_LINE);
        await lease.checkLeaseTail();
        expect(S.leaseExitDetected).toBe(false);
        expect(S.leaseOffset).toBe(0);
        appendFileSync(LOG_FILE, '\n');
        await lease.checkLeaseTail();
        expect(S.leaseExitDetected).toBe(true);
        expect(S.leaseOffset).toBe(Buffer.byteLength(LEASE_EXITING_LINE + '\n'));
    });

    test('LE4 incremental: consumed preamble is never re-scanned', async () => {
        const preamble = 'preamble line\n'.repeat(10);
        writeFileSync(LOG_FILE, preamble + LEASE_EXITING_LINE + '\n');
        S.leaseOffset = Buffer.byteLength(preamble);
        await lease.checkLeaseTail();
        expect(S.leaseExitDetected).toBe(true);
        expect(S.leaseOffset).toBe(Buffer.byteLength(preamble + LEASE_EXITING_LINE + '\n'));
    });

    test('LE5 appended noise after the consumed exit line → no re-detection', async () => {
        const consumed = 'preamble line\n'.repeat(10) + LEASE_EXITING_LINE + '\n';
        writeFileSync(LOG_FILE, consumed);
        S.leaseOffset = Buffer.byteLength(consumed);
        await lease.checkLeaseTail();
        expect(S.leaseExitDetected).toBe(false);
        appendFileSync(LOG_FILE, 'noise line\n');
        await lease.checkLeaseTail();
        expect(S.leaseExitDetected).toBe(false);
        expect(S.leaseOffset).toBe(Buffer.byteLength(consumed + 'noise line\n'));
    });

    test('LE6 rotation/shrink: size < offset resets to 0 and rescans from the top', async () => {
        S.leaseOffset = 100_000;
        const shrunk = 'rotated\n' + LEASE_EXITING_LINE + '\n';
        writeFileSync(LOG_FILE, shrunk);
        await lease.checkLeaseTail();
        expect(S.leaseExitDetected).toBe(true);
        expect(S.leaseOffset).toBe(Buffer.byteLength(shrunk));
    });

    test('LE7 equal size → early-return no-op', async () => {
        const content = 'same\n';
        writeFileSync(LOG_FILE, content);
        S.leaseOffset = Buffer.byteLength(content);
        await lease.checkLeaseTail();
        expect(S.leaseOffset).toBe(Buffer.byteLength(content));
        expect(S.leaseExitDetected).toBe(false);
    });

    test('LE9 single-char line: offset advances past lastNlByte=+1 (arithmetic trap)', async () => {
        writeFileSync(LOG_FILE, 'a\n');
        await lease.checkLeaseTail();
        expect(S.leaseOffset).toBe(Buffer.byteLength('a\n'));
        expect(S.leaseExitDetected).toBe(false);
    });

    test('LE8 legacy terminal exit (KOL_GIVEUP_REARM=0 child): rc=1 + PROXY_EXIT audit + lock released', () => {
        const childHome = mkdtempSync(path.join(tmpdir(), 'see1370-lexit-'));
        const childMcp = path.join(childHome, '.multica');
        mkdirSync(path.join(childMcp, 'godot-editor'), { recursive: true });
        const childLog = path.join(childMcp, 'editor.log');
        writeFileSync(childLog, LEASE_EXITING_LINE + '\n');
        const childScript = path.join(childHome, 'child.mjs');
        writeFileSync(childScript, `
import fs from 'node:fs';
const sf = await import(${JSON.stringify(MOD('proxy/state-file.mjs'))});
const { S } = await import(${JSON.stringify(MOD('proxy/state.mjs'))});
const lease = await import(${JSON.stringify(MOD('proxy/lease.mjs'))});
const rid = process.env.GODOT_MCP_RUNTIME_ID;
sf.writeRuntimeState(rid, { schema_version: sf.STATE_SCHEMA_VERSION, state: 'WARM', port: 6599, heartbeat_at: new Date().toISOString() });
sf.acquireRuntimeLock(rid, { ownerPid: process.pid });
S.leaseOffset = 0;
await lease.checkLeaseTail();
console.log('UNREACHABLE — the legacy branch must process.exit(1)');
`);
        const r = spawnSync(process.execPath, [childScript], {
            encoding: 'utf8',
            env: {
                ...process.env,
                HOME: childHome,
                GODOT_MCP_HOME: childMcp,
                GODOT_MCP_RUNTIME_ID: 'See1370-lexit',
                GODOT_EDITOR_LOG_FILE: childLog,
                GODOT_MCP_GIVEUP_REARM: '0',
                KOL_PROGRESS_PROTOCOL: 'off',
            },
        });
        expect(r.status).toBe(1);
        expect(r.stdout).not.toContain('UNREACHABLE');
        expect(existsSync(path.join(childMcp, 'held-runtime', 'See1370-lexit'))).toBe(false);
        const ev = readFileSync(path.join(childMcp, 'godot-editor', 'See1370-lexit.events.jsonl'), 'utf8');
        expect(ev).toContain('"event":"PROXY_EXIT"');
        expect(ev).toContain('lease self-exit FAILED_EXIT (legacy terminal)');
        expect(existsSync(path.join(childMcp, 'godot-editor', 'See1370-lexit.state'))).toBe(true);
    });
});

// ---- SP: beginWarmEditorRespawn --------------------------------------------------

describe('SEE-1370 SP beginWarmEditorRespawn (spawn.mjs:107-139)', () => {
    beforeEach(() => {
        cleanDisk();
        S.warmRespawnInFlight = false;
        S.warmEditorDead = false;
        S.warm = true;
        S.recovering = true;
        S.renderStable = true;
        S.spawnTriggered = true;
        S.warmupTimeoutMs = 4321;
        S.recoveryRound = 3;
        S.recoveryWindowStart = 111;
    });

    test('SP1 death call: disk COLD + identity cleared + audit line + recovery state reset', () => {
        seedWarm();
        spawnMod.beginWarmEditorRespawn();
        const after = sf.readRuntimeState(RID);
        expect(after.ok).toBe(true);
        expect(after.state.state).toBe('COLD');
        expect(after.state.editor_pid).toBe(null);
        expect(after.state.editor_pid_started_at).toBe(null);
        expect(after.state.port).toBe(6599);
        expect(after.state.last_error).toBe('editor gone after warmup; respawn armed');
        const eg = events().filter((e) => e.event === 'EDITOR_GONE');
        expect(eg).toHaveLength(1);
        expect(eg[0].from_state).toBe('WARM');
        expect(eg[0].to_state).toBe('COLD');
        expect(eg[0].detail).toBe('post-warm death; respawn armed');
        expect(S.warmRespawnInFlight).toBe(true);
        expect(S.warmEditorDead).toBe(true);
        expect(S.warm).toBe(false);
        expect(S.recovering).toBe(false);
        expect(S.renderStable).toBe(false);
        expect(S.spawnTriggered).toBe(false);
        expect(S.warmupTimeoutMs).toBe(null);
        expect(S.recoveryRound).toBe(0);
        expect(S.recoveryWindowStart).toBe(null);
    });

    test('SP2 in-flight guard: second call is a no-op (no disk write)', () => {
        seedWarm();
        spawnMod.beginWarmEditorRespawn();
        const snap = readFileSync(STATE_FILE, 'utf8');
        spawnMod.beginWarmEditorRespawn();
        expect(readFileSync(STATE_FILE, 'utf8')).toBe(snap);
        expect(events().filter((e) => e.event === 'EDITOR_GONE')).toHaveLength(1);
    });

    // Kills the fromState StringLiteral mutant: appendStateEvent falls back to
    // the disk prev state when fromState is empty — with a WARM seed the
    // fallback equals the param and the mutant is invisible. Seeding
    // RECOVERING makes the explicit verdict ('WARM') distinguishable from the
    // record's prior state ('RECOVERING').
    test('SP3 explicit fromState verdict wins over the disk prev state', () => {
        seedWarm({ state: 'RECOVERING' });
        spawnMod.beginWarmEditorRespawn();
        const eg = events().filter((e) => e.event === 'EDITOR_GONE');
        expect(eg).toHaveLength(1);
        expect(eg[0].from_state).toBe('WARM');
        expect(eg[0].to_state).toBe('COLD');
    });
});
