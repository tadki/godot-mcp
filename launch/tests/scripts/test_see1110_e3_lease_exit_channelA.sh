#!/usr/bin/env bash
# test_see1110_e3_lease_exit_channelA.sh
#
# SEE-1110 §8 E3 — lease self-exit, asserted on CHANNEL A (response body).
#
# Scenario: editor up but no MCP client for the lease grace window. The addon
# logs "Lease: no MCP client for the grace window; exiting editor to release the
# port." → the proxy's independent lease monitor fast-fails via the T4 path:
# rejectQueue(error with warmupDiagnostic('failed_exit')) + process.exit(1),
# bypassing the long RECOVERING window.
#
# SEE-1111 hold-to-warm adaptation: a tools/call that lands while the editor is
# warming is HELD in the FIFO (pendingCalls), not answered immediately. So on
# lease fast-fail the held id=2 IS buffered — rejectQueue answers it with the
# failed_exit diagnostic before process.exit(1). E3.2 therefore asserts id=2
# carries the failed_exit diagnostic (not a friendly hint, not a silent drop),
# and E3.4 asserts the queue was NOT empty (the held call was rejected).
#
# This is an integration test against the proxy (not the parser unit), so it
# drives the real proxy with a fake editor log + mock helpers, asserting the
# Channel A error body.
#
# Assertions:
#   E3.1  proxy fast-fails (<5s) after the LEASE_EXITING line is appended.
#   E3.2  the held warming tools/call id=2 got the failed_exit diagnostic
#         (state=failed_exit), NOT a friendly warmup hint and NOT a silent drop.
#   E3.3  the lease-death stderr log carries the FAILED_EXIT path proof.
#   E3.4  the lease fast-fail rejected >= 1 buffered call (the held id=2).
#   E3.5  [A4 adversarial] stale LEASE_EXITING pre-seeded before proxy start →
#         proxy does NOT fast-fail (offset mechanism); the held warming call
#         id=2 is rejected only if the proxy exits (which it must not here).
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1110_e3_lease_exit_channelA.sh

set -uo pipefail
trap '' PIPE

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_see1085_helpers.sh
source "$SCRIPT_DIR/_see1085_helpers.sh"
lib_init

LEASE_EXITING='Lease: no MCP client for the grace window; exiting editor to release the port.'

# Mock configure/start are no-ops — the lease monitor is what we exercise; the
# test's own fake log + listener control warmup. Exported so the coproc env sees them.
MOCK_CONFIGURE="$TMPDIR/mock-configure.sh"
cat > "$MOCK_CONFIGURE" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$MOCK_CONFIGURE"
MOCK_START="$TMPDIR/mock-start.sh"
cat > "$MOCK_START" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$MOCK_START"

# ---------------------------------------------------------------------------
# E3 main: WARMING + LEASE_EXITING appended → fast-fail with Channel A diag.
# ---------------------------------------------------------------------------
sep "E3: lease self-exit → fast-fail (held call rejected with failed_exit)"
E3_PORT=$(find_free_port)
E3_LOG="$TMPDIR/e3-editor.log"; : > "$E3_LOG"

# E3 pins the FAILED_EXIT lane (rejectQueue + process.exit(1), header
# contract): the WS-5 giveup-rearm default lane has its own coverage
# (test_see1240_ws5_giveup_rearm.sh, long bucket); selecting the lane here
# is a fixture choice, not an assertion change.
start_proxy \
    "GODOT_PORT=$E3_PORT" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$MOCK_CONFIGURE" \
    "KOL_START_SH=$MOCK_START" \
    "KOL_WARMUP_TIMEOUT_MS=30000" \
    "KOL_FAILED_EXIT_MS=60000" \
    "GODOT_EDITOR_LOG_FILE=$E3_LOG" \
    "KOL_GIVEUP_REARM=0" \
    "MOCK_NPX_LOG=$TMPDIR/e3_npx.log"

send_line "$INIT_LINE"
send_line "$(call_line 2)"
wait_for "$PROXY_OUT" '"id":1' 3000 || ko "E3.pre: initialize not answered"

# E3.2 — the warming tools/call id=2 is HELD in the FIFO (hold-to-warm), NOT
# answered immediately. When LEASE_EXITING is appended, the lease fast-fail's
# rejectQueue answers the held call with the failed_exit diagnostic before
# process.exit(1). So id=2 must carry that diagnostic — never a friendly
# warmup hint, never a silent drop.
# (The id=2 response arrives only after LEASE_EXITING is appended, so we wait
# for it after the fast-fail check below.)

sleep 0.5
T_SEND=$(date +%s%3N)
echo "$LEASE_EXITING" >> "$E3_LOG"
if wait_for_death 5000; then
    T_DEAD=$(date +%s%3N)
    LAT=$(( T_DEAD - T_SEND ))
    ok "E3.1: proxy fast-failed ~${LAT}ms after LEASE_EXITING (well under 30s warmup)"
else
    ko "E3.1: proxy still alive 5s after LEASE_EXITING (lease monitor missing?)"
fi

# E3.2 — the held warming call id=2 was answered by the lease fast-fail's
# rejectQueue with the failed_exit diagnostic (never a warmup hint, never a
# silent drop). The response is flushed to proxy stdout before process.exit(1).
if grep -q '"id":2' "$PROXY_OUT" && grep -q '"state": *"failed_exit"' "$PROXY_OUT"; then
    ok "E3.2a: held id=2 rejected with the failed_exit diagnostic on lease fast-fail"
else
    ko "E3.2a: id=2 did NOT carry failed_exit (held call not rejected on lease exit)"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$PROXY_OUT"; then
    ko "E3.2b: warmup-hint text appeared (default hint must be gone under 90s timeout)"
else
    ok "E3.2b: no warmup-hint text anywhere (hold-to-warm, no default hint)"
fi

# E3.3 — the always-emitted stderr log: the lease monitor matched LEASE_EXITING
# and ran the FAILED_EXIT path.
if grep -q 'lease death detected' "$PROXY_ERR"; then
    ok "E3.3: lease monitor matched LEASE_EXITING and took the FAILED_EXIT path"
else
    ko "E3.3: no lease-death log line on stderr (monitor did not fire)"
fi
# E3.4 — the FAILED_EXIT log reports the pendingCalls count. With hold-to-warm
# the warming call id=2 is HELD, so the queue has >= 1 buffered call to reject —
# the proof that the call was held (not answered by a hint) and then rejected.
if grep -qE 'rejecting [1-9][0-9]* buffered call\(s\) and exiting' "$PROXY_ERR"; then
    ok "E3.4: lease fast-fail rejected >= 1 buffered call (held id=2 was in the queue)"
else
    ko "E3.4: lease fast-fail did not reject a held call: $(grep 'buffered call' "$PROXY_ERR" | head -1)"
fi

# ---------------------------------------------------------------------------
# A4 adversarial: stale LEASE_EXITING pre-seeded → no fast-fail (offset).
# ---------------------------------------------------------------------------
sep "A4: stale LEASE_EXITING before proxy start → no fast-fail (offset mechanism)"
A4_PORT=$(find_free_port)
A4_LOG="$TMPDIR/a4-editor.log"
echo "$LEASE_EXITING" > "$A4_LOG"

start_proxy \
    "GODOT_PORT=$A4_PORT" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$MOCK_CONFIGURE" \
    "KOL_START_SH=$MOCK_START" \
    "KOL_WARMUP_TIMEOUT_MS=8000" \
    "KOL_FAILED_EXIT_MS=30000" \
    "GODOT_EDITOR_LOG_FILE=$A4_LOG" \
    "MOCK_NPX_LOG=$TMPDIR/a4_npx.log"

send_line "$INIT_LINE"
send_line "$(call_line 2)"
wait_for "$PROXY_OUT" '"id":1' 3000 || ko "A4.pre: initialize not answered"
# A4.2 — the stale lease line must NOT trigger a rejection: the proxy skips it
# (offset), stays alive, and the held id=2 is NOT answered with a failed_exit
# error. Under hold-to-warm id=2 stays HELD in the FIFO while the proxy waits
# for WARM — the invariant to assert is "no error envelope for id=2".
sleep 1
if grep -q '"id":2.*"error"' "$PROXY_OUT" 2>/dev/null; then
    ko "A4.2b: id=2 rejected with an error on a stale line (false positive rejection)"
else
    ok "A4.2b: id=2 NOT rejected on a stale lease line (no false-positive rejection)"
fi
sleep 3
if proxy_alive; then
    ok "A4.1: proxy alive despite pre-seeded LEASE_EXITING (offset skips stale bytes)"
else
    ko "A4.1: proxy fast-failed on stale LEASE_EXITING (offset tail broken — false positive)"
fi
stop_proxy

summary
