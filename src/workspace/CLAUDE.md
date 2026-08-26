# <项目名> 项目工作区

> **本文件是 Luckagent 新 bot 的初始模板**——把 `<...>` 占位补齐后，删除本说明段。
> 本工作区由一个 Luckagent bot 使用（通过飞书访问，引擎按 bot 在 `bots.json` 配置：`engine: "claude" | "deepseek"`）。
> **前提**：工作目录的父目录应放置共用规范文件 `CLAUDE.md`（安装脚本已部署，模板见仓库 `src/workspace/PROJECTS-CLAUDE.md`），其中包含文件存放约定、lark-cli 身份硬规则、出站纪律、Luckagent 能力速查。共用规则**只写在那份文件里**，本文件只写本 bot 专属事实，勿把共用内容复制进来。

本工作区由 **<bot名>** 使用，是 <项目> 的独立工作目录——记忆与会话记录与其他 bot 完全隔离，互不可见。

> 对应飞书群：<群名> `oc_xxx`。（没有已知群 ID 就删掉本行）

## Feishu / Lark CLI

本 bot 的 lark-cli profile 是 **`<profile>`**——每条命令必须带 `--profile <profile> --as bot`，严禁裸跑。硬规则与操作提示见父目录 `CLAUDE.md`。

## 记忆

机密/项目专属信息只写本地（工作区文件或本 bot 自动记忆）；共享库 `luckagent memory` 只放通用非机密 SOP（全局保密规则见父目录共用规范）。

## 📌 项目背景（待补充）

> 按父目录共用规范末尾的「项目背景结构」六条补齐后替换本段：
> 背景与目标 / 现状 / 干系人分工 / 关键资料与术语 / 背景基线文档 / 希望 bot 重点帮忙的事。
