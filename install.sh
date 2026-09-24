#!/usr/bin/env bash
# Luckagent 一键安装（macOS）
#
#   bash install.sh              # 交互安装（推荐）
#   bash install.sh --yes        # 全部用默认值，不提问
#   bash install.sh --no-system  # 跳过系统级步骤（Homebrew/node/pm2/全局 npm/办公媒体工具链），
#                                # 只装项目本体——用于沙箱测试或已备齐环境的机器
#   bash install.sh --skip-net-check  # 跳过开头的网络检查（确认网络没问题时）
#
# 安装完成后：浏览器打开 http://localhost:9100/admin，用打印出的 API_SECRET 登录，
# 走「飞书接入向导」创建第一个机器人。

set -euo pipefail

YES=false
NO_SYSTEM=false
SKIP_NET_CHECK=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y)      YES=true ;;
    --no-system)   NO_SYSTEM=true ;;
    --skip-net-check) SKIP_NET_CHECK=true ;;
    --help|-h)
      sed -n '2,12p' "$0"; exit 0 ;;
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

# .env 读写（首次生成与重跑都能用）：_env_get KEY 输出已生效的值（注释行不算）；
# _env_set KEY VALUE 替换已有的 KEY= 行，否则替换第一处 # KEY= 注释行，都没有就追加。
_env_get() {
  sed -n "s/^$1=//p" .env 2>/dev/null | head -1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}
_env_set() {
  ENV_KEY="$1" ENV_VALUE="$2" python3 - <<'PYEOF'
import os, re
k, v = os.environ['ENV_KEY'], os.environ['ENV_VALUE']
p = '.env'
lines = open(p).read().splitlines()
line = f'{k}={v}'
for pat in (rf'^{re.escape(k)}=', rf'^#\s*{re.escape(k)}='):
    idx = next((i for i, l in enumerate(lines) if re.match(pat, l)), None)
    if idx is not None:
        lines[idx] = line
        break
else:
    lines.append(line)
open(p, 'w').write('\n'.join(lines) + '\n')
PYEOF
}

# ---- 网络检查 ----
# 安装要从 GitHub / Homebrew / npm / PyPI 下载；网络不通时这些下载不报错、只是挂住不动。
# 先把这些源测一遍，有问题就停下来提示开梯子的 TUN 模式，别装到一半卡死。
if [[ "$SKIP_NET_CHECK" != "true" ]]; then
  if [[ "$YES" == "true" ]]; then
    bash scripts/net-check.sh --report \
      || { error "网络检查未通过（见上）。开好梯子 TUN 模式后重跑；确认网络没问题可加 --skip-net-check"; exit 1; }
  else
    bash scripts/net-check.sh || { info "已退出。开好梯子 TUN 模式后重跑: bash install.sh"; exit 1; }
  fi
  echo ""
fi

# 下载兜底：网络在安装中途变差时，git / curl 低于 1 KB/s 持续 60 秒就失败退出，而不是永远挂着
# （env 会传给 Homebrew 官方安装器里的 git）。安装可重复执行，失败后开好网络重跑即可。
export GIT_HTTP_LOW_SPEED_LIMIT="${GIT_HTTP_LOW_SPEED_LIMIT:-1000}"
export GIT_HTTP_LOW_SPEED_TIME="${GIT_HTTP_LOW_SPEED_TIME:-60}"
CURL_GUARD=(--connect-timeout 15 --speed-limit 1000 --speed-time 60)

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
      NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL "${CURL_GUARD[@]}" https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
        || { error "Homebrew 安装失败。多为网络问题：开好梯子 TUN 模式后重跑 bash install.sh（可重复执行）"; exit 1; }
    else
      /bin/bash -c "$(curl -fsSL "${CURL_GUARD[@]}" https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" \
        || { error "Homebrew 安装失败。多为网络问题：开好梯子 TUN 模式后重跑 bash install.sh（可重复执行）"; exit 1; }
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
# Google Chrome：opencli 的浏览器自动化与需登录站点的命令要驱动本机已登录的 Chrome
_chrome_installed() {
  [[ -d "/Applications/Google Chrome.app" || -d "$HOME/Applications/Google Chrome.app" ]] \
    || command -v google-chrome &>/dev/null || command -v google-chrome-stable &>/dev/null
}
_chrome_mark(){ _chrome_installed && echo "✓ 已安装" || echo "✗ 未安装"; }
echo ""
echo -e "${BOLD}—— 工具与引擎盘点 ——${NC}"
echo "  引擎（bot 按 bots.json 选择，至少配一种认证即可干活）:"
echo "    Claude Code CLI   $(_mark claude)    （订阅登录路线；或稍后在 .env 填 ANTHROPIC_API_KEY 走 API 路线）"
echo "    DeepSeek          无需装 CLI    （可选引擎；只要 API key，见下方申请入口）"
echo "  增强工具:"
echo "    opencli           $(_mark opencli)    （网站自动化：抓取 / 搜索 155+ 网站、驱动浏览器；稍后询问并代装）"
echo "    Google Chrome     $(_chrome_mark)    （opencli 驱动已登录的 Chrome 做浏览器自动化；需自行安装）"
echo "    lark-cli          $(_mark lark-cli)    （必备，稍后自动安装）"
echo "    Codex CLI         $(_mark codex)    （生图首选：有 ChatGPT 订阅即可，稍后询问并代装）"
echo "  需要申请的 key（安装中可粘贴，也可之后编辑 .env）:"
echo "    Claude API:  https://console.anthropic.com  → ANTHROPIC_API_KEY"
echo "    生图（没有 ChatGPT 订阅时）: 火山方舟 https://console.volcengine.com/ark → ARK_API_KEY（需开通 Doubao-Seedream 模型）"
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
    curl -fsSL "${CURL_GUARD[@]}" https://claude.ai/install.sh | bash \
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

# ---- opencli（网站自动化；默认代装）----
# 把 155+ 网站变成 CLI、驱动本机已登录的 Chrome 做浏览器自动化。装了才同步 opencli 技能。
OPENCLI_TODO=""
if command -v opencli &>/dev/null; then
  success "opencli $(opencli --version 2>/dev/null | head -1)"
elif [[ "$NO_SYSTEM" == "true" ]]; then
  info "--no-system：不代装 opencli（需要时手动 npm i -g @jackwener/opencli 后重跑本脚本）"
elif ask_yn "安装 opencli 吗？（网站自动化：让 bot 抓取 / 搜索网站、操作浏览器）" y; then
  info "安装 opencli（@jackwener/opencli 最新版）..."
  npm install -g @jackwener/opencli@latest \
    || { npm install -g --prefix "$HOME/.local" @jackwener/opencli@latest && export PATH="$HOME/.local/bin:$PATH"; } \
    || { warn "opencli 安装失败"; OPENCLI_TODO="npm i -g @jackwener/opencli，然后重跑 bash install.sh 启用其技能"; }
  if command -v opencli &>/dev/null; then success "opencli $(opencli --version 2>/dev/null | head -1) 已安装"; fi
fi
if command -v opencli &>/dev/null && ! _chrome_installed; then
  warn "opencli 的浏览器自动化需要 Google Chrome，本机没检测到"
  OPENCLI_TODO="安装 Google Chrome（https://www.google.com/chrome/），并登录 bot 要访问的网站；之后可跑 opencli doctor 检查浏览器连接"
fi

# ---- 技能同步 ----
info "同步技能到 ~/.claude/skills ..."
mkdir -p "$HOME/.claude/skills"
SYNC_SKILLS="luckagent voice luckagent-team image-gen seedance-video"
command -v opencli &>/dev/null && SYNC_SKILLS="$SYNC_SKILLS opencli"
for skill in $SYNC_SKILLS; do
  case "$skill" in
    luckagent)      src="$LUCKAGENT_HOME/packages/skills/luckagent" ;;
    voice)          src="$LUCKAGENT_HOME/src/skills/voice" ;;
    luckagent-team) src="$LUCKAGENT_HOME/src/skills/luckagent-team" ;;
    image-gen)      src="$LUCKAGENT_HOME/src/skills/image-gen" ;;
    seedance-video) src="$LUCKAGENT_HOME/src/skills/seedance-video" ;;
    opencli)        src="$LUCKAGENT_HOME/src/skills/opencli" ;;
  esac
  if [[ -d "$src" ]]; then
    for dst_root in "$HOME/.claude/skills"; do
      mkdir -p "$dst_root/$skill" && cp -r "$src/." "$dst_root/$skill/"
    done
  fi
done
success "技能已同步（${SYNC_SKILLS}）"
# image-gen 已退役的文件（v0.7.13 去掉 OpenAI API 后端）——cp 不会删目标端多出来的文件
rm -f "$HOME/.claude/skills/image-gen/scripts/gen_image.py" "$HOME/.claude/skills/image-gen/references/image-api.md"
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

# ---- 办公与媒体工具链（必装：bot 产出 PPT/Excel/Word/PDF/图片/语音都靠它们）----
# 来源于生产环境 18 个 bot 的实际依赖统计：python-pptx / openpyxl / Pillow 是产出的三大件，
# LibreOffice 负责 pptx 转 pdf/图自检，poppler 读 PDF，ffmpeg 转语音回复，Noto CJK 是 Pillow 排字的默认中文字体。
# 以前这些全靠 bot 在任务里临时 pip/brew 装，散落在系统 Python 里、换机不可复现——现在装机一次到位。
DEPS_TODO=""
_deps_todo() { DEPS_TODO="${DEPS_TODO}     $1"$'\n'; }
LUCKAGENT_PY_FORMULA="python@3.13"
LUCKAGENT_VENV="$HOME/.luckagent/venv"
if [[ "$NO_SYSTEM" != "true" ]] && command -v brew &>/dev/null; then
  echo ""
  echo -e "${BOLD}—— 办公与媒体工具链 ——${NC}"
  # brew formula：ffmpeg（语音回复 mp3→opus）、poppler（pdftotext/pdftoppm）
  for f in ffmpeg poppler; do
    if brew list --formula "$f" &>/dev/null; then
      success "$f 已安装"
    else
      info "安装 $f ..."
      brew install "$f" && success "$f 已安装" || { warn "$f 安装失败"; _deps_todo "brew install $f"; }
    fi
  done
  # LibreOffice：pptx/docx 转 pdf、转图逐页自检；bridge 的 pptx 预览也调 soffice
  if brew list --cask libreoffice &>/dev/null || [[ -d /Applications/LibreOffice.app ]]; then
    success "LibreOffice 已安装"
  else
    info "安装 LibreOffice（约 400MB，耐心等）..."
    brew install --cask libreoffice && success "LibreOffice 已安装" || { warn "LibreOffice 安装失败"; _deps_todo "brew install --cask libreoffice"; }
  fi
  # 手动装的 LibreOffice 不会把 soffice 放进 PATH——补一个软链
  if ! command -v soffice &>/dev/null && [[ -x /Applications/LibreOffice.app/Contents/MacOS/soffice ]]; then
    mkdir -p "$HOME/.local/bin"
    ln -sf /Applications/LibreOffice.app/Contents/MacOS/soffice "$HOME/.local/bin/soffice"
    info "已链接 soffice → ~/.local/bin/soffice"
  fi
  # Noto Sans CJK SC：Pillow 排字与 LibreOffice 渲染的默认中文字体
  if brew list --cask font-noto-sans-cjk-sc &>/dev/null || ls "$HOME"/Library/Fonts/NotoSansCJKsc-Regular.otf /Library/Fonts/NotoSansCJKsc-Regular.otf &>/dev/null; then
    success "Noto Sans CJK SC 字体已安装"
  else
    info "安装 Noto Sans CJK SC 字体 ..."
    brew install --cask font-noto-sans-cjk-sc && success "Noto Sans CJK SC 字体已安装" || { warn "字体安装失败"; _deps_todo "brew install --cask font-noto-sans-cjk-sc"; }
  fi
  # Python：固定用 brew 的 python@3.13 建一个专用 venv，不碰系统自带的 Python
  # （系统 Python 随 Xcode CLT 升级会整体换版本，装在里面的包会集体失效）
  if ! brew list --formula "$LUCKAGENT_PY_FORMULA" &>/dev/null; then
    info "安装 $LUCKAGENT_PY_FORMULA ..."
    brew install "$LUCKAGENT_PY_FORMULA" || { warn "$LUCKAGENT_PY_FORMULA 安装失败"; _deps_todo "brew install $LUCKAGENT_PY_FORMULA"; }
  fi
  py_bin="$(brew --prefix "$LUCKAGENT_PY_FORMULA" 2>/dev/null)/bin/python3.13"
  if [[ -x "$py_bin" ]]; then
    if [[ -x "$LUCKAGENT_VENV/bin/python" ]] && "$LUCKAGENT_VENV/bin/python" -c 'import sys' &>/dev/null; then
      info "Python venv 已存在: $LUCKAGENT_VENV"
    else
      [[ -d "$LUCKAGENT_VENV" ]] && { warn "旧 venv 已损坏（多半是 Python 升级所致），重建"; rm -rf "$LUCKAGENT_VENV"; }
      info "创建 Python venv: $LUCKAGENT_VENV ..."
      mkdir -p "$HOME/.luckagent"
      "$py_bin" -m venv "$LUCKAGENT_VENV" || { warn "venv 创建失败"; _deps_todo "$py_bin -m venv $LUCKAGENT_VENV"; }
    fi
    if [[ -x "$LUCKAGENT_VENV/bin/python" ]]; then
      info "安装 Python 基础包（requirements.txt：python-pptx / openpyxl / Pillow / pandas / PyMuPDF …）..."
      "$LUCKAGENT_VENV/bin/python" -m pip install -q --upgrade pip >/dev/null 2>&1 || true
      if "$LUCKAGENT_VENV/bin/python" -m pip install -q -r "$LUCKAGENT_HOME/requirements.txt"; then
        success "Python 基础包已就绪（$("$LUCKAGENT_VENV/bin/python" --version 2>&1)）"
      else
        warn "Python 基础包安装失败"; _deps_todo "$LUCKAGENT_VENV/bin/python -m pip install -r $LUCKAGENT_HOME/requirements.txt"
      fi
      # venv 排在 PATH 最前：本终端、新终端、PM2 里的 bot 会话（ecosystem.config.cjs 同样前置）都解析到它
      case ":$PATH:" in
        *":$LUCKAGENT_VENV/bin:"*) ;;
        *) export PATH="$LUCKAGENT_VENV/bin:$PATH" ;;
      esac
      _persist_zprofile 'export PATH="$HOME/.luckagent/venv/bin:$PATH"'
    fi
  else
    warn "找不到 $LUCKAGENT_PY_FORMULA 解释器，跳过 Python venv"
  fi
elif [[ "$NO_SYSTEM" == "true" ]]; then
  warn "--no-system：跳过办公与媒体工具链（ffmpeg / LibreOffice / poppler / Noto CJK / Python venv）——正式环境请确保已装"
fi

# ---- 生图与视频（image-gen / seedance-video 技能）----
# 生图：首选 Codex CLI 内置生图（走 ChatGPT 订阅，无需 key），否则火山 Seedream。
# 视频：火山方舟 Seedance，需要 ARK_API_KEY——与 Seedream 生图共用同一把 key。
# 本地参考视频/音频（群里发来的视频当参考）还需要火山对象存储 TOS，可选。
# 都写进 .env，重跑时已配置的项不再问；之后在管理台「系统配置 → 默认设置」修改。
IMAGE_GEN_TODO=""
VIDEO_TODO=""
_codex_logged_in() {
  command -v codex &>/dev/null || return 1
  local st; st="$(codex login status 2>&1)" || return 1
  [[ "$st" == *"Logged in"* || "$st" == *"logged in"* ]] && [[ "$st" != *"Not logged in"* && "$st" != *"not logged in"* ]]
}
_trim() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}
echo ""
echo -e "${BOLD}—— 生图与视频 ——${NC}"
img_provider="$(_env_get IMAGE_GEN_PROVIDER)"
ark_key_now="$(_env_get ARK_API_KEY)"
codex_wanted=false

# 1) 生图：有 ChatGPT 订阅就走 Codex
if [[ -n "$img_provider" ]]; then
  info "生图已配置：IMAGE_GEN_PROVIDER=${img_provider}（之后可在管理台「系统配置」切换）"
elif [[ "$YES" == "true" ]]; then
  # 无人值守：只检测，不代装、不登录
  if _codex_logged_in; then
    _env_set IMAGE_GEN_PROVIDER codex; img_provider=codex
    success "检测到 Codex 已登录——生图走 Codex"
  fi
else
  if ask_yn "有 ChatGPT 订阅（Plus / Pro / Team 等）、想用它生图吗？（走 Codex CLI，不需要 API key）" y; then
    codex_wanted=true
    if ! command -v codex &>/dev/null; then
      if [[ "$NO_SYSTEM" == "true" ]]; then
        warn "--no-system：不代装 Codex CLI，手动执行 npm i -g @openai/codex"
      else
        info "安装 Codex CLI（@openai/codex 最新版）..."
        npm install -g @openai/codex@latest \
          || { npm install -g --prefix "$HOME/.local" @openai/codex@latest && export PATH="$HOME/.local/bin:$PATH"; } \
          || warn "Codex CLI 安装失败"
      fi
    fi
    if command -v codex &>/dev/null; then
      success "Codex CLI $(codex --version 2>/dev/null | awk '{print $NF}')"
      if ! _codex_logged_in; then
        info "登录 Codex：会打开浏览器，用你的 ChatGPT 账号授权，完成后回到这里 ..."
        codex login || true
      fi
      if _codex_logged_in; then
        _env_set IMAGE_GEN_PROVIDER codex; img_provider=codex
        success "Codex 已登录——生图默认走 Codex（ChatGPT 订阅额度，本机所有 bot 共用这一个登录）"
      else
        warn "Codex 还没登录——之后在终端执行 codex login 即可启用，无需重装"
        IMAGE_GEN_TODO="codex login"
      fi
    else
      IMAGE_GEN_TODO="npm i -g @openai/codex && codex login"
    fi
  fi
fi

# 2) 火山方舟 key：视频生成必需；没用 Codex 时也用它生图
if [[ -n "$ark_key_now" ]]; then
  info "火山方舟 key 已配置（ARK_API_KEY ••••${ark_key_now: -4}）——视频生成已开通"
elif [[ "$YES" != "true" ]]; then
  echo "  火山方舟 API key：视频生成（Seedance）必需；没有 ChatGPT 订阅时也用它生图（Seedream）"
  read -r -s -p "  填入 ARK_API_KEY（申请: https://console.volcengine.com/ark；输入不回显，回车跳过） " ark_key || ark_key=""
  echo ""
  ark_key="$(_trim "$ark_key")"
  if [[ -n "$ark_key" ]]; then
    _env_set ARK_API_KEY "$ark_key"; ark_key_now="$ark_key"
    success "ARK_API_KEY 已写入——视频生成已开通"
    echo "    （记得在方舟控制台「开通管理」开通 Doubao-Seedance（视频）和 Doubao-Seedream（生图）模型）"
  fi
fi
if [[ -z "$ark_key_now" ]]; then
  VIDEO_TODO="视频生成需要火山方舟 key：管理台「系统配置 → 默认设置 → 视频生成」填写，或在 .env 写 ARK_API_KEY"
fi

# 生图后端最终落定（上面还没定下来时）
if [[ -z "$img_provider" ]]; then
  if [[ -n "$ark_key_now" && "$codex_wanted" != "true" ]]; then
    _env_set IMAGE_GEN_PROVIDER seedream; img_provider=seedream
    success "生图走火山 Seedream"
  elif [[ -n "$ark_key_now" ]]; then
    # 想用 Codex 但暂未就绪：不锁定后端，登录后自动切回 Codex，期间用 Seedream
    success "Codex 登录前生图先走火山 Seedream，登录后自动切到 Codex"
  elif [[ -z "$IMAGE_GEN_TODO" ]]; then
    IMAGE_GEN_TODO="有 ChatGPT 订阅：npm i -g @openai/codex && codex login；否则填火山方舟 key（见下方视频待办）"
  fi
fi

# 3) TOS（可选）：用本地视频/音频当参考素材时要先传到 TOS 换公网链接
tos_ak_now="$(_env_get TOS_ACCESS_KEY)"
if [[ -n "$tos_ak_now" ]]; then
  info "TOS 已配置（桶 $(_env_get TOS_BUCKET)）——可以用本地视频/音频当参考"
elif [[ -n "$ark_key_now" && "$YES" != "true" ]]; then
  if ask_yn "要支持「参考群里发的视频 / 音频」生成视频吗？需要火山对象存储 TOS（大多数人用不到）" n; then
    echo "  建议在火山控制台新建一个子用户，只授权这个桶的上传 / 读取 / 删除，用它的 AK/SK（主账号 AK/SK 权限过大）"
    read -r -s -p "  TOS Access Key（输入不回显） " tos_ak || tos_ak=""; echo ""
    read -r -s -p "  TOS Secret Key（输入不回显） " tos_sk || tos_sk=""; echo ""
    read -r -p "  桶名 " tos_bucket || tos_bucket=""
    read -r -p "  地域（回车 = cn-beijing） " tos_region || tos_region=""
    tos_ak="$(_trim "$tos_ak")"; tos_sk="$(_trim "$tos_sk")"
    tos_bucket="$(_trim "$tos_bucket")"; tos_region="$(_trim "$tos_region")"
    tos_region="${tos_region:-cn-beijing}"
    if [[ -n "$tos_ak" && -n "$tos_sk" && -n "$tos_bucket" ]]; then
      _env_set TOS_ACCESS_KEY "$tos_ak"
      _env_set TOS_SECRET_KEY "$tos_sk"
      _env_set TOS_BUCKET "$tos_bucket"
      _env_set TOS_REGION "$tos_region"
      info "TOS 连通测试（上传一个小文件再删除）..."
      if tos_msg="$(TOS_ACCESS_KEY="$tos_ak" TOS_SECRET_KEY="$tos_sk" TOS_BUCKET="$tos_bucket" TOS_REGION="$tos_region" \
            python3 "$LUCKAGENT_HOME/src/skills/seedance-video/scripts/tos_upload.py" --probe 2>&1)"; then
        success "TOS ${tos_msg}"
      else
        warn "TOS 连通测试未通过：${tos_msg}"
        VIDEO_TODO="TOS 连通测试未通过（${tos_msg}）——在管理台「系统配置 → 默认设置 → 视频生成」改好后点「测试 TOS」"
      fi
    else
      warn "TOS 信息不全，已跳过（之后可在管理台补填）"
    fi
  fi
fi
# 个人装的同类技能会和 image-gen 抢触发（描述几乎一样，模型随机选），提醒一下，不替用户删
if [[ -d "$HOME/.claude/skills/codex-image-gen" ]]; then
  warn "检测到 ~/.claude/skills/codex-image-gen：它和内置 image-gen（已含 Codex 后端）触发词重叠，建议移走或删除"
fi

# ---- bot 工作区根目录（默认 ~/projects，可自定义）----
# 每个 bot 的工作目录建在 <根目录>/<bot名>，根目录下放一份共用规范 CLAUDE.md。
# 选择写进 .env 的 LUCKAGENT_PROJECTS_DIR；重跑时已配置则沿用，不再询问。
_expand_path() {  # ~ 展开；相对路径按 $HOME 补全；去掉末尾的 /
  local p="$1"
  case "$p" in
    "~") p="$HOME" ;;
    "~/"*) p="$HOME/${p#\~/}" ;;
    /*) ;;
    *) p="$HOME/$p" ;;
  esac
  [[ "$p" != "/" ]] && p="${p%/}"
  printf '%s' "$p"
}
projects_cfg="$(_env_get LUCKAGENT_PROJECTS_DIR)"
projects_configured=true
if [[ -z "$projects_cfg" ]]; then
  projects_configured=false
  projects_cfg="~/projects"
  if [[ "$YES" != "true" ]]; then
    echo ""
    echo -e "${BOLD}—— bot 工作区根目录 ——${NC}"
    echo "  每个机器人的工作目录会建在 <根目录>/<机器人名>，根目录下放一份所有机器人共用的规范 CLAUDE.md。"
    read -r -p "工作区根目录（回车 = ~/projects，即 $HOME/projects） " projects_in || projects_in=""
    projects_in="${projects_in#"${projects_in%%[![:space:]]*}"}"   # 去首尾空白
    projects_in="${projects_in%"${projects_in##*[![:space:]]}"}"
    [[ -n "$projects_in" ]] && projects_cfg="$projects_in"
  fi
fi
BOTS_ROOT="$(_expand_path "$projects_cfg")"
if ! mkdir -p "$BOTS_ROOT" 2>/dev/null || [[ ! -w "$BOTS_ROOT" ]]; then
  warn "无法创建或写入 ${BOTS_ROOT}，改用默认 ~/projects"
  projects_cfg="~/projects"
  BOTS_ROOT="$HOME/projects"
  projects_configured=false
  mkdir -p "$BOTS_ROOT"
fi
if [[ "$projects_configured" != "true" ]]; then
  # 默认值保留 ~ 写法（换用户名/换机器照样可用），自定义值写展开后的绝对路径
  if [[ "$projects_cfg" == "~/projects" ]]; then
    _env_set LUCKAGENT_PROJECTS_DIR "~/projects"
  else
    _env_set LUCKAGENT_PROJECTS_DIR "$BOTS_ROOT"
  fi
fi
success "bot 工作区根目录: ${BOTS_ROOT}（.env 的 LUCKAGENT_PROJECTS_DIR；只影响之后新建的机器人）"
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
echo "     （机器人工作目录建在 ${BOTS_ROOT}/<机器人名>）"
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
if [[ -n "$DEPS_TODO" ]]; then
  echo -e "  ${RED}❗ 待办${NC}: 办公与媒体工具链未装齐（bot 做 PPT/Excel/PDF/语音会缺能力），请手动执行:"
  printf '%s' "$DEPS_TODO"
  echo ""
fi
if [[ -n "$IMAGE_GEN_TODO" ]]; then
  echo -e "  ${YELLOW}生图待办${NC}: $IMAGE_GEN_TODO"
  echo ""
fi
if [[ -n "$VIDEO_TODO" ]]; then
  echo -e "  ${YELLOW}视频待办${NC}: $VIDEO_TODO"
  echo ""
fi
if [[ -n "$OPENCLI_TODO" ]]; then
  echo -e "  ${YELLOW}网站自动化待办${NC}: $OPENCLI_TODO"
  echo ""
fi
echo "  可选能力（编辑 .env 填 key 后 luckagent restart 生效）:"
echo "     语音TTS: VOLCENGINE_TTS_*（不填则用免费 Edge TTS）"
echo ""
if [[ "${PATH_JUST_ADDED:-}" == "1" ]]; then
  echo "  ⚠️  当前终端还找不到 luckagent 命令的话，先执行:  source ~/.zprofile  （或新开终端）"
fi
echo "  常用命令:  luckagent status | logs | restart | doctor --json | help"
echo "  详细文档:  INSTALL.md 与 docs/ 目录"
echo ""
