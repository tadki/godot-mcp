# 测试计划 — SEE-1356 批 1 实机 QA（L7/L2/L5/L6/L1/COM-02）

> revy-qa Step 3。实机红线：禁 headless；oracle 全部为日志行/JSON 字段/进程态（concrete/hybrid），无视觉项（本批实机判据不含视觉断言）。

## 1. 回归清单（Step 5 运行对象）

| 测试文件 | 类型 | 来源 |
|---|---|---|
| launch/tests/scripts/test_see1356_l7_seed_layout.sh | .sh harness | 上游已有 + hardener G6 |
| launch/tests/scripts/test_see1356_status_segments.sh | .sh harness | 上游已有 + hardener R1/R2 边界 |
| launch/tests/scripts/test_see1356_proxy_units.mjs | node harness | 上游已有 |
| launch/tests/scripts/test_see1240_screenshot_contract.mjs | node harness | 上游已有 |
| launch/tests/scripts/test_see1240_ws4_status_doctor.sh | .sh harness | 上游已有（registration FAIL 契约） |
| launch/tests/unit/see1356-*.test.mjs（5 件） | vitest 单测面 | hardener 新增 |
| launch fast tier 全量（97 件，serial+par） | 全量回归 | 上游 |
| godot-qa-toolkit tests/（pytest 321） | .py | 上游 + hardener 9 例 |
| features/*.feature（gherkin 2 件） | BDD | 上游 |
| .dev/tests/scripts/qa_see1356_batch1_live.sh + see1356_rpc_call.py | 实机驱动（本步新增） | 本次 |

## 2. 补充场景设计（实机）

| 场景 # | 目标 | 类型 | Given | When | Then（oracle，强度） |
|---|---|---|---|---|---|
| S0 | §SPEC-L7-03 | 实机只读 | 本 workspace 真实 registry | 只读勘测 | entries/distinct realpaths/duplicate_groups 计数（concrete：0 重复组） |
| S1-A1 | §SPEC-L6-01 | 实机 | 沙箱化 HOME/registry + KOL 真 worktree + marker 6557 | launcher 冷启动真 editor（Windows godot.exe，非 headless） | proxy.log 含 LAUNCHER_EXEC→…→WARM 有序 stage 序列 + 启动头 port/worktree/workdir_hash=ef9f21ac6d16/hash_source=slot（concrete：grep 行号+字段） |
| S1-A2 | §SPEC-L6-02 | 实机 | S1 warm 后 | status --json | proxylog.present=true、highest_stage=WARM、json_rpc_contaminated=false（concrete：JSON 字段） |
| S1-A3 | §SPEC-L2-03 | 实机 | S1 warm 后 | JSON-RPC get_info | workdir_snapshot.workdir_hash==status workdir_hash==ef9f21ac6d16、hash_source=slot（concrete：JSON-RPC 响应文本字段） |
| S1-A4 | §SPEC-L5-02 | 实机 | S1 warm 后 | doctor --json + 快照文件 | proxy_state:warm PASS；快照 state=warm + schema/heartbeat/warmupDiagnostic/transitions/recent_calls/give_up_count 字段全（concrete） |
| S1-A5 | §SPEC-L5-02 T2 | 对抗实机 | S1 warm 后杀 editor 并发 held 调用 | powershell Stop-Process + 并发 get_info | doctor proxy_state recovering + 快照 hold_queue_depth≥1；respawn 后 doctor 复判 warm PASS ≤240s（concrete，负向场景） |
| S1-A6 | §SPEC-L2-03 null | 边界实机 | 删除 R1 快照文件 | get_info | hash_source=snapshot_absent、workdir_hash=null（concrete，空状态） |
| S2-A7 | §SPEC-L2-02 | 实机双 worktree | W2=seed-*/see-qa2-c0ffee123456/workdir/KingOfLikes-Godot 最小工程+addon+marker 6558，R2 冷启动 | 从 W1 cwd 跑 status --json | entries 哈希互异==目录尾、仅一条 is_current_workdir=true（R1）、runtime_id==RevyQa1-ef9f21ac6d16（concrete，并发 runtime 隔离） |
| S3-A8 | §SPEC-L5-02 T4 | 对抗实机 | R3 GODOT_EDITOR=/nonexistent + warmup 20s + cooldown 20s | spawn 失败→give_up | 快照 state=failed_exit；cooldown 中 doctor proxy_state:failed_exit WARN（concrete，异常路径） |
| S3-A9 | §SPEC-L5-02 | 对抗实机 | 杀 R3 proxy 后冷却过期 | doctor | FAIL proxy_state:failed_exit + exit 1 + 两文件 mtime 并列（concrete，契约逃逸仲裁） |
| S4 | §SPEC-L1-03 | 实机 | KOL 真仓 utils/csv_value_utils.gd（38 行，GUT 单测在库） | gqt mutation ×2（timing store 同一 key） | 第二次 wall-clock 显著降低（<70%）且 JSON 契约键集不变；timing_source 首 bootstrap 次 store（concrete：报告字段+wall-clock 实测） |
| S5 | §SPEC-COM-02 | 实机 | KOL 真仓 .mcp.json | mcp-assert-registration.sh | resolve helper 换用后 verdict 正确（exit 0 + 输出形态）（concrete） |

## 3. 覆盖核对表

| 任务目标 | 场景 | 判据 |
|---|---|---|
| §SPEC-L7-03 | S0 | registry 勘测计数 |
| §SPEC-L2-02 | S2-A7 | 双 worktree 三处标注 |
| §SPEC-L2-03 | S1-A3/A6 | 快照回显==status + null 语义 |
| §SPEC-L5-02 | S1-A4/A5、S3-A8/A9 | warm/T2/T4/cooldown/FAIL 仲裁六态实机全覆盖 |
| §SPEC-L6-01 | S1-A1 | daemon 冷启动 stage 序列落盘 |
| §SPEC-L6-02 | S1-A2 | proxylog 段 + 哨兵恒 false |
| §SPEC-L1-03 | S4 | KOL 双跑 + run_error 复测 |
| §SPEC-COM-02 | S5 + 全量回归 | registration 活体 + fast tier |

对抗/负向覆盖：边界值（13-hex/大小写/空串已由 hardener .sh 面覆盖）、并发·快速重复输入（held 调用并发 S1-A5）、非法·空状态（S1-A6 快照删除、S3 spawn 失败）各 ≥1 ✓。
