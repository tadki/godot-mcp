@gprotocol
Feature: 单客户端独占拒绝（WS 4001）
  addon 单 WS 槽（websocket_server.gd）：第一客户端握手成功后独占槽位；
  第二客户端被 WS close code 4001 拒绝（SEE-1110 §4.2 rejected_4001 子态）。
  协议层 mock 编辑器复现 wire 行为，并绑定 proxy 侧 errors.mjs 分类器的
  editor_busy 可重试语义。

  Scenario: 第二客户端被 4001 拒绝
    Given a single-client mock editor listening on port 6601
    When the first client connects
    And the first client holds the single slot
    When a second client attempts to connect
    Then the second client is rejected with close code 4001
    And the proxy-side classifier maps the 4001 wire text to a retryable editor_busy diagnostic
