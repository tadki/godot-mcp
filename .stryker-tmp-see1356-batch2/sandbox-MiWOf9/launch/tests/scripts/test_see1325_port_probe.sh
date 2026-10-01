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

echo "== C-fix: command-failure/empty-output → UNDETERMINED (not FREE) =="
# ss 层失败注入：ss 返回 rc≠0（模拟命令执行失败）→ UNDETERMINED，不落 FREE。
# 用 PATH 里的假 ss 覆盖真实 ss（探针链第一个命中的工具即注入点）。
FIXTURE="$(mktemp -d)"
printf '#!/bin/sh\nexit 1\n' > "$FIXTURE/ss"; chmod +x "$FIXTURE/ss"
out="$(PATH="$FIXTURE:/usr/bin:/bin" "$BASH_BIN" -c "source '$LIB'; port_probe_verdict 64210")"
tc "ss command failure → UNDETERMINED" "UNDETERMINED" "$out"
# ss 层空输出注入（rc0 但零行）→ UNDETERMINED 而非 FREE（Revy C-qa §3 语义区分）。
printf '#!/bin/sh\nexit 0\n' > "$FIXTURE/ss"
out="$(PATH="$FIXTURE:/usr/bin:/bin" "$BASH_BIN" -c "source '$LIB'; port_probe_verdict 64210")"
tc "ss empty output (rc0) → UNDETERMINED" "UNDETERMINED" "$out"
# 正常"确认无监听"仍 FREE：假 ss 输出真实格式的无监听列表（rc0 非空）。
printf '#!/bin/sh\necho "State Recv-Q Send-Q Local Address:Port Peer Address:Port"\n' > "$FIXTURE/ss"
out="$(PATH="$FIXTURE:/usr/bin:/bin" "$BASH_BIN" -c "source '$LIB'; port_probe_verdict 64210")"
tc "ss normal no-listener output → FREE (existing semantics preserved)" "FREE" "$out"
# 正常"确认有监听"仍 IN_USE。
printf '#!/bin/sh\necho "LISTEN 0 128 *:64210 *:*"\n' > "$FIXTURE/ss"
out="$(PATH="$FIXTURE:/usr/bin:/bin" "$BASH_BIN" -c "source '$LIB'; port_probe_verdict 64210")"
tc "ss normal listener present → IN_USE" "IN_USE" "$out"
# netstat.exe 层失败注入同理。
printf '#!/bin/sh\nexit 1\n' > "$FIXTURE/netstat.exe"; chmod +x "$FIXTURE/netstat.exe"; rm -f "$FIXTURE/ss"
out="$(PATH="$FIXTURE:/usr/bin:/bin" "$BASH_BIN" -c "source '$LIB'; port_probe_verdict 64210")"
tc "netstat.exe command failure → UNDETERMINED" "UNDETERMINED" "$out"
rm -rf "$FIXTURE"

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
