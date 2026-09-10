#!/usr/bin/env bash
# test_see1111_spawn_prepare_generates_project_godot.sh
#
# SEE-1111 (cold-start one-shot) regression — the spawn path must GENERATE
# project.godot when it is absent before configuring.
#
# Root cause (Archi, 2026-08-06): project.godot is gitignored + untracked since
# PR#479, so a worktree that already existed when the fix deployed (or whose
# checkout-time prepare-worktree.sh self-location failed — Revy 缺陷2
# linked-worktree case) has NO project.godot. The lazy spawn path called
# configure-mcp-port.sh directly, which dies with `configure_failed` (non-
# existent file) BEFORE the editor ever spawns — the cold start never reached
# warmup at all (`editor spawn failed: configure_failed; will retry on next
# call`). The fix invokes prepare-worktree.sh in the spawn path (and the
# hot-reuse pin path) so the file is generated (copy clean + pin port) first.
#
# This test stubs KOL_PREPARE_SH so it never touches the real D-drive; the stub
# creates project.godot in the mock worktree (simulating prepare's copy+pin) and
# bumps a counter. It asserts:
#   P.1  spawn triggers prepare (counter bumped) even though the mock worktree
#        has no project.godot.
#   P.2  prepare runs BEFORE configure (ordering: copy/pin precede configure).
#   P.3  after prepare generates the file, the spawn proceeds to start (editor
#        spawn launched) — no configure_failed.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1111_spawn_prepare_generates_project_godot.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)
EDITOR_LOG="$TMPDIR/editor.log"; : > "$EDITOR_LOG"
CFG="$TMPDIR/cfg.count"; START="$TMPDIR/start.count"; PREP="$TMPDIR/prep.count"; ORDER="$TMPDIR/order.log"
: > "$CFG"; : > "$START"; : > "$PREP"; : > "$ORDER"

# Remove the mock worktree's project.godot so the spawn path sees it ABSENT.
rm -f "$MOCK_WORKTREE/project.godot"

# Stub prepare-worktree.sh: records ordering, bumps the counter, and GENERATES
# project.godot (simulating the copy-clean + pin behavior) so configure succeeds.
PREP_SH="$TMPDIR/mock-prepare.sh"
cat > "$PREP_SH" <<EOF
#!/usr/bin/env bash
echo prepare >> "$ORDER"
echo x >> "$PREP"
cat > "$MOCK_WORKTREE/project.godot" <<'PG'
config_version=5

[godot_mcp]

port_override_enabled=true
port_override=$PORT
PG
exit 0
EOF
chmod +x "$PREP_SH"

# configure/start mocks record ordering too, so we can assert prepare precedes
# configure. configure must find the file prepare just wrote.
CFG_SH="$TMPDIR/mock-configure.sh"
cat > "$CFG_SH" <<EOF
#!/usr/bin/env bash
echo configure >> "$ORDER"
echo x >> "$CFG"
[[ -f "$MOCK_WORKTREE/project.godot" ]] || { echo "configure: project.godot missing" >&2; exit 3; }
exit 0
EOF
chmod +x "$CFG_SH"
START_SH=$(make_start_mock "$START" 0 1)   # spawn=1 → WS listener on GODOT_PORT

sep "SEE-1111 cold-start one-shot: spawn path generates project.godot when absent"

start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Archi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_PREPARE_SH=$PREP_SH" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG" \
    "KOL_START_COUNTER=$START" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "GODOT_EDITOR_LOG_FILE=$EDITOR_LOG" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "P.pre: initialize not answered"

# Trigger the lazy spawn with a first tools/call.
send_line "$(call_line 2)"

# P.1 — prepare ran (counter bumped) despite project.godot being absent.
if wait_for "$PROXY_ERR" 'editor spawn launched' 4000; then
    ok "P.0: spawn proceeded past configure (no configure_failed)"
else
    ko "P.0: spawn never launched (configure_failed regression — prepare did not generate the file)"
fi
if [[ -s "$PREP" ]]; then
    ok "P.1: prepare-worktree.sh invoked by the spawn path (counter bumped)"
else
    ko "P.1: prepare-worktree.sh NOT invoked (fix missing — absent project.godot would die configure_failed)"
fi

# P.2 — prepare precedes configure in the order log.
FIRST=$(head -1 "$ORDER" 2>/dev/null || true)
if [[ "$FIRST" == "prepare" ]]; then
    ok "P.2: prepare ran before configure (ordering correct: generate → pin → configure)"
else
    ko "P.2: expected 'prepare' first in order log, got '$FIRST'"
fi

# P.3 — the file prepare generated let configure find it and the editor spawn
# (start mock spawned the WS listener), so the proxy can warm and answer id=2.
echo "[godot-mcp] Server listening on 127.0.0.1:$PORT [test]" >> "$EDITOR_LOG"
echo "[godot-mcp] WebSocket handshake complete" >> "$EDITOR_LOG"
if wait_for "$PROXY_OUT" '"id":2' 12000; then
    ok "P.3: first call answered after prepare+configure+spawn (one-shot cold start)"
else
    ko "P.3: id=2 never answered after warm (spawn chain broke)"
fi

stop_proxy
summary
