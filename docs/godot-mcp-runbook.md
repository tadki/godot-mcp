# godot-mcp 运维手册（Runbook）

> 适用范围：fork `tadki/godot-mcp` 的 launch 层——磁盘运行时状态机、审计轨迹、锁族与回收链（SEE-1338/1348/1363/1365/1370 批次沉淀）。游戏态工具（`mcp_watch` / `_mcp_state()`）不在本文范围，见 `addons/godot_mcp/docs/runtime-state-guide.md`。
> 第一原则：**落盘状态是唯一真源**。任何裁决（接管、复用、冷启动、清扫）都以盘上记录为准；proxy 内存态不构成裁决依据。

## 1. 文件布局与读写契约

`GODOT_MCP_HOME` 默认 `~/.config/godot-mcp`。`<rid>` = runtime_id（per-runtime 隔离，非 per-agent）。

| 文件 | 路径 | 内容 | 读写约定 |
|---|---|---|---|
| 主记录 | `$GODOT_MCP_HOME/godot-editor/<rid>.state` | JSON：schema_version=3、state、port、editor_pid(+started_at/source)、proxy_pid(+started_at)、agent、issue_id、worktree、lease_id、heartbeat_at、spawn_attempts、last_error、warm_at、updated_at | 写 = tmp + fsync + 原子 rename（盘上永远是旧版或新版，绝无半写）；读 = 解析失败 / schema 失配 / 未知状态名一律降级为「NO STATE」（按冷启动处理） |
| 审计轨迹 | `$GODOT_MCP_HOME/godot-editor/<rid>.events.jsonl` | 追加式 JSONL：`{ts, event, from_state, to_state, detail}` | 审计是增强不是契约——追加失败绝不阻塞主路径 |
| held-runtime 逻辑锁 | `$GODOT_MCP_HOME/held-runtime/<rid>/`（`owner` + `since`） | 「谁在管理本 runtime 的编辑器」的互斥锁 | mkdir 原子获取；owner 记录 proxy pid（WSL 侧 node pid） |
| arbiter 端口锁 | `$GODOT_MCP_HOME/godot-mcp-held/<port>/`（`pid` + `meta`） | per-port 物理锁（端口分配仲裁） | 同上，mkdir 原子 |
| launcher 启动锁 | `addons/godot_mcp/launch/held/<rid>/pid` | launcher 进程级启动互斥 | 同上 |
| 端口注册表 | `$GODOT_MCP_HOME/godot-port-registry.json` | proxy 心跳 upsert 的端口↔proxy 注册 | flock 协议串行化 |

**读降级的触发（任一命中）**：文件不存在 / JSON 解析失败 / `schema_version ≠ 3` / `state` 不在枚举内 / `editor_pid_source` 不在 `{wsl, windows, pending}` 内。降级语义统一 = NO STATE = 按冷启动处理，损坏盘面永远不会卡死分配路径。

## 2. 磁盘 5 态机速查

状态枚举（`VALID_STATES`）恰为五态，**无第六态**（历史否决见 §8）：

| 状态 | 判据 | 含义 | 处置 | 升级条件 |
|---|---|---|---|---|
| COLD | `state=COLD`（或无记录/不可读→等价） | 无在管编辑器，或上一段已结算（EDITOR_GONE 死亡裁决的落盘态） | 无需操作——下一次 tools/call 自动冷启动 | 反复冷启动失败 → 看 `last_error` + events（§7） |
| WARMING | `state=WARMING` + `heartbeat_at` 新鲜（≤10min） | proxy 正在拉起/预热编辑器 | 等待（proxy 内部事件驱动；操作者不要手动占端口） | 心跳停滞 >10min 且 proxy_pid 已死 → 按「proxy 死亡」处置（§7） |
| WARM | `state=WARM` + 心跳新鲜 | 编辑器可用，proxy 在管 | 无 | MCP 调用报 `editor_gone` → 重试（proxy 已自动写 COLD 并重暖）；持续失败 → 查 events |
| RECOVERING | `state=RECOVERING` | warmup 超时后的恢复轮（有硬上限，超限转 FAILED_CLEAN） | 观察 events | 长时间停驻不进出 → 按 §7 强制冷重启流程 |
| FAILED_CLEAN | `state=FAILED_CLEAN` | 连续失败熔断（可重入：下一次 tools/call 自动重试冷启动，无需重启 MCP） | 读 `last_error`、events 失败串、`spawn_failed_streak`/`give_up_count` 等预算字段 | 熔断反复重入 → 清理 worktree sidecar 残留 + 手工停残留编辑器（§5/§7） |

## 3. 逐态处置详情

### 3.1 COLD / NO STATE

- **判据文件**：`<rid>.state` 不存在、`state=COLD`、或读降级（§1）。
- **处置命令**：无——链路设计为下一次 `tools/call` 自动冷启动（SPAWN_ISSUED 事件落盘）。需手工拉起时用 `addons/godot_mcp/launch/start-godot-editor.sh`（参数见其 usage）。
- **升级条件**：冷启动连续失败（调用方连续收到 `spawn_failed` 诊断、盘上转入 FAILED_CLEAN）→ §7。

### 3.2 WARMING / RECOVERING（在途态）

- **判据文件**：`state` 字段 + `heartbeat_at` 新鲜度（默认 10min 阈值）+ `proxy_pid` 活性（kill-0 + `/proc/<pid>/exe` 必须为 node）。
- **处置**：join_wait——后继 proxy 读到在途态 + 活 proxy + 新鲜心跳时加入等待，不重复拉起。操作者同样等待。
- **升级条件**：proxy_pid 死 / 心跳停滞 → 判定 holder 死亡，进入 reclaim_dead（清残留 + 冷启动）；手工等价：`bash addons/godot_mcp/launch/reap-stale-leases.sh --dry-run` 预览后去掉 `--dry-run` 执行。

### 3.3 WARM

- **判据文件**：`state=WARM` + 心跳新鲜 + proxy_pid 活。
- **正常退出语义**：proxy 干净退出写 `PROXY_EXIT` 事件——只释放 proxy 所有权（`proxy_pid:null`），编辑器状态保留（编辑器比 proxy 长寿）；同时在 lease sidecar 上打 `intentional_release` 标记，resident reaper 据此跳过 120s 宽限期、下一 tick 即回收空闲编辑器。后继读到 `WARM + 无 proxy 所有者` → HANDOFF（接管，不起新编辑器）。
- **升级条件**：MCP 调用返回 `editor_gone`（retryable）→ proxy 已按 EDITOR_GONE 处理（写 COLD + 后台重暖），直接重试即可；重试仍败 → 查 events.jsonl 的 EDITOR_GONE detail 与 proxy 日志。

### 3.4 FAILED_CLEAN

- **判据文件**：`state=FAILED_CLEAN`；伴随 `spawn_failed_streak` / `give_up_count` / `spawn_backoff_until` 等预算字段落盘（重启预算可跨进程续算）。
- **处置**：该态可重入——下一次 tools/call 自动走冷启动；操作者先读 `last_error` 与 events 的失败原因，再决定是否手工清场。
- **升级条件**：手工清场顺序——`stop-godot-editor.sh --port <port>` 停残留编辑器 → `reap-stale-leases.sh --dry-run` 预览 → 正式清扫 → 重新触发调用。

## 4. events.jsonl 审计语义

- 追加式 JSONL，审计是增强不是契约（写失败不阻塞主路径）。
- **事件由 proxy 独家产生**；reaper 不产生任何 `.state` 审计。历史更正：曾存在的唯一 REAP 事件写入点位于 SEE-1370 删除的 `--from-state` executor 块内——legacy 清扫臂从未写过 `.state` 审计。
- 典型事件序列：`SPAWN_ISSUED`（COLD→拉起）→ 各 stage 标记 → `EDITOR_GONE`（WARM→COLD，post-warm 死亡裁决）→ `PROXY_EXIT`（干净退出，编辑器保留）/ `STATE_TRANSITION`（如 streak 耗尽 → FAILED_CLEAN）。
- **弃管 runtime 的诚实终态**：events 以 `EDITOR_GONE` 或 `PROXY_EXIT` 收尾；若 proxy 被 SIGKILL，则没有收尾事件——盘上停留的最后一个状态即真相，按 §2/§3 判据处置。

## 5. 三族锁与清扫

| 锁族 | 路径 | 属主文件 | 判活标准 | 清扫者 |
|---|---|---|---|---|
| launcher 启动锁 | `addons/godot_mcp/launch/held/<rid>/` | `pid` | arbiter 标准：kill -0 成功 + `/proc/<pid>/exe` 是 node | reaper HELD 段 |
| arbiter 端口锁 | `$GODOT_MCP_HOME/godot-mcp-held/<port>/` | `pid`（+`meta`） | 同上 | reaper HELD 段 |
| held-runtime 逻辑锁 | `$GODOT_MCP_HOME/held-runtime/<rid>/` | `owner`（+`since`） | 同上 | reaper HELD 段（SEE-1370 #7 起纳入） |

要点：

- **owner 写入是 best-effort**（写失败锁仍算持有）；缺 `owner` 的目录 proxy 侧**永不窃取**（读失败即 contention）——因此清扫策略为：缺 owner 时按 `since`（缺省回退目录 mtime）陈旧度裁决，新鲜（阈值内）视为在途获取予以保留，陈旧视为崩溃残留予以收割。阈值以命名常量定义于 reaper 脚本（在途窗为毫秒级，阈值裕度远大于此）。
- 活锁目录**永不被删**；dry-run 只报告不动盘。
- 手动清扫：`bash addons/godot_mcp/launch/reap-stale-leases.sh --dry-run`（预览）→ 去 `--dry-run` 执行。可用 `KOL_REAP_HELD=0` / `KOL_REAP_REGISTRY=0` 分别关闭 held/registry 两路清扫。

## 6. reaper 与 CLI 契约

- `reap-stale-leases.sh`（默认 legacy 扫描模式）判据族：sidecar `configured_by_pid` 已死 / sidecar 的 editor pidfile 死或端口无监听 / sidecar 损坏。附加清扫：端口注册表死项 + 三族 held 锁（§5）。LIVE 模式有 3 秒 Ctrl-C 宽限窗（resident 无人值守模式跳过）。
- **`--from-state` = 显式失败契约**：`rc=2` + stderr `unknown arg`。该模式已被否决并删除（§8），任何脚本/文档若仍引用它即为过时。
- resident reaper：`bash addons/godot_mcp/launch/install-resident-reaper.sh install` 安装 systemd user timer（5 分钟粒度），安装后默认 dry-run，稳定后 `--enable-live`；journal 观察 `pwsh=` 行确认 PowerShell 解析状态。
- `state-cli.mjs`：bash→`.state` 的 editor_pid 回填桥（`--editor-pid <n>|pending` + `--editor-pid-source wsl|windows|pending`），exit 0/1/2。它刻意旁路状态枚举校验（回填文档可能尚无 state 字段）——**不是操作者显示工具**；查看盘面直接 `cat <rid>.state`。
- **等待语义**：任何等待一律事件驱动——就绪握手、目标日志行出现、pipe/信号、带上限的 predicate 轮询；禁止裸 `sleep N` 当同步手段。端口就绪探针：`addons/godot_mcp/launch/mcp_ready_probe.py`（exit 0 = ready）。

## 7. 故障处置速查（症状 → 处置）

| 症状 | 判据 | 处置 |
|---|---|---|
| tools/call 报 `editor_gone`（retryable） | WS 层不可达（进程死或僵活皆可能） | 直接重试——proxy 已写 COLD 并后台重暖；重试仍败查 events 的 EDITOR_GONE detail |
| 报 `editor_busy` | 前任 proxy 在管（AMEND-1：物理活不盲杀） | 等其退出，或核实 proxy_pid 活性后按 reclaim_dead 处置 |
| `spawn_failed` 连续、streak 耗尽 | 转入 FAILED_CLEAN + backoff（封顶 60s） | 读 `last_error`；手工清场按 §3.4。注：`spawn_failed` 是返回调用方的诊断态（含 bucket/spawnAttempts 等字段，retryable），非落盘状态；盘上序列为拉起中 → FAILED_CLEAN |
| WARM 但心跳停滞 >10min 且 proxy 已死 | heartbeatFresh 判 stale | reaper（dry-run 预览后正式）或按 §3.2 手工回收 |
| editor_pid 探测返回「未知」 | PowerShell 不可达（如 appendWindowsPath off） | 判活为 null ≠ 死——链路不会因此误杀活编辑器；检查 `GODOT_MCP_HOME` 与 pwsh 解析（resident journal `pwsh=` 行） |
| 盘上出现不认识的 `state` 值 | 读降级（§1） | 惰性无害，见 §8 操作者契约——不要慌、不要误删 |

## 8. 非目标 / 已否决设计

### REAP_PENDING / `--from-state` executor 模式（已否决并删除）

- **历史**：随 `6f7a43c`（SEE-1338 P1，spec §5）以「proxy 裁决 → reaper 定点执行」设计落地；同提交内被「线性单源」裁决取代——EDITOR_GONE 死亡裁决直接落盘为 COLD，不需要中间裁决态。executor 块出生即死代码（生产端从未写过 REAP_PENDING，全历史零调用方）。
- **否决理由（SEE-1370 plan-debate 三方对抗后裁决，CRITICAL）**：兄弟相残竞态（EDITOR_GONE 写 `editor_pid:null` → executor 只能按端口杀，而 proxy 同端口秒级 respawn → 定点杀死继任编辑器）；与 AMEND-1「物理活不盲杀」冻结裁决冲突；观察性归零（respawn 毫秒级覆写记录 vs 执行臂 5 分钟粒度 → 永远空转）；执行臂独特能力集合为空（清理职责已归属 spawn 链与 legacy 扫描）。完整裁决见 SEE-1370 附件 `decision-see1370-2.md`。
- **操作者契约**：`--from-state` 现为 rc=2 显式失败；盘上若出现未知状态名的残留记录（含历史手搓的 REAP_PENDING），直接 `cat` 可见原始字段，所有决策读者一律降级为 NO STATE（冷启动）——惰性无害，见之不慌、不误删，下一次写盘自然覆盖。
- **防复活哨兵**：fork 仓 CI 含全域零命中检查 `grep -rn REAP_PENDING launch/`（含 tests，token 分段构造实现，合法居所为空集）。复活该机制的前置条件（缺一即回到上述 CRITICAL 形态）：新的 spec 裁决（owner 参与）+ victim 身份模型（editor_pid+source+started_at 全链路携带）+ 事件驱动触发路径。
- 范围注记：launcher/arbiter 两族的 mkdir→pid-write 同型竞态不在 SEE-1370 #7 章程内（未修，如修另立台账）。

## 9. 快速清单

- [ ] 看状态：`cat $GODOT_MCP_HOME/godot-editor/<rid>.state`
- [ ] 看审计：`tail $GODOT_MCP_HOME/godot-editor/<rid>.events.jsonl`
- [ ] 清扫预览：`bash addons/godot_mcp/launch/reap-stale-leases.sh --dry-run`
- [ ] 停编辑器：`bash addons/godot_mcp/launch/stop-godot-editor.sh --port <port>`
- [ ] 就绪探针：`python3 addons/godot_mcp/launch/mcp_ready_probe.py --port <port> [--check tcp|ws|ready]`（`--port` 必填；WSL 下编辑器在 Windows 侧监听，默认 127.0.0.1 不通，需 `--host <WSL 网关 IP>` 或 env `GODOT_HOST`）
- [ ] 规则：不手动加 sleep 等事件；不误删未知态残留；`--from-state` 必 rc=2，引用它的文档即过时
