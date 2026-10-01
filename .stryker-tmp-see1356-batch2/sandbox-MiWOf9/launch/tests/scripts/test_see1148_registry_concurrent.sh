#!/usr/bin/env bash
# SEE-1148 registry concurrent upsert race regression.
#
# Revy P1 review §A3+A4 (HIGH): under the prior mktemp+mv-only pattern,
# 5 concurrent writers to the same rid lost 4 of 5 writers' fields
# (read-modify-write inside node was unlocked). Fix: flock short critical
# section around the read-modify-write-publish block.
#
# The test reproduces the race the reviewer described:
#   1. Fire 5 parallel writers, each upserting a UNIQUE kv pair to the
#      same rid. Wait for all 5.
#   2. Assert the final registry has ALL 5 writers' fields — none lost.
#   3. Also assert that the flock non-blocking die path works: hold the
#      lock in a subshell, attempt a 2nd upsert, expect die.
#
# Note: because flock is non-blocking, two writers can serialize without
# data loss — that's the entire point. The test asserts the observable
# property (final state has all 5 fields), not the implementation detail
# (which of the 5 won the lock first).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_DIR="$(cd "$SCRIPT_DIR/../../../launch" && pwd)"

# Isolate HOME so we don't touch the real ~/.multica registry.
SBOX="$(mktemp -d)"
export HOME="${SBOX}"
mkdir -p "${HOME}/.multica"
trap 'rm -rf "$SBOX"' EXIT

# shellcheck source=../../../launch/port-registry.lib.sh
source "$LAUNCH_DIR/port-registry.lib.sh"
die() { echo "DIE: $*" >&2; exit 1; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "== RC.1: 5 concurrent writers → all 5 fields preserved (flock fix) =="
RID="Bachi-fe7bb0db"
# Reset state for a clean test.
rm -f "${PORT_REGISTRY_PATH}" "${PORT_REGISTRY_PATH}.lock"
# Each writer upserts a unique kv pair to the same rid. Fire-and-forget
# background subshells; `wait` collects them. Capture each writer's exit
# status; the test passes if EVERY writer's field is in the final state
# regardless of which one lost any internal race. With blocking flock,
# all 5 should succeed cleanly; with the prior mktemp+mv-only pattern,
# the same writers lose fields.
WRITER_LOG="${SBOX}/writer_log.txt"
: > "$WRITER_LOG"
for i in 1 2 3 4 5; do
    (
        if port_registry_upsert "$RID" \
            "writer${i}_field=w${i}" \
            "writer${i}_ts=$(date -u +%s%N)" 2>>"$WRITER_LOG"; then
            echo "writer $i OK" >> "$WRITER_LOG"
        fi
    ) &
done
wait
# Read back the final registry and assert each writer's field is present.
ALL_OK=1
GOT=""
for i in 1 2 3 4 5; do
    f="$(port_registry_get "$RID" "writer${i}_field")"
    GOT="${GOT} w${i}=${f}"
    [[ "$f" == "w${i}" ]] || ALL_OK=0
done
if (( ALL_OK == 1 )); then
    ok "all 5 writers' fields preserved (final=$GOT)"
else
    bad "lost-update regression: $GOT"
fi

echo "== RC.2: held-lock contention is serialized (blocking flock) — 2nd upsert waits and succeeds =="
# Reset state for a clean lock test.
rm -f "${PORT_REGISTRY_PATH}" "${PORT_REGISTRY_PATH}.lock"
# Open the lockfile in a background subshell, hold the flock for ~0.5s.
LOCK_HOLDER_PID=""
(
    exec 9>"${PORT_REGISTRY_PATH}.lock"
    flock 9
    sleep 0.5   # 竞态窗口语义（CLAUDE.md 边界）：锁持有时长即被测的争抢窗口
) &
LOCK_HOLDER_PID=$!
sleep 0.05  # 竞态窗口语义（CLAUDE.md 边界）：保证 holder 先夺锁的交错时序，即被测行为
START_MS="$(date +%s%N)"
port_registry_upsert "$RID" "port=6553" "agent=Bachi" 2>&1
END_MS="$(date +%s%N)"
ELAPSED_MS=$(( (END_MS - START_MS) / 1000000 ))
# Should have waited for the holder (~500ms) then succeeded.
wait "$LOCK_HOLDER_PID" 2>/dev/null || true
PORT_GOT="$(port_registry_get "$RID" port)"
AGENT_GOT="$(port_registry_get "$RID" agent)"
if [[ "$PORT_GOT" == "6553" && "$AGENT_GOT" == "Bachi" ]] && (( ELAPSED_MS >= 300 )); then
    ok "blocking flock serialized 2nd upsert (waited ${ELAPSED_MS}ms, then succeeded)"
else
    bad "blocking flock did not serialize: elapsed=${ELAPSED_MS}ms port=$PORT_GOT agent=$AGENT_GOT"
fi

echo "== RC.3: sequential upserts to same rid do NOT lose prior fields (preserved) =="
rm -f "${PORT_REGISTRY_PATH}" "${PORT_REGISTRY_PATH}.lock"
port_registry_upsert "$RID" "field_a=A1" "field_b=B1"
port_registry_upsert "$RID" "field_c=C1"
A="$(port_registry_get "$RID" field_a)"
B="$(port_registry_get "$RID" field_b)"
C="$(port_registry_get "$RID" field_c)"
if [[ "$A" == "A1" && "$B" == "B1" && "$C" == "C1" ]]; then
    ok "sequential upserts preserve prior fields (a=$A b=$B c=$C)"
else
    bad "sequential upsert lost fields: a=$A b=$B c=$C"
fi

echo "== RC summary: pass=$PASS fail=$FAIL =="
(( FAIL == 0 )) || exit 1
exit 0
