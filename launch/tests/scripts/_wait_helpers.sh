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

# wait_for_stable <file> <budget_ms> — SEE-1365 hardener: the mtime-stability
# settle primitive, mirrored here from _see1085_helpers.sh so every harness
# sourcing _wait_helpers.sh gets the same semantics (see1240/1077 batch-4
# conversions call it, but only the _see1085_helpers family had the
# definition — the calls silently no-op'd as "command not found" until then).
# Returns 0 once the file's mtime has stayed unchanged for
# ~KOL_WAIT_STABLE_MS (default 400ms), or when the budget expires (bounded,
# same deadline behavior as the fixed settle it replaces). Second-resolution
# mtimes, hence the 400ms stability floor.
wait_for_stable() {
    local path="$1" budget="${2:-2000}" waited=0 stable_ms="${KOL_WAIT_STABLE_MS:-400}"
    local last=0 now
    last=$(stat -c %Y "$path" 2>/dev/null || echo 0)
    while (( waited < budget )); do
        sleep 0.05; waited=$(( waited + 50 ))
        now=$(stat -c %Y "$path" 2>/dev/null || echo 0)
        if (( last > 0 && now == last )); then
            if (( waited >= stable_ms )); then return 0; fi
        else
            last="$now"
        fi
    done
    # SEE-1365 hardener: budget expiry = the settle never stabilized (writes
    # still landing or file vanished). Deadline semantics unchanged (rc=0),
    # but the expiry must announce itself — a caller that snapshots after an
    # unstable settle has a flake-shaped failure mode and deserves the marker.
    # (Mirror definition lives in the other helper file; keep bodies identical.)
    echo "  [stable-timeout] ${path}: mtime never stable within ${budget}ms (settle expired; snapshot may be mid-write)" >&2
    return 0
}
