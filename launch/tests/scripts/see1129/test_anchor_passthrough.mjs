// SEE-1129 v7 anchor passthrough / cross-task drift mock
// (M_anchor_passthrough, sub-step dcacbb66 v7).
//
// Atlas v7 的诊断假设是"launcher 从未把 anchor env 下发给 proxy 子进程"。本回合
// 真机取证证伪了该假设——launcher 行 521/523 确实 export KOL_WORKTREE /
// KOL_PROJECT_GODOT，live proxy 318700 env 也确实带有这两个 anchor（值=17219eb2）。
// 真实根因是 launcher 的 _resolve_via_runtime_registry 在 marker 尚未落盘
// （daemon lag，本回合现场 marker mtime 21:08:33 vs proxy 启动 21:08:27）时落
// (b) freshest-mtime fallback，而 freshest-mtime winner 是另一个任务（02f45f9d）
// 残留的 runtime 17219eb2（managed_env mtime 18:37），不是本任务（683b665c）
// 复用的 41115b3c（managed_env mtime 16:21）。
//
// 这是 c8c703b0 的 Revy 注释明确预言过的盲点："when the daemon had not yet
// provisioned the runtime hash dir, (a2) silently skipped and (b)'s freshest-
// mtime picked whichever other runtime of the same agent had the newest
// .managed_env.json mtime — pinning the launcher to that older runtime"。该注释
// 声称"dropping that check closes the gap"，但 gap 仍然存在——因为 (a2) 要求
// marker 文件先落盘，而 marker 有同样的 daemon-lag 问题。
//
// 修复策略：在 (b) freshest-mtime fallback 之前插入 cwd-anchor 短路。当 launcher
// 的 pwd 在 ws_base/<hash>/workdir 下时，<hash> 就是本任务实际 slot（cwd 是
// Multica runtime 为本任务设置的），只要该 hash 的 managed_env agent_id 匹配本
// agent（或 managed_env 尚未写出但 hash 目录存在——B1 lazy-load 信任），直接返回
// 该 hash 的 worktree，绕过跨任务的 mtime 比较。
//
// 本 mock 把 _resolve_via_runtime_registry 的 (b) 分支抽象成纯函数
// resolveRuntimeRegistryTierB，对比修前（裸 freshest-mtime）vs 修后
// （cwd-anchor 短路优先）。不碰真实 ~/.multica 或真实工作区。

// 修后的 (b) 分支等价纯函数：cwd-anchor 短路 + freshest-mtime 兜底。
// 输入：cwd、ws_base、agent_id，以及每个 runtime hash 的 { managedEnvMtime,
// managedEnvAgent, managedEnvExists, worktreeExists }。
// 输出：选中的 worktree 路径，或 null（(b) return 1）。
function resolveRuntimeRegistryTierB_fixed({ cwd, wsBase, agentId, runtimes }) {
    // 修复：cwd-anchor 短路。cwd 在 ws_base/<hash>/workdir 下时，<hash> 是本任务
    // 实际 slot——直接信任它，绕过跨任务 mtime 比较。这是本 mock 验证的核心修复。
    if (cwd && cwd.startsWith(`${wsBase}/`) && cwd.includes('/workdir')) {
        const rest = cwd.slice(`${wsBase}/`.length);
        const cwdHash = rest.split('/')[0];
        const rt = runtimes[cwdHash];
        if (rt) {
            // managed_env 已写：agent_id 必须匹配本 agent（cross-agent gate）。
            if (rt.managedEnvExists) {
                if (rt.managedEnvAgent === agentId) {
                    return `${wsBase}/${cwdHash}/workdir/KingOfLikes-Godot`;
                }
                // agent 不匹配：cwd 指向别 agent 的 slot——退化到 freshest-mtime。
            } else {
                // managed_env 未写（daemon lag）：信任 cwd（B1 lazy-load 同源信任）。
                return `${wsBase}/${cwdHash}/workdir/KingOfLikes-Godot`;
            }
        }
    }

    // 退化：cwd 不在 ws_base 下，或 cwd hash 的 agent 不匹配——按 freshest-mtime
    // 选同 agent 的 runtime。这是修前 (b) 的全部逻辑。
    let bestHash = null, bestMtime = -1;
    for (const [hash, rt] of Object.entries(runtimes)) {
        if (rt.managedEnvAgent !== agentId) continue;
        if (!rt.worktreeExists) continue;
        if (rt.managedEnvMtime > bestMtime) {
            bestMtime = rt.managedEnvMtime;
            bestHash = hash;
        }
    }
    return bestHash ? `${wsBase}/${bestHash}/workdir/KingOfLikes-Godot` : null;
}

// 修前的 (b) 分支：裸 freshest-mtime，cwd 无关——这正是 Archi/Bachi 真机漂移的根因。
function resolveRuntimeRegistryTierB_master({ wsBase, agentId, runtimes }) {
    let bestHash = null, bestMtime = -1;
    for (const [hash, rt] of Object.entries(runtimes)) {
        if (rt.managedEnvAgent !== agentId) continue;
        if (!rt.worktreeExists) continue;
        if (rt.managedEnvMtime > bestMtime) {
            bestMtime = rt.managedEnvMtime;
            bestHash = hash;
        }
    }
    return bestHash ? `${wsBase}/${bestHash}/workdir/KingOfLikes-Godot` : null;
}

const WS = '1a011680-a476-4553-929d-478690824e46';
const WS_BASE = `/home/jerry/multica_workspaces/${WS}`;
const AGENT_BACHI = 'a5c250e8-7257-466e-b45a-03f995c7206c';
const AGENT_ARCHI = '809951ab-c70c-48c3-b0d6-7b16b49e1ce3';

// 本回合真机现场快照（managed_env mtime 取自 stat）：
//   17219eb2 mtime=18:37 (issue 02f45f9d，残留) | 41115b3c mtime=16:21 (issue 683b665c，本任务)
const T0 = 1786436494; // 41115b3c mtime epoch (16:21)
const runtimes_realMachine = {
    '17219eb2': { managedEnvMtime: T0 + 78143, managedEnvAgent: AGENT_BACHI, managedEnvExists: true, worktreeExists: true },
    '41115b3c': { managedEnvMtime: T0, managedEnvAgent: AGENT_BACHI, managedEnvExists: true, worktreeExists: true },
};

const cases = [
    // [label, input, wantFixed, wantMaster, note]
    ['本回合真机现场：cwd=41115b3c, marker 缺失(daemon lag), 17219eb2 mtime 更新 → 必须 cwd-anchor 到 41115b3c',
     { cwd: `${WS_BASE}/41115b3c/workdir/KingOfLikes-Godot`, wsBase: WS_BASE, agentId: AGENT_BACHI, runtimes: runtimes_realMachine },
     `${WS_BASE}/41115b3c/workdir/KingOfLikes-Godot`,
     `${WS_BASE}/17219eb2/workdir/KingOfLikes-Godot`,
     'Atlas v7 真机复现：修前漂移到 17219eb2，修后 cwd-anchor 到 41115b3c'],

    ['cwd 在 ws_base 但 hash 无 managed_env（daemon 未写出）→ 信任 cwd（B1 lazy-load）',
     { cwd: `${WS_BASE}/41115b3c/workdir/KingOfLikes-Godot`, wsBase: WS_BASE, agentId: AGENT_BACHI,
       runtimes: { '41115b3c': { managedEnvMtime: 0, managedEnvAgent: null, managedEnvExists: false, worktreeExists: true } } },
     `${WS_BASE}/41115b3c/workdir/KingOfLikes-Godot`,
     null,
     'managed_env 缺失：修前 (b) 全失败 return 1（launcher die）；修后信任 cwd'],

    ['cwd 指向别 agent 的 slot（cross-agent 误入）→ 不信任 cwd，退化 freshest-mtime',
     { cwd: `${WS_BASE}/41115b3c/workdir/KingOfLikes-Godot`, wsBase: WS_BASE, agentId: AGENT_ARCHI,
       runtimes: { '41115b3c': { managedEnvMtime: T0, managedEnvAgent: AGENT_BACHI, managedEnvExists: true, worktreeExists: true } } },
     null,
     null,
     'cwd slot 属于 Bachi 但本 agent=Archi：cwd-anchor 拒绝（cross-agent gate），(b) 无 Archi runtime → null'],

    ['cwd 不在 ws_base 下（手动启动 / 容器外）→ 退化 freshest-mtime（兼容旧行为）',
     { cwd: `/mnt/d/GodotProjects/king-of-likes`, wsBase: WS_BASE, agentId: AGENT_BACHI, runtimes: runtimes_realMachine },
     `${WS_BASE}/17219eb2/workdir/KingOfLikes-Godot`,
     `${WS_BASE}/17219eb2/workdir/KingOfLikes-Godot`,
     'cwd 无 anchor 信息：修后与修前一致（freshest-mtime）—— 不破坏非 Multica 启动场景'],

    ['同 agent 多 runtime，cwd 命中其中之一且非 freshest → cwd-anchor 仍选 cwd',
     { cwd: `${WS_BASE}/a26701db/workdir/KingOfLikes-Godot`, wsBase: WS_BASE, agentId: AGENT_BACHI,
       runtimes: {
         '17219eb2': { managedEnvMtime: T0 + 90000, managedEnvAgent: AGENT_BACHI, managedEnvExists: true, worktreeExists: true },
         'a26701db': { managedEnvMtime: T0 - 10000, managedEnvAgent: AGENT_BACHI, managedEnvExists: true, worktreeExists: true },
       } },
     `${WS_BASE}/a26701db/workdir/KingOfLikes-Godot`,
     `${WS_BASE}/17219eb2/workdir/KingOfLists-Godot`.replace('Lists', 'Likes'),
     'cwd 是权威：即使别的同 agent runtime 更新鲜，仍选 cwd slot'],

    ['cwd slot 的 worktree 尚未 checkout（B1 lazy）但 managed_env 在 → 仍信任 cwd',
     { cwd: `${WS_BASE}/41115b3c/workdir/KingOfLikes-Godot`, wsBase: WS_BASE, agentId: AGENT_BACHI,
       runtimes: {
         '17219eb2': { managedEnvMtime: T0 + 80000, managedEnvAgent: AGENT_BACHI, managedEnvExists: true, worktreeExists: true },
         '41115b3c': { managedEnvMtime: T0, managedEnvAgent: AGENT_BACHI, managedEnvExists: true, worktreeExists: false },
       } },
     `${WS_BASE}/41115b3c/workdir/KingOfLikes-Godot`,
     `${WS_BASE}/17219eb2/workdir/KingOfLikes-Godot`,
     'worktree 未 checkout：修前 freshest-mtime 选 17219eb2（漂移）；修后 cwd-anchor 选 41115b3c（正确，spawn 会 lazy 创建）'],
];

let pass = 0, fail = 0;
for (const [label, input, wantFixed, wantMaster] of cases) {
    const gotFixed = resolveRuntimeRegistryTierB_fixed(input);
    const gotMaster = resolveRuntimeRegistryTierB_master(input);
    // wantMaster for case 5 is intentionally constructed via .replace to match 17219eb2 path
    const wantM = (typeof wantMaster === 'string') ? wantMaster.replace('KingOfLists', 'KingOfLikes') : wantMaster;
    const fixedOk = gotFixed === wantFixed;
    const masterOk = gotMaster === wantM;
    if (fixedOk && masterOk) {
        pass++;
        console.log(`ok   - ${label}`);
        console.log(`       fixed=${gotFixed || '(null)'} master=${gotMaster || '(null)'}${wantMaster !== wantM ? '' : ''}`);
    } else {
        fail++;
        console.log(`FAIL - ${label}`);
        console.log(`       fixed=${gotFixed || '(null)'} (want ${wantFixed || '(null)'})`);
        console.log(`       master=${gotMaster || '(null)'} (want ${wantM || '(null)'})`);
    }
}

// 不变量：修后模型在 cwd 指 ws_base slot 时，绝不返回非 cwd-hash 的 runtime（除非
// cross-agent gate 拒绝 cwd → 退化）。这是 v7 修复的核心成功标准。
let invariantViolations = 0;
for (const [label, input] of cases) {
    const { cwd, wsBase } = input;
    if (!cwd || !cwd.startsWith(`${wsBase}/`) || !cwd.includes('/workdir')) continue;
    const cwdHash = cwd.slice(`${wsBase}/`.length).split('/')[0];
    const got = resolveRuntimeRegistryTierB_fixed(input);
    if (got && !got.includes(`/${cwdHash}/`)) {
        // 退化场景（cross-agent）允许——检查 agent 匹配
        const rt = input.runtimes[cwdHash];
        if (rt && rt.managedEnvExists && rt.managedEnvAgent === input.agentId) {
            invariantViolations++;
            console.log(`FAIL - 不变量：cwd=${cwdHash} 但返回 ${got}`);
        }
    }
}

console.log();
if (fail === 0 && invariantViolations === 0) {
    console.log(`M_anchor_passthrough OK (pass=${pass})`);
    process.exit(0);
} else {
    console.log(`M_anchor_passthrough FAIL (pass=${pass} fail=${fail} invariantViolations=${invariantViolations})`);
    process.exit(1);
}
