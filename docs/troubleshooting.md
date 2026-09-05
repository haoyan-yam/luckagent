# 常见问题排查

遇事先跑一条命令：

```bash
luckagent doctor --json
```

它会逐项检查安装目录、PM2 进程、桥接健康、core 服务、bots.json、语音与引擎配置，每个失败项都带修复建议。下面按症状分条。

## 端口被占（EADDRINUSE / 起不来）

```bash
lsof -i :9100    # 谁占了桥接端口
lsof -i :9200    # 谁占了 core 端口
```

- 占用者是**残留的旧进程**：`pm2 ls` 看一眼，`pm2 delete <name>` 清掉再 `luckagent start`；
- 确实撞了别的服务：改 `.env` 里的 `API_PORT`（桥接），core 端口在 `ecosystem.config.cjs` 的 `LUCKAGENT_CORE_PORT` 环境变量里改，改完 `luckagent restart --all`。CLI 会自动跟着 `.env` 的端口走。

## 手工跑脚本触发飞书 API 循环重定向（代理变量坑）⚠️

**真实踩坑**：shell 里若导出了 `HTTPS_PROXY` / `HTTP_PROXY`（常见于本机开着代理客户端的场景），代理可能把发往 `open.feishu.cn` 的请求兜进**循环重定向**，表现为手工跑的脚本调飞书接口一直 30x / 超时，而桥接进程本身（由 PM2 启动、不继承你终端的代理变量）一切正常。

**处置**：凡是**手工在终端里跑**、会触碰飞书 API 的脚本或命令，先清掉代理变量：

```bash
env -u HTTPS_PROXY -u HTTP_PROXY node your-script.js
# 或本条 shell 里
unset HTTPS_PROXY HTTP_PROXY
```

**长期方案**：真需要代理时在 `.env` 里配置 `HTTP_PROXY` / `HTTPS_PROXY`，并用 `NO_PROXY` 把不该走代理的域名放行（支持精确域名、`.example.com` 后缀与 `*` 通配），例如：

```bash
NO_PROXY=open.feishu.cn,localhost,127.0.0.1
```

## `luckagent: command not found`

CLI 装在 `~/.local/bin/luckagent`，你的 PATH 里没有它。加进 shell 配置：

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # bash 用 ~/.bashrc
source ~/.zshrc
```

临时救急也可以直接跑 `~/luckagent/bin/luckagent …`。

## 开机自启（重启机器后进程没了）

PM2 需要注册系统级开机自启（macOS 上是 launchd，Linux 上是 systemd）：

```bash
pm2 startup          # 按它打印的提示执行一次（可能要 sudo）
luckagent start      # 起两个进程
pm2 save             # 固化当前进程列表（luckagent start/update 也会自动 save）
```

之后重启机器，PM2 会自动拉起 luckagent-bridge 与 luckagent-core。

## 机器人不回话/启动失败

按命中率排序自查：

1. **飞书应用没发布版本**——凭证有效、连接正常，但没发版对成员就不可用。去开放平台「版本管理与发布」补发。
2. **长连接事件没配好**——「事件与回调」里必须选「使用长连接接收事件」并订阅 `im.message.receive_v1`；注意**保存时桥接必须在线**（飞书会实时验证 WebSocket）。
3. **凭证错**——管理台「机器人管理 → 测试连接」实时验证 App ID/Secret。
4. **权限没开通**——至少要有 `im:message`、`im:message:readonly`、`im:resource`、`im:chat:readonly`，加完权限要重新发版。清单见[飞书应用配置](feishu-app-setup.md#第四步配置权限)。
5. **改了配置没重启**——`bots.json` 的任何增删改都需要 `luckagent restart` 生效，管理台会亮「配置已变更」提示。
6. **bots.json 语法错 / 工作目录不存在**——`luckagent doctor` 的 `bots_config` 检查项会指出来。
7. **没 @ 机器人**——默认群聊需要 @ 才响应（除非该 bot 配了 `groupNoMention: true`）；配了 `privateRequireMention: true` 的 bot 连私聊和两人群也要 @（不 @ 静默不回，飞书私聊输入 @ 能选到机器人；私聊里不 @ 发的链接/要求/文件不会丢，下一次 @ 时按飞书接口拉本轮消息一起带上，48 小时内有效；群聊同理但只拉 @ 的那个人自己发的）；配了 `groupOnly` 的 bot 私聊只理白名单。
8. **Claude 引擎认证**——`.env` 里配 `ANTHROPIC_API_KEY`，或设 `CLAUDE_EXECUTABLE_PATH` 指向一个已登录的 Claude Code CLI 复用订阅。

以上都对还不行，看日志找具体报错（下一条）。

## 日志在哪看

```bash
luckagent logs            # bridge 实时日志
luckagent logs --core     # core 实时日志
luckagent logs -n 200     # 先回放最近 200 行
```

文件位置：`<安装目录>/logs/{out,error,core-out,core-error}.log`。管理台「运行日志」页可在浏览器 tail bridge 的两个文件。

## 管理台打不开或登录失败

| 症状 | 原因与处置 |
| --- | --- |
| 连不上 / 拒绝连接 | 桥接没在跑：`luckagent status` 看进程，`luckagent start` 拉起 |
| 打开了但登录报 401 | 口令错：登录用的是 `.env` 里的 `API_SECRET` 原文 |
| 一直 429 | 触发限流：鉴权连续失败超过 10 次会锁定约 1 分钟，稍等重试（别用脚本爆破自己）；点重启后 30 秒内再点也会 429，属防抖 |
| 本机能开、远程打不开 | 默认只绑 `127.0.0.1`，这是特性不是 bug。远程访问用 `ssh -L 9100:127.0.0.1:9100 you@server` 端口转发；真要暴露公网请读[安全说明](admin-console.md#安全说明) |
| 页面开了但数据全空 | 浏览器里存的口令过期/错误，登出重登；或看 `/api/health` 是否正常 |

## npm 装依赖报 EACCES（缓存被 sudo 污染）

曾经用 `sudo npm …` 跑过命令的机器，`~/.npm` 缓存里会留下 root 属主的文件，之后普通用户 `npm install` 报 `EACCES: permission denied`。修复：

```bash
sudo chown -R "$(whoami)" ~/.npm
```

然后重跑 `npm install`（或 `luckagent update`）。原则：**不要用 sudo 跑 npm/安装脚本**，Luckagent 全套都装在用户目录，不需要 root。

## `luckagent update` 失败

- `git pull --ff-only` 拒绝合并：本地改过源码导致无法快进。先 `git stash`（或提交到自己的分支）再 update；
- 安装目录不是 git 检出（get.sh 在无 git 机器上的 tarball 下载模式）：update 的拉码步骤不可用，改用 `curl -fsSL https://codeload.github.com/haoyan-yam/luckagent/tar.gz/refs/heads/main | tar -xz --strip-components=1 -C ~/luckagent` 覆盖最新代码后重跑 `bash install.sh`（幂等，含依赖/构建/重启）。

## 还没解决？

- 翻[设计笔记](design-notes.md)确认你遇到的是不是「特性」（比如发送暂存目录里文件消失＝已发送成功）；
- 带着 `luckagent doctor --json` 的输出与 `logs/error.log` 的相关片段提 issue。
