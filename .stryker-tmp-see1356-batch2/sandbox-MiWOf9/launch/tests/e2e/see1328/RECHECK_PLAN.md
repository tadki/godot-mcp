# 测试计划 — SEE-1328 A-recheck：D1 修复复验（f750d0d）

> revy-qa Step 3（复验轮）。基线 = A-qa 报告（FAIL，D1）。修复 = 模板去 escape 占位（`aa96ec0` RED → `f750d0d` GREEN）。

## 1. 回归清单

| 测试文件 | 类型 | 来源 |
|---|---|---|
| launch/tests/scripts/test_see1325_config_validate.mjs（15 用例，含 D1 反断言 ×2） | 单测 | 上游（A-fix 扩充） |
| launch/tests/scripts/test_see1328_config_validate_hardener.mjs | 单测 | 本阶段（A-hardener） |
| launch/tests/e2e/see1328/test_see1328_config_validate_realchain.mjs | 实机 E2E | 本阶段（A-qa，未改动） |
| launch/mcp-assert-registration.sh | 回归 | §SPEC-017 |
| launch/tests/e2e/see1328/see1328_abtest_d1.mjs | 实机 A/B（修复验证） | 本次新增 |

## 2. 补充场景（A-recheck 专用）

A/B（修复验证，owner-order §2.6.2 必选）：before = `46fdccb`（D1 在场）/ after = `f750d0d`（修复），隔离 fixture 内以 **git worktree 双检出**完成，非主 worktree 切分支。

| 场景 | 类型 | Given | When | Then（concrete oracle） |
|---|---|---|---|---|
| AB-A | A/B before | 46fdccb 检出，non-KOL standalone fixture | 真实 launcher 执行 | A 组复现：stderr 含 DRDFS_ESCAPE 行（D1 存在，★修复前复现） |
| AB-B | A/B after | f750d0d 检出（main worktree），同 fixture | 同上 | B 组通过：stderr 零 DRDFS_ESCAPE 字节 |
| X1 | E2E 对抗复现 | A-qa 报告 §6 复现路径（non-KOL standalone + hard-fail 前置态），f750d0d | 真实 shim + 真实 launcher 重跑 R2/R4 形态 | stderr 零 DRDFS_ESCAPE 字节 + 判定行为不变（exit 2 / NON_KOL） |
| X2 | E2E 语义回归 | KOL 签名 + DRDFS 执行路径 + `--allow-drvfs` | 真 CLI + 真 launcher | 完整 DRDFS_STAGE_LINE 输出、escape 行整体替换 ok= 行、launcher case 正确转发一次（且 escape 场景仍打印） |
| X2 | 对抗（修复反向探针） | f750d0d | 检查修复未破坏 launcher 对**真实 escape** 的转发：launcher 真进程 + escape 态 | DRDFS_ESCAPE 行仍由 launcher 输出（case 分支未死） |
| X3 | 对抗（shim 侧同类） | f750d0d | 真 shim non-KOL + escape 注入态 | stderr 零意外 DRDFS_ESCAPE；SHIM_STAGE_LINE 零字面量（15 用例套件钉死） |

## 3. 覆盖核对

| 目标 | 场景 |
|---|---|
| 复验 D1 修复（复现路径重跑） | AB-A/B, X1 |
| escape 语义回归（替换契约不变） | X2, H11/H12（既有），15 用例套件反断言内 escape 分支 |
| 三套件全量回归 + §SPEC-017 | Step 5 |
| §SPEC-012 终验 | X1-X3 + 全量回归 |
