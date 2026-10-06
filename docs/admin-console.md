# 管理台使用手册

桥接进程自带 Web 管理台：`http://localhost:9100/admin`（访问根路径 `/` 也会进来）。日常运维——看状态、加机器人、配定时任务、翻日志——都可以在浏览器里完成，不用 ssh。

## 登录

登录口令就是 `.env` 里的 **`API_SECRET`**。输入后保存在浏览器 localStorage，之后每个数据请求都以 `Authorization: Bearer <API_SECRET>` 发出。登出即清除本地保存的口令。

> 管理台没有独立账号体系：拿到 `API_SECRET` 等于拿到全部管理能力，请像对待密码一样对待它。

## 页面一览

### 系统总览

每天打开先看这一页：系统是否正常、钱花在哪、哪里需要处理。

- **系统状态条**：一行汇总 bridge（版本 / 运行时长 / 内存）、core、bot 在线数、开机自启、配置文件。全部正常时很低调；有问题时整条变色，下方逐条写明原因（如哪些 bot 没起来、`bots.json` 改了待重启——附「重启生效」按钮、pm2 未配置 launchd 自启）。
- **成本卡片**：今日任务、今日成本（都与**昨天同一时段**对比，早上看不会拿半天比一整天）、近 7 天成本（附每日小柱图与日均）、今日平均每个任务（与近 7 天平均对比）。成本上涨标红、下降标绿。数据来自活动记录库（`~/.luckagent/activity.db`，保留 35 天）。
- **机器人列表**：今日任务（失败数标红）、今日成本、近 7 天成本（附每日小柱图）、状态（执行中 / 空闲 / 离线）、最近活动。离线或今天有失败的 bot 置顶并整行标红，其余按今日成本排序。
- **接下来的定时任务**：同一时刻、同一 bot 的同类任务合并成一行（如「明天 08:00 · claudebot · 群日报 × 12」）。
- **今日失败**：今天的失败任务及错误信息。

以下几项在「系统配置」页：

- **密钥状态**：Claude / DeepSeek / MiniMax / 火山 ARK key 等各一行，三态显示——已生效、**「已写入 .env——重启桥接后生效」**（面板直读磁盘 `.env`，新增或轮换 key 后不会误显示成未配置，尾号是即将生效的值）、未配置；key 只填在某些 bot 的编辑表单里时，全局行会提示「另有 N 个 bot 单独配置」；
- **Claude 订阅登录状态**：走订阅路线时显示登录邮箱、档位与有效性；**core Token** 是否就位；
- **生图后端**：当前生效的是 Codex（ChatGPT 订阅）还是火山 Seedream、Codex 是否已装已登录、有没有 Seedream 兜底（登录状态按本机凭据文件判断，精确探测用 `luckagent doctor`）；

### 机器人管理

bot 的增删改查（读写 `bots.json`）：

- **新增**：表单只需名称、飞书凭证——保存时自动完成：①在 `<工作区根目录>/<名称>`（`.env` 的 `LUCKAGENT_PROJECTS_DIR`，默认 `~/projects`，系统配置页「Bot 工作区根目录」可查）创建工作目录与 `inputs/` 附件目录（`downloadsDir` 自动写为 `<工作目录>/inputs`；引擎用全局默认，建好后可在「编辑」里按 bot 调整）；②部署说明模板并预留定制技能目录（共享技能在全局 `~/.claude/skills`，无需按 bot 复制）；③放置 bot 级 `CLAUDE.md`/`AGENTS.md` 说明模板（父目录没有共用规范时一并部署）；④为 lark-cli 追加该应用的 profile（以机器人名命名，已存在同 appId 则跳过）。也可直接走「接入向导」（见下），自动化相同。
- **编辑**：打开详情表单改配置。**凭证掩码规则**：App Secret、API key 等敏感字段回显为 `••••` + 末 4 位；**保持掩码不动（或留空）= 不修改**，只有输入了新值才会覆盖。被回显的掩码值永远不会被写回配置。
- **群聊限制**：折叠区里可开「仅群聊模式」（`groupOnly`），并配**私聊白名单**——编辑运行中的 bot 时可先选一个群、再**按姓名勾选群成员**（自动填入 open_id），也支持直接粘贴 `ou_` 字符串；把白名单清空后保存即真正移除（非敏感字段在编辑态支持「清空 = 删除该配置项」）。同一折叠区还有「群里无需 @ 也响应」（`groupNoMention`）和「私聊也需要 @ 才响应（两人群同）」（`privateRequireMention`）两个开关：前者只管群聊，后者让私聊也走「不 @ 不理」的群聊规则（私聊里未 @ 发的文本/链接/图片/文件不会丢：下次 @ 时桥接按飞书接口拉这个人本轮的消息一起带上，48 小时内有效），并取消两人群的免 @ 豁免；默认都关。
- **删除**：从配置移除该 bot（工作目录不会被删）。
- **测试连接**：用当前凭证实时调飞书的 tenant_access_token 接口，验证 App ID/Secret 是否有效，不用等重启。
- **模型列**：列表显示每个运行中 bot **实际生效**的默认模型（bot 自己的设置 → 系统配置里的全局默认）；Claude bot 显示「跟随订阅」表示没有指定模型、由订阅档位决定。

⚠️ **任何增删改都不会热生效**——接口会明确返回 `requiresRestart: true`。流程固定是：**改 → 保存 → 点右上角「重启」→ 等 5 秒左右自动恢复**。桥接允许 `bots.json` 为空启动，所以全新安装可以先进管理台再从零加第一个 bot。

### 飞书接入向导

「机器人管理」页的「接入向导」按钮，把[飞书应用配置指南](feishu-app-setup.md)做成七步页面向导：

1. **创建应用** → 2. **填写凭证**（App ID/Secret，带实时测试连接）→ 3. **开启机器人** → 4. **权限配置**（列出要加的 scope）→ 5. **事件订阅**（长连接 + `im.message.receive_v1`，此时服务已在线，正好能通过飞书的连接验证）→ 6. **发布版本** → 7. **保存机器人**（名称、描述、工作目录，写入 `bots.json`）。

保存完同样需要重启生效。

### 定时任务

对应 `/api/schedule`：表格展示每个任务的类型（周期/一次性）、cron 表达式、时区、下次执行时间、状态（进行中/已暂停/待执行）；表格上方可按类型、bot、状态筛选（默认全部，各选项带计数）；新建弹窗二选一（cron 表达式 或 延迟秒数）；周期任务可暂停/恢复，所有任务可取消。详见[定时任务](scheduling.md)。

### 群日报

给飞书群配置每日总结，本质是把「日报」做成 label 为 `group-summary:<chatId>` 的周期任务，再叠加一层**按群名管理**的界面：

- 页面一次列出**所有 bot 实际所在的全部群**（每行一个「bot × 群」，按群名显示，来自飞书接口，不用手抄 `oc_` ID），每行一种状态：
  - **未配置**（蓝色）——新群默认态，页面顶部会提示「有 N 个群尚未配置日报」；
  - **已开日报**（绿色）——存在对应周期任务，显示 cron 与下次执行时间；
  - **已暂停**（橙色）——任务还在但暂停中；
  - **已忽略**（灰色）——明确不总结，记入 `~/.luckagent/group-summary.json`，不再被「未配置」提示打扰；
  - **失效**（红色）——bot 已退出该群，遗留任务可一键删除。
- 表格上方可按**群名 / chat_id 搜索**、按 **bot** 筛选、按**状态**筛选（默认「全部」，每个状态带计数）。
- 某个 bot 拉不到群列表（未运行 / 凭证失效）时只在顶部提示，不影响其他 bot；它已配置的日报仍会列出。
- **开启日报**：弹窗里改发送时间（默认每天 07:00，总结昨天全天——早晨看昨日复盘）与日报提示词模板（预填模板会自动带上群 chat_id 与 bot 的 lark-cli profile），确认即创建周期任务——**调度即时生效，无需重启**。
- 已开的群可**暂停/恢复/修改/关闭**；**「立即试跑」**按当前模板马上触发一次（走 `/api/talk` 异步执行），不用等到晚上验证效果。

> 前提：bot 处于运行状态且飞书应用有 `im:chat:readonly` 权限（接入向导的默认权限清单已包含）；日报内容由 bot 在对应群会话里用 lark-cli 拉取当天消息后生成并直接发群。

### 技能

只读视图，分两个标签页，点技能名可直接渲染 `SKILL.md`：

- **项目技能**（默认）：所有 bot 工作目录 `.claude/skills/` 下的定制技能拍平成一张表（与全局同名时项目级优先），叠加**使用统计**——近 7 天 / 近 30 天 / 累计调用次数、涉及会话数、最近使用时间；顶部汇总「近 30 天在用 / 30 天未用 / 从未使用」，可按技能名、bot、使用状态筛选。
- **全局技能**：`~/.claude/skills/`（对所有 bot 生效，由 `luckagent update` / lark-cli 维护），不纳入使用统计。

使用统计来自各 bot 的 Claude Code 会话记录（`~/.claude/projects/**/*.jsonl`）。**一次「使用」= 一轮用到该技能的对话**（一次请求里跑多少次脚本都只算 1 次），包括三种方式：调用 `Skill` 工具、直接读取 `.claude/skills/<name>/SKILL.md`、直接运行技能目录下的脚本——实际上项目级技能大多是后两种方式在用，只数 `Skill` 工具会严重低估。详情里的「直接使用」是其中没走 `Skill` 工具的轮数。按调用时的工作目录归属到 bot；增量扫描，结果缓存在 `~/.luckagent/skill-usage-cache.json`，会话记录被 Claude Code 定期清理后已统计的历史仍保留。每个 bot 的统计起始日以它现存最早的会话记录为准，「从未使用」指该日以来没有任何读取或调用。增删技能仍走文件系统或 `luckagent skills`（见[技能体系](claude-code-skills.md)）。

### 记忆

只读视图，展示各 bot 的 Claude Code auto-memory（按工作目录隔离的私人笔记），分两个标签页：

- **总览**：一个 bot 一行——记忆条数、总大小、**索引占用**、反馈类记忆数、30 天未更新数、索引行过长数、异常（未入索引 / 文件缺失）、最近更新。bot 每次会话开始只加载 `MEMORY.md` 的前 **200 行 / 25,000 字符**（Claude Code 2.1.290 源码核实），超出部分 bot 看不到；占用取两项中更高的一项，≥70% 标黄、超限标红并注明「已被截断」。点一行或某个计数，跳到明细并带上筛选。
- **明细**：所有 bot 的记忆拍平成一张表——Bot、标题与文件名、类型（取记忆文件 frontmatter 的 `type`：项目 / 反馈 / 参考 / 用户）、钩子（索引里的那句话，超过 150 字标出字数）、大小、更新时间（30 天未更新标橙）。搜索框同时搜标题、钩子和**正文**（正文命中由后端全文检索，显示命中处数与上下文片段并高亮关键词），并可按 bot、状态、类型筛选。
- **详情**：顶部显示记忆的类型、名称、描述（取自 frontmatter）和文件信息，正文去掉 frontmatter 后渲染；正文里的 `[[名字]]` 引用和指向同目录 `.md` 的链接可直接点击，跳到被引用的那条记忆。

索引解析兼容 bot 的各种写法：行首带 ⭐/⛔ 标记、表格行、一行多个链接（如「8 月日报：[0831](…) ｜ [0828](…)」，这行的字数平摊给其中每条记忆）。修改记忆仍在对应 bot 的记忆目录里手动编辑。

### 运行日志

在浏览器里 tail 桥接日志：`out.log` / `error.log` 二选一，可选行数（上限 1000 行，最多回读文件末尾 512 KB）。core 的日志请用 `luckagent logs --core` 看。

### 系统配置

**默认设置**（可编辑，写入 `.env`）——整机默认值，单个 bot 在「机器人管理 → 编辑」里单独设置的引擎 / 模型优先：

| 项 | `.env` 键 | 取值 |
| --- | --- | --- |
| 默认引擎 | `LUCKAGENT_ENGINE` | Claude Code / DeepSeek / MiniMax |
| Claude 默认模型 | `CLAUDE_MODEL` | 「跟随订阅档位」（推荐，不写）或手填模型 ID |
| DeepSeek / MiniMax 默认模型 | `DEEPSEEK_MODEL` / `MINIMAX_MODEL` | 下拉，选项与 bot 表单同源；清空 = 各引擎默认 |
| 生图后端 | `IMAGE_GEN_PROVIDER` | 自动（Codex 优先）/ Codex / 火山 Seedream；旁边显示 Codex 是否已装已登录、有无火山 key，「重新检测」实时跑一次 `codex login status` |
| 视频生成 · 火山方舟 key | `ARK_API_KEY` | **只写不回显**（只显示末 4 位）；视频生成必需，Seedream 生图也用这把；「清除」= 取消配置 |
| 视频生成 · TOS | `TOS_ACCESS_KEY` / `TOS_SECRET_KEY`（只写不回显）、`TOS_BUCKET`、`TOS_REGION` | 可选，只在参考本地视频 / 音频时需要；「测试 TOS」用**已保存**的配置上传一个小文件再删除，直接报出密钥 / 桶名 / 权限问题 |

- 保存只改动过的项，然后弹框确认是否**立即重启桥接**（会写明当前有几个任务在跑、重启会中断它们）；选「稍后」则各项显示「已保存，重启桥接后生效（当前运行：…）」。
- 只能改上表这些键，值也逐个校验（密钥限定字符集，杜绝写出换行、引号等破坏 `.env` 的内容）——`API_SECRET`、Anthropic / DeepSeek / MiniMax 等其他 key、端口等仍只能在终端编辑 `.env`，后台不会变成通用的 `.env` 编辑器。密钥类只写不回显：接口只返回末 4 位，日志只记改了哪些键、不记值。写入是原子替换，保持文件 0600 权限，其余行原样保留；清空一项 = 把该行注释掉。
- 某项如果在 PM2 启动时的环境变量里就已存在，`.env` 覆盖不了，界面会标红提示。
- Codex 的安装与登录仍需在这台 Mac 的终端里做（`npm i -g @openai/codex`、`codex login`），后台只显示状态与命令。

**有效配置**（只读，`GET /admin/api/config`）：

- 端口与绑定地址（apiPort / apiHost / core 地址）；
- 关键路径（安装目录、bots.json、状态目录、日志目录、发送暂存根目录）；
- 引擎默认值（Claude 模型与 backend、调度时区）；
- 凭证配置状态——只显示「是否已设置 + 末 4 位」，永远不回显完整密钥。

其余配置请编辑 `.env` / `bots.json` 后重启。

## 重启按钮的语义

管理台的「重启」调 `POST /admin/api/restart`，动作是：**桥接进程写下重启面包屑后主动 `exit(0)`，由 PM2 的 autorestart 拉起新进程**（预计 5 秒内恢复）。所以：

- 前提是进程由 PM2 管理（正常安装即是）；如果你用别的方式裸跑 bridge，这个按钮等于「停止」；
- 30 秒内重复点击会得到 429（restart already in progress），属正常防抖；
- 重启面包屑让新进程里的 agent 会话知道刚重启过，不会从历史消息里再触发一轮重启；
- 只重启 bridge，不动 core；
- 新进程沿用 PM2 首次启动时的 env，**不会重读 `ecosystem.config.cjs`**——升级后需要刷新 PATH 等环境变量时（如 v0.7.9 的 Python venv），用 `luckagent restart` 或重跑 `bash install.sh`。

## 安全说明

- **默认只绑 127.0.0.1**。bridge 监听地址由 `LUCKAGENT_API_HOST` 控制，默认回环——同机浏览器可访问，外部网络不可达。远程访问推荐 ssh 端口转发：`ssh -L 9100:127.0.0.1:9100 you@server`。
- **设 `LUCKAGENT_API_HOST=0.0.0.0` 之前想清楚**：管理台与 API 能创建 bot、投任务、让 agent 在服务器上执行任意命令——暴露它约等于暴露一个 shell。确要暴露时：必须设置强 `API_SECRET`；用防火墙 / 安全组把 9100 限制到可信来源 IP；最好再套一层带 TLS 的反向代理。9200（core）同理，默认也是回环。
- **鉴权边界**：`/admin` 与 `/admin/*` 的**静态资源**（HTML/JS）免鉴权——它们只是公开的前端代码；但所有数据接口（`/admin/api/*` 与 `/api/*`）一律要求 Bearer。`/api/health` 是唯一例外，只回状态与 uptime，供探活。
- **内置限流**：每 IP 每分钟 300 请求；一分钟内鉴权失败超过 10 次会被锁定约 1 分钟（返回 429，带 Retry-After）。可用 `LUCKAGENT_RATE_LIMIT_MAX` / `LUCKAGENT_RATE_LIMIT_AUTH_FAILS` 调整，`LUCKAGENT_RATE_LIMIT_DISABLED=1` 关闭（不建议）。

## 管理台后端接口

想脚本化时可以直接调（都要 Bearer）：

| 接口 | 作用 |
| --- | --- |
| `GET /admin/api/overview` | 总览页聚合数据 |
| `GET /admin/api/logs?file=out\|error&lines=200` | tail 日志 |
| `GET /admin/api/pm2` | PM2 进程列表（只读） |
| `GET /admin/api/config` | 生效配置（密钥掩码） |
| `GET /admin/api/config/defaults` | 可编辑的全局默认值：每项的 `live`（运行中）/ `disk`（.env 里）值、下拉选项、生图后端状态 |
| `PUT /admin/api/config/defaults` | 写入默认值（白名单键 + 值校验，`""` = 取消设置），返回 `requiresRestart` 与当前运行任务数 |
| `GET /admin/api/image-gen/probe` | 实时探测 Codex：是否安装、版本、`codex login status` 结果 |
| `POST /admin/api/video-gen/tos-probe` | 用已保存的 TOS 配置上传一个小对象再删除，返回是否通过与原因 |
| `POST /admin/api/feishu/test-connection` | 验证飞书凭证（传 `{appId, appSecret}` 或 `{botName}`） |
| `POST /admin/api/restart` | 重启桥接（进程自退出 + PM2 拉起） |
| `GET /admin/api/feishu/chats?bot=<name>` | 列出 bot 所在的群（群名 + chat_id，供群日报页与选人器） |
| `GET /admin/api/feishu/chat-members?bot=<name>&chatId=<oc_>` | 列出某群成员（姓名 + open_id，供白名单选人） |
| `GET /admin/api/costs?days=<1-35>` | 各 bot 每日任务数 / 失败数 / 成本，以及今天截至此刻与昨天同一时段的对比 |
| `GET /admin/api/memory/overview` | 所有 bot 的记忆索引、文件清单（含 frontmatter 类型）与索引占用 |
| `GET /admin/api/memory/search?q=<text>[&bot=<name>]` | 记忆正文全文检索（不区分大小写，返回命中数与上下文片段） |
| `GET /admin/api/memory/file?bot=<name>&file=<name.md>` | 读取单条记忆（原文 + 解析后的 frontmatter + 去掉 frontmatter 的正文） |
| `GET /admin/api/skills/usage` | 各 bot 的技能调用统计（扫描会话记录，后台增量刷新） |
| `GET /admin/api/group-summary?bot=<name>` | 读取该 bot 的群日报忽略名单 |
| `PUT /admin/api/group-summary` | 覆写忽略名单（`{bot, excluded: ["oc_…"]}`） |
| `GET/POST /api/bots`、`GET/PUT/DELETE /api/bots/:name` | bot CRUD（详情接口掩码密钥；改动需重启） |

## 相关文档

- [飞书应用配置指南](feishu-app-setup.md)｜[定时任务](scheduling.md)｜[常见问题排查](troubleshooting.md#管理台打不开或登录失败)
