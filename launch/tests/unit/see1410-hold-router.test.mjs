// SEE-1410 hardener — router hold-to-warm discriminator (rev2 bind-evidence hold).
// In-process face: handleClaudeMessage must HOLD a call in S.pendingCalls (FIFO)
// while the bind-evidence hold is active (warmEditorDead + bindEvidenceHoldActive),
// instead of answering the respawn warmup hint. Kills the mutant that drops the
// !S.bindEvidenceHoldActive conjunct (hint semantics leak into the hold window —
// the client gets a retryable hint for a flip that is ≤1.5s away).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LAUNCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOD = (rel) => pathToFileURL(path.join(LAUNCH, rel)).href;

const SB = mkdtempSync(path.join(tmpdir(), 'see1410-hold-'));
process.env.HOME = SB;
process.env.GODOT_MCP_HOME = path.join(SB, '.multica');
process.env.GODOT_MCP_RUNTIME_ID = 'See1410-hold';
process.env.GODOT_PORT = '6598';
process.env.GODOT_EDITOR_LOG_FILE = path.join(SB, 'editor.log');
process.env.GODOT_MCP_GIVEUP_REARM = '1';
process.env.KOL_PROGRESS_PROTOCOL = 'off';

const { S } = await import(MOD('proxy/state.mjs'));
const router = await import(MOD('proxy/router.mjs'));

// Capture outbound responses: sendToClaude writes JSON-RPC lines to stdout.
let outbound = [];
const origWrite = process.stdout.write.bind(process.stdout);
beforeEach(() => {
    outbound = [];
    process.stdout.write = ((chunk) => { outbound.push(String(chunk)); return true; });
});
afterEach(() => {
    process.stdout.write = origWrite;
    return () => { process.stdout.write = origWrite; };
});

const CALL = (id) => JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'godot_project', arguments: { action: 'get_info' } },
});

describe('SEE-1410 rev2 router bind-evidence hold (hold-to-warm FIFO)', () => {
    test('hold active → call lands in pendingCalls FIFO, NO warmup hint response', () => {
        S.pendingCalls = [];
        S.warmEditorDead = true;
        S.bindEvidenceHoldActive = true;   // the ≤1.5s evidence-arrival window
        S.spawnLastFailed = false;
        S.spawnTriggered = true;
        S.recovering = false;
        S.warmupTimedOut = false;
        S.spawnTerminal = false;
        S.spawnBackoffUntil = 0;
        router.handleClaudeMessage(CALL(2));
        expect(S.pendingCalls).toHaveLength(1);
        expect(S.pendingCalls[0]).toContain('"id":2');
        const hinted = outbound.some((l) => l.includes('"id":2') && l.includes('warming'));
        expect(hinted).toBe(false);
    });

    test('hold inactive → respawn hint path unchanged (dropToolsCallId + warming hint)', () => {
        S.pendingCalls = [];
        S.warmEditorDead = true;
        S.bindEvidenceHoldActive = false;  // window over → legacy hint semantics
        S.spawnLastFailed = false;
        S.spawnTriggered = true;
        S.recovering = false;
        S.warmupTimedOut = false;
        S.spawnTerminal = false;
        S.spawnBackoffUntil = 0;
        router.handleClaudeMessage(CALL(3));
        expect(S.pendingCalls).toHaveLength(0, 'hint path drops the call, does not FIFO it');
        const hinted = outbound.some((l) => l.includes('"id":3') && l.includes('warming'));
        expect(hinted).toBe(true);
    });
});
