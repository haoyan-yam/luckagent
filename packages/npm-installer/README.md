# luckagent

把 Claude Code / DeepSeek / MiniMax 变成飞书里的常驻 AI 同事——自托管的多 bot 平台。

本 npm 包是 **安装引导器**：

```bash
npm install -g luckagent
luckagent init          # 克隆仓库到 ~/luckagent 并运行交互式安装
```

或者免安装一次性执行：

```bash
npx luckagent init
```

安装完成后，`luckagent` 命令自动透传给完整 CLI（`status` / `bots` / `talk` / `schedule` / `doctor` / `update` …）。

- 仅支持 macOS（目标机型 Mac mini / MacBook，Apple Silicon）
- 完整文档、架构说明与飞书接入指南：**https://github.com/haoyan-yam/luckagent**

基于 [MetaBot](https://xvirobotics.com/metabot/) 构建 · MIT License
