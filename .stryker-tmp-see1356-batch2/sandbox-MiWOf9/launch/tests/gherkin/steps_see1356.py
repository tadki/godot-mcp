"""SEE-1356 L7 harness steps — drives the launch-tree bash harness.

The bash harness (launch/tests/scripts/test_see1356_l7_seed_layout.sh) is
the single source of truth for the fixture semantics; the steps only give
the DoD command (`gqt gherkin`) a machine-checkable wrapper over it.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from godot_qa_toolkit.gherkin.runner import Registry, StepFailure

_HARNESS = Path(__file__).resolve().parents[2] / "tests" / "scripts" / "test_see1356_l7_seed_layout.sh"


def register(registry: Registry) -> None:
    state: dict[str, object] = {}

    @registry.step("the SEE-1356 L7 harness script in the launch test tree")
    def _given_harness(_params: dict[str, str]) -> None:
        if not _HARNESS.is_file():
            raise StepFailure(reason="harness script missing", detail=str(_HARNESS))

    @registry.step("the harness runs against mock seed-<id12> fixtures")
    def _when_harness(_params: dict[str, str]) -> None:
        r = subprocess.run(
            ["bash", str(_HARNESS)],
            capture_output=True,
            text=True,
            timeout=180,
        )
        state["rc"] = r.returncode
        state["stdout"] = r.stdout
        state["stderr_tail"] = r.stderr[-2000:]

    @registry.step("the harness reports zero failures across all groups")
    def _then_zero_failures(_params: dict[str, str]) -> None:
        out = str(state.get("stdout", ""))
        if "FAIL=0" not in out:
            raise StepFailure(
                reason="L7 harness reported failures",
                detail=out.strip().splitlines()[-1] if out.strip() else "(no output)",
                stderr_tail=str(state.get("stderr_tail", "")),
            )
        if int(state.get("rc", 1)) != 0:
            raise StepFailure(reason="harness exit code nonzero", detail=f"rc={state.get('rc')}")
