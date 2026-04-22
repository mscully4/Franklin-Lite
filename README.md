# Franklin

![Franklin](Franklin.jpg)

Franklin is a personal autonomous agent that monitors Slack, GitHub, Jira, Gmail, and your calendar — surfacing what needs attention and acting on it. DM him a task, and he figures out how to get it done.

---

## How It Works

Tasks are called **quests**. The flow is:

1. DM Franklin or @mention him in a channel
2. Franklin creates a quest, DMs you a proposed approach
3. You approve, give feedback, or cancel
4. Franklin executes and reports back

For simple requests (send an email, check a dashboard, answer a question), Franklin just does it — no quest needed.

---

## Architecture

```
franklin.ts (supervisor, 30-second cycles)
  ├── server.ts (dashboard + Slack socket listener)
  ├── Scouts (github, jira, gmail, calendar)
  ├── filter-signals (dedup + state comparison)
  ├── Brain (reads signals, decides what to do)
  ├── Workers (autonomous Claude agents)
  └── Quest agents (long-running multi-step tasks)
```

**Scouts** poll external sources on staggered intervals and write results to `state/scout_results/`.

**filter-signals** compares current state against previously surfaced state in SQLite, passing through only what changed.

**Brain** reads the filtered signals and writes `state/delegation.json` — a list of tasks to execute.

**Workers** are autonomous Claude agents that receive a task and figure out how to do it. They have access to MCP tools (Slack, GitHub, Jira, Datadog, etc.), a global skills library (`~/DevEnv/skills/`), playbooks for complex workflows, and the `pi-db-query` skill for read-only database lookups when a task requires it.

**Quest agents** handle multi-step work: create a branch, write code, open a PR, babysit CI, and report back. See `playbooks/DevWorkflow.md`.

---

## Scouts

| Scout | Interval | What it monitors |
|-------|----------|------------------|
| `github` | 10 min | Your PRs (CI, reviews), review requests, assignments, notifications |
| `jira` | 10 min | Assigned tickets, status changes, comments |
| `gmail` | 15 min | Unread inbox (filters out automated noise) |
| `calendar` | 10 min | Today + tomorrow events, transcript availability |

---

## Workers

Workers are autonomous — given a task, they decide how to execute it. They can:

- Use MCP tools directly (Slack, GitHub, Jira, Datadog)
- Invoke skills from `~/DevEnv/skills/`
- Follow playbooks from `playbooks/`
- Ask you for clarification via Slack DM
- Update Franklin's own prompts and config based on your feedback

See `modes/worker_wrapper.md` for the full worker prompt.

---

## Scheduled Tasks

Recurring jobs defined in `state/scheduled_tasks.json`. The supervisor fires them on schedule — no brain involved. Tasks come in two kinds:

**Worker tasks** (default) — spawn a Claude worker with LLM reasoning:

```json
{
  "id": "daily-review",
  "every": "weekdays",
  "type": "scheduled",
  "priority": "normal",
  "context": { "objective": "Run daily service health review" }
}
```

**Script tasks** — run a shell command directly, no LLM:

```json
{
  "id": "sandbox-cleanup",
  "every": "daily",
  "type": "scheduled",
  "priority": "low",
  "kind": "script",
  "command": "npx tsx scripts/cleanup-sandboxes.ts",
  "timeout": 30000,
  "context": { "objective": "Clean up stale quest sandbox directories" }
}
```

Use `kind: "script"` for deterministic tasks that don't need reasoning (cleanup, pruning, health pings). Script-specific fields: `command` (required), `timeout` in ms (optional, default 60s).

Valid frequencies: `"30m"`, `"4h"`, `"7d"`, `"2w"`, `"daily"`, `"weekdays"`, `"weekly"`

You can also DM Franklin to add/remove scheduled tasks.

---

## Docker Port Isolation

When workers run integration tests across multiple repos in parallel, Docker host ports can conflict (e.g. two repos both binding postgres on `5432`). Franklin assigns each worker a unique loopback IP (`127.0.0.2`–`127.0.0.254`) and generates a `docker-compose.override.yml` that rebinds all published ports to that IP, keeping workers fully isolated.

**One-time macOS setup** (loopback aliases survive reboots):

```bash
sudo bash scripts/setup-loopback.sh
```

On Linux, all `127.x.x.x` addresses are already routable — no setup needed.

**Per-repo config** lives in `knowledge/repos/<repo-name>/docker.md`. Each file declares the env vars that need the IP substituted (e.g. `APP_CONFIG_OPTION_PG_URL={ip}:5432`) and any repo-specific notes. It can also set `skip_docker: true` to opt that repo out.

**Feature flag** — `feature_flags.skip_docker` in `state/settings.json` disables Docker startup globally (workers skip containers and push to CI instead).

---

## Dashboard

`http://localhost:7070` — auto-starts with Franklin.

Shows: process health, socket status, scout intervals, active workers, quests, dispatch history, today's meetings, scheduled tasks.

---

## Quests

Each quest is tracked in SQLite and as a JSON file in `state/quests/`. Franklin tracks:

- Objective and approach
- Every action taken (log)
- Linked Jira ticket and PR URL
- Outcome when complete

For code changes, Franklin clones into a sandbox, makes changes, opens a PR, and babysits CI/reviews until it's green.

---

## Self-Improvement

Franklin updates his own prompts and config based on your feedback. Tell him "always do X" or "stop doing Y" and he'll edit the relevant file (`CLAUDE.md`, `modes/brain.md`, `modes/worker_wrapper.md`, etc.) and confirm what changed. Changes are logged in `state/self_improvement_log.json`.

---

## Directory Structure

```
franklin.ts                    # Supervisor — the main loop
server.ts                      # Dashboard + Slack socket listener
CLAUDE.md                      # Franklin's behavioral instructions
modes/
  brain.md                     # Brain prompt — signal reasoning
  worker_wrapper.md            # Worker prompt — autonomous task execution
  RUN.md                       # Run mode spec
  DEV.md                       # Dev mode spec
playbooks/
  DevWorkflow.md               # End-to-end dev workflow
scripts/
  setup-loopback.sh            # One-time macOS loopback alias setup (run with sudo)
src/
  db.ts                        # SQLite schema and helpers
  docker_override.ts           # Docker compose override generator for port isolation
  filter-signals.ts            # Dedup and state-diff
  slack_send.ts                # Send messages/reactions as Franklin bot
  scripts/
    docker_claim.ts            # Claim a loopback IP for a worker
    docker_release.ts          # Release IP and remove compose override
  scouts/
    github.ts                  # GitHub scout
    jira.ts                    # Jira scout
    gmail.ts                   # Gmail scout
    calendar.ts                # Calendar scout
state/
  settings.json                # Personal config (gitignored)
  scheduled_tasks.json         # Recurring task definitions
  franklin.db                  # SQLite — quests, dispatch log, signals, IP pool
  quests/active/               # In-flight quests
  quests/completed/            # Done
  scout_results/               # Latest scout output
  brain_input/                 # Filtered signals for the brain
  worker_results/              # Worker output
secrets/                       # Tokens (gitignored)
knowledge/                     # Domain knowledge (symlink, gitignored)
  repos/<repo>/docker.md       # Per-repo Docker config and flags
references/                    # Tool guides (symlink)
```

---

## Setup

See [SETUP.md](SETUP.md) for the full setup guide.

Quick start:

```bash
npm install
cp state/settings.example.json state/settings.json
# Edit settings.json with your info
# Add Slack tokens to secrets/
sudo bash scripts/setup-loopback.sh  # macOS only, one-time
npx tsx franklin.ts
```

Key `state/settings.json` fields:

| Field | Description |
|-------|-------------|
| `owner_user_id` | Your Slack user ID |
| `timezone` | Your timezone (e.g. `America/Chicago`) |
| `feature_flags.skip_docker` | `true` to skip Docker startup globally — workers push to CI instead |
