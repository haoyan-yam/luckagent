#!/usr/bin/env bash
# Luckagent 一键安装（macOS）
#
#   bash install.sh              # 交互安装（推荐）
#   bash install.sh --yes        # 全部用默认值，不提问
#   bash install.sh --no-system  # 跳过系统级步骤（Homebrew/node/pm2/全局 npm），
#                                # 只装项目本体——用于沙箱测试或已备齐环境的机器
#
# 安装完成后：浏览器打开 http://localhost:9100/admin，用打印出的 API_SECRET 登录，
# 走「飞书接入向导」创建第一个机器人。

set -euo pipefail

YES=false
NO_SYSTEM=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y)      YES=true ;;
    --no-system)   NO_SYSTEM=true ;;
    --help|-h)
      sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "未知参数: $arg（--help 查看用法）"; exit 1 ;;
  esac
done

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[OK]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }

ask_yn() { # ask_yn "问题" default(y/n)
  local q="$1" def="${2:-y}"
  if [[ "$YES" == "true" ]]; then [[ "$def" == "y" ]]; return; fi
  local hint="[Y/n]"; [[ "$def" == "n" ]] && hint="[y/N]"
  read -r -p "$q $hint " ans || ans=""
  ans="${ans:-$def}"
  [[ "$ans" =~ ^[Yy] ]]
}

LUCKAGENT_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$LUCKAGENT_HOME"

echo -e "${BOLD}"
echo "  🍀 Luckagent 安装程序"
echo -e "${NC}"
info "安装目录: $LUCKAGENT_HOME"

# ============================================================
# 第一段：系统前置（Homebrew / node 22 / git / pm2）
# ============================================================
if [[ "$NO_SYSTEM" != "true" ]]; then
  if [[ "$(uname -s)" != "Darwin" ]]; then
    warn "本脚本面向 macOS；其他系统请自行准备 node>=22 / git / pm2 后用 --no-system 重跑。"
  fi

  # Homebrew（安装过程会自动带出 Xcode Command Line Tools，需要输入密码，
  # CLT 下载可能要 5–15 分钟）
  if ! command -v brew &>/dev/null && [[ "$(uname -s)" == "Darwin" ]]; then
    info "未检测到 Homebrew，开始安装（会提示输入开机密码）..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
      || { error "Homebrew 安装失败。手动安装后重跑：https://brew.sh"; exit 1; }
    # Apple Silicon 默认装在 /opt/homebrew，本 shell 里先接上
    if [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
  fi

  # node >= 22
  node_major=0
  if command -v node &>/dev/null; then node_major="$(node -v | sed 's/^v//' | cut -d. -f1)"; fi
  if (( node_major < 22 )); then
    info "安装 node@22 ..."
    brew install node@22 || { error "node 安装失败。手动执行: brew install node@22"; exit 1; }
    brew link --overwrite node@22 2>/dev/null || true
    if [[ -d /opt/homebrew/opt/node@22/bin ]]; then export PATH="/opt/homebrew/opt/node@22/bin:$PATH"; fi
  fi
  success "node $(node -v)"

  command -v git &>/dev/null || { info "安装 git ..."; brew install git; }

  if ! command -v pm2 &>/dev/null; then
    info "安装 pm2（进程守护）..."
    npm install -g pm2 || { error "pm2 安装失败。手动执行: npm install -g pm2"; exit 1; }
  fi
  success "pm2 $(pm2 -v 2>/dev/null || echo '?')"
else
  info "--no-system：跳过系统前置检查"
  command -v node &>/dev/null || { error "node 不存在，--no-system 模式要求已装 node>=22"; exit 1; }
fi

# ============================================================
# 第二段：项目本体
# ============================================================
info "安装依赖（首次需要几分钟，better-sqlite3 等原生模块会本地编译）..."
npm install --no-audit --no-fund

info "构建（管理台前端 + TypeScript）..."
npm run build

mkdir -p "$LUCKAGENT_HOME/logs"

# ---- .env ----
if [[ ! -f .env ]]; then
  info "生成 .env ..."
  cp .env.example .env
  # 随机 API_SECRET（管理台登录密钥）
  secret="$( (command -v openssl &>/dev/null && openssl rand -hex 24) || head -c 36 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 48 )"
  # 用 python 做精确行替换，避免 sed 转义坑
  API_SECRET_VALUE="$secret" python3 - <<'PYEOF'
import os
p = '.env'
s = open(p).read()
s = s.replace('API_SECRET=', 'API_SECRET=' + os.environ['API_SECRET_VALUE'], 1)
open(p, 'w').write(s)
PYEOF
  chmod 600 .env
  success ".env 已生成（API_SECRET 已随机生成）"

  if [[ "$YES" != "true" ]]; then
    read -r -p "现在填入 ANTHROPIC_API_KEY 吗？（回车跳过，之后可编辑 .env） " akey || akey=""
    if [[ -n "$akey" ]]; then
      ANTHROPIC_KEY_VALUE="$akey" python3 - <<'PYEOF'
import os
p = '.env'
s = open(p).read()
s = s.replace('# ANTHROPIC_API_KEY=sk-ant-...', 'ANTHROPIC_API_KEY=' + os.environ['ANTHROPIC_KEY_VALUE'], 1)
open(p, 'w').write(s)
PYEOF
      success "ANTHROPIC_API_KEY 已写入"
    fi
  fi
else
  info ".env 已存在，跳过生成"
fi

# ---- bots.json（空列表启动，之后用管理台向导补配）----
if [[ ! -f bots.json ]]; then
  printf '{\n  "feishuBots": []\n}\n' > bots.json
  chmod 600 bots.json
  success "bots.json 已生成（空列表——用管理台「飞书接入向导」添加机器人）"
fi

# ---- CLI 入口 ----
mkdir -p "$HOME/.local/bin"
cp bin/luckagent "$HOME/.local/bin/luckagent" && chmod +x "$HOME/.local/bin/luckagent"
success "CLI 已安装: ~/.local/bin/luckagent"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) warn '~/.local/bin 不在 PATH 里。把这行加进 ~/.zshrc:  export PATH="$HOME/.local/bin:$PATH"' ;;
esac

# ---- 技能同步（Claude Code / Codex 双目录）----
info "同步技能到 ~/.claude/skills 与 ~/.codex/skills ..."
mkdir -p "$HOME/.claude/skills" "$HOME/.codex/skills"
for skill in luckagent voice luckagent-team; do
  case "$skill" in
    luckagent)      src="$LUCKAGENT_HOME/packages/skills/luckagent" ;;
    voice)          src="$LUCKAGENT_HOME/src/skills/voice" ;;
    luckagent-team) src="$LUCKAGENT_HOME/src/skills/luckagent-team" ;;
  esac
  if [[ -d "$src" ]]; then
    for dst_root in "$HOME/.claude/skills" "$HOME/.codex/skills"; do
      mkdir -p "$dst_root/$skill" && cp -r "$src/." "$dst_root/$skill/"
    done
  fi
done
success "技能已同步（luckagent / voice / luckagent-team）"

# ---- lark-cli（必装：bot 操作飞书文档/表格/日历、群日报拉群消息都依赖它）----
LARK_CLI_TODO=""
if [[ "$NO_SYSTEM" != "true" ]]; then
  if ! command -v lark-cli &>/dev/null; then
    info "安装 lark-cli（飞书官方 CLI，Luckagent 必备组件）..."
    npm install -g @larksuite/cli       || npm install -g --prefix "$HOME/.local" @larksuite/cli       || { error "lark-cli 安装失败——群日报/文档操作等能力不可用"; LARK_CLI_TODO="npm install -g @larksuite/cli && npx skills add larksuite/cli --all -y -g"; }
  fi
  if command -v lark-cli &>/dev/null; then
    success "lark-cli $(lark-cli --version 2>/dev/null || echo '已安装')"
    info "安装 lark-cli AI Agent 技能（19 个）..."
    npx skills add larksuite/cli --all -y -g 2>/dev/null && success "lark 技能已装"       || { warn "lark 技能安装失败"; LARK_CLI_TODO="npx skills add larksuite/cli --all -y -g"; }
  fi
else
  command -v lark-cli &>/dev/null || warn "--no-system：跳过 lark-cli 安装，但它是必备组件——正式环境请确保已装（npm i -g @larksuite/cli）"
fi

# ---- 工作区目录 ----
BOTS_ROOT="$HOME/projects"
mkdir -p "$BOTS_ROOT"
if [[ ! -f "$BOTS_ROOT/CLAUDE.md" && -f "$LUCKAGENT_HOME/src/workspace/PROJECTS-CLAUDE.md" ]]; then
  cp "$LUCKAGENT_HOME/src/workspace/PROJECTS-CLAUDE.md" "$BOTS_ROOT/CLAUDE.md"
  success "工作区共用规范已部署: $BOTS_ROOT/CLAUDE.md"
fi

# ============================================================
# 启动
# ============================================================
if [[ "$NO_SYSTEM" != "true" ]]; then
  info "用 PM2 启动 luckagent-bridge + luckagent-core ..."
  pm2 start ecosystem.config.cjs
  pm2 save --force >/dev/null 2>&1 || true

  # 等 core 起来后，把首启管理员 token 接到 CLI（memory/skills/agents 子命令用）
  core_data="$HOME/.luckagent-core/data"
  for _ in $(seq 1 15); do
    curl -sf http://localhost:9200/health >/dev/null 2>&1 && break
    sleep 1
  done
  if [[ -f "$core_data/admin-bootstrap-token.txt" && ! -f "$HOME/.luckagent-core/token" ]]; then
    cp "$core_data/admin-bootstrap-token.txt" "$HOME/.luckagent-core/token"
    chmod 600 "$HOME/.luckagent-core/token"
    success "core 管理员 token 已接入 CLI（~/.luckagent-core/token）"
  fi
else
  info "--no-system：不注册 PM2。前台启动命令："
  echo "    core:   node packages/server/dist/index.js"
  echo "    bridge: npx tsx src/index.ts"
fi

# ============================================================
# 完成
# ============================================================
api_port="$(sed -n 's/^API_PORT=//p' .env 2>/dev/null | head -1)"
api_secret="$(sed -n 's/^API_SECRET=//p' .env 2>/dev/null | head -1)"
echo ""
echo -e "${BOLD}🎉 安装完成！接下来：${NC}"
echo ""
echo "  1. 打开管理台:  http://localhost:${api_port:-9100}/admin"
echo "     登录密钥（API_SECRET）: ${api_secret:-<见 .env>}"
echo "  2. 在管理台点「飞书接入向导」，创建并保存第一个机器人，然后点「重启桥接」"
echo "  3. Claude 引擎认证：编辑 .env 填 ANTHROPIC_API_KEY（或配 CLAUDE_EXECUTABLE_PATH），"
echo "     然后 luckagent restart"
if [[ "$NO_SYSTEM" != "true" ]]; then
  echo "  4. 开机自启（推荐）：执行  pm2 startup  并按提示运行输出的 sudo 命令，再 pm2 save"
fi
echo ""
if [[ -n "$LARK_CLI_TODO" ]]; then
  echo -e "  ${RED}❗ 待办${NC}: lark-cli 未装齐（必备组件），请手动执行:"
  echo "     $LARK_CLI_TODO"
  echo ""
fi
echo "  常用命令:  luckagent status | logs | restart | doctor --json | help"
echo "  详细文档:  INSTALL.md 与 docs/ 目录"
echo ""
