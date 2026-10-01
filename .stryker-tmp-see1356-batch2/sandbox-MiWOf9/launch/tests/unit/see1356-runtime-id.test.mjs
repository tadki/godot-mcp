// @ts-nocheck
// SEE-1356 batch-2 hardener — runtime-id.mjs direct test face (the slot-form
// runtime_id predicate SSOT, cleanup ③). This is the StrykerJS mutation face
// for the predicate boundary matrix the QA派单 flagged (base 66.67%→68.97%).
// Pure module: env + string predicates only — no fs, no side effects, so no
// sandboxing is needed beyond env save/restore.
import { afterEach, describe, expect, test } from 'vitest';
import { isSlotRuntimeId, legacyFormName, SLOT_RUNTIME_ID_RE } from '../../proxy/runtime-id.mjs';

const SAVED = { ...process.env };
afterEach(() => { process.env.GODOT_MCP_AGENT_NAME = SAVED.GODOT_MCP_AGENT_NAME; process.env.KOL_AGENT_NAME = SAVED.KOL_AGENT_NAME; });

describe('SLOT_RUNTIME_ID_RE shape contract', () => {
    // The regex is the RULE; the predicate wraps it. Pin the regex itself so
    // its literal mutants die independently of the guard chain.
    const reTrue = [
        ['Units-111122223333', '12-hex canonical (see-<issue>-<hex> family)'],
        ['Units-11112222', '8-hex legacy bare-dir layout'],
        ['units-111122223333', 'lowercase first letter ([A-Za-z] class)'],
        ['Bo_chi-11112222', 'underscore in the label part ([A-Za-z0-9_-])'],
        ['Revy-x-11112222', 'dash INSIDE the label part (only the LAST -segment must be hex)'],
    ];
    for (const [rid, why] of reTrue) {
        test(`regex accepts ${why}`, () => expect(SLOT_RUNTIME_ID_RE.test(rid)).toBe(true));
    }
    const reFalse = [
        ['Units-1111222', '7-hex tail below the {8,} floor'],
        ['Units-1111222233334', '13-hex tail above the {8,12} cap'],
        ['Units-zzzz', 'non-hex tail'],
        ['Units-1111222A', 'UPPERCASE hex tail (slot hashes are lowercase)'],
        ['1Units-11112222', 'digit-first label (^ char class)'],
        ['-Units-11112222', 'dash-first label'],
        ['Units-11112222-extra', 'hex segment is not the LAST -segment'],
        ['Units-solo', '-solo never a slot id'],
        ['', 'empty'],
        ['*  ', 'star-ish junk'],
    ];
    for (const [rid, why] of reFalse) {
        test(`regex rejects ${why}`, () => expect(SLOT_RUNTIME_ID_RE.test(rid)).toBe(false));
    }
});

describe('isSlotRuntimeId guard chain boundary matrix', () => {
    // NOTE (adversarial self-check): 'Agents-solo-111122223333' and
    // 'UnitsSOLO-11112222' are regex-TRUE and endsWith('-solo')-FALSE — the
    // production predicate returns TRUE for both. That is the F3-contract
    // boundary exactly as implemented: only an id ENDING in '-solo' is
    // legacy. Two stronger assumptions were tested and REFUTED against the
    // code; they are recorded here as refuted, not asserted.
    test('refuted-assumption record: -solo mid-label is still a slot (production semantics)', () => {
        expect(isSlotRuntimeId('Agents-solo-111122223333')).toBe(true);
        expect(isSlotRuntimeId('UnitsSOLO-11112222')).toBe(true);
    });

    // kills: each guard's deletion/loosening is observable ONLY through inputs
    // that are regex-TRUE but guard-FALSE, plus the empty/undefined arm that
    // the regex alone would NPE/accept differently.
    const trueCases = [
        ['Units-111122223333', 'canonical 12-hex'],
        ['Agents-11112222', '8-hex'],
        ['agents-111122223333', 'lowercase label'],
        ['Bo_chi-11112222', 'underscore label'],
        ['Revy-x-11112222', 'multi-dash label with hex tail'],
    ];
    for (const [rid, why] of trueCases) {
        test(`slot: ${why}`, () => expect(isSlotRuntimeId(rid)).toBe(true));
    }
    const falseCases = [
        [undefined, 'undefined (Boolean guard arm — regex .test(undefined) would coerce "undefined")'],
        [null, 'null (same coercion trap)'],
        ['', 'empty string'],
        ['*', 'the wildcard — must fall back to legacy even though it could be regex-tuned'],
        ['Units-solo', '-solo manual runs'],
        ['Units-1111222', '7-hex below floor'],
        ['Units-1111222233334', '13-hex above cap'],
        ['Units-zzzz', 'non-hex tail'],
        ['Units-1111222A', 'uppercase hex tail'],
        ['1Units-11112222', 'digit-first'],
        ['Units-11112222-extra', 'hex not last segment'],
    ];
    for (const [rid, why] of falseCases) {
        test(`legacy: ${why}`, () => expect(isSlotRuntimeId(rid)).toBe(false));
    }
    test('guard-arm redundancy notes (the four surviving mutant classes)', () => {
        // Adversarial kill-attempt documentation for the four survivors of the
        // 87.31% run — each is an output-equivalent mutant under this guard
        // chain, with the kill attempt that failed pinned here:
        //
        // 1) `Boolean(runtimeId)` → `true` / `runtimeId !== '*'` → `!== ''`:
        //    the regex `.test(undefined/'')` is false, so a false-input arm
        //    deletion never flips an output (the regex is the real killer and
        //    it is independently pinned above). The '*' literal mutant is
        //    likewise shadowed: '*' fails the regex anyway.
        expect(isSlotRuntimeId(undefined)).toBe(false);
        expect(isSlotRuntimeId(null)).toBe(false);
        expect(isSlotRuntimeId('')).toBe(false);
        expect(isSlotRuntimeId('*')).toBe(false);
        // 2) `.endsWith('-solo')` → `.startsWith('-solo')`: a START-dash id
        //    ('-Units-11112222') already fails the regex ^[A-Za-z] class, so
        //    the swap is output-equivalent on every string. The only string
        //    ending in '-solo' that the regex accepts would need a hex tail —
        //    impossible ('solo' is not hex) — hence endsWith is itself a
        //    redundant-vs-regex guard for ALL regex-false inputs, kept for the
        //    F3 contract's explicitness.
        expect(isSlotRuntimeId('-Units-11112222')).toBe(false);
        // Sanity: the endsWith guard is observable ONLY as documentation —
        // record the equivalence class here so future readers don't re-derive.
        expect(isSlotRuntimeId('Units-solo')).toBe(false);
        expect(SLOT_RUNTIME_ID_RE.test('Units-solo')).toBe(false);
    });

    test('mutual exclusion: every slot-true rid is regex-true, every guard-false is predicate-false', () => {
        // kills: guard-chain reorder mutants (e.g. dropping endsWith but keeping
        // !== '*' still passes '*' only if the regex also matched — it doesn't,
        // so the observable contract is: guard-false ⊇ regex-false ∪ {'*','-solo'}).
        for (const rid of ['Units-111122223333', 'Agents-11112222', 'Bo_chi-11112222']) {
            expect(isSlotRuntimeId(rid)).toBe(SLOT_RUNTIME_ID_RE.test(rid));
        }
        expect(isSlotRuntimeId('*')).toBe(false);
        expect(isSlotRuntimeId('Units-solo')).toBe(false);
    });
});

describe('legacyFormName env precedence (LEGACY_LABEL path)', () => {
    // kills: the || -chain order swaps and the 'unknown' fallback literal —
    // each env permutation has a DISTINCT expected label, so any reorder or
    // fallback deletion flips exactly one pin.
    const cases = [
        ['Alpha', 'beta', 'alpha', 'GODOT_MCP_AGENT_NAME wins'],
        ['', 'beta', 'beta', 'KOL_AGENT_NAME is the fallback'],
        ['', '', 'unknown', 'neither → unknown literal'],
        ['0', 'beta', '0', 'a truthy "0" string is respected (env strings, not numbers)'],
    ];
    for (const [gm, kol, expected, why] of cases) {
        test(`precedence: ${why}`, () => {
            process.env.GODOT_MCP_AGENT_NAME = gm;
            process.env.KOL_AGENT_NAME = kol;
            expect(legacyFormName()).toBe(expected);
        });
    }
    test('undefined envs → unknown (|| chain, not ??)', () => {
        delete process.env.GODOT_MCP_AGENT_NAME;
        delete process.env.KOL_AGENT_NAME;
        expect(legacyFormName()).toBe('unknown');
    });
    test('label is lowercased (file-family naming contract)', () => {
        process.env.GODOT_MCP_AGENT_NAME = 'MiXeDCase';
        process.env.KOL_AGENT_NAME = '';
        expect(legacyFormName()).toBe('mixedcase');
    });
});
