# Franklin — Setup Guide

Get Franklin running from a fresh clone.

---

## 1. Prerequisites

You need these installed before starting:

- **Node.js** v20+ (`node --version`)
- **Claude Code** CLI (`claude --version`) — [install guide](https://claude.ai/claude-code)
- **gws CLI** (`gws --help`) — optional, only if using Google Workspace integration

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
  "integrations": ["telegram", "gws"]
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
| `user_profile.telegram_user_id` | Your Telegram user ID |
| `user_profile.tone` | How Franklin writes — be specific. Example: `"curt but witty, keeps it professional"` |
| `authorized_users` | Who can create quests via DM. Franklin ignores messages from everyone else. |
| `integrations` | Which platforms to monitor. Remove any you don't use. |

---

## 4. Create a Telegram bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

Franklin stores the token in AWS Secrets Manager. Deploy the CDK stack first (see CDK section), then add the token:

```bash
aws secretsmanager create-secret --name franklin/telegram-bot-token \
  --secret-string "your-bot-token"
```

---

## 5. Add secrets

The Telegram bot token is stored in AWS Secrets Manager (see step 4). No local secrets file is needed for Telegram.

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
npx tsx franklin.ts --only=gmail           # Run only specific scouts
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

### Telegram bot not responding

- Check `state/telegram_bot.json` for current status
- Verify the bot token is in AWS Secrets Manager under `franklin/telegram-bot-token`
- Verify your Telegram user ID in `settings.json` matches `authorized_users`

### Port 7070 already in use

```bash
lsof -ti :7070 | xargs kill   # Kill whatever's holding the port
```

### Scouts failing

Check `state/scout_results/<scout>.json` for error details. Common issues:
- **gmail/calendar**: `gws` CLI not installed or not authenticated (`gws setup`)

---

## Architecture overview

```
franklin.ts (supervisor)
  ├── Spawns server.ts (dashboard + Telegram bot)
  ├── Runs scouts on intervals (gmail, calendar)
  ├── Runs filter-signals (dedup, state comparison)
  ├── Runs brain (reads signals, writes delegation.json)
  ├── Generates DM tasks (deterministic, from Telegram inbox)
  ├── Generates scheduled tasks (from scheduled_tasks.json)
  ├── Dispatches workers (autonomous Claude agents)
  │   └── Workers use MCP tools + skills library + playbooks
  └── Dispatches quest agents (long-running, multi-step tasks)

server.ts
  ├── Dashboard at :7070
  ├── Telegram bot (long polling)
  └── SQLite DB for state (surfaced signals, quests, dispatch log)
```

### Key files

| File | Purpose |
|------|---------|
| `franklin.ts` | Supervisor — the main loop |
| `server.ts` | Dashboard + Telegram bot |
| `modes/brain.md` | Brain prompt — signal reasoning |
| `modes/worker_wrapper.md` | Worker prompt — autonomous task execution |
| `src/db.ts` | SQLite schema and helpers |
| `src/scouts/*.ts` | Scout scripts (gmail, calendar) |
| `src/filter-signals.ts` | Dedup and state-diff before brain |
| `state/settings.json` | Your personal config |
| `state/scheduled_tasks.json` | Recurring task definitions |
| `CLAUDE.md` | Franklin's behavioral instructions |
