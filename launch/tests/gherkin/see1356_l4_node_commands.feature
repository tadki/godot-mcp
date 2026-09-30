Feature: SEE-1356 L4 scene-structure write commands (§SPEC-L4-01)
  Scenario: add_node/attach_script/connect_signal pure decision faces
    Given the SEE-1356 batch-2 gd-faces harness in the launch test tree
    When the harness runs the node_commands face against the current tree
    Then the node_commands face reports zero failures
