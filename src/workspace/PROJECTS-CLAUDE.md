# Luckagent 项目根共用规范

> 本文件由 Luckagent 安装脚本部署到各 bot 工作目录的父目录（如 `~/projects/CLAUDE.md`），
> 对该目录下**所有 bot 工作区**生效。各 bot 自己的 `CLAUDE.md` 只写该 bot 的专属事实，
> 共用规则一律写在这里，不要复制进子目录。

## 文件存放约定（每个 bot 工作区）

| 目录 | 用途 |
| --- | --- |
| `inputs/` | 聊天里收到的文件自动下载到这里（持久保留，任务结束不清理） |
| `work/` | 过程文件、草稿、中间产物 |
| `outputs/` | **归档目录**：定稿产物的留存副本（⚠️ 放这里**不会**自动发群） |

**要把文件发到聊天**：复制到系统提示中给出的「发送暂存目录」（形如
`<tmp>/luckagent-outputs-<用户名>/<chatId>/`）。该目录的语义是**发过即删**——
文件发送成功后会被清掉，所以：先在 `outputs/` 留档，再复制过去发送。
两个目录不要搞混，这是历史上真实出过事故的地方。

## 出站内容纪律

- 发到聊天/文档里的内容**禁止携带本机绝对路径**（`/Users/...`、`/home/...`）。
  引用文件时说文件名或相对含义，不要暴露本机目录结构。
- 密钥、token、`.env` 内容永远不出站。出站前自查一遍。

## lark-cli 身份硬规则（安装了 lark-cli 技能时）

每条 lark-cli 命令**必须**显式带身份：`--profile <本bot的profile> --as bot`。
严禁裸跑（会用错身份操作其他 bot 的应用）。本 bot 的 profile 名见工作区 `CLAUDE.md`。

## 文档权限

用 lark-cli 创建的飞书文档默认只有 bot 自己可见。发给用户前先开权限
（协作者添加或链接分享），否则对方打开是 404。

## Luckagent 能力速查

```bash
luckagent bots                         # 看本机与互联实例的 bot
luckagent talk <bot> <chatId> "<msg>"  # 委托另一个 bot 干活
luckagent schedule cron <bot> <chatId> '<cron>' "<prompt>"   # 定时任务
luckagent memory search <query>        # 搜共享记忆
luckagent memory create "<title>" "<content>"                # 沉淀知识
luckagent skills list | install <name> # 技能中心
luckagent voice tts "文本" --play      # 文本转语音
```

工作循环建议：接到任务 → 不清楚目标就先问 → 干完关键阶段把结论沉淀进
`luckagent memory` → 可复用的方法发布成 skill（写清 when-to-use）→
自己搞不定的部分 `luckagent talk` 委托更合适的 bot。

## 新 bot 工作区模板

新工作区由安装脚本/管理台自动创建 `CLAUDE.md`（含 `AGENTS.md` 镜像）。
把模板里的 `<占位>` 补齐后删除说明段即可。
