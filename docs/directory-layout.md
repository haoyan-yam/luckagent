# 目录结构

Luckagent 涉及四类目录：安装目录、每个 bot 的工作目录、两个隐藏状态目录（`~/.luckagent`、`~/.luckagent-core`），外加一个容易被搞混的**发送暂存目录**。本文把它们一次说清——尤其是 ⚠️ 一节，历史上真实出过事故。

## 安装目录（`~/luckagent`）

默认装在 `~/luckagent`，可用 `LUCKAGENT_HOME` 环境变量或 `install.sh --dir` 改。

```
~/luckagent/
├── .env                  # 环境配置（密钥所在，权限 600，不入库）
├── bots.json             # 机器人列表（密钥所在，权限 600，不入库）
├── ecosystem.config.cjs  # PM2 双进程定义（luckagent-bridge / luckagent-core）
├── install.sh            # 安装脚本
├── bin/luckagent         # CLI（安装时复制到 ~/.local/bin/luckagent）
├── src/                  # bridge 源码（含 src/workspace/ 两个工作区模板）
├── packages/             # core 服务、CLI、管理台前端、内置技能源
├── dist/                 # 构建产物
└── logs/                 # 双进程日志（见下）
```

### 日志位置

| 文件 | 内容 |
| --- | --- |
| `<安装目录>/logs/out.log` | luckagent-bridge 标准输出 |
| `<安装目录>/logs/error.log` | luckagent-bridge 错误输出 |
| `<安装目录>/logs/core-out.log` | luckagent-core 标准输出 |
| `<安装目录>/logs/core-error.log` | luckagent-core 错误输出 |

看实时日志用 `luckagent logs`（core 加 `--core`）；管理台「运行日志」页可在浏览器里 tail bridge 的 out/error。

## 每个 bot 的工作目录

每个 bot 在 `bots.json` 里配 `defaultWorkingDirectory`（如 `~/projects/<bot名>`），agent 的所有文件操作都发生在这里。约定的子目录：

```
~/projects/<bot名>/
├── inputs/           # 聊天里收到的文件落地处（持久保留，任务结束不清理）
├── work/             # 过程文件、草稿、中间产物
├── outputs/          # 归档目录：定稿产物的留存副本（⚠️ 放这里不会自动发群）
├── CLAUDE.md         # 本 bot 专属指令（模板 src/workspace/CLAUDE.md，已存在则不覆盖）
├── AGENTS.md         # CLAUDE.md 的镜像（Kimi/Codex 引擎读这个名字）
├── .claude/skills/   # Claude/Kimi 引擎发现的技能
└── .codex/skills/    # Codex 引擎发现的技能（内容与上面一致）
```

另外，工作目录的**父目录**（如 `~/projects/`）会部署一份共用规范 `CLAUDE.md`（模板 `src/workspace/PROJECTS-CLAUDE.md`），对该目录下所有 bot 工作区生效。两级模板的分工见[技能体系](claude-code-skills.md#工作区指令文件两级模板)。

> 聊天附件的实际下载位置由 bot 的 `downloadsDir` 决定，**默认就是 `<工作目录>/inputs`**（管理台创建 bot 时会显式写入 bots.json；手写配置省略该字段时也回退到同一位置），文件持久保留、任务结束不清理。设置 `DOWNLOADS_DIR` 环境变量或该 bot 的 `downloadsDir` 可整体/单独改位置。

## ⚠️ outputs 归档目录 ≠ 发送暂存目录

这是整个目录体系里**最重要的一条区分**，两个目录名字相近、语义相反：

| | 归档目录 | 发送暂存目录 |
| --- | --- | --- |
| 路径 | `<工作目录>/outputs/` | `<系统tmp>/luckagent-outputs-<用户名>/<chatId>/` |
| 放进去会发到聊天吗 | **不会** | **会**——桥接自动扫描并发送 |
| 发送后文件还在吗 | 一直在（留档） | **发过即删** |
| 路径怎么改 | 工作区约定，自便 | 环境变量 `OUTPUTS_BASE_DIR`（或 bot 级 `outputsBaseDir`） |

**要把文件发到聊天**：复制到发送暂存目录对应 chatId 的子目录（桥接会在系统提示里把确切路径告诉 agent）。**要留档**：放 `outputs/`。正确顺序是**先在 `outputs/` 留档，再复制一份过去发送**——因为发送暂存目录里的文件发出后就没了。

### 「发过即删 + 漏发补扫」语义

发送暂存目录的生命周期（[设计笔记 E/Q](design-notes.md)）：

1. **发过即删**：每个文件发送成功后立即删除。于是「目录里还有文件 = 一定没发过」，任何入口都天然不会重复发送。
2. **开轮清空**：每回合开始时清空该 chat 的发送目录——里面若还有文件，只可能是上一轮已投递的残留。
3. **漏发补扫**：清空前、延迟清理（5 分钟保留期）前、以及自发卡片发出后，都会先补扫一遍目录把残留**发出去再删**。这样跨回合的后台任务（比如慢速生图在回合结束后才落盘）的迟到产物不会被静默销毁，而是落盘即发。
4. **per-chat 发送互斥**：同一 chat 的发送串行化，防并发双发。

一句话记忆：**`outputs/` 是仓库，发送暂存目录是传送带**。别把仓库当传送带（文件永远发不出去），更别把传送带当仓库（文件发完就没了）。

## `~/.luckagent`（bridge 状态目录）

路径可用 `SESSION_STORE_DIR` 覆盖。内容物：

| 文件 | 内容 |
| --- | --- |
| `scheduled-tasks.json` | 定时任务持久化（一次性 + 周期），重启自动恢复 |
| `sessions-<bot名>.json` | 每 bot 的会话映射（chatId → agent 会话），供连续对话续接 |
| `activity.db` | 活动事件库（任务开始/完成/失败、费用），管理台总览的数据源 |
| `outbound-ledger.db` | 出站台账：bot 发出的卡片终版文本与媒资 key，供「引用回复」上下文回捞 |
| `agent-teams.db` | Agent Teams（团队/任务/消息/运行）状态 |
| `budgets.json` | 每 bot 每日预算用量 |
| `last-restart.json` | 重启面包屑：重启后注入一次性提醒，防 agent 从历史会话里看到「请重启」又循环重启 |
| `default.env` | 可选的内部默认环境变量（优先级低于真实环境变量与项目 `.env`） |

## `~/.luckagent-core`（core 状态目录）

| 文件 | 内容 |
| --- | --- |
| `token` | 本机 CLI 使用的 Bearer token（首行），`luckagent memory/skills/agents/inbox` 自动读取 |
| `data/central.db` | 中央 SQLite：共享记忆、技能、agent 注册表、收件箱全在这一个库里 |
| `data/admin-bootstrap-token.txt` | 首次启动自动签发的 admin token（**只显示这一次**，权限 600，妥善保存；后续用 `bin/central-admin` 签发/吊销成员 token） |
| `data/audit/` | core 的审计日志（按天分文件） |

## 相关文档

- [设计笔记](design-notes.md) —— 发送目录生命周期等行为的来龙去脉
- [技能体系](claude-code-skills.md) —— `.claude`/`.codex` 双技能目录与两级指令模板
- [常见问题排查](troubleshooting.md) —— 目录相关的常见坑
