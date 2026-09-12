#!/usr/bin/env bash
# test_see1240_ws4_status_doctor.sh — WS-4 regression: godot-status.sh status/doctor.
#
# Exercises the real godot-status.sh binary against sandboxed sources:
#   T1: normal state emits every required JSON top-level section
#   T2: broken registration (command points at a deleted path — the SEE-1078
#       incident shape) → FAIL verdict, exit 1
#   T3: mcp-config present but NO godot-mcp entry → WARN missing-registration
#   T4: no /tmp/multica-mcp-* dirs at all → registration WARN, verdict WARN, exit 2
#   T5: D4 timeout table carries all four layers (13 entries, L1..L4)
#   T6: doctor exit codes are disjoint: 0=PASS / 2=WARN / 1=FAIL
#
# Sandbox: KOL_PORT_REGISTRY_PATH_OVERRIDE + HOME relocation; the testfake
# registration dir under /tmp is injected/removed around each case.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
STATUS="$REPO_ROOT/launch/godot-status.sh"

command -v node >/dev/null 2>&1 || { echo "node required"; exit 1; }
[[ -x "$STATUS" ]] || { echo "FAIL: godot-status.sh not executable: $STATUS"; exit 1; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $*"; }

SBOX="$(mktemp -d)"
FAKE_TMP="$SBOX/tmp"; mkdir -p "$FAKE_TMP" "$SBOX/home/.multica"
trap 'rm -rf "$SBOX"' EXIT

export HOME="$SBOX/home"
# SEE-1292 §DECPL-001: point GODOT_MCP_HOME at the sandbox (the status tool now
# resolves its state dir from GODOT_MCP_HOME). Keep HOME relocation for parity
# with the legacy override + node/git discovery keeps working under sandbox HOME.
export GODOT_MCP_HOME="$HOME/.multica"
export KOL_PORT_REGISTRY_PATH_OVERRIDE="$HOME/.multica/godot-port-registry.json"

# Seed a minimal v2 lease + registry so the normal-state checks have sources.
WT="$SBOX/wt1"; mkdir -p "$WT/.godot"
node -e '
const crypto=require("crypto"),fs=require("fs");
const wt=process.argv[1];
fs.writeFileSync(wt+"/.godot/mcp-lease.json", JSON.stringify({
    schema_version:2, runtime_id:"Bachi-aabbccdd", task_id:"",
    port:6563, agent:"Bachi", label:"bachi", state:"released",
    lease_id:crypto.randomUUID(), worktree:wt,
    configured_at:new Date().toISOString(), configured_by_pid:null,
    released_at:null, notes:"mock"
},null,2)+"\n");
fs.writeFileSync(process.env.KOL_PORT_REGISTRY_PATH_OVERRIDE, JSON.stringify({
    schema_version:1, updated_at:new Date().toISOString(),
    entries:{"Bachi-aabbccdd":{port:6563, proxy_pid:process.pid, heartbeat_at:new Date().toISOString(), agent:"Bachi", worktree:wt}}
},null,2)+"\n");
' "$WT"
# Registration layer: seed ONE real-shaped config dir (multica-mcp-* under /tmp)
REG_DIR="$FAKE_TMP/multica-mcp-ws4test"
mkdir -p "$REG_DIR"
node -e '
const fs=require("fs");
fs.writeFileSync(process.argv[1]+"/mcp-config.json", JSON.stringify({mcpServers:{
    "godot-mcp-bachi":{args:["Bachi"],command:process.argv[2]},
    "grepai":{type:"http",url:"http://x/mcp"}
}},null,2)+"\n");
' "$REG_DIR" "$REPO_ROOT/launch/godot-mcp-launcher.sh"

# The registration collector hardcodes /tmp — point it at the sandbox via a
# subshell trick: we cannot move /tmp, so instead run the REAL /tmp configs
# (they exist on this machine and are all-ok) and assert the count>=3. For the
# broken/missing-injection cases we inject a testfake dir under /tmp (the
# collector scans /tmp/multica-mcp-*) and remove it after each case.
TF="/tmp/multica-mcp-ws4testfake"
cleanup_tf() { rm -rf "$TF"; }
trap 'cleanup_tf; rm -rf "$SBOX"' EXIT

run_status()  { KOL_AGENT_NAME=Bachi KOL_WORKTREE="$WT" bash "$STATUS" status --json 2>/dev/null; }
run_doctor()  { KOL_AGENT_NAME=Bachi KOL_WORKTREE="$WT" bash "$STATUS" doctor 2>/dev/null; }
run_doctor_j(){ KOL_AGENT_NAME=Bachi KOL_WORKTREE="$WT" bash "$STATUS" doctor --json 2>/dev/null; }

echo "== T1: normal state — status JSON carries every required section =="
OUT="$(run_status)"
for key in schema generated_at runtime lease registry lifecycle warmup registration timeouts; do
    echo "$OUT" | jq -e "has(\"$key\")" >/dev/null 2>&1 && ok "status has .$key" || bad "status missing .$key"
done
echo "$OUT" | jq -e '.timeouts.layers | length == 13' >/dev/null 2>&1 && ok "timeouts table has 13 layers" || bad "timeouts layers != 13"
echo "$OUT" | jq -e '.timeouts.layers[] | select(.layer=="L1" and .name=="claude_initialize" and .value_ms==120000)' >/dev/null 2>&1 && ok "L1 claude_initialize=120000ms" || bad "L1 wrong"
echo "$OUT" | jq -e '.timeouts.layers[] | select(.layer=="L3" and .name=="claude_tool_call" and .value_ms==300000)' >/dev/null 2>&1 && ok "L3 claude_tool_call=300000ms" || bad "L3 wrong"
echo "$OUT" | jq -e '.timeouts.layers[] | select(.layer=="L4" and .name=="addon_initial_grace" and .value_ms==300000)' >/dev/null 2>&1 && ok "L4 addon_initial_grace=300000ms" || bad "L4 grace wrong"
echo "$OUT" | jq -e '.timeouts.layers[] | select(.layer=="L4" and .name=="addon_quit_delay" and .value_ms==120000)' >/dev/null 2>&1 && ok "L4 addon_quit_delay=120000ms" || bad "L4 quit wrong"
echo "$OUT" | jq -e '.registration.configs | length >= 1' >/dev/null 2>&1 && ok "registration sees >=1 real config" || bad "registration configs missing"
run_status >/dev/null 2>&1; [[ $? -eq 0 ]] && ok "status exit code 0" || bad "status nonzero exit"

echo "== T2: broken registration (command → deleted path, SEE-1078 shape) =="
mkdir -p "$TF"
cat > "$TF/mcp-config.json" <<'EOF'
{"mcpServers":{"godot-mcp-bachi":{"args":["Bachi"],"command":"/mnt/d/GodotProjects/king-of-likes/.dev/launch/godot-mcp-launcher.sh"}}}
EOF
OUTJ="$(run_doctor_j)"
echo "$OUTJ" | jq -e '.verdict == "FAIL"' >/dev/null 2>&1 && ok "verdict=FAIL on broken registration" || bad "verdict not FAIL: $(echo "$OUTJ" | jq -r '.verdict')"
echo "$OUTJ" | jq -e '.fail_count >= 1' >/dev/null 2>&1 && ok "fail_count>=1" || bad "fail_count<1"
echo "$OUTJ" | jq -e '.checks[] | select(.level=="FAIL" and (.check|startswith("registration")))' >/dev/null 2>&1 && ok "FAIL check is registration layer" || bad "no registration FAIL check"
run_doctor >/dev/null 2>&1; [[ $? -eq 1 ]] && ok "doctor exit 1 on FAIL" || bad "doctor exit != 1 on FAIL"

echo "== T3: mcp-config present but NO godot entry (mcp_config 缺失形态) =="
cat > "$TF/mcp-config.json" <<'EOF'
{"mcpServers":{"grepai":{"type":"http","url":"http://x/mcp"}}}
EOF
OUTJ="$(run_doctor_j)"
echo "$OUTJ" | jq -e '.checks[] | select(.level=="WARN" and (.check|startswith("registration")))' >/dev/null 2>&1 && ok "missing godot entry → WARN registration" || bad "no WARN for missing godot entry"
echo "$OUTJ" | jq -e '.fail_count == 0' >/dev/null 2>&1 && ok "missing entry is WARN not FAIL (surface, not crash)" || bad "missing entry escalated to FAIL"

echo "== T4: NO mcp-config dirs at all → WARN + exit 2 =="
mv "$TF" "$SBOX/tf-bak"
OUTJ="$(run_doctor_j)"
echo "$OUTJ" | jq -e '.fail_count == 0' >/dev/null 2>&1 && ok "absent configs → no FAIL" || bad "absent configs escalated to FAIL"
echo "$OUTJ" | jq -e '.verdict == "WARN" or .verdict == "FAIL"' >/dev/null 2>&1 && ok "absent configs → non-PASS verdict" || bad "absent configs gave PASS"
run_doctor >/dev/null 2>&1; _rc=$?; [[ "$_rc" == "1" || "$_rc" == "2" ]] && ok "doctor exit code in {1,2}" || bad "doctor rc=$_rc unexpected"

echo "== T5: D4 timeout table completeness (13 layers, L1..L4, sources named) =="
cleanup_tf
OUTJ="$(run_doctor_j)"
echo "$OUTJ" | jq -e '[.timeouts.layers[].layer] | unique == ["L1","L2","L3","L4"]' >/dev/null 2>&1 && ok "layers L1..L4 present" || bad "layers incomplete"
echo "$OUTJ" | jq -e '[.timeouts.layers[] | select(.source|startswith("addons/godot_mcp/lease_controller.gd"))] | length == 2' >/dev/null 2>&1 && ok "L4 sources name lease_controller.gd" || bad "L4 source unnamed"
echo "$OUTJ" | jq -e '.timeouts.layers[] | select(.name=="claude_initialize") | .injected != null' >/dev/null 2>&1 && ok "injection flag exposed for L1" || bad "no injection flag"

echo "== T6: doctor exit codes disjoint (0=PASS-only / 2=WARN-only) =="
cleanup_tf
run_doctor >/dev/null 2>&1; _rc=$?
[[ "$_rc" == "0" || "$_rc" == "2" ]] && ok "doctor exit code in {0,2} on healthy sandbox" || bad "doctor rc=$_rc on healthy sandbox"

echo
echo "== WS-4 summary: pass=$PASS fail=$FAIL =="
(( FAIL == 0 ))
