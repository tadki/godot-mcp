# GD guard fixture (SEE-1348 §SPEC-016)

Resident minimal Godot project hosting GUT guard tests for the game_bridge GD
surface (mcp_qa.gd, mcp_runtime_state_sampler.gd). `gqt mutation` /
`gqt coverage --project-root tests/gd` run directly against the godot-mcp repo.

- `addons/gut/` — vendored GUT (third-party open-source test framework; the
  ONLY dependency inside this fixture; zero KingOfLikes code or paths).
- `game_bridge/` — SYMLINK-JUNCTION-FREE copies are NOT used: tests load the
  production sources via `../game_bridge` relative preload (no duplication —
  the single source of truth stays in game_bridge/).
- `tests/gut/` — GUT suites.

Run (one line):
  gqt mutation game_bridge/mcp_qa.gd game_bridge/mcp_runtime_state_sampler.gd \
      --project-root tests/gd --tests res://tests/gut

The .godot cache inside this dir is gitignored (generated on first import).
