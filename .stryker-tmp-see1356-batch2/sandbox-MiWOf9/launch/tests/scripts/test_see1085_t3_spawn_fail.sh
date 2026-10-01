#!/usr/bin/env bash
# test_see1085_t3_spawn_fail.sh
#
# SEE-1085 B1 lazy-load + SEE-1111 hold-to-warm 误报防护 — T3 spawn-failure
# diagnostics.
#
# Precondition: configure succeeds, but the start helper always exits non-zero
# with a structured stderr block (mirrors start-godot-editor.sh die()ing on a
# missing Godot binary). ensureEditor throws a SpawnError(spawn_failed_start);
# handleSpawnFailure latches spawnLastFailed and resets spawnTriggered so the
# next call retries.
#
# The spawn failure happens ASYNCHRONOUSLY while the first tools/call id=2 is
# HELD in the FIFO (hold-to-warm). handleSpawnFailure's rejectQueue drains the
# held call with the real spawn_failed diagnostic — so the TRIGGER call itself
# gets the failure, never a friendly "warming" hint (误报防护). The retry id=3
# surfaces the one-shot spawn_failed latch AND re-triggers a fresh spawn.
#
# Assertions:
#   T3.0  id=2 (the call that TRIGGERED the failing spawn) is HELD while the
#         spawn runs; when the async failure lands, rejectQueue answers it with
#         the spawn_failed diagnostic — NOT a warmup hint.
#   T3.1  id=3 gets the one-shot spawn_failed diagnostic: code=-32000,
#         data.state='spawn_failed', data.bucket='spawn_failed_start'.
#   T3.2  data.spawnStderr non-empty AND carries the structured marker line
#         emitted by the failing helper.
#   T3.3  time from send to id=3's error response < 10s (NOT 180s).
#   T3.4  id=3's diagnostic RE-TRIGGERS the spawn (spawnTriggered was reset):
#         configure counter climbs 1 → 2.
#   T3.5  the failure latch re-arms — id=4 gets the real spawn_failed
#         diagnostic again, NEVER a warmup hint after a real failure.
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1085_t3_spawn_fail.sh

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

CFG_SH=$(make_configure_mock "$CFG_COUNTER" 0 "$MOCK_WORKTREE")
# rc=1, spawn=0 → start always fails, no listener (editor never boots).
START_SH=$(make_start_mock "$START_COUNTER" 1 0)

sep "T3: warmup hint first, then one-shot spawn_failed diagnostic on the retry"
start_proxy \
    "GODOT_PORT=$PORT" \
    "KOL_AGENT_NAME=Bachi" \
    "KOL_WORKTREE=$MOCK_WORKTREE" \
    "KOL_CONFIGURE_SH=$CFG_SH" \
    "KOL_START_SH=$START_SH" \
    "KOL_CONFIGURE_COUNTER=$CFG_COUNTER" \
    "KOL_START_COUNTER=$START_COUNTER" \
    "KOL_WARMUP_TIMEOUT_MS=15000" \
    "KOL_HOT_WARMUP_TIMEOUT_MS=5000" \
    "KOL_SPAWN_RETRY_BACKOFF_MS=200" \
    "KOL_PROBE_INTERVAL_MS=200" \
    "MOCK_NPX_LOG=$TMPDIR/npx.log"

send_line "$INIT_LINE"
wait_for "$PROXY_OUT" '"id":1' 1500 || ko "T3.pre: initialize not answered"

# T3.0 — the call that TRIGGERED the spawn is HELD while the spawn runs
# (hold-to-warm). The async failure lands while id=2 is in the FIFO, so
# handleSpawnFailure's rejectQueue answers id=2 with the real spawn_failed
# diagnostic — never a friendly "warming" hint (误报防护).
send_line "$(call_line 2)"
# The spawn failure is asynchronous: wait for the failure to latch and reject.
if wait_for "$PROXY_ERR" 'editor spawn failed' 8000; then
    ok "T3.0.pre: spawn failure latched (async, after the hold began)"
else
    note "T3.0: spawn failure not yet logged (timing)"
fi
if wait_for "$PROXY_OUT" '"id":2' 10000; then
    ok "T3.0a: held id=2 answered by rejectQueue (spawn_failed diagnostic)"
else
    ko "T3.0a: no id=2 response"
fi
SNAP0="$TMPDIR/t3_snap0.out"; cp "$PROXY_OUT" "$SNAP0"
if grep -q '"state": *"spawn_failed"' "$SNAP0"; then
    ok "T3.0b: id=2 carried the REAL spawn_failed diagnostic (误报防护 — never a warming hint on failure)"
else
    ko "T3.0b: id=2 response is not a spawn_failed diagnostic (hint leaked?)"
fi
if grep -q 'editor 正在预热中（冷启动约需 60s）' "$SNAP0"; then
    ko "T3.0c: warmup-hint text appeared alongside a real failure (误报防护 violated)"
else
    ok "T3.0c: no warmup-hint text anywhere (real failure → real diagnostic)"
fi

# T3.1 — id=3 (the retry) gets the ONE-SHOT spawn_failed diagnostic.
send_line "$(call_line 3)"
T_SEND=$(date +%s%3N)
if wait_for "$PROXY_OUT" '"id":3' 10000; then
    T_RECV=$(date +%s%3N)
    LAT=$(( T_RECV - T_SEND ))
    if (( LAT < 10000 )); then
        ok "T3.3: spawn_failed diagnostic returned in ${LAT}ms (well under 10s; not the 180s warmup)"
    else
        ko "T3.3: diagnostic took ${LAT}ms (≥ 10s — synchronous diagnostic failed)"
    fi
else
    ko "T3.3: no id=3 response within 10s (spawn failure never surfaced to the retry)"
fi

SNAP="$TMPDIR/t3_snap.out"; cp "$PROXY_OUT" "$SNAP"

# T3.1: error envelope shape on the id=3 diagnostic.
if grep -q '"code": *-32000' "$SNAP"; then
    ok "T3.1a: error code=-32000"
else
    ko "T3.1a: error code != -32000"
fi
if grep -q '"state": *"spawn_failed"' "$SNAP"; then
    ok "T3.1b: data.state='spawn_failed'"
else
    ko "T3.1b: data.state missing or != 'spawn_failed'"
fi
if grep -q '"bucket": *"spawn_failed_start"' "$SNAP"; then
    ok "T3.1c: data.bucket='spawn_failed_start'"
else
    ko "T3.1c: data.bucket missing or != 'spawn_failed_start'"
fi

# T3.2: structured stderr carried through to the diagnostic.
if grep -q '"spawnStderr"' "$SNAP" && grep -q '启动失败诊断' "$SNAP"; then
    ok "T3.2: data.spawnStderr carries the structured marker line"
else
    ko "T3.2: structured stderr not surfaced in spawnStderr"
fi
if grep -q '"retryable": *true' "$SNAP"; then
    ok "T3.1d: data.retryable=true (non-terminal; streak=1)"
else
    ko "T3.1d: retryable flag wrong/absent (expected true for streak < 3)"
fi

# T3.4: id=3's spawn_failed diagnostic re-triggered the spawn (spawnTriggered
# was reset on the non-terminal failure): the retry call starts a SECOND spawn
# attempt, so configure counter reaches ≥ 2 (attempt 1 + attempt 2).
# SEE-1192 (同 defect7/defect8 R4.2): the id=3 diagnostic is answered while the
# second spawn pipeline (tcpProbe → prepare → configure counter write) still
# runs asynchronously — a fixed sleep races it under load. Poll the counter
# until it reaches ≥ 2 (bounded budget) instead.
CFG_AFTER=0
for _ in $(seq 1 50); do
    CFG_AFTER=$(count_lines "$CFG_COUNTER")
    (( CFG_AFTER >= 2 )) && break
    sleep 0.1
done
if (( CFG_AFTER >= 2 )); then
    ok "T3.4: spawn re-triggered by the retry call (configure count=$CFG_AFTER ≥ 2) — spawnTriggered reset works"
else
    ko "T3.4: configure not re-invoked (count=$CFG_AFTER) — spawnTriggered stuck"
fi

# T3.5 — 误报防护 holds the OTHER direction too: after the spawn_failed one-shot
# on id=3, the fresh spawn attempt re-armed the latch (attempt 2 also fails), so
# id=4 must again carry the real spawn_failed diagnostic — NEVER a warmup hint.
# The rule: once the spawn has failed, no call gets a "warming" hint.
send_line "$(call_line 4)"
if wait_for "$PROXY_OUT" '"id":4' 10000; then
    ok "T3.5a: id=4 answered"
else
    ko "T3.5a: no id=4 response"
fi
wait_for_stable "$PROXY_OUT" 2000   # SEE-1342 D4
SNAP2="$TMPDIR/t3_snap2.out"; cp "$PROXY_OUT" "$SNAP2"
if grep -q '"state": *"spawn_failed"' "$SNAP2"; then
    ok "T3.5b: id=4 carried the re-armed spawn_failed diagnostic (no stale warmup hint after a real failure)"
else
    ko "T3.5b: id=4 did NOT carry spawn_failed — 误报防护 broken (hint after failure?)"
fi

stop_proxy
summary