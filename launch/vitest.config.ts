// launch-side vitest config — SEE-1334 Phase 2 (plan §6 / SPEC-020..023),
// scheduling layer reworked by SEE-1342 Phase A (D1 build gate + D3 parallel
// split). ONLY the runner changes: SEE-1291's tiering (fast/long) is
// preserved; the entry lists below are the SAME entries as before, now split
// into a serial bucket and a parallel bucket INSIDE the fast tier.
//
// D1 build gate (§SPEC-101): `server/dist` is gitignored, so a cold checkout
// used to make the FIRST harness pay the launcher's in-window auto-build
// (godot-mcp-launcher.sh "fork CLI missing ... building"), inflating that
// test past its budget and killing it mid-build (Terminated) — fake reds
// (see1244 tier1_wait 45.2s in the SEE-1340 baseline). The gate below builds
// the fork CLI ONCE at config-load time, before any harness runs. Every
// entry path (local vitest run, CI jobs, coverage gate, speed audit) loads
// this config first, so a warm checkout pays zero and a cold one pays the
// build exactly once, outside the test window.
//
// D3 parallel split (§SPEC-102): the fast tier runs as two projects.
// `fast-serial` keeps the entries whose behavior is anchored to SHARED
// machine state (network clone of fork main, machine-wide /proc sweeps, the
// shared default port 6550) — strictly one at a time, byte-identical
// wrappers to the pre-1342 layout. `fast-par` runs everything else
// concurrently (maxWorkers 4, in the Owner-approved 4-6 band); each of its
// wrappers redirects HOME / GODOT_MCP_HOME / KOL_PORT_REGISTRY_PATH_OVERRIDE
// to a private per-run mktemp sandbox — the same override seam ws4 already
// demonstrates (test_see1240_ws4_status_doctor.sh:32-37). No test file is
// edited: case semantics are untouched, every harness still runs as its own
// process with exit code as the pass/fail contract. Any single entry can be
// moved back into FAST_SERIAL (one-line list edit) to bisect an偶发红.
//
// stdin defense (SPEC-022) is preserved verbatim: wrappers spawn each
// harness with stdio stdin: 'ignore' — the process-level equivalent of
// </dev/null (read() → EOF immediately).
//
// Tier membership moves with the SEE-1291 graduation flow (drift → fast), by
// editing these lists. The 61 drift/env harness files stay auto-discovery
// EXCLUDED; they keep running via launch-special.yml. `ws-mock-listener.mjs`
// is a shared mock server, not a test.

import { execSync } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const REPO = path.resolve(import.meta.dirname, '..');

// ——— D1 build gate (§SPEC-101) ————————————————————————————————————————————
// Mirror the launcher's own trigger (FORK_CLI missing / not executable) and
// its remedy (npm ci when node_modules is absent, then npm run build, then
// chmod +x so the launcher's `-x` check passes without rebuilding).
const FORK_CLI = path.join(REPO, 'server/dist/cli.js');
const SERVER_DIR = path.join(REPO, 'server');
try {
  accessSync(FORK_CLI, fsConstants.X_OK);
} catch {
  console.log('[vitest.config] D1 gate: server/dist/cli.js missing — building fork CLI before the tier starts (one-time, gitignored output)...');
  if (!existsSync(path.join(SERVER_DIR, 'node_modules'))) {
    execSync('npm ci --no-audit --no-fund', { cwd: SERVER_DIR, stdio: 'inherit' });
  }
  execSync('npm run build', { cwd: SERVER_DIR, stdio: 'inherit' });
  execSync(`chmod +x "${FORK_CLI}"`, { cwd: SERVER_DIR, stdio: 'inherit' });
}

// ——— SSOT entry lists (mirrors launch-ci.yml / launch-special long bucket) ———
//
// FAST_SERIAL — shared-machine-state bucket, runs strictly one at a time.
// Per-item binning evidence (§SPEC-102 高风险通道 requirement):
//
//   see1273 五件已按 §SPEC-106（D2，Owner 2026-09-23 指令）迁出 fast tier，
//   归入 launch-special.yml drift 桶（evidence runs，非阻塞）；红修复已落地
//   （hermetic HOME fixture 化 + t1 cleanup trap）。毕业回 fast 走 SEE-1291
//   graduation flow。
//   test_see1137_reaper_headless_orphan_sweep.sh — 以 KOL_REAP_HEADLESS_GRACE_M=0
//   调用真实 reap-stale-leases.sh：grace=0 的 headless 扫描按 /proc cmdline
//   匹配并击杀【全机】所有 godot --headless 进程（reap-stale-leases.sh
//   list_headless_orphans），会误杀同窗 see1273 t1_import 的真实 godot 进程；
//   仅在与一切真实 godot 进程互斥的串行桶内安全。
//
//   test_see1070_proxy_default_port_guard.sh — 行为半区绑定【共享默认端口
//   6550】（GODOT_PORT 字面量，--allow-default 变体会真实 bind 6550）；共享
//   端口项按 §SPEC-102 分箱规则留串行桶。
//
//   test_see1148_t16_runtime_identity.sh — T16.9 断言 port-registry.lib.sh 在
//   HOME 未设时必须 FATAL 拒选路径（F11 no-fallback 守卫）。该断言与
//   KOL_PORT_REGISTRY_PATH_OVERRIDE 注入【语义对立】：override 在场时 lib 走
//   override 分支、HOME 检查永不触发（SEE-1342 首轮并行实测稳定复红，非时序
//   flake）。任何 override 注入型调度下都必须以真实环境独占运行。
//
//   see1129/test_lease_lifecycle_boundary_matrix.sh — 串行执行 9 次
//   reap-stale-leases.sh 全量 pass（单次 15-45s：WSL2 pwsh per-port 探测），
//   原生即 ~分钟级；180s 逐项预算在 ≥4-way 调度延迟下必然溢出（两轮并行实测
//   均撞 180s timeout）。机器级扫描器，与 see1137 同类。
//
//   test_see1111_defect6_wsprobe_first_call.sh / test_see1111_defect7_respawn.sh /
//   test_see1244_rechain.mjs — 三件均为「固定 sleep 窗内订阅 stderr/计数文件」的
//   时序断言（F2.1 于 +0.3s 读 WS 握手计数、R6.3 re-warm 窗内 npx 到达、R4 链
//   重启日志流观测窗），在 4-way 负载下窗内信号迟到（r1/r3/r4 各复现一次，
//   互换出现），串行基线稳定绿 → 留串行桶（同 v2_gate 判据）。
//
//   test_see1244_v2_gate.mjs — shim 状态机亚秒级时序窗：W1 断言
//   worktree_wait 先于 proxy_warming 出现在 stderr 订阅流（两轮并行实测均为
//   排序颠倒）、D3 断言 SHIM_CHAIN_EXIT 落日志观测窗。对调度延迟零容忍，
//   串行基线稳定绿 → 留串行桶。
//
//   —— SEE-1344 rebin 8 项（紧时序窗/负载校准预算，4-way 实测 flake 证据；
//   与上方三先例同语义，r7-r10 全量 sweep 定性，详见 ② 汇报与 f5e2486）——
//
//   test_see1045_stdio_proxy.sh — stub launcher 全链 stdio 观测窗按
//   delay+6s 校准（launcher 侧 WORKTREE_WAIT/prepare 链路延迟窗）；4-way
//   下 exec 落点越过观测窗（r3 实测红，standalone 稳定绿）→ 留串行桶。
//
//   test_see1077_edge_cases.sh — E2 burst 断言依赖「5 条 exiting 行 <100ms
//   写入后 5s 内 fast-fail 恰一次」的亚秒窗 + E1/E3 的 warm 观测预算；
//   r7/r9 实测 E2.1-E2.4 全组红（lease 计时器被调度延迟拖过 5s 窗），
//   standalone 稳定绿 → 留串行桶。
//
//   test_see990_mcp_ready_gate.sh — B1 断言 gate 路径 <6s（TCP 快路径
//   wall 上限语义）+ A1 exec 观测窗；r9 实测 B1 11s（预算超限非语义红）
//   → 留串行桶。
//
//   test_see1111_fork_wiring.sh — Case A/B 依赖 stub launcher 在固定 sleep
//   观测窗内完成 fork 解析 + 子进程 spawn（marker 文件落盘窗）；r8 实测
//   marker 空组红，standalone 5/5 稳定绿 → 留串行桶。
//
//   test_see1111_warmup_hint.sh — W9 断言 3s warmup 窗内 held 不应答、
//   窗口耗尽后以 recovering 诊断应答（hold-to-timeout 语义即被测对象）；
//   负载下 spawn 链延迟使应答提前落窗（r8 实测 W9a 红）→ 留串行桶。
//
//   test_see1148_p3_reclaim.sh — reaper 全量 sweep ×多 case，单 case 内
//   真实时钟 grace 窗（intentional_release 15s 窗语义）+ resident 模式
//   切换等待；机器级扫描器（与 see1137/lease_matrix 同类），r10 实测
//   180s 逐项预算溢出（standalone 36s 绿）→ 留串行桶。
//
//   test_see1244_cache_closure.mjs — PROACTIVE refresh 闭环断言挂 30s
//   closure timer（负载校准预算，r2 恰以 30.5s 撞线红，r1/r3 绿）；
//   cache 写入时机依赖 warm+CLI 连接的亚秒窗 → 留串行桶。
//
//   test_see1244_proxy_tools_cache.mjs — 同族：tools cache 写入点 =
//   NPX_CLI_CONNECTED 亚秒窗后的同步 rename（r8 实测 write 点被调度延迟
//   推出观测窗）→ 留串行桶。
const FAST_SERIAL = `
launch/tests/scripts/see1137/test_reaper_headless_orphan_sweep.sh
launch/tests/scripts/see1129/test_lease_lifecycle_boundary_matrix.sh
launch/tests/scripts/test_see1070_proxy_default_port_guard.sh
launch/tests/scripts/test_see1148_t16_runtime_identity.sh
launch/tests/scripts/test_see1244_v2_gate.mjs
launch/tests/scripts/test_see1111_defect6_wsprobe_first_call.sh
launch/tests/scripts/test_see1111_defect7_respawn.sh
launch/tests/scripts/test_see1244_rechain.mjs
launch/tests/scripts/test_see1045_stdio_proxy.sh
launch/tests/scripts/test_see1077_edge_cases.sh
launch/tests/scripts/test_see990_mcp_ready_gate.sh
launch/tests/scripts/test_see1111_fork_wiring.sh
launch/tests/scripts/test_see1111_warmup_hint.sh
launch/tests/scripts/test_see1148_p3_reclaim.sh
launch/tests/scripts/test_see1244_cache_closure.mjs
launch/tests/scripts/test_see1244_proxy_tools_cache.mjs
launch/tests/scripts/test_see1244_runtime_held_wait.sh
launch/tests/scripts/test_see1244_shim_handoff.mjs
`;

// SEE-1344 ⑫ graduation notes (2, drift residual → 2): event-driven-hardened
// greens per Owner 2026-09-24 23:04 ruling —
//   test_see1244_shim_handoff.mjs — shim 状态机亚秒窗族（同 v2_gate 判据）：
//   固定 300/500ms boot/顺序 sleep 已改事件驱动（callUntilEcho transient 重发
//   + exit 事件先行监听；CHAIN_STDOUT_OPEN 非 boot 信号，无 --emit-frame 时
//   链 stdout 首行前不触发），4-way 下曾现瞬态 → 留串行桶。
//   test_see1244_runtime_held_wait.sh — 真实时钟 held 预算 + /proc liveness
//   探测（机器级，同 see1137/lease_matrix 判据）；C5 takeover 断言已锚定
//   观测到的 holder-death 事件（≤3.5s = 一个 2s 生产 tick + reclaim）。

// FAST_PARALLEL_SHELL — everything else. Shared binning evidence (all entries
// verified by reading the harness): each creates its own mktemp sandbox
// (SBOX/TMPDIR via lib_init or in-file), redirects HOME / GODOT_MCP_HOME /
// the port registry through the production seams (env.sh:22, env.sh:96-97,
// port-registry.lib.sh:39-40), discovers ports at runtime (find_free_port →
// bind-probe on 127.0.0.1), and drives a MOCK editor / mock npx placed on
// PATH — no fixed ports, no repo-tree writes outside the sandbox (cleanup
// pkills are anchored to the per-test $TMPDIR path), no network. Per-family
// notes:
//   - see1085 t1-t5 + ws7_grace_race + see990: `_see1085_helpers.sh lib_init`
//     (TMPDIR=mktemp, mock-npx bin on PATH, find_free_port, KOL_WORKTREE →
//     throwaway mock worktree).
//   - see1111 余下六件 + see1110_e5: same lib pattern (find_free_port + TMPDIR
//     counters/logs; mock configure/start/npx; defect6's mock completes the
//     WS upgrade on GODOT_PORT=$PORT).
//   - see1129 五件 .sh + 4 纯逻辑 .mjs（anchor/reuse_short_circuit/selftest/
//     release_after_start_race）: 纯函数断言或 HOME=$BASE/home mktemp 沙箱；
//     明确「不碰真实 ~/.multica」。
//   - see1148 剩余六件 + see1077 + see1152 两件 + see1164 四件 + see1240 三件
//     .sh + see1244 shim_degrade/tier1_wait .sh + see1288:
//     SBOX/HOME/GODOT_MCP_HOME/KOL_PORT_REGISTRY_PATH_OVERRIDE 自沙箱
//     （ws4:37 seam 的既有使用者）；see1288 全程在 MOCK_TREE 内验证 launcher
//     构建回退，不触真实 server/dist。
//   - see1148_t15: 纯 bash 谓词函数 + F3 pid 文件断言，全部落自身
//     F3_HOME/T157_HOME mktemp 沙箱（无真实 sweep 调用）。
//   - see1137 之外的 reaper 类（see1152_registry_sweep / see1129_grace_integration
//     / see1152_configure_async_reaper）：registry/sweep 目标全部重定向进自身
//     SBOX（KOL_PORT_REGISTRY_PATH_OVERRIDE / --root "$SBOX"/ws），grace 取值
//     仅作用于沙箱内 fake lease/orphan。
//   - see1338 两件 .mjs + see1170_channel3 + see1240 三件 .mjs + see1152_stage_log:
//     process.env.GODOT_MCP_HOME=mkdtemp 重定向或 mkdtemp 沙箱内 spawn
//     proxy/shim（see1240 三件为纯契约断言 + execFile 短窗超时）。
//   - ac_m3reorg 两件: 纯逻辑/env-shape 断言，无共享状态。
const FAST_PARALLEL_SHELL = `
launch/tests/scripts/test_ac_m3reorg_013_shell_guard_empty.sh
launch/tests/scripts/test_see1077_lease_fast_fail.sh
launch/tests/scripts/test_see1085_t1_cold_spawn.sh
launch/tests/scripts/test_see1085_t2_hot_reuse.sh
launch/tests/scripts/test_see1085_t3_spawn_fail.sh
launch/tests/scripts/test_see1085_t4_lease_respawn.sh
launch/tests/scripts/test_see1085_t5_dedup.sh
launch/tests/scripts/test_see1110_e5_multi_agent_channelA.sh
launch/tests/scripts/test_see1111_cold_start_gate.sh
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
launch/tests/scripts/test_see1152_configure_async_reaper.sh
launch/tests/scripts/test_see1152_reaper_registry_sweep.sh
launch/tests/scripts/test_see1164_adversarial_revy.sh
launch/tests/scripts/test_see1164_persist_stderr.sh
launch/tests/scripts/test_see1164_port_die_adversarial_revy.sh
launch/tests/scripts/test_see1164_port_die_owner.sh
launch/tests/scripts/test_see1240_d1_corrupt_accounting.sh
launch/tests/scripts/test_see1240_ws4_status_doctor.sh
launch/tests/scripts/test_see1240_ws7_grace_race.sh
launch/tests/scripts/test_see1244_shim_degrade.sh
launch/tests/scripts/test_see1244_tier1_wait.sh
launch/tests/scripts/test_see1288_build_fallback_negative.sh
launch/tests/scripts/test_see990_live_gate_race.sh
launch/tests/scripts/see1129/test_multi_path_drift_assertion.sh
launch/tests/scripts/see1129/test_multi_slot_reuse_predicate.sh
launch/tests/scripts/see1129/test_reaper_grace_integration.sh
launch/tests/scripts/see1129/test_runtime_registry_marker.sh
launch/tests/scripts/see1129/test_sidecar_guard_predicate.sh
launch/tests/scripts/test_see1117_phase1_marker_lifecycle.sh
launch/tests/scripts/test_see1117_sidecar_lifecycle.sh
launch/tests/scripts/test_see1070_proxy_exec_hints.sh
launch/tests/scripts/test_see1070_proxy_screenshot_hint.sh
launch/tests/scripts/test_see1070_warmup_self_heal.sh
launch/tests/scripts/test_see1085_t6_editor_busy.sh
launch/tests/scripts/test_see1085_t8_direct_node.sh
launch/tests/scripts/test_see1085_t9_editor_gone.sh
launch/tests/scripts/test_see1085_t10_takeover_success.sh
launch/tests/scripts/test_see1085_t11_takeover_timeout.sh
launch/tests/scripts/test_see1110_e1_cold_warmup_timeline.sh
launch/tests/scripts/test_see1110_e2_editor_busy_channelA.sh
launch/tests/scripts/test_see1110_e3_lease_exit_channelA.sh
launch/tests/scripts/test_see1111_worktree_isolation.sh
launch/tests/scripts/test_see1152_reaper_held_sweep.sh
launch/tests/scripts/test_see1240_exec_constraints_proxy.sh
launch/tests/scripts/test_see1240_proxy_integration.sh
launch/tests/scripts/test_see1348_m4_gate_matrix.sh
`;

// FAST_NODE — same binning evidence as the shell bucket above (mkdtemp
// GODOT_MCP_HOME redirects or pure-logic assertions; see the family notes).
const FAST_NODE = `
launch/tests/scripts/test_see1348_m6_coldstart.mjs
launch/tests/scripts/test_see1348_m4_editor_pid_state.mjs
launch/tests/scripts/test_see1348_qa_relay_wiring.mjs
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
launch/tests/scripts/test_see1244_shim_handshake.mjs
launch/tests/scripts/test_see1244_shim_placeholder.mjs
launch/tests/scripts/test_see1338_p1_sot.mjs
launch/tests/scripts/test_see1338_stale_takeover.mjs
launch/tests/scripts/test_see1085_t7_resolver.mjs
launch/tests/scripts/test_see1110_stage_parser.mjs
`;

const LONG = `
launch/tests/scripts/test_see1148_t14_reaper_grace_guard.sh
launch/tests/scripts/test_see1240_ws5_giveup_rearm.sh
launch/tests/hooks/see1273/test_see1273_t1_import.sh
launch/tests/hooks/see1273/test_see1273_t2_chain.sh
launch/tests/hooks/see1273/test_see1273_t3_chain.sh
launch/tests/hooks/see1273/test_see1273_t4_chain.sh
launch/tests/scripts/test_see1134_restart_hold.sh
// SEE-1344 ⑫+: 5-agent concurrent cold start — real-clock/concurrency-window
// by nature (configure's async reaper + 15s warmup budget + RECOVERING lane
// under load), so it is a long-tier entry per §SPEC-120, not drift, not fast.
launch/tests/scripts/test_see1111_e5_concurrent_5agent.sh
`;

const parse = (block) => block.trim().split('\n').map((s) => s.trim()).filter(Boolean)
  .map((rel) => path.join(REPO, rel))
  .filter((p) => existsSync(p));

const serialEntries = parse(FAST_SERIAL);
const fastEntries = [...parse(FAST_PARALLEL_SHELL), ...parse(FAST_NODE)];
const longEntries = parse(LONG);

if (serialEntries.length !== 18) {
  throw new Error(`fast serial bucket expects 16 entries (8 + SEE-1344's 8 load-fragile graduates: tight internal timing windows proven to flake under 4-way load in r7-r9 sweeps), resolved ${serialEntries.length} — update the bucket in sync with the SEE-1291 graduation flow`);
}
if (serialEntries.length + fastEntries.length !== 94) {
  throw new Error(`fast tier expects 94 entries (serial + parallel; SEE-1344 ⑫ graduates + SEE-1348 WP4 m4_gate_matrix/m4_editor_pid_state + WP7 m6_coldstart + F-QA-1 qa_relay_wiring), resolved ${serialEntries.length + fastEntries.length} — an entry was renamed/retired; update the list in sync with the SEE-1291 graduation flow`);
}
if (longEntries.length !== 8) {
  throw new Error(`long tier expects 8 entries (SEE-1344 ⑫+: e5_concurrent joins the 7), resolved ${longEntries.length}`);
}

// Generate one wrapper per entry under .vitest-gen/<bucket>/ (gitignored —
// derived data; regenerating on config load keeps CI honest).
const genDir = path.join(REPO, 'launch/tests/.vitest-gen');
mkdirSync(genDir, { recursive: true });

const makeWrapper = (entry, tier, parallel) => {
  const rel = path.relative(REPO, entry);
  const runner = entry.endsWith('.mjs') ? 'node' : 'bash';
  // fast tier: shell job budget 10min / per-item 180s, node budget 5min / 120s
  // (SEE-1291 budgets, kept verbatim). long tier: 600s per launch-special.yml.
  // EXCEPTION — see1129 boundary_matrix: 9 sequential reaper passes are
  // natively ~105s (measured standalone, hermetic mode); its 180s fast-tier
  // budget is a serial-bucket artifact with zero parallel-load headroom.
  // Being serial-bucketed (§SPEC-102 binning), its wrapper budget extends to
  // the fast-tier JOB ceiling (10min, same as launch-ci.yml's shell job) —
  // wrapper-only scheduling relief; the harness itself is untouched.
  const isSerialHeavy = rel.endsWith('test_lease_lifecycle_boundary_matrix.sh');
  const timeout = tier === 'fast' ? (isSerialHeavy ? 600_000 : 180_000) : 600_000;
  // §SPEC-102: parallel-bucket wrappers redirect the three env seams to a
  // private per-run mktemp sandbox — the ws4 harness seam
  // (test_see1240_ws4_status_doctor.sh:32-37), applied at the scheduling
  // layer. Harnesses that sandbox themselves re-export and win; harnesses
  // that derive state from HOME/GODOT_MCP_HOME get isolation for free; the
  // port registry alias maps to the canonical override in env.sh:96-97.
  // ~/.gitconfig is copied in so any git op under the sandbox keeps the
  // operator's identity. Serial wrappers stay byte-identical to the
  // pre-1342 layout (no injection — real environment, one at a time).
  const sandbox = parallel ? `
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

const SANDBOX_HOME = mkdtempSync(path.join(tmpdir(), 'kol-fast-par-'));
const SANDBOX_ENV = {
  HOME: SANDBOX_HOME,
  GODOT_MCP_HOME: path.join(SANDBOX_HOME, '.multica'),
  KOL_PORT_REGISTRY_PATH_OVERRIDE: path.join(SANDBOX_HOME, '.multica', 'godot-port-registry.json'),
};
const REAL_GITCONFIG = path.join(homedir(), '.gitconfig');
if (existsSync(REAL_GITCONFIG)) {
  try { copyFileSync(REAL_GITCONFIG, path.join(SANDBOX_HOME, '.gitconfig')); } catch { /* best-effort identity seed */ }
}
process.on('exit', () => { try { rmSync(SANDBOX_HOME, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } });
` : '';
  const envExpr = parallel
    ? 'env: { ...process.env, ...SANDBOX_ENV, ...(process.env.LAUNCH_COVERAGE_DIR ? { NODE_V8_COVERAGE: process.env.LAUNCH_COVERAGE_DIR } : {}) },'
    : 'env: { ...process.env, ...(process.env.LAUNCH_COVERAGE_DIR ? { NODE_V8_COVERAGE: process.env.LAUNCH_COVERAGE_DIR } : {}) },';
  return `// GENERATED by vitest.config.ts — do not edit. Entry: ${rel}
import { test } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
${sandbox}
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
      ${envExpr}
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

for (const [bucket, entries, tier, parallel] of [
  ['fast', serialEntries, 'fast', false],
  ['fast-par', fastEntries, 'fast', true],
  ['long', longEntries, 'long', false],
]) {
  const bucketDir = path.join(genDir, bucket);
  mkdirSync(bucketDir, { recursive: true });
  const wanted = new Set();
  for (const entry of entries) {
    const safe = path.relative(REPO, entry).replace(/[^\w-]/g, '__');
    wanted.add(safe + '.test.mjs');
    writeFileSync(path.join(bucketDir, safe + '.test.mjs'), makeWrapper(entry, tier, parallel));
  }
  // Remove stale wrappers from renamed/retired entries so vitest never runs
  // a wrapper whose harness no longer exists.
  for (const f of readdirSync(bucketDir)) {
    if (f.endsWith('.test.mjs') && !wanted.has(f)) unlinkSync(path.join(bucketDir, f));
  }
}

export default defineConfig({
  test: {
    root: REPO,
    include: ['launch/tests/.vitest-gen/**/*.test.mjs'],
    reporters: [['default', { summary: false }]],
    // Harnesses spawn editors/ports/registries; cross-project and intra-bucket
    // discipline is owned by the projects below (SEE-1342 §SPEC-102).
    sequence: { concurrent: false },
    // SEE-1334 SPEC-021 revised: launch-side coverage is judged by the
    // repo-internal gate (tests/runner/coverage-gate.mjs) over child-process
    // v8 dumps — NOT by vitest's provider. The provider cannot see the
    // harness subprocesses (0% always), so its thresholds here were a fake
    // gate on top of the real one; per the rework ruling the vitest-side
    // threshold block is REMOVED (single true gate, no dual-track fiction).
    // The gate script owns include/exclude + thresholds + exit code.
    coverage: { provider: 'v8' },
    projects: [
      {
        // Serial bucket: shared-machine-state entries (see FAST_SERIAL
        // evidence notes). fileParallelism:false ⇒ maxWorkers 1 — one harness
        // at a time, exactly the pre-1342 behavior for these entries.
        test: {
          name: 'fast-serial',
          include: ['launch/tests/.vitest-gen/fast/**/*.test.mjs'],
          fileParallelism: false,
          testTimeout: 600_000,
          hookTimeout: 30_000,
        },
      },
      {
        // Parallel bucket: self-sandboxing entries + per-run env-seam
        // injection (see makeWrapper). 4 workers sits in the Owner-approved
        // 4-6 band (§SPEC-102). Calibrated: real-clock stderr-subscription /
        // ≤4s-poll budgets in the timing-sensitive harnesses collapse under
        // ≥5-way contention (each worker nests a 3+ process tree on 8
        // logical cores) — measured in the SEE-1342 first parallel run.
        test: {
          name: 'fast-par',
          include: ['launch/tests/.vitest-gen/fast-par/**/*.test.mjs'],
          fileParallelism: true,
          maxWorkers: 4,
          testTimeout: 600_000,
          hookTimeout: 30_000,
        },
      },
      {
        // Long tier: unchanged serial scheduling (launch-special.yml drives
        // it via the .vitest-gen/long path filter).
        test: {
          name: 'long',
          include: ['launch/tests/.vitest-gen/long/**/*.test.mjs'],
          fileParallelism: false,
          testTimeout: 600_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
