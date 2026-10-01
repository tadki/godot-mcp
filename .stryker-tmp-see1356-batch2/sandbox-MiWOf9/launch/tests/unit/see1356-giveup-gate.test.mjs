// @ts-nocheck
// SEE-1356 hardener — the giveup-family hex gate {8}→{8,12} fix (spawn.mjs
// persistGiveUpStatus) boundary matrix, fully IN-PROCESS: the gate reads
// GODOT_MCP_RUNTIME_ID / agent label from process.env at CALL time (only
// GODOT_MCP_HOME is import-frozen), so the rid/label matrix needs no child
// processes — child coverage is invisible to Stryker, and every mutant here
// must be killable. The legacy flat file is removed between legacy cases so
// each landing is independently observable in the one frozen home dir.
// Kills: {8,12}→{8} (12-hex giveup-fix regression — the exact defect the fix
// closed), {8,12}→{8,} (uncapped), hex-class loosening, first-char class,
// -solo/'*' guard removal, legacy-label fallback removal.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SB = mkdtempSync(path.join(tmpdir(), 'see1356-giveup-unit-'));
process.env.HOME = SB;
process.env.GODOT_MCP_HOME = path.join(SB, '.multica');
process.env.GODOT_MCP_AGENT_NAME = 'Agents';
process.env.GODOT_MCP_RUNTIME_ID = 'Agents-111122223333';
mkdirSync(path.join(process.env.GODOT_MCP_HOME, 'godot-editor'), { recursive: true });

const { persistGiveUpStatus } = await import('../../proxy/spawn.mjs');

const STATE_DIR = path.join(process.env.GODOT_MCP_HOME, 'godot-editor');
const LEGACY = path.join(STATE_DIR, 'godot-editor-agents.giveup.json');
const LEGACY_UNKNOWN = path.join(STATE_DIR, 'godot-editor-unknown.giveup.json');

beforeEach(() => {
    for (const f of readdirSync(STATE_DIR)) {
        if (f.endsWith('.giveup.json')) rmSync(path.join(STATE_DIR, f), { force: true });
    }
    process.env.GODOT_MCP_AGENT_NAME = 'Agents';
    process.env.GODOT_MCP_RUNTIME_ID = 'Agents-111122223333';
});

afterEach(() => {
    process.env.GODOT_MCP_AGENT_NAME = 'Agents';
    process.env.GODOT_MCP_RUNTIME_ID = 'Agents-111122223333';
});

const slotDoc = (rid) => JSON.parse(readFileSync(path.join(STATE_DIR, `${rid}.giveup.json`), 'utf8'));
const giveupFiles = () => readdirSync(STATE_DIR).filter((f) => f.endsWith('.giveup.json'));

describe('persistGiveUpStatus dual-form hex gate', () => {
    test('slot forms: 8-hex AND 12-hex runtime ids → per-slot giveup files (the {8}→{8,12} fix pin)', () => {
        for (const rid of ['Agents-11112222', 'Agents-111122223333']) {
            process.env.GODOT_MCP_RUNTIME_ID = rid;
            persistGiveUpStatus('give_up', 'editor_busy', 'unit-probe');
            expect(existsSync(path.join(STATE_DIR, `${rid}.giveup.json`)), `rid=${rid}`).toBe(true);
        }
        // mutual exclusion: NO legacy-flat artifact for slot rids
        expect(giveupFiles()).toEqual(['Agents-11112222.giveup.json', 'Agents-111122223333.giveup.json']);
    });

    test('boundary violations land on the legacy flat name, never a slot file', () => {
        // kills: floor/cap/guards — each rid below must NOT take the slot path
        for (const rid of ['Agents-1111222', 'Agents-1111222233334', 'Agents-zzzz', 'Agents-solo', '*', '1Agents-11112222']) {
            process.env.GODOT_MCP_RUNTIME_ID = rid;
            rmSync(LEGACY, { force: true });
            persistGiveUpStatus('give_up', 'editor_busy', 'unit-probe');
            expect(existsSync(LEGACY), `rid=${rid} legacy missing`).toBe(true);
            expect(giveupFiles(), `rid=${rid} must not create slot files`).toEqual(['godot-editor-agents.giveup.json']);
        }
    });

    test('no runtime id AND no agent name → unknown legacy label (fallback pinned)', () => {
        process.env.GODOT_MCP_RUNTIME_ID = '';
        process.env.KOL_RUNTIME_ID = '';
        process.env.GODOT_MCP_AGENT_NAME = '';
        process.env.KOL_AGENT_NAME = '';
        persistGiveUpStatus('give_up', 'editor_busy', 'unit-probe');
        expect(existsSync(LEGACY_UNKNOWN)).toBe(true);
        expect(giveupFiles()).toEqual(['godot-editor-unknown.giveup.json']);
    });

    test('KOL_RUNTIME_ID fallback feeds the gate (env-name literal pin)', () => {
        // Kills: the `process.env.GODOT_MCP_RUNTIME_ID ||` env-NAME literal
        // mutants (renamed env would silently read nothing and fall through).
        process.env.GODOT_MCP_RUNTIME_ID = '';
        process.env.KOL_RUNTIME_ID = 'Agents-444455556666';
        persistGiveUpStatus('give_up', 'editor_busy', 'unit-probe');
        expect(existsSync(path.join(STATE_DIR, 'Agents-444455556666.giveup.json'))).toBe(true);
        expect(giveupFiles()).toEqual(['Agents-444455556666.giveup.json']);
    });

    test('armed give-up stamps cooldown_until + backoff arithmetic', async () => {
        // Kills (NoCoverage→covered): the armed branch of the cooldown
        // ternary and the armed+backoff millisecond arithmetic.
        const { S } = await import('../../proxy/state.mjs');
        const armedAt = Date.now() - 5000;
        S.giveUpArmedAt = armedAt;
        S.giveUpBackoffMs = 30000;
        try {
            persistGiveUpStatus('give_up', 'editor_busy', 'unit-probe');
            const doc = slotDoc('Agents-111122223333');
            expect(doc.last_giveup_at).toBe(new Date(armedAt).toISOString());
            expect(doc.cooldown_until).toBe(new Date(armedAt + 30000).toISOString());
            expect(doc.backoff_ms).toBe(30000);
        } finally {
            S.giveUpArmedAt = 0;
            S.giveUpBackoffMs = 0;
        }
    });

    test('persist write failure → WARNING logged, never thrown', async () => {
        // Kills (NoCoverage→covered): the catch block — the best-effort
        // contract (observability must not break the give-up path).
        const { chmodSync, readdirSync, readFileSync } = await import('node:fs');
        chmodSync(STATE_DIR, 0o500);
        try {
            expect(() => persistGiveUpStatus('give_up', 'editor_busy', 'unit-probe')).not.toThrow();
        } finally {
            chmodSync(STATE_DIR, 0o700);
        }
        // the structured WARNING must stay greppable in the L6 tee
        const tee = readdirSync(STATE_DIR).find((f) => f.endsWith('.proxy.log'));
        expect(readFileSync(path.join(STATE_DIR, tee), 'utf8')).toContain('WARNING: persistGiveUpStatus failed');
    });

    test('giveup doc field completeness (doctor 仲裁判定表 input contract)', () => {
        process.env.GODOT_MCP_RUNTIME_ID = 'Agents-111122223333';
        persistGiveUpStatus('give_up', 'editor_busy', 'unit-probe');
        const doc = slotDoc('Agents-111122223333');
        expect(doc).toMatchObject({
            schema: 'see1240-ws5-giveup/1',
            state: 'FAILED_CLEAN',
            last_event: 'give_up',
            last_bucket: 'editor_busy',
            last_reason: 'unit-probe',
        });
        for (const k of ['giveup_count', 'backoff_ms', 'last_giveup_at', 'cooldown_until', 'updated_at']) {
            expect(doc, `missing field ${k}`).toHaveProperty(k);
        }
    });
});
