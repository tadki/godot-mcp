#!/usr/bin/env bash
# test_see1292_lease_reactivation.sh
#
# SEE-1292 respawn-round lease reactivation (AC-DECPL-009 prerequisite).
#
# Live-machine failure this guards against (Revy ⑤ QA, 2026-09-12): after an
# editor lease self-exit, the respawn/chain-restart round's editor read
# state=released from .godot/mcp-lease.json and fell back to the default port
# 6550 — the proxy then probed the registry port until the 300s warmup window
# expired (SYN-SENT). Root cause: concurrent same-agent slots share the
# per-LABEL lifecycle files, so a foreign evict's stop/reap released the slot's
# fresh active lease inside the window between configure's write and the editor
# boot.
#
# Fix under test (proxy side, defense in depth):
#   F1  lease-activation assertion — ensureEditor's spawn path re-runs
#       configure until the sidecar reads active@GODOT_PORT (bounded 3), AFTER
#       the first configure and BEFORE START_SH runs.
#   F2  scoped eviction — evictStaleHolder pins stop's release target to the
#       STALE HOLDER's worktree (--project-godot) and scopes the reaper sweep
#       to it, so evicting a dead holder can never release a live foreign
#       slot's lease.
#
# Cases (REAL configure-mcp-port.sh against a fixture worktree, mock start):
#   R1  cold spawn with a PRE-RELEASED lease (the live failure's starting
#       state) → configure rewrites it; lease is active@port with a FRESH
#       configured_at and released_at cleared BEFORE start fires.
#   R2  hot-reuse configure is a no-op on a clean active lease (lease_id and
#       configured_at unchanged — Archi A2 oracle preserved).
#   R3  evict stop honors --project-godot (release-pinned): the pinned
#       worktree's lease is released, a FOREIGN slot's fresh active lease on
#       the same label is NOT touched.
#
# Run: bash launch/tests/scripts/test_see1292_lease_reactivation.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_DIR="$(cd "$SCRIPT_DIR/../../" && pwd)"
FORK_ROOT="$(cd "$LAUNCH_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

free_port() {
    python3 - <<'PY'
import socket, random
for p in random.sample(range(20000, 40000), 200):
    try:
        s = socket.socket(); s.bind(('127.0.0.1', p)); s.close(); print(p); break
    except OSError:
        continue
PY
}

make_fixture_worktree() { # <dir> — project.godot + .godot/ (no .git: the
    # configure write-target branch guard only inspects checkouts WITH .git)
    local d="$1"
    mkdir -p "$d/.godot"
    printf 'config_version=5\n' > "$d/project.godot"
}

seed_released_lease() { # <worktree> <port>
    LEASE="$1" WT="$1" PORT="$2" python3 - <<'PY'
import json, os, datetime
p = os.path.join(os.environ['LEASE'], '.godot', 'mcp-lease.json')
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
json.dump({
    "schema_version": 2, "runtime_id": "Bachi-see1292fix", "task_id": "",
    "port": int(os.environ['PORT']), "agent": "Bachi", "label": "bachi",
    "state": "released", "lease_id": "12920000-0000-0000-0000-000000000001",
    "worktree": os.environ['WT'], "configured_at": now,
    "configured_by_pid": os.getpid(), "released_at": now, "notes": "prior round"
}, open(p, 'w'), indent=2)
PY
}

lease_field() { # <worktree> <field>
    python3 -c "
import json,sys
try:
    d=json.load(open('$1/.godot/mcp-lease.json'))
    v=d.get('$2')
    print('' if v is None else v)
except Exception:
    print('')"
}

echo "== R1: pre-released lease → spawn-path configure reactivates it (fresh configured_at, traces cleared) =="
PORT1="$(free_port)"
WT1="$TMP/wt1"; make_fixture_worktree "$WT1"
seed_released_lease "$WT1" "$PORT1"
BEFORE_TS="$(lease_field "$WT1" configured_at)"
CFG_LOG="$TMP/cfg-r1.log"
# Run the REAL configure exactly the way the proxy's spawn path does
# (buildHelperArgs: [agent] --port <p> --project-godot <path>).
KOL_RUNTIME_ID=Bachi-see1292fix KOL_AGENT_NAME=Bachi GODOT_MCP_HOME="$TMP/home" \
    bash "$LAUNCH_DIR/configure-mcp-port.sh" Bachi --port "$PORT1" --project-godot "$WT1/project.godot" \
    >"$CFG_LOG" 2>&1
CFG_RC=$?
[[ "$CFG_RC" == "0" ]] && ok "configure rc=0 on released lease" || bad "configure rc=$CFG_RC (log: $(tail -2 "$CFG_LOG"))"
[[ "$(lease_field "$WT1" state)" == "active" ]] && ok "lease state rewritten to active" || bad "lease state=$(lease_field "$WT1" state)"
[[ -z "$(lease_field "$WT1" released_at)" ]] && ok "released_at trace cleared" || bad "released_at=$(lease_field "$WT1" released_at)"
AFTER_TS="$(lease_field "$WT1" configured_at)"
[[ -n "$AFTER_TS" && "$AFTER_TS" != "$BEFORE_TS" ]] && ok "configured_at refreshed ($BEFORE_TS → $AFTER_TS)" || bad "configured_at not refreshed"
# Historical semantic (SEE-1152): lease_id is preserved only for an
# active-lease cleanup rewrite (state==active && port match); a RELEASED lease
# gets a fresh identity — a new round is a new lease. The A2 oracle binds the
# identity to the active-cleanup path, not to respawn reactivation.
[[ "$(lease_field "$WT1" lease_id)" != "12920000-0000-0000-0000-000000000001" ]] && ok "released-lease reactivation issues a fresh lease_id (new round = new lease)" || bad "unexpected lease_id carryover"
[[ "$(lease_field "$WT1" port)" == "$PORT1" ]] && ok "lease port = target port" || bad "lease port=$(lease_field "$WT1" port) want $PORT1"

echo "== R2: clean active lease → fast path is a no-op (no rewrite churn) =="
sleep 1.1   # ensure a rewrite WOULD move configured_at measurably
CFG_LOG2="$TMP/cfg-r2.log"
KOL_RUNTIME_ID=Bachi-see1292fix KOL_AGENT_NAME=Bachi GODOT_MCP_HOME="$TMP/home" \
    bash "$LAUNCH_DIR/configure-mcp-port.sh" Bachi --port "$PORT1" --project-godot "$WT1/project.godot" \
    >"$CFG_LOG2" 2>&1
[[ $? == "0" ]] && ok "second configure rc=0" || bad "second configure failed"
grep -q "Fast path" "$CFG_LOG2" && ok "fast path taken (no rewrite)" || bad "fast path NOT taken: $(tail -2 "$CFG_LOG2")"
[[ "$(lease_field "$WT1" configured_at)" == "$AFTER_TS" ]] && ok "configured_at untouched by fast path" || bad "fast path rewrote configured_at"
R1_LEASE_ID="$(lease_field "$WT1" lease_id)"
[[ "$(lease_field "$WT1" lease_id)" == "$R1_LEASE_ID" ]] && ok "lease_id untouched by fast path" || bad "fast path regenerated lease_id"

echo "== R3: evict stop honors --project-godot (foreign active lease untouched) =="
PORT2="$(free_port)"
# Holder fixture: the stale holder's worktree (its lease WILL be released).
WTH="$TMP/wt-holder"; make_fixture_worktree "$WTH"
seed_released_lease "$WTH" "$PORT2"
# Foreign fixture: a LIVE same-label slot's fresh ACTIVE lease that must
# survive the eviction (the respawn-round bug released exactly this).
WTF="$TMP/wt-foreign"; make_fixture_worktree "$WTF"
KOL_RUNTIME_ID=Bachi-foreignslot KOL_AGENT_NAME=Bachi GODOT_MCP_HOME="$TMP/home" \
    bash "$LAUNCH_DIR/configure-mcp-port.sh" Bachi --port "$PORT2" --project-godot "$WTF/project.godot" >/dev/null 2>&1
[[ "$(lease_field "$WTF" state)" == "active" ]] && ok "foreign lease seeded active" || bad "foreign lease seed failed"
KOL_REAP_DISABLE_PWSH=1 KOL_STAGE_LOG=off GODOT_MCP_HOME="$TMP/home" \
    bash "$LAUNCH_DIR/stop-godot-editor.sh" Bachi --port "$PORT2" --project-godot "$WTH/project.godot" \
    >"$TMP/stop-r3.log" 2>&1
[[ $? == "0" || $? == "2" ]] || bad "stop rc unexpected"
grep -q "release target pinned by --project-godot" "$TMP/stop-r3.log" && ok "stop pinned release to holder worktree" || bad "stop did not honor --project-godot: $(head -3 "$TMP/stop-r3.log")"
[[ "$(lease_field "$WTH" state)" == "released" ]] && ok "holder lease released" || bad "holder lease state=$(lease_field "$WTH" state)"
[[ "$(lease_field "$WTF" state)" == "active" ]] && ok "FOREIGN slot's active lease survived the eviction (respawn fix)" || bad "foreign lease was released by the evict (regression)"

echo ""
echo "==== SEE-1292 lease reactivation: PASS=$PASS FAIL=$FAIL ===="
[[ "$FAIL" -eq 0 ]]
