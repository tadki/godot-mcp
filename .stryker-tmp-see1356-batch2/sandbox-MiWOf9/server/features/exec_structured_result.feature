# godot_exec 结构化返回（M2，§SPEC-003）
# exec 返回值从"str() 截断 200 字符"升级为递归 JSON 序列化。
# 协议层走 mock npx：响应 envelope 由 proxy 透传，断言只看
# result/result_repr/result_truncated 字段形状。
# fixture 名定义（protocol_steps.ts）：
#   flat-dict -> {"hp":100,"pos":{"x":1,"y":2}}   array -> {"k":[1,2,3]}   ok -> {"ok":true}
Feature: godot_exec 结构化 JSON 返回 + result_repr 过渡（SEE-1348 WP5 §SPEC-003）

  Scenario: 平面 dict 完整结构化返回
    Given a warm proxy session
    When the mock npx answers exec_run with the "flat-dict" exec fixture
    Then the exec response result matches the "flat-dict" exec fixture
    And the exec response carries result_repr as a string

  Scenario: result_repr 恒为字符串（旧消费契约不回退）
    Given a warm proxy session
    When the mock npx answers exec_run with the "array" exec fixture
    Then the exec response carries result_repr as a string

  Scenario: result_truncated 仅在双闸/字节闸触发时出现
    Given a warm proxy session
    When the mock npx answers exec_run with the "ok" exec fixture and truncated "depth"
    Then the exec response carries result_truncated "depth"

  Scenario: 无截断时不含 result_truncated 字段
    Given a warm proxy session
    When the mock npx answers exec_run with the "ok" exec fixture
    Then the exec response does not carry result_truncated
