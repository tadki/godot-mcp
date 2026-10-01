// @ts-nocheck
// SEE-1356 hardener — scoped vitest config for the batch-1 unit test face
// (launch/tests/unit/). These files are the StrykerJS mutation-test layer for
// the L1/L2/L3-2/L5/L6 .mjs modules (see stryker.see1356.json); they do NOT
// join the launch fast tier (that contract is the exit-code harness set —
// launch/vitest.config.ts entry lists stay untouched, pins intact).
//
// Deliberately NOT importing launch/vitest.config.ts: the base config's D1
// gate builds server/dist at load time, which inside a Stryker sandbox would
// pay a full npm ci + build per mutant run. This face is pure in-process
// unit tests + short child-process matrices — no fork CLI needed.
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        root: new URL('.', import.meta.url).pathname,
        include: ['tests/unit/**/*.test.mjs'],
        reporters: [['default', { summary: false }]],
        fileParallelism: false,
        testTimeout: 30000,
        hookTimeout: 15000,
    },
});
