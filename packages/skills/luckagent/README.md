# `luckagent` — Claude Code skill bundle

This directory ships the canonical Claude Code skill for the unified `luckagent` CLI. It's the address-book + memory + skills front-end for the entire luckagent-core stack.

## Install

```bash
# Per-project (default): writes to <cwd>/.claude/skills/luckagent/SKILL.md
luckagent skills install luckagent

# Global (recommended for personal Claude Code installs):
luckagent skills install luckagent --to ~/.claude/skills/luckagent
```

**Mind the install path landmine.** `luckagent skills install <name>` (and its alias `mh install <name>`) defaults to `<cwd>/.claude/skills/<name>` — a per-project install. If you want every Claude Code session on your machine to see this skill, pass `--to ~/.claude/skills/luckagent`. Without that flag, other sessions outside the install cwd will not see the skill and will wonder why `luckagent agents …` shows up as an "unknown command" hint instead of a usable tool.

The legacy `metamemory` and `skill-hub` Claude Code skills keep working unchanged; this one is purely additive.

## What's inside

- `SKILL.md` — the user-facing skill manifest with frontmatter (`name`, `description`) and the full `luckagent` CLI reference: `memory`, `skills`, `agents` (incl. `talk <peer>/<bot> [<chatId>] "<msg>"` with project-derived chatId default), `inbox` (central spool for CC/Codex agents that have no resident bridge).

## Source of truth

This skill is published from this directory inside `luckagent-core`. To re-publish after editing:

```bash
luckagent skills publish luckagent --from packages/skills/luckagent
```
