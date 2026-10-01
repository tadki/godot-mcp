@gprotocol
Feature: 截图契约（SEE-1240 WS-3 C3/C4 + D3）
  成功截图响应必须携带帧龄元数据块（_screenshot：captured_at_ms /
  capture_latency_ms / auto_step / stale），并把全分辨率 PNG 落盘到
  exports（宽度×高度以磁盘 PNG 头为准）；调用方传入 max_width 时，
  磁盘帧超宽即违规（D3 判据）。

  Scenario: 成功捕获携带帧元数据 + 全分辨率导出
    Given a warm proxy session
    And the mock editor answers capture_game_screenshot with a PNG of width 64 height 48
    When the agent calls capture_game_screenshot
    Then the response carries a _screenshot block with capture metadata
    And the full-resolution export lands on disk with the PNG header dimensions

  Scenario: 磁盘帧宽于 max_width 时宽×高检查违规（D3）
    Given a warm proxy session
    And the mock editor answers capture_game_screenshot with a PNG of width 64 height 48
    When the agent calls capture_game_screenshot with max_width 16
    Then the width×height check fails on the oversized on-disk frame
