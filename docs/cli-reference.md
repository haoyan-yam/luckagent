# CLI 参考

`luckagent` 是唯一的命令行入口（bash 脚本，装在 `~/.local/bin/luckagent`），三类命令：

1. **进程管理** —— 操作 PM2 里的两个进程；
2. **桥接 API** —— curl 本机桥接 `localhost:9100`（鉴权自动取 `.env` 的 `API_SECRET`）；
3. **中央服务委托** —— 其余子命令转发给 luckagent-core 功能 CLI（`localhost:9200`，token 取 `LUCKAGENT_CORE_TOKEN` 或 `~/.luckagent-core/token`）。

不带参数（或 `help` / `--help` / `-h`）打印总帮助。

---

## 一、进程管理

### `luckagent start`

用 PM2 启动 `ecosystem.config.cjs` 里的两个应用（luckagent-bridge + luckagent-core），并 `pm2 save` 固化进程列表。

### `luckagent stop [--core|--all]`

| 形式 | 效果 |
| --- | --- |
| `luckagent stop` | 只停 bridge |
| `luckagent stop --core` | 只停 core |
| `luckagent stop --all` | 两个都停 |

### `luckagent restart [--core|--all]`（别名 `rs`）

参数语义同 `stop`，默认只重启 bridge。重启前会写入「重启面包屑」（`~/.luckagent/last-restart.json`），让重启后的 agent 会话知道「刚刚已经重启过了」，避免从历史消息里再触发一次重启形成循环。

```bash
luckagent restart          # 改了 bots.json / .env 后生效配置
luckagent restart --all    # bridge + core 一起
```

### `luckagent logs [--core] [pm2参数…]`（别名 `log`）

看实时日志，默认 bridge，`--core` 看 core。多余参数原样传给 `pm2 logs`：

```bash
luckagent logs                 # bridge 实时日志
luckagent logs --core          # core 实时日志
luckagent logs -n 200          # 先回放最近 200 行
```

### `luckagent status`（别名 `st`）

`pm2 ls` 的 luckagent 相关行：进程在不在、重启次数、内存。

### `luckagent update`（别名 `up`）

一条命令完成升级，依次执行：

1. `git pull --ff-only`（要求安装目录是 git 检出；CLI 自身被更新时会自动用新版重跑）；
2. `npm install` + `npm run build`；
3. 复制 CLI 到 `~/.local/bin`；
4. 同步技能（详见[技能体系](claude-code-skills.md#luckagent-update-的技能同步)）；
5. `pm2 restart` 两个进程 + `pm2 save`。

### `luckagent doctor [--json]`

本机运行时诊断，逐项检查并给出修复建议；`--json` 输出结构化报告（schemaVersion 1），适合让 agent 自己读：

| 检查项 | 内容 |
| --- | --- |
| `luckagent_home` | 安装目录解析是否正确、.env / bots.json 是否存在 |
| `pm2_runtime` | bridge 是否 online、是否从正确目录启动 |
| `bridge_health` | `/api/health` 是否可达（用 .env 的端口与密钥） |
| `luckagent_core` | core `/health` 是否可达、token 是否就位 |
| `bots_config` | bots.json 可解析、各 bot 工作目录是否存在 |
| `voice_defaults` | TTS 凭证是否配置 |

```bash
luckagent doctor           # 人类可读
luckagent doctor --json    # agent 可读
```

---

## 二、桥接 API（localhost:9100）

这一类命令 curl 本机桥接。地址与鉴权的解析顺序：环境变量 `LUCKAGENT_URL` / `API_SECRET` → 安装目录 `.env` 里的 `LUCKAGENT_URL` / `API_PORT` / `API_SECRET` → 默认 `http://localhost:9100`。

### `luckagent bots`（别名 `b`）/ `luckagent bot <name>`

```bash
luckagent bots         # 列出所有 bot（本机 + 已联邦 peers 上的）
luckagent bot mybot    # 单个 bot 详情（密钥字段掩码显示）
```

### `luckagent talk [peer/]<bot> <chatId> <提示词>`（别名 `t`）

把一段任务投给某个 bot 的某个会话（`POST /api/talk`，带卡片输出）。bot 名可带 peer 前缀跨实例投递：

```bash
luckagent talk mybot oc_xxx '把昨天的错误日志归因一下'
luckagent talk alice/backend-bot oc_xxx '部署到 staging'
```

### `luckagent schedule …`（别名 `sched`、`sc`）

定时任务管理，详见[定时任务](scheduling.md)：

```bash
luckagent schedule list                                       # 全部任务（别名 ls）
luckagent schedule add  <bot> <chatId> <延迟秒> <提示词>        # 一次性（别名 a）
luckagent schedule cron <bot> <chatId> '<cron>' <提示词>       # 周期（别名 c）
luckagent schedule pause <id>     # 暂停周期任务（别名 p）
luckagent schedule resume <id>    # 恢复（别名 r）
luckagent schedule cancel <id>    # 取消（别名 rm）
```

### `luckagent teams …`（别名 `team`）

本机 Agent Teams 编排（`/api/agent-teams/*`）：一个「lead」把任务拆给常驻的 teammate agent，带任务板与站内消息。

```bash
# 团队生命周期
luckagent teams list
luckagent teams create <team> [--description 文本]
luckagent teams delete <team>
luckagent teams status <team> [--summary|--plain]
luckagent teams start|stop <team>
luckagent teams bind <team> <chatId> [--display]     # 绑定飞书群展示
luckagent teams watch <team> [--interval 秒] [--count n]

# 成员
luckagent teams agents list <team>
luckagent teams agents spawn <team> <name> [--role r] [--engine claude|deepseek] [--prompt p]
luckagent teams agents stop|delete <team> <name>

# 任务与消息
luckagent teams dispatch <team> <agent> <标题> [--description 文本] [--message 文本]  # 建任务+指派+发唤醒消息，一步到位
luckagent teams tasks list|create|get|update|claim|done|block|reopen <team> …
luckagent teams send <team> <to> <消息> [--from name] [--summary 摘要]
luckagent teams inbox <team> <name> [--unread] [--read]
luckagent teams next <team> <agent> [--read]          # teammate 取「我的未读+我的任务」

# 运行记录
luckagent teams runs list|create|update|output|stop <team> …
```

`--summary` / `--plain` 让 `status`、`next`、`inbox`、`tasks list`、`runs list`、`dispatch`、`watch` 输出简洁文本；不加输出 JSON 便于脚本处理。

### `luckagent peers …`（别名 `p`）

跨实例联邦：把另一台机器的 Luckagent 加为 peer 后，`luckagent bots` / `talk` 可以直接看见并使用对方的 bot。

```bash
luckagent peers                            # 列出 peers 与在线状态（别名 list/ls）
luckagent peers add <name> <url> [secret]  # 运行时添加，无需重启
luckagent peers remove <name>              # 移除（别名 rm/del）
```

### `luckagent stats` / `luckagent metrics`（别名 `m`）

```bash
luckagent stats     # 费用与用量统计（JSON）
luckagent metrics   # Prometheus 文本格式，可直接被抓取
```

### `luckagent voice tts`（别名 `v`）

语音只有 `tts` 一个子命令（`POST /api/tts`）：

```bash
luckagent voice tts "今晚八点发布" --play                 # 生成并播放
luckagent voice tts "hello" -o /tmp/hello.mp3            # 指定输出文件（默认 /tmp/luckagent-voice-<时间戳>.mp3）
luckagent voice tts "你好" --provider doubao --voice zh_male_rap_mars_bigtts
echo '从管道读文本' | luckagent voice tts
```

| 参数 | 说明 |
| --- | --- |
| `--provider` / `-p` | `doubao` \| `openai` \| `elevenlabs`（不传按服务端默认，未配付费 key 时用免费 Edge TTS） |
| `--voice` | 音色名 |
| `-o` / `--output` | 输出 MP3 路径；命令固定把最终路径打印到 stdout |
| `--play` | 生成后本机播放（依次尝试 afplay / mpv / ffplay / play） |

### `luckagent health`（别名 `h`）

`GET /api/health`，返回状态与 uptime。

---

## 三、中央服务委托（localhost:9200）

以上未列出的子命令全部转发给 luckagent-core 功能 CLI（随仓库在 `packages/cli/`，可用 `LUCKAGENT_CORE_CLI` 显式指定路径）。鉴权自动解析：环境变量 `LUCKAGENT_CORE_URL` / `LUCKAGENT_CORE_TOKEN` → 安装目录 `.env` → token 文件 `~/.luckagent-core/token`。

### `luckagent memory` — 共享记忆

```bash
luckagent memory list [folder_id]              # 浏览目录树
luckagent memory search "<关键词>"              # 全文搜索
luckagent memory get <id|路径>                  # 读一篇（元数据+内容）
luckagent memory create "<标题>" "<内容>" [--share|--no-share] [--html] [--tags a,b] [--path /users/<bot>/x | --folder <id>]
luckagent memory mkdir "<名称>" [--path …]
luckagent memory update <id> [内容] [--title …] [--tags …] [--share|--no-share]
luckagent memory share <id> [on|off]           # 单篇的跨 bot 可见性
luckagent memory visibility [public|private]   # 本 bot 新文档的默认可见性
luckagent memory health
```

不带 `--path`/`--folder` 时写入自己的命名空间 `/users/<botName>/…`；文档的跨 bot 可读性由 `shared` 标志（`--share`）决定，与路径无关。

### `luckagent skills` — 技能中心

```bash
luckagent skills list
luckagent skills get <name>
luckagent skills publish <name> --from <目录>       # 读 <目录>/SKILL.md
luckagent skills install <name> [--to <目录>]       # ⚠️ 默认装到 ./.claude/skills/<name>（当前目录）；全局装传 --to ~/.claude/skills/<name>
luckagent skills remove <name>
luckagent skills health
```

### `luckagent agents` — Agent 总线（peer bot 地址簿）

```bash
luckagent agents list [--include-hidden]        # 可见注册表（--include-hidden 需 admin token）
luckagent agents whoami                         # 当前 token 的身份
luckagent agents register --url <url> [--bot-name <name>] [--hidden]
luckagent agents heartbeat [--bot-name <name>]
luckagent agents visible <botName> | hide <botName>   # 可见性即权限
luckagent agents talk <peer>[/<bot>] [<chatId>] "<消息>"   # 经注册表解析地址后点对点投递
```

`agents talk` 不传 chatId 时按当前目录派生 `proj:<目录名>:<hash>` 作为会话 id（stderr 会回显）。注意与第二类的 `luckagent talk` 不同：`talk` 走本机桥接的 `/api/talk`（本机 + 配置的 peers），`agents talk` 走中央注册表解析后直连对方。

### `luckagent inbox` — CLI agent 收件箱

给没有常驻桥接的纯 CLI agent（如 Claude Code 终端会话）收消息用：注册成 `url: inbox:` 的收件箱型 agent，消息在 core 里排队，自己拉取。

```bash
luckagent inbox register [--bot-name <name>]   # 默认名 cli:<owner>@<hostname>
luckagent inbox project-id                     # 打印当前目录派生的 chatId
luckagent inbox peek  [--chat <id>] [--all-chats] [--limit 20]
luckagent inbox poll  [--chat <id>] [--wait 30] [--once|--loop]   # --loop 常驻拉取，一行一条 JSON
luckagent inbox clear [--chat <id>] [--all-chats]
```

---

## 环境变量速查

| 变量 | 作用 |
| --- | --- |
| `LUCKAGENT_HOME` | 安装目录（默认按脚本位置推断，再退回 `~/luckagent`） |
| `LUCKAGENT_URL` / `API_PORT` / `API_SECRET` | 第二类命令的桥接地址与密钥（默认读安装目录 `.env`） |
| `LUCKAGENT_CORE_URL` / `LUCKAGENT_CORE_TOKEN` | 第三类命令的 core 地址与 token（token 也可放 `~/.luckagent-core/token`） |
| `LUCKAGENT_CORE_CLI` | 显式指定 core 功能 CLI 路径 |
| `LUCKAGENT_ROLLOVER_IDLE_MS` / `LUCKAGENT_ROLLOVER_DISABLED` | 桥接的空闲会话自动换新（design-note T）：空闲阈值毫秒（默认 3 小时）/ 设 `1` 关闭 |

## 相关文档

- [定时任务](scheduling.md)｜[技能体系](claude-code-skills.md)｜[管理台使用手册](admin-console.md)｜[常见问题排查](troubleshooting.md)
