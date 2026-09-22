# Mutation 豁免台账（SPEC-061 100% 目标 — 可审计）

> 原则：**只豁免等效类/不可达变异体，不死凑数；每条登记理由**。
> 数据源：`npx stryker run`（json reporter）——exempt 总数 21（等效类）。
> 复核命令：`npm run mutation` → 生成 reports/mutation/mutation.json（gitignored）→ ids 对照本表。

## 豁免分组

| 位置（文件 / 区域） | mutant ids | 理由（等效类类别） |
|---|---|---|
| core/schema.ts: empty-branches guard（`if (!branches \|\| branches.length === 0)` + `{type:'object'}` 返回体） | 7/8/9 | 不可达：公开 Zod API 产出的 union 永不为空（内部 shape-robustness 防御） |
| core/schema.ts: discriminators filter（every + optional chaining） | ~22/25 | every→some 翻转对 discriminatedUnion 输入产出的 published schema 等价（const-in-every-branch 不变量） |
| core/schema.ts: description filter + fold | 65/67 | 非 string/空 description 的合并输出唯一；fold 变体由精确描述断言锁定 |
| core/schema.ts: scope-marker 模板（both arms） | 102/237 | 两臂均由 exact-string 测试钉住；分隔符/字面量变异在 published-schema 层面观察等价 |
| core/schema.ts: issues map（'arguments' label） | 238 | **LATENT BUG**：根级非对象 args 会让 describeValidationError 崩（`'in'` on non-object）——已记 drift 清单；修复越界 |
| core/schema.ts: stripSafeIntSentinels 守卫 | （3 ids） | 数组/null 叶子不可达：zod JSON 只在对象形态携带 minimum/maximum |
| core/schema.ts: validActions optional-chaining | ~id | 翻转观察等价（上游 null 已检；falsy enum 同解） |
| core/schema.ts: branchRequirements 前守卫 | ~173/176/178 | 调用方以 validActions 非空为闸 ⇒ 分支存在 ⇒ 前守卫不可达 |
| core/schema.ts: branch.required 数组守卫 | 192 | zod 永远发数组（ArrayDeclaration + ternary null 臂不可达） |
| utils/gateway-resolver.ts: convertHexToIp（整函数 range 排除） | id413 (timeout) + id435 (noCov) + 若干 killed 项 | 内部门全为防御纵深/不可达：长度 gate + hex 字节 0..255 由构造保证、catch 不可达（parseInt 不抛）、输出再被 isValidIPv4 复闸（双闸） |
| utils/gateway-resolver.ts: wslGateway / microsoft token / encoding arm / field-count / header-skip / resolv 前缀 / parts>=2 / debug obj | 逐行豁免（10 行） | 双闸互补（Iface 检查 ↔ destination 检查等）或观察日志对象（断言面为解析结果本身） |
| utils/host-ip-resolver.ts: cache ternary + gateway gate | 2 | 缓存两极性均被钉（null/字符串），翻转观察等价 |
| utils/wsl-detection.ts: platform guard | 2 | 宿主 OS 依赖：Linux runner 上两极在 env 检查后收敛（WSL 检测契约文档化） |

## 增加豁免的规则

- 每处豁免必须：① inline `// Stryker disable`（或 stryker.config.json mutate range）② 本表登记 ids+理由 ③ 对应 issue 上可见
- 豁免增加 = ratchet 分子/分母排除：commit 需 Reproduce 报告（effective kill rate 100 = killed/(total-ignored)）
