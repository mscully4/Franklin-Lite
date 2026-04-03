---
id: proposal-00003
title: Franklin Sandbox for Code-Change Quests
status: applied
applied_at: 2026-04-03
created: 2026-04-03
---

# Franklin Sandbox for Code-Change Quests

## Problem

The current Code-Change Quests procedure clones repos into `~/Workplace/emu/`, which is where Michael does his own development. This causes two problems:

1. Franklin must pause quests if Michael has uncommitted changes in a repo — unnecessary interruption
2. Any mistake by Franklin could affect Michael's working state

## Proposal

Use a dedicated `~/franklin-sandbox/` directory for all code-change quest work. Franklin owns this directory entirely.

### Directory structure

```
~/franklin-sandbox/
  <quest-id>/
    <repo-name>/   ← full clone, feature branch checked out
```

### Updated Code-Change Quests procedure

1. Create quest workspace: `mkdir -p ~/franklin-sandbox/<quest-id>`
2. Clone the repo: `git clone <remote> ~/franklin-sandbox/<quest-id>/<repo-name>`
3. If fork: `git remote add upstream <upstream-url>`
4. Create feature branch: `git checkout -b <ticket-key>`
5. Spawn subagent: `claude -p "<task>" --cwd ~/franklin-sandbox/<quest-id>/<repo-name> --dangerously-skip-permissions` — subagent makes changes, pushes branch, returns PR URL
6. Log PR URL in quest, DM user
7. On quest completion or cancellation: `rm -rf ~/franklin-sandbox/<quest-id>`

Remove the "check for uncommitted changes" guard — Franklin no longer touches emu repos.

### Startup checklist addition

Scan `~/franklin-sandbox/` for directories whose quest-id has no corresponding active quest file — clean them up.

## Notes

- Full clone (no `--depth=1`) so `git log`, `git blame`, and history-dependent operations work
- The spawned `claude -p` subprocess inherits `~/.claude/settings.json` globally, so all MCP tools (Slack, Jira, GitHub, Datadog) and skills (`~/DevEnv/skills/`) are available to the subagent without any additional setup
- `~/franklin-sandbox/` is persistent across reboots — in-progress quest work survives a crash
- Directory already created at `~/franklin-sandbox/`
