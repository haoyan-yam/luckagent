# @luckagent/cli-core

Shared building blocks for the luckagent-core feature CLIs (config, HTTP client, arg parsing, printing).
Holds the canonical implementations of:

- **config** — `loadConfig()` / `tokenFilePath()` / `DEFAULT_URL`
- **client** — `request<T>()` with Bearer auth + JSON handling
- **args** — `parseArgs(argv)` (`--name value`, `--name=value`, `-n value`, `--` terminator)
- **print** — `print(body)` (string passthrough or pretty JSON)

## Usage

Import a named subpath to avoid pulling everything:

```ts
import { loadConfig } from '@luckagent/cli-core/config';
import { request } from '@luckagent/cli-core/client';
import { parseArgs } from '@luckagent/cli-core/args';
import { print } from '@luckagent/cli-core/print';
```

Or grab the whole barrel:

```ts
import { loadConfig, request, parseArgs, print } from '@luckagent/cli-core';
```

## Environment contract

- `LUCKAGENT_CORE_URL` — server base URL (default `http://localhost:9200`, dedicated front-door domain since P4-MR6)
- `LUCKAGENT_CORE_TOKEN` — bearer token; falls back to first line of `~/.luckagent-core/token`

`loadConfig()` throws when no token is configured.
