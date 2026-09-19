# 测试计划 — SEE-1328 B-qa：§SPEC-013/015/016 实机验收（阶段二收口）

> revy-qa Step 3。实机 = 真 editor（KingOfLikes 4.6.2-stable）+ 真部署链（运行中 godot-mcp MCP 链路），owner-order §5.2 禁 headless。

## 1. 回归清单

| 测试文件 | 类型 | 来源 |
|---|---|---|
| launch/tests/scripts/test_see1328_b_screenshot_link.mjs | 单测 | B-code |
| launch/tests/scripts/test_see1328_b_screenshot_link_hardener.mjs | 单测 | B-hardener |
| launch/tests/scripts/test_see1325_config_validate.mjs | 单测 | 阶段一 |
| launch/tests/scripts/test_see1328_config_validate_hardener.mjs | 单测 | 阶段一 |
| launch/tests/e2e/see1328/test_see1328_resolution_threestate.mjs | 实机 E2E（三态分辨率） | 本次新增 |
| launch/tests/e2e/see1328/test_see1328_b_qa_realchain.mjs | 实机 E2E（freshness/retention/attachment） | 本次新增 |
| launch/mcp-assert-registration.sh | 回归 | §SPEC-017 |

## 2. 补充场景（实机）

| 场景 | 关联目标 | Given | When | Then（concrete oracle） |
|---|---|---|---|---|
| T1 | §SPEC-013 ① | 真 editor + 运行中游戏（title_screen） | screenshot_game 省略 max_width ×2 连拍 | 两帧 pngDimensions 相等；帧 A 与帧 B 字节哈希一致（同帧不重采样）；且与降采样帧宽高不同 |
| T2 | §SPEC-013 ② | 同上 | screenshot_game max_width=原生宽（≥ 分支，取 T1 实测宽） | 输出与 T1 帧**逐字节相同**（sha256 相等）——上限语义：≥ 原生 = 原样返回 |
| T3 | §SPEC-013 ③ | 同上 | screenshot_game max_width=原生宽/2 | 输出宽=原生/2（±1px 取整）、高等比；同参 sharp LANCZOS 参考图与实际输出**字节级确定性一致**（或像素级 SSIM=1 的确定性比对：同参数重复运行输出自身稳定 + 与参考图逐像素比对）|
| T4 | §SPEC-015 | 真 editor 链 | screenshot_game 带 auto_step + 校验响应 _screenshot 元数据；复跑 SEE-1166 amber oracle（qa_ws3 客户端像素证据）| _screenshot.stale=false / reason=auto_step；amber oracle 输出与基线帧像素判定一致（qa-green/amber 参照）|
| T5 | §SPEC-015 | 阈值文案 | 检查 stale 文案渲染路径（verdict.thresholdMs 接线）| 单测层已钉（HR3）；实机核对运行链 verdict 文本含 "1500ms" 默认阈值 |
| T6 | attachment 实投 | 本地落盘 PNG | multica issue comment add --attachment 实投一张实机截图 | 平台回执成功（本报告附件即证据）|
| T7 | §SPEC-016 | exports 目录 | 记录目录 inode/文件清单 → 执行多次截图 → 再查清单 | 只增不删（零自动清理实机核对）；单测层零 unlink 断言已钉 |

对抗覆盖：T2 上限边界、T3 整数取整边界、T1 同帧确定性（负向：若两次连拍不一致即 FAIL）、T5 非法 env 不适用实机（单测已覆盖十类非法值）。

## 3. 覆盖核对

| 目标 | 场景 |
|---|---|
| §SPEC-013 | T1/T2/T3 |
| §SPEC-015 | T4/T5 |
| --attachment 实投 | T6 |
| §SPEC-016 | T7 |
| see1244 适配尾部回归 | 待 Atlas 转发 Bachi 落地 HEAD 后补归档 |
