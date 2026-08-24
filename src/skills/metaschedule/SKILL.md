---
name: metaschedule
description: "Luckagent's persistent server-side scheduler (cron + one-shot). Optional skill — not installed by default. Use when the user wants tasks that survive Claude session restarts, are visible to other bots, or need to run in Luckagent's PM2 process rather than this Claude session."
---

## Luckagent Scheduler

> Persistent server-side scheduler. Use this when:
> - The schedule needs to outlive the current Claude session.
> - Another bot or operator may need to list, pause, or cancel it.
> - You want it to run inside Luckagent's PM2 process (not Claude's).
>
> For ad-hoc, session-scoped scheduling, prefer the Claude Code native tools `CronCreate` and `/loop` instead — they're faster, in-process, and need no Luckagent server call.

### Quick Commands (luckagent CLI)

The `luckagent` CLI is pre-installed and handles auth automatically.

```bash
# One-time delayed tasks
luckagent schedule list                                       # List all scheduled tasks
luckagent schedule add <bot> <chatId> <delaySec> <prompt>     # Schedule a one-time future task
luckagent schedule cancel <id>                                # Cancel a scheduled task

# Recurring (cron)
luckagent schedule cron <bot> <chatId> '<cronExpr>' <prompt>  # Create recurring task
luckagent schedule pause <id>                                 # Pause a recurring task
luckagent schedule resume <id>                                # Resume a paused recurring task
```

Cron format: `minute hour day month weekday` (5 fields). Examples:
- `0 8 * * *`   → daily at 8am
- `0 8 * * 1-5` → weekdays at 8am
- `*/30 * * * *`→ every 30 minutes
Default timezone: Asia/Shanghai.

### API Reference

Auth header: `-H "Authorization: Bearer $LUCKAGENT_API_SECRET"`
Base URL: !`echo http://localhost:${LUCKAGENT_API_PORT:-9100}`

**Create one-time scheduled task:**
```bash
curl -s -X POST http://localhost:${LUCKAGENT_API_PORT:-9100}/api/schedule \
  -H "Authorization: Bearer $LUCKAGENT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"botName":"<bot>","chatId":"<chatId>","prompt":"<task>","delaySeconds":3600,"label":"Reminder"}'
```

**Create recurring task (cron):**
```bash
curl -s -X POST http://localhost:${LUCKAGENT_API_PORT:-9100}/api/schedule \
  -H "Authorization: Bearer $LUCKAGENT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"botName":"<bot>","chatId":"<chatId>","prompt":"<task>","cronExpr":"0 8 * * 1-5","timezone":"Asia/Shanghai","label":"Daily report"}'
```

**Update task (prompt, delay, or cron):**
```bash
curl -s -X PATCH http://localhost:${LUCKAGENT_API_PORT:-9100}/api/schedule/<id> \
  -H "Authorization: Bearer $LUCKAGENT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"updated prompt","delaySeconds":7200}'

curl -s -X PATCH http://localhost:${LUCKAGENT_API_PORT:-9100}/api/schedule/<id> \
  -H "Authorization: Bearer $LUCKAGENT_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"cronExpr":"0 9 * * *","prompt":"Updated prompt","timezone":"Asia/Shanghai"}'
```

**Pause / resume recurring task:**
```bash
curl -s -X POST http://localhost:${LUCKAGENT_API_PORT:-9100}/api/schedule/<id>/pause \
  -H "Authorization: Bearer $LUCKAGENT_API_SECRET"
curl -s -X POST http://localhost:${LUCKAGENT_API_PORT:-9100}/api/schedule/<id>/resume \
  -H "Authorization: Bearer $LUCKAGENT_API_SECRET"
```

**Cancel:**
```bash
curl -s -X DELETE http://localhost:${LUCKAGENT_API_PORT:-9100}/api/schedule/<id> \
  -H "Authorization: Bearer $LUCKAGENT_API_SECRET"
```

### Installation (opt-in)

This skill is not installed by default. To enable it for one bot, copy it into the bot's working directory:

```bash
mkdir -p <bot-work-dir>/.claude/skills/metaschedule
cp $LUCKAGENT_HOME/src/skills/metaschedule/SKILL.md <bot-work-dir>/.claude/skills/metaschedule/SKILL.md
# Mirror for Codex bots:
mkdir -p <bot-work-dir>/.codex/skills/metaschedule
cp $LUCKAGENT_HOME/src/skills/metaschedule/SKILL.md <bot-work-dir>/.codex/skills/metaschedule/SKILL.md
```

Or install globally so every Claude session picks it up:

```bash
mkdir -p ~/.claude/skills/metaschedule
cp $LUCKAGENT_HOME/src/skills/metaschedule/SKILL.md ~/.claude/skills/metaschedule/SKILL.md
```
