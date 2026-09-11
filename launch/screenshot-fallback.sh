#!/usr/bin/env bash
# SEE-1070 #7: out-of-band screenshot fallback for the godot-mcp bridge.
#
# Purpose: when the addon's screenshot path (capture_game_screenshot /
# capture_editor_screenshot, exposed as godot_editor_read action=screenshot_*)
# errors out, the proxy (godot-mcp-proxy.mjs) appends a hint pointing here.
# This script grabs the primary Windows display via PowerShell
# System.Drawing.CopyFromScreen and writes a PNG under shots/, so debugging
# can continue without a working addon screenshot path.
#
# Boundary (Archi ca665f75): screenshot interception is the proxy's ONLY
# side-effect exception — it does not open a general hook for business logic.
# This script MUST surface real failures: it never swallows an error or hangs.
# If powershell.exe is present but capture fails, the PS exit code + stderr are
# propagated verbatim (non-zero exit); it does NOT silently fall through to
# grim/import, which would mask a Session-0 / no-desktop failure with an
# irrelevant Linux capture. The grim/import fallback runs ONLY when
# powershell.exe is entirely absent.
#
# Session caveat (to be confirmed by Revy's real-machine test): powershell.exe
# launched from WSL interop lands in whatever Windows session the interop
# process belongs to. If that is Session 0 (no interactive desktop),
# CopyFromScreen captures an empty / non-interactive desktop, not the visible
# Godot editor. The editor itself runs in the interactive session via Task
# Scheduler (start-godot-editor.sh); whether a WSL-spawned PS can see that
# desktop is exactly what the real-machine test must verify.
#
# Usage:
#   .dev/godot-mcp/launch/screenshot-fallback.sh [output.png]
#   # default output: <repo_root>/shots/screenshot-<unix-ts>.png

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SHOTS_DIR="$REPO_ROOT/shots"

# Resolve powershell.exe: prefer PATH, else the well-known System32 location
# (same resolution as start-godot-editor.sh).
POWERSHELL=""
if command -v powershell.exe >/dev/null 2>&1; then
    POWERSHELL="powershell.exe"
elif [[ -x /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe ]]; then
    POWERSHELL="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
fi

usage() {
    cat <<EOF
Usage: screenshot-fallback.sh [output.png]

Capture the primary Windows display to a PNG (PowerShell System.Drawing), or
fall back to grim/import when powershell.exe is unavailable.
Default output: <repo_root>/shots/screenshot-<timestamp>.png
EOF
}

OUT="${1:-}"
if [[ "$OUT" == "-h" || "$OUT" == "--help" ]]; then
    usage; exit 0
fi

if [[ -z "$OUT" ]]; then
    mkdir -p "$SHOTS_DIR"
    OUT="$SHOTS_DIR/screenshot-$(date +%s).png"
fi

# --- Primary path: PowerShell System.Drawing.CopyFromScreen -------------------
if [[ -n "$POWERSHELL" ]]; then
    # Write the PS to a temp .ps1 and run via -File to avoid -Command quoting
    # issues with paths (same pattern as start-godot-editor.sh launch_via_schtasks).
    PS_SCRIPT="$(mktemp /tmp/kol-screenshot.XXXXXX.ps1)" || { echo "screenshot-fallback: mktemp failed" >&2; exit 1; }
    OUT_WIN="$(wslpath -w "$OUT" 2>/dev/null || echo "$OUT")"
    cat >"$PS_SCRIPT" <<'PSEOF'
param([string]$OutPath)
$ErrorActionPreference = "Stop"
try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen
    if ($null -eq $screen) { throw "PrimaryScreen returned null (no interactive desktop visible to this session)" }
    $bounds = $screen.Bounds
    if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw "Primary screen bounds empty: $bounds" }
    $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output "OK $($bounds.Width)x$($bounds.Height)"
    exit 0
} catch {
    Write-Error $_
    exit 1
}
PSEOF
    PS_WIN="$(wslpath -w "$PS_SCRIPT" 2>/dev/null || echo "$PS_SCRIPT")"
    if "$POWERSHELL" -NoProfile -ExecutionPolicy Bypass -File "$PS_WIN" "$OUT_WIN"; then
        rm -f "$PS_SCRIPT"
        echo "[screenshot-fallback] captured primary screen -> $OUT" >&2
        exit 0
    else
        rc=$?
        rm -f "$PS_SCRIPT"
        # Boundary: powershell.exe was present but capture FAILED. Propagate
        # the original error; do not fall through to grim/import.
        echo "[screenshot-fallback] powershell.exe capture failed (rc=${rc}); see stderr above." >&2
        exit "$rc"
    fi
fi

# --- Fallback: grim (Wayland) / import (X11) — Linux display only -------------
# NOTE: this captures the Linux display WSL sees, NOT the Windows desktop where
# the Godot editor runs. Only reached when powershell.exe is entirely absent.
if command -v grim >/dev/null 2>&1; then
    if grim -t png "$OUT"; then
        echo "[screenshot-fallback] captured via grim -> $OUT" >&2
        exit 0
    else
        rc=$?
        echo "[screenshot-fallback] grim failed (rc=${rc})" >&2
        exit "$rc"
    fi
fi
if command -v import >/dev/null 2>&1; then
    if import -window root "$OUT"; then
        echo "[screenshot-fallback] captured via import -> $OUT" >&2
        exit 0
    else
        rc=$?
        echo "[screenshot-fallback] import failed (rc=${rc})" >&2
        exit "$rc"
    fi
fi

echo "[screenshot-fallback] no capture tool available (need powershell.exe, grim, or import)" >&2
exit 1
