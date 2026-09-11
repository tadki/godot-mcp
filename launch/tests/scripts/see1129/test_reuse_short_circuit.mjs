// SEE-1129 v6 reuse 短路 mock (M_reuse_short, sub-step dcacbb66).
//
// Archi 回归 v2 定位：ensureEditor() 在 tcpProbe(port)=busy 时直接 reuse 短路，
// 完全绕过 spawn / sidecar-guard / 路径 B 整条链路——证据是 c508560b lease_id
// 跨 3 轮回归不变（configure 没跑）+ sidecar 始终不存在（spawn 没跑）+ editor/
// mtime 调用时刻被写（打到活跃 holder）。
//
// 该诊断在 main 仓库 master 分支上完全成立：master 的 ensureEditor 在
// (master.proxy.mjs:1575-1580) 是无条件 reuse，零守卫。本 mock 验证的是
// shared/SEE-1129 上的修复形态（proxy.mjs:1683-1739）：reuse 短路点 return 之前
// 必须先跑 decideReuse（agent 域）+ decideSidecarGuard（worktree 域），任一判
// evict/foreign 即 evict holder 并 fall through spawn，spawn 写出本 slot sidecar。
//
// 本 mock 把 ensureEditor reuse 分支的【控制流】抽成纯函数 decideReuseBranch，
// 用真实谓词（see1129-reuse-predicate + see1129-sidecar-guard）跑 Archi 现场精确
// 复现 + 边界矩阵。断言：修前（裸 reuse）错；修后（守卫触发）对。
//
// 不碰真实 ~/.multica 或真实工作区；纯逻辑判定。

// SEE-1273 T3: 过渡窗 import 旧路径（T4 gitlink 切换后随测试树归属裁决调整）
import { decideReuse } from '../../../../launch/see1129-reuse-predicate.mjs';
// SEE-1273 T3: 过渡窗 import 旧路径（T4 gitlink 切换后随测试树归属裁决调整）
import { decideSidecarGuard } from '../../../../launch/see1129-sidecar-guard-predicate.mjs';

// shared/SEE-1129 ensureEditor reuse 分支的控制流抽象。
// 输入：port 是否 busy + holder/本 slot 的 agent 与 worktree。
// 输出：'reuse'（直接返回 holder 连接）/ 'evict_then_spawn'（evict + fall through
// spawn + 写本 slot sidecar）/ 'foreign_error'（cross-agent，抛错而非 reuse）。
// 这是 proxy.mjs:1683-1739 的等价纯函数——master 分支没有这段逻辑。
function decideReuseBranch({ portBusy, holderAgent, ourAgent, holderWorktree, ourWorktree }) {
    // master:1575 无条件 reuse 短路点：port busy 即 return reuse，零守卫——
    // 这正是 Archi 现场复现的失败模式。本函数仅在 portBusy 时进入分支。
    if (!portBusy) return 'spawn_cold';

    // shared/SEE-1129:1700 agent 域守卫先跑——cross-agent holder 抛错（principle #5）。
    if (decideReuse(holderAgent, ourAgent, holderWorktree, ourWorktree) === 'foreign') {
        return 'foreign_error';
    }
    // shared/SEE-1129:1718 worktree 域守卫——holder 不可证明服务本 slot 即 evict。
    if (decideSidecarGuard(holderWorktree, ourWorktree) === 'evict') {
        // shared/SEE-1129:1724 evict holder → fall through spawn → 写本 slot sidecar。
        return 'evict_then_spawn';
    }
    // shared/SEE-1129:1734 holder 可证明是本 slot editor → 安全 reuse。
    return 'reuse';
}

// master 分支的对照模型：port busy 即裸 reuse，无任何守卫。用于证明"修前"行为。
function decideReuseBranch_master({ portBusy }) {
    if (!portBusy) return 'spawn_cold';
    return 'reuse'; // master:1576-1580 无条件 reuse，绕过一切
}

const WS = '11111111-2222-3333-4444-555555555555';
const ARCHI_OLD = `/home/jerry/multica_workspaces/${WS}/c508560b/workdir/KingOfLikes-Godot`;
const ARCHI_NEW = `/home/jerry/multica_workspaces/${WS}/7a634b21/workdir/KingOfLikes-Godot`;
const BACHI_OLD = `/home/jerry/multica_workspaces/${WS}/17219eb2/workdir/KingOfLikes-Godot`;
const BACHI_NEW = `/home/jerry/multica_workspaces/${WS}/41115b3c/workdir/KingOfLikes-Godot`;

const cases = [
    // [label, input, wantFixed, wantMaster, note]
    // wantFixed = shared/SEE-1129 修复后期望；wantMaster = master 修前期望（证明 bug）。
    ['Archi 现场：port busy + 残留 holder(c508560b) 无 sidecar, 本 slot 7a634b21',
     { portBusy: true, holderAgent: 'Archi', ourAgent: 'Archi', holderWorktree: null, ourWorktree: ARCHI_NEW },
     'evict_then_spawn', 'reuse',
     'Archi 回归 v2 精确复现：lease 不变 + sidecar 不写 → 必须触发守卫 evict'],

    ['Archi 现场：port busy + 残留 holder sidecar 指 c508560b, 本 slot 7a634b21',
     { portBusy: true, holderAgent: 'Archi', ourAgent: 'Archi', holderWorktree: ARCHI_OLD, ourWorktree: ARCHI_NEW },
     'evict_then_spawn', 'reuse',
     'worktree 不匹配 → evict + spawn 写 7a634b21 sidecar'],

    ['Bachi 现场（本回合真机）：port busy + 残留 holder(17219eb2), 本 slot 41115b3c',
     { portBusy: true, holderAgent: 'Bachi', ourAgent: 'Bachi', holderWorktree: BACHI_OLD, ourWorktree: BACHI_NEW },
     'evict_then_spawn', 'reuse',
     '本 Bachi slot 真机复现（KOL_WORKTREE 漂移到 17219eb2）'],

    ['同 slot 断线重连：holder sidecar == 本 slot → 安全 reuse（principle #1/#2）',
     { portBusy: true, holderAgent: 'Archi', ourAgent: 'Archi', holderWorktree: ARCHI_NEW, ourWorktree: ARCHI_NEW },
     'reuse', 'reuse',
     '可证明 holder 即本 slot editor → 不重复 spawn'],

    ['cross-agent holder（端口映射错配）→ 抛 foreign_error，绝不静默 reuse',
     { portBusy: true, holderAgent: 'Bachi', ourAgent: 'Archi', holderWorktree: BACHI_NEW, ourWorktree: ARCHI_NEW },
     'foreign_error', 'reuse',
     'principle #5：cross-agent 必须报错；master 会裸 reuse（严重 bug）'],

    ['port 空闲 → 冷启动 spawn（不进 reuse 分支）',
     { portBusy: false, holderAgent: null, ourAgent: 'Archi', holderWorktree: null, ourWorktree: ARCHI_NEW },
     'spawn_cold', 'spawn_cold',
     '无 holder → 正常 spawn 写 sidecar'],

    ['port busy + holder 不可验证（pre-#499 无 sidecar 无 lease agent）→ evict',
     { portBusy: true, holderAgent: null, ourAgent: 'Archi', holderWorktree: null, ourWorktree: ARCHI_NEW },
     'evict_then_spawn', 'reuse',
     'back-compat null holder：旧 M3 会 reuse（bug），修复后 evict'],
];

let pass = 0, fail = 0;
for (const [label, input, wantFixed, wantMaster] of cases) {
    const gotFixed = decideReuseBranch(input);
    const gotMaster = decideReuseBranch_master(input);
    const fixedOk = gotFixed === wantFixed;
    const masterOk = gotMaster === wantMaster; // 期望 master 表现出 bug 行为
    // 关键不变量：修复后绝不在 untrusted holder 上裸 reuse（除同 slot 确认外）
    const noNakedReuse = (gotFixed !== 'reuse') ||
                         (gotFixed === 'reuse' && input.holderWorktree === input.ourWorktree && input.holderWorktree !== null);
    if (fixedOk && masterOk && noNakedReuse) {
        pass++;
        console.log(`ok   - ${label}`);
        console.log(`       fixed=${gotFixed} master=${gotMaster}(bug)`);
    } else {
        fail++;
        console.log(`FAIL - ${label}`);
        console.log(`       fixed=${gotFixed}(want ${wantFixed}) master=${gotMaster}(want ${wantMaster}) noNakedReuse=${noNakedReuse}`);
    }
}

// 额外断言：修复模型在所有 untrusted 场景下必须 evict 或报错，绝不裸 reuse。
// 这是 Archi 回归 v2 的核心成功标准（lease 必须变化、sidecar 必须重写）。
let invariantViolations = 0;
for (const [, input] of cases) {
    if (!input.portBusy) continue;
    const trusted = input.holderWorktree !== null && input.holderWorktree === input.ourWorktree &&
                    input.holderAgent !== null && input.holderAgent === input.ourAgent;
    const got = decideReuseBranch(input);
    if (!trusted && got === 'reuse') {
        invariantViolations++;
        console.log(`FAIL - 不变量：untrusted holder 被裸 reuse (holder=${input.holderWorktree} our=${input.ourWorktree})`);
    }
}

console.log();
if (fail === 0 && invariantViolations === 0) {
    console.log(`M_reuse_short OK (pass=${pass})`);
    process.exit(0);
} else {
    console.log(`M_reuse_short FAIL (pass=${pass} fail=${fail} invariantViolations=${invariantViolations})`);
    process.exit(1);
}
