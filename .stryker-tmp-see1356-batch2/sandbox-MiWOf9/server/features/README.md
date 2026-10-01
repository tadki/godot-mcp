# 简介一览

无限货币差不多了，本目录（`server/features/`）是 SEE-1334 Phase 3 的 gherkin 场景套件＝任务 spec 的可执行条款（Owner 2026-09-21 拍板）。

- Runner: cucumber-js `--strict`（pending 即失败，对齐 gqt「step 被跳过即失败、禁 observe 式 pass」）。
- 端口被占 fail-fast 带诊断 / B1 懒加载拉起 / 单客户端独占拒绝（4001）/ 截图契约 /
  exec 约束拦截 —— 全部协议层 mock 可复现（ seam: `_see1085_helpers.sh` 同款 counting
  mocks + `ws-mock-listener.mjs` SSOT mock editor + mock npx on PATH），不依赖真机。
- 运行命令（任务验收 + nightly 证据跑；暂不入 PR CI）：

```bash
cd server && npx cucumber-js --strict
```

## 条款 ↔ 场景对账表（SPEC-031 依据物）

| 任务 spec 条款 | 场景（scenario） | 判据锚点 |
|---|---|---|
| B1 lazy-load：MCP 握手永远成功，编辑器延迟生成 | b1_lazy_load:「initialize 秒回且不触碰生成链路」 | configure/start 计数为 0 且 initialize <5s 应答 |
| B1 lazy-load：首个 tools/call 拉起编辑器各恰好一次 + hold-to-warm flush | b1_lazy_load:「首个 tools/call 生成编辑器各恰好一次」 | configure=1、start=1（计数文件精确断言）+ id=2 已到达 npx 日志（hold 后 flush） |
| 端口被占：arbiter busy_foreign → fail-fast 不启动生成链路，in-band 拒绝带可重试诊断 | port_conflict_fail_fast:「端口被活 holder 占用 → in-band editor_busy，零生成」 | 响应 error.data: bucket=editor_busy / state=spawn_failed / retryable=true；configure/start 计数为 0 |
| 单客户端独占：第二 WS 客户端被 close code 4001 拒绝；proxy 侧分类器给出可重试 editor_busy | single_client:「第二客户端被 4001 拒绝」 | wire 层：客户端 close 事件 code=4001 + 服务端 closed_4001 标记；errors.mjs EDITOR_BUSY_PATTERNS 命中 wire 文本 |
| 截图契约 C3：成功响应携带 `_screenshot`（captured_at_ms / capture_latency_ms / auto_step / stale） | screenshot_contract:「成功捕获携带帧元数据 + 全分辨率导出」 | 响应 JSON 块含 `_screenshot`（stale=false、latency 数字、captured_at_ms>0） |
| 截图契约 C4+D3：全分辨率导出落盘 + 宽×高按磁盘 PNG 头核实；超宽即 FAILED | screenshot_contract: 两场景 | exports.png_path 存在且 PNG 头=原生尺寸；max_width=16 而磁盘帧 64 宽 → 响应含「Width×height check FAILED」 |
| exec 约束 SSOT：DENIED_TOKEN in-band 点名违反条目 | exec_constraints:「禁用 token 被 in-band 拒绝并点名」 | 错误 message 含 OS.kill；npx 传输日志无该 call id（in-band 拦截） |
| exec 约束 SSOT：await 非法（SYNC ONLY） | exec_constraints:「await 拒绝为 SYNC_ONLY」 | 错误 message 含前缀「SYNC_ONLY:」 |
| exec 约束 SSOT：action:help 返回完整约束摘要 | exec_constraints:「help 返回完整 SSOT 约束摘要」 | result 文本含「godot_exec constraints」+ OS.execute + SYNC ONLY |

每条款 ≥1 场景；以上场景全部依赖既有测试资产（`ws-mock-listener.mjs`、
`_see1085_helpers.sh` 的 counting-mock 契约、`proxy/errors.mjs` 分类器、
`see1240-exec-constraints.mjs` SSOT）——不重复造 mock。

## steps

- `steps/protocol_steps.ts` — 全部 Given/When/Then（TS + tsx hook 加载）。
- `steps/support/proxy_driver.ts` — 真实 stdio 驱动器（spawn `node launch/godot-mcp-proxy.mjs`，
  一次生成 wrapper、throwaway sandbox 隔离注册表状态）。

## 暴露真实 bug 的处理

本阶段为测试资产落地；若场景揭示运行时缺陷，记录并上报，不在本 Phase 中修（约束6）。
