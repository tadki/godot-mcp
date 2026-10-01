#!/usr/bin/env bash
# SEE-1148 P3.1: proxy markIntentionalRelease marker semantics.
#
# The proxy's shutdown path stamps intentional_release=true on its OWN
# runtime's active lease sidecar. These tests drive the exact node marker body
# the proxy runs (extracted here verbatim) against fixture sidecars:
#   - marks an active lease whose runtime_id matches
#   - does NOT touch a lease owned by a DIFFERENT runtime (concurrent slot)
#   - does NOT touch a released lease
#   - tolerates a legacy sidecar with empty runtime_id
#
# Hermetic: temp sidecars only; no proxy, no editor.

set -uo pipefail
command -v node >/dev/null 2>&1 || { echo "FAIL: node required"; exit 1; }

SBOX="$(mktemp -d)"
trap 'rm -rf "$SBOX"' EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# marker <sidecar> <runtime_id> — verbatim replica of the proxy's marker body.
marker() {
    local sidecar="$1" rid="$2"
    [[ -f "$sidecar" ]] || return 0
    RID="$rid" SIDE="$sidecar" node -e '
        const fs = require("fs");
        let o;
        try { o = JSON.parse(fs.readFileSync(process.env.SIDE, "utf8")); } catch (e) { process.exit(0); }
        const rid = process.env.RID;
        if (o.runtime_id && o.runtime_id !== rid) process.exit(0);
        if (o.state !== "active") process.exit(0);
        o.intentional_release = true;
        o.intentional_release_at = new Date().toISOString();
        const tmp = process.env.SIDE + ".tmp." + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + "\n", "utf8");
        fs.renameSync(tmp, process.env.SIDE);
    '
}

getf() { node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(o[process.argv[2]]===undefined?"<unset>":o[process.argv[2]]))' "$1" "$2"; }

echo "== M1: marks own-runtime active lease =="
S1="$SBOX/s1.json"
cat > "$S1" <<JSON
{ "schema_version": 2, "runtime_id": "Bachi-aabbccdd", "port": 6601, "agent": "Bachi",
  "state": "active", "lease_id": "m1", "worktree": "$SBOX", "configured_by_pid": 123, "notes": "" }
JSON
marker "$S1" "Bachi-aabbccdd"
if [[ "$(getf "$S1" intentional_release)" == "true" ]]; then ok "own-runtime lease marked"; else bad "own-runtime lease not marked: $(cat "$S1")"; fi

echo "== M2: does NOT touch a different runtime's lease =="
S2="$SBOX/s2.json"
cat > "$S2" <<JSON
{ "schema_version": 2, "runtime_id": "Bachi-zzzz9999", "port": 6602, "agent": "Bachi",
  "state": "active", "lease_id": "m2", "worktree": "$SBOX", "configured_by_pid": 124, "notes": "" }
JSON
marker "$S2" "Bachi-aabbccdd"
if [[ "$(getf "$S2" intentional_release)" == "<unset>" ]]; then ok "different-runtime lease untouched"; else bad "different-runtime lease wrongly marked: $(cat "$S2")"; fi

echo "== M3: does NOT touch a released lease =="
S3="$SBOX/s3.json"
cat > "$S3" <<JSON
{ "schema_version": 2, "runtime_id": "Bachi-aabbccdd", "port": 6603, "agent": "Bachi",
  "state": "released", "lease_id": "m3", "worktree": "$SBOX", "configured_by_pid": 125, "notes": "" }
JSON
marker "$S3" "Bachi-aabbccdd"
if [[ "$(getf "$S3" intentional_release)" == "<unset>" ]]; then ok "released lease untouched"; else bad "released lease wrongly marked: $(cat "$S3")"; fi

echo "== M4: legacy sidecar with empty runtime_id is marked =="
S4="$SBOX/s4.json"
cat > "$S4" <<JSON
{ "schema_version": 1, "port": 6604, "agent": "Bachi",
  "state": "active", "lease_id": "m4", "worktree": "$SBOX", "configured_by_pid": 126, "notes": "" }
JSON
marker "$S4" "Bachi-aabbccdd"
if [[ "$(getf "$S4" intentional_release)" == "true" ]]; then ok "legacy empty-runtime lease marked"; else bad "legacy lease not marked: $(cat "$S4")"; fi

echo "== M5: malformed sidecar is a no-op (no crash) =="
S5="$SBOX/s5.json"
printf '{ not json ' > "$S5"
marker "$S5" "Bachi-aabbccdd"
if [[ "$(cat "$S5")" == '{ not json ' ]]; then ok "malformed sidecar untouched"; else bad "malformed sidecar modified: $(cat "$S5")"; fi

echo "== summary: pass=$PASS fail=$FAIL =="
(( FAIL == 0 )) || exit 1
exit 0
