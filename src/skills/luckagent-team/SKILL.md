---
name: luckagent-team
description: "Use when coordinating or working inside a Luckagent Agent Team via `luckagent teams`: create/list teams, spawn teammates, exchange messages, manage shared tasks, inspect runs, and report status to the lead."
---

# Luckagent Agent Team

Luckagent Agent Teams mirror the compact Claude Agent Teams workflow, but the
coordination model is Luckagent-native and engine-neutral. Teammates may be
declared as Claude, Codex, Kimi, or future engines, but execution still goes
through the current bridge/session-engine path. Do not assume every engine can
handle every workflow until runtime capability validation or per-engine
adapters are added.

## Core Model

Team = Agents + Messages + Tasks + Runs.

Use the CLI for all team coordination. Plain chat output is not visible to
teammates unless you send it through the team mailbox.

## Lead Workflow

```bash
luckagent teams create <team> --description "..."
luckagent teams agents spawn <team> <name> --role <role> --prompt "..."  # engine defaults to codex
luckagent teams dispatch <team> <name> "<subject>" --description "..." --plain
luckagent teams next <team> <name> --summary
luckagent teams runs list <team>
luckagent teams status <team> --summary
```

Lead rules:
- Keep the team task list current.
- Prefer `luckagent teams dispatch` over separate `tasks create` + `tasks update --owner` + `send`; it creates the task, assigns the owner, and wakes the teammate in one command.
- Use `agents spawn` without `--engine` for Codex teammates. Pass `--engine claude|kimi` only when a teammate specifically needs another engine.
- Use `next` to inspect a teammate's unread messages and open assigned tasks before deciding whether to send more work.
- Integrate completed work before reporting to the user.
- Stop or delete the team when the work is done.

## Teammate Workflow

```bash
luckagent teams next <team> <your-name> --read
luckagent teams tasks get <team> <taskId>
luckagent teams tasks claim <team> <taskId> <your-name>
luckagent teams tasks done <team> <taskId> "..."
luckagent teams tasks block <team> <taskId> "blocked reason" --blocked-by <id,id>
luckagent teams runs list <team>
luckagent teams send <team> lead "Completed task <taskId>: ..."
```

Teammate rules:
- Claim a task before working on it.
- Prefer available tasks in ID order.
- Mark a task completed only after the requested verification is done.
- If blocked, use `tasks block` and message the lead with the concrete blocker.
- After completing a task, check the task list again.

## Smooth CLI Shortcuts

Lead handoff:

```bash
luckagent teams dispatch luckagent-core-chat bridge-runtime "Review agent bus relay" \
  --description "Read-only. Report exact files and risks." \
  --plain
```

This is equivalent to creating a task, assigning it, and sending a start
message. It returns both the task and the message ids.

Teammate loop:

```bash
luckagent teams next luckagent-core-chat bridge-runtime --read
luckagent teams status luckagent-core-chat --summary
luckagent teams tasks claim luckagent-core-chat 18 bridge-runtime
luckagent teams tasks done luckagent-core-chat 18 "Reviewed, no code edits."
```

For local shell aliases, set `LUCKAGENT_TEAM_AGENT=<name>` and omit the owner in
`tasks claim`.

Use `--summary` or `--plain` on `status`, `next`, `inbox`, `tasks list`,
`runs list`, `dispatch`, and `watch` when a concise text view is easier to scan
than JSON. The default output stays JSON for scripting.

## Parallel Same-Agent Runs

One agent can run multiple assigned tasks concurrently. This is useful for a
single `reviewer` or `verifier` member checking several independent areas in
parallel:

```bash
luckagent teams dispatch luckagent-core-chat reviewer "Verify backend routes" --description "Read-only. Run focused tests." --plain
luckagent teams dispatch luckagent-core-chat reviewer "Verify web UI build" --description "Read-only. Check UI build and risks." --plain
luckagent teams dispatch luckagent-core-chat reviewer "Verify package install" --description "Read-only. Inspect latest.tgz contents." --plain
luckagent teams status luckagent-core-chat --summary
```

Supervisor behavior:
- Pending tasks for the same agent are split into separate runs.
- Default max parallelism per agent is `4`.
- Override with `LUCKAGENT_AGENT_TEAM_MAX_PARALLEL_PER_AGENT=<n>`.
- Parallel runs use isolated run-scoped chats like
  `team:<team>:<agent>:<runId>` so one Codex session does not bleed into
  another. Single non-parallel runs keep the stable `team:<team>:<agent>` chat.
- The agent remains `working` until all its running tasks finish.

## Runs

Runs are background execution records. The supervisor creates them
automatically when it starts a teammate, but leads and teammates can also use
them for smoke tests or long-running work:

```bash
luckagent teams runs list <team>
luckagent teams runs create <team> [--agent <name>] [--task-id <id>] [--status running|completed|failed|stopped] [--output <text>] [--error <text>]
luckagent teams runs update <team> <runId> [--status running|completed|failed|stopped] [--output <text>] [--error <text>]
luckagent teams runs output <team> <runId>
luckagent teams runs stop <team> <runId>
```

Run statuses: `running`, `completed`, `failed`, `stopped`.

Stop semantics: `luckagent teams runs stop` marks the stored run as `stopped`.
When the supervisor owns the in-flight run, it also asks the bridge to stop the
teammate chat task, requeues assigned in-progress tasks to `pending` with a
stop note, and suppresses late executor output so delayed success cannot
overwrite the stopped run.

Failed-run rules:
- If a manual run fails, update it with `--status failed --error "<reason>"`.
- Inspect failure details with `luckagent teams runs output <team> <runId>`.
- The supervisor marks failed or crashed executions as `failed`, records the
  error, requeues assigned in-progress tasks to `pending` with failure context
  in `result`, returns the agent to idle, and sends a failure message to
  `lead` for non-lead teammates.
- Do not manually mark a requeued task completed just because a failed run
  produced partial output; let the supervisor retry it or ask the lead whether
  to reassign/stop it.

## Supervisor Behavior

The bridge supervisor scans active teams for agents with unread messages or
assigned pending tasks. It creates one run per ready task, marks the agent
working, runs that agent in either `team:<team>:<agent>` or isolated
`team:<team>:<agent>:<runId>` chats for parallel same-agent work, records output
or error, then returns the agent to idle once no running runs remain. Non-lead
teammates send a completion or failure message to `lead`.

Operational knobs:
- `LUCKAGENT_AGENT_TEAM_SUPERVISOR=0` disables the loop.
- `LUCKAGENT_AGENT_TEAM_SUPERVISOR_INTERVAL_MS` changes the polling interval.
- `LUCKAGENT_AGENT_TEAM_MAX_PARALLEL_PER_AGENT` caps concurrent runs for one
  agent. Default: `4`.
- The supervisor sets the configured session engine for the teammate chat, but
  currently does not validate engine capabilities before dispatch.
- New CLI-spawned teammates default to `codex`; resident teams should still set
  `engine: "codex"` explicitly for reproducibility.

## Card Display

Feishu cards use the team store snapshot:
- Team panel: agents, working/idle state, and visible tasks.
- Background activity panel: runs, status, latest output, or latest error.
- Deleted tasks are hidden from cards.
- Cards are chat-scoped: teams display only when the current chat matches
  `displayChatIds` or `chatIds`; active teams are not displayed globally.

## Resident `bots.json` Teams

For persistent teams, configure `agentTeams` in `bots.json`. The bridge
reconciles these teams at startup and hot-reloads them unless
`LUCKAGENT_AGENT_TEAMS_HOT_RELOAD=0` is set.

```json
{
  "agentTeams": [
    {
      "name": "luckagent-dev",
      "description": "Luckagent implementation team",
      "status": "active",
      "chatIds": ["team:luckagent-dev:cli-engineer", "team:luckagent-dev:runtime-engineer"],
      "displayChatIds": ["oc_feishu_chat_id"],
      "agents": [
        { "name": "cli-engineer", "role": "implementation", "engine": "codex", "prompt": "Own teams CLI, command UX, tests, and docs." },
        { "name": "runtime-engineer", "role": "runtime", "engine": "codex", "prompt": "Own bridge runtime, store, supervisor, and cards." }
      ],
      "tasks": [
        { "id": 8, "subject": "Document Agent Teams workflow", "owner": "cli-engineer", "status": "pending" }
      ]
    }
  ]
}
```

Use `chatIds` for teammate execution chats like `team:<team>:<agent>`.
Parallel same-agent runs may also use run-scoped execution chats like
`team:<team>:<agent>:<runId>`. Use `displayChatIds` for user-facing Feishu
chats where the Team and Background card sections should appear.

`lead` is not globally reserved. For a top-level team, the current user-facing
bot can be the leader; if no active `lead` member exists, messages sent to
`lead` are surfaced through Agent Activity. Nested/sub-project teams may still
define their own `lead` member, which then runs in `team:<team>:lead`.

Rollout caveat: on existing DBs, the `managed_by_config` column defaults false
when the migration first adds it. Pre-existing resident teams are not eligible
for config-removal stop behavior until they have been reconciled from
`bots.json` once. After deploying this change, restart the bridge or trigger
one hot reload with the desired `agentTeams` still present before relying on
removing a team from config to stop that resident team.

## Minimal Tool Equivalents

| Claude Agent Teams | Luckagent CLI |
| --- | --- |
| TeamCreate | `luckagent teams create` |
| TeamDelete | `luckagent teams delete` |
| Agent | `luckagent teams agents spawn` |
| ListAgents | `luckagent teams agents list` |
| SendMessage | `luckagent teams send` / `luckagent teams inbox` |
| TaskCreate/List/Get/Update | `luckagent teams tasks ...` |
| TaskDispatch | `luckagent teams dispatch` |
| TaskClaim/Done/Block | `luckagent teams tasks claim/done/block` |
| TaskOutput/TaskStop | `luckagent teams runs output/stop` |
