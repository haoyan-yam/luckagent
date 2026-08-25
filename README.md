# Luckagent

把飞书群聊接到 AI agent 引擎的自托管机器人平台。每个飞书机器人背后是一个完整的 agent 引擎——Claude Code（`@anthropic-ai/claude-agent-sdk` / Claude Code CLI）、Codex、Kimi 或 DeepSeek——在各自独立的工作目录里拥有完整的工具权限：读写文件、跑命令、调 API、收发聊天附件。你在群里 @机器人说一句话，它就在你自己的 Mac 上替你干活，并把过程与产物以卡片形式实时回贴到群里。

## 项目目标

- **把 agent 从终端搬进团队日常沟通的地方。** Claude Code 这类 agent 很强，但入口是本机终端、一人一会话。Luckagent 让它以飞书机器人的身份 7×24 常驻：团队任何人在群里 @它 就能派活，产物（文档、图片、表格、代码）直接回到群里。
- **完全自托管、数据不出自己机器。** 跑在你的 Mac mini / MacBook 上：飞书凭证、聊天记录、工作文件、API key 都留在本机；对外只有到飞书开放平台的 websocket 长连接和你选择的模型 API。两个服务端口默认只绑 `127.0.0.1`。
- **多 bot、多引擎、一份配置。** 一台机器跑任意多个机器人，每个 bot 独立的飞书应用、工作目录、引擎（Claude / Codex / Kimi / DeepSeek）与预算限额，适合「一个项目一个 bot 同事」的用法。
- **生产可靠优先。** 本项目源自一套在真实团队里连续运行数月的飞书 bot 集群，消息合并、附件收发、发送目录清理、引用上下文注入等 15 项行为增强都是实际踩坑后的沉淀（见[设计笔记](docs/design-notes.md)），并配有 750+ 自动化测试。

## 架构

两个常驻进程，由 PM2 管理：

```
                       ┌──────────────────────────────────────────────┐
  飞书开放平台          │  luckagent-bridge          (127.0.0.1:9100)  │
  ┌──────────┐  长连接  │  ┌────────────┐   ┌───────────────────────┐  │
  │ 飞书应用 A │◄───────►│  │ Bot A 桥接  │──►│ 引擎: Claude Code     │  │
  │ 飞书应用 B │◄───────►│  │ Bot B 桥接  │──►│       / Kimi / Codex  │  │
  │   ...    │ websocket│  │   ...      │   │ (每 bot 独立工作目录)   │  │
  └──────────┘          │  └────────────┘   └───────────────────────┘  │
                        │  HTTP API (Bearer)  +  Web 管理台 /admin      │
                        └──────────────┬───────────────────────────────┘
                                       │
        luckagent CLI ─────────────────┤ :9100  (bots/talk/schedule/…)
        (~/.local/bin)                 │
                                       ▼
                        ┌──────────────────────────────────────────────┐
                        │  luckagent-core            (127.0.0.1:9200)  │
                        │  共享记忆 / 技能中心 / Agent 总线 / 收件箱     │
                        │  SQLite: ~/.luckagent-core/data/central.db   │
                        └──────────────────────────────────────────────┘
```

- **luckagent-bridge**：通过 websocket 长连接接入每个配置的飞书应用，驱动 agent 引擎跑任务，同时暴露 HTTP API（`API_SECRET` Bearer 鉴权）并托管 Web 管理台 `http://localhost:9100/admin`。
- **luckagent-core**：中央存储服务——跨 bot 共享记忆、技能注册中心、agent 地址簿与 CLI 收件箱，token 由 `central-admin` 签发。
- **luckagent CLI**：单一命令行入口，覆盖进程管理、bridge API 与 core 功能三类命令。

两个端口默认都只绑 `127.0.0.1`，不额外配置不会暴露到网络。

### 一条消息的生命周期

1. **接收**：飞书事件经 websocket 长连接推到 bridge（无需公网回调地址）；快速连发的多条消息会自动合并成一轮。
2. **会话**：每个聊天（群/私聊）对应一个持续的 agent 会话——Claude/DeepSeek 默认走**持久执行器池**（长驻进程，支持 Agent Teams、`/goal` 多轮自动推进、后台任务），其余引擎逐回合拉起。
3. **执行**：引擎在该 bot 的独立工作目录里全工具运行；聊天里发的文件自动下载到 `inputs/` 供 agent 直接使用。
4. **回贴**：过程流式更新到飞书卡片；agent 放进发送暂存目录的产物**发过即删**，回合结束再补扫一次防漏发（归档另存 `outputs/`）。
5. **管控**：预算限额、并发上限、群聊白名单、`/model` 会话内切引擎等都按 bot 配置；全程记账可在管理台与 `luckagent stats` 查看。

## 特性

- **多 bot 单进程**：一份 `bots.json` 配任意多个飞书机器人，各自独立的应用凭证、工作目录、引擎与预算限额。
- **四引擎可选**：每个 bot 用 `engine: "claude" | "kimi" | "codex" | "deepseek"` 选择后端；Claude 支持 API key 或订阅登录，DeepSeek 走官方 Anthropic 兼容端点、只要 key 零安装（含视觉模型）。
- **Web 管理台**：系统总览、机器人管理（含手把手的飞书接入向导）、定时任务、运行日志、系统配置，浏览器里完成从建应用到跑通的全流程。
- **定时任务**：一次性延迟与 cron 周期任务，CLI / 管理台 / HTTP API 三种入口，持久化、重启自动恢复。
- **生产磨出来的稳定性**（详见 [设计笔记](docs/design-notes.md)）：文件上传超时重试、快速连发消息合并、群聊引用回复精确通知、被引消息上下文注入、出站内容脱敏、发送目录「发过即删 + 漏发补扫」、超大附件分片下载、发送失败明确告知等，全部内建。
- **跨 bot 协作**：共享记忆沉淀知识、技能中心复用方法、agent 总线让 bot 之间互相委托任务，也支持跨主机 peers 联邦。
- **语音**：文本转语音（豆包 / OpenAI / ElevenLabs / Edge TTS），可配置语音回复。

## 系统要求

- **macOS**（目标机型 Mac mini / MacBook，Apple Silicon）；安装脚本会自动补齐 Homebrew、node 22、PM2、lark-cli 等依赖
- 一个**飞书企业自建应用**（安装后管理台的「接入向导」会手把手带你创建，或先看[配置指南](docs/feishu-app-setup.md)）
- 至少一种**引擎认证**：Claude 订阅登录或 `ANTHROPIC_API_KEY`；或 DeepSeek 的 `DEEPSEEK_API_KEY`（零 CLI 安装）；Codex / Kimi 见[多引擎配置](docs/engines.md)

## 安装

三选一，装完效果相同（推荐方式 A）：

**方式 A · npm（推荐）**

```bash
npx luckagent init
```

（或 `npm install -g luckagent && luckagent init`。）引导器会把仓库取到 `~/luckagent` 并运行交互式安装脚本；装好后 `luckagent` 命令自动变成完整 CLI。

**方式 B · git clone**

```bash
git clone https://github.com/haoyan-yam/luckagent.git ~/luckagent
cd ~/luckagent && bash install.sh
```

git 检出天然支持 `luckagent update` 一键升级。

**方式 C · 发行包（离线机器）**

从 [Releases](https://github.com/haoyan-yam/luckagent/releases) 下载 `luckagent-installer-v*.tar.gz`：

```bash
tar -xzf luckagent-installer-v*.tar.gz
mv luckagent ~/luckagent && cd ~/luckagent
bash install.sh
```

安装完成后：

1. 打开管理台 `http://localhost:9100/admin`（登录密钥是 `.env` 里的 `API_SECRET`）；
2. 在「机器人管理 → 接入向导」里创建飞书应用并保存第一个机器人（也可以先看[飞书应用配置指南](docs/feishu-app-setup.md)）；
3. 重启桥接进程使配置生效：`luckagent restart`；
4. 在飞书里搜到机器人，发一句话测试。

安装细节（依赖、目录选择、PM2 自启等）见 [INSTALL.md](INSTALL.md)。

## 命令速查

```bash
# 进程管理
luckagent start                 # 用 PM2 启动 bridge + core
luckagent restart [--core|--all]# 重启（默认只重启 bridge）
luckagent stop [--core|--all]   # 停止
luckagent logs [--core]         # 看实时日志
luckagent status                # PM2 进程状态
luckagent update                # git pull + 重装依赖 + 构建 + 同步技能 + 重启
luckagent doctor [--json]       # 本机运行时诊断

# 桥接 API（localhost:9100）
luckagent bots                  # 列出所有 bot（本机 + peers）
luckagent talk <bot> <chatId> "<任务>"          # 让某个 bot 干活
luckagent schedule cron <bot> <chatId> '0 9 * * 1-5' "<提示词>"  # 定时任务
luckagent stats                 # 费用与用量统计
luckagent voice tts "你好" --play  # 文本转语音
luckagent health                # 健康检查

# 中央服务（localhost:9200）
luckagent memory search "<关键词>"   # 搜共享记忆
luckagent memory create "<标题>" "<内容>"
luckagent skills list | install <name>
luckagent agents list           # peer bot 地址簿
luckagent inbox poll            # CLI agent 收件箱
```

完整命令与参数见 [CLI 参考](docs/cli-reference.md)。

## 升级

| 安装方式 | 升级命令 |
| --- | --- |
| npm / git clone | `luckagent update`（git pull + 重装依赖 + 构建 + 同步技能 + 重启） |
| 发行包 | 下载新版包解开覆盖到 `~/luckagent/`，重跑 `bash install.sh`（幂等） |

## 文档

| 文档 | 内容 |
| --- | --- |
| [飞书应用配置指南](docs/feishu-app-setup.md) | 在飞书开放平台建应用、配权限、订阅事件、发布上线的逐步引导 |
| [多引擎配置](docs/engines.md) | Codex / Kimi / DeepSeek 引擎的接入要求，指令文件在各引擎下的生效机制 |
| [目录结构](docs/directory-layout.md) | 安装目录、每 bot 工作目录约定、⚠️ 归档目录与发送暂存目录的关键区别、状态目录与日志位置 |
| [定时任务](docs/scheduling.md) | CLI / 管理台 / HTTP API 三种入口，cron 与时区，暂停恢复 |
| [技能体系](docs/claude-code-skills.md) | 随装与可选技能、`.claude`/`.codex` 双目录发现、工作区两级指令模板 |
| [CLI 参考](docs/cli-reference.md) | `luckagent` 全命令的用途与示例 |
| [管理台使用手册](docs/admin-console.md) | 六个页面、机器人增删改流程、重启语义、安全说明 |
| [设计笔记](docs/design-notes.md) | 15 项内建行为增强（代号 A–R）的行为说明与设计取舍 |
| [常见问题排查](docs/troubleshooting.md) | 端口占用、代理变量坑、启动失败、管理台打不开等 |

## 安全提示

- bridge 与 core 默认只监听 `127.0.0.1`；把 `LUCKAGENT_API_HOST` 设为 `0.0.0.0` 之前请务必读[管理台使用手册的安全一节](docs/admin-console.md#安全说明)。
- `.env` 与 `bots.json` 含密钥，安装脚本会将其权限设为 600，请勿提交进版本库。

## License

MIT，见 [LICENSE](LICENSE)。
