---
id: proposal-00006
title: Sub-Agent Loop Architecture — Fresh Context Per Cycle + Background Quest Agents
status: implemented
created: 2026-04-06
updated: 2026-04-06
implemented_at: 2026-04-06
---

## Problem

The current run loop accumulates context in a single Claude Code session indefinitely. Two consequences:

1. **Context bloat** — every cycle adds scout results, quest state, and message history to the same window. Eventually performance degrades and the session must be manually restarted.
2. **Loop blocking** — long-running quests (code changes, PR reviews) execute inline, stalling the polling loop for 10+ minutes.

## Proposal

Replace the single-agent loop with a two-tier model.

### Tier 1 — Cycle Agent (fresh context per cycle)

The main scheduler becomes a thin loop. Each minute it:

1. Checks `state/franklin.lock` for overlap (another cycle still running)
2. Reads `state/last_run.json`, `state/settings.json`, and active quest file summaries
3. Spawns a **cycle sub-agent** with that state as input
4. Waits for the cycle agent to finish, then repeats

The cycle agent runs all due scouts, categorizes messages, dispatches work, and exits. No state lives in the main agent's context between cycles — every cycle starts clean.

### Tier 2 — Quest Agents (background, long-running)

For quests requiring extended work (code changes, PR reviews, multi-step tasks), the cycle agent does not execute them inline. Instead:

1. Cycle agent spawns a quest sub-agent with `run_in_background: true`
2. The `Agent` tool returns a `task_id` — the cycle agent writes it to the quest file:
   ```json
   "agent_task_id": "abc123",
   "agent_status": "running"
   ```
3. Cycle agent exits — the loop is never blocked

Each subsequent cycle, for any quest with `agent_status: "running"`:

1. Call `TaskOutput(task_id, block=false)`
2. **Still running** → skip, continue with other work
3. **Completed** → parse result, DM user with summary, set `agent_status: null`, clear `agent_task_id`
4. **Error (stale ID)** → task IDs don't survive session restarts; if `TaskOutput` errors, clear `agent_task_id`, set `agent_status: null`, re-spawn the quest agent

## Design

### Quest schema additions

```json
"agent_task_id": "string or null",
"agent_status": "running | null"
```

### What the main scheduler holds

Only two things need to persist in the scheduler's context:
- The 1-minute `CronCreate` job (or a sleep loop)
- The lock file path

Everything else — quest state, settings, timestamps — lives on disk and is re-read each cycle.

### Cycle agent inputs

Passed as prompt context at spawn time:
- Full contents of `state/last_run.json`
- Full contents of `state/settings.json`
- Summary of each active quest file (id, status, objective, agent_status, agent_task_id)

The cycle agent loads full quest files and logs only when actively working a quest.

## Implementation Plan

1. Update `modes/RUN.md`:
   - Replace the run loop description with the two-tier model
   - Add quest polling logic (TaskOutput check for running quests)
   - Document stale ID recovery
2. Update quest schema in `modes/RUN.md` with `agent_task_id` and `agent_status` fields
3. Update the startup checklist — the main scheduler only writes the lock; the cycle agent updates heartbeat

## Open Questions

- Should the cycle agent also update `franklin.lock` heartbeat, or does the scheduler handle it? (Probably the scheduler, since it's the persistent process.)
- What's the right timeout before assuming a quest agent is hung and re-spawning?

## References

- `modes/RUN.md` — run loop, quest schema, scout scheduling
- `state/quests/` — quest file format
