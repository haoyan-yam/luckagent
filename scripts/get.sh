#!/bin/bash
# Luckagent 一行命令引导安装脚本（零前置依赖：只用 macOS 自带的 curl/tar/bash）。
#
#   curl -fsSL https://github.com/haoyan-yam/luckagent/releases/latest/download/get.sh | bash
#
# 职责：把仓库取到安装目录，然后转交交互式 install.sh（依赖、.env、PM2 一条龙）。
# 已装机器上重复执行是安全的——检测到现有安装会给出升级指引后退出。
#
# 可用环境变量：
#   LUCKAGENT_DIR=~/luckagent   安装目录
#   LUCKAGENT_REF=main          分支或 tag（v 开头按 tag 处理）
#   LUCKAGENT_REPO=<url>        克隆源（fork / 内网镜像可覆盖）
#   LUCKAGENT_YES=1             install.sh 全部采用默认值、不提问
#   LUCKAGENT_NO_INSTALL=1      只取代码，不运行 install.sh
#
# 整个逻辑包在 main() 里、最后一行才调用——网络中断导致脚本下载半截时
# 什么都不会执行。
set -euo pipefail

main() {
  local BLUE='\033[0;34m' GREEN='\033[0;32m' RED='\033[0;31m' NC='\033[0m'
  info()    { echo -e "${BLUE}[luckagent]${NC} $*"; }
  success() { echo -e "${GREEN}[luckagent]${NC} $*"; }
  fail()    { echo -e "${RED}[luckagent]${NC} $*" >&2; exit 1; }

  [[ "$(uname -s)" == "Darwin" ]] || fail "Luckagent 目前只支持 macOS（目标机型 Mac mini / MacBook）。"

  local target="${LUCKAGENT_DIR:-${LUCKAGENT_HOME:-$HOME/luckagent}}"
  local ref="${LUCKAGENT_REF:-main}"
  local repo="${LUCKAGENT_REPO:-https://github.com/haoyan-yam/luckagent.git}"

  # 已经装过：不重复取码，给升级路径。
  if [[ -f "$target/package.json" && -x "$target/bin/luckagent" ]]; then
    success "$target 已经是一份 Luckagent 安装。"
    if [[ -d "$target/.git" ]]; then
      echo "  升级: luckagent update"
    else
      echo "  升级: curl -fsSL https://codeload.github.com/haoyan-yam/luckagent/tar.gz/refs/heads/main | tar -xz --strip-components=1 -C $target"
      echo "        cd $target && bash install.sh"
    fi
    echo "  重跑安装(幂等): cd $target && bash install.sh"
    return 0
  fi
  if [[ -d "$target" && -n "$(ls -A "$target" 2>/dev/null)" ]]; then
    fail "目录 $target 已存在且非空，但不是 Luckagent 安装。换个目录: LUCKAGENT_DIR=<path> 重跑本命令。"
  fi

  # 取代码。全新 Mac 的 /usr/bin/git 是触发 Xcode CLT 弹窗的桩——
  # 只有 xcode-select -p 成功（CLT 真装了）才走 git clone，否则 curl 拉 tarball。
  info "获取 Luckagent（$ref）到 $target ..."
  mkdir -p "$(dirname "$target")"
  if xcode-select -p &>/dev/null && command -v git &>/dev/null; then
    git clone --depth 1 --branch "$ref" "$repo" "$target" \
      || fail "git clone 失败。检查网络后重跑本命令即可。"
  else
    local slug tarball
    slug="${repo#https://github.com/}"; slug="${slug%.git}"
    case "$ref" in
      v[0-9]*) tarball="https://codeload.github.com/$slug/tar.gz/refs/tags/$ref" ;;
      *)       tarball="https://codeload.github.com/$slug/tar.gz/refs/heads/$ref" ;;
    esac
    mkdir -p "$target"
    curl -fsSL "$tarball" | tar -xz --strip-components=1 -C "$target" \
      || fail "下载失败（$tarball）。检查网络后重试。"
  fi
  success "代码就绪: $target"

  if [[ "${LUCKAGENT_NO_INSTALL:-}" == "1" ]]; then
    info "跳过安装（LUCKAGENT_NO_INSTALL=1）。之后执行: cd $target && bash install.sh"
    return 0
  fi

  # curl | bash 模式下 stdin 是管道——把终端还给交互式 install.sh。
  local extra=()
  [[ "${LUCKAGENT_YES:-}" == "1" ]] && extra+=(--yes)
  info "运行交互式安装 install.sh ..."
  if [[ -r /dev/tty && ${#extra[@]} -eq 0 ]]; then
    ( cd "$target" && bash install.sh < /dev/tty )
  else
    # 无终端可用（如 CI）或指定了 --yes：全默认跑。
    [[ ${#extra[@]} -eq 0 ]] && { info "检测不到交互终端，改用全默认值（--yes）。"; extra=(--yes); }
    ( cd "$target" && bash install.sh "${extra[@]}" )
  fi

  echo ""
  success "安装完成。管理台: http://localhost:9100/admin （密钥在 $target/.env 的 API_SECRET）"
}

main "$@"
