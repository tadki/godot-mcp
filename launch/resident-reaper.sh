#!/usr/bin/env bash
# SEE-1148 P3 (§2.5 第三层): resident reaper entry point.
#
# Thin wrapper around reap-stale-leases.sh that the systemd user timer invokes
# every 5 minutes. It owns the one decision the raw reaper must NOT make on its
# own: whether this run is a DRY-RUN (report only) or a LIVE reap.
#
# Mode resolution (dry-run is the DEFAULT — Atlas P3 constraint "常驻 reaper 先
# 以 dry-run 常驻模式上线，日志稳定无异常后再启用真回收"):
#   - A mode file at ~/.multica/godot-reaper.mode holds either "dry-run" or
#     "live". Absent / empty / unrecognized => dry-run.
#   - Operators promote to live by writing "live" to that file (see
#     install-resident-reaper.sh --enable-live) — never by editing the unit.
#
# Why a mode file and not a unit edit: the timer is meant to run unattended for
# days. Flipping a single state file is auditable (mtime = when live mode was
# armed) and does not require a daemon-reload, so the cutover is one command.
#
# GUI-orphan (T23) reclaim is SEPARATELY gated by KOL_REAP_GUI_ORPHAN=1 inside
# the reaper and is NOT armed by "live" — live mode only enables the lease /
# residue / headless reclaims. The GUI class stays report-only until the owner
# confirms attribution once, per the P0 report.

set -uo pipefail

LAUNCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAPER="${LAUNCH_DIR}/reap-stale-leases.sh"
MODE_FILE="${GODOT_MCP_HOME:-${HOME}/.config/godot-mcp}/godot-reaper.mode"

mode="dry-run"
if [[ -f "$MODE_FILE" ]]; then
    read -r mode < "$MODE_FILE" || mode="dry-run"
fi

args=()
case "$mode" in
    live)  args=() ;;               # real reap: lease transitions + kills
    *)     args=(--dry-run) ;;      # default + any garbage value: report only
esac

# DRY_RUN=1 in the environment also forces report-only regardless of the mode
# file — a safe override an operator can export to pause live reclaim without
# flipping the mode file back.
if [[ "${DRY_RUN:-0}" == "1" ]]; then
    args=(--dry-run)
fi

# Tell the reaper this invocation is the unattended systemd-timer path so it
# skips the interactive Ctrl-C abort window (Atlas Final Review MEDIUM-4) —
# nobody is watching the journal to abort a live tick.
export KOL_REAP_RESIDENT=1

exec "$REAPER" "${args[@]}"
