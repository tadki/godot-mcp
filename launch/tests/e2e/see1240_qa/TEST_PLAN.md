# SEE-1240 QA 测试计划（Revy，对抗性全量真机验证）

## 1. 验收标准 / 场景枚举（Given/When/Then）

来源：流程图 comment `01a070fd` 验收要点表 + 触发 comment `01a073cf` 重点清单。

| # | AC | Given | When | Then（可观测 oracle） |
|---|----|-------|------|----------------------|
| AC1 | WS-1/WS-8 终态 | configure→start 全链 | start-godot-editor 后逐阶段检查 | editor log 出现 `WS_BIND_OK port=6555 bind=172.17.192.1` + `Server listening ... [WSL]`；`git status --porcelain` 全程为空 |
| AC2 | stop-hook sanitize | project.godot `[godot_mcp]` 注入 `port_override_enabled=true / port_override=6599` | 运行 sanitize_project_godot_mcp | 两键还原 false/6550；bind_mode=1/custom_bind_ip 逐字节保留；sed 锚定不越段 |
| AC3 | WS-2 跨 slot 归属 | SEE-1129/1131 场景注入 | 复测 predicate + runtime identity 套件 | reuse_short_circuit 7/7、multi_slot 7/7、sidecar_guard 7/7、anchor 6/6、drift 6/6、registry_marker 8/8、T16 11/11 |
| AC4 | test_see1129 修法裁定 | C3/C5/C7 FAIL×3 复现 | 对照 pid_alive 实现 | WSL `$$` 经 Windows Get-Process 探测=0（实测）；`KOL_REAP_DISABLE_PWSH=1` 对照 13/13 |
| AC5 | WS-4 故障注入四形态 | 真实 status/doctor | 杀编辑器/占端口/停 lease/删注册 | doctor verdicts 每形态字段正确（lease 层 FAIL / registration 层 FAIL/WARN / exit 三态 0/2/1）；套件 29/29 |
| AC6 | D4 超时全表 | status --json | 查询 timeouts | 13 条、L1-L4 四层、L1=120000/L3=300000/L4=300s+120s、injected 标志 |
| AC7 | WS-5 两路径+并发 | WS-5 套件 | give-up→重武装→成功 / 再失败退避加深 / 恢复期并发 | 16/16（含 R3 退避 3s→6s 实证、R4 并发零丢失、R1.6 无 warming hint 红线） |
| AC8 | WS-3 红/绿 | 真机游戏运行 | set→no-step→capture / auto_step capture | `_screenshot.stale=true`（no_step_after_mutation）vs `stale=false`+auto_step 溯源；**独立 amber_px oracle**（QA 自行 PNG 解码统计，2521px） |
| AC9 | WS-3 落盘/校验 | exports 路径 | 读回落盘 PNG | PNG magic 正确 + IHDR 尺寸与响应一致（900x506） |
| AC10 | WS-3 ui_inspect/drag | 真机 | ui_tree/inspect_node/drag/malformed | 346 Control 节点；hover 不可信标注；drag 4 事件展开（"4 input(s) executed"）；malformed -32602 in-band 拒绝 |
| AC11 | WS-6 三处一致+拦截 | exec constraints | 16 token 逐条 + 不误伤矩阵 + digest | 逐条具名 DENIED_TOKEN；字符串/注释/词边界放行；digest 确定性且含 16 token；套件 35/35 + 11/11 |
| AC12 | WS-7 G1/G2/G3 | grace-race 套件 | 慢 bind 红绿对照 | 8/8（G1 驱逐+重生+flush、G2 legacy 红侧可复现、G3 无驱逐循环） |
| AC13 | 存量裁定 | see976/see1077/see1129 | 复跑 + 失败类归因 | 裁定不阻塞（见报告） |

## 2. 失败模式清单（这个功能会怎么坏）

- 端口链：lease 丢失/损坏 → 编辑器静默回落 6550（**实测复现，见缺陷 D1**）；port_override 运行期键泄漏进 git
- 并发：同 agent 双 slot 互踢 / 跨 agent 抢占误 reuse；恢复期调用静默丢失
- 状态面：编辑器死但 lease=active（真相源与物理漂移）；注册指向失效路径（2026-08-01 事故形态）
- exec 层：拦截漏报 / 误伤合法代码（字符串/注释/词边界）/ description 与 addon DENYLIST 漂移
- 截图：frozen 态迟到帧伪装 fresh；落盘与响应尺寸不一致
- 退避：第二次 give-up 不翻倍（退避链归零——Bachi 自测已修，R3 复测实证）

## 3. 对抗/负向场景（≥各 1 条）

- 边界：max_width=200 超宽约束（AC 通过：实际 200x112）
- 并发/快速重复：恢复期双并发调用（R4）、5-agent registry 并发（RC 3/3）
- 非法/空状态：malformed drag（-32602）、corrupt sidecar quarantine（C8）、无 mcp-config 目录（T4）、缺少 godot 条目（T3 WARN）
- 中断恢复：give-up→冷却→重武装→再失败→退避加深（R3 两路径）

## 4. Oracle 定义（每断言的判别信号）

- 端口/bind：editor log stage 行字面值（`WS_BIND_OK port=6555 bind=172.17.192.1`）
- git 恒净：`git status --porcelain` 空串
- stale：`_screenshot.stale` 布尔 + `no_step_after_mutation` 信号名（响应字面）
- amber_px：QA 独立 PNG 解码（IHDR+IDAT inflate+unfilter+RGB 计数），不采信被测方上报
- drag：响应中 `4 input(s) executed` + 事件序列字面；malformed：JSON-RPC error code -32602
- exec 拦截：`{ok:false, kind:"DENIED_TOKEN", violations:[token]}` 结构化返回
- doctor：verdict level（PASS/WARN/FAIL）+ exit code 三态互斥
- WS-5：giveup status JSON `giveup_count/backoff_ms/cooldown_until` 数值断言

## 5. 追溯矩阵

| AC | 场景/套件 | 结果 |
|----|-----------|------|
| AC1 | 真机 configure→start 全周期 ×3 | PASS |
| AC2 | sanitize 隔离函数级注入×2 + 段锚定 diff | PASS |
| AC3 | see1129 7 套件 + T16/T1/T3/arbiter/registry/B6/P3 | PASS |
| AC4 | C3/C5/C7 复现 + DISABLE_PWSH 对照 13/13 | 裁定 PASS（测试缺陷） |
| AC5/AC6 | ws4 套件 29/29 + 真机 doctor live | PASS |
| AC7 | ws5 套件 16/16（run3）+ run1 flake 分析 | PASS（flake 备案） |
| AC8-AC10 | QA 自研真机驱动 qa_ws3_real_machine.mjs + drag 复测 | PASS（12/14→2 项为 QA oracle 笔误，修正后复核 PASS） |
| AC11 | exec 单元 35/35 + proxy 11/11×2 + QA 手工矩阵 39/40 | PASS |
| AC12 | ws7 套件 8/8×2 | PASS |
| AC13 | see976/see1077/see1129 复跑归因 | 不阻塞裁定 |
