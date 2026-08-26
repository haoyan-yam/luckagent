#!/bin/bash
# Luckagent 卸载脚本。
#
#   bash ~/luckagent/scripts/uninstall.sh            # 交互确认
#   bash ~/luckagent/scripts/uninstall.sh --yes      # 全部默认（保留工作区）
#
# 卸载范围：PM2 进程、安装目录、状态目录、CLI、随装技能。
# 刻意保留（含你的数据，需要时自行删除）：
#   ~/projects/ 各 bot 工作区与共用规范    —— 你的项目文件
#   ~/.claude/projects/*/memory           —— bot 的记忆
#   brew / node / pm2 / lark-cli / claude —— 共享工具
set -euo pipefail

YES=false
[[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]] && YES=true

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()    { echo -e "${BOLD}[卸载]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[保留]${NC} $*"; }

ask() {
  [[ "${YES}" == "true" ]] && return 0
  read -r -p "$1 [y/N] " a || a=""
  [[ "${a}" =~ ^[Yy] ]]
}

# 安装目录：脚本所在仓库，或默认 ~/luckagent
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)" || SELF_DIR=""
LUCKAGENT_HOME="${LUCKAGENT_HOME:-${SELF_DIR:-$HOME/luckagent}}"
[[ -f "${LUCKAGENT_HOME}/package.json" ]] || LUCKAGENT_HOME="$HOME/luckagent"

echo ""
info "将从本机移除 Luckagent（安装目录: ${LUCKAGENT_HOME}）"
echo "  移除：PM2 进程 / 安装目录(含 .env、bots.json) / ~/.luckagent* 状态 / CLI / 随装技能"
echo "  保留：~/projects 工作区与项目记忆、brew/node/pm2/lark-cli/claude 等共享工具"
echo ""
ask "确认卸载？" || { echo "已取消"; exit 0; }

# 1) 停并移除 PM2 进程
if command -v pm2 &>/dev/null; then
  pm2 delete luckagent-bridge luckagent-core >/dev/null 2>&1 || true
  pm2 save --force >/dev/null 2>&1 || true
  success "PM2 进程已移除（luckagent-bridge / luckagent-core）"
  if [[ "$(pm2 jlist 2>/dev/null)" == "[]" ]]; then
    echo "  提示: pm2 已无其他应用。可选彻底清理："
    echo "    pm2 kill && pm2 unstartup   # unstartup 会打印需要 sudo 的命令"
  fi
fi

# 2) 状态目录
for d in "$HOME/.luckagent" "$HOME/.luckagent-core"; do
  [[ -d "${d}" ]] && rm -rf "${d}" && success "已删除 ${d}"
done

# 3) CLI
[[ -e "$HOME/.local/bin/luckagent" ]] && rm -f "$HOME/.local/bin/luckagent" && success "已删除 ~/.local/bin/luckagent"

# 4) 随装技能（仅本项目安装的；lark-* 属 lark-cli 生态，单独询问）
for skill in luckagent voice luckagent-team image-gen opencli frontend-slides; do
  for root in "$HOME/.claude/skills" "$HOME/.codex/skills"; do
    [[ -d "${root}/${skill}" ]] && rm -rf "${root}/${skill}" && success "已删除技能 ${root}/${skill}"
  done
done
if ls "$HOME/.claude/skills"/lark-* >/dev/null 2>&1; then
  if ask "同时删除 19 个 lark-* 技能吗？（lark-cli 本体不受影响）"; then
    rm -rf "$HOME/.claude/skills"/lark-*
    success "lark-* 技能已删除"
  else
    warn "lark-* 技能保留"
  fi
fi

# 5) 安装目录（最后删，脚本自身在里面）
if [[ -d "${LUCKAGENT_HOME}" ]]; then
  rm -rf "${LUCKAGENT_HOME}"
  success "已删除安装目录 ${LUCKAGENT_HOME}"
fi

echo ""
success "卸载完成。以下为刻意保留项，需要时自行处理："
warn "~/projects/ —— bot 工作区与共用规范 CLAUDE.md（你的项目数据）"
warn "~/.claude/projects/ 下各工作区的会话与记忆"
warn "~/.lark-cli/config.json —— 内含各 bot 应用凭证 profile，不再用请手动清理"
warn "~/.zprofile 里的 PATH 行（brew / node / ~/.local/bin）—— 无害，可留"
warn "brew / node / pm2 / lark-cli / claude / opencli 等共享工具"
echo "  若曾 npm i -g luckagent（引导器）：npm rm -g luckagent"
