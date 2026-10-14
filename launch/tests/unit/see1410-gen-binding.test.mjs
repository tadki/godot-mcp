// SEE-1410 hardener — log-generation binding discriminator (lease.mjs live tail).
// In-process face: when the editor log file is RECREATED (new inode — rm -f
// rebuild or symlink retarget across boots), checkLeaseTail must reset the
// generation: offset re-anchored to the new file's beginning and every
// log-domain milestone + bind evidence of the previous boot dropped. Kills the
// mutant removing the applyLogGenerationBinding(st) call (stale previous-boot
// milestones would satisfy this generation's gate — the third-recurrence root
// cause survives).
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LAUNCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = (rel) => pathToFileURL(path.join(LAUNCH, rel)).href;

const SB = mkdtempSync(path.join(tmpdir(), 'see1410-gen-'));
process.env.HOME = SB;
process.env.GODOT_MCP_HOME = path.join(SB, '.multica');
process.env.GODOT_MCP_RUNTIME_ID = 'See1410-gen';
process.env.GODOT_PORT = '6595';
process.env.GODOT_EDITOR_LOG_FILE = path.join(SB, 'editor.log');
process.env.GODOT_MCP_GIVEUP_REARM = '1';
process.env.KOL_PROGRESS_PROTOCOL = 'on';

const { S } = await import(MOD('proxy/state.mjs'));
const lease = await import(MOD('proxy/lease.mjs'));
const { STAGE_ENUM } = await import(MOD('warmup-stage-parser.mjs'));

const LOG_FILE = path.join(SB, 'editor.log');

beforeEach(() => {
    rmSync(LOG_FILE, { force: true });
    S.leaseOffset = 0;
    S.leaseInode = null;
    S.leaseExitDetected = false;
    S.warmupTimedOut = false;
    S.warmRespawnInFlight = false;
    S.leaseTimer = null;
    S.logTailUnavailableSince = 0;
    S.stage = 'EDITOR_SPAWNED';
    S.stageTimestamps = {};
    for (const s of STAGE_ENUM) S.stageTimestamps[s] = null;
    S.stageTimestamps.LAUNCHER_EXEC = 111;
    S.stageTimestamps.EDITOR_SPAWNED = 222;
    S.tcpReceivedCount = 5;
    S.wsBindOkDelayMs = null;
});
afterEach(() => { rmSync(LOG_FILE, { force: true }); });

// Mirror startLeaseMonitor's initial anchor: the monitor stats the file at
// startup and records (offset, inode) as generation 0. applyLogGenerationBinding
// only fires on inode CHANGE (null returns immediately — the change detector,
// not the anchor).
const anchorGeneration0 = () => {
    const st = statSync(LOG_FILE);
    S.leaseOffset = st.size;
    S.leaseInode = st.ino;
};

describe('SEE-1410 rev2 log-generation binding (lease tail live face)', () => {
    test('gen0: first scan anchors inode and absorbs this-boot milestones', async () => {
        writeFileSync(LOG_FILE, '');
        anchorGeneration0();
        appendFileSync(LOG_FILE, '[godot-mcp] Server listening on 127.0.0.1:6595 [WSL]\n'
            + '[godot-mcp] [stage=WS_BIND_OK] [t=+44213ms] port=6595\n');
        await lease.checkLeaseTail();
        expect(S.leaseInode).not.toBe(null);
        expect(S.stageTimestamps.SERVER_LISTENING).not.toBe(null);
        expect(S.wsBindOkDelayMs).toBe(44213);
    });

    test('inode change → generation reset: old milestones/bind evidence dropped, offset re-anchored', async () => {
        // gen0: anchor on the empty log (monitor start), then the boot writes.
        writeFileSync(LOG_FILE, '');
        anchorGeneration0();
        appendFileSync(LOG_FILE, '[godot-mcp] Server listening on 127.0.0.1:6595 [WSL]\n'
            + '[godot-mcp] [stage=WS_BIND_OK] [t=+44213ms] port=6595\n'
            + '[godot-mcp] Client connected from 127.0.0.1:1\n');
        await lease.checkLeaseTail();
        const gen0Inode = S.leaseInode;
        expect(S.stageTimestamps.WS_HANDSHAKE).not.toBe(null);

        // New boot generation via symlink retarget (the spec's other trigger —
        // runtime-scoped log path is a symlink across boots): point the watched
        // path at a freshly created file whose inode differs (pre-created pair
        // guards against tmpfs inode reuse on rm+rewrite).
        const alt = path.join(SB, 'editor-boot2.log');
        writeFileSync(alt, '[godot-mcp] Server listening on 127.0.0.1:6595 [WSL]\n');
        if (statSync(alt).ino === gen0Inode) {
            // pathological inode reuse: pad until distinct (bounded loop)
            for (let i = 0; i < 50 && statSync(alt).ino === gen0Inode; i++) {
                rmSync(alt, { force: true });
                writeFileSync(alt, 'x');
            }
            writeFileSync(alt, '[godot-mcp] Server listening on 127.0.0.1:6595 [WSL]\n');
        }
        expect(statSync(alt).ino).not.toBe(gen0Inode, 'test premise: distinct inode obtainable');
        rmSync(LOG_FILE, { force: true });
        // symlink(LOG_FILE → alt) reproduces the runtime-scoped retarget
        symlinkSync(alt, LOG_FILE);
        await lease.checkLeaseTail();

        expect(S.leaseInode).not.toBe(gen0Inode);
        expect(S.stageTimestamps.WS_HANDSHAKE).toBe(null, 'previous-boot handshake milestone invalidated');
        expect(S.wsBindOkDelayMs).toBe(null, 'previous-boot bind evidence invalidated');
        // The new generation's own line is the only evidence: SERVER_LISTENING
        // re-fires from THIS boot's content (offset restarted at 0).
        expect(S.stageTimestamps.SERVER_LISTENING).not.toBe(null);
        // Stage re-anchored then re-advanced by THIS boot's own line — the
        // discriminator is the gen0-only evidence below, not the stage value.
        expect(S.stage).toBe('SERVER_LISTENING', 'new generation absorbed only its own line');
    });

    test('same inode, size shrink (truncation) → offset reset WITHOUT generation reset', async () => {
        writeFileSync(LOG_FILE, 'boot line\n');
        anchorGeneration0();
        await lease.checkLeaseTail();
        const ino = S.leaseInode;
        expect(S.leaseOffset).toBeGreaterThan(0);
        // In-place truncation: same file object, smaller size.
        writeFileSync(LOG_FILE, 'x\n');
        await lease.checkLeaseTail();
        expect(S.leaseInode).toBe(ino, 'same file → no generation reset');
        expect(S.leaseOffset).toBe(Buffer.byteLength('x\n'), 'truncation rescan only new content');
    });
});
