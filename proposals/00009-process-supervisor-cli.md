---
id: proposal-00009
title: Process Supervisor CLI — Dumb Scouts, Brain Agent, Targeted Workers
status: draft
created: 2026-04-07
updated: 2026-04-07
---

## Problem

The current run loop has three compounding issues:

1. **Context bloat** — the scheduler session accumulates tool call history across cycles indefinitely
2. **Token waste** — every cycle pays to load scout logic, API calls, and prior history into the same window
3. **Slow cycles** — scouts run in the critical path; GitHub + Jira due at the same time means 5+ min before inbox is processed

All three share a root cause: too much work lives inside a single long-running agent session.

## Proposal

Replace the CC `/loop` scheduler with a **Node.js process supervisor** (`franklin.js`) that:

- Runs dumb data-collection scripts on intervals — no Claude, no tokens
- After each collection pass, spawns a **brain agent** to read results and decide what needs doing
- Brain outputs a delegation manifest; supervisor spawns **targeted worker agents** for each task
- Stays in the foreground; all child process logs pipe to stdout
- PID/lock file prevents double-starts

Claude is only invoked when there is something to reason about or act on. Quiet periods cost nothing.

## Design

### Architecture

```
franklin.js (supervisor)
│
├── server.js (persistent)          state/slack_inbox.jsonl
│
├── scripts/scouts/*.ts             state/scout_results/*.json
│   (gh CLI, jira CLI, gws CLI)
│   run on intervals, write JSON, exit
│
└── on each brain tick (2 min):
    │
    ├── spawn: claude -p modes/brain.md
    │   reads: slack_inbox.jsonl, scout_results/*.json,
    │           last_run.json, settings.json, quest summaries
    │   writes: state/delegation.json
    │   no API calls — reads local files only, exits fast
    │
    └── for each task in delegation.json:
        spawn: claude -p modes/workers/{type}.md
        (independent, run in parallel, own context window)
```

### CLI

```bash
node franklin.js run      # start everything, foreground
node franklin.js stop     # SIGTERM running instance (PID from lock)
node franklin.js status   # lock file, last_run, active workers, scout freshness
```

SIGINT/SIGTERM: kill all children, delete `state/franklin.lock`, exit 0.

### Scouts — dumb scripts, no Claude

Scripts in `scripts/scouts/`. Each:
1. Runs its CLI commands
2. Writes `state/scout_results/{name}.json`
3. Exits

```json
{
  "scout": "github",
  "collected_at": "ISO 8601",
  "status": "ok" | "error",
  "error": "message or null",
  "entries": [ ... ]
}
```

| Scout | Script | Interval | Tool |
|---|---|---|---|
| slack | `scouts/slack.ts` | 10 min | `slack_conversations.ts` |
| github | `scouts/github.ts` | 10 min | `gh` CLI |
| jira | `scouts/jira.ts` | 10 min | `jira` CLI |
| gmail | `scouts/gmail.ts` | 30 min | GWS CLI |
| calendar | `scouts/calendar.ts` | 10 min | GWS CLI |
| meet | `scouts/meet.ts` | 15 min | GWS CLI |

Phase offsets applied as `setTimeout` delays on startup (same values as current RUN.md) to avoid thundering herd.

Scouts run immediately on startup then on interval. If a scout errors, it writes `status: error` to the result file and exits — supervisor logs it but does not retry immediately.

### Brain agent — read and decide, never act

Prompt: `modes/brain.md`

The brain's only job is to produce `state/delegation.json`. It:

1. Reads all local state files (inbox, scout results, quest summaries, settings)
2. Applies judgment: what needs a human response, what needs action, what can be ignored
3. Writes `state/delegation.json` — a list of tasks to spawn
4. Exits

The brain never calls MCP tools, never runs CLI commands, never sends messages. Context window is bounded to local files — always the same size regardless of activity.

```json
{
  "generated_at": "ISO 8601",
  "last_drain_ts": "ISO 8601",
  "tasks": [
    {
      "id": "task-001",
      "type": "inbox" | "pr_monitor" | "jira" | "calendar" | "quest_followup" | "deploy_approval" | ...,
      "priority": "high" | "normal",
      "context": { ... },
      "quest_id": "quest-001 or null"
    }
  ]
}
```

`context` contains everything the worker needs — extracted from scout results and inbox. The worker reads no additional state unless it needs to load a full quest file.

### Worker agents — act, never reason broadly

One prompt file per worker type in `modes/workers/`. Each worker:
- Receives its task context from `delegation.json` (injected into prompt)
- Performs one focused job (send a DM, post a PR review, transition a Jira ticket)
- Writes result to `state/worker_results/{task-id}.json`
- Exits

Workers run in parallel. Supervisor spawns all tasks from `delegation.json` immediately after brain exits.

```json
{
  "task_id": "task-001",
  "status": "ok" | "error",
  "completed_at": "ISO 8601",
  "summary": "Sent DM to Michael: CI failing on wallets-api #42",
  "quest_id": "quest-001 or null"
}
```

Worker results are read on the next brain tick and folded into `last_run.json` / quest files before the brain runs again.

### Quest agent status (file-based, replaces TaskOutput)

Long-running quest agents (PR review, code change) write a status file:

```
state/quests/active/quest-{id}.agent.json
```

```json
{
  "status": "running" | "completed" | "error",
  "started_at": "ISO 8601",
  "completed_at": "ISO 8601 or null",
  "result": "summary or null",
  "error": "message or null"
}
```

Brain reads these files each tick. On completion: includes a `quest_followup` task in delegation so the worker DMs the user and updates the quest file.

Stale detection: `status: running` + `started_at` >1 hour → brain includes a `quest_followup` task flagging it as hung.

`agent_task_id` on quest files is no longer used.

### Surfaced state — SQLite

Signal deduplication and change detection lives in `state/franklin.db`, a SQLite database shared across scouts, brain, and supervisor.

#### `surfaced` table

```sql
CREATE TABLE surfaced (
  id               TEXT PRIMARY KEY,  -- stable signal ID, e.g. "github:pr:crcl-main/wallets-api/3077"
  source           TEXT NOT NULL,     -- "github", "jira", "calendar", etc.
  created_at       TEXT NOT NULL,     -- ISO 8601 — when entry was first observed
  last_surfaced_at TEXT,              -- ISO 8601 — when brain last told the user about this
  last_seen_at     TEXT NOT NULL,     -- ISO 8601 — when scout last observed this entry (for pruning)
  state            TEXT NOT NULL      -- JSON blob of what was surfaced (CI status, review state, etc.)
);

CREATE INDEX surfaced_source ON surfaced(source);
CREATE INDEX surfaced_last_seen ON surfaced(last_seen_at);
```

**Scout behavior**: after writing `scout_results/{name}.json`, each scout also upserts `last_seen_at = now` for every entry it found. Entries not updated in 7 days are pruned on the next scout run (`DELETE WHERE source = ? AND last_seen_at < ?`).

**Brain behavior**: before deciding whether to surface a signal, queries `SELECT state FROM surfaced WHERE id = ?`. Compares current entry against stored state — only surfaces if something meaningful changed. After spawning a worker, updates `last_surfaced_at` and `state`.

**What replaces**: `ci_notified_today`, `notified_meetings`, and any other ad-hoc notification tracking currently in `last_run.json`.

Brain queries only the source it needs — `WHERE source = 'github'` — so context stays bounded even as the table grows.

Dependency: `better-sqlite3` (synchronous, no async complexity for scripts).

### Lock file

```json
{
  "pid": 12345,
  "started_at": "ISO 8601",
  "last_heartbeat": "ISO 8601"
}
```

`franklin.js` updates `last_heartbeat` on each brain tick. On startup: if lock exists and `kill -0 <pid>` succeeds, abort. If PID is dead, proceed (stale lock).

## Implementation Plan

1. **SQLite setup**: add `better-sqlite3` dependency, write `scripts/db.ts` — shared helper that opens `state/franklin.db` and initializes the `surfaced` table.
2. **Pilot scout**: write `scripts/scouts/github.ts` — runs `gh` CLI, writes `scout_results/github.json`, upserts `last_seen_at` to `surfaced`. Test manually. _(done — needs SQLite upsert added)_
2. **Remaining scouts**: slack, jira, gmail, calendar, meet — same pattern.
3. **Brain prompt**: write `modes/brain.md`. Extract reasoning/categorization logic from `RUN.md`. Test with `claude -p < modes/brain.md` against real scout results.
4. **Worker prompts**: write `modes/workers/` — start with `inbox.md` and `pr_monitor.md` as the two highest-volume types.
5. **`franklin.js`**: supervisor — scout timers with phase offsets, brain tick, worker spawning, PID management, SIGTERM handler, status command.
6. **Fold in quest agent status**: update quest agent instructions to write `.agent.json`; brain reads it.
7. **End-to-end test**: start CLI, send a DM, verify brain generates a task, worker sends a reply.
8. **Cut over**: deprecate `modes/RUN.md`, update `README.md`.

## Decisions

- **Worker result folding**: supervisor handles it in JS before spawning the brain. Mechanical bookkeeping with no judgment needed — keeps the brain prompt smaller and its job cleaner.
- **Worker result retention**: delete after folding. Worker summaries are written into quest sidecar logs — no information is lost.
- **Signal deduplication**: SQLite `surfaced` table in `state/franklin.db`. Scouts upsert `last_seen_at`; brain compares `state` blob before surfacing; 7-day TTL pruned by each scout. Replaces all ad-hoc notification tracking in `last_run.json`.

## References

- `modes/RUN.md` — current run loop (source for brain + worker logic)
- `server.js` — existing separate-process model for socket intake
- Proposal-00006 — two-tier agent model this replaces
