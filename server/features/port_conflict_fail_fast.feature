@gprotocol
Feature: 端口被占 fail-fast 带诊断
  当分配端口被另一个 runtime 的活 holder 占用时，proxy 必须 fail-fast
  （不启动生成链路）并在-band 拒绝持有调用，回报可重试的 editor_busy 诊断
  （arbiter → busy_foreign 分支，SEE-1148 B 树）。

  Scenario: 端口被活 holder 占用 → in-band editor_busy，零生成
    Given the editor port 6599 is held by a live foreign runtime
    When a proxy of ours starts on that port and receives the first tools/call
    Then the call is answered in-band with a retryable editor_busy diagnostic
    And no editor spawn ran on the occupied port (fail-fast)
