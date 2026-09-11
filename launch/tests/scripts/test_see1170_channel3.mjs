#!/usr/bin/env node
// SEE-1170 通道 3 对抗性 QA — proxy tryPruneBareRepo / pruneThenRestat / hasPrunedBareRepo
// 测试方式：从真实 proxy 文件提取 SEE-1170 函数体，注入 stub 依赖，隔离验证。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { existsSync as _mcp_exists } from "node:fs";
const _proxy_default = path.resolve(new URL("../../../launch/godot-mcp-proxy.mjs", import.meta.url).pathname); // SEE-1273 T5-F 单落点（fork 根 = launch/；argv[2] 或 KOL 场景传 KOL proxy 绝对路径可覆盖）
const PROXY = path.resolve(process.argv[2] || _proxy_default);
const src = readFileSync(PROXY, 'utf8');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('PASS: ' + m); };
const bad = (m) => { fail++; console.log('FAIL: ' + m); };
const assertEq = (m, a, b) => (a === b ? ok(`${m} (got=${a})`) : bad(`${m} (want=${b} got=${a})`));
const assertTrue = (m, a) => (a ? ok(m) : bad(m));

// ---- Extract SEE-1170 function block from the proxy source ----
function extractFn(name) {
  const re = new RegExp(`^(async )?function ${name}\\([\\s\\S]*?\\n\\}`, 'm');
  const m = src.match(re);
  if (!m) throw new Error(`fn ${name} not found in proxy source`);
  return m[0];
}
// also need the two state vars
const stateVars = `
let hasPrunedBareRepo = false;
let lastBareRepoPruneDiag = null;
const stageLogCalls = [];
function stageLog(stage, msg) { stageLogCalls.push(stage + '|' + msg); }
`;

// Build a sandbox that exposes our stub environment then defines the functions.
function buildSandbox(extraEnv = {}) {
  const fnBlock = [
    stateVars,
    extractFn('deriveBareRepoFromAnchor'),
    extractFn('tryPruneBareRepo'),
    extractFn('pruneThenRestat'),
    'return { deriveBareRepoFromAnchor, tryPruneBareRepo, pruneThenRestat, getDiag: () => lastBareRepoPruneDiag, getLog: () => stageLogCalls.slice(), getHasPruned: () => hasPrunedBareRepo, resetState: () => { hasPrunedBareRepo = false; lastBareRepoPruneDiag = null; stageLogCalls.length = 0; } };',
  ].join('\n');
  const sandbox = {
    readFileSync,
    path,
    spawn: extraEnv.spawn,
    stat: extraEnv.stat,
    Date,
    console,
  };
  const fn = new Function(...Object.keys(sandbox), fnBlock);
  return fn(...Object.values(sandbox));
}

// fake spawn: returns a controllable fake child
function makeFakeSpawn(behavior) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args });
    const listeners = {};
    const child = {
      kill: () => { queueMicrotask(() => listeners.close && listeners.close(null)); },
      on: (ev, cb) => { listeners[ev] = cb; },
    };
    const r = behavior(cmd, args, calls.length);
    queueMicrotask(() => {
      if (r.error) listeners.error && listeners.error(new Error('spawn error'));
      else listeners.close && listeners.close(r.code);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

// ---- Fixture: bare repo + worktree .git file with gitdir ----
function makeBareWithStale() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'see1170-c3-'));
  const bare = path.join(tmp, 'bare.git');
  execFileSync('git', ['init', '--bare', '-q', bare]);
  const seed = path.join(tmp, 'seed');
  mkdirSync(seed);
  writeFileSync(path.join(seed, 'x'), 'y');
  execFileSync('git', ['-C', seed, 'init', '-q']);
  execFileSync('git', ['-C', seed, 'add', '.']);
  execFileSync('git', ['-C', seed, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i']);
  execFileSync('git', ['-C', bare, 'fetch', '-q', seed, 'HEAD:master']);
  // make a "worktree" dir with a .git FILE pointing to bare/worktrees/slot
  const wt = path.join(tmp, 'ws', 'deadbeef', 'workdir', 'repo');
  mkdirSync(wt, { recursive: true });
  const slot = 'slot1';
  mkdirSync(path.join(bare, 'worktrees', slot), { recursive: true });
  writeFileSync(path.join(wt, '.git'), `gitdir: ${bare}/worktrees/${slot}\n`);
  return { tmp, bare, wt, seed };
}

(async () => {
  // ===== S14: deriveBareRepoFromAnchor extracts bare path =====
  {
    const { tmp, bare, wt } = makeBareWithStale();
    const sb = buildSandbox({ spawn: makeFakeSpawn(() => ({ code: 0 })), stat: async () => {} });
    const derived = sb.deriveBareRepoFromAnchor(wt);
    assertEq('S14 derive bare repo from .git file', derived, bare);
    rmSync(tmp, { recursive: true, force: true });
  }

  // ===== S14b: derive returns null when no .git file exists =====
  {
    const tmp = mkdtempSync(path.join(tmpdir(), 'see1170-c3-'));
    const anchor = path.join(tmp, 'nonexistent', 'repo');
    const sb = buildSandbox({ spawn: makeFakeSpawn(() => ({ code: 0 })), stat: async () => {} });
    const derived = sb.deriveBareRepoFromAnchor(anchor);
    assertEq('S14b derive returns null when unresolved', derived, null);
    rmSync(tmp, { recursive: true, force: true });
  }

  // ===== S16: bare repo unresolved -> explicit log + attempted=false, no spawn =====
  {
    const sb = buildSandbox({ spawn: makeFakeSpawn(() => ({ code: 0 })), stat: async () => {} });
    await sb.tryPruneBareRepo(null);
    const diag = sb.getDiag();
    assertEq('S16 attempted=false', diag.attempted, false);
    assertEq('S16 reason', diag.reason, 'bare_repo_unresolved');
    const logs = sb.getLog().join('\n');
    assertTrue('S16 explicit log emitted', logs.includes('prune skipped: bare repo unresolved'));
  }

  // ===== S17: hasPrunedBareRepo caps prune to once per process =====
  {
    const spawn = makeFakeSpawn(() => ({ code: 0 }));
    const sb = buildSandbox({ spawn, stat: async () => {} });
    await sb.tryPruneBareRepo('/some/bare');
    await sb.tryPruneBareRepo('/some/bare');
    assertEq('S17 spawn called exactly once', spawn.calls.length, 1);
    const diag = sb.getDiag();
    assertEq('S17 second call reason=already_pruned', diag.reason, 'already_pruned');
    assertEq('S17 attempted=false on 2nd', diag.attempted, false);
  }

  // ===== S14c: pruneThenRestat recovered — stat succeeds after prune =====
  {
    const spawn = makeFakeSpawn(() => ({ code: 0 }));
    const goodStat = async () => ({});
    const sb = buildSandbox({ spawn, stat: goodStat });
    const r = await sb.pruneThenRestat('/any/path');
    assertEq('S14c recovered=true', r.recovered, true);
    assertEq('S14c statAfterPrune', sb.getDiag().statAfterPrune, 'recovered');
    const logs = sb.getLog().join('\n');
    assertTrue('S14c recovered log', logs.includes('stat recovered after prune'));
  }

  // ===== S15: pruneThenRestat still_failing — stat fails after prune =====
  {
    const spawn = makeFakeSpawn(() => ({ code: 0 }));
    const failStat = async () => { const e = new Error('no'); e.code = 'ENOENT'; throw e; };
    const sb = buildSandbox({ spawn, stat: failStat });
    const r = await sb.pruneThenRestat('/any/path');
    assertEq('S15 recovered=false', r.recovered, false);
    assertEq('S15 statAfterPrune=still_failing', sb.getDiag().statAfterPrune, 'still_failing');
    const logs = sb.getLog().join('\n');
    assertTrue('S15 cause-unclear log', logs.includes('cause unclear'));
  }

  // ===== S15b: prune non-zero exit still returns normally =====
  {
    const { tmp, bare, wt } = makeBareWithStale(); // real path so derive succeeds
    const spawn = makeFakeSpawn(() => ({ code: 128 }));
    const sb = buildSandbox({ spawn, stat: async () => {} });
    const r = await sb.pruneThenRestat(wt);
    assertEq('S15b prune non-zero non-fatal outcome=exit_128', sb.getDiag().outcome, 'exit_128');
    assertEq('S15b still recovered if stat ok', r.recovered, true);
    rmSync(tmp, { recursive: true, force: true });
  }

  // ===== S17b: prune timeout (5000ms) -> resolve timeout, non-fatal =====
  // use shorter jitter: override spawn that never closes
  {
    const spawn = (cmd, args) => {
      const listeners = {};
      return {
        kill: () => { /* simulate real SIGKILL: process gone, no close event */ },
        on: (ev, cb) => { listeners[ev] = cb; },
      };
    };
    const sb = buildSandbox({ spawn, stat: async () => {} });
    const t0 = Date.now();
    await sb.tryPruneBareRepo('/any');
    const elapsed = Date.now() - t0;
    assertTrue(`S17b timeout fires around 5s (elapsed=${elapsed}ms)`, elapsed >= 4900 && elapsed < 6000);
    assertEq('S17b outcome=timeout', sb.getDiag().outcome, 'timeout');
  }

  console.log('==========================================');
  console.log(`SUMMARY: PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
