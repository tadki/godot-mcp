@gprotocol
Feature: exec 约束拦截（SEE-1240 WS-6 SSOT）
  godot_exec 报错预检：违反 denylist 的 source 在 proxy 侧被 in-band 拒绝
  并点名违反条目，永不透传到 fork/addon；await 触发 SYNC_ONLY；
  action:help 由 proxy 供给完整约束摘要。

  Scenario: 禁用 token 被 in-band 拒绝并点名
    Given a warm proxy session
    When the agent calls godot_exec with source "OS.kill(1234)"
    Then the response names the violated constraint "OS.kill"
    And the call never reached the mock npx (in-band interception)

  Scenario: await 拒绝为 SYNC_ONLY
    Given a warm proxy session
    When the agent calls godot_exec with source "await tree.get_nodes_in_group('e')"
    Then the response names the violated constraint "SYNC_ONLY:"

  Scenario: help 返回完整 SSOT 约束摘要
    Given a warm proxy session
    When the agent calls godot_exec with action help
    Then the response carries the full SSOT constraint digest
