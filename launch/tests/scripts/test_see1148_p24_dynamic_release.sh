#!/usr/bin/env bash
# SEE-1148 P2.4: dynamic-port pool-exhaustion fallback, release path (cooldown
# window), and the same-worktree live-holder detection predicate.
#
# Hermetic: sandbox HOME + KOL_PORT_HELD_DIR, force the port probe "free", and
# stub PID liveness. No real listeners, no real git worktrees.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_DIR="$(cd "$SCRIPT_DIR/../../../launch" && pwd)"
SCRIPT_DIR="$LAUNCH_DIR"
export SCRIPT_DIR

SBOX="$(mktemp -d)"
trap 'rm -rf "$SBOX"' EXIT
export HOME="$SBOX"
mkdir -p "$HOME/.multica"
export KOL_PORT_HELD_DIR="$SBOX/held-port"
export _ARBITER_POWERSHELL=""
unset GODOT_HOST || true

die() { echo "DIE: $*" >&2; exit 1; }
# shellcheck source=../../../launch/port-arbiter.lib.sh
source "$LAUNCH_DIR/port-arbiter.lib.sh"
# shellcheck source=../../../launch/port-registry.lib.sh
source "$LAUNCH_DIR/port-registry.lib.sh"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

port_arbiter_port_bound() { return 1; }   # no real listeners in the sandbox

echo "== P2.4.1: pool exhaustion → ensure returns 1 (launcher falls back to legacy) =="
# Pre-hold every dynamic port with a LIVE different-runtime holder so no
# candidate is grantable, then ensure must fail (the launcher logs a WARNING
# and falls back to the legacy table port — tested here at the lib boundary).
for (( p = PORT_DYNAMIC_MIN; p <= PORT_DYNAMIC_MAX; p++ )); do
    mkdir -p "$KOL_PORT_HELD_DIR/$p"
    printf 'runtime_id=Other-x%08d\n' "$p" > "$KOL_PORT_HELD_DIR/$p/meta"
    printf '%s\n' "$$" > "$KOL_PORT_HELD_DIR/$p/pid"
done
port_arbiter_pid_alive() { kill -0 "$1" 2>/dev/null; }   # every holder alive
if port_arbiter_ensure "Bachi-aaaa1111" 4242 >/dev/null 2>&1; then
    bad "ensure granted a port despite full pool exhaustion"
else
    ok "ensure returns 1 on pool exhaustion (launcher legacy fallback path)"
fi
rm -rf "$KOL_PORT_HELD_DIR"
port_arbiter_pid_alive() { return 1; }

echo "== P2.4.2: release stamps released_at and removes the held dir =="
gp="$(port_arbiter_ensure "Bachi-release1" 7000)"
[[ "$gp" =~ ^[0-9]+$ ]] || { bad "setup grant failed"; gp=""; }
if [[ -n "$gp" && -d "$KOL_PORT_HELD_DIR/$gp" ]]; then
    ok "held dir exists after grant ($gp)"
else
    bad "held dir missing after grant"
fi
port_arbiter_release "$gp"
if [[ ! -d "$KOL_PORT_HELD_DIR/$gp" ]]; then
    ok "release removed the held dir ($gp)"
else
    bad "release left the held dir behind ($gp)"
fi

echo "== P2.4.3: same-runtime re-grab after release skips cooldown =="
# Immediately re-ensure under the SAME runtime id — respawn reclaim must not
# be cooled (the proxy respawn path depends on this).
gp2="$(port_arbiter_ensure "Bachi-release1" 7001)"
if [[ "$gp2" == "$gp" ]]; then
    ok "same-runtime re-grab reclaimed $gp instantly after release (no cooldown)"
else
    bad "same-runtime re-grab did not reclaim $gp (got $gp2)"
fi
port_arbiter_release "$gp2" 2>/dev/null || true

echo "== P2.4.4: same-worktree live-holder detection predicate =="
# Replica of the launcher's same-worktree registry scan: a DIFFERENT runtime
# with a FRESH heartbeat holding the SAME worktree must be flagged; a stale
# heartbeat or a different worktree must NOT.
WT="/home/jerry/multica_workspaces/ws/slotA/workdir/KingOfLikes-Godot"
fresh="$(node -e 'process.stdout.write(new Date().toISOString())')"
stale="$(node -e 'process.stdout.write(new Date(Date.now()-120000).toISOString())')"
# Holder H1: same worktree, fresh heartbeat → must be detected.
WT="$WT" FRESH="$fresh" STALE="$stale" REG_PATH="$PORT_REGISTRY_PATH" node -e '
    const fs=require("fs");
    const out={schema_version:1,updated_at:new Date().toISOString(),entries:{
        "Bachi-slotA00":{port:6560,worktree:process.env.WT,heartbeat_at:process.env.FRESH},
        "Bachi-slotB00":{port:6561,worktree:"/other/worktree",heartbeat_at:process.env.FRESH},
        "Bachi-slotC00":{port:6562,worktree:process.env.WT,heartbeat_at:process.env.STALE}
    }};
    fs.writeFileSync(process.env.REG_PATH, JSON.stringify(out,null,2)+"\n");
' 2>/dev/null || die "failed to seed registry"
detect="$(
    REG_PATH="$PORT_REGISTRY_PATH" REG_RID="Bachi-self999" REG_WT="$WT" \
    node -e '
        const fs=require("fs");
        let out="";
        try{
            const cur=JSON.parse(fs.readFileSync(process.env.REG_PATH,"utf8"));
            const entries=(cur&&cur.entries)||{};
            const now=Date.now();
            for(const [rid,e] of Object.entries(entries)){
                if(rid===process.env.REG_RID) continue;
                if(!e||e.worktree!==process.env.REG_WT) continue;
                const hb=e.heartbeat_at?Date.parse(e.heartbeat_at):0;
                if(hb&&(now-hb)<60000){out=rid;break;}
            }
        }catch(err){}
        process.stdout.write(out);
    ' 2>/dev/null || true
)"
if [[ "$detect" == "Bachi-slotA00" ]]; then
    ok "same-worktree LIVE holder detected ($detect)"
else
    bad "same-worktree detection wrong (got '$detect' want Bachi-slotA00)"
fi
# Self must never be flagged as its own contender.
detect_self="$(
    REG_PATH="$PORT_REGISTRY_PATH" REG_RID="Bachi-slotA00" REG_WT="$WT" \
    node -e '
        const fs=require("fs");
        let out="";
        try{
            const cur=JSON.parse(fs.readFileSync(process.env.REG_PATH,"utf8"));
            const entries=(cur&&cur.entries)||{};
            const now=Date.now();
            for(const [rid,e] of Object.entries(entries)){
                if(rid===process.env.REG_RID) continue;
                if(!e||e.worktree!==process.env.REG_WT) continue;
                const hb=e.heartbeat_at?Date.parse(e.heartbeat_at):0;
                if(hb&&(now-hb)<60000){out=rid;break;}
            }
        }catch(err){}
        process.stdout.write(out);
    ' 2>/dev/null || true
)"
if [[ -z "$detect_self" ]]; then
    ok "self-runtime never flagged as same-worktree contender"
else
    bad "self-runtime mis-flagged as contender ($detect_self)"
fi

echo "== summary: pass=$PASS fail=$FAIL =="
(( FAIL == 0 )) || exit 1
exit 0
