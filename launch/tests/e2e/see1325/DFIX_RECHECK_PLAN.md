# D-recheck 记录 — SEE-1328 D-fix（gdignore track 版）真 editor 实机复验

> 2026-09-21 真机（真 editor Godot 4.6.2-stable win64 + 真 fork 检出 + build 产物）。
> A/B 对照形态：B 组 = D-fix 在位（`server/addon/.gdignore` track 版 + build 38 个 .gd 副本）；
> A 组 = 对抗对照（临时移除 .gdignore，C0 双注册形态复现）。判定 oracle = 编辑器扫描期 stdout 日志
> 中的 `UID duplicate detected` 与 `Class "..." hides a global script class` 计数。

## 实测记录（判别力完备的 A/B 对照）

| 组 | 形态 | UID duplicate | hides a global | 判定 |
|---|---|---|---|---|
| A（对抗对照：.gdignore 移除） | fork 检出 + build 38 .gd 双注册形态裸奔 | **36** | **30** | C0 形态完整复现（判据判别力证明）|
| B（D-fix 在位） | 同形态 + .gdignore（track 版） | **0** | **0** | **.gdignore 生效实锤** |

A 组原始样例：`WARNING: UID duplicate detected between res://addons/godot_mcp/server/addon/commands/animation_commands.gd and res://addons/godot_mcp/commands/animation_commands.gd.`（逐文件成对出现）+ `SCRIPT ERROR: Parse Error: Class "MCPDebuggerPlugin" hides a global script class.`

补充实机事实：
- B 组编辑器启动后 MCP 插件正常加载（`WS_BIND_OK` 出现在编辑器日志；端口 6550 为未跑 configure 的默认绑定，与被测物无关）
- B 组日志中的字体/theme 资源解析 ERROR 为 KOL 项目既有问题（A 组同样存在），与被测物无关
- build 保留逻辑真跑验证：`npm run build` 后 `.gdignore preserved` 输出 + 文件在位（38 .gd 副本与 .gdignore 共存于 server/addon/）

## 判据判读

A 组复现 + B 组归零 = "零 UID duplicate" 不是"扫描未跑/表不覆盖"的假阳性——**判据判别力成立，D-fix 生效实锤**。

## 常规回归（生产链路）

- 主检出（本 workdir）editor 链路正常：godot-mcp MCP 工具实调 `godot_project get_info` 返回 KingOfLikes 4.6.2-stable ✓
- §SPEC-017 registration verdict=PASS（4 entries / 0 broken）✓
- 全量套件回归见测试报告（唯一环境项：D-fix 分支基线并入 fork main 后 server 运行时新增 zod 依赖，测试侧 `npm install` 适配后 ui_tools 1/1 恢复——revy-qa 5.3.2 环境配置类处置）
