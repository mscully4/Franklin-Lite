# Franklin

![Franklin](Franklin.jpg)

Franklin is a personal autonomous agent that monitors Slack for tasks and executes them on your behalf. You tag yourself in a message — Franklin picks it up, proposes an approach, and gets it done.

He works in two modes: **Run** (continuous loop, monitors integrations) and **Dev** (interactive, for testing and improvements).

---

## How It Works

Tasks are called **quests**. The flow is:

1. Tag yourself in a Slack message (or DM Franklin directly)
2. Franklin sees it, creates a quest, DMs you a proposed approach
3. You approve, give feedback, or cancel
4. Franklin executes and reports back

Franklin monitors Slack mentions, DMs, Jira tickets, GitHub PRs, Gmail, and your calendar — surfacing what needs attention and acting on it according to your settings.

---

## Prerequisites

- [Claude Code](https://claude.ai/code) with the `/loop` skill available
- MCP servers connected: **Slack**, **Jira**, **GitHub**, **Google Workspace**
- A `state/settings.json` filled in (see below)

---

## Setup

```bash
git clone git@github.com:michael-scully_crcl/franklin.git
cd franklin
cp state/settings.example.json state/settings.json
# Edit state/settings.json with your info
```

Then open Claude Code in this directory.

### settings.json

```json
{
  "mode": "drafts_only",
  "user_profile": {
    "name": "Your Name",
    "slack_user_id": "UXXXXXXXXXX",
    "tone": "professional but not stiff, direct, friendly"
  },
  "authorized_users": [
    { "name": "your-name", "slack_user_id": "UXXXXXXXXXX" }
  ],
  "integrations": ["slack", "jira", "github", "gws"]
}
```

| Setting | Values | Description |
|---|---|---|
| `mode` | `drafts_only` / `allow_send` | Whether Franklin drafts outbound messages or sends them directly |
| `user_profile.name` | string | Your name |
| `user_profile.slack_user_id` | string | Your Slack user ID |
| `user_profile.tone` | string | How Franklin writes as you |
| `authorized_users` | array | Who can create quests |
| `integrations` | array | Active platforms: `slack`, `jira`, `github`, `gws` |

In `drafts_only` mode, Franklin will draft proactive outbound messages for your review. Direct commands and replies to Franklin are always sent immediately, regardless of mode.

---

## Starting Franklin

**Run mode** — starts the monitoring loop (2-minute cycles):
```
Run
```

**Dev mode** — interactive session for testing and building:
```
Dev
```

See `modes/RUN.md` and `modes/DEV.md` for the full behavioral specs.

---

## Directory Structure

```
state/
  settings.json          # Your personal config (gitignored)
  settings.example.json  # Template
  last_run.json          # Loop state
  quests/
    active/              # In-flight quests
    completed/           # Done
    archived/            # Cancelled or stale
  dev/
    proposals/           # Feature/improvement proposals (Dev mode)
knowledge/               # Symlink to your knowledge base (gitignored)
references/              # Symlink to tool usage guides (gitignored)
integrations/            # Integration-specific specs
playbooks/               # Process guides (e.g. dev workflow)
```

`knowledge/` and `references/` are local symlinks — point them wherever your knowledge base lives.

---

## Integrations

| Integration | What Franklin monitors |
|---|---|
| Slack | Mentions, DMs, @franklin tags, quest threads, ops channels |
| Jira | Assigned tickets, status changes, sprint deadlines, stale tickets |
| GitHub | Your PRs (CI, reviews), PRs assigned to you for review |
| Google Workspace | Gmail inbox, calendar events, tasks |

Scouts run on staggered intervals (2–30 min depending on urgency). See `RUN.md` for the full spec.

---

## Quests

Each quest is a JSON file in `state/quests/`. Franklin tracks:
- What needs to be done (`objective`, `approach`)
- Every message sent and received (`log`)
- Linked Jira ticket and PR URL
- Outcome when complete

For code changes, Franklin clones your fork into a sandbox, makes changes, opens a PR, and babysits CI/reviews.

---

## Dev Workflow

When a quest involves code changes, Franklin follows a structured end-to-end flow. The full spec is in `playbooks/DevWorkflow.md`.

### Phases

**1. Ticket** — Create or transition the Jira ticket to `In Progress`.

**2. Plan** — A subagent explores the codebase and returns a plan plus any open questions. Franklin DMs you the questions, waits for answers, then finalizes the plan. In `drafts_only` mode, you approve the plan before implementation starts.

**3. Implement** — A subagent works in an isolated sandbox (`~/franklin-sandbox/<quest-id>/`), follows the plan, and makes changes. Never touches your working directories.

**4. PR** — Franklin opens a PR against upstream, self-reviews it with `analyze-pr`, posts a comment on the Jira ticket, transitions it to `In Review`, and DMs you the link.

**5. Babysit** — `babysit-pr` runs autonomously: fixes CI failures, addresses review comments, resolves SonarQube issues, and notifies reviewers when ready. Franklin DMs you when the PR is mergeable.

**6. Cleanup** — Sandbox directory is deleted. Quest moves to `completed/`.

### Clarification Rule

At any phase, if a decision is ambiguous enough to meaningfully change the approach, Franklin pauses and DMs you rather than guessing. Questions during planning are preferred — mid-implementation interruptions are more disruptive, but always better than a wrong assumption.

---

## Self-Improvement

When Franklin spots a gap in its own instructions, it drafts a proposed change to `CLAUDE.md` and DMs you. You approve or reject. Changes are logged in `state/self_improvement_log.json`.
