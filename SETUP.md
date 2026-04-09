# Franklin — Setup Guide

Get Franklin running from a fresh clone.

---

## 1. Prerequisites

You need these installed before starting:

- **Node.js** v20+ (`node --version`)
- **Claude Code** CLI (`claude --version`) — [install guide](https://claude.ai/claude-code)
- **GitHub CLI** (`gh --version`) — authenticated with `gh auth login`
- **Jira CLI** (`jira --help`) — optional, only if using Jira integration
- **gws CLI** (`gws --help`) — optional, only if using Google Workspace integration

### MCP servers

Franklin uses MCP servers for Slack, GitHub, Jira, Atlassian, and Datadog. Configure the ones you need in Claude Code:

```bash
claude mcp add slack
claude mcp add atlassian    # for Jira/Confluence
claude mcp add datadog      # optional
```

or add the following to your JSON config file

```json
"mcp-atlassian": {
  "command": "npx",
  "args": [
    "mcp-remote",
    "https://mcp.atlassian.com/v1/sse"
  ]
},
"glean_default": {
  "type": "http",
  "url": "https://circle-be.glean.com/mcp/default"
},
"datadog": {
  "type": "http",
  "url": "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp"
},
"slack": {
  "type": "http",
  "url": "https://mcp.slack.com/mcp",
  "oauth": {
    "clientId": "1601185624273.8899143856786",
    "callbackPort": 3118
  }
}
```

---

## 2. Install dependencies

```bash
cd franklin
npm install
```

---

## 3. Configure settings

```bash
cp state/settings.example.json state/settings.json
```

Edit `state/settings.json`:

```json
{
  "mode": "allow_send",
  "user_profile": {
    "name": "Your Name",
    "slack_user_id": "UXXXXXXXXXX",
    "tone": "professional but not stiff, direct, friendly"
  },
  "authorized_users": [
    { "name": "your-slack-username", "slack_user_id": "UXXXXXXXXXX" }
  ],
  "integrations": ["slack", "jira", "github", "gws"]
}
```

### Finding your Slack user ID

1. Open Slack, click your profile picture
2. Click **Profile**
3. Click the **...** menu → **Copy member ID**

### Settings reference

| Field | Description |
|-------|-------------|
| `mode` | `"allow_send"` sends messages directly. `"drafts_only"` drafts proactive messages for your review (direct replies always send). |
| `user_profile.name` | Your name |
| `user_profile.slack_user_id` | Your Slack member ID |
| `user_profile.tone` | How Franklin writes — be specific. Example: `"curt but witty, keeps it professional"` |
| `authorized_users` | Who can create quests via DM. Franklin ignores messages from everyone else. |
| `integrations` | Which platforms to monitor. Remove any you don't use. |

---

## 4. Create a Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app.

### Bot token scopes

Under **OAuth & Permissions**, add these bot token scopes:

- `app_mentions:read`
- `channels:history`
- `chat:write`
- `groups:history`
- `im:history`
- `im:write`
- `reactions:read`
- `reactions:write`

### User token scopes

Under **OAuth & Permissions**, add this user token scope:

- `search:read`

### Event subscriptions

Under **Event Subscriptions**, enable events and subscribe to these bot events:

- `message.im`
- `message.channels`
- `message.groups`
- `app_mention`
- `reaction_added`

### Socket Mode

Under **Socket Mode**, enable it. This is how Franklin receives events in real-time without a public URL.

### App-level token

Under **Basic Information** → **App-Level Tokens**, generate a token with the `connections:write` scope.

### Install the app

Install to your workspace. Copy the three tokens.

---

## 5. Add secrets

Create a `secrets/` directory and add your tokens:

```bash
mkdir -p secrets

# Bot OAuth token (xoxb-...)
echo "xoxb-your-bot-token" > secrets/franklin_bot_oauth_token.txt

# User OAuth token (xoxp-...)
echo "xoxp-your-user-token" > secrets/franklin_user_oauth_token.txt

# App-level token for Socket Mode (xapp-...)
echo "xapp-your-app-token" > secrets/franklin_socket_token.txt
```

### Optional tokens

These are only needed if you use the corresponding integrations:

```bash
# Jira API token (Settings → API tokens at id.atlassian.com)
echo "your-jira-token" > secrets/jira_api_token.txt

# SonarQube token (optional, for sonar-scan skill)
echo "your-sonar-token" > secrets/sonarqube.txt
```

**Important:** The `secrets/` directory is gitignored. Never commit tokens.

---

## 6. Initialize state

Create the required directories:

```bash
mkdir -p state/quests/active state/quests/completed state/quests/archived
mkdir -p state/scout_results state/brain_input state/worker_results
```

Initialize empty files:

```bash
echo '[]' > state/scheduled_tasks.json
```

---

## 7. Set up knowledge and references (optional)

Franklin reads from `knowledge/` and `references/` directories for domain context. These are gitignored symlinks — point them at your own knowledge base:

```bash
ln -s /path/to/your/knowledge knowledge
ln -s /path/to/your/references references
```

If you don't have these, Franklin still works — he just won't have extra domain context.

---

## 8. Set up skills (optional)

Franklin uses a global skills library at `~/DevEnv/skills/`. Each skill is a directory with a `SKILL.md` file. Franklin discovers them at runtime.

If you don't have skills set up, Franklin still works — he'll use MCP tools directly for everything.

---

## 9. Start Franklin

```bash
npx tsx franklin.ts
```

This starts:
- The supervisor loop (30-second cycles)
- The dashboard server at `http://localhost:7070`
- The Slack socket listener (real-time event intake)

### CLI options

```bash
npx tsx franklin.ts                        # Start everything
npx tsx franklin.ts status                 # Print status and exit
npx tsx franklin.ts --skip=gmail,calendar  # Skip specific scouts
npx tsx franklin.ts --only=github          # Run only specific scouts
```

### Check it's working

1. Open `http://localhost:7070` — you should see the dashboard
2. DM Franklin in Slack — you should see a raccoon reaction within ~30 seconds
3. Franklin should reply in the thread shortly after

---

## 10. Add scheduled tasks (optional)

Edit `state/scheduled_tasks.json` to add recurring jobs, or just DM Franklin:

> "Schedule a daily health review on weekdays"

Manual format:

```json
[
  {
    "id": "daily-review",
    "every": "weekdays",
    "type": "scheduled",
    "priority": "normal",
    "context": {
      "objective": "Run daily service health review"
    }
  }
]
```

Valid `every` values: `"30m"`, `"4h"`, `"7d"`, `"2w"`, `"daily"`, `"weekdays"`, `"weekly"`

---

## Troubleshooting

### "Another instance is already running"

```bash
npx tsx franklin.ts status    # Check if it's actually running
rm state/franklin.lock        # Remove stale lock if the process is dead
```

### Socket not connecting

- Check `secrets/franklin_socket_token.txt` exists and contains a valid `xapp-` token
- Check **Socket Mode** is enabled in your Slack app config
- Check `state/slack_socket.json` for the current status

### No reactions on messages

- Verify `secrets/franklin_bot_oauth_token.txt` has a valid `xoxb-` token
- Verify the bot has `reactions:write` scope
- Verify your Slack user ID in `settings.json` matches `authorized_users`

### Port 7070 already in use

```bash
lsof -ti :7070 | xargs kill   # Kill whatever's holding the port
```

### Scouts failing

Check `state/scout_results/<scout>.json` for error details. Common issues:
- **github**: `gh auth login` not run
- **jira**: missing `secrets/jira_api_token.txt` or jira CLI not installed
- **gmail/calendar**: `gws` CLI not installed or not authenticated (`gws setup`)

---

## Architecture overview

```
franklin.ts (supervisor)
  ├── Spawns server.ts (dashboard + socket listener)
  ├── Runs scouts on intervals (github, jira, gmail, calendar)
  ├── Runs filter-signals (dedup, state comparison)
  ├── Runs brain (reads signals, writes delegation.json)
  ├── Generates DM tasks (deterministic, from socket inbox)
  ├── Generates scheduled tasks (from scheduled_tasks.json)
  ├── Dispatches workers (autonomous Claude agents)
  │   └── Workers use MCP tools + skills library + playbooks
  └── Dispatches quest agents (long-running, multi-step tasks)

server.ts
  ├── Dashboard at :7070
  ├── Slack Socket Mode listener
  └── SQLite DB for state (surfaced signals, quests, dispatch log)
```

### Key files

| File | Purpose |
|------|---------|
| `franklin.ts` | Supervisor — the main loop |
| `server.ts` | Dashboard + socket listener |
| `modes/brain.md` | Brain prompt — signal reasoning |
| `modes/worker_wrapper.md` | Worker prompt — autonomous task execution |
| `playbooks/DevWorkflow.md` | End-to-end dev workflow |
| `scripts/db.ts` | SQLite schema and helpers |
| `scripts/scouts/*.ts` | Scout scripts (github, jira, gmail, calendar) |
| `scripts/slack_send.ts` | Send messages/reactions as the Franklin bot |
| `scripts/filter-signals.ts` | Dedup and state-diff before brain |
| `state/settings.json` | Your personal config |
| `state/scheduled_tasks.json` | Recurring task definitions |
| `CLAUDE.md` | Franklin's behavioral instructions |
