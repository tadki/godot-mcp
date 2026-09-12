# SEE-1291 — Phase-1 测试语义漂移逐条裁决（11 arms）+ H2 残留处置记录

> 裁决人：Refacty（SEE-1291 子步骤 ②b，2026-09-12）
> 目标套件：`launch/tests/scripts/test_see1117_phase1_marker_lifecycle.sh`（fork main = 289d1ba 起点）
> 依据：「裁决须基于现实现语义」约束 —— 以下每条均先核对生产代码再定夺，核心事实先行。

## 0. 现实现语义基线（裁决依据）

| 事实 | 出处（生产代码，非臆测） |
|---|---|
| project.godot 不再承载 per-agent 运行时状态；lease 只存在于 gitignored sidecar `<worktree>/.godot/mcp-lease.json` | `launch/mcp-sidecar.lib.sh` 头注（SEE-1117 Direction 3）；`launch/configure-mcp-port.sh:385` 唯一写点 `sidecar_write_active` |
| `mcp_write_marker` 生产调用点 = 0（仅 lib 内定义 + 测试引用） | `grep -rn mcp_write_marker launch/ --include=*.sh` 仅命中 `mcp-marker-section.lib.sh:112` 定义处 |
| configure / restore / verify 全部只操作 sidecar，不写 project.godot | `configure-mcp-port.sh`（写 active）、`restore-godot-original.sh`（置 released）、`verify-godot-written-back.sh`（按 sidecar state 出 0/1） |
| push-guard 的 marker/port_override 拦截已随 SEE-1117 Direction 3 + SEE-1240 WS-8 退役，无 legacy grep fallback；现存不变量为 sidecar Check A（HEAD 树携带 `.godot/mcp-lease.json` → rc=2 硬阻断）与 Check B（worktree 侧 active → rc=0 软提示） | KOL `.claude/hooks/push-guard.sh:252-316`（退役注记 + run_sidecar_guard） |
| stop hook 的 [godot_mcp] 处置为「删除 port_override_* 行」（非恢复 false/6550），静态 bind 行（bind_mode/custom_bind_ip，WS-8）原样保留 | KOL `.claude/hooks/auto-pr-on-stop.sh` sanitize_project_godot_mcp |
| project.godot 的 tracked `[godot_mcp]` 段只含 bind_mode=1 / custom_bind_ip="" | KOL HEAD project.godot 实测 |

## 1. 11 个漂移 arm 逐条裁决表

| # | Arm | 原断言（Phase-1 语义） | 现实现 | 裁决 | 落实动作 / 替代覆盖 |
|---|-----|----------------------|--------|------|--------------------|
| 1 | S-atlas.1 | configure 在 project.godot 内钉 marker true/6551 | configure 只写 sidecar（active/port），不触 project.godot | **修改适配** | 改为断言 sidecar `state=active, port=6551`（本套件内保留端到端往返流）；与 Suite A A1 互补 |
| 2 | S-atlas.3 | restore 把 marker 恢复 false/6550 | restore 置 sidecar released，不触 project.godot | **修改适配** | 改为断言 sidecar `state=released`；与 Suite A A4 互补 |
| 3 | S-revy.1 | 同 #1（port 6555） | 同 #1 | **修改适配** | 同 #1（6555） |
| 4 | S-revy.3 | 同 #2 | 同 #2 | **修改适配** | 同 #2 |
| 5 | S10 | auto-pr-on-stop 无条件恢复 marker false/6550 | stop hook：释放 sidecar（sanitize_lease_sidecar）+ 删除 [godot_mcp] 运行时键（非恢复） | **修改适配** | 改为断言 stop hook 后 sidecar `released`（lease-end backstop）；运行时键删除语义由 `hooks/test_see1070_stop_hook_projectgodot_isolation.sh` 承接（D2 delete-key 契约） |
| 6 | S13 | configure 在缺 [godot_mcp] 段时补段 + marker | configure 不写 project.godot（实测 rc=0、段数 0、sidecar 正常） | **退役（归档）** | 归档理由：marker 写路径为死代码（mcp_write_marker 零调用点），无生产行为可断言。替代覆盖：Suite A A1（sidecar 写入）+ 本套件 S-x.5（project.godot 字节不变契约 P1，间接保证不写段） |
| 7 | S14 | configure 处理 EOF 处 marker 块 | 同上，in-place marker 编辑路径不存在 | **退役（归档）** | 归档理由：同 #6，且 EOF 编辑属 marker 写实现的边界防御，随写路径一起死亡。替代覆盖：无需（行为不存在）；marker 读原语仍存于 `mcp-marker-section.lib.sh`（详见 §3 备注） |
| 8 | S8 | push-guard 拒绝携带钉死 marker 的 commit（rc=2） | push-guard 已无 marker 拦截；现存硬阻断 = Check A（HEAD 树携带 sidecar lease 文件） | **修改适配** | 改为 Check A 断言：fixture `git add -f .godot/mcp-lease.json` 入 HEAD → rc=2 + stderr 提 sidecar；复用原「污染 commit 被拒」的叙事骨架 |
| 9 | S9 | push-guard 在 restore 后放行（rc=0） | 现存放行 + 软提示 = Check B（worktree sidecar active，不入 git，不阻断） | **修改适配** | 改为两段断言：`git rm --cached` 后 Check A 放行；worktree 残留 active sidecar → rc=0 + 软提示行。原「恢复后放行」语义由 Check A 放行段承接 |
| 10 | S11 | 工具链缺失时 push-guard 走 legacy grep 仍拦 port_override=true | legacy grep 已整体退役（push-guard 无该代码路径） | **退役（归档）** | 归档理由：被测分支（fallback grep）在生产代码中不存在，无现实现可适配。替代覆盖：无（防御对象已消失）；现役不变量由 #8/#9 的 Check A/B 承接 |
| 11 | S11b(+inverse) | verify 路径权威 vs grep fallback 的行为分叉（rc=0/rc=2 对照） | 分叉双方之一（grep）已退役；push-guard 单一路径 | **退役（归档）** | 归档理由：divergence fixture 的存在前提（双判定路径）消失。替代覆盖：Check A/B 的单路径行为由 #8/#9 直接断言 |

统计：修改适配 6（#1-5、#8、#9 中计 7 处断言重写，arm 计 6 个），退役归档 5（S13、S14、S11、S11b、S11b-inverse）。

> 计数说明：Atlas 语境的「11 个 arm」= marker-pinning 家族（S-atlas.1/.3、S-revy.1/.3、S10、S13、S14）+ push-guard 环境分叉家族（S8/S9/S11/S11b）。本表按此口径逐条覆盖；S11b-inverse 作为 S11b 的组成部分计入 #11。

## 2. 相邻处置（非 11 arm 清单内，随套件重写一并定夺）

| Arm | 处置 | 说明 |
|---|---|---|
| S7 master write-target guard | **保留（路径修复）** | guard 在现实现中仍活跃（configure-mcp-port.sh guard_write_target）；原失败仅为路径锚 127。套件改用 KOL 布局自动解析后保留原断言 |
| S-atlas/S-revy .2/.4/.5 | **保留** | 语义已自然迁移到 sidecar（verify 0/1 出码、project.godot 字节不变），断言文本更新 |
| S12 verify exit 0 on marker absent | **退役（重复覆盖）** | verify 现按 sidecar 判定；「无 lease → clean」已由 `test_see1117_sidecar_lifecycle.sh` A7（sidecar absent → exit 0）承载，套件内保留则为纯重复。随 S13/S14 一并移除，理由留档于此 |

## 3. 遗留观察（记录，不越界处理）

- `launch/mcp-marker-section.lib.sh` 的 `mcp_write_marker`（及 marker 块 in-place 重写原语）在生产代码中已零调用点，属死代码。文件位于 `launch/` 根（本次改动边界仅限 `launch/tests/`、`docs/`、`README.md`），留待后续清理轮处理。
- `test_see1273_t4_chain.sh` 的 `shim_degrade` 子臂在 t4 消费方 clone 形态下失败、单跑该套件 16/16 全绿——疑似 t4 fixture 的 clone 检出状态问题，非语义漂移，留给 see1273 harness 归档轮（M2 承接）核查。
- `test_see1117_live_*`、`test_see1117_suite_f_prime_6agents.sh`、`e2e/`、`abtest/`、`test_see1152_mcp_daily_call_stability.sh`（需 live runtime registry）为 live-editor/长跑/实机类，属 CI 专项层（与 Bachi ②a 分级方案衔接），本次不改其语义。

## 4. H2 残留家族处置记录（双等号 + KOL_ROOT 耦合）

### 4.1 双等号（==）

扫描 `launch/tests/` 全树：`[ x == y ]`（POSIX test 不支持 ==）形态 **0 处残留**——SEE-1287 修复轮已在 KOL 侧 `see1117/1152/1170` 完成 `==`→`=` 与 `$REPO_ROOT/addons/godot_mcp/launch` 前缀修正；本次迁移副本未见回归。现存 `[[ == ]]`（bash 合法）与 `(( == ))` 不在治理范围。**结论：无遗留动作。**

### 4.2 KOL_ROOT 耦合（环境受限测试识别与标记）

耦合根因：迁移后的套件原按 KOL 布局锚定（`$KOL_ROOT/addons/godot_mcp/launch`、`$KOL_ROOT/.claude/hooks`、`$KOL_ROOT/project.godot`、`$KOL_ROOT/.dev/autopilots`），fork 独立检出下默认锚全部落空（rc=127 / fixture 缺文件）。处置分三类：

**A. 修复（fork 布局自适配，已落地并实跑验证）**

| 文件 | 修复 | 实跑结果 |
|---|---|---|
| `test_see1117_phase1_marker_lifecycle.sh` | KOL_ROOT 解析链（env → superproject → 自身）+ LAUNCH_DIR fork 优先 + 合成 project.godot fixture + push-guard host-scoping 适配 + hooks 缺失时 ENV-LIMITED 显式计数（不静默 SKIP、不计 PASS） | 本机（submodule 检出，hooks 可用）：14 PASS / 0 FAIL / exit 0；纯 fork clone 模拟：11 PASS / 3 ENV-LIMITED / exit 0 |
| `test_see1117_sidecar_lifecycle.sh` | 同一解析链（本套件无 hooks 依赖，fork 独立可跑） | 12 PASS / 0 FAIL / exit 0 |
| `test_see1152_configure_async_reaper.sh` | fixture project.godot 改合成生成（fork 根无该文件） | 14 PASS / 0 FAIL / exit 0 |
| `see1129/test_reaper_grace_integration.sh` | `env -i` 行补 `KOL_REAP_DISABLE_PWSH=1`（/mnt/c 绝对路径 fallback 不受 PATH 剥离影响，SEE-1242 A-2 先例） | exit 0（原 124 挂起） |
| `see1129/selftest_evict_residue.sh` | `export KOL_REAP_DISABLE_PWSH=1`（同上） | 7 PASS / 0 FAIL / exit 0（原 124 挂起） |
| `test_see1170_channel1.sh` / `test_see1170_fix_round2.sh` | HOOK 锚改 KOL_ROOT 解析链（repo-checkout.sh 为 KOL 资产） | 16 PASS / 9 PASS，均 exit 0 |
| `test_see1170_channel2.py` / `test_see1170_fix_round.py` | 同上（`local_repo_check` 位于 KOL `.dev/autopilots`）；后者补 python3 shebang | unittest OK / OK |

**B. 标记（环境受限，保留原样，交 CI 分级）**

| 文件 | 限制 | CI 层建议 |
|---|---|---|
| `test_see1152_mcp_daily_call_stability.sh` | 需 live runtime（port registry / editor 生命周期文件） | 专项层（workflow_dispatch / 定时） |
| `test_see1117_live_e2e_editor_port.sh` / `test_see1117_live_sidecar_e2e.sh` / `test_see1117_suite_f_prime_6agents.sh` | 需真实编辑器 / 分钟级长跑 | 专项层（Windows runner 或实机 self-hosted） |
| `launch/tests/e2e/`、`launch/tests/abtest/` | 需真实编辑器 + WS | 专项层 |
| `launch/tests/hooks/see1273/` | KOL_ROOT 必填（`t3d1` 已硬校验）；`t1_tree_consistency` 为归档-only harness | 专项层（KOL_ROOT 就绪的环境） |
| `test_see976_mcp_multi_port.sh` | 依赖退役路径 `.dev/godot-mcp/docs/...`（fatal 退出） | 归档评估：其锚定文档已随 SEE-1273 T5-F 退役，建议下一清理轮归档该套件 |

**C. 衔接说明（与 Atlas/Bachi CI 分级方案）**

> ③ tidy 已按 ②a 最终 workflow（`launch-ci.yml` / `launch-special.yml` @ `shared/SEE-1291`）对齐本节；对齐核验方式与结果见 §6。

- 快层（`launch-ci.yml`，push/PR main，node 22）：59 个入口（shell 45 + node-units 14，runner 按扩展名分派 bash/node/python3 并带 `</dev/null` stdin 防御）。含 ②b 治理后毕业的 5 项：`test_see1117_phase1_marker_lifecycle.sh`（runner 上 hooks 臂 ENV-LIMITED 计数放行，不阻断、不虚报覆盖）、`test_see1117_sidecar_lifecycle.sh`、`test_see1152_configure_async_reaper.sh`、`see1129/test_lease_lifecycle_boundary_matrix.sh`、`see1129/test_reaper_grace_integration.sh`。
- drift-watch（`launch-special.yml` drift bucket，证据性运行、非阻塞）：预存 RED / runner 环境耦合项。②a 迭代移入的 `t16_runtime_identity`、`ws4_status_doctor`、`see986_autopilot_descriptions`、`see1244_shim_handoff`，加上本子步骤甄别移入的 `test_see1134_restart_hold.sh`（依赖干净 HOME——真实 `~/.multica` arbiter/registry 状态互扰，隔离 HOME 下 16/0 绿）与 `test_see1077_edge_cases.sh`（预存 RED，本机亦红）。`test_see1170_channel1.sh` / `fix_round2.sh` / `channel2.py` / `fix_round.py` 留守 drift-watch：本机绿但纯 fork clone 红（repo-checkout.sh 与 `local_repo_check` 均为 KOL 资产，KOL_ROOT 解析链在 runner 上落空），毕业条件 = KOL-coupled 层落地。
- env-bound（`launch-special.yml` env bucket，runner 上显式留档 SKIPPED）：e2e/godot-mcp 31 项 + 顶层 `test_see1070_ws_single_client_4001.mjs`（live editor，且在 `run_all.mjs` 的 `tests/` 目录扫描之外）、see1240*/see1240_qa（KOL_ROOT 真机）、see1273 链（t1_import / t1_tree_consistency 归档 SKIP / t2_chain / t3d1 / t3/t4_chain）、`launch/test_see1273_t2_param.sh`（headless 绿，归 long bucket note）。
- long（`launch-special.yml` long bucket）：`test_see1148_t14_reaper_grace_guard.sh`、`test_see1240_ws5_giveup_rearm.sh`。
- vacuous 退役：`test_see1117_regression_sweep.sh` 已删除（裁决见 §6）。

## 5. 验证记录（AC-DRIFT-002 证据）

```
$ bash launch/tests/scripts/test_see1117_phase1_marker_lifecycle.sh
  PASS: 14  FAIL: 0  ENV-LIMITED: 0   → exit 0
（submodule 检出本机实跑；S8 Check A rc=2、S9 Check B rc=0+warn、S10 sidecar released 均实测）

$ bash launch/tests/scripts/test_see1117_sidecar_lifecycle.sh
  PASS: 12  FAIL: 0 → exit 0

$ bash launch/tests/scripts/test_see1152_configure_async_reaper.sh
  pass=14 fail=0 → exit 0

$ bash launch/tests/scripts/see1129/selftest_evict_residue.sh        → exit 0
$ bash launch/tests/scripts/see1129/test_reaper_grace_integration.sh → exit 0
$ bash launch/tests/scripts/test_see1170_channel1.sh     PASS=16 FAIL=0
$ bash launch/tests/scripts/test_see1170_fix_round2.sh   PASS=9  FAIL=0
$ python3 launch/tests/scripts/test_see1170_channel2.py  OK (3 tests)
$ python3 launch/tests/scripts/test_see1170_fix_round.py OK (7 tests)
$ node launch/tests/scripts/test_see1170_channel3.mjs    PASS=18 FAIL=0
```

## 6. ③ tidy 记录（2026-09-12，AC-CI-004）

**vacuous sweep 裁决**：`test_see1117_regression_sweep.sh` **退役（删除）**。理由：其唯一职责是盘点 SEE-1273 迁移前的旧源树 `.dev/godot-mcp/tests/` + `.dev/tests/scripts/`（SEE-1117 时代的一次性回归盘点，Owner 补充验收 2）；SEE-1287 迁移 + SEE-1273 T5-F 退役后源树消失，glob 落空 → 0 文件、恒绿（vacuous）。选择删除而非修 glob：把 glob 指向新树会造出第二个「跑批器」，与 workflow 显式清单形成第二份需要保持同步的清单——正是 AC-CI-004 要消除的漂移面；且跑批器会无差别触发 live/RED 项。恒绿壳保留只会延续假绿。替代覆盖：测试树入口清单以 `launch-ci.yml`/`launch-special.yml` 显式列表为唯一事实源（missing=0 / 未登记项均 env-bound 留档）。

**workflow ↔ 测试树一致性核验（最终态，b12fa78 @ shared/SEE-1291；Revy ④⑤ §1 对账口径）**：两 workflow 引用的 `launch/tests/` 路径缺失 = 0；测试树 `test_*` 入口 **120 个 = 快层 58 + drift-watch 53 + long 2 + env-bound 7**（env 7 项在 `launch-special.yml` env echo 行显式留档：see1273×5、e2e 顶层 4001、`launch/test_see1273_t2_param.sh` 在 long bucket note）。快层实际列表 59 行 = 58 个 `test_*` 入口 + 1 个 `selftest_integration_combined.mjs`（`selftest_` 前缀 helper，不计入 120 口径）。快层 61→59 修正：`test_see1170_channel2.py` / `test_see1170_fix_round.py` 纯 fork clone 下 ModuleNotFoundError（KOL 资产依赖），从快层移入 drift-watch。

**快层本机终验**：59 项全量按 runner 同款分派（bash/node/python3 + `</dev/null`）串行实跑 PASS=59 FAIL=0。

**runner 循环 stdin 防御**：tidy 本机复验发现 `test_see1148_p3_t16_live_editor.sh` 在部分环境下消费循环 stdin，heredoc 喂单的 runner 循环会提前 EOF 终止（本机复现：t16 后续项不执行；runner 上因环境差异未触发，历史 run 54 项 PASS 完整）。三处 runner 循环（ci shell / ci node-units / special drift）统一加 `</dev/null`。属 runner 加固，无测试断言改动。

**node 版本**：②a 已升 node 22（proxy wsProbe 需 global WebSocket）——本节分层清单按 node 22 事实陈述。

**残留未登记项（7）与处置**：全部 env-bound、已在 `launch-special.yml` env 行留档，无需 workflow 登记为可执行项；`test_see1077_edge_cases.sh`（预存 RED，本机亦红）已入 drift-watch 证据运行。
