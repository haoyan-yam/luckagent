# `luckagent-team` — Luckagent Agent Team skill bundle

This directory ships the canonical Agent Team skill for `luckagent teams`.
It is optimized for Codex-first delegation, teammate task claiming, concise
handoffs, run inspection, and lead reporting.

## Install

```bash
luckagent skills install luckagent-team --to ~/.codex/skills/luckagent-team
```

For Claude Code, install to `~/.claude/skills/luckagent-team` instead.

## Source of truth

The runtime copy lives at `src/skills/luckagent-team/SKILL.md`. Keep this packaged
copy in sync before publishing:

```bash
cp src/skills/luckagent-team/SKILL.md packages/skills/luckagent-team/SKILL.md
luckagent skills publish luckagent-team --from packages/skills/luckagent-team
```
