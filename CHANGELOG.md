# 更新日志

版本号 = 根 `package.json`（管理台总览页显示的就是它）。升级：`luckagent update`（git 安装）或重跑一行安装命令（tarball 安装）。git tag 与本文件同步打点。

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
