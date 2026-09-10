#!/usr/bin/env bash
# QA Test: SEE-986 — .dev/docs/autopilots.md content completeness
#
# Verifies Atlas sub-step goal 1 for issue SEE-986:
#   Goal 1: .dev/docs/autopilots.md has independent H2 sections for the
#           always-on script autopilots, each with script path / param table /
#           behavior-or-phase / output JSON fields / troubleshooting.
#
# Also verifies that every script path cited in the doc actually exists on disk,
# so the doc is not referencing a phantom file.
#
# This is the doc-side half of the SEE-986 QA pair. Description-side checks
# live in test_see986_autopilot_descriptions.sh.
#
# Note: the original Goal 4 (PR #412 scope guard) was removed in SEE-1195
# cleanup — it asserted zero diff under .dev/autopilots/ vs origin/master,
# which fails by design on any PR that legitimately touches that directory.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DOC="$REPO_DIR/.dev/docs/autopilots.md"

fail=0
note() { echo "[see986-doc] $*"; }

if [[ ! -f "$DOC" ]]; then
    note "FAIL: doc not found at $DOC"
    exit 1
fi

# ---------------------------------------------------------------------------
# Goal 1: structural completeness of the doc
# ---------------------------------------------------------------------------

# 3 expected H2 sections for the always-on script autopilots. Use the leading
# "## N. " numbering the author chose. (Section 4 远程分支巡检 was removed
# in SEE-1195 cleanup when autopilot e76b363c was deleted on the platform side.)
expected_sections=(
    "## 1. Agent Watchdog"
    "## 2. Issue 状态检查"
    "## 3. 本地仓库巡检"
)
for needle in "${expected_sections[@]}"; do
    if grep -qF "$needle" "$DOC"; then
        note "PASS: section found -> $needle"
    else
        note "FAIL: missing section -> $needle"
        fail=1
    fi
done

# Each section must contain the 5 required sub-elements. We check per-section
# by slicing the doc between H2 boundaries.
declare -A section_ranges=(
    ["## 1. Agent Watchdog"]="## 1. Agent Watchdog|## 2. Issue"
    ["## 2. Issue 状态检查"]="## 2. Issue 状态检查|## 3. 本地仓库"
    ["## 3. 本地仓库巡检"]="## 3. 本地仓库巡检|## 4. 架构日检"
)

required_subsections=(
    "脚本路径"
    "参数说明"
    "行为说明"
    "输出 JSON 字段速查"
    "故障排查"
)

for section in "${!section_ranges[@]}"; do
    range="${section_ranges[$section]}"
    # Slice lines from the section header up to (not including) the next header.
    body="$(awk -v beg="${range%%|*}" -v end="${range##*|}" '
        $0 ~ beg {flag=1; next}
        $0 ~ end {flag=0}
        flag {print}
    ' "$DOC")"
    for sub in "${required_subsections[@]}"; do
        if echo "$body" | grep -qF "$sub"; then
            note "PASS: [$section] has $sub"
        else
            note "FAIL: [$section] missing $sub"
            fail=1
        fi
    done
done

# ---------------------------------------------------------------------------
# Goal 1 (cont.): cited script paths exist on disk
# ---------------------------------------------------------------------------

cited_scripts=(
    ".dev/autopilots/agent_watchdog.py"
    ".dev/autopilots/issue_status_check.py"
    ".dev/autopilots/local_repo_check.py"
    ".dev/autopilots/multica_helpers.py"
)
for rel in "${cited_scripts[@]}"; do
    if [[ -f "$REPO_DIR/$rel" ]]; then
        note "PASS: cited script exists -> $rel"
    else
        note "FAIL: cited script missing -> $rel"
        fail=1
    fi
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [[ $fail -eq 0 ]]; then
    note "RESULT: PASS (doc structure + script existence)"
    exit 0
else
    note "RESULT: FAIL"
    exit 1
fi
