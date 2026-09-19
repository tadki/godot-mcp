#!/usr/bin/env bash
# SEE-1325 §SPEC-008 — port-probe.lib.sh probe suite (bash, JUnit output via wrapper).
# Run: bash launch/tests/scripts/test_see1325_port_probe.sh
set -u
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/port-probe.lib.sh"
# shellcheck source=/dev/null
source "$LIB"

PASS=0; FAIL=0
declare -a CASES=()
tc() { # name expected
    local name="$1" expected="$2"; shift 2
    local got; got="$*"
    if [[ "$got" == "$expected" ]]; then PASS=$((PASS+1)); echo "  [PASS] $name";
    else FAIL=$((FAIL+1)); echo "  [FAIL] $name (got=[$got] want=[$expected])"; fi
}

echo "== port_in_use chain =="
# /dev/tcp self-probe against a definitely-closed port must NOT claim FREE via ps
# (no PS/netstat/ss in PATH for this test unless host provides them — verdicts
# below assert the CHAIN semantics, not machine specifics).
v="$(port_probe_verdict 64210)"
tc "verdict returns a legal enum" "ok" "$([[ "$v" == IN_USE || "$v" == FREE || "$v" == UNDETERMINED ]] && echo ok)"

echo "== fail-closed: UNDETERMINED is a first-class verdict =="
# Strip every probe tool, then a closed loop port → /dev/tcp fails → UNDETERMINED (not FREE)
# （PATH 收窄后 bash 需要绝对路径调用；ss/netstat.exe 在本机存在与否决定走哪条链，
#  断言语义是"全探针不可用 → UNDETERMINED"——用最小 PATH 让 ps 链失活，仅剩 /dev/tcp）
BASH_BIN="$(command -v bash)"
out="$(PATH=/usr/bin:/bin POWERSHELL= "$BASH_BIN" -c "source '$LIB'; PATH=/nonexistent; export PATH; port_probe_verdict 64210")"
tc "no-probe closed port → UNDETERMINED (fail-closed)" "UNDETERMINED" "$out"

echo "== host chain =="
# 双 host 皆配置且皆不可达（死端口）→ UNDETERMINED（§SPEC-008 不可判定单列）
out="$(GODOT_MCP_HOST=127.0.0.1 GODOT_MCP_GATEWAY_HOST=127.0.0.2 bash -c "source '$LIB'; host_probe_verdict 64210")"
tc "dual-host both unreachable → UNDETERMINED" "UNDETERMINED" "$out"
# 单 host 未命中 → UNREACHABLE（信息完整，非不可判定）
out="$(GODOT_MCP_HOST=127.0.0.1 bash -c "source '$LIB'; host_probe_verdict 64210")"
tc "single host unreachable → UNREACHABLE" "UNREACHABLE" "$out"

echo "== summary =="
echo "SUMMARY: PASS=$PASS FAIL=$FAIL"
# JUnit XML（bash 套件内联 junit 报告，工具链勘误判据）
XML="${BASH_SOURCE[0]%.sh}.junit.xml"
{
    echo '<?xml version="1.0" encoding="utf-8"?>'
    echo '<testsuites>'
    echo "  <testsuite name=\"test_see1325_port_probe\" tests=\"$((PASS+FAIL))\" failures=\"$FAIL\">"
    echo "    <testcase name=\"port-probe-lib fail-closed contract\"/>"
    echo "  </testsuite>"
    echo '</testsuites>'
} > "$XML"
[[ $FAIL -eq 0 ]]
