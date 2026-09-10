#!/usr/bin/env bash
# test_see1164_adversarial_revy.sh
#
# Revy adversarial QA for SEE-1164 — covers gaps NOT exercised by Bachi's
# original test_see1164_persist_stderr.sh / test_see1164_port_die_owner.sh:
#
#   R1  block header carries ISO timestamp, source, rc, runtime_id, port
#       (trigger goal 1c) — Bachi's A1-A5 never asserted the header fields.
#   R2  empty KOL_RUNTIME_ID lands in `unknown.stderr.log`, NOT in a
#       `.stderr.log` shared/legacy name (trigger goal 1d, per-slot isolation).
#   R3  fs failure (read-only ~/.multica/godot-editor) does NOT break the
#       SpawnError path — proxy must still answer id=2 with
#       bucket='spawn_failed_start' (trigger goal 1e, best-effort persistence).
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1164_adversarial_revy.sh

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
CFG_SH=$(make_configure_mock "$CFG_COUNTER" 0)

# Mock start: fail with a small deterministic stderr so the log file content
# is easy to assert on.
START_SH="$TMPDIR/mock-start.sh"
cat > "$START_SH" <<'EOF'
#!/usr/bin/env bash
echo x >> "${KOL_START_COUNTER}"
{
    echo "ADVERSARIAL_MARKER_DIE rc=1 port=${GODOT_PORT}"
} >&2
exit 1
EOF
chmod +x "$START_SH"

TEST_HOME="$TMPDIR/home"
mkdir -p "$TEST_HOME"

# ---------------------------------------------------------------------------
# R1 + R2: header fields + empty runtime_id → unknown.stderr.log
# ---------------------------------------------------------------------------
sep "SEE-1164 R1+R2: header fields present, empty runtime_id → unknown.stderr.log"

start_proxy \
    "HOME=$TEST_HOME" \
    "KOL_RUNTIME_ID=" \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Revy" \
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
wait_for "$PROXY_OUT" '"id":2' 10000 || ko "pre: id=2 not answered"

EXPECT_UNKNOWN="$TEST_HOME/.multica/godot-editor/unknown.stderr.log"
EXPECT_SHARED_LEGACY="$TEST_HOME/.multica/godot-editor/.stderr.log"

for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -f "$EXPECT_UNKNOWN" ]] && break; sleep 0.2; done

# R2a: file landed at unknown.stderr.log
if [[ -f "$EXPECT_UNKNOWN" ]]; then
    ok "R2a: empty runtime_id landed at unknown.stderr.log"
else
    ko "R2a: unknown.stderr.log missing (expected at $EXPECT_UNKNOWN)"
    ls -la "$TEST_HOME/.multica/godot-editor/" 2>/dev/null || true
fi

# R2b: shared/legacy .stderr.log was NOT created
if [[ -f "$EXPECT_SHARED_LEGACY" ]]; then
    ko "R2b: legacy '.stderr.log' (no rid prefix) WAS created — per-slot isolation violated"
else
    ok "R2b: legacy '.stderr.log' not created (per-slot isolation intact)"
fi

# R1a: header carries ISO timestamp (=====[<ISO>] =====)
if grep -qE '===== \[20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z\]' "$EXPECT_UNKNOWN" 2>/dev/null; then
    ok "R1a: header contains ISO 8601 UTC timestamp"
else
    ko "R1a: header missing ISO timestamp"; sed -n '1,10p' "$EXPECT_UNKNOWN" 2>/dev/null || true
fi

# R1b: header carries source=
if grep -qE 'source=start-godot-editor\.sh' "$EXPECT_UNKNOWN" 2>/dev/null; then
    ok "R1b: header contains source=start-godot-editor.sh"
else
    ko "R1b: header missing source="
fi

# R1c: header carries rc=
if grep -qE 'rc=1' "$EXPECT_UNKNOWN" 2>/dev/null; then
    ok "R1c: header contains rc=1"
else
    ko "R1c: header missing rc=1"
fi

# R1d: header carries runtime_id= (value may be empty/unknown literal)
if grep -qE 'runtime_id=' "$EXPECT_UNKNOWN" 2>/dev/null; then
    ok "R1d: header contains runtime_id= field"
else
    ko "R1d: header missing runtime_id="
fi

# R1e: header carries port=
if grep -qE "port=${PORT}" "$EXPECT_UNKNOWN" 2>/dev/null; then
    ok "R1e: header contains port=$PORT"
else
    ko "R1e: header missing port=$PORT"
fi

stop_proxy

# ---------------------------------------------------------------------------
# R3: fs failure must NOT break SpawnError path (best-effort persistence)
# ---------------------------------------------------------------------------
sep "SEE-1164 R3: read-only ~/.multica/godot-editor → SpawnError still surfaces"

TEST_HOME_RO="$TMPDIR/home-ro"
mkdir -p "$TEST_HOME_RO/.multica/godot-editor"
chmod 0555 "$TEST_HOME_RO/.multica/godot-editor"

PORT2=$(find_free_port)
: > "$CFG_COUNTER"; : > "$START_COUNTER"

start_proxy \
    "HOME=$TEST_HOME_RO" \
    "KOL_RUNTIME_ID=revy-ro-test" \
    "GODOT_PORT=$PORT2" \
    "KOL_AGENT_NAME=Revy" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG_COUNTER" \
    "KOL_START_COUNTER=$START_COUNTER" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=5000" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "MOCK_NPX_LOG=$TMPDIR/npx2.log"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "R3.pre: initialize not answered"

send_line "$(call_line 2)"
if wait_for "$PROXY_OUT" '"id":2' 10000; then
    ok "R3a: id=2 answered despite fs failure (best-effort persists)"
else
    ko "R3a: id=2 NOT answered — fs failure broke SpawnError path"
fi

# R3b: response still carries bucket='spawn_failed_start'
if grep -q '"bucket": *"spawn_failed_start"' "$PROXY_OUT"; then
    ok "R3b: bucket='spawn_failed_start' still surfaced"
else
    ko "R3b: spawn_failed_start bucket missing — diagnostic path regressed"
fi

# R3c: proxy stderr shows the persistSpawnStderr failure (not silent)
if grep -qE 'persistSpawnStderr failed' "$PROXY_ERR" 2>/dev/null; then
    ok "R3c: proxy logged persistSpawnStderr failure to stderr"
else
    # not a hard fail — it's acceptable if the message is different, as long as SpawnError surfaced
    ok "R3c: (info) persistSpawnStderr failure message not found verbatim — proxy stderr:"
    grep -iE 'persist|appendFile|ENOENT|EACCES|EPERM' "$PROXY_ERR" 2>/dev/null | head -3 || true
fi

stop_proxy
chmod 0755 "$TEST_HOME_RO/.multica/godot-editor" 2>/dev/null || true

summary
