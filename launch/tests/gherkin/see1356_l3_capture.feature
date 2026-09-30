Feature: SEE-1356 L3 段1 capture format normalization (§SPEC-L3-02)
  Scenario: addon capture classification on headless-probeable pure helpers
    Given the SEE-1356 batch-2 gd-faces harness in the launch test tree
    When the harness runs the capture face against the current tree
    Then the capture face reports zero failures
