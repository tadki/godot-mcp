#!/usr/bin/env node
// SEE-1342 §SPEC-110 目标4 — drift-watch RED → 自动建 Multica issue 通道。
// 默认 dry-run：只做「本轮 vs 上轮」RED 集合对比 + step summary 报告，不建 issue；
// Owner/Atlas 确认后，在 workflow 里设 ENABLE_DRIFT_ISSUE_CHANNEL=true 才真调
// `multica issue create`（去重：同项已有 open issue 则 skip；单次 ≤5 个防风暴）。
// 证据型步骤：任何失败都显式写进 summary/日志，但永不非零退出（不挡 evidence run）。
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [currentPath, storeDir, runId] = process.argv.slice(2);
if (!currentPath || !storeDir || !runId) {
  console.error('usage: drift-issue-report.mjs <current-red-file> <store-dir> <run-id>');
  process.exit(0);
}

// FR3 LOW-2：cache restore 状态入 summary，放量期 cache-miss 首日报告失真一眼可辨。
const prevCacheKey = (process.env.PREV_CACHE_KEY ?? '').trim();
const cacheNote = prevCacheKey
  ? `prev=cache-hit (matched ${prevCacheKey})`
  : 'prev=cache-miss (first run this window)';

const norm = (p) => p.trim().replace(/^launch\//, '').replace(/\\/g, '/');
const readSet = (p) => {
  try {
    return new Set(
      readFileSync(p, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map(norm),
    );
  } catch (e) {
    console.error(`[drift-report] cannot read ${p}: ${e.message}`);
    return null;
  }
};

const current = readSet(currentPath);
if (!current) process.exit(0);

// 上一轮 RED 集合 = store 目录里 run_id 数值最大的一份非本轮 red-<runid>.txt（由
// actions/cache restore-keys 跨 run 恢复；首跑无上轮 → 视为空集，全部按「新增」
// 处理）。按数值排序而非字典序：99 < 100，跨位数时字典序会选错对比基准。
let previous = new Set();
let prevLabel = 'none (first run)';
try {
  const candidates = readdirSync(storeDir)
    .map((f) => /^red-(\d+)\.txt$/.exec(f))
    .filter((m) => m && m[1] !== String(runId))
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (candidates.length > 0) {
    prevLabel = candidates[0][0];
    previous = readSet(join(storeDir, prevLabel)) ?? new Set();
  }
} catch (e) {
  console.error(`[drift-report] store dir unreadable: ${e.message}`);
}

const newRed = [...current].filter((t) => !previous.has(t));
const persistent = [...current].filter((t) => previous.has(t));
const resolved = [...previous].filter((t) => !current.has(t));

const summary = [];
const log = (s) => {
  summary.push(s);
  console.log(s);
};

log('## Drift-watch RED report');
log(`- prev set: ${prevLabel} (${previous.size} RED) — ${cacheNote}`);
log(`- current set: ${current.size} RED`);
log(`- NEW RED (${newRed.length}): ${newRed.length ? '' : '—'}`);
for (const t of newRed) log(`  - ${t}`);
log(`- PERSISTENT RED (${persistent.length}): ${persistent.length ? '' : '—'}`);
for (const t of persistent) log(`  - ${t}`);
log(`- RESOLVED since prev round (${resolved.length}): ${resolved.length ? '' : '—'}`);
for (const t of resolved) log(`  - ${t} (drift fixed → graduate candidate)`);

// 建单对象 = 新增 + 持续 RED（都要修），单次限流 ≤5，新增优先。
const CREATE_CAP = 5;
const candidates = [...newRed, ...persistent].slice(0, CREATE_CAP);
const overflow = [...newRed, ...persistent].length - candidates.length;
const enabled = process.env.ENABLE_DRIFT_ISSUE_CHANNEL === 'true';

const summaryPath = process.env.GITHUB_STEP_SUMMARY;
if (summaryPath) {
  try {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(summaryPath, summary.join('\n') + '\n');
  } catch (e) {
    console.error(`[drift-report] cannot append step summary: ${e.message}`);
  }
}

// 放量模式下建单候选截断的可观测性（INFO-1）：overflow 计数在 summary 尾行复述。
const OVERFLOW_NOTE =
  overflow > 0
    ? `[overflow] ${overflow} candidate(s) beyond cap ${CREATE_CAP} NOT queued this round.`
    : `[overflow] 0 (all candidates within cap ${CREATE_CAP}).`;
log(OVERFLOW_NOTE);

if (!enabled) {
  log(
    `[dry-run] ENABLE_DRIFT_ISSUE_CHANNEL not 'true' — would create ${candidates.length} Multica issue(s): ${candidates.join(', ')}${overflow > 0 ? ` (+${overflow} over cap)` : ''}`,
  );
  process.exit(0);
}

// 放量模式：multica 必须真实在场；缺失时显式报告而非静默跳过。
let multica;
try {
  multica = execFileSync('which', ['multica'], { encoding: 'utf8' }).trim();
} catch {
  log('[drift-report] multica CLI not found on runner — issues NOT created (explicit, not silent).');
  process.exit(0);
}

// 去重数据源：现有 open 侧 issue 标题（title 前缀约定 `drift-RED: <entry>`）。
let openTitles = [];
try {
  const raw = execFileSync(multica, ['issue', 'list', '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const issues = JSON.parse(raw);
  openTitles = issues
    .filter((i) => !['done', 'cancelled'].includes(String(i.status ?? '').toLowerCase()))
    .map((i) => String(i.title ?? ''));
} catch (e) {
  log(`[drift-report] issue list probe failed (${e.message.split('\n')[0]}) — cannot dedupe, aborting creation.`);
  process.exit(0);
}

let created = 0;
for (const entry of candidates) {
  const title = `drift-RED: ${entry}`;
  if (openTitles.some((t) => t === title || t.includes(entry))) {
    log(`[skip] open issue already exists for ${entry}`);
    continue;
  }
  const desc = `Automated drift-watch RED (run ${runId}): ${entry}\nRound type: ${newRed.includes(entry) ? 'NEW RED' : 'PERSISTENT RED'}\nWorkflow: launch-special.yml drift-watch`;
  const descFile = `/tmp/drift-issue-${created}.md`;
  const { writeFileSync } = await import('node:fs');
  writeFileSync(descFile, desc);
  try {
    execFileSync(multica, ['issue', 'create', '--title', title, '--description-file', descFile, '--status', 'todo'], {
      encoding: 'utf8',
    });
    created += 1;
    log(`[created] ${title}`);
  } catch (e) {
    log(`[drift-report] issue create failed for ${entry}: ${e.message.split('\n')[0]}`);
  }
}
log(`[drift-report] done: ${created} issue(s) created, ${candidates.length} candidate(s), cap ${CREATE_CAP}.`);
process.exit(0);
