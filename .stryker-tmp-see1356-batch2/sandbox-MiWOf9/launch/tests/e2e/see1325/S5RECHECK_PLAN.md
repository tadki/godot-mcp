# 测试计划 — SEE-1328 S5-recheck：专用长寿命 harness 捕获 EMBEDDED_HEAL 证据

> revy-qa Step 3（S5 补捕获轮）。基线 = C-qa FAIL（S5 未捕获）+ Atlas 裁决（测试基建问题，专用 harness 方案采纳）。

## 1. 回归清单

| 测试文件 | 类型 | 来源 |
|---|---|---|
| launch/tests/e2e/see1325/test_see1325_s5_recovery_round.mjs | 实机 E2E（S5 专用 harness） | 本次新增 |
| launch/tests/scripts/test_see1325_recovery.mjs | 单测 | C-code |
| launch/tests/scripts/test_see1325_recovery_hardener.mjs | 单测 | C-hardener |
| launch/tests/scripts/test_see1325_configure_invariants.mjs | 单测 | C-code |
| launch/tests/scripts/test_see1325_port_probe.sh | bash 单测 | C-code（C-fix 落地后复跑） |
| launch/tests/e2e/see1325/test_see1325_cqa_smatrix.mjs | 实机记录 | C-qa |
| 全量单测矩阵 | 回归 | 沿用 |

## 2. 补充场景（S5 专用 harness 设计要点）

前轮 6 次失败根因：feeder/proxy 生命周期耦合 + FAILED_EXIT 窗口 > 链存活时长 + 管道喂话阻塞。本 harness 三项对策：

1. **生命周期解耦**：proxy 由 harness 直接 spawn（stderr 直落文件，无中间管道），feeder 为独立进程仅写 stdin；harness 总时长 ≥ FAILED_EXIT + 单轮最坏 90s + 余量。
2. **窗口压缩**：`GODOT_MCP_FAILED_EXIT_MS=90000`（§SPEC-003 env 可调语义）+ `GODOT_MCP_WARMUP_TIMEOUT_MS=20000`（快速进入 RECOVERING）→ 理论到达 recovery round ≈ 110s。
3. **trio 构造**：phaseA 驱动器 warm 后 SIGKILL 整链（无释放痕迹），清 reaper 翻转残留后，新 proxy 直入 trio。

| 场景 | Given | When | Then（concrete oracle） |
|---|---|---|---|
| S5-1 | trio 态（lease active + released_at null + proxy_pid 死 + 端口闭合） | 新 proxy（FAILED_EXIT=90s）+ feeder 持续 tools/call | proxy stderr 出现 `stage=RECOVERY_ROUND n=1/m remaining=Xms trigger=cold_failed_exit` |
| S5-2 | 同上 | 恢复轮判定 stop_first | `stage=RECOVERY_DECISION action=stop_first` + `stage=EMBEDDED_HEAL_BEGIN mode=stop_first` + `EMBEDDED_HEAL_CONFIRMED` + `EMBEDDED_HEAL_END ok=true` |
| S5-3 | 恢复轮 respawn 后 | 编辑器重启绑定同端口 | `WS_BIND_OK port=<同端口>` + feeder 首调成功（get_info 返回 KingOfLikes） |
| S5-4 | 预算记账 | 剩余 < 90s 场景（FAILED_EXIT=90s 单轮即耗尽） | 无第二轮 RECOVERY_ROUND（n=1 后无 n=2）或 RECOVERY_ROUND_SKIP budget_exhausted |

对抗覆盖：S5-1（死亡态恢复=异常）、S5-4（预算边界=负向）、S5-3（恢复成功=正常）、trio 构造验证（边界）。

## 3. 覆盖核对

| 目标 | 场景 |
|---|---|
| §SPEC-002（RECOVERING 内嵌恢复轮闭环） | S5-1/S5-2/S5-3 |
| §SPEC-003（预算口径 (a) 实机） | S5-1 计量行 + S5-4 |
| §SPEC-004（FAILED_EXIT ≥ 实测和） | S5-1 触发实测 + 常量单测（已锁） |
| §SPEC-006（stop-first 唯一腿实机） | S5-2 |
