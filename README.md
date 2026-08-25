# Luckagent

把飞书群聊接到 AI 编程 agent 的机器人框架。每个飞书机器人背后是一个完整的 agent 引擎——Claude Code（通过 `@anthropic-ai/claude-agent-sdk` / Claude Code CLI）、Kimi 或 Codex——在各自独立的工作目录里拥有完整的工具权限：读写文件、跑命令、调 API、收发聊天附件。你在群里 @机器人说一句话，它就在服务器上替你干活，并把过程与产物以卡片形式实时回贴到群里。

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

## 特性

- **多 bot 单进程**：一份 `bots.json` 配任意多个飞书机器人，各自独立的应用凭证、工作目录、引擎与预算限额。
- **三引擎可选**：每个 bot 用 `engine: "claude" | "kimi" | "codex"` 选择后端；Claude 支持 API key 或复用已登录的 Claude Code CLI 订阅。
- **Web 管理台**：系统总览、机器人管理（含手把手的飞书接入向导）、定时任务、运行日志、系统配置，浏览器里完成从建应用到跑通的全流程。
- **定时任务**：一次性延迟与 cron 周期任务，CLI / 管理台 / HTTP API 三种入口，持久化、重启自动恢复。
- **生产磨出来的稳定性**（详见 [设计笔记](docs/design-notes.md)）：文件上传超时重试、快速连发消息合并、群聊引用回复精确通知、被引消息上下文注入、出站内容脱敏、发送目录「发过即删 + 漏发补扫」、超大附件分片下载、发送失败明确告知等，全部内建。
- **跨 bot 协作**：共享记忆沉淀知识、技能中心复用方法、agent 总线让 bot 之间互相委托任务，也支持跨主机 peers 联邦。
- **语音**：文本转语音（豆包 / OpenAI / ElevenLabs / Edge TTS），可配置语音回复。

## 快速开始

解开发行包，跑安装脚本，跟着交互提示走完即可：

```bash
tar -xzf luckagent-installer-v0.2.2.tar.gz && cd luckagent && bash install.sh
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

## 文档

| 文档 | 内容 |
| --- | --- |
| [飞书应用配置指南](docs/feishu-app-setup.md) | 在飞书开放平台建应用、配权限、订阅事件、发布上线的逐步引导 |
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
