#!/usr/bin/env bash
# SEE-1148 P2: port-arbiter.lib.sh — allocation concurrency (T3), cooldown
# boundary (T13), and the reuse/evict decision tree branches (B-1 respawn /
# B-2 cross-runtime evict).
#
# Hermetic: overrides KOL_PORT_HELD_DIR + HOME into a sandbox, forces the
# /dev/tcp probe to report "free" (no listener is actually bound in the
# sandbox), and stubs port_arbiter_port_bound where a "busy" port is needed.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_DIR="$(cd "$SCRIPT_DIR/../../../launch" && pwd)"
SCRIPT_DIR="$LAUNCH_DIR"   # arbiter resolves held dir from SCRIPT_DIR
export SCRIPT_DIR

SBOX="$(mktemp -d)"
trap 'rm -rf "$SBOX"' EXIT
export HOME="$SBOX"
mkdir -p "$HOME/.multica"
export KOL_PORT_HELD_DIR="$SBOX/held-port"
# No listener is actually bound in the sandbox — force the probe OFF so the
# mkdir layer is what decides (this is what the unit under test arbitrates).
export _ARBITER_POWERSHELL=""
unset GODOT_HOST || true

die() { echo "DIE: $*" >&2; exit 1; }
# shellcheck source=../../../launch/port-arbiter.lib.sh
source "$LAUNCH_DIR/port-arbiter.lib.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# Deterministic free-port probe (no real listeners in the sandbox).
port_arbiter_port_bound() { return 1; }

echo "== T3.1: sequential allocation grants distinct dynamic ports =="
p1="$(port_arbiter_ensure "Bachi-aaaa1111" 1000)"
p2="$(port_arbiter_ensure "Bachi-bbbb2222" 1001)"
if [[ "$p1" =~ ^[0-9]+$ && "$p2" =~ ^[0-9]+$ && "$p1" != "$p2" ]]; then
    ok "two runtimes got distinct ports ($p1 vs $p2)"
else
    bad "distinct-port guarantee broken (p1=$p1 p2=$p2)"
fi
if (( p1 >= PORT_DYNAMIC_MIN && p1 <= PORT_DYNAMIC_MAX && p2 >= PORT_DYNAMIC_MIN && p2 <= PORT_DYNAMIC_MAX )); then
    ok "grants land in the dynamic pool ${PORT_DYNAMIC_MIN}-${PORT_DYNAMIC_MAX}"
else
    bad "grant outside dynamic pool (p1=$p1 p2=$p2)"
fi
# Dynamic pool must NOT touch the legacy reserved range.
if (( p1 < 6551 || p1 > 6556 )) && (( p2 < 6551 || p2 > 6556 )); then
    ok "grants avoid the legacy reserved pool 6551-6556 (physical isolation)"
else
    bad "grant collided with legacy reserved pool"
fi

echo "== T3.2: concurrent allocation — N racers each get a distinct port =="
# 6 parallel racers on the same dynamic pool. mkdir arbitration must give
# each a UNIQUE port (no two winners on one port).
N=6
: > "$SBOX/races.txt"
for i in $(seq 1 "$N"); do
    (
        port="$(port_arbiter_ensure "Racer-$(printf '%08d' "$i")" "20$i")"
        [[ -n "$port" ]] && echo "$port" >> "$SBOX/races.txt"
    ) &
done
wait
granted="$(sort -u "$SBOX/races.txt" | grep -cE '^[0-9]+$' || true)"
total="$(grep -cE '^[0-9]+$' "$SBOX/races.txt" || true)"
if [[ "$total" -eq "$N" && "$granted" -eq "$N" ]]; then
    ok "all $N concurrent racers got a unique port (no double-grant)"
else
    bad "concurrency double-grant or starvation (total=$total unique=$granted want=$N)"
fi

echo "== T3.3: registry records the granted port (acceleration layer) =="
rp="$SBOX/.multica/godot-port-registry.json"
if [[ -f "$rp" ]] && grep -q '"port": '"$p1" "$rp"; then
    ok "registry recorded granted port $p1"
else
    bad "registry missing granted port $p1"
fi

echo "== T13.1: same-runtime reuse skips the cooldown =="
# Runtime re-ensures the SAME slot: a respawn reclaiming its own warm port is
# NOT cooled. Release then immediately re-acquire under the same runtime id.
port_arbiter_release "$p1"
p1b="$(port_arbiter_ensure "Bachi-aaaa1111" 1099)"
if [[ "$p1b" == "$p1" ]]; then
    ok "same-runtime respawn reclaimed its port $p1 instantly (cooldown skipped)"
else
    bad "same-runtime respawn did NOT reclaim port (got $p1b want $p1)"
fi

echo "== T13.2: cross-runtime grant honors the 60s cooldown =="
# Port $p2 was granted to Bachi-bbbb2222 and NOT released cleanly here — its
# held dir exists with a LIVE pid (we plant the test's own shell pid as a live
# holder). A DIFFERENT runtime must NOT take it (live holder + within window).
mkdir -p "$KOL_PORT_HELD_DIR/$p2"
printf 'runtime_id=Bachi-bbbb2222\n' > "$KOL_PORT_HELD_DIR/$p2/meta"
printf '%s\n' "$$" > "$KOL_PORT_HELD_DIR/$p2/pid"   # $$ is alive (bash, not node — see below)
# Force the alive check to treat $$ as a live node holder (anti-reuse check is
# covered separately; here we only exercise the cooldown/live-holder branch).
port_arbiter_pid_alive() { kill -0 "$1" 2>/dev/null; }
if port_arbiter_try_acquire "$p2" "Revy-cccc3333" 5555; then
    bad "cross-runtime grabbed a live-held port (cooldown bypassed)"
else
    ok "cross-runtime grant refused on a live-held port"
fi

echo "== T13.3: cooldown expires → cross-runtime grant allowed =="
# Age the held dir's mtime beyond the cooldown so a different runtime may
# reclaim a port whose holder proxy is dead.
mkdir -p "$KOL_PORT_HELD_DIR/6599"
printf 'runtime_id=Old-dead9999\n' > "$KOL_PORT_HELD_DIR/6599/meta"
printf '999999\n' > "$KOL_PORT_HELD_DIR/6599/pid"    # dead pid
touch -d "120 seconds ago" "$KOL_PORT_HELD_DIR/6599"
port_arbiter_pid_alive() { return 1; }                 # holder provably dead
if port_arbiter_try_acquire "6599" "Revy-cccc3333" 5555; then
    ok "cross-runtime grant allowed after cooldown expiry (stale reclaimed)"
    port_arbiter_release "6599"
else
    bad "cross-runtime grant refused even after cooldown expiry"
fi

echo "== B-1: PID dead + same runtime id → respawn (wait, do NOT mis-kill) =="
# The port is busy and its held dir names OUR runtime but its proxy pid is
# dead → this is OUR editor mid-respawn. Decision must be 'respawn' so the
# proxy WAITS for release instead of evicting its own re-appearing editor.
mkdir -p "$KOL_PORT_HELD_DIR/6570"
printf 'runtime_id=Bachi-aaaa1111\n' > "$KOL_PORT_HELD_DIR/6570/meta"
printf '999998\n' > "$KOL_PORT_HELD_DIR/6570/pid"    # dead proxy pid
port_arbiter_port_bound() { return 0; }                # port is busy
port_arbiter_pid_alive() { return 1; }                 # proxy dead
d="$(port_arbiter_decide 6570 "Bachi-aaaa1111")"
if [[ "$d" == "respawn" ]]; then
    ok "same-runtime dead-proxy → respawn (wait-for-release, no mis-kill)"
else
    bad "B-1 decision wrong (got '$d' want respawn)"
fi
port_arbiter_release 6570

echo "== B-2: PID dead + runtime id mismatch → immediate evict (no 300s wait) =="
mkdir -p "$KOL_PORT_HELD_DIR/6571"
printf 'runtime_id=Other-stale777\n' > "$KOL_PORT_HELD_DIR/6571/meta"
printf '999997\n' > "$KOL_PORT_HELD_DIR/6571/pid"    # dead proxy pid
port_arbiter_port_bound() { return 0; }
port_arbiter_pid_alive() { return 1; }
d="$(port_arbiter_decide 6571 "Bachi-aaaa1111")"
if [[ "$d" == "evict" ]]; then
    ok "cross-runtime dead-proxy → immediate evict (cold-start, seconds not 300s)"
else
    bad "B-2 decision wrong (got '$d' want evict)"
fi
port_arbiter_release 6571

echo "== B-3: PID alive + same runtime → reuse (hot takeover) =="
mkdir -p "$KOL_PORT_HELD_DIR/6572"
printf 'runtime_id=Bachi-aaaa1111\n' > "$KOL_PORT_HELD_DIR/6572/meta"
printf '4242\n' > "$KOL_PORT_HELD_DIR/6572/pid"
port_arbiter_port_bound() { return 0; }
port_arbiter_pid_alive() { [[ "$1" == "4242" ]]; }     # our holder alive
d="$(port_arbiter_decide 6572 "Bachi-aaaa1111")"
[[ "$d" == "reuse" ]] && ok "same-runtime live-proxy → reuse (hot takeover)" \
                      || bad "B-3 decision wrong (got '$d' want reuse)"
port_arbiter_release 6572

echo "== B-4: PID alive + different runtime → busy_foreign (editor_busy) =="
mkdir -p "$KOL_PORT_HELD_DIR/6573"
printf 'runtime_id=Other-live8888\n' > "$KOL_PORT_HELD_DIR/6573/meta"
printf '4243\n' > "$KOL_PORT_HELD_DIR/6573/pid"
port_arbiter_port_bound() { return 0; }
port_arbiter_pid_alive() { [[ "$1" == "4243" ]]; }
d="$(port_arbiter_decide 6573 "Bachi-aaaa1111")"
[[ "$d" == "busy_foreign" ]] && ok "cross-runtime live-proxy → busy_foreign (editor_busy retryable)" \
                            || bad "B-4 decision wrong (got '$d' want busy_foreign)"
port_arbiter_release 6573

echo "== T16: dynamic port distinct from every legacy reserved port =="
legacy_bad=0
for lp in 6551 6552 6553 6554 6555 6556; do
    [[ "$p1" == "$lp" || "$p2" == "$lp" ]] && legacy_bad=1
done
[[ "$legacy_bad" == "0" ]] && ok "dynamic grant never equals a legacy reserved port" \
                           || bad "dynamic grant collided with a legacy reserved port"

echo "== summary: pass=$PASS fail=$FAIL =="
(( FAIL == 0 )) || exit 1
exit 0
