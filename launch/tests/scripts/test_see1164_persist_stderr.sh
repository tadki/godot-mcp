#!/usr/bin/env bash
# test_see1164_persist_stderr.sh
#
# SEE-1164 改进 1 — when the start helper dies (spawn_failed_start), the proxy
# must persist the FULL (un-truncated) helper stderr to
#   ~/.multica/godot-editor/<KOL_RUNTIME_ID>.stderr.log
# so a post-mortem investigator can read the exact die message + stage lines
# that the daemon's `tool_result observed` log never stores.
#
# Setup: KOL_RUNTIME_ID + HOME are pointed into TMPDIR so the assertion never
# touches the real ~/.multica tree. The mock start helper emits a stderr block
# deliberately LONGER than DIAGNOSTIC_STDERR_TAIL (500 chars) so the test also
# catches a regression that persists only the truncated tail.
#
# Assertions:
#   A1  after id=2 is rejected with spawn_failed, the stderr.log file EXISTS.
#   A2  the file contains the start mock's early marker line (proving the FULL
#       stream was written, not just the 500-char tail).
#   A3  the file contains the start mock's late marker line (a line from the
#       bottom of the stream — sanity that the bottom is intact too).
#   A4  the file path uses the KOL_RUNTIME_ID from the env (per-slot isolation).
#   A5  the proxy still answered id=2 with bucket='spawn_failed_start'
#       (persistence must not break the diagnostic path).
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1164_persist_stderr.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

PORT=$(find_free_port)
CFG_COUNTER="$TMPDIR/cfg.count"
START_COUNTER="$TMPDIR/start.count"
: > "$CFG_COUNTER"; : > "$START_COUNTER"

# Mock configure: succeed silently.
CFG_SH=$(make_configure_mock "$CFG_COUNTER" 0)

# Mock start: emit a stderr block that EXCEEDS 500 chars before the trailing
# die marker, then exit 1. Early line proves the head is preserved; late line
# proves the tail is preserved.
START_SH="$TMPDIR/mock-start-big.sh"
cat > "$START_SH" <<'EOF'
#!/usr/bin/env bash
echo x >> "${KOL_START_COUNTER}"
{
    echo "EARLY_MARKER_PORT_PROBE_BEGIN port=9999"
    # ~700 chars of filler so total stderr > DIAGNOSTIC_STDERR_TAIL (500)
    python3 -c 'print("FILLER_" + "x" * 700)' 2>/dev/null \
        || echo "FILLER_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    echo "LATE_MARKER_DIE port 9999 already in use"
} >&2
exit 1
EOF
chmod +x "$START_SH"

# Redirect HOME so the proxy writes ~/.multica/... inside TMPDIR.
TEST_HOME="$TMPDIR/home"
mkdir -p "$TEST_HOME/.multica"
TEST_RID="bachi-test1164"

sep "SEE-1164 A1-A5: spawn_failed_start persists FULL stderr to ~/.multica/godot-editor/<rid>.stderr.log"
start_proxy \
    "HOME=$TEST_HOME" \
    "GODOT_MCP_HOME=$TEST_HOME/.multica" \
    "KOL_RUNTIME_ID=$TEST_RID" \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG_COUNTER" \
    "KOL_START_COUNTER=$START_COUNTER" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=5000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "pre: initialize not answered"

send_line "$(call_line 2)"
if wait_for "$PROXY_OUT" '"id":2' 10000; then
    ok "A5.pre: id=2 answered"
else
    ko "A5.pre: no id=2 response within 10s"
fi

EXPECT_LOG="$TEST_HOME/.multica/godot-editor/${TEST_RID}.stderr.log"

# A1: the file exists.
if wait_for "$PROXY_ERR" 'persisted helper stderr' 5000 || [[ -f "$EXPECT_LOG" ]]; then
    :
fi
# give the async appendFile a beat
for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -f "$EXPECT_LOG" ]] && break; sleep 0.2; done
if [[ -f "$EXPECT_LOG" ]]; then
    ok "A1: stderr.log exists at $EXPECT_LOG"
else
    ko "A1: stderr.log missing (expected at $EXPECT_LOG)"
    ls -la "$TEST_HOME/.multica/godot-editor/" 2>/dev/null || true
fi

# A2: full-stream head preserved.
if [[ -f "$EXPECT_LOG" ]] && grep -q "EARLY_MARKER_PORT_PROBE_BEGIN" "$EXPECT_LOG"; then
    ok "A2: stderr.log contains EARLY_MARKER (head of stream persisted, not just tail)"
else
    ko "A2: EARLY_MARKER missing — only the truncated tail was persisted"
fi

# A3: late marker preserved (sanity).
if [[ -f "$EXPECT_LOG" ]] && grep -q "LATE_MARKER_DIE" "$EXPECT_LOG"; then
    ok "A3: stderr.log contains LATE_MARKER (tail of stream persisted)"
else
    ko "A3: LATE_MARKER missing from stderr.log"
fi

# A4: file path matches KOL_RUNTIME_ID (already covered by A1 path; explicit name check).
if [[ -f "$EXPECT_LOG" ]]; then
    case "$EXPECT_LOG" in
        *"${TEST_RID}.stderr.log") ok "A4: file name carries runtime_id (${TEST_RID}.stderr.log)" ;;
        *) ko "A4: file path does not carry runtime_id" ;;
    esac
fi

# A5: the failure path still surfaces spawn_failed_start to the caller.
if grep -q '"bucket": *"spawn_failed_start"' "$PROXY_OUT"; then
    ok "A5: id=2 diagnostic still reports bucket='spawn_failed_start'"
else
    ko "A5: spawn_failed_start bucket missing from id=2 response"
fi

stop_proxy
summary
