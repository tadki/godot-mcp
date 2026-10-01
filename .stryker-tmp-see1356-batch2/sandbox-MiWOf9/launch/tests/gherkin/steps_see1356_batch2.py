"""SEE-1356 batch-2 gherkin steps — drive the .gd face harness.

The bash harness (launch/tests/scripts/test_see1356_batch2_gd_faces.sh) is the
single source of truth for the face semantics; these steps only give the DoD
command (`gqt gherkin`) a machine-checkable wrapper over it, one feature per
face (L3 capture / L4 node_commands).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from godot_qa_toolkit.gherkin.runner import Registry, StepFailure

_HARNESS = Path(__file__).resolve().parents[2] / "tests" / "scripts" / "test_see1356_batch2_gd_faces.sh"


def register(registry: Registry) -> None:
    state: dict[str, object] = {}

    @registry.step("the SEE-1356 batch-2 gd-faces harness in the launch test tree")
    def _given_harness(_params: dict[str, str]) -> None:
        if not _HARNESS.is_file():
            raise StepFailure(reason="gd-faces harness script missing", detail=str(_HARNESS))

    @registry.step("the harness runs the capture face against the current tree")
    def _when_capture(_params: dict[str, str]) -> None:
        _run_face("capture", state)

    @registry.step("the harness runs the node_commands face against the current tree")
    def _when_node(_params: dict[str, str]) -> None:
        _run_face("node_commands", state)

    @registry.step("the capture face reports zero failures")
    def _then_capture(_params: dict[str, str]) -> None:
        _assert_zero_failures("capture", state)

    @registry.step("the node_commands face reports zero failures")
    def _then_node(_params: dict[str, str]) -> None:
        _assert_zero_failures("node_commands", state)


def _run_face(face: str, state: dict[str, object]) -> None:
    r = subprocess.run(
        ["bash", str(_HARNESS), face],
        capture_output=True,
        text=True,
        timeout=420,
    )
    state[f"{face}_rc"] = r.returncode
    state[f"{face}_stdout"] = r.stdout
    state[f"{face}_stderr_tail"] = r.stderr[-2000:]


def _assert_zero_failures(face: str, state: dict[str, object]) -> None:
    out = str(state.get(f"{face}_stdout", ""))
    if "FAIL=0" not in out:
        tail = out.strip().splitlines()[-1] if out.strip() else "(no output)"
        raise StepFailure(
            reason=f"{face} face reported failures",
            detail=tail,
            stderr_tail=str(state.get(f"{face}_stderr_tail", "")),
        )
    if int(state.get(f"{face}_rc", 1)) != 0:
        raise StepFailure(reason=f"{face} face harness exit code nonzero", detail=f"rc={state.get(f'{face}_rc')}")
