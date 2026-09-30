Feature: SEE-1356 L4 scene-structure write commands (§SPEC-L4-01)
  # connect_signal is SHELVED (SEE-1356 终裁: binary gate unproven across two
  # live rounds) — removed from the delivery surface; the gd-faces N1 pin
  # asserts its registry absence until the gate is proven for re-enable.
  Scenario: add_node/attach_script pure decision faces (connect_signal shelved)
    Given the SEE-1356 batch-2 gd-faces harness in the launch test tree
    When the harness runs the node_commands face against the current tree
    Then the node_commands face reports zero failures
