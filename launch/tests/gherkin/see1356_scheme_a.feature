Feature: SEE-1356 方案A undo/redo + set_main_screen commands (Owner 2026-10-01 终裁)
  Scenario: undo/redo registration and same-stack contract faces
    Given the SEE-1356 batch-2 gd-faces harness in the launch test tree
    When the harness runs the node_commands face against the current tree
    Then the node_commands face reports zero failures
  Scenario: main-screen switch registration face
    Given the SEE-1356 batch-2 gd-faces harness in the launch test tree
    When the harness runs the capture face against the current tree
    Then the capture face reports zero failures

  Scenario: D-SCRIPT read-side WindowWrapper drill-down (Script screen decidable)
    Given the SEE-1356 batch-2 gd-faces harness in the launch test tree
    When the harness runs the node_commands face against the current tree
    Then the node_commands face reports zero failures
