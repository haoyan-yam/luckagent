# 管理台使用手册

桥接进程自带 Web 管理台：`http://localhost:9100/admin`（访问根路径 `/` 也会进来）。日常运维——看状态、加机器人、配定时任务、翻日志——都可以在浏览器里完成，不用 ssh。

## 登录

登录口令就是 `.env` 里的 **`API_SECRET`**。输入后保存在浏览器 localStorage，之后每个数据请求都以 `Authorization: Bearer <API_SECRET>` 发出。登出即清除本地保存的口令。

> 管理台没有独立账号体系：拿到 `API_SECRET` 等于拿到全部管理能力，请像对待密码一样对待它。

## 页面一览

### 系统总览

一屏看全运行态：

- **桥接进程**：版本、uptime、内存占用；**core 服务**：在线状态与版本；
- **机器人列表**：每个 bot 的引擎、工作目录、是否在运行、常驻执行器数、**今日**任务数/失败数/费用、累计任务与费用、最近活动时间。「配置中的 bot」与「实际在跑的 bot」有差集时一眼能看出哪个没起来；
- **配置已变更提示**：`bots.json` 在进程启动后被修改过（管理台改的或手改的）会亮黄条，提醒需要重启生效；
- **定时任务**：一次性/周期任务计数与最近 5 条即将执行的任务；
- **最近失败**：今天最近 10 条失败任务及错误信息。

### 机器人管理

bot 的增删改查（读写 `bots.json`）：

- **新增**：表单只需名称、飞书凭证——保存时自动完成：①在 `~/projects/<名称>` 创建工作目录与 `inputs/` 附件目录（`downloadsDir` 自动写为 `<工作目录>/inputs`；引擎用全局默认，建好后可在「编辑」里按 bot 调整）；②部署说明模板并预留定制技能目录（共享技能在全局 `~/.claude/skills`，无需按 bot 复制）；③放置 bot 级 `CLAUDE.md`/`AGENTS.md` 说明模板（父目录没有共用规范时一并部署）；④为 lark-cli 追加该应用的 profile（以机器人名命名，已存在同 appId 则跳过）。也可直接走「接入向导」（见下），自动化相同。
- **编辑**：打开详情表单改配置。**凭证掩码规则**：App Secret、API key 等敏感字段回显为 `••••` + 末 4 位；**保持掩码不动（或留空）= 不修改**，只有输入了新值才会覆盖。被回显的掩码值永远不会被写回配置。
- **群聊限制**：折叠区里可开「仅群聊模式」（`groupOnly`），并配**私聊白名单**——编辑运行中的 bot 时可先选一个群、再**按姓名勾选群成员**（自动填入 open_id），也支持直接粘贴 `ou_` 字符串；把白名单清空后保存即真正移除（非敏感字段在编辑态支持「清空 = 删除该配置项」）。同一折叠区还有「群里无需 @ 也响应」（`groupNoMention`）和「私聊也需要 @ 才响应（两人群同）」（`privateRequireMention`）两个开关：前者只管群聊，后者让私聊也走「不 @ 不理、图片/文件暂存等下次 @」的群聊规则，并取消两人群的免 @ 豁免；默认都关。
- **删除**：从配置移除该 bot（工作目录不会被删）。
- **测试连接**：用当前凭证实时调飞书的 tenant_access_token 接口，验证 App ID/Secret 是否有效，不用等重启。

⚠️ **任何增删改都不会热生效**——接口会明确返回 `requiresRestart: true`。流程固定是：**改 → 保存 → 点右上角「重启」→ 等 5 秒左右自动恢复**。桥接允许 `bots.json` 为空启动，所以全新安装可以先进管理台再从零加第一个 bot。

### 飞书接入向导

「机器人管理」页的「接入向导」按钮，把[飞书应用配置指南](feishu-app-setup.md)做成七步页面向导：

1. **创建应用** → 2. **填写凭证**（App ID/Secret，带实时测试连接）→ 3. **开启机器人** → 4. **权限配置**（列出要加的 scope）→ 5. **事件订阅**（长连接 + `im.message.receive_v1`，此时服务已在线，正好能通过飞书的连接验证）→ 6. **发布版本** → 7. **保存机器人**（名称、描述、工作目录，写入 `bots.json`）。

保存完同样需要重启生效。

### 定时任务

对应 `/api/schedule`：表格展示每个任务的类型（周期/一次性）、cron 表达式、时区、下次执行时间、状态（进行中/已暂停）；新建弹窗二选一（cron 表达式 或 延迟秒数）；周期任务可暂停/恢复，所有任务可取消。详见[定时任务](scheduling.md)。

### 群日报

给飞书群配置每日总结，本质是把「日报」做成 label 为 `group-summary:<chatId>` 的周期任务，再叠加一层**按群名管理**的界面：

- 选定 bot 后，页面列出它**实际所在的全部群**（按群名显示，来自飞书接口，不用手抄 `oc_` ID），每个群三态：
  - **已开日报**（绿色）——存在对应周期任务，显示 cron 与下次执行时间；
  - **已忽略**（灰色）——明确不总结，记入 `~/.luckagent/group-summary.json`，不再被「未配置」提示打扰；
  - **未配置**（蓝色）——新群默认态，页面顶部会提示「有 N 个群尚未配置日报」。
- **开启日报**：弹窗里改发送时间（默认每天 07:00，总结昨天全天——早晨看昨日复盘）与日报提示词模板（预填模板会自动带上群 chat_id 与 bot 的 lark-cli profile），确认即创建周期任务——**调度即时生效，无需重启**。
- 已开的群可**暂停/恢复/修改/关闭**；**「立即试跑」**按当前模板马上触发一次（走 `/api/talk` 异步执行），不用等到晚上验证效果。
- bot 退出了某个群后，遗留任务会以「失效」标出，可一键删除。

> 前提：bot 处于运行状态且飞书应用有 `im:chat:readonly` 权限（接入向导的默认权限清单已包含）；日报内容由 bot 在对应群会话里用 lark-cli 拉取当天消息后生成并直接发群。

### 运行日志

在浏览器里 tail 桥接日志：`out.log` / `error.log` 二选一，可选行数（上限 1000 行，最多回读文件末尾 512 KB）。core 的日志请用 `luckagent logs --core` 看。

### 系统配置

**只读**的生效配置视图（`GET /admin/api/config`）：

- 端口与绑定地址（apiPort / apiHost / core 地址）；
- 关键路径（安装目录、bots.json、状态目录、日志目录、发送暂存根目录）；
- 引擎默认值（Claude 模型与 backend、调度时区）；
- 凭证配置状态——只显示「是否已设置 + 末 4 位」，永远不回显完整密钥。

页面也提供重启按钮。改配置本身请编辑 `.env` / `bots.json` 后重启。

## 重启按钮的语义

管理台的「重启」调 `POST /admin/api/restart`，动作是：**桥接进程写下重启面包屑后主动 `exit(0)`，由 PM2 的 autorestart 拉起新进程**（预计 5 秒内恢复）。所以：

- 前提是进程由 PM2 管理（正常安装即是）；如果你用别的方式裸跑 bridge，这个按钮等于「停止」；
- 30 秒内重复点击会得到 429（restart already in progress），属正常防抖；
- 重启面包屑让新进程里的 agent 会话知道刚重启过，不会从历史消息里再触发一轮重启；
- 只重启 bridge，不动 core。

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
| `POST /admin/api/feishu/test-connection` | 验证飞书凭证（传 `{appId, appSecret}` 或 `{botName}`） |
| `POST /admin/api/restart` | 重启桥接（进程自退出 + PM2 拉起） |
| `GET /admin/api/feishu/chats?bot=<name>` | 列出 bot 所在的群（群名 + chat_id，供群日报页与选人器） |
| `GET /admin/api/feishu/chat-members?bot=<name>&chatId=<oc_>` | 列出某群成员（姓名 + open_id，供白名单选人） |
| `GET /admin/api/group-summary?bot=<name>` | 读取该 bot 的群日报忽略名单 |
| `PUT /admin/api/group-summary` | 覆写忽略名单（`{bot, excluded: ["oc_…"]}`） |
| `GET/POST /api/bots`、`GET/PUT/DELETE /api/bots/:name` | bot CRUD（详情接口掩码密钥；改动需重启） |

## 相关文档

- [飞书应用配置指南](feishu-app-setup.md)｜[定时任务](scheduling.md)｜[常见问题排查](troubleshooting.md#管理台打不开或登录失败)
