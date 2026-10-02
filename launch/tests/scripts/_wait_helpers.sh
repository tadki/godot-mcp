#!/usr/bin/env bash
# _wait_helpers.sh — shared event-driven wait primitives for launch test
# harnesses (SEE-1363). Sourced, not run directly.
#
# House rule (repo CLAUDE.md 「同步等待：事件驱动优先，禁止固定 sleep」): waits
# must be event-driven — a target log line / file content appearing — with a
# bounded budget and diagnostics on timeout. The poll interval lives ONLY in
# this file (inside a bounded loop: lint-gate exempt); harness files carry no
# literal `sleep N`.

# wait_for_pattern <file> <ERE-pattern> <budget_ms> [desc]
# Poll <file> until grep -E matches <pattern>. Returns 0 on the match event,
# 1 when the budget expires — and on timeout prints a diagnostic (what was
# awaited, budget, and the file's tail) to stderr so a stall is attributable.
wait_for_pattern() {
    local file="$1" pat="$2" budget_ms="$3" desc="${4:-$1 ~ $2}" waited=0
    while (( waited < budget_ms )); do
        grep -qE -- "$pat" "$file" 2>/dev/null && return 0
        sleep 0.1; waited=$(( waited + 100 ))
    done
    echo "  [wait-timeout] ${desc}: no match within ${budget_ms}ms (file=${file})" >&2
    if [[ -f "$file" ]]; then
        echo "  [wait-timeout] tail of ${file}:" >&2
        tail -n 8 "$file" | sed 's/^/    /' >&2
    else
        echo "  [wait-timeout] ${file} does not exist" >&2
    fi
    return 1
}
