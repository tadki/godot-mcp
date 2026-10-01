@gprotocol
Feature: B1 lazy-load — editor 拉起延迟到首个 tools/call
  SEE-1085 B1：MCP 握手永远秒回（不依赖编辑器），首个 tools/call 触发
  configure+start 各一次；调用在 WARM 前被 FIFO 持有，WARM 后 flush 到
  npx 并应答（SEE-1111 hold-to-warm）。全部协议层 mock 可复现。

  Scenario: initialize 秒回且不触碰生成链路
    When a proxy with counting spawn seams starts on a free port
    Then initialize is answered without spawning the editor

  Scenario: 首个 tools/call 生成编辑器各恰好一次
    When a proxy with counting spawn seams starts on a free port
    And the first tools/call spawns the editor exactly once
    Then the held call is flushed after WARM and answered
