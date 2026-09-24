#!/usr/bin/env bash
# Luckagent 安装前网络检查：并行测一遍安装要用到的海外源
# （GitHub / Homebrew / npm / PyPI / Claude），连不上或很慢时提示开梯子的虚拟网卡（TUN）模式——
# 否则装到一半卡在 Homebrew / npm 下载上，既不报错也不结束。
#
#   bash scripts/net-check.sh            # 交互：有问题时可 重新检测 / 忽略继续 / 退出
#   bash scripts/net-check.sh --report   # 只打印结果，不提问
#
# 退出码：0 必需源全部正常（或用户选择忽略继续）；1 必需源有问题（--report）或用户选择退出。
# 测的是本终端的真实出网路径：https_proxy 等环境变量会被 curl 自动使用。
set -uo pipefail

REPORT=false
[[ "${1:-}" == "--report" ]] && REPORT=true

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'

SLOW_BPS="${LUCKAGENT_NET_SLOW_BPS:-102400}"   # 低于 100 KB/s 算慢：Homebrew 仓库几十 MB，这个速度要十几分钟起
SLOW_TTFB=4       # 首字节超过 4 秒算慢

# 名称|类型|必需|URL|期望状态码
#   speed：下载最多 1 MB 测吞吐；reach：只看能否连通、多久响应（用状态码判断，不下载正文）
PROBES=(
  "GitHub 代码仓库|speed|1|https://github.com/Homebrew/brew.git/info/refs?service=git-upload-pack|200"
  "GitHub 文件下载|reach|1|https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh|200 206"
  "Homebrew 软件索引|speed|1|https://formulae.brew.sh/api/formula.jws.json|200 206"
  "Homebrew 软件包|reach|1|https://ghcr.io/v2/|401 200"
  "npm 包仓库|speed|1|https://registry.npmjs.org/typescript/-/typescript-5.6.3.tgz|200 206"
  "Python 包仓库|speed|1|https://files.pythonhosted.org/packages/d4/55/90db48d85f7689ec6f81c0db0622d704306c5284850383c090e6c7195a5c/pip-24.2-py3-none-any.whl|200 206"
  "Claude 安装包|reach|0|https://downloads.claude.ai/claude-code-releases/bootstrap.sh|200 206"
  "Claude API|reach|0|https://api.anthropic.com/v1/models|401"
)

# 代理 URL 里可能带 user:pass@，打印前去掉
_redact() { sed -E 's#//[^@/]*@#//#'; }

_env_proxy() {
  local v
  for v in "${https_proxy:-}" "${HTTPS_PROXY:-}" "${all_proxy:-}" "${ALL_PROXY:-}" "${http_proxy:-}" "${HTTP_PROXY:-}"; do
    [[ -n "$v" ]] && { echo "$v" | _redact; return 0; }
  done
  return 1
}

_system_proxy_on() {
  command -v scutil &>/dev/null && scutil --proxy 2>/dev/null | grep -Eq '(HTTPS|HTTP|SOCKS)Enable : 1'
}

REQ_BAD=0; OPT_BAD=0; REGION_BLOCKED=false

run_checks() {
  local tmp i n=${#PROBES[@]}
  tmp="$(mktemp -d)"
  for ((i = 0; i < n; i++)); do
    local url
    url="$(echo "${PROBES[$i]}" | cut -d'|' -f4)"
    ( curl -s -o /dev/null -r 0-1048575 --connect-timeout 8 --max-time 12 \
        -w '%{http_code} %{size_download} %{speed_download} %{time_starttransfer}' "$url" \
        >"$tmp/$i" 2>/dev/null || true ) &
  done
  wait

  REQ_BAD=0; OPT_BAD=0; REGION_BLOCKED=false
  echo ""
  for ((i = 0; i < n; i++)); do
    local name kind req expect code size speed ttfb state detail
    IFS='|' read -r name kind req _ expect <<<"${PROBES[$i]}"
    read -r code size speed ttfb <"$tmp/$i" 2>/dev/null || true
    code="${code:-000}"; size="${size:-0}"; speed="${speed:-0}"; ttfb="${ttfb:-0}"

    if [[ "$code" == "000" ]]; then
      state=bad; detail="连不上"
    elif [[ "$name" == "Claude API" && "$code" == "403" ]]; then
      state=bad; detail="HTTP 403：当前出口地区不受 Anthropic 支持"; REGION_BLOCKED=true
    elif [[ " $expect " != *" $code "* ]]; then
      state=bad; detail="HTTP ${code}"
    elif [[ "$kind" == "speed" ]]; then
      if awk -v s="$speed" -v t="$SLOW_BPS" 'BEGIN{exit !(s < t)}'; then state=slow; else state=ok; fi
      detail="$(awk -v s="$speed" 'BEGIN{ if (s >= 1048576) printf "%.1f MB/s", s/1048576; else printf "%d KB/s", s/1024 }')"
    else
      if awk -v s="$ttfb" -v t="$SLOW_TTFB" 'BEGIN{exit !(s > t)}'; then state=slow; else state=ok; fi
      detail="$(awk -v s="$ttfb" 'BEGIN{ printf "响应 %.1fs", s }')"
    fi

    local mark
    case "$state" in
      ok)   mark="${GREEN}✓${NC}" ;;
      slow) mark="${YELLOW}⚠${NC}"; detail="${detail}（慢）" ;;
      *)    mark="${RED}✗${NC}" ;;
    esac
    [[ "$req" == "1" ]] || name="${name}（Claude 引擎用）"
    printf "  %b %s  %s\n" "$mark" "$name" "$detail"
    if [[ "$state" != "ok" ]]; then
      if [[ "$req" == "1" ]]; then REQ_BAD=$((REQ_BAD + 1)); else OPT_BAD=$((OPT_BAD + 1)); fi
    fi
  done
  rm -rf "$tmp"
  echo ""
}

advise() {
  echo -e "${YELLOW}[WARN]${NC} 有 ${REQ_BAD} 项安装必需的海外源连不上或很慢——直接安装大概率会卡在 Homebrew / npm 下载上。"
  echo ""
  echo -e "  ${BOLD}请开启梯子，并切到「虚拟网卡模式（TUN）」${NC}"
  echo "    · 普通的「系统代理」模式只对浏览器生效：终端里的 curl / git / npm / brew 不走它，"
  echo "      所以会出现「浏览器能上 GitHub，安装却卡住」；"
  echo "    · TUN 模式接管整台机器的流量，安装过程中的所有下载都会经过代理。"
  echo ""
  echo -e "  推荐 ${BOLD}Clash Verge${NC}（维护中的是 Clash Verge Rev 版）："
  echo "    设置 → 打开「虚拟网卡模式 / TUN 模式」（首次会要求安装服务模式、输入开机密码），"
  echo "    节点选美国 / 日本 / 新加坡等地区（Claude 不支持中国大陆和香港出口）。"
  local p
  if p="$(_env_proxy)"; then
    echo ""
    echo -e "  ${YELLOW}终端里设置了代理 ${p}${NC}：确认梯子在运行、端口一致；"
    echo "    开了 TUN 就不需要它，可先 unset https_proxy http_proxy all_proxy 再重跑。"
  elif _system_proxy_on; then
    echo ""
    echo -e "  ${YELLOW}检测到系统代理已开启${NC}，但终端程序不走系统代理——这正是上面说的情况，改开 TUN 即可。"
  fi
}

advise_claude() {
  if [[ "$REGION_BLOCKED" == "true" ]]; then
    echo -e "${YELLOW}[WARN]${NC} Claude API 拒绝了当前出口地区：用 Claude 引擎需把梯子节点换到美国 / 日本 / 新加坡等地区。"
  else
    echo -e "${YELLOW}[WARN]${NC} Claude 相关地址不通：用 Claude 引擎需要梯子（TUN 模式）；只用 DeepSeek / MiniMax 引擎可忽略。"
  fi
}

echo -e "${BOLD}—— 网络检查（安装要从这些海外源下载，约 10 秒）——${NC}"
if p="$(_env_proxy)"; then
  echo -e "${BLUE}[INFO]${NC} 终端代理: ${p}"
fi

while true; do
  run_checks
  if [[ $REQ_BAD -eq 0 ]]; then
    echo -e "${GREEN}[OK]${NC} 安装所需的网络正常"
    [[ $OPT_BAD -gt 0 ]] && advise_claude
    exit 0
  fi
  advise
  [[ $OPT_BAD -gt 0 ]] && { echo ""; advise_claude; }
  echo ""
  if [[ "$REPORT" == "true" ]]; then
    exit 1
  fi
  read -r -p "开好后按回车重新检测；输入 s 忽略并继续安装；输入 q 退出 [回车/s/q] " ans || ans="q"
  case "$ans" in
    s|S) echo -e "${YELLOW}[WARN]${NC} 忽略网络问题继续安装——如果卡在某一步不动，Ctrl+C 后开好 TUN 再重跑（安装可重复执行）"; exit 0 ;;
    q|Q) exit 1 ;;
    *) echo -e "${BLUE}[INFO]${NC} 重新检测 ..." ;;
  esac
done
