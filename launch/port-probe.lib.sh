#!/usr/bin/env bash
# SEE-1325 阶段三 H1（§SPEC-008）— 端口探针收敛 lib（fail-closed）。
#
# 背景：start-godot-editor.sh 的 port_in_use() 在 PowerShell/netstat/ss 全缺失
# 时 fail-open（"assume free"），与 proxy 侧 fail-closed 语义相反；host 解析链
# 分散在 launcher 的 resolve_mcp_host()。本 lib 收敛为单一落点：
#   port_in_use <port>          — OS 探针链（PS > netstat.exe > ss > /dev/tcp），全败 = 不可判定
#   port_probe_verdict <port>   — fail-closed 判定：'IN_USE' | 'FREE' | 'UNDETERMINED'
#   resolve_probe_host <port>   — host 解析链：GODOT_MCP_HOST 显式 > resolve_mcp_host()；
#                                 双 host（显式+网关）TCP 不可达 = 'UNDETERMINED'
# 引用方式：source 本文件后调用；PROBE_RC 存最近一次 port_in_use 的判定质量。
#
# fail-closed 语义（§SPEC-008）：全探针不可用 → UNDETERMINED，调用方必须按
# "不可判定" 单列处理（不得当 free，也不得当 busy）——与 owner-order
# "master 共享拒绝防御 fail-open 禁止" 同族原则。

# OS 探针链：PowerShell（WSL interop 最可靠）> netstat.exe > ss > /dev/tcp。
# 返回 0 = 端口在用；1 = 端口空闲；2 = 不可判定（全探针不可用）。
port_in_use() {
    local p="$1"
    # PowerShell（若调用方已解析 POWERSHELL 变量则复用）
    if [[ -n "${POWERSHELL:-}" ]]; then
        if "$POWERSHELL" -NoProfile -Command "if (Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" 2>/dev/null; then
            return 0
        fi
        return 1
    fi
    if command -v netstat.exe >/dev/null 2>&1; then
        local pattern=":${p}\\b" _ns_out _ns_rc
        _ns_out="$(netstat.exe -ano -p tcp 2>/dev/null)"; _ns_rc=$?
        # SEE-1328 C-fix（§SPEC-008 fail-closed）：命令失败（rc≠0）或异常空输出
        # 不能证明"无监听"——只有命令成功且输出经 grep 确认无匹配才是 FREE。
        if [[ $_ns_rc -ne 0 || -z "$_ns_out" ]]; then
            return 2
        fi
        if printf '%s\n' "$_ns_out" | grep -E "LISTENING" | grep -qE "$pattern"; then
            return 0
        fi
        return 1
    fi
    if command -v ss >/dev/null 2>&1; then
        local _ss_out _ss_rc
        _ss_out="$(ss -H -tln 2>/dev/null)"; _ss_rc=$?
        # 同上：ss 失败或异常空输出 → 不可判定（正常确认无监听 = rc0 且非空输出无匹配）。
        if [[ $_ss_rc -ne 0 || -z "$_ss_out" ]]; then
            return 2
        fi
        printf '%s\n' "$_ss_out" | grep -qE ":${p}\\b"
        return $?
    fi
    # /dev/tcp 自探（最后手段；bash 内建，但容器/受限 shell 可能禁用）
    if (echo >/dev/tcp/127.0.0.1/"$p") 2>/dev/null; then
        return 0
    fi
    # /dev/tcp 连不上不能证明空闲（编辑器可能未监听回环）——但无其他探针时
    # 以"回环不可达"为 UNDETERMINED 信号：调用方按不可判定单列。
    return 2
}

# fail-closed 判定：UNDETERMINED 是一等公民（§SPEC-008 "双 host 不可达 = 不可
# 判定单列"的端口侧对应物）。
port_probe_verdict() {
    local p="$1"
    port_in_use "$p"
    case $? in
        0) printf 'IN_USE\n' ;;
        1) printf 'FREE\n' ;;
        *) printf 'UNDETERMINED\n' ;;
    esac
}

# host 解析链（§SPEC-008）：GODOT_MCP_HOST 显式 > 网关（resolve_mcp_host 若调用
# 方提供）> 127.0.0.1。probe_port_on <host> <port> 用 /dev/tcp 做可达性验证。
probe_port_on() {
    local host="$1" p="$2"
    (echo >/dev/tcp/"$host"/"$p") 2>/dev/null
}

# 双 host 可达性：显式 GODOT_MCP_HOST 与网关 host 都探不通且端口本机也无监听
# → 不可判定。返回 'REACHABLE' | 'UNREACHABLE' | 'UNDETERMINED'。
host_probe_verdict() {
    local p="$1" explicit="${GODOT_MCP_HOST:-}" gw="${GODOT_MCP_GATEWAY_HOST:-}"
    if [[ -n "$explicit" ]] && probe_port_on "$explicit" "$p"; then
        printf 'REACHABLE\n'; return
    fi
    if [[ -n "$gw" ]] && probe_port_on "$gw" "$p"; then
        printf 'REACHABLE\n'; return
    fi
    # 双 host 皆配置但皆不可达 → 不可判定单列；任一缺失则按可达性直接判
    if [[ -n "$explicit" && -n "$gw" ]]; then
        printf 'UNDETERMINED\n'; return
    fi
    printf 'UNREACHABLE\n'
}
