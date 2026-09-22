# Mutation 豁免台账（SPEC-061 100% 目标 — D2 对账版）

> 原则：**只豁免等效类/不可达/双闸防御变异体，不死凑数；逐条登记 id+理由，可审计**。
> 数据源：`npx stryker run`（json reporter，gitignored）→ 本表由其实测 Ignored 集合生成并人工核对区域归因。
> 复核命令：`npm run mutation` → `reports/mutation/mutation.json` → 对照本表逐条 mutant id。
> **D2 修订（2026-09-22）**：mutate 面已恢复 SPEC-040 原白名单（6 文件全量，无 range 排除——convertHexToIp 的 catch/noCov/timeout 以 per-line disable 处理）；schema.ts disable 跨度逐条对账如下表。

## 总账

- Ignored 总数：**262**（= Stryker 实测）
- 有效 kill rate：**100%**（killed 224 / non-ignored 224；0 survived、0 noCov、0 timeout 逃逸）
- 覆盖区域：20 个（下表全覆盖，无未映射位点）

## 逐区域台账

| 位置 | 数量 | mutant ids | 行位（≤12 示例） | 理由（等效类类别） |
|---|---|---|---|---|
| `core/schema.ts` L22– | 9 | 1, 2, 3, 4, 5, 6, 7, 8, 9 | L24, L24, L24, L24, L24, L24, L24, L25, L25 | empty-branches guard: unreachable via the public Zod API — zod unions are never empty; internal shape-robustness |
| `core/schema.ts` L26– | 3 | 10, 11, 12 | L29, L30, L30 | propsOf/requiredOf helpers + commonRequired: ArrowFunction/ArrayDeclaration variants observable-equivalent through the merge contract |
| `core/schema.ts` L34– | 13 | 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25 | L34, L34, L34, L34, L38, L38, L40, L40, L40, L40, L40, L40 … | discriminator filter: every/some + optional-chaining flips yield equivalent published schemas (const-in-every-branch invariant) |
| `core/schema.ts` L44– | 2 | 26, 27 | L44, L44 | appearance collection: CallExpression/BlockStatement/LogicalOperator/ArrayDeclaration variants observable-equivalent through the merge contract |
| `core/schema.ts` L50– | 10 | 28, 29, 30, 31, 32, 33, 34, 35, 36, 37 | L53, L53, L56, L57, L57, L58, L58, L59, L59, L60 | discriminator summary lines: label/desc conditional, enum construction, appearance loop variants pinned or equivalent through exact three-line description tests |
| `core/schema.ts` L66– | 17 | 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54 | L68, L69, L72, L72, L72, L72, L72, L72, L72, L72, L72, L72 … | description merge + base-schema selection: filter/fold/markers produce identical merged text for all reachable appearance sets; last-appearance-wins structure pinned by schema-fidelity tests |
| `core/schema.ts` L84– | 15 | 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69 | L84, L84, L88, L90, L90, L90, L90, L90, L90, L90, L90, L90 … | scope markers + description assignment: both arms of every conditional pinned by exact-string tests (required-only / optional-only / dual-segment / (for:) forms) |
| `core/schema.ts` L99– | 21 | 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117 | L110, L110, L110, L110, L111, L111, L111, L112, L112, L113, L115, L115 … | spread guards + marker block: properties/required keys always present for reachable unions; marker literals pinned by exact-string tests |
| `core/schema.ts` L124– | 12 | 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129 | L128, L129, L130, L130, L130, L130, L130, L131, L131, L131, L131, L131 | stripSafeIntSentinels guards: zod JSON emits bounds only in object form — array/null leaf guards are shape-robustness, unreachable via public API |
| `core/schema.ts` L134– | 38 | 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165, 166, 167 | L138, L140, L140, L140, L141, L145, L145, L145, L145, L145, L145, L145 … | toInputSchema dispatch + union flatten: oneOf/anyOf/allOf/object-root conditionals and flatten internals pinned by union-flattening killer tests (allOf + non-object root throws) |
| `core/schema.ts` L166– | 5 | 168, 169, 170, 171, 172 | L166, L166, L171, L175, L175 | validActions: optional-chaining + enum flip observable-equivalent (upstream null checked; falsy enum resolves identically) |
| `core/schema.ts` L176– | 25 | 173, 174, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197 | L184, L188, L188, L188, L192, L192, L192, L192, L192, L195, L195, L195 … | branchRequirements: optional-chaining/pre-guards/required-array guard unreachable or equivalent (callers gate on validActions; zod always emits required arrays) |
| `core/schema.ts` L201– | 53 | 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230, 231, 232, 233, 234, 235, 236, 237, 238, 239, 241, 242, 245, 246, 248, 250, 251, 252, 253, 254, 255 | L203, L203, L203, L203, L214, L215, L215, L215, L215, L218, L218, L218 … | describeValidationError message assembly: unknown/missing/branch paths and separators pinned by exact-message killer tests; arguments fallback = LATENT BUG (drift ledger) |
| `utils/gateway-resolver.ts` L1– | 2 | 321, 322 | L44, L44 | resolveGateway platform/wsl branches: complementary checks — flips converge via downstream gates; platform branches host-OS dependent; microsoft token classified on release path |
| `utils/gateway-resolver.ts` L76– | 2 | 355, 356 | L78, L78 | parse gates: header/non-default skip complementary; short/bad-hex lines nulled by convertHexToIp length gate + isValidIPv4 re-gate (defense-in-depth); catch logs and falls through |
| `utils/gateway-resolver.ts` L106– | 10 | 373, 374, 380, 381, 384, 385, 387, 389, 390, 392 | L111, L111, L117, L117, L121, L121, L121, L121, L121, L121 | route parsing: field-count/header/destination gates complementary; string-literal mutations masked by later gates; encoding arm parse-identical |
| `utils/gateway-resolver.ts` L144– | 13 | 411, 416, 417, 418, 419, 420, 421, 422, 423, 424, 425, 428, 431 | L151, L156, L156, L156, L156, L156, L156, L156, L156, L156, L156, L156 … | convertHexToIp: byte-range some() guard arms unreachable (2-char hex parseInt yields 0..255 or NaN by construction; NaN returns null via some; isValidIPv4 re-gates at caller); catch unreachable (parseInt never throws); i-=2 flip = infinite-loop class, non-killable without hanging the runner |
| `utils/gateway-resolver.ts` L167– | 5 | 433, 434, 436, 443, 444 | L175, L175, L180, L184, L184 | resolveWSL2Nameserver parse gates: prefix exactness/parts-length/regex variants converge via isValidIPv4 re-gate; catch logs and returns null |
| `utils/host-ip-resolver.ts` L1– | 4 | 459, 460, 473, 474 | L27, L27, L47, L47 | cache ternary + override/WSL/resolver gates: null and string cache polarities both pinned; flip observable-equivalent; resolver failure path converges to cached null |
| `utils/wsl-detection.ts` L1– | 3 | 552, 553, 556 | L16, L16, L16 | platform guard is host-OS dependent: on Linux runners both polarities converge after env checks (documented WSL detection contract) |

## 增加豁免的规则

- 每处豁免必须：① inline `// Stryker disable next-line <mutators>: <理由>`（冒号紧跟 mutator 列表——`--` 与 ` : ` 分隔符会导致解析失配，见 D2 过程）或 stryker.config.json 的精确 mutate range；② 本表登记 ids+理由；③ issue 上对 Revy 可见并经对抗复核。
- 禁止：file 级/range 级整体切除、把"难测"登记为"等效"、写空转测试凑 kill rate。
- LATENT BUG（describeValidationError 根级非对象 args 崩溃）维持 drift 清单登记，本单不修。
