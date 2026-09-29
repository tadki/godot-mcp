Feature: SEE-1356 L7 seed-* layout regression harness
  Scenario: three assertion groups on double-layout fixtures
    Given the SEE-1356 L7 harness script in the launch test tree
    When the harness runs against mock seed-<id12> fixtures
    Then the harness reports zero failures across all groups
