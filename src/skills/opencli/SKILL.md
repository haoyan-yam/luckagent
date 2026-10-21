---
name: opencli
description: Turn any website into a CLI and drive the user's logged-in Chrome. Use opencli when the user wants data from a specific site (Bilibili, 知乎, 小红书, 12306, Amazon, GitHub, arXiv, LinkedIn, 36kr, Hacker News, 抖音, 微博, etc.), wants to search/scrape/download from a website, or automate browser actions (open/click/fill/extract/screenshot). 前提：本机已安装 opencli 二进制（PATH 可用，2.x）。
---

# OpenCLI — "Make any website your CLI"

`opencli` (2.x) runs locally (binary on PATH). It exposes **170+ website adapters** and a **browser-automation bridge** that drives the user's real logged-in Chrome — all as plain CLI commands that return JSON by default.

## Command shape

```bash
opencli <site> <command> [args] [options]
```

- Find commands: `opencli list [query] [--site <site>] [--limit n] [--offset n]` (paginated; follow `nextOffset`)
- Per-command help (READ THIS before guessing args): `opencli <site> <command> --help -f json`
- Validate connectivity / browser bridge: `opencli doctor`

## ⭐ Output is a JSON envelope

Every command prints JSON by default:

```json
{ "ok": true,  "data": ... }
{ "ok": false, "error": { "code": "...", "message": "...", "hint": "..." } }
```

- Read results from `data`; on failure read `error.message` / `error.hint`. Failures also exit nonzero.
- Follow/streaming modes emit JSON Lines.
- Only pass `-f table|plain|yaml|md|csv` when you want human-readable output.

Common options on (almost) every command:
- `-f, --format <json|table|plain|yaml|md|csv>` (default `json`)
- `--limit <n>` (where listing)
- `-v, --verbose` (debug)
- `--trace <off|on|retain-on-failure>`

Each `--help` footer also shows: `Access:` (read/write), `Browser:` (yes/no), `Domain:`, an `Example:`, and `Output columns:`.

## Login

`Browser: no` commands work immediately (e.g. `hackernews top`, `arxiv`, `12306 trains`). `Browser: yes` commands run in the user's Chrome and usually need that site logged in.

```bash
opencli auth status                # login state for every site with an auth adapter
opencli <site> login               # e.g. opencli xiaohongshu login (opens Chrome, waits for auth)
opencli <site> whoami              # confirm identity
```
If a command fails as not-logged-in, tell the user to run `opencli <site> login` (they must complete login in the browser), then retry. Prefer `Browser: no` commands when possible.

`Access: write` commands change something on the site (post, comment, delete, add to cart…) — confirm with the user before running them.

## Browser bridge

Drive the logged-in Chrome directly. Page commands **require `--session <name>`** (one name per task; reuse it across steps):

```bash
opencli browser open https://example.com --session task1
opencli browser state --session task1          # URL, title, interactive elements with [N] indices
opencli browser extract --session task1        # pull page content (chunked; pass --start <next_start_char> for more)
opencli browser click / fill / type / scroll / screenshot / eval / wait ... --session task1
opencli browser close --session task1          # release the tab when done
```
- `opencli browser chrome describe` / `chrome call` — native Chrome tab/window/tab-group management without attaching a page.
- `opencli browser network --static --session <s>` — captured requests + endpoint evidence (for API reverse-engineering).

Use the browser bridge as a fallback when no site adapter covers the task.

## Typical examples

```bash
# No browser / no login
opencli hackernews top --limit 5
opencli arxiv search "diffusion model" --limit 10
opencli 12306 trains --help -f json            # check exact flags first
opencli github repo jackwener/opencli

# Needs the site logged-in in Chrome
opencli xiaohongshu search "关键词" --limit 10
opencli zhihu hot
opencli bilibili download BV1xxxxxx --output ./bili
```

## Working tips

1. **Never invent flags.** Run `opencli <site> <command> --help -f json` first; arg names vary per adapter.
2. **Discovery:** `opencli list <keyword>` searches all commands; `opencli <site> --help` lists one site's subcommands.
3. **Summarize, don't dump:** parse `data` and report concisely (Feishu cards are small).
4. **Login flow is human-in-the-loop:** don't loop retrying login failures — surface the `opencli <site> login` instruction.
5. **Browser issues:** if browser commands hang or fail, run `opencli doctor`; the daemon can be managed with `opencli daemon status|restart|stop`. `Navigation rejected` errors usually mean the Chrome extension is older than 1.0.26.
6. **Adapter broken?** An `error.code` of `COMMAND_EXEC` with a site-specific message often means the site changed — report it to the user rather than retrying endlessly.
7. **Downloads / files:** when a command produces files for the user, copy them to the outputs directory from the system prompt so they reach the chat.
8. **Known issue — `xiaohongshu search` fails with `search_input_not_available`** (2.0.2; site moved to an AI-search homepage, upstream fix pending in jackwener/OpenCLI#2673). Workaround: open the results page directly and read the cards (URL-encode the keyword; use `eval`, since `extract` is flooded with inline images):
   ```bash
   opencli browser open "https://www.xiaohongshu.com/search_result?keyword=<urlencoded>" --session xhs
   opencli browser wait selector "section.note-item" --session xhs
   opencli browser eval --session xhs "[...document.querySelectorAll('section.note-item')].slice(0,10).map(s=>({title:s.querySelector('.title, .footer .title span')?.innerText, author:s.querySelector('.author .name, .name')?.innerText, likes:s.querySelector('.count, .like-wrapper .count')?.innerText, url:s.querySelector('a.cover, a[href*=\"/search_result/\"], a[href*=\"/explore/\"]')?.href}))"
   opencli browser close --session xhs
   ```
   Drop this workaround once `opencli xiaohongshu search` works again.
9. **External CLIs** (gh, docker, lark-cli…) are no longer proxied by opencli in 2.x — call them directly.
10. **Config (env):** `OPENCLI_DAEMON_PORT` (default 19825), `OPENCLI_PROFILE` (Chrome profile alias), `OPENCLI_BROWSER_COMMAND_TIMEOUT` (default 60s).
