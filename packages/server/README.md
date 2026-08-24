# @luckagent/core-server

Memory + skill-hub HTTP server for Luckagent. Single process, single SQLite,
single bind on `127.0.0.1:9200`. In the personal edition you run it locally
(default `http://localhost:9200`) or on your own box behind a reverse proxy
of your choice (e.g. Caddy at `https://your-luckagent-host.example.com`),
protected by a single API token — no SSO or corporate VPN required.

## Quick start (dev)

From the luckagent-core repo root:

```bash
npm install                                  # workspace install
npm -w @luckagent/core-server build
npm -w @luckagent/core-server test
LUCKAGENT_CORE_DATA_DIR=/tmp/mc-dev \
  node packages/server/dist/index.js
```

On first start the server bootstraps an admin credential and writes the
one-time bearer token to `<data-dir>/admin-bootstrap-token.txt` (mode 0600).
Save it — it is never displayed again.

## Configuration (env)

| Var | Default | Notes |
|---|---|---|
| `LUCKAGENT_CORE_HOST` | `127.0.0.1` | Bind address. Loopback-only by default; put your own reverse proxy in front to expose it. |
| `LUCKAGENT_CORE_PORT` | `9200` | TCP port. |
| `LUCKAGENT_CORE_DATA_DIR` | `~/.luckagent-core/data` | SQLite + audit live here. |
| `LUCKAGENT_CORE_AUDIT_DIR` | `$LUCKAGENT_CORE_DATA_DIR/audit` | Override audit dir. |
| `LUCKAGENT_CORE_AUDIT_ENABLED` | `true` | Set `false` to disable audit writes. |
| `LUCKAGENT_CORE_INSTANCE_NAME` | _pkg name_ | Surfaced in `/api/manifest`. |
| `LOG_FORMAT` | _auto_ | `json` for prod; defaults to `pino-pretty` on a TTY. |
| `LOG_LEVEL` | `info` | pino level. |

## API

Open routes (no auth):

```
GET  /health          → { ok, uptime, version }
GET  /api/manifest    → { schemaVersion, instance, capabilities }
```

Authenticated routes use `Authorization: Bearer <token>`. Admin routes
(`role: 'admin'`):

```
POST   /admin/credentials/issue
POST   /admin/credentials/revoke
GET    /admin/credentials
GET    /admin/audit?date=YYYY-MM-DD[&principal=&op=]
```

Memory routes:

```
GET    /api/memory/folders[?prefix=/users/...]
GET    /api/memory/folders/tree
GET    /api/memory/folders/:idOrPath
POST   /api/memory/folders
DELETE /api/memory/folders/:idOrPath
GET    /api/memory/documents[?folder_id=|prefix=&limit=&offset=]
POST   /api/memory/documents
GET    /api/memory/documents/:idOrPath
PATCH  /api/memory/documents/:idOrPath
DELETE /api/memory/documents/:idOrPath
GET    /api/memory/search?q=&limit=
```

Skill routes:

```
GET    /api/skills
GET    /api/skills/search?q=
GET    /api/skills/:name
POST   /api/skills/:name/publish      ← requires publishSkill or admin
DELETE /api/skills/:name              ← admin only
```

Paths may be referenced as either internal id (uuid) or absolute path
starting with `/`. The router URL-decodes the segment, so e.g.
`/api/memory/documents/%2Fusers%2Fdkj%2Fnotes%2Fhello` resolves the
document at `/users/dkj/notes/hello`.

### Document `content_type`

Documents carry a `content_type` field. v1 whitelist:

- `text/markdown` (default when omitted)
- `text/html`

`POST` / `PATCH` / `PUT` accept an optional `content_type` in the request
body; unknown values → `400 unsupported_content_type`. Existing databases
get the column added on first boot via an idempotent migration; all
pre-existing documents default to `text/markdown`. The capability is
advertised on `/api/manifest` as
`capabilities.content_types: ["text/markdown", "text/html"]` so clients
can feature-detect.

FTS still indexes raw `content`, so HTML documents are searchable by both
their tags and text. Snippet rendering may include `<mark>` tags inside
HTML markup — acceptable for v1; not in scope to fix here.

## ACL

```
canRead(cred, path):
  admin → true
  /shared/* → true
  cred.readableNamespaces matches → true
  otherwise false

canWrite(cred, path):
  admin → true
  cred.writableNamespaces matches → true
  otherwise false

canPublishSkill(cred):
  admin → true
  cred.publishSkill → true
  otherwise false
```

Defaults when issuing a member:
- `writableNamespaces`: `[/users/<botName>]`
- `readableNamespaces`: `[/shared, /users/<botName>]`
- `publishSkill`: false

## CLI: `central-admin`

```
central-admin issue   --bot <name> --owner <name> [--role admin|member]
                      [--writable <ns,ns>] [--readable <ns,ns>]
                      [--publish-skill] [--notes <text>]
central-admin revoke  --id <credentialId>
central-admin list
central-admin audit   --date YYYY-MM-DD [--principal <id>] [--op <op>]
```

Auth: `LUCKAGENT_CORE_ADMIN_TOKEN` env or `--token <token>`. URL via
`LUCKAGENT_CORE_URL` (default `http://localhost:9200`; set your own remote
host if luckagent-core runs elsewhere) or `--url`.

## Deployment

For a simple self-hosted deployment you only need the server itself running
on `127.0.0.1:9200` with a data dir and an API token. In the Luckagent
monorepo it is started by PM2 via the root `ecosystem.config.cjs`
(app `luckagent-core`).

TLS and SSO are **out of scope** for the personal edition and not required:
the server listens on localhost with token auth. If you want to expose it on
your own hostname, put any reverse proxy (Caddy, nginx, …) in front to
terminate TLS, and optionally an SSO/identity proxy (e.g. oauth2-proxy) — both
are entirely your choice and bring-your-own.

## Tests

`npm test` runs the full vitest suite:

- `tests/auth.test.ts` — credential issue/revoke/lookup/cache + bootstrap
- `tests/memory.test.ts` — folder + document CRUD with namespace ACL
- `tests/skills.test.ts` — publish/list/search/delete + publish-acl
- `tests/audit.test.ts` — every authed request logged JSONL
- `tests/e2e.test.ts` — full flow over real HTTP: bootstrap → issue → member
  writes own ns / 403 elsewhere → revoke
