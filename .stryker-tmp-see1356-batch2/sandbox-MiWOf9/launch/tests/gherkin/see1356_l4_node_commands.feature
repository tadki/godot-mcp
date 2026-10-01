Feature: SEE-1356 L4 scene-structure write commands (§SPEC-L4-01)
  # connect_signal RE-ENABLED (Owner 2026-10-01 终局指示): registered again in
  # get_commands() and node.ts; the gd-faces N1 pin asserts the full registry
  # and the N9 direct-write CONNECT_PERSIST shape. The live three-step
  # persistence gate is Revy's 实机完整 QA lane (§SPEC-L4-02).
  Scenario: add_node/attach_script/connect_signal pure decision faces (re-enabled)
    Given the SEE-1356 batch-2 gd-faces harness in the launch test tree
    When the harness runs the node_commands face against the current tree
    Then the node_commands face reports zero failures
