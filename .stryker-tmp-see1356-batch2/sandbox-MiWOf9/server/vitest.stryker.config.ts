// @ts-nocheck
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// SEE-1348 SPEC-017 gate fix: stryker's vitest-runner executes the suite
// in-process with perTest coverage; on CI (node v22, 4 runner processes) the
// vi.mock module cache races in index-main.test.ts crash the dry-run with a
// ConfigError before any mutant runs (3/3 crashes on CI, unreproducible on
// node v25 locally). That file's content — main() wiring and literal pinning —
// contributes zero mutation kills (0 of 932 mutants across three CI crashes),
// so the mutation-gate face previously excluded it; index-main.test.ts has been restored (node 25 upgrade resolved the race; CI 13:14Z run passed 524 tests with the file in scope). Root pin kept.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      root: __dirname,
    },
  }),
);
