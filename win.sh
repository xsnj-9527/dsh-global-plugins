#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# win / winps — WSL → Windows 调用的唯一入口
#
# 背景（2026-09-13 实测于本机 Win11 26200 / zh-CN / 代码页 936）：
#
#   1. **输出乱码**：Windows 控制台程序经 WSL interop 调用时，stdout 是管道，
#      它们按 OEM 代码页（936 = GBK）吐字节，而 WSL/DSH 一律按 UTF-8 解码，
#      于是 `whoami`、`schtasks`、`powershell` 的中文全变 `����`。
#   2. **参数被吃掉**：Windows PowerShell 5.1（以及任何走 cmd/PowerShell 的
#      多层嵌套）重引用原生参数时会吞引号、合并参数——实测 6 个参数变 5 个。
#   3. **控制台噪声**：工作目录是 WSL 路径时 cmd.exe 必打一段 UNC 警告。
#
# 本脚本只做三件事，都是**调用侧**的、不改动任何程序行为：
#   · 直接 interop 启动目标程序，argv 原样透传（不经 cmd / 不经 PowerShell）；
#   · 读回原始字节后按判据解码——BOM → 严格 UTF-8 校验 → 落回 GBK936；
#   · 统一超时、退出码透传、可选的二进制透传。
#
# 为什么用「严格 UTF-8 校验」而不是维护一张程序→编码表：GBK 字节序列几乎
# 不可能通过 UTF-8 校验（实测 gb2312 的「中文」= D6 D0 CE C4，D0 不是合法
# 续字节），所以判据在本机足够可靠，而表会过期。
#
# 用法：
#   win [选项] <程序> [程序自身的参数...]
#       --raw             二进制透传，不解码（certutil / reg export 等）
#       --utf8 | --gbk    跳过自动判定，强制按指定编码解码
#       --stream[=编码]   边跑边解码输出（长任务用；stdout+stderr 合并，默认 GBK）
#       --timeout SEC     超时秒数，默认 120（全局默认可设 WIN_TIMEOUT）
#       --wincwd DIR      先切到 DIR 再启动（cmd.exe 不能用 UNC 工作目录，需配这个）
#
#   winps [选项] '<PowerShell 代码>'
#   winps [选项] -File <路径.ps1>     # 首参以 - 开头时按 pwsh 原始 argv 透传
#       --ps5             改用 Windows PowerShell 5.1
#       --timeout SEC     同上
#
# 退出码：目标程序的退出码原样返回；超时返回 124；用法错误返回 2。
# 环境变量：WIN_PWSH / WIN_PS5 指定解释器路径，WIN_FALLBACK_CODEC 换兜底编码（默认 GBK），
#           WIN_DEBUG=1 打印解析出的程序路径与解码判定。
#
# winps 会自动给脚本前置一句把 Console/OutputEncoding 钉成 UTF-8 的语句——这是
# 本机唯一能把 `✓`、emoji 这类 **GBK 表示不了的字符**救回来的办法（5.1 的
# $OutputEncoding 默认 us-ascii，会在字符到达解码器之前就把它变成 `?`）。
#
# 不做的事（刻意）：不做通用框架、不解析程序自身的选项、不做程序→编码表、
#                  不改动 Windows 侧任何设置。
# ─────────────────────────────────────────────────────────────────────────────

set -u

ME="${0##*/}"
WIN_FALLBACK_CODEC="${WIN_FALLBACK_CODEC:-GBK}"
WIN_TIMEOUT="${WIN_TIMEOUT:-120}"

# Windows 可执行文件不在 WSL 的 PATH 上（DSH 会裁掉 Windows 路径段），
# 所以对裸程序名做一次兜底查找，省掉每次手写 /mnt/c/Windows/System32/... 。
search_dirs() {
    printf '%s\n' \
        /mnt/c/Windows/System32 \
        /mnt/c/Windows/System32/WindowsPowerShell/v1.0 \
        /mnt/c/Windows \
        "/mnt/c/Program Files/PowerShell/7" \
        "/mnt/c/Program Files/nodejs" \
        "/mnt/c/Program Files (x86)/nodejs" \
        "/mnt/c/Program Files/Git/cmd"
    local d
    # Microsoft Store / MSIX 的应用执行别名（pwsh.exe、winget.exe 都在这里）
    for d in /mnt/c/Users/*/AppData/Local/Microsoft/WindowsApps; do
        [ -d "$d" ] && printf '%s\n' "$d"
    done
}

TMPD=""
cleanup() { [ -n "$TMPD" ] && rm -rf "$TMPD"; }
# 被 source 时不要往调用方的 shell 里塞 EXIT trap。
[ "${BASH_SOURCE[0]}" = "$0" ] && trap cleanup EXIT

dbg() { [ "${WIN_DEBUG:-0}" = "1" ] && printf 'win[debug]: %s\n' "$*" >&2; return 0; }

# ── 程序解析 ────────────────────────────────────────────────────────────────
resolve_program() {
    local p="$1" d
    case "$p" in
        */*) printf '%s\n' "$p"; return 0 ;;
    esac
    # 刻意**不**查 WSL 的 PATH：win 的语义是「跑 Windows 程序」，
    # 否则 `win node` / `win git` 会被 WSL 里同名的 Linux 程序抢走。
    while IFS= read -r d; do
        if [ -x "$d/$p" ]; then printf '%s\n' "$d/$p"; return 0; fi
        if [ -x "$d/$p.exe" ]; then printf '%s\n' "$d/$p.exe"; return 0; fi
    done < <(search_dirs)
    printf '%s\n' "$p"
}

resolve_pwsh() {
    local c
    [ -n "${WIN_PWSH:-}" ] && { printf '%s\n' "$WIN_PWSH"; return 0; }
    for c in "/mnt/c/Program Files/PowerShell/7/pwsh.exe" \
             /mnt/c/Users/*/AppData/Local/Microsoft/WindowsApps/pwsh.exe; do
        if [ -e "$c" ] || [ -L "$c" ]; then printf '%s\n' "$c"; return 0; fi
    done
    return 1
}

# ── 解码 ────────────────────────────────────────────────────────────────────
# $1=文件  $2=模式(raw|utf8|gbk|auto)
decode() {
    local f="$1" m="$2" b
    case "$m" in
        raw)  cat "$f"; return 0 ;;
        utf8) iconv -f UTF-8 -t UTF-8 -c "$f"; return 0 ;;
        gbk)  iconv -f "$WIN_FALLBACK_CODEC" -t UTF-8 -c "$f"; return 0 ;;
    esac

    b="$(head -c 3 "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
    [ "$b" = "efbbbf" ] && { tail -c +4 "$f"; return 0; }

    b="$(head -c 2 "$f" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
    case "$b" in
        fffe) iconv -f UTF-16LE -t UTF-8 -c "$f"; return 0 ;;
        feff) iconv -f UTF-16BE -t UTF-8 -c "$f"; return 0 ;;
    esac

    # 严格校验：能无损通过就是 UTF-8，否则按本机 OEM 代码页解码。
    if iconv -f UTF-8 -t UTF-8 "$f" >/dev/null 2>&1; then
        dbg "解码判定 = UTF-8"
        cat "$f"
    else
        dbg "解码判定 = $WIN_FALLBACK_CODEC"
        iconv -f "$WIN_FALLBACK_CODEC" -t UTF-8 -c "$f"
    fi
}

# ── 执行 ────────────────────────────────────────────────────────────────────
# run_capture <模式> <超时> <wincwd> <程序> [参数...]
run_capture() {
    local m="$1" t="$2" cwd="$3"; shift 3
    local out="$TMPD/out" err="$TMPD/err" rc

    if [ -n "$cwd" ]; then
        ( cd "$cwd" 2>/dev/null && exec timeout "$t" "$@" ) >"$out" 2>"$err"
    else
        timeout "$t" "$@" >"$out" 2>"$err"
    fi
    rc=$?

    decode "$out" "$m"
    [ -s "$err" ] && decode "$err" "$m" >&2
    if [ "$rc" -eq 124 ]; then
        printf 'win: 超过 %ss 仍未结束，已终止（长任务请加大 --timeout，或用 --stream 看实时输出）\n' "$t" >&2
    fi
    return "$rc"
}

# run_stream <编码> <超时> <wincwd> <程序> [参数...]
# stdout 与 stderr 合并后一起解码：流式模式下无法先缓冲再判定编码。
run_stream() {
    local c="$1" t="$2" cwd="$3"; shift 3
    local rc
    if [ -n "$cwd" ]; then
        ( cd "$cwd" 2>/dev/null && exec timeout "$t" "$@" ) 2>&1 | iconv -f "$c" -t UTF-8 -c
    else
        timeout "$t" "$@" 2>&1 | iconv -f "$c" -t UTF-8 -c
    fi
    rc=${PIPESTATUS[0]}
    if [ "$rc" -eq 124 ]; then
        printf 'win: 超过 %ss 仍未结束，已终止\n' "$t" >&2
    fi
    return "$rc"
}

# ── 入口 ────────────────────────────────────────────────────────────────────
win_usage() {
    sed -n '/^# 用法：/,/^# winps 会自动/p' "$0" | sed 's/^# \{0,1\}//'
}

win_main() {
    local mode=auto t="$WIN_TIMEOUT" cwd="" stream_codec="" prog
    local -a argv=()

    while [ $# -gt 0 ]; do
        case "$1" in
            --raw)     mode=raw; shift ;;
            --utf8)    mode=utf8; shift ;;
            --gbk)     mode=gbk; shift ;;
            --stream)  stream_codec="$WIN_FALLBACK_CODEC"; shift ;;
            --stream=*) stream_codec="${1#*=}"; shift ;;
            --timeout)  t="${2:-}"; shift 2 ;;
            --timeout=*) t="${1#*=}"; shift ;;
            --wincwd)   cwd="$(wslpath -u "${2:-}" 2>/dev/null || printf '%s' "${2:-}")"; shift 2 ;;
            --wincwd=*) cwd="$(wslpath -u "${1#*=}" 2>/dev/null || printf '%s' "${1#*=}")"; shift ;;
            -h|--help) win_usage; return 0 ;;
            --) shift; argv=("$@"); break ;;
            -*) printf 'win: 未知选项 %s（程序自身的选项要放在程序名之后）\n' "$1" >&2; return 2 ;;
            *) argv=("$@"); break ;;
        esac
    done

    if [ ${#argv[@]} -eq 0 ]; then
        win_usage >&2
        return 2
    fi
    case "$t" in ''|*[!0-9]*) printf 'win: --timeout 需要一个正整数秒数\n' >&2; return 2 ;; esac

    prog="$(resolve_program "${argv[0]}")"
    argv[0]="$prog"
    if [ ! -e "$prog" ]; then
        printf 'win: 找不到 Windows 程序 %s\n     裸名只查 Windows 目录（System32 / WindowsPowerShell / PowerShell7 / nodejs / Git / WindowsApps），\n     不查 WSL 的 PATH——要跑 WSL 程序就别用 win。显式路径写成 /mnt/c/... 或 C:\\... 即可。\n' "$prog" >&2
        return 127
    fi
    dbg "程序 = $prog"
    dbg "模式 = ${stream_codec:+stream:$stream_codec}${stream_codec:-$mode}  超时 = ${t}s"

    TMPD="$(mktemp -d)"
    if [ -n "$stream_codec" ]; then
        run_stream "$stream_codec" "$t" "$cwd" "${argv[@]}"
    else
        run_capture "$mode" "$t" "$cwd" "${argv[@]}"
    fi
}

winps_usage() {
    sed -n '/^#   winps \[选项\]/,/^#       --timeout SEC/p' "$0" | sed 's/^# \{0,1\}//'
}

winps_main() {
    local t="$WIN_TIMEOUT" use5=0 script="" exe
    local -a argv=()
    local pre='[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$OutputEncoding=[System.Text.UTF8Encoding]::new($false);'

    while [ $# -gt 0 ]; do
        case "$1" in
            --ps5)      use5=1; shift ;;
            --timeout)  t="${2:-}"; shift 2 ;;
            --timeout=*) t="${1#*=}"; shift ;;
            -h|--help) winps_usage; return 0 ;;
            -*) argv=("$@"); break ;;
            *) script="$1"; shift; break ;;
        esac
    done

    if [ "$use5" = 1 ]; then
        exe="${WIN_PS5:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"
    elif ! exe="$(resolve_pwsh)"; then
        printf 'winps: 找不到 pwsh.exe（Windows PowerShell 7）。可用 WIN_PWSH 指定路径，或加 --ps5 改用 5.1。\n' >&2
        return 3
    fi
    case "$t" in ''|*[!0-9]*) printf 'winps: --timeout 需要一个正整数秒数\n' >&2; return 2 ;; esac
    if [ ${#argv[@]} -eq 0 ] && [ $# -gt 0 ]; then
        printf 'winps: 代码片段只能有一个，多余参数：%s\n' "$*" >&2
        return 2
    fi
    dbg "解释器 = $exe"

    TMPD="$(mktemp -d)"
    if [ ${#argv[@]} -gt 0 ]; then
        # 首参以 - 开头：按原始 argv 透传，不注入前置语句。
        # 因此输出编码由目标自己决定（可能仍是 GBK），交给自动判定，不能强制 UTF-8。
        run_capture auto "$t" "" "$exe" -NoLogo -NoProfile -NonInteractive "${argv[@]}"
    else
        if [ -z "$script" ]; then
            winps_usage >&2
            return 2
        fi
        run_capture utf8 "$t" "" "$exe" -NoLogo -NoProfile -NonInteractive -Command "${pre}${script}"
    fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    case "$ME" in
        winps) winps_main "$@" ;;
        *)     win_main "$@" ;;
    esac
fi
