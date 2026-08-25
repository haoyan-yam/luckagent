# 技能体系

技能（skill）是给 agent 的可复用操作手册：一个含 `SKILL.md` 的目录，描述「什么时候用、怎么用」。Claude Code / Kimi / Codex 会在会话里自动发现工作目录下的技能并按需加载。Luckagent 负责把该装的技能装到每个 bot 的工作目录里，并在升级时保持同步。

## 双目录发现机制

每个 bot 的工作目录里有两份内容一致的技能目录：

| 目录 | 谁来读 |
| --- | --- |
| `<工作目录>/.claude/skills/` | Claude、Kimi 引擎 |
| `<工作目录>/.codex/skills/` | Codex 引擎 |

安装器（`src/api/skills-installer.ts`）每次都成对写入两个目录，所以**换引擎不用重装技能**。全局层面同理：`~/.claude/skills` 与 `~/.codex/skills` 是一对。

## 随装技能

新建 bot（管理台勾选安装技能，或安装脚本）会装：

| 技能 | 作用 | 内置源 |
| --- | --- | --- |
| `luckagent` | **CLI 参考技能**：教 agent 用 `luckagent memory / skills / agents / inbox / teams / schedule / talk / voice` 等全部命令，是 bot 融入协作体系的说明书 | `packages/skills/luckagent/` |
| `voice` | 文本转语音：`luckagent voice tts` 的用法（生成 MP3、发语音） | `src/skills/voice/` |
| `openai-image-gen` | 文生图 / 图生图 / 改图：直调 OpenAI 图像 API（脚本零依赖），含提示词打法参考与绿幕抠图脚本。需 `.env` 配 `OPENAI_IMAGE_API_KEY` 或 `OPENAI_API_KEY`（可配 `OPENAI_BASE_URL` 走网关） | `src/skills/openai-image-gen/` |

**飞书 bot 额外装 19 个 `lark-*` 技能**（lark-doc、lark-im、lark-calendar、lark-sheets、lark-base、lark-task、lark-drive、lark-mail、lark-wiki 等），让 agent 会用 `lark-cli` 操作飞书文档/消息/日历/多维表格等 11 个业务域。lark-cli 是**必备组件**，安装脚本会自动装好（含 19 个技能）；若曾安装失败可手动补：

```bash
npm install -g @larksuite/cli
npx skills add larksuite/cli --all -y -g   # 拉取 19 个官方技能到全局
```

首次为飞书 bot 装技能时，Luckagent 会顺手用该 bot 的 App ID/Secret 初始化 `lark-cli` 配置（`~/.lark-cli/config.json` 已存在则跳过）。

## 可选技能（手动启用）

不默认安装，需要时从源码目录拷贝到 `~/.claude/skills/`（或某个 bot 的 `.claude/skills/`）即可；管理台创建 bot 时会自动把随装技能装进该 bot 工作目录的 `.claude/skills` 与 `.codex/skills`；`luckagent update` 检测到已启用会跟着同步进工作区：

| 技能 | 作用 | 源 |
| --- | --- | --- |
| `metaskill` | AI Agent 团队/技能生成器：`/metaskill ios app` 一句话生成可移植的 agent 团队或自定义技能 | `src/skills/metaskill/` |
| `metaschedule` | 服务端持久调度技能：教 agent 用桥接的定时任务 API（临时性任务建议优先用 Claude Code 原生的 `CronCreate` / `/loop`） | `src/skills/metaschedule/` |
| `luckagent-team` | Agent Teams 协作速查（紧凑版），`luckagent update` 会同步到全局技能目录 | `packages/skills/luckagent-team/`、`src/skills/luckagent-team/` |

```bash
# 启用示例
cp -r ~/luckagent/src/skills/metaskill ~/.claude/skills/
cp -r ~/luckagent/src/skills/metaskill ~/.codex/skills/
```

## 工作区指令文件：两级模板

技能之外，agent 还读两级「指令文件」，模板都在 `src/workspace/`：

| 层级 | 文件 | 模板 | 职责 |
| --- | --- | --- | --- |
| 共用层（部署一次） | 各 bot 工作目录的**父目录**下的 `CLAUDE.md`（如 `~/projects/CLAUDE.md`） | `src/workspace/PROJECTS-CLAUDE.md` | 对该目录下**所有** bot 生效的共用规范：inputs/work/outputs 文件存放约定、发送暂存目录语义、出站内容纪律、lark-cli 身份硬规则、`luckagent` 能力速查 |
| bot 层（每 bot 一份） | `<工作目录>/CLAUDE.md` + 镜像 `AGENTS.md` | `src/workspace/CLAUDE.md` | 只写**本 bot 专属**事实：项目背景、对应飞书群、lark-cli profile 名等（模板里的 `<占位>` 补齐后删说明段） |

分工原则：**共用规则只写在父目录那份里，bot 层不要复制**——否则改一条规则要改 N 个文件。`AGENTS.md` 是给 Kimi/Codex 引擎看的镜像（它们读这个文件名），内容与 `CLAUDE.md` 保持一致。

部署时机：新建 bot 时安装器部署两级文件（已存在则不覆盖）。

## `luckagent update` 的技能同步

`luckagent update` 在拉代码、重建之后会做一轮技能同步：

1. 仓库内置技能（`luckagent`、`voice`、`luckagent-team`、`openai-image-gen`）刷新到 `~/.claude/skills` 与 `~/.codex/skills`；
2. 若本机装过 lark-cli：升级 `@larksuite/cli` 并刷新 19 个 `lark-*` 技能，再镜像进两个全局技能目录；
3. 把上述技能（含已手动启用的 `metaskill` / `metaschedule`）同步进**首个 bot** 的工作目录 `.claude/skills` + `.codex/skills`；
4. ⚠️ 把首个 bot 工作目录的 `CLAUDE.md` 刷新为最新模板（**会覆盖本地修改**，改过模板的注意先备份或升级后 `git diff` 找回；`AGENTS.md` 仅缺失时补建）。

## 从旧机器迁移个人技能

全局技能就是普通目录，从旧机器拷到新机的 `~/.claude/skills/`（Codex bot 再镜像一份到 `~/.codex/skills/`）即可被所有 bot 发现：

```bash
scp -r 旧机器:~/.claude/skills/某技能 ~/.claude/skills/
cp -r ~/.claude/skills/某技能 ~/.codex/skills/   # 有 codex bot 时
```

迁移前自查三件事：**①** SKILL.md 里有没有旧机器的绝对路径、真实群/人 ID、人名（有就改掉）；**②** 依赖的密钥是否已进新机 `.env`；**③** 依赖的本地二进制是否已装。典型例子 `opencli`（把网站变成 CLI、驱动已登录的 Chrome）：技能文本可直接拷，但需在新机安装 opencli 二进制、装 Chrome 并完成目标网站登录后才可用——浏览器登录态迁移不了，属于每台机器的现场配置。

## 中央技能中心（跨 bot 共享）

某个 bot 沉淀出的可复用方法，可以发布到 luckagent-core 的技能中心，其他 bot / 其他机器一条命令安装：

```bash
luckagent skills publish <name> --from <目录>   # 读 <目录>/SKILL.md 发布
luckagent skills list                           # 看已发布的技能
luckagent skills install <name> --to ~/.claude/skills/<name>   # 安装（默认装到 ./.claude/skills/<name>，注意 --to）
```

发布时务必在 `SKILL.md` 里写清 **when-to-use**——技能是写给别的 agent 用的，触发条件模糊等于没写。

## 相关文档

- [CLI 参考](cli-reference.md) —— skills 子命令完整参数
- [目录结构](directory-layout.md) —— 工作目录全貌
