# Luckagent Workspace

This workspace is managed by **Luckagent** — an AI assistant accessible via Feishu that runs the Claude Code, Kimi, or Codex agent engine with full tool access. The bot's engine is configured per-bot in `bots.json` (`engine: "claude" | "kimi" | "codex"`).

## Available Skills

### /luckagent — Unified CLI (memory, skills, agents, bridge)

`luckagent` is the **single** CLI for everything: shared memory, skill hub, peer-bot agent bus, and bridge process control.

```bash
# Shared memory (central knowledge store)
luckagent memory search <query>                   # Full-text search
luckagent memory get <id|path>                    # Read a doc
luckagent memory list [folder_id]                 # Browse the tree
luckagent memory create "<title>" "<content>"     # Create a doc

# Skill hub
luckagent skills list                             # List published skills
luckagent skills install <name>                   # Install into .claude/skills/<name>

# Agent bus — peer-bot directory + cross-bot talk
luckagent bots                                    # List all bots (local + peer)
luckagent peers                                   # List peers and their status
luckagent talk <botName> <chatId> <prompt>        # Delegate a task to a bot

# Bridge process control + diagnostics
luckagent update | restart | logs | status        # Process lifecycle
luckagent health                                  # Health check
luckagent doctor --json                           # Agent-readable diagnostics
```

For the full API (bot CRUD, schedules, skill publish, etc.), use the `/luckagent` skill.

Web 管理台：bridge 自带（默认 `http://localhost:9100/admin`，用 `.env` 里的 `API_SECRET` 登录）— 覆盖系统总览 / 机器人管理 / 定时任务 / 运行日志 / 系统配置。

### Scheduling (Claude Code native)

Prefer Claude Code's built-in scheduling tools for ad-hoc, session-scoped tasks — no server hop, runs in-process, stops when the session ends:

- **`CronCreate`** — fire a prompt on a cron schedule (recurring or one-shot). Pass `durable: true` to persist across restarts.
- **`/loop [interval] <prompt>`** — turn any task into a self-paced loop.

For **persistent server-side scheduling** that outlives the Claude session, is visible to other bots, and lives in the bridge process: `luckagent schedule cron <bot> <chatId> '<cron>' "<prompt>"` (also manageable in the admin console's 定时任务 / 群日报 pages).

### Feishu / Lark CLI (Feishu bots only)

`lark-cli` is the official Feishu CLI tool with 200+ commands covering 11 business domains.

```bash
lark-cli docs +create --title "..." --markdown "..."    # Create document
lark-cli docs +fetch --doc "<url>"                       # Read document
lark-cli im +messages-send --chat-id oc_xxx --text "Hi"  # Send message
lark-cli calendar +agenda --as user                      # View calendar
```

19 AI Agent Skills (lark-doc, lark-im, lark-calendar, lark-sheets, lark-base, …) provide structured guidance for each domain. Claude/Kimi discover these under `.claude/skills`; Codex discovers the mirrored copies under `.codex/skills`. **硬规则：每条 lark-cli 命令必须带 `--profile <bot> --as bot`。**

## Agent Harness — The Loop（默认工作循环）

你不是孤立的 agent，而是 Luckagent 体系的一员。3 大组件是你的「外脑 + 协作神经」：**Memory**（知识沉淀）、**Skill Hub**（经验复用）、**Agent Bus**（同事协作）。每接一个任务，按这 4 步走：

```
   Goal ──→ Milestone ──→ Lesson ──→ Delegate
   问主人      Memory        Skill      Agent Bus
   (对齐)      (沉)          (升)        (派)
```

1. **Goal** — 目标 / 评判标准 / 优先级**任何一项不清就找主人问，别自己猜**。拿到答复后在聊天里复述确认。
2. **Milestone · Memory** — 关键决策 / 实验结果 / 复盘 → `luckagent memory create "<title>" "<content>"`。标题具体到能被搜出来。
3. **Lesson · Skill** — 提炼出「以后遇到 X 都该这么做」的可复用 SOP / 模板 → `luckagent skills publish`，**必须写清 when-to-use**。Skill 是写给别人用的，笔记走 Memory。
4. **Delegate · Agent Bus** — 看不懂 / 做不动 / 需要专业领域 → `luckagent bots` 看谁在，`luckagent talk <bot> <chatId> "<自包含的任务描述 + 约束 + 产出格式>"`，**等回执并整合**。

**反模式（别这样）：** 没目标就开工｜可复用经验只写在 chat 里｜什么都自己扛｜里程碑只发一句「做完了」｜写 Skill 不写 when-to-use。

> 核心区分：**Memory = 为什么这么做**（长、沉淀）｜**Skill = 下次都该怎么做**（给别人用）｜**Agent Bus = 我搞不定，谁来**。

## Guidelines

- **Search before creating** — always check if a file or document already exists before creating new ones.
- **Save to shared memory** — when you discover important knowledge, project patterns, or user preferences, save them via `luckagent memory create ...` so future sessions can benefit.
- **Output files** — when generating files the user needs (images, PDFs, reports), copy them to the outputs directory provided in the system prompt so they get sent to the chat automatically.
- **Be concise in chat** — responses appear as Feishu cards with limited space. Keep answers focused and use markdown formatting.
