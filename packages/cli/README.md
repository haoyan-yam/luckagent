# @luckagent/cli

`luckagent` — unified CLI that dispatches to the luckagent-core subcommand
implementations. Invoked by `bin/luckagent` (the bash dispatcher) for the
feature subcommands.

| Subcommand           | Implementation           | Talks to        |
| -------------------- | ------------------------ | --------------- |
| `luckagent memory`   | `@luckagent/metamemory`  | core :9200      |
| `luckagent skills`   | `@luckagent/skill-hub`   | core :9200      |
| `luckagent agents`   | in-tree (`src/agents.ts`)| core :9200      |
| `luckagent inbox`    | in-tree (`src/inbox.ts`) | core :9200      |
| `luckagent teams`    | in-tree (`src/teams.ts`) | bridge :9100    |

Auth: `LUCKAGENT_CORE_TOKEN` env or `~/.luckagent-core/token`;
base URL via `LUCKAGENT_CORE_URL` (default `http://localhost:9200`).

Build: `npm run build -w @luckagent/cli` (emits `dist/`, entry `bin/luckagent`).
