#!/usr/bin/env bash
# QA Test: SEE-986 — autopilot descriptions trimmed or left untouched
#
# Verifies Atlas sub-step goals 2 and 3 for issue SEE-986:
#   Goal 2: 4 script-type autopilots have a unified, concise description that
#           includes the correct script path and parameter flags.
#   Goal 3: 3 non-script autopilots are NOT modified to the trimmed template.
#
# This is the description-side half of the SEE-986 QA pair. Doc-side checks
# (doc-side half retired with SEE-1344 — autopilots doc/paths retired with SEE-1273 T5-F).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

fail=0
note() { echo "[see986-desc] $*"; }

# ---------------------------------------------------------------------------
# Goal 2: script-type autopilots are trimmed and retain the correct script path
# ---------------------------------------------------------------------------

declare -A script_autopilots=(
    ["25ba8a6f-aec5-4cfa-8fd7-c9eb6c54316b"]=".dev/autopilots/agent_watchdog.py|--no-dry-run|--max-restarts-per-hour 3|--verbose|--execution-issue-id"
    ["2dd8fa65-514d-498b-8675-63bf8f188b96"]=".dev/autopilots/issue_status_check.py|--no-dry-run|--verbose|--alert-issue-id"
    ["d655880c-d256-454e-898f-1cae6f71deea"]=".dev/autopilots/local_repo_check.py|--execution-issue-id"
    # e76b363c (remote_branch_check) deleted platform-side on 2026-08-27
    # (SEE-1179 Owner order); script + repo-side residue removed in SEE-1195
    # cleanup, so it no longer belongs in the script-autopilot check list.
)

for id in "${!script_autopilots[@]}"; do
    spec="${script_autopilots[$id]}"
    script_path="${spec%%|*}"
    flags_raw="${spec#*|}"
    IFS='|' read -ra flags <<< "$flags_raw"

    desc_json="$(multica autopilot get "$id" --output json 2>/dev/null || true)"
    if [[ -z "$desc_json" ]]; then
        note "FAIL: [$id] could not fetch autopilot description"
        fail=1
        continue
    fi
    description="$(echo "$desc_json" | jq -r '.autopilot.description')"
    updated_at="$(echo "$desc_json" | jq -r '.autopilot.updated_at')"

    note "[$id] updated_at=$updated_at"

    # Unified template check: must contain all three steps.
    for step in "Step 1 检出仓库" "Step 2 执行脚本" "Step 3 静默结束"; do
        if echo "$description" | grep -qF -- "$step"; then
            note "PASS: [$id] contains $step"
        else
            note "FAIL: [$id] missing $step"
            fail=1
        fi
    done

    # Script path retained in the Step 2 command.
    if echo "$description" | grep -qF -- "$script_path"; then
        note "PASS: [$id] references script path $script_path"
    else
        note "FAIL: [$id] does not reference expected script path $script_path"
        fail=1
    fi

    # Key parameter flags retained. Use `--` so flags like --no-dry-run are
    # treated as a grep pattern, not as grep options.
    for flag in "${flags[@]}"; do
        if echo "$description" | grep -qF -- "$flag"; then
            note "PASS: [$id] retains flag '$flag'"
        else
            note "FAIL: [$id] missing flag '$flag'"
            fail=1
        fi
    done

    # Optional: description should not be excessively long now (the trimmed
    # format is ~30 lines tops). Flag as a warning if it grows much beyond that.
    line_count="$(echo "$description" | wc -l)"
    if [[ "$line_count" -gt 60 ]]; then
        note "WARN: [$id] description is $line_count lines, larger than expected for trimmed format"
    fi
done

# ---------------------------------------------------------------------------
# Goal 3: non-script autopilots are NOT modified to the trimmed template
# ---------------------------------------------------------------------------

declare -a non_script_autopilots=(
    "87c49136-67e2-4a6a-85fb-a8019dd6e636"
    "5513ff4d-b081-483e-9abf-436f66e8149d"
    "7f54ea39-3a1c-46c6-b205-4a838a9bffa6"
)

for id in "${non_script_autopilots[@]}"; do
    desc_json="$(multica autopilot get "$id" --output json 2>/dev/null || true)"
    if [[ -z "$desc_json" ]]; then
        note "FAIL: [$id] could not fetch autopilot description"
        fail=1
        continue
    fi
    description="$(echo "$desc_json" | jq -r '.autopilot.description')"
    updated_at="$(echo "$desc_json" | jq -r '.autopilot.updated_at')"

    note "[$id] updated_at=$updated_at"

    # A non-script autopilot should not contain the script-type template steps
    # all together. If it does, it has been mistakenly trimmed.
    trimmed_markers=0
    for marker in "Step 1 检出仓库" "Step 2 执行脚本" "Step 3 静默结束"; do
        if echo "$description" | grep -qF -- "$marker"; then
            trimmed_markers=$((trimmed_markers + 1))
        fi
    done

    if [[ "$trimmed_markers" -eq 3 ]]; then
        note "FAIL: [$id] appears to have been trimmed to the script-type template"
        fail=1
    else
        note "PASS: [$id] is not in the script-type trimmed template"
    fi

    # They should also still be rich, detailed descriptions (not just Step 1/2/3).
    line_count="$(echo "$description" | wc -l)"
    if [[ "$line_count" -lt 30 ]]; then
        note "WARN: [$id] is only $line_count lines, unexpectedly short for a non-script autopilot"
    else
        note "PASS: [$id] retains a rich description ($line_count lines)"
    fi
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [[ $fail -eq 0 ]]; then
    note "RESULT: PASS (descriptions + non-script scope)"
    exit 0
else
    note "RESULT: FAIL"
    exit 1
fi
