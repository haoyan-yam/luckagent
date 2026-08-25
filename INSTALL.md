# Luckagent 安装说明（全新 Mac mini 从零开始）

本文假设目标机是一台**全新 macOS**（Apple Silicon），什么都没装。照着一步一步执行即可；
每一步都写了「预期会发生什么」，卡住时看第 8 节排障。

> 已经装好 Homebrew / node 22 / pm2 的机器，直接从第 3 步开始。

---

## 0. 你需要准备的

| 东西 | 说明 |
| --- | --- |
| 安装包 | `luckagent-installer-v0.3.1.tar.gz`（+ 同名 `.sha256` 校验文件） |
| 网络 | 目标机需联网（下载 Homebrew/node/npm 依赖、连飞书与模型 API） |
| 飞书账号 | 有权限在 [飞书开放平台](https://open.feishu.cn/app) 创建企业自建应用 |
| Claude 认证 | 二选一：[Anthropic API Key](https://console.anthropic.com)，或 Claude Code 订阅账号（安装脚本可代装 CLI，登录需自己跑一次 `claude`） |
| 生图 key（可选） | 二选一：[OpenAI](https://platform.openai.com) 的 key，或 [火山方舟](https://console.volcengine.com/ark) 的 ARK key（需在控制台开通 Doubao-Seedream 模型） |
| 其他引擎（可选） | 要用 Codex / Kimi 引擎的话各需装其 CLI 并登录，见 [docs/engines.md](docs/engines.md) |
| 时间 | 全程约 20–40 分钟（首次装 Xcode 命令行工具占大头） |

---

## 1. 把安装包传到 Mac mini

任选其一：

- **隔空投送（AirDrop）**：从另一台电脑把 `luckagent-installer-v0.3.1.tar.gz` 投过去（默认落在 `~/Downloads`）
- **U 盘**：拷贝到 U 盘再拷进 `~/Downloads`
- **scp**（两台机器同一局域网时）：

```bash
scp luckagent-installer-v0.3.1.tar.gz 用户名@mac-mini.local:~/Downloads/
```

（可选）校验包完整性：

```bash
cd ~/Downloads
shasum -a 256 -c luckagent-installer-v0.3.1.tar.gz.sha256
```

看到 `OK` 即通过。

---

## 2. 解压并运行安装脚本

打开「终端」（聚焦搜索 Terminal），执行：

```bash
cd ~/Downloads
tar -xzf luckagent-installer-v0.3.1.tar.gz
mv luckagent ~/luckagent
cd ~/luckagent
bash install.sh
```

安装脚本会依次做这些事，**其中三处需要你配合**：

| 阶段 | 会发生什么 | 需要你做什么 |
| --- | --- | --- |
| Homebrew | 全新机器会先装 Homebrew，并自动带出 **Xcode 命令行工具**下载 | 弹窗点「安装」、终端里**输入开机密码**；CLT 下载约 5–15 分钟，耐心等 |
| node@22 / git / pm2 | 自动安装 | 无 |
| npm install + 构建 | 下载依赖并本地编译原生模块，几分钟 | 无 |
| 生成 `.env` | 自动生成随机 `API_SECRET`（管理台登录密钥） | 会依次询问 `ANTHROPIC_API_KEY`（Claude 认证）和 OpenAI key（生图技能），都可回车跳过、之后编辑 `.env` 补填 |
| 生成 `bots.json` | 空列表——机器人稍后用管理台向导创建 | 无 |
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

> 想用 **Codex 或 Kimi** 引擎的 bot？各需在终端多做两步（装对应 CLI + 登录），见 [docs/engines.md](docs/engines.md)。

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

验证：重启 Mac mini，等 1 分钟后跑 `luckagent status`，两个进程应为 `online`。

---

## 6. 验证清单

```bash
luckagent status          # luckagent-bridge / luckagent-core 均 online
luckagent health          # {"status":"ok",...}
luckagent doctor --json   # 全面体检（bridge/core/bots/引擎逐项检查）
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
| `~/.claude/skills/`、`~/.codex/skills/` | 随装技能（luckagent / voice / lark-* 等） |
| `~/.local/bin/luckagent` | CLI 命令 |

详细说明见 [docs/directory-layout.md](docs/directory-layout.md)。

> **可选增强**：安装 opencli（网站自动化工具）等第三方二进制后跑一次 `luckagent update`，
> 对应技能会自动启用；添加自定义技能见 [docs/claude-code-skills.md](docs/claude-code-skills.md)。

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
- `luckagent doctor --json` 里 `bots` 一项有逐 bot 诊断

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
