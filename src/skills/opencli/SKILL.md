---
name: opencli
description: Turn any website into a CLI and drive the user's logged-in Chrome. Use opencli when the user wants data from a specific site (Bilibili, 知乎, 小红书, 12306, Amazon, GitHub, arXiv, LinkedIn, 36kr, Hacker News, 抖音, 微博, etc.), wants to search/scrape/download from a website, automate browser actions (open/click/fill/extract/screenshot), or call wrapped external CLIs (gh, docker, lark-cli, notion, vercel...). 前提：本机已安装 opencli 二进制（PATH 可用）。
---

# OpenCLI — "Make any website your CLI"

`opencli` runs locally (binary on PATH). It exposes **155+ website adapters**, **13 wrapped external CLIs**, and a **browser-automation bridge** that drives the user's real logged-in Chrome — all as plain CLI commands. Great for AI agents because every command can emit structured output.

## Command shape

```bash
opencli <site> <command> [args] [options]
```

- Discover everything: `opencli list`
- Per-command help (READ THIS before guessing args): `opencli <site> <command> --help`
- Validate connectivity / browser bridge: `opencli doctor`

## ⭐ Always request structured output for parsing

Default format is a human table. When you need to parse the result, append `-f json` (or `yaml`):

```bash
opencli hackernews top --limit 5 -f json
opencli bilibili hot --limit 10 -f yaml
```

Common options on (almost) every command:
- `-f, --format <table|plain|json|yaml|md|csv>` (default `table`)
- `--limit <n>` (where listing)
- `-v, --verbose` (debug)
- `--trace <off|on|retain-on-failure>`

Each `--help` footer also shows: `Access:` (public/cookie/intercept), `Browser:` (yes/no), `Domain:`, an `Example:`, and `Output columns:`.

## Access levels (important for login)

Commands are tagged by how they get data:
- **`public`** — no login, works immediately (e.g. `36kr hot`, `12306 trains`, `hackernews top`, `arxiv`, `github`).
- **`cookie`** — needs the site logged in inside the user's Chrome.
- **`intercept`** — needs browser network interception.

Check login state for all sites:
```bash
opencli auth status
```
Log in to a site (opens Chrome, waits for auth):
```bash
opencli <site> login        # e.g. opencli xiaohongshu login
opencli <site> whoami       # confirm identity
```
If a `cookie`/`intercept` command fails with not-logged-in, tell the user to run `opencli <site> login` (they must complete login in the browser), then retry. Prefer `public` commands when possible.

## Categories

**Site adapters (155+)** — e.g. `12306 1688 36kr 51job amazon arxiv baidu-scholar bilibili binance boss bbc bloomberg booking chess cnki coingecko coupang ctrip deepseek dianping douban douyin duckduckgo eastmoney facebook gitee github google google-scholar hackernews hf hupu imdb indeed instagram jd jike jira ke kimi lichess linkedin linux-do maimai maven mdn medium notebooklm reddit weibo xiaohongshu zhihu ...` (run `opencli list` for the full set + each site's subcommands).

**External CLIs (13)** — opencli proxies these if installed: `discord docker dws(钉钉) gh lark-cli longbridge ntn(notion) obsidian tg vercel wecom-cli(企业微信) wrangler wx(微信)`. Manage with `opencli external list|register`.

**Browser bridge** — drive the logged-in Chrome directly:
```bash
opencli browser open https://example.com
opencli browser extract        # pull structured content
opencli browser click / fill / type / scroll / screenshot / eval / wait ...
opencli doctor                 # diagnose bridge connectivity
```
Use the browser bridge as a fallback when no site adapter covers the task.

## Typical examples

```bash
# Public, no login
opencli hackernews top --limit 5 -f json
opencli 36kr hot -f yaml
opencli arxiv search "diffusion model" --limit 10 -f json
opencli 12306 trains --from 上海 --to 北京 --date 2026-07-01    # check --help for exact flags
opencli github repo jackwener/opencli -f json

# Needs the site logged-in in Chrome (cookie)
opencli xiaohongshu search "关键词" -f json
opencli zhihu hot -f json
opencli bilibili download BV1xxxxxx --output ./bili

# Wrapped external CLI
opencli gh ...
opencli lark-cli ...
```

## Working tips

1. **Never invent flags.** Run `opencli <site> <command> --help` first; arg names/format vary per adapter.
2. **Discovery:** `opencli list` shows all sites; a bare `opencli <site>` lists that site's subcommands.
3. **Parse-friendly:** add `-f json` whenever you'll process the output programmatically; summarize results back to the user concisely (Feishu cards are small).
4. **Login flow is human-in-the-loop:** for `cookie`/`intercept` commands, the user must complete login in their Chrome via `opencli <site> login`. Don't loop retrying — surface the instruction.
5. **Browser issues:** if browser commands hang or fail, run `opencli doctor`; the daemon can be managed with `opencli daemon status|restart|stop`.
6. **Downloads / files:** when a command produces files for the user, copy them to the outputs directory from the system prompt so they reach the chat.
7. **Config (env):** `OPENCLI_DAEMON_PORT` (default 19825), `OPENCLI_PROFILE` (Chrome profile alias), `OPENCLI_BROWSER_COMMAND_TIMEOUT` (default 60s).
