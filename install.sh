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
    *) echo "未知参数: ${arg}（--help 查看用法）"; exit 1 ;;
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

# 把一行 PATH 设置持久化进 ~/.zprofile（幂等：已有同行则跳过）
_persist_zprofile() {
  local line="$1" f="$HOME/.zprofile"
  touch "$f"
  grep -qxF "$line" "$f" 2>/dev/null || { echo "$line" >> "$f"; info "已写入 ~/.zprofile: $line"; }
}

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
    if [[ "$YES" == "true" ]]; then
      NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
        || { error "Homebrew 安装失败。手动安装后重跑：https://brew.sh"; exit 1; }
    else
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
        || { error "Homebrew 安装失败。手动安装后重跑：https://brew.sh"; exit 1; }
    fi
    # Apple Silicon 默认装在 /opt/homebrew，本 shell 里先接上
    if [[ -x /opt/homebrew/bin/brew ]]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
  fi
  # 新终端也要能找到 brew（curl|bash 安装器不写 /etc/paths.d）
  if [[ -x /opt/homebrew/bin/brew ]]; then
    _persist_zprofile 'eval "$(/opt/homebrew/bin/brew shellenv)"'
  fi

  # node >= 22
  node_major=0
  if command -v node &>/dev/null; then node_major="$(node -v | sed 's/^v//' | cut -d. -f1)"; fi
  if (( node_major < 22 )); then
    info "安装 node@22 ..."
    brew install node@22 || { error "node 安装失败。手动执行: brew install node@22"; exit 1; }
    # node@22 是 keg-only：不带 --force 的 link 必失败（会被静默吞掉）
    brew link --overwrite --force node@22 2>/dev/null || true
    if [[ -d /opt/homebrew/opt/node@22/bin ]]; then
      export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
      _persist_zprofile 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"'
    fi
  fi
  success "node $(node -v)"

  command -v git &>/dev/null || { info "安装 git ..."; brew install git; }

  if ! command -v pm2 &>/dev/null; then
    info "安装 pm2（进程守护）..."
    npm install -g pm2 \
      || { npm install -g --prefix "$HOME/.local" pm2 && export PATH="$HOME/.local/bin:$PATH"; } \
      || { error "pm2 安装失败。手动执行: npm install -g pm2"; exit 1; }
  fi
  success "pm2 $(pm2 -v 2>/dev/null || echo '?')"
else
  info "--no-system：跳过系统前置检查"
  command -v node &>/dev/null || { error "node 不存在，--no-system 模式要求已装 node>=22"; exit 1; }
fi

# ============================================================
# 第二段：工具与引擎盘点（信息 + 可选代装，全部可跳过）
# ============================================================
_mark(){ command -v "$1" &>/dev/null && echo "✓ 已安装" || echo "✗ 未安装"; }
echo ""
echo -e "${BOLD}—— 工具与引擎盘点 ——${NC}"
echo "  引擎（bot 按 bots.json 选择，至少配一种认证即可干活）:"
echo "    Claude Code CLI   $(_mark claude)    （订阅登录路线；或稍后在 .env 填 ANTHROPIC_API_KEY 走 API 路线）"
echo "    DeepSeek          无需装 CLI    （可选引擎；只要 API key，见下方申请入口）"
echo "  增强工具:"
echo "    opencli           $(_mark opencli)    （网站自动化；检测到即自动启用其技能，之后安装的话重跑一次 bash install.sh 生效）"
echo "    lark-cli          $(_mark lark-cli)    （必备，稍后自动安装）"
echo "  需要申请的 key（安装中可粘贴，也可之后编辑 .env）:"
echo "    Claude API:  https://console.anthropic.com  → ANTHROPIC_API_KEY"
echo "    生图（二选一）: OpenAI https://platform.openai.com → OPENAI_IMAGE_API_KEY"
echo "                   火山方舟 https://console.volcengine.com/ark → ARK_API_KEY（需开通 Doubao-Seedream 模型）"
echo "    DeepSeek 引擎（可选）: https://platform.deepseek.com → DEEPSEEK_API_KEY"
echo "    MiniMax 引擎（可选）: https://platform.minimaxi.com → MINIMAX_API_KEY"
echo "    语音 TTS（可选）: 火山 VOLCENGINE_TTS_*（不配则用免费 Edge TTS）"
echo ""
# ---- 选择默认引擎（每个 bot 之后仍可在管理台单独选） ----
ENGINE_CHOICE="claude"
if [[ "$YES" != "true" ]]; then
  echo -e "${BOLD}—— 选择默认引擎 ——${NC}"
  echo "  1) Claude Code —— 能力最强（需 Claude 订阅登录，或 ANTHROPIC_API_KEY）"
  echo "  2) DeepSeek    —— 零安装、成本低（只要一个 DeepSeek API key）"
  echo "  3) MiniMax     —— 零安装、原生看图（只要一个 MiniMax API key）"
  read -r -p "默认引擎 [1/2/3]（回车 = 1 Claude） " eng_choice || eng_choice=""
  [[ "$eng_choice" == "2" ]] && ENGINE_CHOICE="deepseek"
  [[ "$eng_choice" == "3" ]] && ENGINE_CHOICE="minimax"
  echo ""
fi

if [[ "$ENGINE_CHOICE" == "claude" ]] && [[ "$NO_SYSTEM" != "true" ]] && ! command -v claude &>/dev/null; then
  if ask_yn "现在安装 Claude Code CLI（订阅登录路线需要它；纯 API key 路线可跳过）？" y; then
    curl -fsSL https://claude.ai/install.sh | bash \
      && success "Claude Code CLI 已安装——稍后在终端跑一次 claude 完成登录（走 API key 路线则无需登录）" \
      || warn "Claude Code CLI 安装失败，可稍后手动: curl -fsSL https://claude.ai/install.sh | bash"
  fi
fi

# ============================================================
# 第三段：项目本体
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
    if [[ "$ENGINE_CHOICE" == "minimax" ]]; then
      python3 - <<'PYEOF'
p = '.env'
s = open(p).read()
s = s.replace('# LUCKAGENT_ENGINE=deepseek', 'LUCKAGENT_ENGINE=minimax', 1)
open(p, 'w').write(s)
PYEOF
      success "默认引擎已设为 MiniMax（.env 的 LUCKAGENT_ENGINE，可随时改）"
      read -r -p "填入 MINIMAX_API_KEY（申请: https://platform.minimaxi.com；回车跳过则之后补填 .env） " mkey || mkey=""
      if [[ -n "$mkey" ]]; then
        MINIMAX_KEY_VALUE="$mkey" python3 - <<'PYEOF'
import os
p = '.env'
s = open(p).read()
s = s.replace('# MINIMAX_API_KEY=sk-cp-...', 'MINIMAX_API_KEY=' + os.environ['MINIMAX_KEY_VALUE'], 1)
open(p, 'w').write(s)
PYEOF
        success "MINIMAX_API_KEY 已写入（默认模型 MiniMax-M3）"
      else
        warn "还没填 key——bot 干活前记得编辑 .env 补上 MINIMAX_API_KEY"
      fi
      echo "  （想同时用其他引擎：之后编辑 .env 填对应 key 即可）"
    elif [[ "$ENGINE_CHOICE" == "deepseek" ]]; then
      # ---- DeepSeek 路线：写默认引擎 + 要 key ----
      python3 - <<'PYEOF'
p = '.env'
s = open(p).read()
s = s.replace('# LUCKAGENT_ENGINE=deepseek', 'LUCKAGENT_ENGINE=deepseek', 1)
open(p, 'w').write(s)
PYEOF
      success "默认引擎已设为 DeepSeek（.env 的 LUCKAGENT_ENGINE，可随时改）"
      read -r -p "填入 DEEPSEEK_API_KEY（申请: https://platform.deepseek.com；回车跳过则之后补填 .env） " dkey || dkey=""
      if [[ -n "$dkey" ]]; then
        DEEPSEEK_KEY_VALUE="$dkey" python3 - <<'PYEOF'
import os
p = '.env'
s = open(p).read()
s = s.replace('# DEEPSEEK_API_KEY=sk-...', 'DEEPSEEK_API_KEY=' + os.environ['DEEPSEEK_KEY_VALUE'], 1)
open(p, 'w').write(s)
PYEOF
        success "DEEPSEEK_API_KEY 已写入"
      else
        warn "还没填 key——bot 干活前记得编辑 .env 补上 DEEPSEEK_API_KEY"
      fi
      read -r -p "默认模型 [1/2]（回车 = 1 deepseek-v4-flash 快而省；输 2 = deepseek-v4-pro 更强推理、更贵） " dmodel || dmodel=""
      if [[ "$dmodel" == "2" ]]; then
        python3 - <<'PYEOF'
p = '.env'
s = open(p).read()
s = s.replace('# DEEPSEEK_MODEL=deepseek-v4-flash', 'DEEPSEEK_MODEL=deepseek-v4-pro', 1)
open(p, 'w').write(s)
PYEOF
        success "DeepSeek 默认模型已设为 deepseek-v4-pro（.env 的 DEEPSEEK_MODEL，可随时改回）"
      fi
      echo "  （想同时用 Claude 引擎：之后编辑 .env 填 ANTHROPIC_API_KEY，或装 Claude CLI 登录）"
    else
      # ---- Claude 路线：认证二选一 ----
      echo "  Claude 引擎认证二选一："
      echo "    ① API key 路线 —— 在下面粘贴 ANTHROPIC_API_KEY"
      echo "    ② 订阅登录路线 —— 直接回车跳过，安装结束后在终端跑一次 claude 完成浏览器登录即可"
      read -r -p "现在填入 ANTHROPIC_API_KEY 吗？（订阅用户直接回车跳过） " akey || akey=""
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
      echo "  （想同时用 DeepSeek 引擎：之后编辑 .env 填 DEEPSEEK_API_KEY 即可）"
    fi
    read -r -p "填入生图 key 吗？OpenAI(sk-…) 或火山(ark-…) 均可，按前缀自动识别（回车跳过） " ikey || ikey=""
    if [[ -n "$ikey" ]]; then
      if [[ "$ikey" == ark-* ]]; then
        IMAGE_KEY_VALUE="$ikey" python3 - <<'PYEOF'
import os
p = '.env'
s = open(p).read()
s = s.replace('# ARK_API_KEY=', 'ARK_API_KEY=' + os.environ['IMAGE_KEY_VALUE'], 1)
open(p, 'w').write(s)
PYEOF
        success "ARK_API_KEY 已写入（生图走火山 Seedream；记得在方舟控制台开通 Doubao-Seedream 模型）"
      else
        IMAGE_KEY_VALUE="$ikey" python3 - <<'PYEOF'
import os
p = '.env'
s = open(p).read()
s = s.replace('# OPENAI_IMAGE_API_KEY=sk-...', 'OPENAI_IMAGE_API_KEY=' + os.environ['IMAGE_KEY_VALUE'], 1)
open(p, 'w').write(s)
PYEOF
        success "OPENAI_IMAGE_API_KEY 已写入（生图走 gpt-image-2）"
      fi
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
if [[ -e "$HOME/.local/bin/luckagent" && bin/luckagent -ef "$HOME/.local/bin/luckagent" ]]; then
  info "CLI 已是同一文件（符号链接），跳过拷贝"
else
  cp bin/luckagent "$HOME/.local/bin/luckagent"
fi
chmod +x "$HOME/.local/bin/luckagent"
success "CLI 已安装: ~/.local/bin/luckagent"
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *)
    export PATH="$HOME/.local/bin:$PATH"
    _persist_zprofile 'export PATH="$HOME/.local/bin:$PATH"'
    success "~/.local/bin 已写入 ~/.zprofile —— 新终端自动生效"
    PATH_JUST_ADDED=1
    ;;
esac

# ---- 技能同步 ----
info "同步技能到 ~/.claude/skills ..."
mkdir -p "$HOME/.claude/skills"
SYNC_SKILLS="luckagent voice luckagent-team image-gen"
command -v opencli &>/dev/null && SYNC_SKILLS="$SYNC_SKILLS opencli"
for skill in $SYNC_SKILLS; do
  case "$skill" in
    luckagent)      src="$LUCKAGENT_HOME/packages/skills/luckagent" ;;
    voice)          src="$LUCKAGENT_HOME/src/skills/voice" ;;
    luckagent-team) src="$LUCKAGENT_HOME/src/skills/luckagent-team" ;;
    image-gen)      src="$LUCKAGENT_HOME/src/skills/image-gen" ;;
    opencli)        src="$LUCKAGENT_HOME/src/skills/opencli" ;;
  esac
  if [[ -d "$src" ]]; then
    for dst_root in "$HOME/.claude/skills"; do
      mkdir -p "$dst_root/$skill" && cp -r "$src/." "$dst_root/$skill/"
    done
  fi
done
success "技能已同步（${SYNC_SKILLS}）"
# 清理旧名技能目录（仅限本项目早期版本装出的副本，以脱敏标记识别；个人同名技能不受影响）
for dst_root in "$HOME/.claude/skills"; do
  old="$dst_root/openai-image-gen"
  if [[ -f "$old/SKILL.md" ]] && grep -q "当用户说" "$old/SKILL.md" 2>/dev/null; then
    rm -rf "$old" && info "已移除旧名技能目录: ${old}（更名为 image-gen）"
  fi
done

# ---- frontend-slides（第三方 MIT 技能：HTML 演示文稿/PPT 转网页，从上游拉取保持最新）----
FS_SKILL_DIR="$HOME/.claude/skills/frontend-slides"
if [[ -d "$FS_SKILL_DIR/.git" ]] && command -v git &>/dev/null; then
  git -C "$FS_SKILL_DIR" pull --ff-only --quiet 2>/dev/null     && info "frontend-slides 技能已更新（上游 main）"     || warn "frontend-slides 上游更新失败（保留现有版本）"
elif [[ ! -d "$FS_SKILL_DIR" ]] && command -v git &>/dev/null; then
  info "拉取 frontend-slides 技能（HTML 演示文稿生成，MIT · zarazhangrui/frontend-slides）..."
  git clone --depth 1 https://github.com/zarazhangrui/frontend-slides "$FS_SKILL_DIR" 2>/dev/null     && success "frontend-slides 技能已安装"     || warn "frontend-slides 拉取失败（可选技能，不影响安装）。之后手动: git clone https://github.com/zarazhangrui/frontend-slides ~/.claude/skills/frontend-slides"
fi

# ---- lark-cli（必装：bot 操作飞书文档/表格/日历、群日报拉群消息都依赖它）----
LARK_CLI_TODO=""
if [[ "$NO_SYSTEM" != "true" ]]; then
  if ! command -v lark-cli &>/dev/null; then
    info "安装 lark-cli（飞书官方 CLI，Luckagent 必备组件）..."
    npm install -g @larksuite/cli       || { npm install -g --prefix "$HOME/.local" @larksuite/cli && export PATH="$HOME/.local/bin:$PATH"; }       || { error "lark-cli 安装失败——群日报/文档操作等能力不可用"; LARK_CLI_TODO="npm install -g @larksuite/cli && npx -y skills add larksuite/cli --all -y -g"; }
  fi
  if command -v lark-cli &>/dev/null; then
    success "lark-cli $(lark-cli --version 2>/dev/null || echo '已安装')"
    info "安装 lark-cli AI Agent 技能（19 个）..."
    npx -y skills add larksuite/cli --all -y -g 2>/dev/null && success "lark 技能已装"       || { warn "lark 技能安装失败"; LARK_CLI_TODO="npx -y skills add larksuite/cli --all -y -g"; }
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

  # ---- 开机自启（真实事故：macOS 半夜自动更新重启后 bot 离线一整个上午，
  # 因为 pm2 startup 从没被执行过——它需要 sudo，不能默默代跑，所以在这里问）----
  _pm2_startup_configured() {
    ls "$HOME"/Library/LaunchAgents/*pm2*.plist /Library/LaunchDaemons/*pm2*.plist >/dev/null 2>&1
  }
  if [[ "$YES" != "true" ]] && ! _pm2_startup_configured; then
    if ask_yn "配置开机自启？（推荐：系统更新/断电重启后自动拉起 bot，需要输入密码）" y; then
      if sudo env PATH="$PATH" "$(command -v pm2)" startup launchd -u "$(whoami)" --hp "$HOME"; then
        pm2 save --force >/dev/null 2>&1 || true
        success "开机自启已配置（launchd）"
      else
        warn "开机自启配置失败——稍后手动: pm2 startup（按提示执行 sudo 命令）→ pm2 save"
      fi
    fi
  fi

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
if [[ "${ENGINE_CHOICE:-claude}" == "minimax" ]]; then
  if grep -q "^MINIMAX_API_KEY=" .env 2>/dev/null; then
    echo "  3. 默认引擎 MiniMax 已就绪（key 已配置），建 bot 即可干活"
  else
    echo "  3. 默认引擎已设为 MiniMax——干活前编辑 .env 补上 MINIMAX_API_KEY，然后 luckagent restart"
  fi
elif [[ "${ENGINE_CHOICE:-claude}" == "deepseek" ]]; then
  if grep -q "^DEEPSEEK_API_KEY=" .env 2>/dev/null; then
    echo "  3. 默认引擎 DeepSeek 已就绪（key 已配置），建 bot 即可干活"
  else
    echo "  3. 默认引擎已设为 DeepSeek——干活前编辑 .env 补上 DEEPSEEK_API_KEY，然后 luckagent restart"
  fi
elif command -v claude &>/dev/null && ! grep -q "^ANTHROPIC_API_KEY=" .env 2>/dev/null; then
  echo "  3. Claude 引擎认证（订阅路线）：终端跑一次  claude  完成浏览器登录即可"
  echo "     （安装器无法代做 OAuth；已登录过则忽略。走 API 路线则编辑 .env 填 ANTHROPIC_API_KEY）"
else
  echo "  3. Claude 引擎认证：编辑 .env 填 ANTHROPIC_API_KEY（或装 Claude CLI 跑一次 claude 登录），"
  echo "     然后 luckagent restart"
fi
if [[ "$NO_SYSTEM" != "true" ]]; then
  if ls "$HOME"/Library/LaunchAgents/*pm2*.plist /Library/LaunchDaemons/*pm2*.plist >/dev/null 2>&1; then
    echo "  4. 开机自启：✅ 已配置（系统重启后自动拉起）"
  else
    echo "  4. ⚠️ 开机自启未配置：执行  pm2 startup  并按提示运行输出的 sudo 命令，再 pm2 save"
    echo "     （不配的话：系统更新/断电重启后 bot 不会自动恢复——真实事故导致过整个上午离线）"
  fi
fi
echo ""
if [[ -n "$LARK_CLI_TODO" ]]; then
  echo -e "  ${RED}❗ 待办${NC}: lark-cli 未装齐（必备组件），请手动执行:"
  echo "     $LARK_CLI_TODO"
  echo ""
fi
echo "  可选能力（编辑 .env 填 key 后 luckagent restart 生效）:"
echo "     生图: OPENAI_IMAGE_API_KEY 或 火山 ARK_API_KEY（Seedream）   语音TTS: VOLCENGINE_TTS_*（不填则用免费 Edge TTS）"
echo "  可选增强: 安装 opencli（网站自动化）后重跑一次 bash install.sh，其技能自动启用；"
echo ""
if [[ "${PATH_JUST_ADDED:-}" == "1" ]]; then
  echo "  ⚠️  当前终端还找不到 luckagent 命令的话，先执行:  source ~/.zprofile  （或新开终端）"
fi
echo "  常用命令:  luckagent status | logs | restart | doctor --json | help"
echo "  详细文档:  INSTALL.md 与 docs/ 目录"
echo ""
