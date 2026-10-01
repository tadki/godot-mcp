# 测试计划 — SEE-1170 三通道 worktree prune 缓解（对抗性 QA）

被测 commit：`c0541292`（通道 1 `31003f1a` + 通道 2/3 `c0541292`），分支 `shared/SEE-1170`。

## 1. 验收标准 / 场景枚举

| # | Given | When | Then（oracle） | 用例 |
|---|-------|------|----------------|------|
| S1 | 测试 bare repo 存在 stale 注册（worktree add 后 rm -rf 目录） | checkout_repo() 命中 `missing but already registered` stderr | prune 被执行一次、checkout 重试恰好一次、成功路径写 DIAG | test_see1170_channel1.sh |
| S2 | stderr 无命中 + 兜底三重 AND（目录在/.git 缺/bare 注册在） | checkout 失败 | 同样走 prune+retry | 同上 |
| S3 | 普通网络错误 stderr | checkout 失败 | **不 prune、不 retry**，CHECKOUT_FAILED=true | 同上 |
| S4 | stale 注册但 retry 仍失败 | prune 后重试失败 | CHECKOUT_FAILED=true + 诊断日志含「仍失败」 | 同上 |
| S5 | bare repo 无法推导 | stderr 命中但 resolve_bare_repo 失败 | 跳过 prune + 显式 DIAG + CHECKOUT_FAILED | 同上 |
| S6 | 真实 worktree 存在（活占用） | prune 对其 | no-op（活 worktree 仍在） | B0 单测 |
| S7 | 注册目录缺失 | B0 sweep | 无条件 prune 且仅一次 git 调用 | test_see1170_channel2.py |
| S8 | 活 worktree（有 .git，属于他 prefix） | B0 sweep | contested 档 report-only，**目录完好**、报告含结构化字段 | 同上 |
| S9 | empty 残壳 + mtime fresh（≤300s） | B0 | skip，reason=mtime_too_fresh，目录保留 | 同上 |
| S10 | empty 残壳 + mtime 静止 + issue 活跃 | B0 | skip，reason=issue_active，目录保留 | 同上 |
| S11 | empty 残壳 + issue 查询失败 | B0 | skip，reason=issue_status_query_failed，目录保留 | 同上 |
| S12 | empty 残壳 + lock 被占 | B0 | skip，reason=skipped_concurrent，目录保留 | 同上 |
| S13 | `--fast` | 运行 | 输出只含 B0，无 Phase1-3 字段；无 issue 写副作用；errors 空 → exit 0 | 同上 |
| S14 | anchor stat 失败 + stale 注册 | proxy tryPruneBareRepo | prune 一次、stat 恢复、返回 anchor | test_see1170_channel3.mjs |
| S15 | anchor stat 失败 + prune 后仍失败 | proxy | 日志「still failing ... cause unclear」+ return null（worktree_unresolved 语义不变） | 同上 |
| S16 | bare repo 推导失败 | tryPruneBareRepo(null) | 日志 `prune skipped: bare repo unresolved` + diag attempted=false | 同上 |
| S17 | 同一进程两次失败路径 | 第二次 tryPruneBareRepo | attempted=false, reason=already_pruned（至多一次） | 同上 |

## 2. 失败模式清单

- F1: stderr 文本漂移（非 git 标准串）→ 兜底三重 AND 覆盖；两者皆无 → 不 prune（防误伤）
- F2: prune 误删活 worktree → git prune 内建语义保证 no-op；显式测 S6
- F3: retry 无限循环 → 代码结构单次；实测调用计数
- F4: contested 误删 → 代码仅 report；实测目录完好
- F5: empty 档门限旁路（mtime 伪造新 / issue 查询挂 / lock 不可得）→ 任一跳过
- F6: --fast 引入写副作用（建 issue/评论）→ 对比 multica 调用计数
- F7: prune 级联（daemon 重试风暴）→ hasPrunedBareRepo
- F8: 推导 bare repo 读到目录 .git 而非文件 → readFileSync 抛错被吞、继续向上

## 3. 对抗/负向场景

- A1 边界：S3（非匹配错误不触发）、S9（mtime 恰好 ≤300s）
- A2 并发：S12（lock 被他人持有）、S17（重复 prune）
- A3 非法/空：S5（bare 无法推导）、S16、F8

## 4. Oracle 强度

全部断言绑定 concrete 信号：git worktree list 条目数、目录存在性（test -d）、exit code、stderr/日志字面量（grep -q）、mock multica 调用计数、报告 JSON 字段值。无"看起来对"断言。

## 5. 追溯矩阵

目标1→S1-S5；目标2→S6-S13；目标3→S14-S17；目标4→红线 grep（diff 全量 + cron/文件路径检查）。
