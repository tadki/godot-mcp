# 测试计划 — SEE-1328 阶段一 A-qa：§SPEC-011/012/017 实机验收

> revy-qa Step 3 产出。实机 = 真部署链（真实 shim 进程 / 真实 launcher 执行）+ 真 editor（owner-order §5.2 禁 headless 降级）。

## 1. 回归清单

| 测试文件 | 类型 | 来源 |
|----------|------|------|
| launch/tests/scripts/test_see1325_config_validate.mjs | 单测（node --test junit） | 上游已有（A-code/TDD + A-tidy） |
| launch/tests/scripts/test_see1328_config_validate_hardener.mjs | 单测（node --test junit） | 上游已有（A-hardener，本会话交付） |
| launch/tests/e2e/see1328/test_see1328_config_validate_realchain.mjs | 实机 E2E（bash + node，JUnit 输出） | 本次新增 |
| launch/mcp-assert-registration.sh | 回归（§SPEC-017） | 上游已有 |

## 2. 补充场景设计（实机 E2E）

实机形态说明：真实 KOL 部署链 = daemon → shim（`node godot-mcp-shim.mjs`）→ T+0 `runConfigValidate()` → launcher（bash，bootstrap 后跑 config-validate CLI）。本套件以真实子进程方式拉起 shim / launcher 本体（非 mock、非 import 产品函数），断言其进程退出码、stderr 原始 stage 行与墙钟——oracle 全部 concrete（进程 rc / 字节级 stderr 内容 / hrtime 计时）。

| 场景 # | 关联目标 | 类型 | Given | When | Then（可观测信号） | oracle |
|--------|----------|------|-------|------|--------------------|--------|
| R1 | §SPEC-011 shim 入口 | E2E 对抗 | 真实 KOL repo 副本（project.godot + kol-mcp.env + 真实 shim/launcher），`GODOT_MCP_HOME=/mnt/d/evil`（注入失败态） | `node godot-mcp-shim.mjs` 拉起，等待退出 | SHIM_DIE rc=2；stderr 含 `[godot-mcp-shim]` SHIM_DIE 行与 `config-validate hard fail`；墙钟 ≤2s；诊断含 daemon 根治项文案 | concrete |
| R2 | §SPEC-011 launcher 入口 | E2E 对抗 | 同 R1 repo 副本，`GODOT_MCP_HOME=/mnt/d/evil` | `bash godot-mcp-launcher.sh` 执行 | exit=2；stderr 含 `stage=CONFIG_VALIDATE ok=false reason=HOME_HEALTH_UNSAFE` 与 `stage=CONFIG_VALIDATE_FAIL`；墙钟 ≤2s；**且任何写操作（log 文件/端口分配）不发生** | concrete |
| R3 | §SPEC-012 逃生门 | E2E | 同 R1，`GODOT_MCP_HOME` 健康（$HOME 下非默认）+ launcher 强制落 /mnt/ 需 escape：以 `GODOT_MCP_ALLOW_DRVFS_PATHS=1` + `GODOT_MCP_FORK_CLI` 指向真实 fork cli、launcher 路径经 symlink 投影到 /mnt/ 不可行（WSL2 实机 /mnt/d 为真盘）→ 改用 config-validate CLI 真进程验证 escape 行 + launcher 真进程验证 escape stage 行转发 | CLI 带 `--allow-drvfs` 真跑 | stderr 精确输出完整 `stage=DRDFS_ESCAPE msg="GODOT_MCP_ALLOW_DRVFS_PATHS=1 escape active"` 行，无 ok= 行 | concrete |
| R4 | §SPEC-012 非 KOL 零影响 | E2E 负向 | standalone repo 副本（无 kol-mcp.env / 无 project.godot），`GODOT_MCP_HOME` 为内置默认 | 真实 shim + 真实 launcher 拉起 | guard 不触发：launcher 继续 boot（stage 行 ok=true reason=NON_KOL），rc≠2；shim 不 SHIM_DIE | concrete |
| R5 | hardener §4-1 raw-path 语义 | E2E 对抗 | shim 经 symlink 指向共享 master 副本内的 shim 文件（raw path 在 KOL repo 内） | 以 symlink 路径拉起真实 shim，注入失败 HOME | 签名仍判 KOL（raw scriptPath 落 repo 内）→ hard fail rc=2（钉死"不做 realpath 归一"的实机语义） | concrete |
| R6 | hardener §4-3 防御放行 | E2E 对抗 | 真实 KOL repo 副本，config-validate.mjs 临时移除（模块缺失态），HOME 注入失败 | 拉起真实 shim | guard 防御式放行：无 SHIM_DIE(config-validate)，链继续 spawn（launcher 真实拉起，NON_KOL 或健康判定路径），进程不以 rc=2 因 guard 死亡 | concrete |
| R7 | §SPEC-017 注册对账 | 回归 | 真实运行中的 editor 链路（本会话 godot-mcp 已挂载） | `bash launch/mcp-assert-registration.sh --json` | verdict=PASS，godot_entries≥1，broken=0 | concrete |

R2 写操作不发生判据：launcher 在 validate 之后的第一个写动作是 `$GODOT_MCP_HOME` 下日志/状态文件；R2 断言执行后目标 GODOT_MCP_HOME 目录内无新增 launcher 日志（时间戳比对）。

对抗覆盖核对：边界值（R3 escape、R5 symlink）≥1；非法/空状态（R1/R2 注入失败、R6 模块缺失）≥1；负向（R4 非 KOL 零影响）≥1；并发/快速重复场景不适用（校验器无共享状态，单测层 H6 逐位一致已覆盖，实机补充说明入报告）。

## 3. 覆盖核对表

| 任务目标 | 场景 # | 用例文件 |
|----------|--------|----------|
| §SPEC-011 hard fail 双入口 + rc≤2 + 墙钟 + 诊断 | R1, R2 | test_see1328_config_validate_realchain.mjs |
| §SPEC-012 逃生门 + DRDFS_ESCAPE stage log | R3 | 同上 |
| §SPEC-012 非 KOL 零影响 | R4 | 同上 |
| hardener §4-1 raw-path 集成态 | R5 | 同上 |
| hardener §4-3 防御放行集成态 | R6 | 同上 |
| §SPEC-017 注册对账不退化 | R7 | 同上（真链调用 mcp-assert-registration.sh） |
| hardener §4-2 双入口集成行为 | R1, R2（SHIM_DIE / CONFIG_VALIDATE_FAIL 双触发即双入口集成证明）| 同上 |

回归门禁：§1 全部 4 项须全绿（13 + 12 + 实机套件 + registration PASS）。
