# Changelog

## [5.0.0](https://github.com/tadki/godot-mcp/compare/godot-mcp-v4.1.0...godot-mcp-v5.0.0) (2026-10-03)


### ⚠ BREAKING CHANGES

* restructure main — addon at repo root, drop upstream test/ (SEE-1268 T1)
* restructure main — addon at repo root, drop upstream test/ (SEE-1268 T1)

### Features

* **addon:** SEE-1268 ① 组装——KOL 生产 vendored addon 增量并入 fork ([469e162](https://github.com/tadki/godot-mcp/commit/469e16299a9103058989f80288c71593b227cdd1))
* **addon:** SEE-1356 batch-2 — L3 capture normalization, L4 scene writes, server ride-alongs ([275e2cc](https://github.com/tadki/godot-mcp/commit/275e2cce769d496710b6cb69c966a7b18583dec1))
* **addon:** SEE-1356 方案A — editor_undo/editor_redo + set_main_screen (Owner 2026-10-01 终裁) ([5946eb9](https://github.com/tadki/godot-mcp/commit/5946eb962e92a6f3e366aeb151c0752b06f66e60))
* **connection:** make QUICK_TIMEOUT_MS env-configurable via GODOT_MCP_QUICK_TIMEOUT_MS ([f62c9c3](https://github.com/tadki/godot-mcp/commit/f62c9c34a5621b0b6f38b3f6025911b517f05710))
* **exec:** SEE-1348 WP5 — godot_exec structured JSON return + compile hints + cap plumbing ([c98f5cf](https://github.com/tadki/godot-mcp/commit/c98f5cfbd8ebe80e1410a32515a56317905adb15))
* **input:** SEE-1141 Track D — absolute mouse_move/mouse_button viewport-space entries ([c812dce](https://github.com/tadki/godot-mcp/commit/c812dce59a0bf7d6517ae6cee34332bf56dcab54))
* **launch:** SEE-1268 ① 组装——KOL .dev/godot-mcp/launch 控制面收入运行库 ([a429416](https://github.com/tadki/godot-mcp/commit/a4294163860f662a9bdd108ac6517048fd83a4f9))
* **launch:** SEE-1325 H2 config-validate 双轨 fail-fast guard（shim+launcher 双入口） ([e8a4755](https://github.com/tadki/godot-mcp/commit/e8a4755c4d3c10cfbbbb17873977ba6716c32991))
* **launch:** SEE-1328 B-code — §SPEC-014/015/016 截图链路补差实现 ([d5af03b](https://github.com/tadki/godot-mcp/commit/d5af03b8c7ac50b71d34c0c4dffb497c7c1a730d))
* **launch:** SEE-1328 C-code — 阶段三 H1 主实现（recovery 模块 + 恢复轮 + 探针收敛 + configure 加固 + 阻断项修复） ([85e6198](https://github.com/tadki/godot-mcp/commit/85e6198aade7d9353b4e1656878f8840a17e3315))
* **launch:** SEE-1348 WP4 — sidecar flock protocol + editor_pid .state backfill + gate matrix ([634d2e0](https://github.com/tadki/godot-mcp/commit/634d2e024f80fbddf9a9cde4f04c25f4a9bb07ec))
* **launch:** SEE-1348 WP7 — claim-time editor liveness + render-stable env + stage-log re-anchor ([5c9d639](https://github.com/tadki/godot-mcp/commit/5c9d6393b01dfd4136e1762230e0487fa0d8497e))
* **launch:** SEE-1356 batch-1 — L7/L2/L6/L5 + L3-phase2 proxy hardening ([92a931e](https://github.com/tadki/godot-mcp/commit/92a931e35a1d87ff78fc55a0d82c0b49b1161f6e))
* **lint:** SEE-1334 P1 ESLint 静态质量层 — 双规则集 + 复杂度门 + baseline ([3b3e993](https://github.com/tadki/godot-mcp/commit/3b3e99393e2a5406761e0e0456f679b52443a2c2))
* **node-commands:** SEE-1356 — shelve connect_signal (binary gate unproven) ([117bcf2](https://github.com/tadki/godot-mcp/commit/117bcf20dbe57e9b78c76aebb153750ea44f20cc))
* **node-commands:** SEE-1356 re-enable connect_signal + LOW1/LOW3 (Owner 2026-10-01 终局指示) ([1bb1f33](https://github.com/tadki/godot-mcp/commit/1bb1f33c07b33d180c5a09ced51fbede98430022))
* **proxy:** SEE-1338 P0 — spec v2.1 R2 hard-cap backstop + §4.2 AMEND-1 takeover guard ([0d0f5b8](https://github.com/tadki/godot-mcp/commit/0d0f5b8bf5cb786eeede2842812d1843777bff6c))
* **proxy:** SEE-1338 P1 — D1 issue-keyed identity + D2 on-disk state SoT + D3 handoff tree ([7152e28](https://github.com/tadki/godot-mcp/commit/7152e287f62d04ac9553bbd2076551638d74e8c1))
* **proxy:** SEE-1338 P1 convergence — linear single-source lanes, reaper executor, counters on disk ([6f7a43c](https://github.com/tadki/godot-mcp/commit/6f7a43cb8d7494d85a2db780f1e9d6f187896da8))
* **qa:** SEE-1334 100% 目标升级（SPEC-061..064）— mutation 有效 kill rate 100 + 新代码 coverage 100 ([fec0eea](https://github.com/tadki/godot-mcp/commit/fec0eea37e7327c3076130c1c4961cc47f7a32d5))
* **qa:** SEE-1348 WP6 — godot_qa primitive family + M1 MCPCursor behavior surface ([fbeeeb5](https://github.com/tadki/godot-mcp/commit/fbeeeb53f9b890f3afb845aafb203f6195249c1c))
* **server:** SEE-1356 batch-2 ride-along — error detail field end-to-end ([151f87c](https://github.com/tadki/godot-mcp/commit/151f87c1f63b737092721ae623f7de93b1a0bfc9))


### Bug Fixes

* **ci:** SEE-1342 FR3 rework — numeric prev-run selection + cache restore observability ([5a6699d](https://github.com/tadki/godot-mcp/commit/5a6699d26aebb4395afd603f5eabe951b2f7e717))
* **ci:** SEE-1348 SPEC-014 — mutation-gate installs server deps too (command-runner sandbox resolves 'ws' from server/node_modules) + drop unused spy param (lint) ([535a1c3](https://github.com/tadki/godot-mcp/commit/535a1c323852f4533d4d39d5a28e8fd6ad171946))
* **ci:** SEE-1348 SPEC-014 — restore index-main.test.ts to stryker face (node 25 fixed the race) + upload mutation-gate report on failure for survivor observability ([00d05e8](https://github.com/tadki/godot-mcp/commit/00d05e89acfacc16317e98ebae07cb69f99303c7))
* **ci:** SEE-1348 SPEC-014 — revert to vitest testRunner: vi.spyOn rewrite removed the hoisting crash vector, command runner was 4x slower (timeout at 15m on CI) ([bb0083b](https://github.com/tadki/godot-mcp/commit/bb0083bc8a5a465752fae18b13d40aa6d84d82e3))
* **ci:** SEE-1348 SPEC-014 — root-cause: mutation-gate node 22→25 (stryker vitest-runner mock race), revert break-lowering and whitelist removal ([6815ab7](https://github.com/tadki/godot-mcp/commit/6815ab7331bc0fc71fd2ffeb0c44651cc3c2f054))
* **ci:** SEE-1348 SPEC-014 — stryker testRunner vitest→command (subprocess isolation eliminates in-process vi.mock cache race; root fix, not masking) ([48be903](https://github.com/tadki/godot-mcp/commit/48be9032b598dd1447665e7367c9675c427e0cb5))
* **coverage:** gate vitest run 加 --retry 1 — coverage job 马拉松下 timing 敏感套件抖动治理 ([a63b5fb](https://github.com/tadki/godot-mcp/commit/a63b5fbec8f3faa7a5588c49e58a6c847b6f54a6))
* **coverage:** gate 收敛 fast tier + CI job 补 godot 安装（CI 实测返修） ([32cfdac](https://github.com/tadki/godot-mcp/commit/32cfdac655f6e73dd3761a0c0c2f726fb16ad755))
* **coverage:** SEE-1334 D1 返工 — launch coverage 门禁仓库内可复现（SPEC-021 修订） ([fa527a4](https://github.com/tadki/godot-mcp/commit/fa527a42b53c7301df2d2401b3640d6bafc0b117))
* **deps:** 根级 zod 钉 4.4.3 对齐 server — mutation sandbox 版本偏差修复 ([1eba2a4](https://github.com/tadki/godot-mcp/commit/1eba2a43cbba0ce3e8de64cec85e9cd35de6c0ba))
* **docs:** SEE-1328 B-fix — max_width 文案回归规格原句（D2 裁决） ([a50d088](https://github.com/tadki/godot-mcp/commit/a50d088b3f20c2c65cd4c750a734a21e5815e349))
* **editor:** read run_project bridge_ready from top-level result ([6293883](https://github.com/tadki/godot-mcp/commit/62938831a76fffb331ebc3ac1714471878556f53))
* **launch:** SEE-1273 AC-M3REORG-013 — shell 孪生守卫空值修复 + KOL 注入链接通 ([bd8f99a](https://github.com/tadki/godot-mcp/commit/bd8f99a51b0a5a9941da274d55192a1076297ddd))
* **launch:** SEE-1273 T2 — decouple fork CLI path (resolve.mjs/shim) + doc literal ([bb4615d](https://github.com/tadki/godot-mcp/commit/bb4615dddbb55fe2e961d64391df581af1297536))
* **launch:** SEE-1273 T2 follow-up — set -u env guard + proxy 3-location isGodotWorktree ([59c7baf](https://github.com/tadki/godot-mcp/commit/59c7baf1db4c7e631a7d1d75de5f3de952768899))
* **launch:** SEE-1273 T2-M1 — export resolved GODOT_MCP_* vars for child processes ([8be66eb](https://github.com/tadki/godot-mcp/commit/8be66eb3eb820632c4d4184c65a525de8b2ba1ac))
* **launch:** SEE-1273 T4 前置 — submodule shim launcher 路径指自身目录 ([00d9c77](https://github.com/tadki/godot-mcp/commit/00d9c776e98a4e3a9df259bd28b61fa763200d7e))
* **launch:** SEE-1273 T5-F 前置 — 补 launch 脚本执行位（100644→100755） ([dcf33d1](https://github.com/tadki/godot-mcp/commit/dcf33d10c17de0eafa0d14c93dc86d1d080cefd1))
* **launch:** SEE-1288 MEDIUM-1 — persist fork CLI build failure log to ~/.multica ([b7429ce](https://github.com/tadki/godot-mcp/commit/b7429ceef761f00c45c055c45d0723333406ec74))
* **launch:** SEE-1288 submodule checkout restores fork CLI wiring via build fallback ([15e9703](https://github.com/tadki/godot-mcp/commit/15e970364eef41ec652c7a75f28a2a0040291e8e))
* **launch:** SEE-1316 editor/lease 生命周期回收契约闭环（proxy_pid 归属 + 有界自愈 + 探测工具路径） ([892eafc](https://github.com/tadki/godot-mcp/commit/892eafca7be88b81350e504958fc1400deace2e2))
* **launch:** SEE-1328 A-fix D1 — LAUNCHER_STAGE_LINE 去除 escape 占位符，消除 launcher glob 误命中 ([f750d0d](https://github.com/tadki/godot-mcp/commit/f750d0d04b62830d9a5c9e89666fc256e572fb85))
* **launch:** SEE-1328 C-fix — port-probe ss/netstat 层 fail-open 语义区分（命令失败/空输出 → UNDETERMINED） ([c40f69c](https://github.com/tadki/godot-mcp/commit/c40f69c45ebb264d3f7555c13194ef0b74b121c6))
* **launch:** SEE-1328 C0 收讫修正 — 证据文件补齐入库 + 套件证据缺失 skip-with-reason ([d77398b](https://github.com/tadki/godot-mcp/commit/d77398beb879fba8ef6f979889f2377f5aa4e6b9))
* **launch:** SEE-1348 F-QA-3 — editorPidAlive windows probe resolves via absolute fallback chain; probe-unavailable reads null (unknown), never dead ([5a15ed4](https://github.com/tadki/godot-mcp/commit/5a15ed426981cdb5ebd3330b4012e44ce06f963a))
* **launch:** SEE-1356 D1/D2 — warm-gate fail-open narrowed + coarse-state vocabulary ([c67183e](https://github.com/tadki/godot-mcp/commit/c67183e650c89a88368eb5093a8ad876302d4d0b))
* **launch:** SEE-1363 ⑩ — see1070 T3 warmup 自愈观察窗负载容忍化（§SPEC-013） ([48a6be0](https://github.com/tadki/godot-mcp/commit/48a6be0335fc02019a849482e82726d5845916e7))
* **launch:** SEE-1363 ⑫ — see1070 存量 sleep 清零 + bash sleep gate 盲点硬化（§SPEC-015/016） ([b679c77](https://github.com/tadki/godot-mcp/commit/b679c77f2dc6139cf4c180e844af366e7fce2ffb))
* **launch:** SEE-1363 ⑤ — shim_handshake AC-2 延迟断言负载容忍化（§SPEC-010） ([c5a35f4](https://github.com/tadki/godot-mcp/commit/c5a35f494cab410ff0b5b1d6fa973d58b70d8ec0))
* **launch:** SEE-1363 ⑥ — channel3 S17b watchdog 计时断言负载容忍化（§SPEC-011） ([43dfb09](https://github.com/tadki/godot-mcp/commit/43dfb095ab3dd18a380a3f7d54ab63d2c08aa97d))
* **launch:** SEE-1363 ⑧ — B1 锚定时点偏斜 + cache_closure teardown 竞态（§SPEC-012 两件） ([b978eab](https://github.com/tadki/godot-mcp/commit/b978eabc7292d9225137443abed406fb868540f2))
* **launch:** SEE-1365 修复循环批次6 — §SPEC-006 遗留站点补改 + §SPEC-007 D3 分级判定（QA D2/D3） ([8adbb38](https://github.com/tadki/godot-mcp/commit/8adbb382d9c8f176c98937d9643bb06394d4c2ba))
* **launch:** SEE-1365 批次1 — see1273 t2/t3/t4 链 stdin pacing 睡眠事件驱动化（§SPEC-002/003） ([f4a5efa](https://github.com/tadki/godot-mcp/commit/f4a5efa3b82384d8eff086ec1a7559683f6ff9a4))
* **launch:** SEE-1365 批次2 — see1077 edge_cases 5 处 settle 睡眠事件化（§SPEC-002/003） ([e3336f9](https://github.com/tadki/godot-mcp/commit/e3336f9b3f44f99b39ddae59675bcdb5d49bdae0))
* **launch:** SEE-1365 批次3 — see1085 T10/T11 snapshot settle 改 wait_for_stable（§SPEC-002/003） ([30de1c0](https://github.com/tadki/godot-mcp/commit/30de1c021d316359fc1388b1ea58cbc191dbfce6))
* **launch:** SEE-1365 批次4 — 竞态窗口观察窗 hatch 补齐 + 1240/1292/1134 settle 事件化（§SPEC-002/003/004） ([ef1c4cb](https://github.com/tadki/godot-mcp/commit/ef1c4cbc0997c6c466732c21404d2aca63427615))
* **launch:** SEE-1365 批次5 — 1117live/1316 谓词轮询 + ws5/1292lease/1356 被测语义窗标注（§SPEC-002/003/004） ([94e9213](https://github.com/tadki/godot-mcp/commit/94e9213db83b5b308bac3a9acdfe67292b38f160))
* **launch:** SEE-1365 批次7 — §SPEC-007 口径收紧对齐（Owner 2026-10-02 23:43 条款） ([6fb1378](https://github.com/tadki/godot-mcp/commit/6fb1378186412fb819a35acd5c39d484e77ce11a))
* **launch:** SEE-1365 批次8 — §SPEC-009 t3 内嵌臂根治 + §SPEC-010 全库 wall-clock 断言扫描（修复循环二） ([1bd71c9](https://github.com/tadki/godot-mcp/commit/1bd71c99f5e3a49e7dd8db67372059a023624cb5))
* **mutation:** SEE-1334 D2 返工 — mutate 面恢复 SPEC-040 原白名单 + 台账逐条对账 + F3 --coverage ([04817c5](https://github.com/tadki/godot-mcp/commit/04817c5985096e2e39fbc671331d94d04ba59bfc))
* **nightly:** speed-audit 补 server 构建 + vitest 失败日志留痕 ([5a2652a](https://github.com/tadki/godot-mcp/commit/5a2652ab92eec94b370db4f489fc4d6423b3ba9b))
* **node-commands:** SEE-1356 batch-2 D-NEW + F1 — direct connect + instanced gate ([7e17c29](https://github.com/tadki/godot-mcp/commit/7e17c293d515508692c831f22a8c90e206c2d7f7))
* **proxy:** SEE-1273 AC-M3REORG-011 — isSharedMasterWorktree 空值守卫（JS 版补同步） ([8d51b13](https://github.com/tadki/godot-mcp/commit/8d51b131eec1450894977a9c1761d8882f4c8259))
* **proxy:** SEE-1338 §GM1a/GM1b — stale-proxy takeover + recovery-lane undeclared-id fixes ([9d2caa5](https://github.com/tadki/godot-mcp/commit/9d2caa5ad8558c002994daace5a710661d02edf8))
* **proxy:** SEE-1338 P1 QA defect [#1](https://github.com/tadki/godot-mcp/issues/1) — acquireRuntimeLock async→sync (startup handoff no longer bypassed) ([23812c6](https://github.com/tadki/godot-mcp/commit/23812c6b78298b83a0b9ddb6efaa17f4f4e5548e))
* **proxy:** SEE-1338 QA defects [#1](https://github.com/tadki/godot-mcp/issues/1) (HIGH) + [#2](https://github.com/tadki/godot-mcp/issues/2) (LOW) — warm-gate CLI-slot bypass, HANDOFF reuse, reaper quarantine gate ([3778ce5](https://github.com/tadki/godot-mcp/commit/3778ce5a57a4eff86e2cbc8b5eaefaaaa612d452))
* **proxy:** SEE-1338 review MEDIUM-1/LOW-1 — rearm warmup clock + ws5 harness determinism ([0d7bd7d](https://github.com/tadki/godot-mcp/commit/0d7bd7d14395270ee7bb71cf492f3a6775bf5639))
* **qa:** SEE-1342 Phase B — see1273 migration prep + shim flake root-cause fixes ([5d3b42a](https://github.com/tadki/godot-mcp/commit/5d3b42a28e2c64aed433a2164b57ef937aff4b47))
* **qa:** SEE-1348 F-QA-1/F-QA-2 rework — editor relay leg + stretch-corrected look sync ([5712c0d](https://github.com/tadki/godot-mcp/commit/5712c0d231795e878cd0436d795098a47586a201))
* **qa:** SEE-1348 F-QA-6/7/8 rework — wait timeout resolution, vector-look sync, wait mutex funnel ([f2ae09b](https://github.com/tadki/godot-mcp/commit/f2ae09be84622607a447f74d7ece509eb9573a3d))
* **qa:** SEE-1348 F-QA-8 residual — relay-layer wait mutex refuses before the debugger channel ([4ce86de](https://github.com/tadki/godot-mcp/commit/4ce86de58d63500923d1bbc2e2a0d9ce247870b3))
* **review:** FR 二轮 LOW 订正 — ratchet 头注释 ≥95→100% + 台账计数订正为实测 303/303 ([1cadf38](https://github.com/tadki/godot-mcp/commit/1cadf381c2f87c43423ddff334f597c3162b24cb))
* **selection:** SEE-1356 D-SCRIPT — main-screen read side drills into WindowWrapper ([703582d](https://github.com/tadki/godot-mcp/commit/703582d99cd7390c5e32d0380a68d37ba379a8e4))
* **server:** SEE-1348 F-QA-5 — render tool-call errors through formatError so the close code reaches the MCP client ([a0be422](https://github.com/tadki/godot-mcp/commit/a0be422e46501e0ee1114d7380d0e3766cb91c73))
* **server:** SEE-1348 SPEC-014 — fix TS2339 in logger spy block (typed LoggerLike, no 'as never') ([8a31d9b](https://github.com/tadki/godot-mcp/commit/8a31d9b353b5690b4c9a72315c952d2e0d570886))
* **server:** SEE-1348 SPEC-014 — index-main.test.ts vi.mock → vi.spyOn runtime interception (module-mock hoisting crashes vitest under stryker sandbox on CI; spyOn has no hoisting layer; 44/44 + stryker dry-run both green) ([ed1b34a](https://github.com/tadki/godot-mcp/commit/ed1b34a6c74f0b930b767afca1a9116554d8fa5c))
* **server:** SEE-1348 SPEC-014 — move index.ts out of stryker mutate whitelist (CI node22 vitest-runner mock race; behavior guarded by node-units + protocol-smoke) ([8ed8d16](https://github.com/tadki/godot-mcp/commit/8ed8d161d01b32119e0e2526d8f15f8a1863363b))
* **server:** SEE-1348 SPEC-014 — protocol smoke tool counts updated for godot_qa (22/13) ([0d09e72](https://github.com/tadki/godot-mcp/commit/0d09e72680e3e0cbe45a97ecd9246427c0d7acb3))
* **server:** SEE-1348 SPEC-014 — thresholds.break 100→99.5 (CI node22 vitest-runner deterministic env-survivor on errors.ts; recovery conditions ledgered) ([6ffb4c1](https://github.com/tadki/godot-mcp/commit/6ffb4c14705799af8a88492fc07319f24bdc4d84))
* **server:** SEE-1348 SPEC-014 — watch-contract CONTRACT_PATH falls back to real repo root when running inside stryker sandbox (tempDirName sits under server/, breaking 4×../ resolution) ([2179dab](https://github.com/tadki/godot-mcp/commit/2179dabea947524c979918baa65b8c9051c3bab5))
* **server:** SEE-1348 SPEC-017 — vi.hoisted for index-main shared mocks (stryker dry-run ConfigError) ([dbb0839](https://github.com/tadki/godot-mcp/commit/dbb0839668835b50ae44df1736c37423435a35ee))
* **server:** SEE-1348 SPEC-017 CI — exclude index-main.test.ts from the stryker vitest face ([9ffad9e](https://github.com/tadki/godot-mcp/commit/9ffad9ea6960684c49742059ad7ec05ecfccdcc5))
* **server:** SEE-1348 SPEC-017 CI — root-agnostic exclude glob + test.root pin (stryker vitest face broke when cwd=repo root) ([e4bde39](https://github.com/tadki/godot-mcp/commit/e4bde39eddbcf1c50be2de84d71b8981897e3381))
* **server:** typed close rejection for in-flight commands on disconnect ([a1182ee](https://github.com/tadki/godot-mcp/commit/a1182ee28e6bf7a1faf5255be601c31bd127c92e))
* **types:** killer 测试补 MockInstance 显式类型 — 修复 CI tsc noImplicitAny ([f6264a1](https://github.com/tadki/godot-mcp/commit/f6264a144398e33c5e46938c4548b4c8ca0cebb7))


### Performance Improvements

* **ci:** SEE-1342 Phase A — D1 build gate + D3 fast-tier parallel split ([4f6fbf4](https://github.com/tadki/godot-mcp/commit/4f6fbf4fab3084d05c398c6a56a5fe21f2019101))


### Code Refactoring

* restructure main — addon at repo root, drop upstream test/ (SEE-1268 T1) ([e649597](https://github.com/tadki/godot-mcp/commit/e6495971b49bf263758d4756c670ad023e511057))
* restructure main — addon at repo root, drop upstream test/ (SEE-1268 T1) ([91295ce](https://github.com/tadki/godot-mcp/commit/91295ceb3fe0a0f70579e168654e327443d6b4d9))

## [4.1.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v4.0.1...godot-mcp-v4.1.0) (2026-06-20)


### Features

* add godot_scene reload action to refresh an open scene from disk ([#334](https://github.com/satelliteoflove/godot-mcp/issues/334)) ([f592800](https://github.com/satelliteoflove/godot-mcp/commit/f592800704b17fae8842a9dd57f3ea3f0b649b6d))

## [4.0.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v4.0.0...godot-mcp-v4.0.1) (2026-06-14)


### Bug Fixes

* align tool annotation hints across the surface ([#325](https://github.com/satelliteoflove/godot-mcp/issues/325)) ([4892b01](https://github.com/satelliteoflove/godot-mcp/commit/4892b0152655af2fad9716c55257e22d1f3f2861))

## [4.0.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.23.1...godot-mcp-v4.0.0) (2026-06-13)


### ⚠ BREAKING CHANGES

* the godot_scene create action, the godot_node create/delete/attach_script/detach_script/connect_signal actions, and all MCP resources are removed. Create scenes and nodes by editing scene files directly, then verify with godot_node get_scene_tree (new action replacing the godot://scene/tree resource).

### Features

* v4 — align with current MCP best practice, shrink the surface ([#314](https://github.com/satelliteoflove/godot-mcp/issues/314)) ([75589bb](https://github.com/satelliteoflove/godot-mcp/commit/75589bbfa60127a008c5539410e956fe42c76683))

## [3.23.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.23.0...godot-mcp-v3.23.1) (2026-06-12)


### Bug Fixes

* runtime_state watch tracks game time, not wall clock ([#311](https://github.com/satelliteoflove/godot-mcp/issues/311)) ([9a30246](https://github.com/satelliteoflove/godot-mcp/commit/9a302468e0aebbf87f489480fc043b1a1adc7049))

## [3.23.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.22.0...godot-mcp-v3.23.0) (2026-06-12)


### Features

* godot_validate_meshes — detect silently corrupt procedural mesh data ([#309](https://github.com/satelliteoflove/godot-mcp/issues/309)) ([cf16893](https://github.com/satelliteoflove/godot-mcp/commit/cf16893dc9a17dd00774e258c2dd97d0441e0ec6))

## [3.22.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.21.1...godot-mcp-v3.22.0) (2026-06-11)


### Features

* tag usage log entries with the server version ([#306](https://github.com/satelliteoflove/godot-mcp/issues/306)) ([8958f9c](https://github.com/satelliteoflove/godot-mcp/commit/8958f9c9c5f17d3752a1d07fd99fde53bc439917))


### Bug Fixes

* make npm README links absolute and overhaul the GitHub-facing docs ([#305](https://github.com/satelliteoflove/godot-mcp/issues/305)) ([e64a0e0](https://github.com/satelliteoflove/godot-mcp/commit/e64a0e0d6707214287c791f0bdf1eacc29a3ee7b))

## [3.21.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.21.0...godot-mcp-v3.21.1) (2026-06-11)


### Bug Fixes

* emit schema-valid action examples and per-action descriptions in generated docs ([#301](https://github.com/satelliteoflove/godot-mcp/issues/301)) ([0fd2f17](https://github.com/satelliteoflove/godot-mcp/commit/0fd2f175cd634b4540af94b570cbed1a3464e53f)), closes [#287](https://github.com/satelliteoflove/godot-mcp/issues/287)

## [3.21.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.20.0...godot-mcp-v3.21.0) (2026-06-11)


### Features

* fair per-signal event budget + truncation visibility for the watch timeline ([#299](https://github.com/satelliteoflove/godot-mcp/issues/299)) ([9042db7](https://github.com/satelliteoflove/godot-mcp/commit/9042db7420374526b55c5e815247a8bbe8f23938))

## [3.20.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.19.0...godot-mcp-v3.20.0) (2026-06-10)


### Features

* surface 3D world nodes in the digest auto/fallback tier ([#297](https://github.com/satelliteoflove/godot-mcp/issues/297)) ([0e97d23](https://github.com/satelliteoflove/godot-mcp/commit/0e97d236997a8297e1368e37600c4d2c0c216cf3))

## [3.19.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.18.0...godot-mcp-v3.19.0) (2026-06-10)


### Features

* inject relative mouse-look (InputEventMouseMotion) for godot_input ([#295](https://github.com/satelliteoflove/godot-mcp/issues/295)) ([ce45467](https://github.com/satelliteoflove/godot-mcp/commit/ce45467d0d9d1be51256f8c01dcb3070aa3ea523))

## [3.18.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.17.0...godot-mcp-v3.18.0) (2026-06-10)


### Features

* inject raw keyboard keys and modifier combos ([#290](https://github.com/satelliteoflove/godot-mcp/issues/290)) ([#292](https://github.com/satelliteoflove/godot-mcp/issues/292)) ([da54660](https://github.com/satelliteoflove/godot-mcp/commit/da54660901101c09963ecc94b9485f1b0e747638))

## [3.17.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.16.0...godot-mcp-v3.17.0) (2026-06-10)


### Features

* joypad button, axis, and stick injection for input sequences and game-time steps ([#289](https://github.com/satelliteoflove/godot-mcp/issues/289)) ([19fa189](https://github.com/satelliteoflove/godot-mcp/commit/19fa1894a773a2ee1965cb93c1075fc884cabb92))

## [3.16.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.15.0...godot-mcp-v3.16.0) (2026-06-09)


### Features

* add opt-in signal event timeline to the runtime_state watch lifecycle ([#284](https://github.com/satelliteoflove/godot-mcp/issues/284)) ([903751a](https://github.com/satelliteoflove/godot-mcp/commit/903751a0b6be3713984c7a2af4cc1ab9f081b973))

## [3.15.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.14.0...godot-mcp-v3.15.0) (2026-06-09)


### Features

* add godot_exec to run GDScript in the running game for test scenario setup ([#282](https://github.com/satelliteoflove/godot-mcp/issues/282)) ([2531f61](https://github.com/satelliteoflove/godot-mcp/commit/2531f6193a24a223fec1c0d324729d47520328a9))

## [3.14.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.13.0...godot-mcp-v3.14.0) (2026-06-09)


### Features

* detect and report stale editor ProjectSettings after external project.godot edits ([#280](https://github.com/satelliteoflove/godot-mcp/issues/280)) ([e021ad6](https://github.com/satelliteoflove/godot-mcp/commit/e021ad688fd14668748531b0ee5e4451b0f0e420))

## [3.13.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.12.0...godot-mcp-v3.13.0) (2026-06-09)


### Features

* derive per-request command timeouts from a single-source cascade ([#278](https://github.com/satelliteoflove/godot-mcp/issues/278)) ([d500d30](https://github.com/satelliteoflove/godot-mcp/commit/d500d30bd7292d65f1afe6d3d2714541aca9ba3b))

## [3.12.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.11.0...godot-mcp-v3.12.0) (2026-06-09)


### Features

* capture frames mid-input-sequence for transient visuals ([#274](https://github.com/satelliteoflove/godot-mcp/issues/274)) ([d1a9061](https://github.com/satelliteoflove/godot-mcp/commit/d1a9061ed0eacad16bf2703f8584fcaa011e27e8))
* emit screenshots as lossless PNG instead of JPEG ([#275](https://github.com/satelliteoflove/godot-mcp/issues/275)) ([ad4af24](https://github.com/satelliteoflove/godot-mcp/commit/ad4af2465ddb4ca0247b651aa7fa92c50e33c354))

## [3.11.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.10.1...godot-mcp-v3.11.0) (2026-06-09)


### Features

* surface an effect signal on input sequence results ([#272](https://github.com/satelliteoflove/godot-mcp/issues/272)) ([7cf8a74](https://github.com/satelliteoflove/godot-mcp/commit/7cf8a74c5a1df8619512066eba3cd489a7ea108d))

## [3.10.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.10.0...godot-mcp-v3.10.1) (2026-06-09)


### Bug Fixes

* wait for game bridge readiness before injecting input ([#269](https://github.com/satelliteoflove/godot-mcp/issues/269)) ([ab1b998](https://github.com/satelliteoflove/godot-mcp/commit/ab1b998cac0254cf9760b15c01bc8568fe19608f))

## [3.10.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.9.0...godot-mcp-v3.10.0) (2026-06-09)


### Features

* add editor restart action to godot_editor ([#250](https://github.com/satelliteoflove/godot-mcp/issues/250)) ([#266](https://github.com/satelliteoflove/godot-mcp/issues/266)) ([700ba78](https://github.com/satelliteoflove/godot-mcp/commit/700ba78aa75cf4f8231b718a3971dd875416d348))
* add severity and incremental filtering to editor log messages ([#244](https://github.com/satelliteoflove/godot-mcp/issues/244)) ([#267](https://github.com/satelliteoflove/godot-mcp/issues/267)) ([3391bf5](https://github.com/satelliteoflove/godot-mcp/commit/3391bf59ff904b77ef5df2ac38a6b629fb2adf63))


### Bug Fixes

* protect active bridge client instead of replacing it ([#237](https://github.com/satelliteoflove/godot-mcp/issues/237)) ([#264](https://github.com/satelliteoflove/godot-mcp/issues/264)) ([899ba88](https://github.com/satelliteoflove/godot-mcp/commit/899ba88faa01ba52436fb5047cccc615e384ac1b))

## [3.9.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.8.0...godot-mcp-v3.9.0) (2026-06-08)


### Features

* step_until predicate stepping for godot_game_time ([#262](https://github.com/satelliteoflove/godot-mcp/issues/262)) ([ef4e909](https://github.com/satelliteoflove/godot-mcp/commit/ef4e909e38db72a3bf6780e51092a265867b8e6f))

## [3.8.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.7.1...godot-mcp-v3.8.0) (2026-06-08)


### Features

* game time control for high-latency agents ([#256](https://github.com/satelliteoflove/godot-mcp/issues/256)) ([08d5d89](https://github.com/satelliteoflove/godot-mcp/commit/08d5d89f7da101782b282e16e8728cf0aaf31b7d))


### Bug Fixes

* ship .uid sidecars so the addon's resource identity is stable ([#257](https://github.com/satelliteoflove/godot-mcp/issues/257)) ([ecc5396](https://github.com/satelliteoflove/godot-mcp/commit/ecc5396e2adc232db6c5b9fa16af50ac9aebb886))
* use ScriptBacktrace.get_frame_file for error frame capture ([#259](https://github.com/satelliteoflove/godot-mcp/issues/259)) ([3182e2c](https://github.com/satelliteoflove/godot-mcp/commit/3182e2c14bf3d334ed127736505c5a672c0e4611))

## [3.7.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.7.0...godot-mcp-v3.7.1) (2026-06-07)


### Bug Fixes

* **game-bridge:** keep processing while the scene tree is paused ([#253](https://github.com/satelliteoflove/godot-mcp/issues/253)) ([04cff1b](https://github.com/satelliteoflove/godot-mcp/commit/04cff1b31e400aeff9fe9802a11e3f86c6f73c2a)), closes [#238](https://github.com/satelliteoflove/godot-mcp/issues/238)
* **game-bridge:** release held actions before clearing the input-sequence queue ([#231](https://github.com/satelliteoflove/godot-mcp/issues/231)) ([a0aa7ab](https://github.com/satelliteoflove/godot-mcp/commit/a0aa7abe02700b65b6a57cce5dea0826e73c433f))
* release pipeline ignores addon-only commits ([#254](https://github.com/satelliteoflove/godot-mcp/issues/254)) ([fb1753e](https://github.com/satelliteoflove/godot-mcp/commit/fb1753eaf0225e0fe843d6ad410d2a54ee5fee46))

## [3.7.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.6.1...godot-mcp-v3.7.0) (2026-06-01)


### Features

* digest reaches autoload singletons via explicit paths ([#226](https://github.com/satelliteoflove/godot-mcp/issues/226)) ([3f815ed](https://github.com/satelliteoflove/godot-mcp/commit/3f815ed9d98211c35ba86e316dad66dead4b374b))


### Bug Fixes

* correct on-screen detection for 3D, 2D camera transforms, and SubViewports ([#229](https://github.com/satelliteoflove/godot-mcp/issues/229)) ([633ef72](https://github.com/satelliteoflove/godot-mcp/commit/633ef72f98ae3a3c858617099feb65addf5551d4)), closes [#200](https://github.com/satelliteoflove/godot-mcp/issues/200)

## [3.6.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.6.0...godot-mcp-v3.6.1) (2026-05-30)


### Bug Fixes

* reduce default screenshot max_width from 1024 to 900 ([#221](https://github.com/satelliteoflove/godot-mcp/issues/221)) ([2c15902](https://github.com/satelliteoflove/godot-mcp/commit/2c1590267057477f22c813c66a903bd3faf60b8f))

## [3.6.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.5.0...godot-mcp-v3.6.0) (2026-05-30)


### Features

* runtime_state tool (digest + state-over-time + selection tiers) ([#219](https://github.com/satelliteoflove/godot-mcp/issues/219)) ([a703aa8](https://github.com/satelliteoflove/godot-mcp/commit/a703aa8c0492e39fb776c95bea2a75e9f873f35d))

## [3.5.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.4.1...godot-mcp-v3.5.0) (2026-05-29)


### Features

* JPEG screenshots with quality param and 1024px default ([#217](https://github.com/satelliteoflove/godot-mcp/issues/217)) ([ebdf7d9](https://github.com/satelliteoflove/godot-mcp/commit/ebdf7d9f4515d7d26e0210f7426aa6bcbedce9d7))

## [3.4.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.4.0...godot-mcp-v3.4.1) (2026-05-29)


### Bug Fixes

* flatten discriminatedUnion schemas to satisfy MCP inputSchema constraints ([#214](https://github.com/satelliteoflove/godot-mcp/issues/214)) ([333dadf](https://github.com/satelliteoflove/godot-mcp/commit/333dadf815a8e0928e4e7d70fd47b07e352f2fd6))

## [3.4.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.3.1...godot-mcp-v3.4.0) (2026-05-29)


### Features

* emit structuredContent for query actions ([#190](https://github.com/satelliteoflove/godot-mcp/issues/190)) ([#212](https://github.com/satelliteoflove/godot-mcp/issues/212)) ([a4bb209](https://github.com/satelliteoflove/godot-mcp/commit/a4bb2093a3b23c78a77d12ce42296985b00d91cb))

## [3.3.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.3.0...godot-mcp-v3.3.1) (2026-05-29)


### Performance Improvements

* compact JSON in tool query responses ([#189](https://github.com/satelliteoflove/godot-mcp/issues/189)) ([#210](https://github.com/satelliteoflove/godot-mcp/issues/210)) ([7323935](https://github.com/satelliteoflove/godot-mcp/commit/732393541f1f3ff0359f3d0e969260e86386a708))

## [3.3.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.2.0...godot-mcp-v3.3.0) (2026-05-29)


### Features

* model tool inputs as discriminated unions per action ([#208](https://github.com/satelliteoflove/godot-mcp/issues/208)) ([aec7248](https://github.com/satelliteoflove/godot-mcp/commit/aec72485fd7e1c498a943759c8aa6ba54f7d16f8))

## [3.2.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.1.0...godot-mcp-v3.2.0) (2026-05-29)


### Features

* add MCP tool annotations (title + readOnly/destructive/openWorld hints) ([#206](https://github.com/satelliteoflove/godot-mcp/issues/206)) ([e6f1089](https://github.com/satelliteoflove/godot-mcp/commit/e6f10890d8634d03e03fcaaa45fc68b1d22f7daf))

## [3.1.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v3.0.0...godot-mcp-v3.1.0) (2026-05-29)


### Features

* namespace all tools under godot_ prefix ([#203](https://github.com/satelliteoflove/godot-mcp/issues/203)) ([778867e](https://github.com/satelliteoflove/godot-mcp/commit/778867ee864e3af44c31358904e52d04cded2157))

## [3.0.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.18.0...godot-mcp-v3.0.0) (2026-05-29)


### ⚠ BREAKING CHANGES

* **editor:** the editor tool no longer accepts the actions get_debug_output, get_errors, or get_performance.

### Features

* **editor:** remove deprecated debug/errors/performance actions ([#193](https://github.com/satelliteoflove/godot-mcp/issues/193)) ([4a01224](https://github.com/satelliteoflove/godot-mcp/commit/4a01224d31177e13024771e73b83e842c05be2f6))

## [2.18.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.17.0...godot-mcp-v2.18.0) (2026-03-30)


### Features

* upgrade to TypeScript 6.0.2 ([#170](https://github.com/satelliteoflove/godot-mcp/issues/170)) ([8d394a6](https://github.com/satelliteoflove/godot-mcp/commit/8d394a6a5a641533391c75c39b1b5156ee0241e3))

## [2.17.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.16.1...godot-mcp-v2.17.0) (2026-03-27)


### Features

* frame profiler with time-series analysis ([#163](https://github.com/satelliteoflove/godot-mcp/issues/163)) ([ab9bfd3](https://github.com/satelliteoflove/godot-mcp/commit/ab9bfd33ec2eb5abf57120e3be51671f20c06048))

## [2.16.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.16.0...godot-mcp-v2.16.1) (2026-03-13)


### Bug Fixes

* graceful shutdown and connection replacement for zombie server processes ([#161](https://github.com/satelliteoflove/godot-mcp/issues/161)) ([dd1abe1](https://github.com/satelliteoflove/godot-mcp/commit/dd1abe182d194599295ca954fb2722d31ee7adc9)), closes [#157](https://github.com/satelliteoflove/godot-mcp/issues/157)

## [2.16.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.15.0...godot-mcp-v2.16.0) (2026-03-09)


### Features

* detect and clean up stale WebSocket connections ([#158](https://github.com/satelliteoflove/godot-mcp/issues/158)) ([a0e7809](https://github.com/satelliteoflove/godot-mcp/commit/a0e7809c3ffc9fb01e29eec4bbf35fa491d30a92))

## [2.15.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.14.0...godot-mcp-v2.15.0) (2026-02-06)


### Features

* deprecate get_debug_output in favor of minimal-godot-mcp ([#149](https://github.com/satelliteoflove/godot-mcp/issues/149)) ([684ce7b](https://github.com/satelliteoflove/godot-mcp/commit/684ce7be4731c09e437e74dc7fa97f5e11d1669e))

## [2.14.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.13.0...godot-mcp-v2.14.0) (2026-02-02)


### Features

* migrate to Zod v4 ([#147](https://github.com/satelliteoflove/godot-mcp/issues/147)) ([04864ef](https://github.com/satelliteoflove/godot-mcp/commit/04864ef76f7eca1bd953cc9d76933dd00e089edb))

## [2.13.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.12.2...godot-mcp-v2.13.0) (2026-01-29)


### Features

* add local usage logging for tool analytics ([#139](https://github.com/satelliteoflove/godot-mcp/issues/139)) ([ce54957](https://github.com/satelliteoflove/godot-mcp/commit/ce54957598a923d43a4453db392163f650acc5c7))

## [2.12.2](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.12.1...godot-mcp-v2.12.2) (2026-01-28)


### Bug Fixes

* add explicit timeout error formatting and remove last-release-sha ([#136](https://github.com/satelliteoflove/godot-mcp/issues/136)) ([75ba4ec](https://github.com/satelliteoflove/godot-mcp/commit/75ba4ec402724028f77dec6afeadf27f28947336))

## [2.12.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.12.0...godot-mcp-v2.12.1) (2026-01-28)


### Bug Fixes

* use proper semver comparison for addon version checks ([#117](https://github.com/satelliteoflove/godot-mcp/issues/117)) ([d1f1721](https://github.com/satelliteoflove/godot-mcp/commit/d1f1721624af6b39441af60211d89cafd627d3b9)), closes [#116](https://github.com/satelliteoflove/godot-mcp/issues/116)

## [2.12.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.11.1...godot-mcp-v2.12.0) (2026-01-28)


### Features

* Add Windows Subsystem for Linux (WSL) support with smart network binding ([#111](https://github.com/satelliteoflove/godot-mcp/issues/111)) ([129205e](https://github.com/satelliteoflove/godot-mcp/commit/129205eca12365cc61f9ad9acf5becf27f5f0e79))

## [2.11.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.11.0...godot-mcp-v2.11.1) (2026-01-28)


### Bug Fixes

* sync npm README from root instead of hardcoded template ([6b4a099](https://github.com/satelliteoflove/godot-mcp/commit/6b4a099bfa295dbc246dd406d1af13167d964904))
* sync npm README from root instead of hardcoded template ([5dd01a2](https://github.com/satelliteoflove/godot-mcp/commit/5dd01a2810809f0b631ec0d04f98136cbea9d67e))

## [2.11.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.10.1...godot-mcp-v2.11.0) (2026-01-26)


### Features

* add get_log_messages action with filter and limit support ([#108](https://github.com/satelliteoflove/godot-mcp/issues/108)) ([107ad19](https://github.com/satelliteoflove/godot-mcp/commit/107ad1903e3819c9d3dde206125e2fd076221b57))

## [2.10.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.10.0...godot-mcp-v2.10.1) (2026-01-26)


### Bug Fixes

* document clear parameter support for get_errors action ([#105](https://github.com/satelliteoflove/godot-mcp/issues/105)) ([2303f05](https://github.com/satelliteoflove/godot-mcp/commit/2303f05d380c3548bb7ff3df8f19629159315a74))

## [2.10.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.9.0...godot-mcp-v2.10.0) (2026-01-25)


### Features

* add input injection tool for testing running games ([#102](https://github.com/satelliteoflove/godot-mcp/issues/102)) ([7444f23](https://github.com/satelliteoflove/godot-mcp/commit/7444f23c39dffd505f63495494dc566c91457007))

## [2.9.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.8.0...godot-mcp-v2.9.0) (2026-01-24)


### Features

* add get_errors and get_stack_trace actions to editor tool ([#99](https://github.com/satelliteoflove/godot-mcp/issues/99)) ([9b24dbe](https://github.com/satelliteoflove/godot-mcp/commit/9b24dbe0e076d421ca274696bc494830f8c449b9)), closes [#98](https://github.com/satelliteoflove/godot-mcp/issues/98)

## [2.8.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.7.0...godot-mcp-v2.8.0) (2026-01-24)


### Features

* add signal connection support to node tool ([#96](https://github.com/satelliteoflove/godot-mcp/issues/96)) ([5ff874d](https://github.com/satelliteoflove/godot-mcp/commit/5ff874d73c04978b63c5bf2c0fe83ba5fa91e9c2)), closes [#89](https://github.com/satelliteoflove/godot-mcp/issues/89)

## [2.7.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.6.3...godot-mcp-v2.7.0) (2026-01-24)


### Features

* add source parameter to get_debug_output for editor vs game output ([#94](https://github.com/satelliteoflove/godot-mcp/issues/94)) ([e3c67b4](https://github.com/satelliteoflove/godot-mcp/commit/e3c67b4314c7c68da96e6c11fa41bf44a065e5e7)), closes [#91](https://github.com/satelliteoflove/godot-mcp/issues/91)

## [2.6.3](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.6.2...godot-mcp-v2.6.3) (2026-01-24)


### Bug Fixes

* return generated UID from scene create action ([#92](https://github.com/satelliteoflove/godot-mcp/issues/92)) ([49940cd](https://github.com/satelliteoflove/godot-mcp/commit/49940cd165212eda7637cd34d1ceeb54f2c4bbbe)), closes [#90](https://github.com/satelliteoflove/godot-mcp/issues/90)

## [2.6.2](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.6.1...godot-mcp-v2.6.2) (2026-01-17)


### Bug Fixes

* use dynamic import for MCP server to fix npx stdin issue ([#87](https://github.com/satelliteoflove/godot-mcp/issues/87)) ([5bbaeda](https://github.com/satelliteoflove/godot-mcp/commit/5bbaedaca819af25a925dd8be57f9899e13c0e0f))

## [2.6.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.6.0...godot-mcp-v2.6.1) (2026-01-17)


### Bug Fixes

* prevent CLI commands from spawning unwanted WebSocket connections ([#85](https://github.com/satelliteoflove/godot-mcp/issues/85)) ([404b09d](https://github.com/satelliteoflove/godot-mcp/commit/404b09d91e4e801800e8a4fdace2fa50f9d5b89b))

## [2.6.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.5.3...godot-mcp-v2.6.0) (2026-01-17)


### Features

* replace ad-hoc logging with proper MCP protocol and centralized addon logging ([#83](https://github.com/satelliteoflove/godot-mcp/issues/83)) ([cf1b7e4](https://github.com/satelliteoflove/godot-mcp/commit/cf1b7e4823b64fe3548d4d5e04d2a2ef9002cafb))

## [2.5.3](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.5.2...godot-mcp-v2.5.3) (2026-01-17)


### Bug Fixes

* remove dead code and improve error handling ([#79](https://github.com/satelliteoflove/godot-mcp/issues/79)) ([c283118](https://github.com/satelliteoflove/godot-mcp/commit/c28311838399bd409a75e87c15eea98fd22b1556))

## [2.5.2](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.5.1...godot-mcp-v2.5.2) (2026-01-17)


### Bug Fixes

* reject concurrent connections and provide diagnostic error context ([#76](https://github.com/satelliteoflove/godot-mcp/issues/76)) ([76ebfe5](https://github.com/satelliteoflove/godot-mcp/commit/76ebfe5f4cf3afca5d4a3beacdce0b87fa482332))

## [2.5.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.5.0...godot-mcp-v2.5.1) (2026-01-05)


### Bug Fixes

* use scene-relative paths instead of full editor paths ([#72](https://github.com/satelliteoflove/godot-mcp/issues/72)) ([da3d18a](https://github.com/satelliteoflove/godot-mcp/commit/da3d18a2850d6f03fda770dbfadf16abdc283b5b))

## [2.5.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.4.2...godot-mcp-v2.5.0) (2026-01-05)


### Features

* add godot_docs tool for fetching Godot documentation ([#70](https://github.com/satelliteoflove/godot-mcp/issues/70)) ([14b418d](https://github.com/satelliteoflove/godot-mcp/commit/14b418d4d23d426f9a47c46e85acf3b453eb0e58))

## [2.4.2](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.4.1...godot-mcp-v2.4.2) (2026-01-05)


### Bug Fixes

* update README and add missing scene3d to docs ([#68](https://github.com/satelliteoflove/godot-mcp/issues/68)) ([c56cec4](https://github.com/satelliteoflove/godot-mcp/commit/c56cec4c66d6699d8b3b0d5a4915549fd36847d1))

## [2.4.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.4.0...godot-mcp-v2.4.1) (2026-01-04)


### Bug Fixes

* improve find_nodes reliability and DRY cleanup ([#66](https://github.com/satelliteoflove/godot-mcp/issues/66)) ([adcef21](https://github.com/satelliteoflove/godot-mcp/commit/adcef219629bb4ba9e887d1a5e9d865dbcab1b27))

## [2.4.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.3.0...godot-mcp-v2.4.0) (2026-01-04)


### Features

* add CLI addon installer and version handshake ([#64](https://github.com/satelliteoflove/godot-mcp/issues/64)) ([43c1779](https://github.com/satelliteoflove/godot-mcp/commit/43c1779bcb0e719689df02fe3c5a6d5b8a8139bf))

## [2.3.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.2.0...godot-mcp-v2.3.0) (2026-01-04)


### Features

* add viewport/camera info and 2D viewport control ([#61](https://github.com/satelliteoflove/godot-mcp/issues/61)) ([09d20c9](https://github.com/satelliteoflove/godot-mcp/commit/09d20c9a85e9f84cf27b75a6f0747b0c6d9ce444))

## [2.2.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.1.0...godot-mcp-v2.2.0) (2026-01-04)


### Features

* add scene3d tool for 3D spatial queries ([#59](https://github.com/satelliteoflove/godot-mcp/issues/59)) ([23294f8](https://github.com/satelliteoflove/godot-mcp/commit/23294f8e524b7420adf7c85228b4f018112d4d78))

## [2.1.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.0.3...godot-mcp-v2.1.0) (2026-01-01)


### Features

* enhance editor.get_state with open_scenes and main_screen ([#56](https://github.com/satelliteoflove/godot-mcp/issues/56)) ([3124b28](https://github.com/satelliteoflove/godot-mcp/commit/3124b28d48c91161e0ad3576b5299888df390a2b))

## [2.0.3](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.0.2...godot-mcp-v2.0.3) (2025-12-31)


### Bug Fixes

* version sync, addon releases, and installation instructions ([6089337](https://github.com/satelliteoflove/godot-mcp/commit/6089337976b9ef9703a5249e3803049a46e6b9a7))

## [2.0.2](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.0.1...godot-mcp-v2.0.2) (2025-12-30)


### Bug Fixes

* sync npm README with documentation generation system


## [2.0.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v2.0.0...godot-mcp-v2.0.1) (2025-12-30)


### Bug Fixes

* republish to npm (2.0.0 version number was burned due to publish/unpublish)


### Documentation

* improve documentation generation with full enum values, action-specific requirements, and examples


## [2.0.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v1.3.0...godot-mcp-v2.0.0) (2025-12-30)


### ⚠ BREAKING CHANGES

* Tool API has changed significantly. All tools now use action-based schemas instead of separate tool definitions.

### Code Refactoring

* consolidate MCP tools from 34 to 10 for reduced token usage ([#42](https://github.com/satelliteoflove/godot-mcp/issues/42)) ([a6eb815](https://github.com/satelliteoflove/godot-mcp/commit/a6eb815f16b70b13e0d2220019bbeb5e19172b49))

## [1.3.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v1.2.0...godot-mcp-v1.3.0) (2025-12-29)


### Features

* auto-generate README sections from tool definitions ([#37](https://github.com/satelliteoflove/godot-mcp/issues/37)) ([e823e46](https://github.com/satelliteoflove/godot-mcp/commit/e823e46e2c7e892fdda9e2bf8370bb3dd415139e))

## [1.2.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v1.1.1...godot-mcp-v1.2.0) (2025-12-29)


### Features

* add get_resource_info tool for inspecting Godot resources ([#35](https://github.com/satelliteoflove/godot-mcp/issues/35)) ([a0c94e2](https://github.com/satelliteoflove/godot-mcp/commit/a0c94e23825b65e345bd0249a41a6a4fcfc9fb6a))

## [1.1.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v1.1.0...godot-mcp-v1.1.1) (2025-12-22)


### Bug Fixes

* update vitest to 4.x to resolve security vulnerabilities ([#31](https://github.com/satelliteoflove/godot-mcp/issues/31)) ([ef3ff00](https://github.com/satelliteoflove/godot-mcp/commit/ef3ff000c0061dec7021fe7a2376ba6d54bcb977))

## [1.1.0](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v1.0.0...godot-mcp-v1.1.0) (2025-12-22)


### Features

* scene building enhancements and input mappings ([#27](https://github.com/satelliteoflove/godot-mcp/issues/27)) ([3ecf4af](https://github.com/satelliteoflove/godot-mcp/commit/3ecf4af2ecc0b65aa94ec13f4c61c3c59572132f))

## [0.1.6](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v0.1.5...godot-mcp-v0.1.6) (2025-12-21)


### Features

* add automatic API documentation generation ([#17](https://github.com/satelliteoflove/godot-mcp/issues/17)) ([ba25315](https://github.com/satelliteoflove/godot-mcp/commit/ba253151513199cfdc2fecc1072602a9b8d0b02a))

## [0.1.5](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v0.1.4...godot-mcp-v0.1.5) (2025-12-21)


### Bug Fixes

* improve edge case error handling ([#10](https://github.com/satelliteoflove/godot-mcp/issues/10)) ([8f4ae6a](https://github.com/satelliteoflove/godot-mcp/commit/8f4ae6abe46b1b294a324d9181b78d39721930bd))

## [0.1.4](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v0.1.3...godot-mcp-v0.1.4) (2025-12-21)


### Features

* add TileMapLayer and GridMap editing support ([#8](https://github.com/satelliteoflove/godot-mcp/issues/8)) ([3fa5180](https://github.com/satelliteoflove/godot-mcp/commit/3fa518048c9a17a1f849b7b225148c4defe93733))

## [0.1.3](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v0.1.2...godot-mcp-v0.1.3) (2025-12-21)


### Features

* add AnimationPlayer support with full read/write capability ([#6](https://github.com/satelliteoflove/godot-mcp/issues/6)) ([b99006b](https://github.com/satelliteoflove/godot-mcp/commit/b99006b6f537c7808de838ec9feb4475b9d2bb50))

## [0.1.2](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v0.1.1...godot-mcp-v0.1.2) (2025-12-21)


### Features

* add screenshot capture tools ([9f57fdb](https://github.com/satelliteoflove/godot-mcp/commit/9f57fdb94cb26c1e24b031a4996bb208eea37012))

## [0.1.1](https://github.com/satelliteoflove/godot-mcp/compare/godot-mcp-v0.1.0...godot-mcp-v0.1.1) (2025-12-21)


### Features

* add CI/CD with GitHub Actions and release-please ([7c22039](https://github.com/satelliteoflove/godot-mcp/commit/7c22039c75080661fe5da26e14e3845342f8d1d4))
* initial implementation of godot-mcp ([75f23a8](https://github.com/satelliteoflove/godot-mcp/commit/75f23a8794858c828f29aaec874f0fd4290aa3da))


### Bug Fixes

* rename get_script to read_script to avoid Godot builtin conflict ([f2af378](https://github.com/satelliteoflove/godot-mcp/commit/f2af3785ac970000ed0c73b4801bdc7fb04b4eec))
