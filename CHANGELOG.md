# 更新日志

版本号 = 根 `package.json`（管理台总览页显示的就是它）。升级：`luckagent update`（git 安装）或重跑一行安装命令（tarball 安装）。git tag 与本文件同步打点。

## v0.7.17 — 2026-09-23

- **bot 工作区根目录可自定义**：安装脚本新增「bot 工作区根目录」一步——回车用默认 `~/projects`，或输入任意路径（`~` 与相对路径按家目录展开，可含空格）；写进 `.env` 的 `LUCKAGENT_PROJECTS_DIR`，重跑沿用，`--yes` 用默认，目录不可写时回退默认。管理台 / 飞书接入向导新建机器人时工作目录默认为 `<根目录>/<机器人名>`，表单提示显示实际根目录，系统配置页新增「Bot 工作区根目录」；`luckagent update` 补部署共用规范、卸载脚本的保留提示都读同一配置。只影响之后新建的机器人，已有机器人的工作目录记在 bots.json 里不会移动
- **修复：工作目录含 `.`、空格、`_`、`~` 或中文时飞书卡片空白**：Claude Code 按工作目录命名 `~/.claude/projects/<目录>` 时把**所有非字母数字字符**换成 `-`（超 200 字符截断加哈希、按软链接解析后的真实路径），而 PTY 会话跟踪、会话换新 / `/resume`、管理台记忆页三处只替换了 `/`——PTY 扫描器盯着一个不存在的会话文件，卡片空白。现统一由 `claudeProjectsDir` 按 SDK 同款规则推导；这类路径的现有机器人随之找到真实的会话目录
- 测试：`tests/projects-root.test.ts` 5 例；`session-lister` 新增 5 例（对照本机 Claude Code 实际生成的目录名、下划线与中文、超长截断加哈希、软链接解析、不存在路径回退）；安装脚本该段抽出按 6 种输入（回车 / 含空格 / 相对路径 / 已配置 / 无人值守 / 不可写）模拟验证

## v0.7.16 — 2026-09-23

- **2 秒合并窗口内连发的附件不再丢失**：图片 / 文件先发、2 秒内再发文字（或富文本）时，合并会把后者自带的附件整个覆盖掉——富文本的第 2 张及以后的图片、@ 时按接口拉回的「本轮」材料都被静默丢弃；几条纯图片消息合并时，第一条带的本轮材料同样丢失。现在三种合并（攒批 + 文字、纯媒体攒批、同一人排队连发）统一收集每条消息的主附件与自带附件，按「消息 id + key」去重后追加，先发的在前；多图合并时的「请分析这些 N 张图片和 M 个文件」也按全部附件计数
- 测试：`tests/media-batch.test.ts` 新增 5 例（富文本多图 + 攒批、攒批消息自带的本轮材料、@ 带图 + 窗口内再来一张、去重、单条原样返回）

## v0.7.15 — 2026-09-23

代码审查修复（第一批 4 项）：

- **回合启动失败不再卡死在「思考中」**：执行器拉起失败（如 PTY 后端找不到 claude CLI）或上一回合仍在收尾时，群消息与 API / 定时任务两条入口都把已发出的思考卡片收成错误态并写明原因（「启动任务失败：…」），记审计、继续处理排队消息；此前异常只进日志，卡片永远转圈。`/stop` 后立刻发新消息时，新回合先等上一回合中止收尾（最多 10 秒，大于执行器 8 秒的强制清理），不再直接撞上「turn … is in flight」
- **定时任务 / API 任务与群消息不再撞车**：`executeApiTask` 在第一次 await 之前就占住会话（准入标记），期间到达的群消息排队、任务结束后接着跑；准入标记改为按调用发令牌，前一回合收尾时先拉起排队消息再释放自己的标记，不会误删下一回合刚占的；API 任务收尾只删除属于自己的运行记录
- **中文标题记忆写入修复**：服务端与 CLI 的 slugify 保留 Unicode 文字 / 数字，`luckagent memory create "项目决策记录" …` 落在 `/…/项目决策记录`；此前非 ASCII 标题被清成空串，文档路径塌缩到命名空间根上、第二篇起 409。纯表情 / 标点标题回退为 `untitled-<随机串>`。已按旧规则写入的文档路径不会自动迁移
- **超过 24.8 天的一次性定时任务不再立即触发**：一次性任务与周期任务一样分段挂 setTimeout（Node 会把超上限的延迟当作 1 ms），取消 / 修改时连中间检查点一起清掉
- 测试：`tests/message-bridge-turn-start.test.ts` 6 例；调度器长延迟 2 例；记忆库 / CLI 中文路径 8 例；`session-rollover-bridge` 两例改为断言启动失败返回 `success: false`

## v0.7.14 — 2026-09-23

- **管理台可编辑全局默认值**：系统配置页新增「默认设置」卡片——默认引擎（`LUCKAGENT_ENGINE`）、Claude 默认模型（「跟随订阅档位」或手填 ID，`CLAUDE_MODEL`）、DeepSeek / MiniMax 默认模型（下拉，与 bot 表单同源）、生图后端（自动 / Codex / 火山 Seedream，`IMAGE_GEN_PROVIDER`，附 Codex 安装/登录状态与「重新检测」实时探测）。保存只提交改动项，随后弹框确认是否立即重启桥接（写明当前运行中的任务数、重启会中断它们）；选稍后则逐项标出「已保存，重启后生效（当前运行：…）」
- 写入安全：`PUT /admin/api/config/defaults` 只接受这五个键并逐值校验（`API_SECRET`、各类 key 等一律拒绝，后台不会变成通用 `.env` 编辑器）；原子替换、保持 0600、只动目标行，清空 = 注释掉该行；某键若已在 PM2 启动环境里，界面标红提示 `.env` 覆盖不了。新增 `GET /admin/api/config/defaults`、`GET /admin/api/image-gen/probe`
- 机器人列表新增「模型」列，显示每个运行中 bot 实际生效的默认模型（Claude 未指定时显示「跟随订阅」）；bot 表单 Claude 模型框提示改为指向全局默认
- 测试：`tests/env-defaults.test.ts` 14 例（白名单与值校验含换行注入、行级替换/模板行/追加/注释/去重、原子写与权限）；本地一次性桥接实例上端到端验证保存 → 确认框 → 重启生效 → 取消设置

## v0.7.13 — 2026-09-23

- **生图改为 Codex 优先、火山 Seedream 兜底，去掉 OpenAI API 后端**：`image-gen` 技能新增 codex 后端——调本机 Codex CLI 内置的 image_gen 工具出图，走 ChatGPT 订阅额度，不需要任何 key（原生透明底、参考图、并行候选、跨进程并发上限 `CODEX_IMAGE_MAX_CONCURRENCY`）。统一入口 `gen.py` 的判定顺序：`--provider` > `.env` 的 `IMAGE_GEN_PROVIDER` > Codex 已登录 > `ARK_API_KEY`；走 Codex 时若未登录或撞订阅额度且配了火山 key，自动改用 Seedream 重出（`--provider` 强制时不兜底）。两个后端参数统一为 `--aspect / --size / --image / --n / --transparent`，Seedream 的透明底由 gen.py 在色键背景上生成后本地自动抠图，多张统一命名 `<stem>_1..N`。`gen_image.py`（OpenAI gpt-image-2）与 `references/image-api.md` 删除，SKILL.md 与两份提示词参考同步改写
- **安装脚本新增「生图」段**（重跑也会走到，已配置则跳过）：先问有没有 ChatGPT 订阅——有就代装 `@openai/codex` 最新版并引导 `codex login`；没有或登录未成功再问火山 ARK key。结果写进 `.env` 的 `IMAGE_GEN_PROVIDER`；想用 Codex 但暂未登录、先填了火山 key 时不锁定后端，登录后自动切回 Codex。`--yes` 只检测不代装。原先生成 `.env` 时的「OpenAI / 火山生图 key」提问移除
- `luckagent update` 升级经 npm 全局安装的 Codex CLI，并清理旧版同步进 `~/.claude/skills/image-gen` 的已退役文件；`luckagent doctor` 新增 `image_gen` 检查（生效后端、Codex 版本与登录状态、有无 Seedream 兜底、个人装的 `codex-image-gen` 技能触发重叠提示）；管理台配置页「生图 OPENAI_IMAGE_API_KEY」一行换成「生图后端」状态
- **升级注意**：`OPENAI_IMAGE_API_KEY` 不再使用。只配了它的机器升级后无法生图，需 `npm i -g @openai/codex && codex login`，或在 `.env` 填 `ARK_API_KEY`，然后 `luckagent restart`（doctor 会提示）。已部署的 `~/projects/CLAUDE.md` 不会被覆盖，其中「OpenAI 或火山」的描述可对照 `src/workspace/PROJECTS-CLAUDE.md` 手动更新
- 测试：`tests/image-gen-dispatch.test.ts` 10 例（假 codex 可执行文件 + 本地 HTTP 冒充方舟接口，真实跑 gen.py：后端判定 5 例、尺寸换算与参数校验 2 例、额度兜底 / 强制不兜底 / 多张命名 3 例）；本机用真实 Codex 端到端出透明底图验证

## v0.7.12 — 2026-09-23

- **修复：零安装的 DeepSeek / MiniMax 机器在持久会话模式下起不来**：v0.4.1 已把 `executor.ts` 的 claude CLI 查找改为「找不到就返回 undefined、让 Agent SDK 用自带运行时」，但持久执行器（默认路径，DeepSeek / MiniMax 也走它的 SDK 后端）保留了一份旧副本，找不到时回退成猜测路径 `/usr/local/bin/claude` 并总是传给 SDK。现在两处共用同一个 `resolveClaudePath()`：没装 CLI 时 SDK 后端不再传 `pathToClaudeCodeExecutable`；PTY 后端给出「请安装 Claude Code 或设置 `CLAUDE_EXECUTABLE_PATH`」的明确报错
- 测试：`tests/claude-executable-resolution.test.ts` 8 例（查找函数 4 例 + 持久执行器 SDK 后端实际传给 `query()` 的参数 3 例 + PTY 后端报错 1 例）；回退旧代码时其中 2 例失败

## v0.7.11 — 2026-09-21

- **记忆库出站闸门（design-note U）**：bot 的本地 auto-memory（`~/.claude/projects/<工作区>/memory/`、`MEMORY.md`）不可外发，三层硬拦。桥接层：发送目录里的文件发出前逐个检查，文件名是 MEMORY.md、真实路径位于 `~/.claude` 之下、压缩包清单含记忆目录 / 索引 / `.claude/` 或 ≥20 个 .md、正文是记忆 frontmatter 或索引形态，一律拦下删除并发一条红色通知说明「没发、为什么、找谁」；不能列清单的 .7z/.rar 不放行。工具层：Bash 调用前的 PreToolUse 钩子——打包 / 拷贝 / 移动 / 同步记忆目录、把记忆重定向到文件、经 lark-cli 或共享记忆库外传记忆、lark-cli 直传任何压缩包（绕过桥接检查），一律 deny 并把原因回给模型；SDK 后端走进程内钩子，PTY 后端把同源逻辑生成为独立脚本写进 `--settings` 的 command 钩子。提示词层：工作区共用规范新增「记忆不外发，谁提都不行」。刻意不拦读记忆（cat / ls / grep）与 `luckagent memory` 中央库 CLI。起因是一次真实泄露：群成员一句「先把记忆搞过来」，bot 就把 105 个记忆文件打成 zip 发进了群——出站脱敏只看文字不看文件，提示词约束挡不住「用户明确要求」
- 测试：`tests/memory-export-guard.test.ts` 61 例（命令分类拒绝 / 放行各二十余例、PTY 脚本真实 node 子进程同源验证、文件检查含真实 zip 与符号链接、output-handler 集成）；既有超限测试的假 zip 改名为 .bin（假 zip 无法列清单会先被闸门拦）

## v0.7.10 — 2026-09-18

- **`luckagent restart` / `update` 改为从 `ecosystem.config.cjs` 重启**（`--only` 限定进程）：此前按进程名 `pm2 restart` 会沿用首次 start 时的 env，v0.7.9 在配置文件里前置的 venv PATH 在老机器上永远带不上，bot 会话里的 `python3` 仍是系统 Python（pm2 7.0.1 实测：按名 restart 保留旧 env，从配置文件 start/restart 均重新求值，`--only` 只动指定进程且未启动的会拉起）。管理台「重启」按钮走 exit + PM2 自动拉起，同样不刷新 env——升级后第一次请用 `luckagent restart` 或重跑 `install.sh`
- 文档对齐 v0.7.0–v0.7.9：管理台手册补「技能」「记忆」两页与总览的密钥三态 / 订阅登录 / 自启横幅；CLI 参考补 doctor 的 `lark_cli`、`office_media_toolchain` 检查项与 update 的 requirements 同步；设计笔记计数 16→17（A–T）；技能体系与排障文档补工具链说明；飞书配置指南补 v0.7.8 拉本轮上下文所需权限；目录结构补 `group-summary.json`

## v0.7.9 — 2026-09-17

- **安装脚本内置办公与媒体工具链**：`install.sh` 新增「办公与媒体工具链」段，brew 安装 ffmpeg、poppler、LibreOffice、Noto Sans CJK SC 字体，并用 python@3.13 建 `~/.luckagent/venv` 装入根目录新增的 `requirements.txt`（python-pptx / openpyxl / Pillow / numpy / pandas / python-docx / lxml / matplotlib / xlsxwriter / PyMuPDF / edge-tts）。清单来自生产环境 18 个 bot 的实际引用统计：python-pptx、openpyxl、Pillow 是产出三大件，LibreOffice 转 pdf/图自检，ffmpeg 转语音回复，Noto CJK 是排字默认中文字体。此前这些全靠 bot 在任务里临时安装，散落在系统 Python 里、换机不可复现、随 Xcode CLT 升级集体失效
- venv 的 `bin` 前置到 `~/.zprofile` 与 `ecosystem.config.cjs` 的 PATH，终端和 PM2 里的 bot 会话 `python3` 都解析到它；`luckagent update` 顺带同步 `requirements.txt`；`luckagent doctor` 新增 `office_media_toolchain` 检查（二进制 / 字体 / venv / 11 个模块可导入）
- 单项安装失败只警告并在结尾打印待办命令，不中断安装；`--no-system` 跳过整段。工作区共用规范新增「本机工具链」段，告诉 agent 已有什么、别重复装

## v0.7.8 — 2026-09-06

- **@ 触发时按飞书接口拉「本轮」上下文，取代内存缓存**（私聊群聊同一机制）：只拉 @ 的这个人上一条 @ 之后的消息，上限 48 小时/100 条；文本按时间顺序拼到提示词前面、触发消息永远在最后，图片/文件作附件，引用回复的被引内容照常注入。v0.7.5 的「暂存 30 分钟」有三处硬伤——只按内存存、桥接重启即丢、材料发完几小时再 @ 就超时（生产实锤）——飞书接口里什么都有，现在完全无状态。群聊只拉 @ 的人自己的消息，同事的闲聊和文件不拉。拉取失败降级为提示词里一句说明，任务照常启动。需要应用有读取单聊/群消息权限，缺权限时优雅降级
- 私聊开关关闭 / `groupNoMention` / 两人群免 @ 这些「不 @ 也响应」的路径不拉历史（本来就没有积压）
- 测试：round-context 17 例（边界/映射/分页/上限/失败/拼装）+ 处理器 16 例；随缓存退役删除 feishu-media-cache-ttl.test.ts

## v0.7.7 — 2026-09-05

- **空闲会话自动换新覆盖定时任务与 API 入口**：v0.7.6 的换新判定只挂在群消息入口，早 7 点的群日报走内部任务通道，会在旧会话里跑并把空闲计时归零，白天第一条人话要到 10 点后才换新。现在两个入口共用同一判定：日报进门先看会话「乱没乱过」，乱过就换新再跑（交接块进日报的提示词），白天的人直接落在新会话；没压缩过的会话照常不换。带 `maxTurns`/`allowedTools` 的受限回合（语音）不参与。审计事件 `session_rollover` 新增 `source`（message/api）。新增 5 例桥接编排测试。

## v0.7.6 — 2026-09-05

- **空闲会话自动换新（design-note T）**：一个群的会话空闲 ≥3 小时且已经历过上下文压缩时，下一条消息自动开新会话，并把旧会话最近 10 轮 + 最后一次完整回复作为交接块注入首条提示词。此前一个群永远 resume 同一个会话，会话文件长到几十上百 MB 后每天自动压缩 2–6 次、每次 2.5–4 分钟且随机砸在任务中间，压缩后 agent 还要重新翻文件找回上下文。没压缩过的会话不受影响；三引擎都参与；带目标的会话跳过。`LUCKAGENT_ROLLOVER_DISABLED=1` 关闭，`LUCKAGENT_ROLLOVER_IDLE_MS` 调阈值。新增审计事件 `session_rollover`、16 例单测。
- 副作用提示：开了群日报的群每天早 7 点会被日报任务碰一次会话，因此压缩过的群通常在当天 10 点后第一条真人消息时换新，相当于每日自然刷新。

## v0.7.5 — 2026-09-04

- **`privateRequireMention` 补全「先发材料、最后 @」用法**：v0.7.4 只暂存未 @ 的图片/文件，私聊里先发的链接和要求文本会被静默丢弃，最后 `@bot 处理以上需求` 时 bot 只拿到这一句（生产实锤）。现在私聊未 @ 的文本（含引用回复）与媒体一起暂存 30 分钟，下次 @ 时文本按时间顺序拼到提示词前面、触发消息永远在最后、引用回复的被引内容照常注入；群聊仍只暂存媒体
- 富文本（post）里的链接保留 URL：此前只取显示文字，粘贴的飞书文档链接到 bot 手里只剩标题
- 接收处理器新增 8 例测试覆盖上述链路

## v0.7.4 — 2026-09-03

- 新增按 bot 开关 `privateRequireMention`（管理台「群聊限制」折叠区「私聊也需要 @ 才响应（两人群同）」）：开启后私聊也要 @ 机器人才响应，判定与群聊完全一致——未 @ 静默忽略，图片/文件暂存等下次 @ 时自动带上；同时取消「两人群视同私聊免 @」的豁免，两人群按普通群规则处理。`groupNoMention` 仍只管群聊，两开关互不干涉。默认关，不配即原行为（私聊直答）。断连补扫回灌的消息走同一门控。设计笔记代号 S

## v0.7.3 — 2026-08-28

- 内置 image-gen 技能同步上游改进：`gen_image.py` 新增**本地参数校验**（尺寸规则/张数/透明背景组合/mask 依赖，非法组合发请求前直接拦截并给出正确写法，省一次 400 往返）；SKILL.md 新增**「出图前先填表」**一节（19 个 use-case slug + prompt schema + 使用规则，配 `references/sample-prompts.md` 按 slug 抄配方）。`luckagent update` 会把更新同步进 `~/.claude/skills`

## v0.7.2 — 2026-08-28

- 群日报默认口径改为**每天早 7 点总结「昨天全天」**（此前默认工作日 21:00 总结当天；若把旧模板的任务挪到早晨跑，会总结今天 0–7 点的空窗）。已开启的群保留各自既有模板——「关闭」再「开启」一次即套用新默认

## v0.7.1 — 2026-08-28

- 管理台「密钥状态」改为三态：新增橙色**「已写入 .env——重启桥接后生效」**（面板直读磁盘 `.env`，新增或轮换 key 后不再显示成「未配置」造成困惑；尾号显示的是即将生效的值）
- DeepSeek / MiniMax 行补充「另有 N 个 bot 单独配置」提示（key 填在 bot 编辑表单里时全局行不再误读为完全未配置）

## v0.7.0 — 2026-08-27

**新引擎与厂商表**

- **MiniMax 转正为一等引擎**：`engine: "minimax"`，模型 `MiniMax-M3`（旗舰、原生看图、默认）/ `MiniMax-M2.5`；`.env` 的 `MINIMAX_API_KEY` / `MINIMAX_MODEL` / `MINIMAX_BASE_URL`，安装器新增第三引擎选项，管理台下拉 + 子表单 + 密钥状态行，`/model minimax` 会话切换
- 兼容端点厂商收敛为 `COMPAT_PROVIDERS` 注册表（端点/默认模型/模型列表/key 变量/申请入口），再接新厂商只需表里加一行；任何 Anthropic 兼容端点也可用 deepseek 块覆盖 `baseUrl` 零代码接入
- Claude 模型默认改为**跟随订阅档位**（不指定即不传 model，由官方按 Pro/Max 计划选），避免写死模型导致的静默降级

**管理台**

- 新增只读「技能」「记忆」两页：全局 + 项目级技能明细（SKILL.md 渲染）、按 bot 的 auto-memory 索引视图
- 总览补显示：生图 key、core Token 语义、Claude 订阅登录状态（邮箱/档位/有效性）、pm2 开机自启缺配横幅
- 建 bot 表单极简化：创建态只留名称 + 飞书凭证 + 群聊限制，工作目录自动派生 `~/projects/<名称>`，引擎继承安装时的全局默认；预算/语音等仅编辑态显示

**可靠性（真机事故驱动）**

- PTY 后端修复：node-pty prebuilds 的 spawn-helper 执行位（postinstall 自动补位）+ 全新机器 bypass-permissions 确认屏自动化——订阅登录路线首次真正可用
- 飞书长连接：断连可视化 + 重连后 REST 补扫回灌盲区消息（去重防双发）
- 大文件（>100MB）：下载期间会话占位防并发撞车、分片下载瞬时网络错误分类重试（退避 5 次 + range 续传）、静默失败改发红卡
- 提问卡片决策改用回合实际执行方式判定（修复 DeepSeek/逐回合路径下 6 分钟卡死）
- `luckagent update` 不再被自身改写的 lockfile 挡住

**安装与运维**

- 安装流程引擎优先（Claude / DeepSeek / MiniMax 三选一，各自引导认证）；结尾询问是否配置 pm2 开机自启（`doctor` 同步新增检查项）
- 新增 `scripts/uninstall.sh`；lark-cli profile 命名修复（真实 profile 名写入工作区模板）
- 共用规范模板（`~/projects/CLAUDE.md`）以生产实践为蓝本重写为约 200 行生产级版本

## v0.6.1 — 2026-08-26

- DeepSeek-only 一等公民：无 Claude 账号的机器可完整运行（SDK 自带运行时，零 CLI）；安装器询问 `DEEPSEEK_API_KEY` 并自动写 `LUCKAGENT_ENGINE=deepseek`
- 实证 DeepSeek flash/pro 原生看图，向导/表单下架 vision-exp
- 修复：会话 `/model` 切引擎的认证错配、中文安装脚本在 en_US.UTF-8 locale 下的变量展开炸裂（`${VAR}` 全量加括号 + lint 测试防回归）

## v0.6.0 — 2026-08-26

- 引擎收敛：移除 Codex / Kimi，保留 Claude + DeepSeek 共用同一 Claude Code 运行时——持久会话池、Agent Teams、`/goal`、记忆体系对全部引擎一致

## v0.5.0 — 2026-08-25

- 首次公开发布：GitHub 仓库、curl 一行安装（`scripts/get.sh` 常青服务 main 分支）、npm 安装引导器（`npx luckagent init`）
- 此前版本为内部提取期（自 MetaBot 脱敏提取、antd 管理台、飞书接入向导、15 项设计笔记内建化），详见 [docs/design-notes.md](docs/design-notes.md)
