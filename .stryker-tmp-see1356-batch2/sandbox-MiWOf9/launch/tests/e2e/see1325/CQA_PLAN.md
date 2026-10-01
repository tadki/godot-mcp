# 测试计划 — SEE-1328 C-qa：S1-S6 六矩阵实机 + 集成态收口（阶段三终验）

> revy-qa Step 3。实机 = 真 editor（KingOfLikes 4.6.2-stable）+ 真部署链（shim/launcher/proxy 真进程），owner-order §5.2 禁 headless。

## 1. 回归清单

| 测试文件 | 类型 | 来源 |
|---|---|---|
| launch/tests/scripts/test_see1325_recovery.mjs | 单测 | C-code |
| launch/tests/scripts/test_see1325_recovery_hardener.mjs | 单测 | C-hardener |
| launch/tests/scripts/test_see1325_configure_invariants.mjs | 单测 | C-code |
| launch/tests/scripts/test_see1325_port_probe.sh | bash 单测 | C-code |
| launch/tests/scripts/test_see1110_stage_parser.mjs | 单测（本次 1 行修复） | 既有 |
| launch/tests/e2e/see1325/test_see1325_cqa_smatrix.mjs | 实机 E2E（S 矩阵） | 本次新增 |
| launch/tests/e2e/see1325/test_see1325_spec001_trio_probe.mjs | 实机 E2E（证据回放） | C0 |
| 全量单测矩阵（B/A 系列套件） | 回归 | 沿用 |

## 2. 补充场景（实机 S 矩阵）

| 场景 | 关联目标 | Given | When | Then（concrete oracle） |
|---|---|---|---|---|
| S2a | §SPEC-005 | trio 态（C0 形态：lease active + proxy_pid 死 + 端口闭合）经修复链 | 新链打入同端口 | ≤FAILED_EXIT_MS 内 warm 成功（**禁断言 configure 快路径 rc=0**——C0 定稿）；RECOVERY_DECISION stage 行在案 |
| S2b | §SPEC-005 | 端口被外部进程占住（非本 runtime holder，身份不可读/跨 runtime） | 恢复轮判定 | fail-fast 不 evict：诊断含原端口/holder 指引，无 EMBEDDED_HEAL_BEGIN |
| S2c | §SPEC-005 | 冷启动 + 端口被占后释放 | arbiter 再分配 | 新端口分配 + 首调成功（tools/call 返回） |
| S3 | §SPEC-008 | 探针降级态（屏蔽 PS/netstat/ss） | port_probe_verdict | UNDETERMINED 单列（不判 FREE 不判 IN_USE） |
| S4 | §SPEC-005 | 活同 runtime proxy 在位 | 第二链打入 | takeover_wait 语义（无 stop、无 evict，诊断 defer） |
| S5 | §SPEC-002/003 | trio 态 + FAILED_EXIT 窗口 | 内嵌恢复轮 | stage log `RECOVERY_ROUND n/m remaining=Xms` + `EMBEDDED_HEAL_BEGIN/CONFIRMED/END` 原始行在案；预算记账前置（剩余 <90s → RECOVERY_ROUND_SKIP budget_exhausted） |
| P1 | §SPEC-007 | PS cmdline 兜底路径 | probeHolderCmdline 真进程 | ≤2s 返回且命中本 worktree 目录名（真机竞速实测） |
| P2 | INV5 | fork build server/addon 存在 | launcher 启动 | .gdignore 幂等落盘（editor 首启无 UID duplicate） |
| P3 | port-probe fail-open 评估 | POWERSHELL 缺失 + netstat.exe 缺失环境 | port_in_use 探针链 | 实测降级序行为，出评估结论（不改产品代码） |

对抗覆盖：S2b（非法/跨 runtime）、S3（降级边界）、S5 预算负向（剩余不足）、S2a（死亡态恢复）——正常/边界/异常/负向四象限齐备。

## 3. 覆盖核对

| 目标 | 场景 |
|---|---|
| §SPEC-002（S5 闭环） | S5 |
| §SPEC-003（预算） | S5 + HB（单测沿用） |
| §SPEC-004（FAILED_EXIT ≥ 实测和） | S5 计量行 + 常量单测 |
| §SPEC-005（三支判定表） | S2a/S2b/S2c/S4 |
| §SPEC-006（stop-first 唯一腿实机面） | S2a（EMBEDDED_HEAL 仅此腿） |
| §SPEC-007（归因） | P1 + S2b |
| §SPEC-008（探针 fail-closed） | S3 + P3 |
| hardener §3 四项 | S5（编排）/ P1（PS 竞速）/ P2（INV5）/ S3+P3（探针序） |
| stage_parser 顺手修 | 回归清单复跑归档 |
