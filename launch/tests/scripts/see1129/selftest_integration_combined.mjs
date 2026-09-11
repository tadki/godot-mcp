// SEE-1129 integration check: both predicates combined as the proxy uses them.
// SEE-1273 T3: 过渡窗 import 旧路径（T4 gitlink 切换后随测试树归属裁决调整）
import { decideReuse } from '../../../../launch/see1129-reuse-predicate.mjs';
// SEE-1273 T3: 过渡窗 import 旧路径（T4 gitlink 切换后随测试树归属裁决调整）
import { decideSidecarGuard } from '../../../../launch/see1129-sidecar-guard-predicate.mjs';

const cases = [
  // [holderAgent, ourAgent, holderWT, ourWT, expectAgent, expectGuard, label]
  ['Archi','Archi', null,         '/x/7a634b21', 'reuse',   'evict', 'pre-#499 residual: agent OK, guard evicts (bug fix)'],
  ['Archi','Archi','/x/c508560b', '/x/7a634b21', 'reuse',   'evict', 'worktree mismatch → evict'],
  ['Archi','Archi','/x/7a634b21', '/x/7a634b21', 'reuse',   'reuse', 'own slot: both pass'],
  ['Bachi','Archi','/x/41115b3c', '/x/7a634b21', 'foreign', 'evict', 'cross-agent: refused before guard'],
];

let allOk = true;
for (const [ha, oa, hw, ow, ea, eg, label] of cases) {
  const a = decideReuse(ha, oa, hw, ow);
  const g = decideSidecarGuard(hw, ow);
  const ok = (a === ea && g === eg);
  if (!ok) allOk = false;
  console.log(`${ok ? 'ok  ' : 'BAD '} ${label}: agent=${a}(want ${ea}) guard=${g}(want ${eg})`);
}
console.log(allOk ? 'INTEGRATION OK' : 'INTEGRATION FAIL');
process.exit(allOk ? 0 : 1);
