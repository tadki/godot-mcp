#!/usr/bin/env bash
# SEE-1148 P3: install / control the resident godot-mcp reaper (systemd user timer).
#
# Installs godot-mcp-reaper.{service,timer} into the CURRENT user's systemd
# user instance (~/.config/systemd/user/) and enables the timer. The service
# always enters via resident-reaper.sh, which reads its mode from
# ~/.multica/godot-reaper.mode — dry-run unless that file says "live".
#
# Usage:
#   install-resident-reaper.sh install        # install units + enable timer (dry-run mode)
#   install-resident-reaper.sh uninstall      # stop + disable + remove units
#   install-resident-reaper.sh status         # timer/service status + current mode + last log
#   install-resident-reaper.sh --enable-live  # arm LIVE reclaim (write "live" to the mode file)
#   install-resident-reaper.sh --enable-dry   # back to report-only (write "dry-run")
#
# Dry-run-first (Atlas P3 constraint): `install` leaves the mode file at
# dry-run. Watch the journal for a stability window, then `--enable-live`.
#
# Systemd user instance: no root needed. The reaper scans $HOME/multica_workspaces
# which belongs to this user, so a user unit has exactly the privileges it needs.
# On WSL the user instance must be running (loginctl enable-linger for boot-time
# ticks without an interactive login — see status output hint).

set -euo pipefail

LAUNCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# §4.5.3 T2: post-reorg the library IS at the repo root, so the repo root is
# LAUNCH_DIR's parent (previously ../.. from .dev/godot-mcp/launch). K8 note:
# the unit's ExecStart is rendered here at INSTALL time — a stale unit must be
# re-installed (this script) after the checkout moves, never auto-repaired.
REPO_ROOT="$(cd "${LAUNCH_DIR}/.." && pwd)"
UNIT_SRC_SERVICE="${LAUNCH_DIR}/godot-mcp-reaper.service"
UNIT_SRC_TIMER="${LAUNCH_DIR}/godot-mcp-reaper.timer"
UNIT_DIR="${HOME}/.config/systemd/user"
MODE_FILE="${HOME}/.multica/godot-reaper.mode"

cmd="${1:-}"

die() { echo "[install-resident-reaper] ERROR: $*" >&2; exit 1; }

write_mode() { mkdir -p "$(dirname "$MODE_FILE")"; printf '%s\n' "$1" > "$MODE_FILE"; }

current_mode() {
    local m="dry-run"
    [[ -f "$MODE_FILE" ]] && read -r m < "$MODE_FILE" || m="dry-run"
    case "$m" in live) echo "live" ;; *) echo "dry-run" ;; esac
}

case "$cmd" in
    install)
        command -v systemctl >/dev/null 2>&1 || die "systemctl not found."
        mkdir -p "$UNIT_DIR"
        # Stamp the resolved repo path into the service unit at install time so
        # the unit does not depend on where the checkout happened to live when
        # it was written. Only the ExecStart line is rewritten. awk is used
        # (LOW-6, Atlas Final Review): sed treats `&` in the replacement as
        # "the whole match" and `|` as the delimiter — a REPO_ROOT containing
        # either would corrupt the unit. awk string assignment is literal.
        awk -v es="ExecStart=${REPO_ROOT}/launch/resident-reaper.sh" \
            '{ if ($0 ~ /^ExecStart=/) print es; else print $0 }' \
            "$UNIT_SRC_SERVICE" > "${UNIT_DIR}/godot-mcp-reaper.service"
        cp "$UNIT_SRC_TIMER" "${UNIT_DIR}/godot-mcp-reaper.timer"
        systemctl --user daemon-reload
        systemctl --user enable --now godot-mcp-reaper.timer
        # Dry-run-first: a fresh install NEVER arms live reclaim.
        [[ -f "$MODE_FILE" ]] || write_mode "dry-run"
        echo "[install-resident-reaper] installed + timer enabled. mode=$(current_mode) (report-only)."
        echo "[install-resident-reaper] watch:  journalctl --user -u godot-mcp-reaper.service -f"
        echo "[install-resident-reaper] after a stable dry-run window, arm live reclaim:"
        echo "[install-resident-reaper]   $0 --enable-live"
        ;;
    uninstall)
        systemctl --user disable --now godot-mcp-reaper.timer 2>/dev/null || true
        rm -f "${UNIT_DIR}/godot-mcp-reaper.service" "${UNIT_DIR}/godot-mcp-reaper.timer"
        systemctl --user daemon-reload 2>/dev/null || true
        echo "[install-resident-reaper] timer disabled + units removed. mode file left at: ${MODE_FILE}"
        ;;
    --enable-live)
        write_mode "live"
        echo "[install-resident-reaper] mode=live. Next timer tick performs REAL reaps."
        echo "[install-resident-reaper] NOTE: GUI-orphan (T23) reclaim stays report-only; arm separately with KOL_REAP_GUI_ORPHAN=1 after owner confirms attribution."
        ;;
    --enable-dry)
        write_mode "dry-run"
        echo "[install-resident-reaper] mode=dry-run. Next timer tick is report-only."
        ;;
    status)
        echo "mode: $(current_mode)   (mode file: ${MODE_FILE})"
        echo "--- timer ---"
        systemctl --user status godot-mcp-reaper.timer --no-pager 2>&1 | head -8 || true
        echo "--- last run ---"
        journalctl --user -u godot-mcp-reaper.service --no-pager -n 25 2>&1 | tail -25 || true
        echo "--- linger (boot-time ticks without login) ---"
        linger="$(loginctl show-user "${USER}" -p Linger 2>/dev/null || echo 'Linger=?')"
        echo "$linger   (enable with: loginctl enable-linger ${USER})"
        ;;
    *)
        die "unknown command '${cmd}'. Use: install | uninstall | status | --enable-live | --enable-dry"
        ;;
esac
