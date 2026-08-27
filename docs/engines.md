# 引擎配置（Claude Code / DeepSeek / MiniMax）

每个 bot 独立选引擎：`bots.json` 里的 `engine: "claude" | "deepseek" | "minimax"`（默认 `claude`），
管理台「机器人管理 → 编辑」的引擎下拉即可切换，选中 DeepSeek / MiniMax 会展开参数子表单。
同一台机器上多种引擎的 bot 可以并存混用。

所有引擎共享**同一个 Claude Code 运行时**（`@anthropic-ai/claude-agent-sdk`）——持久会话池、
Agent Teams、`/goal`、后台任务、记忆体系（CLAUDE.md / auto-memory / session 续接）对两者完全一致，
差别只在指向哪家的 API 和用谁的 key。DeepSeek 与 MiniMax 都走各家官方的 **Anthropic 兼容端点**，零 CLI 安装。

## Claude Code（默认，开箱即用）

运行时随 Luckagent 打包，无需额外安装。认证二选一：

| 方式 | 步骤 |
| --- | --- |
| API Key | `.env` 填 `ANTHROPIC_API_KEY`（可配 `ANTHROPIC_BASE_URL` 走中转网关）→ `luckagent restart` |
| 订阅登录 | 装 Claude Code CLI（`curl -fsSL https://claude.ai/install.sh \| bash`）→ 终端跑 `claude` 完成登录 → `.env` 填 `CLAUDE_EXECUTABLE_PATH=~/.local/bin/claude` |

模型默认**跟随订阅档位**（不指定时由 Claude 官方按你的计划选：Pro→Opus 5，Max→Fable 5）；
要固定某个模型才设 `.env` 的 `CLAUDE_MODEL`（指定超出档位的会被静默降级，以回复页脚显示的实际模型为准）。
其余参数：`CLAUDE_MAX_TURNS` / `CLAUDE_MAX_BUDGET_USD` 是全局默认，
bot 级的 `model` / `maxTurns` / `maxBudgetUsd`（管理台「限制与预算」）可覆盖。

## DeepSeek（最省事：零安装，只要 key）

DeepSeek 官方提供 **Anthropic 兼容端点**（`https://api.deepseek.com/anthropic`），Luckagent 让它直接跑在
Claude 引擎的运行时上——**不用装任何 CLI**：

1. 申请 key：https://platform.deepseek.com → `.env` 填 `DEEPSEEK_API_KEY`（或在 bot 的 DeepSeek 子表单里按 bot 填）。
   **没有 Claude 账号的机器**再加一行 `LUCKAGENT_ENGINE=deepseek`（全局默认引擎），之后建的 bot 默认即用 DeepSeek——安装脚本检测到「只填了 DeepSeek key 且未装 Claude CLI」时会自动写入这行。
2. 新建 bot 默认继承安装时选定的全局引擎；需要按 bot 调整时在「机器人管理 → 编辑」的引擎下拉选 DeepSeek，模型二选一：
   `deepseek-v4-flash`（快、便宜、默认）/ `deepseek-v4-pro`（更强推理）。
   两个模型都**原生支持看图**（群里发图片给 bot，agent 用 Read 工具读取即可理解——已实测）；
   实验版 `deepseek-v4-flash-vision-exp` 仍可手填使用，但日常无需。
3. 保存重启即生效。会话内 `/model deepseek` 也可临时切换（临时切换的会话走逐回合执行路径，
   Agent Teams / /goal / 后台任务等持久会话特性不参与；要长期用请在 bots.json 或管理台把该 bot 的 engine 设为 deepseek）。

凭证注入是 **bot 级隔离**的：DeepSeek bot 与 Claude 订阅 bot 在同一台机器并存互不干扰
（每个 bot 的子进程注入自己的 endpoint 与 key，宿主机的 Claude 登录态不受影响）。

适合：高频轻任务（群日报、摘要、问答）、中文场景、成本敏感的 bot；复杂多步任务的可靠性与 Claude 有差距，重活建议留 Claude。

> 计费提示：管理台/统计里显示的费用是按 Claude 价目估算的（运行时不识别第三方价目），DeepSeek / MiniMax 实际账单以各自平台为准（通常远低于显示值）。

## MiniMax（零安装，原生看图）

MiniMax 同样提供 **Anthropic 兼容端点**（`https://api.minimaxi.com/anthropic`），接法与 DeepSeek 完全一致：

1. 申请 key：https://platform.minimaxi.com （支持订阅制 Coding Plan，key 以 `sk-cp-` 开头）→ `.env` 填 `MINIMAX_API_KEY`（或在 bot 的 MiniMax 子表单里按 bot 填）。全机默认用它则再加 `LUCKAGENT_ENGINE=minimax`（安装脚本选 MiniMax 时自动写入）。
2. 模型二选一：`MiniMax-M3`（旗舰、**原生看图**、默认）/ `MiniMax-M2.5`（上一代、更省）。
3. 保存重启即生效；会话内 `/model minimax` 临时切换的说明同上（走逐回合路径）。

凭证同样 bot 级隔离，与 Claude / DeepSeek bot 并存互不干扰。

## 指令文件（CLAUDE.md）如何生效

| 内容 | 生效方式 |
| --- | --- |
| bot 工作目录指令 `CLAUDE.md` | 两个引擎同一运行时，直接读取；`AGENTS.md` 是指向它的**符号链接**（建 bot 时自动创建），为你手动在工作目录运行的其他 agent 工具保留兼容 |
| 共用规范（`~/projects/CLAUDE.md`） | 生效（运行时向上遍历父目录） |
| 逐回合系统提示（工作目录、发送暂存目录、提问人 open_id 等） | 桥接注入，引擎无关 |

**日常只维护 `CLAUDE.md` 一个文件**即可。如果你曾手工创建过普通文件版的 `AGENTS.md`，系统不会覆盖它。

## 快速核对清单

| 引擎 | 需要终端做的事 | 其余 |
| --- | --- | --- |
| Claude | 无（API key 路线）或装 CLI + 登录（订阅路线） | `.env` / 管理台 |
| DeepSeek | **无**——只要申请个 key | `.env` 或管理台子表单 |
| MiniMax | **无**——只要申请个 key | `.env` 或管理台子表单 |

`luckagent doctor --json` 可核对运行时、PM2、bots、语音等检查项。
