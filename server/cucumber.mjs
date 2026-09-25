// SEE-1334 Phase 3 gherkin harness (plan §7 / SPEC-030/031).
// Object: MCP protocol behaviors (proxy + addon-on-the-wire), reproduced at
// the protocol layer against the seams the existing launch harnesses already
// pin (WS-completing mock editor, counting spawn helpers, mock npx) — no
// real editor. Scenarios are 任务 spec 可执行条款: any scenario failing or
// pending fails the gherkin evidence.
//
// Task acceptance + nightly evidence runs (`npx cucumber-js --strict` from
// server/); NOT in PR CI (plan §7, Owner 2026-09-21).

export default {
    paths: ['features/**/*.feature'],
    // TS steps via the tsx import hook (plan §7; --loader is deprecated in
    // Node >=20.6 and tsx refuses it). SPEC-030's machine judgment stays the
    // bare command — the hook rides in this config.
    import: ['features/steps/**/*.ts', 'tsx'],
    strict: true,
    retry: 0,
    // Step timeout: the warm handshake through the counting seams is budgeted
    // at 15-20s in the steps (BUDGET) — the 5s cucumber default flakes under
    // load (SEE-1348 WP5: full-feature run on a busy box hit it on warm Given).
    timeout: 25_000,
    format: ['summary'],
};
