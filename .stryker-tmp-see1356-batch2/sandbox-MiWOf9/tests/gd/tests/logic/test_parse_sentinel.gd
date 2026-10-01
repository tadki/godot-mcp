extends GutTest

## SEE-1348 §SPEC-016 sentinel: if a mutation (or any edit) makes a guarded
## production file unparseable, dependent test scripts silently vanish from the run
## and every mutant counts "survived". This sentinel loads each guarded file
## directly — a parse failure fails THIS test, restoring kill-detection.
const GUARDED := [
	"res://game_bridge/mcp_qa.gd",
	"res://game_bridge/mcp_runtime_state_sampler.gd",
]

func test_guarded_files_parse() -> void:
	for path in GUARDED:
		var s: GDScript = load(path)
		assert_true(s != null and s.can_instantiate(), "parses + instantiates: " + path)
