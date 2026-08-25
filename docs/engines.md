# 多引擎配置（Claude Code / Codex / Kimi / DeepSeek）

每个 bot 独立选引擎：`bots.json` 里的 `engine: "claude" | "kimi" | "codex" | "deepseek"`（默认 `claude`），
管理台「机器人管理 → 编辑」的引擎下拉即可切换，选中后会展开对应的参数子表单。
同一台机器上各引擎的 bot 可以并存混用。

## Claude Code（默认，开箱即用）

运行时随 Luckagent 打包（`@anthropic-ai/claude-agent-sdk`），无需额外安装。认证二选一：

| 方式 | 步骤 |
| --- | --- |
| API Key | `.env` 填 `ANTHROPIC_API_KEY`（可配 `ANTHROPIC_BASE_URL` 走中转网关）→ `luckagent restart` |
| 订阅登录 | 装 Claude Code CLI（`curl -fsSL https://claude.ai/install.sh \| bash`）→ 终端跑 `claude` 完成登录 → `.env` 填 `CLAUDE_EXECUTABLE_PATH=~/.local/bin/claude` |

常用参数：`.env` 的 `CLAUDE_MODEL` / `CLAUDE_MAX_TURNS` / `CLAUDE_MAX_BUDGET_USD` 是全局默认，
bot 级的 `model` / `maxTurns` / `maxBudgetUsd`（管理台「限制与预算」）可覆盖。

## Codex

桥接以**子进程方式运行 Codex CLI**（`codex exec`），所以：

1. **装 CLI**（终端）：确保 `codex` 在 PATH 上，或 `.env` 配 `CODEX_EXECUTABLE_PATH` 指过去。
2. **认证二选一**：
   - 订阅：终端跑一次 `codex login`（交互 OAuth）；
   - API key：bot 的 Codex 子表单填 `apiKey`（内部规范化为 `OPENAI_API_KEY` 传给子进程），
     配 `baseUrl` 可接任何 OpenAI 兼容网关；全局默认写 `.env` 的 `CODEX_API_KEY` / `CODEX_BASE_URL`。
3. **免交互默认已就位**：不配置时即 `approvalPolicy=never` + `sandbox=danger-full-access`，
   bot 无人值守不会卡在审批上；需要收紧就在子表单里改（`workspace-write` / `read-only` 等）。
4. 选引擎：管理台下拉选 Codex，子表单填模型（如 `gpt-5.5`）。

`luckagent doctor --json` 里有 `codex` 与 `codex_agent_features` 检查项可自查。

## Kimi

SDK 随 Luckagent 打包，但它**底层拉起 `kimi` CLI**，认证继承自 `~/.kimi/config.toml`：

1. **装 Kimi CLI 并登录**（终端）：完成 Moonshot 订阅的 OAuth 登录；也可在 bot 的 Kimi 子表单填 `apiKey` 走 key 认证。
2. 选引擎：管理台下拉选 Kimi，子表单填模型（如 `kimi-latest`）、思考模式开关。
3. 桥接启动该 bot 时会预检登录态（`isLoggedIn()`），未登录会给出明确报错。

## DeepSeek（最省事：零安装，只要 key）

DeepSeek 官方提供 **Anthropic 兼容端点**（`https://api.deepseek.com/anthropic`），Luckagent 让它直接跑在
Claude 引擎的运行时上——**不用装任何 CLI**：

1. 申请 key：https://platform.deepseek.com → `.env` 填 `DEEPSEEK_API_KEY`（或在 bot 的 DeepSeek 子表单里按 bot 填）。
2. 管理台建/编辑 bot：引擎下拉选 DeepSeek，模型三选一：
   `deepseek-v4-flash`（快、便宜、默认）/ `deepseek-v4-pro`（更强推理）/ `deepseek-v4-flash-vision-exp`（**视觉理解**，可看图）。
3. 保存重启即生效。会话内 `/model deepseek` 也可临时切换。

凭证注入是 **bot 级隔离**的：DeepSeek bot 与 Claude 订阅 bot 在同一台机器并存互不干扰
（每个 bot 的子进程注入自己的 endpoint 与 key，宿主机的 Claude 登录态不受影响）。

适合：高频轻任务（群日报、摘要、问答）、中文场景、成本敏感的 bot；复杂多步任务的可靠性与 Claude 有差距，重活建议留 Claude。

> 计费提示：管理台/统计里显示的费用是按 Claude 价目估算的（运行时不识别 DeepSeek 价目），DeepSeek 实际账单远低于显示值，以 DeepSeek 平台为准。

## 指令文件（CLAUDE.md）在各引擎下如何生效

Luckagent 用**一份内容、多个入口**的方式让同一套指令覆盖所有引擎：

| 内容 | Claude Code | Codex / Kimi |
| --- | --- | --- |
| bot 工作目录指令 | 读 `CLAUDE.md` | 读 `AGENTS.md` —— 它是指向 `CLAUDE.md` 的**符号链接**（建 bot 时自动创建），改 `CLAUDE.md` 即全引擎同步生效 |
| 共用规范（`~/projects/CLAUDE.md`） | 生效（Claude 向上遍历父目录） | Codex 不遍历父目录——安装脚本已把共用规范镜像到其全局指令位 `~/.codex/AGENTS.md`（仅在不存在时部署，可自行改写） |
| 逐回合系统提示（工作目录、发送暂存目录、提问人 open_id 等） | ✅ 桥接注入，引擎无关 | ✅ 同左 |

注意事项：

- **日常只维护 `CLAUDE.md` 一个文件**即可；`AGENTS.md` 符号链接会自动跟随。
  如果你曾手工创建过普通文件版的 `AGENTS.md`，系统不会覆盖它——此时两份内容需要自己保持一致
  （或删掉它再建一次 bot 级技能安装，让符号链接接管）。
- 改了 `~/projects/CLAUDE.md` 共用规范后，若有 codex bot，记得同步一下 `~/.codex/AGENTS.md`
  （直接 `cp ~/projects/CLAUDE.md ~/.codex/AGENTS.md`）。
- 技能同样是双目录机制：`.claude/skills`（Claude/Kimi）与 `.codex/skills`（Codex）
  在建 bot 和 `luckagent update` 时都会同步安装，无需手动维护。

## 快速核对清单

```bash
luckagent doctor --json     # codex 检查项（`codex_cli`；kimi 无独立检查项，认证在 `~/.kimi/config.toml`）一目了然
```

| 引擎 | 需要终端做的事 | 其余 |
| --- | --- | --- |
| Claude | 无（API key 路线）或装 CLI + 登录（订阅路线） | `.env` / 管理台 |
| Codex | 装 `codex` CLI；订阅路线再跑 `codex login` | 管理台子表单 |
| Kimi | 装 `kimi` CLI 并登录 | 管理台子表单 |
| DeepSeek | **无**——只要申请个 key | `.env` 或管理台子表单 |
