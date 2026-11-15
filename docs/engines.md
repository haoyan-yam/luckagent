# 模型接入（Claude / 灵眸 / DeepSeek / MiniMax）

所有接入共用 Claude Code 运行时。后台统一管理服务商连接，每条连接保存自己的地址、Key、默认模型和流量选项；每个机器人独立选择连接。
旧的 `engine`、`deepseek`、`minimax` 配置块及 `.env` 变量继续读取，升级不会改写这些配置，也不会自动为旧 bot 切换服务商。

## 在后台新增连接

进入「系统配置 → 模型接入 → 新增连接」，选择服务商：

| 服务商预设 | Base URL | 运行方式 |
| --- | --- | --- |
| 灵眸 | `https://api.lmuai.ai` | Claude 运行时，保留 bot / 环境指定的后端 |
| DeepSeek | `https://api.deepseek.com/anthropic` | SDK，无需额外安装 CLI |
| MiniMax | `https://api.minimaxi.com/anthropic` | SDK，无需额外安装 CLI |
| Anthropic API | `https://api.anthropic.com` | Claude 运行时 |
| 自定义兼容接口 | 手动填写 | Anthropic Messages 兼容接口 |

预设会填入地址及已支持的默认模型；模型 ID 应以你的 Key 可用列表为准，可手动调整。
同一服务商可以创建多条连接，使用不同 Key、地址或模型。服务商决定内部适配方式，如需更换服务商请新增连接。

- Key 保存后不回显。编辑时留空保留原值，填写新值替换；「清除已保存的 Key」显式删除。
- 可以先保存没有 Key 的连接，稍后填写；使用缺少 Key 的连接会报错，不会偷偷使用其他连接或旧环境 Key。
- 「测试连接」使用已保存的参数发送一条简短 Messages 请求，产生少量费用。
  成功只表示认证与基础模型调用通过，不代表已经验证图片、工具调用或流式会话。
- 每条连接的「禁用非必要流量」默认关闭。开启后禁用自动更新、遥测、错误上报等，也可能影响依赖远程功能开关的 Claude 功能。
  仅传给引用此连接的 bot，开启使用 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`，关闭使用空字符串（不能用 `0`）。
- 列表分别展示已保存绑定与当前运行使用的 bot；顶部汇总当前运行接入，不包含会话临时切换。仍被全局默认或 bot 引用的连接不能删除。

## 默认连接与机器人选择

「模型接入」中的「默认模型连接」是新配置的统一默认入口。
「机器人管理 → 新建 / 编辑 → 模型连接」可选择：

| 选项 | 行为 |
| --- | --- |
| 继承全局默认连接 | 跟随上方默认模型连接；全局为兼容旧配置时，仍按原有引擎与环境规则解析 |
| 某条已保存连接 | 固定使用该连接，优先于 bot 旧的 `engine` 和服务商配置块 |
| 本机 Claude 登录 | 固定官方端点，屏蔽继承的网关 Key；持久会话默认 PTY，要求本机 CLI 已登录 |
| 兼容旧配置 | 保留旧引擎、模型、凭证与环境配置，不跟随统一默认连接切换 |

模型优先级：会话 `/model` 临时选择 → bot 的「模型覆盖」→ 连接默认模型。
选择 DeepSeek / MiniMax 连接时自动用 SDK 后端；选择连接不会删除 bot 原有的旧引擎配置，日后可切回兼容模式。
聊天中的 `/model claude|deepseek|minimax` 仍是旧引擎的临时切换命令，不是后台连接选择器；跨引擎切换按对应旧凭证解析，长期使用请在后台绑定连接。

「本机 Claude 登录」状态使用 `claude auth status --json` 查询结果，短暂缓存一分钟，不读取旧账户缓存来判断订阅状态。
沿用旧配置的 bot 会在各自工作目录查询认证；确认使用同一官方账号后，显示在本机登录的使用列表中，不改写 bot 配置。查询失败或认证不一致时单独列为未确认。

新建机器人（包括飞书接入向导）默认明确选择继承全局连接。
原先未设置 `modelConnection` 的 Claude bot 保留先前的默认连接继承行为；
未设置该字段的旧 DeepSeek / MiniMax bot（包括通过 `LUCKAGENT_ENGINE` 默认选中的 bot）继续使用旧配置。
这类 bot 会在后台标为「兼容旧配置」，只有主动选择新连接或继承全局才迁移。

## 从旧 DeepSeek / MiniMax 配置迁移

「模型接入 → 旧配置兼容与复制」会列出进程环境中的旧全局配置，以及 `bots.json` 的服务商覆盖块。
点击「复制为独立连接」会在本机复制有效地址、模型和 Key，不把 Key 返回浏览器。

复制不修改原配置、不更改全局默认，也不重新绑定 bot。
复制后可先测试新连接，再为目标 bot 选择它；新旧两份配置独立维护，修改新连接不会改变旧 Key。
同一个来源只能复制一次；删除复制所得连接后可以再次复制。

后台不再分别编辑 `CLAUDE_MODEL`、`DEEPSEEK_MODEL`、`MINIMAX_MODEL`、`LUCKAGENT_ENGINE`。
这些变量及旧 API 仍保留兼容能力；「默认设置」保存生图、视频等参数时不会清空它们。
若刚手动更改 `.env` 的旧 Key，请先重启加载后再复制，使复制值与运行值一致。

## 生效与存储

连接与 bot 配置保存后，需要重启桥接才对实际调用生效。全局默认连接需点击「保存默认连接」，确认受影响的 bot 后才写入。
所有重启统一使用页面顶部入口；服务端检查运行、准备中及排队任务，默认拒绝忙碌时重启，退出前再次检查新任务。确需中断时须在弹窗明确确认。
待生效状态由服务端与启动时配置快照比较，刷新或切换页面不会丢失提示；进程恢复以新实例标识确认。
测试连接可以在重启前执行，使用已保存的连接参数；当前运行绑定仍以桥接进程已加载的配置为准。
重启检查、页面分区和管理接口详见[管理台使用手册](admin-console.md#系统配置)。

连接存于本机 `bots.json.modelConnections`，文件权限为 `0600`，Key 为本地明文。
`provider` 指定适配服务商；缺少该字段的原有连接继续按自定义 Claude 兼容接口处理。
`defaultModelConnection` 保存全局连接 ID、`local` 或 `legacy`；bot 的 `modelConnection` 还可为 `inherit`。
不会修改 `~/.claude/settings.json`，也不会把 Key 放进 API 响应或连接测试的错误信息。

各服务商模型能力仍以实际模型为准；管理台费用可能是运行时估算，实际账单以服务商为准。

## 旧配置与 CLI 安装

旧 `.env` 配置继续支持：

- Claude：`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`CLAUDE_MODEL`。
- DeepSeek：`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`，以及 bot 的 `deepseek` 配置块。
- MiniMax：`MINIMAX_API_KEY`、`MINIMAX_BASE_URL`、`MINIMAX_MODEL`，以及 bot 的 `minimax` 配置块。
- 默认引擎：`LUCKAGENT_ENGINE`；任务限制：`CLAUDE_MAX_TURNS` / `CLAUDE_MAX_BUDGET_USD`，bot 可单独覆盖。

PTY 后端需要本机可执行的 Claude CLI，可通过 `CLAUDE_EXECUTABLE_PATH` 指定；SDK 可以使用随包运行时。
`luckagent doctor --json` 可核对运行时、PM2、bots、语音、生图等检查项。

## 指令文件与记忆

各接入共用工作目录、CLAUDE.md、技能、持久会话池与记忆体系。工作目录的 `AGENTS.md` 是指向 `CLAUDE.md` 的符号链接；
共用规范 `~/projects/CLAUDE.md` 继续生效。已有普通 `AGENTS.md` 不会被覆盖。
