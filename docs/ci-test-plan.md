# CI 闸门与定时测试计划（SEE-1334 SPEC-064）

> 状态：Owner 批准（2026-09-22）；实现见 `.github/workflows/`（ci.yml / launch-ci.yml / launch-special.yml）。
> 本文档是 CI 闸门与定时测试的权威计划；改动需同步本文档。

## 1. PR 闸门 —— 6 个 blocking job

| # | job | 内容 | 预算（实测） |
|---|-----|------|------|
| 1 | `build-and-test` | server: npm ci → tsc 构建 → vitest 全量（699 用例）+ protocol smoke | ~31s |
| 2 | `lint` | 根级 ESLint 双规则集（0 error / 58 warn baseline，只降不升） | ~18s |
| 3 | `node-units` | fast 层 node 项（14 个 wrapper） | ~56s |
| 4 | `shell-harnesses` | fast 层 shell 项（52 项；装 godot 二进制） | ~8.5m |
| 5 | `coverage-launch` | launch coverage 门禁（wrapper 注入 NODE_V8_COVERAGE → c8 merge → 全局地板 + 新代码 100%）; retry 1（flake 治理，仅 coverage 数值判定） | ~9.5m |
| 6 | `mutation-gate` | Stryker 白名单 mutation（utils×5 + schema union；break=100，豁免台账 docs/mutation-exemptions.md） | ~1.5m |

**合计并行最慢 ~10m（shell-harnesses），闸口总预算 ≤15m（Owner 2026-09-22 裁决）。**
超预算压缩顺序：白名单拆矩阵 → 收紧并发 → 增量缓存（语义不变），仍超则回报 Owner。

Required checks（main 分支保护）：`build-and-test` / `shell-harnesses` / `node-units` / `mutation-gate` + `enforce_admins` + `required_conversation_resolution` + `required_linear_history`（SPEC-013/063）。

## 2. Nightly（launch-special.yml，周三 cron + workflow_dispatch；非阻塞证据层）

| 桶 | 内容 | 预算 | 语义 |
|---|------|------|------|
| long-suites | 2 个 long 级套件（t14 reaper / ws5 给上重武装） | 15m | green gate（blocking on its own schedule） |
| env-bound | dev-box-only 清单（e2e 真机桶） | 10m | documented skip（SPEC-050 红线） |
| drift-watch | 51 项 drift 证据运行 | 20m | continue-on-error |
| gherkin-evidence | 任务 spec 可执行条款（cucumber --strict 9 场景） | 10m | blocking Green（非 PR gate） |
| speed-audit | fast 层单项 >60s / job >8min 审计 | 20m | advisory 留痕 |
| mutation-evidence | 全库变异（~3h）kill rate 报告 artifact 留档 14 天 | 240m | 只报告不闸门（SPEC-041） |

Nightly 首轮 dispatch 已于 2026-09-22 执行（run 35679632287）；speed-audit 修复后由下轮 cron 落首个干净审计。

## 3. 100% 目标达成路线（ratchet）

- **mutation kill rate 100（白名单）**：72.25%（P4）→ 91.54%（killer 突击，107 用例 / survivors 140→44）→ **100**（等效类豁免 21 项 + convertHexToIp 内围 range 排除）。豁免逐条登记 `docs/mutation-exemptions.md`（理由 + mutant id）；生产代码语义零改动；不死测试凑数。过渡阈值未采用：95 上限在突击后 Υ税为等效墙，直接以豁免机制达 100（Owner 已批准豁免机制）。
- **coverage 新代码 100**：per-file diff ratchet（双侧），祖父锚 `6123f88`（P0a 拆分存量不回填）；不可测行豁免机制：c8 `/* c8 ignore */`（launch）/ `/* v8 ignore next */`（server）注释，理由登记进台账，不得静默。

## 4. 已知与豁免/降级决策轨迹

- eq-wall 分析与 44 项清单：issue 内 2026-09-22 汇报 + docs/mutation-exemptions.md。
- timing 敏感套件在 coverage 马拉松下抖动：runner 级 retry 1（断言零弱化）。
- zod 根级 devDep 钉 4.4.3 对齐 server，消除 sandbox 版本偏差。

## 5. 评估项：coverage-launch 与 shell/node-units 合并单次插桩运行（2026-09-22 Bachi 评估）

**可行**：一次 vitest run（LAUNCH_COVERAGE_DIR 置位）即可同时产出 66 项结果与子进程覆盖率 —— coverage-launch 已按此形态运行（v8 dump 与测试执行在同一进程树上）。

**收益/代价**：
- 收益：省 node-units/shell-harnesses 与 coverage-launch 之间的重复安装/构建（~1-2 runner-min/job），总量很小；
- 代价：coverage gate 与全量 case 结果耦合 —— 任一 timing 敏感套件失败会连带 coverage 数值不可判（需要 retry 兜底更宽），且 shell-harnesses 的独立 flake 仲裁权被稀释（当前架构里它是断言语义的真闸，coverage job 只作数值门禁）。

**评估结论**：不合并（维持 3 job 并行）。理由：runner-min 收益 ~30s vs 信号退化（flake 域耦合）+ 维护成本（一套 job 失败语义双重身份）。若未来 PR 总时长逼近 15m 预算再重新评估。
