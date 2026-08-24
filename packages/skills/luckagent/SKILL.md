---
name: luckagent
description: "Unified Luckagent CLI — central memory, skills hub, and agent bus (talk to peer bots). Use when reading/writing shared memory, browsing/installing skills, listing or messaging peer bots, or coordinating cross-bot work."
---

## Quickstart

The `luckagent` CLI is the single entry point to the luckagent-core ecosystem. It wraps four surfaces:

```bash
luckagent memory <cmd>   # shared knowledge / notes
luckagent skills <cmd>   # skill registry                (alias: skill)
luckagent agents <cmd>   # peer-bot address book
luckagent inbox  <cmd>   # central inbox for CLI agents (CC / Codex with no bridge)
luckagent teams  <cmd>   # local Agent Teams orchestration
luckagent help           # top-level help (also --help, -h, bare invocation)
```

`luckagent` is the **single** CLI binary. Beyond the luckagent-core surfaces above, it also handles bridge process control (`update`/`start`/`stop`/`restart`/`logs`/`status`) and a bridge daemon API (`bots`/`bot`/`talk`/`schedule`/`voice`/`stats`/`peers`/`metrics`/`health` — see the bridge-local section below). The legacy `mm`, `mh`, and per-bot `bot-skills` surfaces have been removed; `mb` is now a thin deprecation wrapper that forwards to `luckagent`. Switch any script still calling them to the `luckagent <subcommand>` form (see the migration table below).

Auth is automatic: `LUCKAGENT_CORE_TOKEN` (env) or `~/.luckagent-core/token` (first line). Server URL is `LUCKAGENT_CORE_URL`, default `http://localhost:9200` for a locally self-hosted luckagent-core; point it at `https://your-luckagent-host.example.com` if you run luckagent-core on a remote box behind your own reverse proxy.

**Fastest path for a fresh agent**: run luckagent-core locally (or reach your own remote host), then put the API token in `~/.luckagent-core/token` (or export `LUCKAGENT_CORE_TOKEN`) and set `LUCKAGENT_CORE_URL`. No SSO or corporate VPN is required for the personal edition — a single local API token is the only credential. Then `luckagent agents whoami` should echo your identity.

## `luckagent memory` — shared knowledge

Most-used:

```bash
luckagent memory list [folder_id]                      # browse the tree
luckagent memory search "<query>"                      # full-text search
luckagent memory get <id|path>                         # read a doc (JSON metadata + content)
luckagent memory create "<title>" ["<content>"] --share --tags a,b
luckagent memory create "<title>" ["<html>"] --share --html --tags docs
luckagent memory mkdir "<name>"                        # create a folder
luckagent memory update <id> [content] [--title …] [--tags a,b,c] [--share|--no-share]
luckagent memory share <id> [on|off]                   # toggle one doc's cross-bot visibility
luckagent memory visibility [public|private]           # default shared flag for new docs
luckagent memory health
```

(Replaces the former standalone `mm` CLI — same wire calls, same behavior, single binary.)

**Write target — `create` / `mkdir`.** Both accept an explicit `--path </absolute/path>`:

```bash
luckagent memory create "Smoke note" "..." --path /users/<botName>/smoke-note
luckagent memory mkdir "smoke-folder"   --path /users/<botName>/smoke-folder
```

When `--path` is given the server ACL-checks it and auto-creates any missing
ancestor folders. With **neither** `--path` nor `--folder` (nor a `parent_id`
for `mkdir`), the write **defaults into your own namespace** —
`/users/<botName>/<slug-of-title>` for `create`,
`/users/<botName>/<name>` for `mkdir` — resolved via `GET /api/whoami`. This
is the fix for the old member `403 forbidden`: members cannot write the root
namespace, so a bare `create`/`mkdir` previously failed. Admin tokens keep the
legacy root default. `--folder <id>` still targets an explicit existing folder
as before.

**Read visibility is document-level.** A document's cross-bot visibility is
controlled by its `shared` flag, not by the path. Use `--share` when creating
team-visible memory; use `--no-share` for private notes. Tags are for search
and discovery, not ACL, but they should still describe audience and topic:

```bash
luckagent memory create "Runbook" "$CONTENT" --share --tags team,runbook
luckagent memory create "Landing page" "$HTML" --share --html --tags luckagent,tutorial
luckagent memory update <doc_id> --share --tags luckagent,public
luckagent memory share <doc_id> on
```

**Per-bot default visibility — `memoryPublic`.** Bots can flip the default
`shared` value for new documents without admin intervention. `public` means
new docs default to `shared:true`; `private` means new docs default to
`shared:false`. Explicit `--share` / `--no-share` on create/update always wins.
Default for newly-registered bots is **public** (`memoryPublic: true`):

```bash
luckagent memory visibility            # prints {state: "public" | "private"}
luckagent memory visibility public     # new docs default shared:true
luckagent memory visibility private    # new docs default shared:false
```

Same shape and auth model as `bots.json` `visible` for agent-bus discovery
("bot self-toggles, owner credential or admin only" — PATCH
`/api/agents/<botName>/memory-visibility`). It only changes the default
`shared` value for *new* documents; existing docs are unchanged until you run
`luckagent memory share <doc_id> on|off` or `luckagent memory update <doc_id>
--share|--no-share`. To pin the choice across bridge restarts, set
`memoryPublic: true|false` on the bot's entry in `bots.json` — the bridge
re-asserts the column on every bulk-register and overrides whatever was last
toggled via CLI. Omitting the field in bots.json leaves CLI toggles sticky.

## `luckagent skills` — skill registry

```bash
luckagent skills list
luckagent skills get <name>
luckagent skills publish <name> --from <dir>        # reads <dir>/SKILL.md
luckagent skills install <name> [--to <dir>]        # default --to .claude/skills/<name>
luckagent skills remove <name>
luckagent skills health
```

**Install location landmine:** `luckagent skills install <name>` defaults to `<cwd>/.claude/skills/<name>`. For a Claude-Code-wide install, pass `--to ~/.claude/skills/<name>`:

```bash
luckagent skills install luckagent --to ~/.claude/skills/luckagent
```

(Replaces the former standalone `mh` CLI — same wire calls, same behavior, single binary.)

## `luckagent agents` — peer-bot address book

The agent bus is the registry of all reachable Luckagent bots in the org. Bots self-register with their callable URL; peers discover them with zero config; the actual talk RPC stays bot-to-bot (P2P). **Visibility is the permission** — if a bot is in the visible registry, anyone with a luckagent-core token can talk to it. Owner credentials decide which of their bots to expose via `bots.json` (`visible: true|false`); the registry no longer stores a per-bot `talkSecret`.

```bash
luckagent agents list [--include-hidden]
luckagent agents register --url <url> [--bot-name <name>] [--hidden]
luckagent agents heartbeat [--bot-name <name>]
luckagent agents whoami
luckagent agents visible <botName>
luckagent agents hide    <botName>
luckagent agents talk <peer>[/<bot>] [<chatId>] "<message>"
```

**`list`** — returns the visible registry. `--include-hidden` requires an admin token; member tokens get 403.

**`register`** — typically called by the IM-bridge on boot for each `visible:true` bot in `bots.json`, not by a human. `--bot-name` lets one credential register many distinct bots; without it, the credential's own `botName` is used (legacy 1:1 mode). Anti-squat is enforced server-side — re-registering an existing name from a different credential returns `403 name_squat`. `--hidden` sets `visible=false` at registration.

**`heartbeat`** — IM-bridges call this every ~60s, batched across all owned bots via `{botNames:[...]}`. Without `--bot-name`, falls back to the legacy single-bot form (uses the credential's own `botName`). After ~180s (3× heartbeat) a row is treated as stale and filtered out of `list`. Stale rows are kept in storage for audit; the store sweeps anything older than 24h.

**`whoami`** — calls `GET /api/whoami` to echo `{botName, role, authSource, credentialId}` for the current token. Bridges use the same endpoint internally to verify an inbound cross-bridge talk caller.

**`visible` / `hide`** — ownership-gated. Only the credential that registered the bot (or an admin token) can toggle visibility.

**`talk`** is a thin convenience: it does `GET /api/agents` to resolve `<peer>` → `{url}`, then either (a) `POST <peerUrl>/api/talk` for resident bridges, or (b) `POST <core>/api/inbox/<botName>` for CLI-only peers whose registered URL is the literal string `inbox:` (see [CLI-only agents](#cli-only-agents-inbox--project-as-chatid) below). The peer bridge verifies the token by calling central `GET /api/whoami`; if it returns 200, the call is authorized. Use `<peer>/<bot>` to target a specific bot inside that peer; `<peer>` alone targets a bot of the same name on that peer.

**Default chatId — project-derived.** If you omit `<chatId>`, the CLI derives one from the current working directory: `proj:<basename>:<sha1(abs-path)[:8]>` (stable per absolute path, intentionally **not** cross-machine stable — see the inbox section). The derived id is echoed on stderr so you can tell when the default fired:

```bash
$ luckagent agents talk alice/research-bot "ping"
→ using project-derived chatId: proj:luckagent:1a2b3c4d
→ alice/research-bot @ proj:luckagent:1a2b3c4d
```

Pass an explicit chatId when you want to share a thread across machines or with a non-CLI sender (Feishu, browser, etc.).

**Semantics:**
- **Asynchronous.** The target bot receives the message in its own chat/session and processes the turn there. Its reply lands in the target bot's chat (not as the return value of this command).
- **The talk RPC is P2P for resident bridges.** The registry is an address book only — for bridge peers, `luckagent agents talk` shells out to the peer's `/api/talk` directly and luckagent-core never proxies the message body. For CLI-only peers (`url: 'inbox:'`), the message is spooled centrally in luckagent-core's `agent_inbox` table and drained by the target via `luckagent inbox poll`.

```bash
# Resolve the registry, then deliver
luckagent agents list
luckagent agents talk alice/research-bot chat_BBB "What did last week's retention dashboard show?"
```

### CLI-only agents (`inbox:` + project-as-chatId)

Claude Code and Codex have no resident bridge, so they can't accept inbound `POST /api/talk`. To make them addressable on the agent bus anyway, they register with a literal `url: 'inbox:'` marker (no scheme, no host — just the string). Senders observe the marker and reroute through luckagent-core's central inbox; the CLI agent drains the queue with `luckagent inbox poll`.

**Project = chatId.** Without Feishu, there's no natural conversation id, so each project directory's absolute path is hashed into `proj:<basename>:<sha1>[:8]`. This is the default chatId for both `luckagent agents talk` (when chatId is omitted) and `luckagent inbox peek/poll/clear` (when `--chat` and `--all-chats` are both omitted). Two checkouts of the same repo at different paths or on different machines are deliberately treated as **different** chats — pass an explicit `--chat` if you want to merge them.

```bash
luckagent inbox project-id   # echo the cwd-derived chatId without doing anything else
```

End-to-end registration:

```bash
# On machine A (the CC/Codex user) — register once per machine
luckagent inbox register                     # bot name defaults to cli:<ownerName>@<hostname>
luckagent inbox poll --loop                  # block forever, draining as messages arrive

# On machine B (any sender with a luckagent-core token)
luckagent agents talk cli:flood@laptop "follow-up on the deploy"
# stderr: → using project-derived chatId: proj:<project>:<hash>
# A's `inbox poll` prints one JSON line per delivered message
```

## `luckagent inbox` — central inbox for CLI-only agents

A small spool kept inside luckagent-core (table `agent_inbox`) so CC/Codex peers — who can't accept inbound HTTP — can still receive `luckagent agents talk` messages. Bots register with `url: 'inbox:'` (see the [CLI-only agents](#cli-only-agents-inbox--project-as-chatid) section above); senders observe the marker and reroute through `POST /api/inbox/<botName>`; the target drains the queue with `poll`. Each project directory is its own chatId by default.

```bash
luckagent inbox register [--bot-name <name>]
luckagent inbox project-id
luckagent inbox peek    [--chat <id>] [--all-chats] [--limit 20]
luckagent inbox poll    [--chat <id>] [--wait 30] [--once|--loop]
luckagent inbox clear   [--chat <id>] [--all-chats]
```

**`register`** — registers an inbox-only agent on the bus. Default `--bot-name` is `cli:<ownerName>@<hostname>` (ownerName from `GET /api/whoami`, hostname from `os.hostname().split('.')[0]`). The registration uses `url: 'inbox:'` and `visible: true`. Re-running it from the same credential is idempotent; a different credential trying to claim the same name gets `403 name_squat` like any other agent registration.

**`project-id`** — print the cwd-derived chatId and exit. Useful for sanity checks and for copy-pasting into an explicit `--chat` on a remote sender.

**`peek`** — show queued messages without popping them. Without `--chat` or `--all-chats`, filters to the cwd-derived chatId and prints a stderr notice (`→ using project-derived chatId: …`). `--limit` defaults to 20 and is hard-capped at 200.

**`poll`** — atomically pop the oldest queued message, long-polling up to `--wait` seconds. `--wait` defaults to 30 and is hard-capped at 60 (proxy idle limits). `--once` (default) returns after the first message or timeout; `--loop` keeps the call open forever and prints one JSON line per delivered message — the canonical mode for "open a terminal on machine A and leave it running". On `--once` timeout, prints a marker line `{"message":null,"waitedMs":<n>}` so pipelines can distinguish empty-poll from error. SIGINT/SIGTERM exits cleanly in `--loop` mode.

```json
{"id":"…","targetBot":"cli:flood@laptop","chatId":"proj:luckagent:1a2b3c4d",
 "fromBot":"alice","fromOwner":"alice@example.com","content":"ping","enqueuedAt":"…"}
```

**`clear`** — delete queued messages. Defaults to the cwd chatId; `--all-chats` wipes every chat for the bot. Use this when a stale CLI session left messages behind that no longer make sense.

**Auth.** All inbox routes are Bearer-only. `peek` / `poll` / `clear` require **owner** of the target bot (`cred.ownerName === bot.ownerName`, or admin); `enqueue` (i.e. `POST /api/inbox/<botName>` triggered by `luckagent agents talk`) only requires a valid Bearer — sending is open, draining is gated.

**Anti-spoof.** The server stamps `fromBot`, `fromOwner`, `fromCredentialId` from the authenticated credential on every enqueue; any matching fields in the request body are ignored. The receiver can trust those three fields without further verification.

**Storage.** SQLite table `agent_inbox(id, target_bot, chat_id, from_bot, from_owner, from_credential_id, content, enqueued_at)` with index `(target_bot, chat_id, enqueued_at)`. No TTL — use `clear` or `luckagent inbox count` (if added) to manage size. The table lives in the same `central.db` as `agents` and `memory_*`.

## `luckagent teams` — local Agent Teams

Agent Teams live in the local bridge (`/api/agent-teams/*`) and are optimized
for Codex-first delegation. New CLI-spawned teammates default to `codex`; pass
`--engine claude|kimi` only for explicit exceptions.

Lead path:

```bash
luckagent teams create <team> --description "..."
luckagent teams agents spawn <team> <agent> --role "runtime" --prompt "Own runtime work."
luckagent teams dispatch <team> <agent> "Fix update package" --description "Self-contained scope." --plain
luckagent teams status <team> --summary
luckagent teams runs list <team>
```

`dispatch` is the smooth path: it creates a task, assigns it to the agent, and
sends the wake-up message in one command.

To parallelize independent verification, dispatch multiple pending tasks to the
same reviewer/verifier. The supervisor starts one run per ready task, up to
`LUCKAGENT_AGENT_TEAM_MAX_PARALLEL_PER_AGENT` concurrent runs per agent
(default: `4`), using isolated run-scoped chats for parallel same-agent work.

Teammate path:

```bash
luckagent teams next <team> <agent> --read
luckagent teams status <team> --summary
luckagent teams tasks claim <team> <taskId> <agent>
luckagent teams tasks done <team> <taskId> "result"
luckagent teams tasks block <team> <taskId> "blocked reason" --blocked-by <id,id>
luckagent teams send <team> lead "Completed task <taskId>: ..."
```

For repeated local teammate use, set `LUCKAGENT_TEAM_AGENT=<agent>` and omit the
owner argument in `tasks claim`.

Add `--summary` or `--plain` to `status`, `next`, `inbox`, `tasks list`,
`runs list`, `dispatch`, and `watch` for concise text output. Omit it when you
need the default JSON for scripts.

## `luckagent` bridge-local — local bridge daemon API

Separate from the luckagent-core surfaces above, `luckagent` also curls the **local
bridge daemon** at `localhost:9100` (auth from `API_PORT` / `API_SECRET` in the
bridge `.env`). These commands act on the bot process running on this host:

```bash
luckagent bots                              # list all bots (local + peer)
luckagent bot <name>                        # get bot details
luckagent talk [peer/]<bot> <chatId> <msg>  # talk to a bot via the bridge /api/talk
luckagent teams ...                          # local Agent Teams
luckagent schedule list|add|cron|pause|resume|cancel …   # task scheduler
luckagent peers                             # list peers and status
luckagent stats                             # cost & usage statistics
luckagent metrics                           # Prometheus metrics
luckagent voice tts …                       # text-to-speech (bridge /api/tts)
luckagent health                            # health check
```

**`talk` — two distinct paths.** `luckagent talk` (here) hits the **bridge**
`/api/talk` on `localhost:9100` for local + peer-federated routing. `luckagent
agents talk` (above) is the **central-registry** P2P path that resolves a peer
via the luckagent-core agent bus. They are not aliases — pick by which registry
you want.

The per-bot bridge-local Skill Hub (`luckagent bot-skills`) has been retired —
all skill publishing/installing now goes through the central `luckagent skills`
surface above.

## Env vars

| Var | Purpose |
|---|---|
| `LUCKAGENT_CORE_URL` | Memory + skills + agents base URL. Default `http://localhost:9200` (locally self-hosted luckagent-core); set to your own remote host if running it elsewhere. |
| `LUCKAGENT_CORE_TOKEN` | Bearer token for member or admin access. If unset, the CLI reads the first line of `~/.luckagent-core/token`. |
| `LUCKAGENT_CORE_AGENT_BUS_URL` | Optional override for the agent-registry base URL when it diverges from `LUCKAGENT_CORE_URL` (e.g. a staging core). Falls back to `LUCKAGENT_CORE_URL`. |
