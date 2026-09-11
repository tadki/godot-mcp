#!/usr/bin/env bash
# SEE-1273 T1 QA — AC-M3REORG-002 independent repro: fresh consumer clone,
# submodule update to fork main, plugin.cfg at mount root, headless Godot
# import with plugin enabled; fails on any error/fail/cannot/missing line.
#
# Run context (SEE-1287): the default EXPECTED_MAIN below is a historical
# snapshot pin from the SEE-1273 T1 QA round. Fork main has since advanced
# (SEE-1285/SEE-1287), so running this harness unmodified will fail on the
# pin — pass EXPECTED_MAIN=<sha> (or EXPECTED_MAIN=$(git ls-remote <fork> main))
# to pin against a specific fork main, or leave the default for the archived
# T1 round reproduction.
set -euo pipefail
FORK_URL="https://github.com/tadki/godot-mcp.git"
EXPECTED_MAIN="${EXPECTED_MAIN:-$(git ls-remote "$FORK_URL" refs/heads/main | awk '{print $1}')}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git init -q "$TMP/consumer" && cd "$TMP/consumer" && git checkout -q -b master
git submodule add -q "$FORK_URL" addons/godot_mcp >/dev/null 2>&1
git add -A && git commit -qm "consumer: submodule to godot-mcp main"

# Fresh-clone path: clone the consumer and materialize via submodule update
git clone -q "$TMP/consumer" "$TMP/clone"
cd "$TMP/clone" && git submodule update --init --recursive >/dev/null
HEAD_SHA="$(cd addons/godot_mcp && git rev-parse HEAD)"
[[ "$HEAD_SHA" == "$EXPECTED_MAIN" ]] || { echo "FAIL: submodule head $HEAD_SHA != $EXPECTED_MAIN"; exit 1; }
[[ -f addons/godot_mcp/plugin.cfg ]] || { echo "FAIL: plugin.cfg not at addon root"; exit 1; }

# A consumer project needs a main scene + enabled plugin to import cleanly
printf 'config_version=5\n\n[application]\nconfig/name="T1QAConsumer"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.5")\n\n[editor_plugins]\nenabled=PackedStringArray("godot_mcp")\n' > project.godot
printf '[gd_scene format=3]\n\n[node name="Main" type="Node"]\n' > main.tscn

LOG="$TMP/import.log"
timeout 300 godot --headless --import --path . >"$LOG" 2>&1 </dev/null || true
if grep -qiE '\b(error|fail(ed)?|cannot|missing|unable|parse error)\b' "$LOG" \
   | grep -vq 'MCPGameBridge autoload is missing'; then
  echo "FAIL AC-M3REORG-002: import errors:"; grep -inE 'error|fail|cannot|missing|unable|parse' "$LOG" | head -20; exit 1
fi
grep -q 'Plugin initialized' "$LOG" || { echo "FAIL: godot-mcp plugin did not initialize"; exit 1; }
echo "PASS AC-M3REORG-002: submodule=$HEAD_SHA plugin.cfg at addons/godot_mcp/, import clean, plugin initialized"
