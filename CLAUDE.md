# godot-mcp 编码规范（Agent 指引）

本库定位为独立 runtime library（无 KingOfLikes 业务概念）。本文件约束在本库内写代码（生产与测试）时的同步等待方式。

## 同步等待：事件驱动优先，禁止固定 sleep

**规则**：生产与测试代码中，凡需等待某件事发生（进程就绪、状态落盘、日志出现、连接建立、资源释放），必须使用事件驱动等待——就绪握手、目标日志行出现、pipe/信号、带上限的 predicate 轮询。**禁止以固定 `sleep N` 作为同步等待手段。**

**Rationale**：固定 sleep 用真实时钟赌完成时机——sleep 过短则 flake（慢机器上条件未成立即断言），过长则白烧时长；在严格串行的测试层（`launch/vitest.config.ts` `fileParallelism: false`）里，每个 `sleep N` 都全额计入总时长。SEE-1340 实测确认：真实时钟等待集中出现在头部最慢的 harness 中，是串行测试时长与 flake 的直接来源。

**正例**（按优先级）：

1. 就绪握手：被等待方显式通知——子进程退出码、stdout/stderr 上的 stage 标记（如 `[stage=...]` 行）、文件 rename 发布（写 tmp → rename 原子可见）。
2. 日志行/输出出现：readline 订阅目标输出流，命中模式即继续（如 shim 测试对 `SHIM_ANSWER_*` 行的等待）。
3. pipe/信号：进程间用管道 EOF、`SIGCHLD`、`kill -0` 探活等内核事件。
4. predicate 轮询上限：确无事件可订阅时，允许带**上限预算**的短间隔轮询（如 `until <cond>; sleep 0.2; done`，总预算受 `timeout` 约束），并在超时时报出诊断信息——轮询间隔远小于被等事件的典型延迟，预算上限保证最坏情况有界。

**反例**（均为本库已消除或在途消除的模式，新代码禁止引入）：

- `sleep 3; assert <cond>`——赌 3 秒内条件成立：慢机器 flake，快机器白等。
- 循环外固定 `sleep N` 模拟"等异步清理完成"——应等待该清理的完成信号（日志行/退出码/pidfile 消失）。
- 无上限的 `while ! cond; sleep 1; done`——必须配 `timeout` 预算与失败诊断。

**边界**：测试中"等一个必然发生的固定延迟"本身是被测语义时（如竞态窗口复现、超时路径的触发），固定 sleep 允许保留，但须注释标明其语义角色，并使总预算受该 harness 的 timeout 约束。
