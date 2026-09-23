#!/usr/bin/env bash
# test_see1240_d1_corrupt_accounting.sh — SEE-1240 D1 regression: corrupt
# branch verdict accounting + sweep scope convergence.
#
# D1 (QA MEDIUM): a fully-valid active lease was silently quarantined
# (.corrupt-<ts>) twice because the corrupt branch renamed on EVERY non-zero
# validation rc — including rc=3 "unreadable", which covers ENOENT/EACCES and
# transient IO failures caused by racing a concurrent sidecar mktemp+mv (find
# enumerates the path, the writer renames it, the reaper's read misses). A
# read failure says nothing about file content; quarantining on it can destroy
# a freshly rewritten valid lease (editor then falls back to port 6550 — the
# exact cross-agent clash WS-2 prevents).
#
# Cases:
#   A  read failure (EACCES injection) on a VALID lease → NOT quarantined,
#      READ-FAILED logged, file left in place
#   B  real corruption (unparseable bytes)        → still quarantined
#   C  missing required fields (valid JSON)       → still quarantined
#   D  unknown schema_version                     → still quarantined
#   E  configure sweep scope: a lease OUTSIDE the registry-recorded worktrees
#      is NOT touched by configure's scoped async reaper
#
# Run: bash .dev/godot-mcp/tests/scripts/test_see1240_d1_corrupt_accounting.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
REAPER="$REPO_ROOT/launch/reap-stale-leases.sh"
CONFIGURE="$REPO_ROOT/launch/configure-mcp-port.sh"

command -v node >/dev/null 2>&1 || { echo "node required"; exit 1; }
[[ -x "$REAPER" && -x "$CONFIGURE" ]] || { echo "reaper/configure not executable"; exit 1; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $*"; }

SBOX="$(mktemp -d)"
export HOME="$SBOX/home"; mkdir -p "$HOME/.multica"
trap 'rm -rf "$SBOX" /tmp/d1-scope-* 2>/dev/null' EXIT

make_lease() {  # <worktree> <json-overrides-via-stdin>
    local wt="$1"
    mkdir -p "$wt/.godot"
    printf 'config_version=5\n' > "$wt/project.godot"
    node -e '
const fs=require("fs"),crypto=require("crypto");
const wt=process.argv[1];
const old=new Date(Date.now()-6*3600*1000).toISOString();
const body=JSON.parse(process.argv[2]);
const o=Object.assign({
  schema_version:2, runtime_id:"Bachi-aabbccdd", task_id:"", port:6563,
  agent:"Bachi", label:"bachi", state:"active", lease_id:crypto.randomUUID(),
  worktree:wt, configured_at:old, configured_by_pid:null,
  released_at:null, notes:""}, body);
delete o._raw;
fs.writeFileSync(wt+"/.godot/mcp-lease.json", JSON.stringify(o,null,2)+"\n");
' "$wt" "$(cat)"
}

run_reaper() {
    KOL_REAP_DISABLE_PWSH=1 KOL_REAP_HEADLESS_GRACE_M=9999 KOL_REAP_GUI_ORPHAN=0 \
        bash "$REAPER" --root "$SBOX" 2>&1
}

has_corrupt() { ls "$1/.godot/" 2>/dev/null | grep -q corrupt; }

echo "== A: read failure (EACCES) on a VALID lease → NOT quarantined =="
WA="$SBOX/wa"
make_lease "$WA" <<'EOF'
{"notes":"complete json — D1 victim shape"}
EOF
chmod 000 "$WA/.godot/mcp-lease.json"
OUT="$(run_reaper)"
chmod 644 "$WA/.godot/mcp-lease.json" 2>/dev/null
if has_corrupt "$WA"; then bad "A: valid lease quarantined on read failure (D1 regression)"; else ok "A: valid lease NOT quarantined on read failure"; fi
echo "$OUT" | grep -q "READ-FAILED" && ok "A: READ-FAILED logged (observability)" || bad "A: READ-FAILED log missing"

echo "== B: real corruption (unparseable) → still quarantined =="
WB="$SBOX/wb"; mkdir -p "$WB/.godot"; printf 'config_version=5\n' > "$WB/project.godot"
printf '{{{ not json at all\n' > "$WB/.godot/mcp-lease.json"
OUT="$(run_reaper)"
echo "$OUT" | grep -q "CORRUPT sidecar (unparseable" && has_corrupt "$WB" && ok "B: unparseable bytes quarantined" || bad "B: corruption NOT caught"

echo "== C: missing required fields (valid JSON) → still quarantined =="
WC="$SBOX/wc"; mkdir -p "$WC/.godot"; printf 'config_version=5\n' > "$WC/project.godot"
printf '{"schema_version":2,"port":6553}\n' > "$WC/.godot/mcp-lease.json"
OUT="$(run_reaper)"
echo "$OUT" | grep -q "CORRUPT sidecar (missing:" && has_corrupt "$WC" && ok "C: missing-field sidecar quarantined" || bad "C: missing-field NOT caught"

echo "== D: unknown schema_version → still quarantined =="
WD="$SBOX/wd"
make_lease "$WD" <<'EOF'
{"schema_version":99,"notes":"foreign producer"}
EOF
OUT="$(run_reaper)"
echo "$OUT" | grep -q "schema_version_unexpected" && has_corrupt "$WD" && ok "D: unknown schema quarantined" || bad "D: unknown schema NOT caught"

echo "== E: configure sweep scope converges to registry worktrees =="
node -e '
const fs=require("fs");
fs.writeFileSync(process.env.HOME+"/.multica/godot-port-registry.json", JSON.stringify({schema_version:1, updated_at:new Date().toISOString(), entries:{
  "A-aaaaaaaa":{port:6560, worktree:"/tmp/d1-scope-a"},
  "B-bbbbbbbb":{port:6561, worktree:"/tmp/d1-scope-b"}
}},null,2)+"\n");
'
mkdir -p /tmp/d1-scope-a /tmp/d1-scope-b
make_lease /tmp/d1-scope-outside <<'EOF'
{"runtime_id":"X-xxxxxxxx","agent":"X","label":"x","port":6569}
EOF
KOL_PORT_REGISTRY_PATH_OVERRIDE="$HOME/.multica/godot-port-registry.json" \
    bash "$CONFIGURE" --port 6570 --project-godot "$SBOX/we/project.godot" >/dev/null 2>&1 || true
sleep 3   # 竞态窗口语义（CLAUDE.md 边界）：configure 的 async reaper 无外部完成信号可订阅，3s = 其窗口上限（同原语义），负向断言"外部 lease 不被触碰"须窗已过
if has_corrupt /tmp/d1-scope-outside; then bad "E: outside-registry lease touched by scoped sweep"; else ok "E: outside-registry lease untouched by configure's scoped sweep"; fi

echo
echo "== D1 summary: pass=$PASS fail=$FAIL =="
(( FAIL == 0 ))
