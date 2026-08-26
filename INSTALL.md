# Luckagent 安装说明（全新 Mac mini 从零开始）

本文假设目标机是一台**全新 macOS**（Apple Silicon），什么都没装。照着一步一步执行即可；
每一步都写了「预期会发生什么」，卡住时看第 8 节排障。

> 已经装好 Homebrew / node 22 / pm2 的机器，直接从第 3 步开始。

---

## 0. 你需要准备的

| 东西 | 说明 |
| --- | --- |
| 网络 | 目标机需联网（取代码、下载 Homebrew/node/npm 依赖、连飞书与模型 API），无需下载任何安装包 |
| 飞书账号 | 有权限在 [飞书开放平台](https://open.feishu.cn/app) 创建企业自建应用 |
| Claude 认证 | 二选一：[Anthropic API Key](https://console.anthropic.com)，或 Claude Code 订阅账号（安装脚本可代装 CLI，登录需自己跑一次 `claude`） |
| 生图 key（可选） | 二选一：[OpenAI](https://platform.openai.com) 的 key，或 [火山方舟](https://console.volcengine.com/ark) 的 ARK key（需在控制台开通 Doubao-Seedream 模型） |
| DeepSeek 引擎（可选） | **无需装任何东西，只要一个 [API key](https://platform.deepseek.com)**。详见 [docs/engines.md](docs/engines.md) |
| 时间 | 全程约 20–40 分钟（首次装 Xcode 命令行工具占大头） |

---

## 1. 一行命令安装（推荐）

打开「终端」（聚焦搜索 Terminal），执行：

```bash
curl -fsSL https://raw.githubusercontent.com/haoyan-yam/luckagent/main/scripts/get.sh | bash
```

零前置依赖（只用 macOS 自带的 curl/tar/bash），全新机器直接跑。脚本把代码取到
`~/luckagent` 后自动进入第 2 节的交互式安装流程——**用这条命令的话第 2 节的
命令不用再手动执行**，直接看第 2 节的「阶段表」了解安装过程中需要你配合什么。

---

## 2. 运行安装脚本

> 用了第 1 节的一行命令则跳过本节的命令（get.sh 已代跑）。想手动控制的话：

```bash
git clone https://github.com/haoyan-yam/luckagent.git ~/luckagent
cd ~/luckagent
bash install.sh
```

（已有 Node 的机器也可用 `npx luckagent init`，效果与一行命令相同。）

安装脚本会依次做这些事，**其中四处需要你配合**：

| 阶段 | 会发生什么 | 需要你做什么 |
| --- | --- | --- |
| Homebrew | 全新机器会先装 Homebrew，并自动带出 **Xcode 命令行工具**下载 | 弹窗点「安装」、终端里**输入开机密码**；CLT 下载约 5–15 分钟，耐心等 |
| node@22 / git / pm2 | 自动安装 | 无 |
| 选择默认引擎 | 询问用 Claude Code 还是 DeepSeek | 回车 = Claude；输 2 = DeepSeek（之后每个 bot 仍可单独选） |
| Claude Code CLI | 仅选 Claude 且未装 CLI 时询问是否代装 | 回答 y/n（订阅登录路线就装；纯 API key 路线可跳过） |
| npm install + 构建 | 下载依赖并本地编译原生模块，几分钟 | 无 |
| 生成 `.env` | 自动生成随机 `API_SECRET`（管理台登录密钥） | 按所选引擎询问认证——Claude：`ANTHROPIC_API_KEY` 或订阅登录提示；DeepSeek：`DEEPSEEK_API_KEY` 并自动设为默认引擎——随后询问生图 key（OpenAI `sk-` 或火山 `ark-` 前缀自动识别），均可回车跳过、之后编辑 `.env` 补填 |
| 生成 `bots.json` | 空列表——机器人稍后用管理台向导创建 | 无 |
| 技能同步 | 内置技能装进全局目录；并从 GitHub 拉取 frontend-slides（HTML 演示文稿生成，第三方 MIT） | 无；拉取失败仅警告不影响安装 |
| lark-cli（必装） | 自动安装飞书官方 CLI + 19 个 AI 技能（文档/表格/日历操作、群日报拉消息都依赖它） | 无；万一安装失败，结尾会打印待办命令 |
| PM2 启动 | 启动 `luckagent-bridge` + `luckagent-core` 两个常驻进程 | 无 |

结尾会打印：**管理台地址、API_SECRET、下一步指引**。把 API_SECRET 复制下来。

> 脚本可重复执行（幂等）：中途失败修复后，重新 `bash install.sh` 即可，已完成的步骤会自动跳过。

---

## 3. Claude 引擎认证（二选一）

**方式 A：API Key（最简单）**

```bash
cd ~/luckagent
nano .env        # 找到 ANTHROPIC_API_KEY，填入 sk-ant-... 后保存（Ctrl+O 回车，Ctrl+X）
luckagent restart
```

需要走中转网关的话同时填 `ANTHROPIC_BASE_URL`。

**方式 B：Claude Code 订阅登录**

```bash
curl -fsSL https://claude.ai/install.sh | bash   # 安装 Claude Code CLI
claude                                            # 首次运行按提示登录订阅账号
```

登录成功后在 `.env` 里填：

```
CLAUDE_EXECUTABLE_PATH=~/.local/bin/claude
```

然后 `luckagent restart`。

---

## 4. 打开管理台，创建第一个机器人

浏览器访问：**http://localhost:9100/admin**

1. 用安装结尾打印的 **API_SECRET** 登录（忘了就 `grep API_SECRET ~/luckagent/.env`）
2. 进「机器人管理」→ 点 **「飞书接入向导」**，向导会带你走完全部七步：
   - 在飞书开放平台创建企业自建应用
   - 复制 App ID / App Secret 回填，点 **「测试连接」** 验证凭证
   - 开启「机器人」能力
   - 开通权限：`im:message`、`im:message:readonly`、`im:resource`、`im:chat:readonly`
   - 事件订阅选 **「长连接」**，添加事件 `im.message.receive_v1`
   - 创建版本并发布
   - 填机器人名称和工作目录（如 `/Users/你/projects/my-bot`），保存
3. 点顶栏 **「重启桥接」**——约 5–10 秒后机器人上线
4. 回到飞书：把机器人加进一个群（或直接私聊），**@它说句话**，收到回复即接入成功 🎉

> 长连接事件订阅保存时要求「至少一个客户端在线」——如果保存报错，先完成向导并重启桥接，再回开放平台保存那一步。

---

## 5. 开机自启（推荐）

让两个进程在重启电脑后自动拉起：

```bash
pm2 startup
```

它会打印一条 `sudo env PATH=... pm2 startup launchd ...` 命令——**复制并执行它**（要输密码），然后：

```bash
pm2 save
```

> **无头 Mac mini 注意**：pm2 的 launchd 方案是**登录级**的——用户登录后才拉起。
> 不接显示器远程使用的机器，请在「系统设置 → 用户与群组」为该账户开启**自动登录**，
> 否则重启后进程不会自动启动。

验证：重启 Mac mini，等 1 分钟后跑 `luckagent status`，两个进程应为 `online`。

---

## 6. 验证清单

```bash
luckagent status          # luckagent-bridge / luckagent-core 均 online
luckagent health          # {"status":"ok",...}
luckagent doctor --json   # 本机体检（runtime/PM2/core/bots/voice 等检查项）
```

- 管理台「系统总览」：桥接与 core 均绿色，机器人显示「运行中」
- 飞书群里 @机器人 说话有回应
- （可选）`luckagent memory create "测试" "hello"` 然后 `luckagent memory search 测试` —— 验证 core 链路

---

## 7. 安装完成后，机器上有什么

| 位置 | 内容 |
| --- | --- |
| `~/luckagent/` | 程序本体（代码、`.env`、`bots.json`、`logs/`） |
| `~/projects/` | 各机器人的工作目录（`<bot>/inputs\|outputs\|work` + 共用规范 `CLAUDE.md`） |
| `~/.luckagent/` | 运行状态（定时任务、会话、活动记录数据库） |
| `~/.luckagent-core/` | core 数据（`token`、`data/central.db` 共享记忆库） |
| `~/.claude/skills/` | 随装技能（luckagent / voice / lark-* / frontend-slides 等） |
| `~/.local/bin/luckagent` | CLI 命令 |

详细说明见 [docs/directory-layout.md](docs/directory-layout.md)。

> **可选增强**：安装 opencli（网站自动化工具）等第三方二进制后，重跑一次 `bash install.sh`
>（幂等，几十秒），对应技能会自动启用；添加自定义技能见 [docs/claude-code-skills.md](docs/claude-code-skills.md)。
>
> **升级 Luckagent**：git 安装（含一行命令在有 git 机器上的安装）执行 `luckagent update`；
> 无 `.git` 的安装（一行命令在裸机上的 tarball 下载模式）执行：
>
> ```bash
> curl -fsSL https://codeload.github.com/haoyan-yam/luckagent/tar.gz/refs/heads/main | tar -xz --strip-components=1 -C ~/luckagent
> cd ~/luckagent && bash install.sh
> ```

---

## 8. 常见问题（更多见 docs/troubleshooting.md）

**装 Homebrew 卡在 Xcode 命令行工具**
下载慢是常态（Apple 服务器）；也可先手动 `xcode-select --install` 装完再重跑 `install.sh`。

**`luckagent: command not found`**
`~/.local/bin` 不在 PATH。执行：

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

**管理台打不开 / 登录一直失败**
- `luckagent status` 确认 bridge 在跑；`luckagent logs` 看报错
- 密钥以 `.env` 里的 `API_SECRET` 为准
- 连续输错会触发限流（HTTP 429），等 5 分钟再试

**机器人显示「未运行/启动失败」**
- 管理台里对该机器人点「测试连接」——凭证错误会直接给出飞书错误码
- 常见原因：应用没发布版本、「机器人」能力没开、长连接事件没配
- `luckagent doctor --json` 里 `bots_config` 一项有逐 bot 诊断

**终端里手工调飞书接口失败 / 循环重定向**
本机 shell 若设了 `HTTPS_PROXY`，代理可能劫持飞书域名。手工执行时用：

```bash
env -u HTTPS_PROXY -u HTTP_PROXY <你的命令>
```

或把 `open.feishu.cn` 加进 `NO_PROXY`。

**`npm install` 报 EACCES / EEXIST（缓存权限）**
通常是历史上用 `sudo npm` 污染了缓存。修复：

```bash
sudo chown -R "$(whoami)" ~/.npm
```

**端口 9100 / 9200 被占**
`lsof -nP -iTCP:9100 -sTCP:LISTEN` 看占用者；或改 `.env` 的 `API_PORT` 后 `luckagent restart`。
