// ESLint flat config — SEE-1334 Phase 1 static quality layer.
//
// Two rulesets, mirroring the repo's two Node-side trees:
//   - server/src/**/*.ts  → TS ruleset (typescript-eslint recommended)
//   - launch/**/*.mjs     → JS ruleset (eslint recommended, node globals)
//     launch/tests/** is excluded on purpose: test harness semantics are
//     Phase 2 scope (SEE-1334 plan §6), lint must not gate them in P1.
//
// Complexity gate maps gqt's `--warn 10 --max 15` semantics onto ESLint:
// `complexity` warn@10 is the warning tier (legacy hits are pinned by the
// --max-warnings baseline in package.json, so new code has zero tolerance)
// and `sonarjs/cognitive-complexity` error@15 is the hard-fail tier. ESLint
// cannot give a single rule two severities, so the two tiers ride two rules
// by design — do not "simplify" one of them away.
//
// Baseline policy (SEE-1334 plan §5): errors = zero tolerance from day one;
// legacy warnings are absorbed by `--max-warnings` in the lint scripts and
// must only ratchet down. Inline `eslint-disable` comments on legacy code
// carry a `-- SEE-1334 baseline` tag and are cleaned up as the code they
// guard gets refactored (unused directives surface as warnings by default).

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';

const complexityGate = {
  rules: {
    complexity: ['warn', 10],
    'sonarjs/cognitive-complexity': ['error', 15],
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'server/dist/**',
      'server/addon/**',
      'coverage/**',
      'launch/tests/**',
    ],
  },
  {
    files: ['server/src/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    plugins: { sonarjs },
    rules: {
      ...complexityGate.rules,
      // The `{ x, ...rest } = obj` omit-key idiom (strip $schema in
      // core/schema.ts, core/doc-examples.ts) trips no-unused-vars without
      // this; the destructured sibling exists only to be excluded from rest.
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    files: ['launch/**/*.mjs'],
    extends: [js.configs.recommended],
    plugins: { sonarjs },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      ...complexityGate.rules,
      // Legacy launch/*.mjs carries 11 unused-var sites; cleanup rides the
      // P0a proxy split (SEE-1334 plan §4) instead of duplicating edits here.
      // Downgraded to the warning tier so the --max-warnings baseline still
      // blocks NEW unused vars; ratchet back to error after the split lands.
      'no-unused-vars': 'warn',
      // SEE-1344 ⑬ (Owner 2026-09-25 01:02): fixed numeric-literal sleeps
      // (setTimeout(fn, N) with a literal delay) surface as warnings — not
      // banned: legitimate timeout paths keep an inline disable with a WHY
      // (launch/CLAUDE.md 边界条款). The ratchet baseline (= sites present at
      // rule introduction) absorbs them; new sites get flagged.
      'no-restricted-syntax': ['warn', {
        selector: "CallExpression[callee.name='setTimeout'] > Literal:nth-child(2)",
        message: 'fixed-literal sleep (setTimeout(fn, N)) — use event-driven waits per launch/CLAUDE.md; keep only with an inline disable + WHY.',
      }],
    },
  },
);
