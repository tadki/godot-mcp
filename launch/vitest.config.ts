// launch-side vitest config — SEE-1334 Phase 2 (plan §6 / SPEC-020..023).
//
// ONLY the runner changes: SEE-1291's four-tier layering (fast/long/env/drift)
// is preserved verbatim. The fast + long entry lists below are the SAME
// entries the old heredoc lists drove — pinned explicitly rather than
// auto-walked, because the launch/tests tree contains 61 extra harness files
// that belong to the drift/env buckets (documented-red / real-editor suites)
// and a directory walk cannot distinguish tiers. Tier membership moves with
// the SEE-1291 graduation flow (drift → fast), i.e. by editing these arrays,
// not by renaming files. No test file is edited: case semantics are untouched,
// every harness still runs as its own process with exit code as the pass/fail
// contract, asserted through a generated wrapper per entry.
//
// stdin defense (SPEC-022): the old runner piped `< /dev/null` so harnesses
// reading stdin never hang. The generated wrappers spawn each harness with
// stdio stdin: 'ignore' — the process-level equivalent of </dev/null (read()
// → EOF immediately).
//
// The 61 drift/env harness files are auto-discovery EXCLUDED on purpose;
// they keep running via launch-special.yml. `ws-mock-listener.mjs` is a
// shared mock server, not a test.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const REPO = path.resolve(import.meta.dirname, '..');

// ——— SSOT entry lists (mirrors launch-ci.yml / launch-special long bucket) ———
const FAST_SHELL = `
launch/tests/hooks/see1273/test_see1273_t1_import.sh
launch/tests/hooks/see1273/test_see1273_t1_tree_consistency.sh
launch/tests/hooks/see1273/test_see1273_t2_chain.sh
launch/tests/hooks/see1273/test_see1273_t3_chain.sh
launch/tests/hooks/see1273/test_see1273_t4_chain.sh
launch/tests/scripts/test_ac_m3reorg_013_shell_guard_empty.sh
launch/tests/scripts/test_see1070_proxy_default_port_guard.sh
launch/tests/scripts/test_see1077_lease_fast_fail.sh
launch/tests/scripts/test_see1085_t1_cold_spawn.sh
launch/tests/scripts/test_see1085_t2_hot_reuse.sh
launch/tests/scripts/test_see1085_t3_spawn_fail.sh
launch/tests/scripts/test_see1085_t4_lease_respawn.sh
launch/tests/scripts/test_see1085_t5_dedup.sh
launch/tests/scripts/test_see1110_e5_multi_agent_channelA.sh
launch/tests/scripts/test_see1111_cold_start_gate.sh
launch/tests/scripts/test_see1111_defect6_wsprobe_first_call.sh
launch/tests/scripts/test_see1111_defect7_respawn.sh
launch/tests/scripts/test_see1111_defect8_respawn_probe.sh
launch/tests/scripts/test_see1111_defect9_npx_death_gate.sh
launch/tests/scripts/test_see1111_spawn_prepare_generates_project_godot.sh
launch/tests/scripts/test_see1111_timeline_negative_degradation.sh
launch/tests/scripts/test_see1111_ws_handshake_gate.sh
launch/tests/scripts/test_see1148_b6_fastfail_race.sh
launch/tests/scripts/test_see1148_p24_dynamic_release.sh
launch/tests/scripts/test_see1148_p3_intentional_release.sh
launch/tests/scripts/test_see1148_p3_t16_live_editor.sh
launch/tests/scripts/test_see1148_port_arbiter.sh
launch/tests/scripts/test_see1148_registry_concurrent.sh
launch/tests/scripts/test_see1148_t15_reaper_port_sweep.sh
launch/tests/scripts/test_see1152_reaper_registry_sweep.sh
launch/tests/scripts/test_see1164_adversarial_revy.sh
launch/tests/scripts/test_see1164_persist_stderr.sh
launch/tests/scripts/test_see1164_port_die_adversarial_revy.sh
launch/tests/scripts/test_see1164_port_die_owner.sh
launch/tests/scripts/test_see1240_d1_corrupt_accounting.sh
launch/tests/scripts/test_see1240_ws4_status_doctor.sh
launch/tests/scripts/test_see1240_ws7_grace_race.sh
launch/tests/scripts/test_see1148_t16_runtime_identity.sh
launch/tests/scripts/test_see1244_shim_degrade.sh
launch/tests/scripts/test_see1244_tier1_wait.sh
launch/tests/scripts/test_see1288_build_fallback_negative.sh
launch/tests/scripts/test_see990_live_gate_race.sh
launch/tests/scripts/see1129/test_lease_lifecycle_boundary_matrix.sh
launch/tests/scripts/see1129/test_multi_path_drift_assertion.sh
launch/tests/scripts/see1129/test_multi_slot_reuse_predicate.sh
launch/tests/scripts/see1129/test_reaper_grace_integration.sh
launch/tests/scripts/see1129/test_runtime_registry_marker.sh
launch/tests/scripts/see1129/test_sidecar_guard_predicate.sh
launch/tests/scripts/see1137/test_reaper_headless_orphan_sweep.sh
launch/tests/scripts/test_see1117_phase1_marker_lifecycle.sh
launch/tests/scripts/test_see1117_sidecar_lifecycle.sh
launch/tests/scripts/test_see1152_configure_async_reaper.sh
`;

const FAST_NODE = `
launch/tests/scripts/see1129/selftest_integration_combined.mjs
launch/tests/scripts/see1129/test_anchor_passthrough.mjs
launch/tests/scripts/see1129/test_release_after_start_race.mjs
launch/tests/scripts/see1129/test_reuse_short_circuit.mjs
launch/tests/scripts/test_ac_m3reorg_011_shared_master_guard.mjs
launch/tests/scripts/test_see1152_stage_log.mjs
launch/tests/scripts/test_see1170_channel3.mjs
launch/tests/scripts/test_see1240_exec_constraints.mjs
launch/tests/scripts/test_see1240_screenshot_contract.mjs
launch/tests/scripts/test_see1240_ui_tools.mjs
launch/tests/scripts/test_see1244_rechain.mjs
launch/tests/scripts/test_see1244_shim_handshake.mjs
launch/tests/scripts/test_see1244_shim_placeholder.mjs
launch/tests/scripts/test_see1244_v2_gate.mjs
launch/tests/scripts/test_see1338_p1_sot.mjs
launch/tests/scripts/test_see1338_stale_takeover.mjs
`;

const LONG = `
launch/tests/scripts/test_see1148_t14_reaper_grace_guard.sh
launch/tests/scripts/test_see1240_ws5_giveup_rearm.sh
`;

const parse = (block) => block.trim().split('\n').map((s) => s.trim()).filter(Boolean)
  .map((rel) => path.join(REPO, rel))
  .filter((p) => existsSync(p));

const fastEntries = [...parse(FAST_SHELL), ...parse(FAST_NODE)];
const longEntries = parse(LONG);

if (fastEntries.length !== 68) {
  throw new Error(`fast tier expects 68 entries, resolved ${fastEntries.length} — an entry was renamed/retired; update the list in sync with the SEE-1291 graduation flow`);
}
if (longEntries.length !== 2) {
  throw new Error(`long tier expects 2 entries, resolved ${longEntries.length}`);
}

// Generate one wrapper per entry under .vitest-gen/<tier>/ (gitignored —
// derived data; regenerating on config load keeps CI honest).
const genDir = path.join(REPO, 'launch/tests/.vitest-gen');
mkdirSync(genDir, { recursive: true });

const makeWrapper = (entry, tier) => {
  const rel = path.relative(REPO, entry);
  const runner = entry.endsWith('.mjs') ? 'node' : 'bash';
  // fast tier: shell job budget 10min / per-item 180s, node budget 5min / 120s
  // (SEE-1291 budgets, kept verbatim). long tier: 600s per launch-special.yml.
  const timeout = tier === 'fast' ? 180_000 : 600_000;
  return `// GENERATED by vitest.config.ts — do not edit. Entry: ${rel}
import { test } from 'vitest';
import { spawn } from 'node:child_process';

// stdin: 'ignore' ≙ the old runner's '</dev/null' defense (read → EOF, no hang).
// NODE_V8_COVERAGE injection (SEE-1334 SPEC-021 revised): harnesses run the
// launch runtime in CHILD processes, so vitest's in-process coverage provider
// cannot see it. When the suite runs under the coverage gate
// (LAUNCH_COVERAGE_DIR is set), every child dumps raw v8 coverage there;
// launch/tests/runner/coverage-gate.mjs merges and judges it. Outside the
// gate the var is unset and children skip the dump (zero overhead).
test(${JSON.stringify(rel)}, { timeout: ${timeout} }, async () => {
  await new Promise((resolve, reject) => {
    const child = spawn(${JSON.stringify(runner)}, [${JSON.stringify(rel)}], {
      cwd: ${JSON.stringify(REPO)},
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, ...(process.env.LAUNCH_COVERAGE_DIR ? { NODE_V8_COVERAGE: process.env.LAUNCH_COVERAGE_DIR } : {}) },
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(\`harness exited \${code ?? 'by signal ' + signal}: ${rel}\`));
    });
  });
});
`;
};

for (const tier of ['fast', 'long']) {
  const tierDir = path.join(genDir, tier);
  mkdirSync(tierDir, { recursive: true });
  const wanted = new Set();
  for (const entry of tier === 'fast' ? fastEntries : longEntries) {
    const safe = path.relative(REPO, entry).replace(/[^\w-]/g, '__');
    wanted.add(safe + '.test.mjs');
    writeFileSync(path.join(tierDir, safe + '.test.mjs'), makeWrapper(entry, tier));
  }
  // Remove stale wrappers from renamed/retired entries so vitest never runs
  // a wrapper whose harness no longer exists.
  for (const f of readdirSync(tierDir)) {
    if (f.endsWith('.test.mjs') && !wanted.has(f)) unlinkSync(path.join(tierDir, f));
  }
}

export default defineConfig({
  test: {
    root: REPO,
    include: ['launch/tests/.vitest-gen/**/*.test.mjs'],
    reporters: [['default', { summary: false }]],
    // Harnesses spawn editors/ports/registries keyed by fixed paths — running
    // them concurrently would cross-contaminate (same reason the old CI ran
    // strictly sequentially).
    sequence: { concurrent: false },
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 30_000,
    // SEE-1334 SPEC-021 revised: launch-side coverage is judged by the
    // repo-internal gate (tests/runner/coverage-gate.mjs) over child-process
    // v8 dumps — NOT by vitest's provider. The provider cannot see the
    // harness subprocesses (0% always), so its thresholds here were a fake
    // gate on top of the real one; per the rework ruling the vitest-side
    // threshold block is REMOVED (single true gate, no dual-track fiction).
    // The gate script owns include/exclude + thresholds + exit code.
    coverage: { provider: 'v8' },
  },
});
