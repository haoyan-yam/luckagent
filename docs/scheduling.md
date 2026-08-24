# 定时任务

桥接进程内置任务调度器（TaskScheduler）：到点把一段提示词投喂给指定 bot 的指定会话，效果等同你在那个群里 @机器人说了这句话。支持一次性延迟任务与 cron 周期任务。

## 三种入口

同一套调度器，三个入口任选：

### 1. CLI

```bash
luckagent schedule list                                      # 列出全部任务
luckagent schedule add  <bot> <chatId> <延迟秒数> <提示词>     # 一次性任务
luckagent schedule cron <bot> <chatId> '<cron表达式>' <提示词> # 周期任务
luckagent schedule pause  <id>                               # 暂停周期任务
luckagent schedule resume <id>                               # 恢复周期任务
luckagent schedule cancel <id>                               # 取消任务（两种类型都可）
```

### 2. 管理台

「定时任务」页（`http://localhost:9100/admin`）：新建（周期 cron / 一次性延迟二选一）、暂停、恢复、取消，表格里直接看 cron 表达式、下次触发时间与状态。见[管理台使用手册](admin-console.md#定时任务)。

### 3. HTTP API

`:9100`，Bearer 鉴权（`API_SECRET`）：

```bash
# 创建周期任务
curl -s -X POST http://localhost:9100/api/schedule \
  -H "Authorization: Bearer $API_SECRET" -H "Content-Type: application/json" \
  -d '{"botName":"mybot","chatId":"oc_xxx","cronExpr":"0 9 * * 1-5","prompt":"汇总收件箱","label":"晨报","timezone":"Asia/Shanghai"}'

# 创建一次性任务（delaySeconds 二选一，与 cronExpr 互斥）
curl -s -X POST http://localhost:9100/api/schedule \
  -H "Authorization: Bearer $API_SECRET" -H "Content-Type: application/json" \
  -d '{"botName":"mybot","chatId":"oc_xxx","delaySeconds":3600,"prompt":"检查部署状态"}'

GET    /api/schedule              # 列表（tasks + recurringTasks）
PATCH  /api/schedule/:id          # 改 prompt / cronExpr / timezone / label / sendCards / delaySeconds
POST   /api/schedule/:id/pause    # 暂停（仅周期任务）
POST   /api/schedule/:id/resume   # 恢复（仅周期任务）
DELETE /api/schedule/:id          # 取消
```

可选字段：`label`（人类可读名字，列表里好认）、`sendCards`（是否把执行过程以卡片发到群里，默认发）。

## cron 表达式与时区

标准五段 cron：`分 时 日 月 周`。

| 表达式 | 含义 |
| --- | --- |
| `0 9 * * 1-5` | 每个工作日 9:00 |
| `*/30 * * * *` | 每 30 分钟 |
| `0 18 * * 5` | 每周五 18:00 |
| `0 0 1 * *` | 每月 1 号 0:00 |

时区解析顺序：任务自带的 `timezone` 字段 → 环境变量 `SCHEDULE_TIMEZONE`（`.env` 里配，IANA 格式）→ 默认 `Asia/Shanghai`。跨时区部署务必显式配置，否则「9 点的晨报」可能在你意想不到的 9 点触发。

## 一次性 vs 周期

| | 一次性 | 周期 |
| --- | --- | --- |
| 创建方式 | `delaySeconds`（正整数秒） | `cronExpr` |
| 触发后 | 执行一次即完成 | 按 cron 计算下次触发，无限循环 |
| 可暂停/恢复 | 否（只能取消） | 是 |
| 典型用途 | 「一小时后提醒我」「明早跑一次」 | 晨报、巡检、周报 |

## 持久化与恢复

任务持久化在 `~/.luckagent/scheduled-tasks.json`（`SESSION_STORE_DIR` 可改路径）。桥接重启后自动恢复：周期任务重新按 cron 排期；一次性任务若错过了触发时间，恢复逻辑以文件里的记录为准。`luckagent restart` / 管理台重启不会丢任务。

## 示例：每个工作日 9 点让 bot 汇总收件箱

```bash
# 1. 拿到目标群的 chatId（群里发条消息看卡片、或从飞书开放平台/日志里取，形如 oc_xxx）
# 2. 建任务
luckagent schedule cron mybot oc_xxx '0 9 * * 1-5' \
  '汇总我收件箱里昨天以来的未读邮件，按重要性排序，给出需要今天回复的清单'

# 3. 确认
luckagent schedule list
# → 能看到 nextExecuteAt 是下一个工作日的 09:00（按配置的时区）
```

到点后，bot 会在 `oc_xxx` 这个群里像收到用户消息一样开始干活并回贴卡片。

> 想让 bot 在**执行任务的过程中**自己给自己排任务（例如「跑完这批后 2 小时再检查一次」），agent 可以直接调 `luckagent schedule add ...`——CLI 在每个工作区都可用。

## 相关文档

- [CLI 参考](cli-reference.md) —— schedule 子命令完整参数
- [管理台使用手册](admin-console.md#定时任务) —— 页面操作
