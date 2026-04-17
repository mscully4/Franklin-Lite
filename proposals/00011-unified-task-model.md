---
id: proposal-00011
title: Unified Background Task Model
status: implemented
implemented_at: 2026-04-16
created: 2026-04-16
updated: 2026-04-16
---

## Problem

Two separate execution models for the same thing:

- **Workers** block the cycle via `await Promise.allSettled()`, 10-min timeout, results processed inline
- **Quests** are fire-and-forget, 60-min timeout, reaped by `reapQuests()` across cycles

This causes: blocked cycles (a slow dm_reply blocks the next scout run), duplicated lifecycle code (mark_surfaced, inflight removal, dispatch logging all exist in two places), inconsistent prompts (workers get `worker_wrapper.md`, quests get a bare one-liner), and brain complexity (must decide `type: "quest"` vs worker based on expected duration).

## Proposal

Unify into a single **background task** model:

- Everything is fire-and-forget. No task blocks the cycle.
- Brain sets `timeout` per task. Defaults by type (dm_reply: 10m, pr_monitor: 60m).
- One prompt file (`worker_wrapper.md`) for all LLM tasks.
- One result format (`worker_results/<task_id>.json`).
- One reaper (`reapTasks()`) replaces both the inline Promise.allSettled result loop and `reapQuests()`.
- Script tasks (`kind: "script"`) stay synchronous — no benefit to backgrounding a shell one-liner.

## Design

### 1. New DB table: `running_tasks`

Replaces the in-memory `runningQuests` Map and transient `active_workers.json`:

```sql
CREATE TABLE IF NOT EXISTS running_tasks (
  task_id         TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  priority        TEXT NOT NULL,
  pid             INTEGER,
  timeout_ms      INTEGER NOT NULL,
  quest_id        TEXT,
  dispatched_at   TEXT NOT NULL,
  mark_surfaced   TEXT,   -- JSON, deferred until reap
  context         TEXT NOT NULL  -- JSON
);
```

Single source of truth for "what is running right now." Dashboard reads this instead of `active_workers.json`.

### 2. Default timeouts by type

```typescript
const DEFAULT_TIMEOUT_BY_TYPE: Record<string, number> = {
  dm_reply:        10 * 60_000,  // 10 min
  email_notify:     5 * 60_000,  //  5 min
  jira_update:      5 * 60_000,  //  5 min
  pr_monitor:      60 * 60_000,  // 60 min
  quest:           60 * 60_000,  // 60 min
  scheduled:       10 * 60_000,  // 10 min
};
```

Brain can override with `timeout` field on any task.

### 3. Revised dispatch flow

```
dispatchWorkers(delegation):
  for each task:
    if kind === "script":
      runScriptTask(task)        // synchronous, unchanged
      finalizeTask(task, result) // inline
      continue
    spawnBackgroundTask(task)     // fire-and-forget
  // returns immediately — no await
```

`spawnBackgroundTask()` replaces both `spawnWithTimeout()` and `spawnQuestAgent()`:
- Inserts into `running_tasks` table
- Creates quest state file if task type warrants it (multi-step work)
- Spawns claude with: `Read modes/worker_wrapper.md and execute. The task ID is ${task.id}.`
- Registers inflight signals
- Returns immediately

### 4. Unified reaper: `reapTasks()`

Runs at the top of each cycle (where `reapQuests()` runs today):

```
reapTasks():
  for each row in running_tasks:
    if worker_results/<task_id>.json exists → task completed
    else if PID dead → process died without result
    else if elapsed > timeout_ms → kill and timeout
    else → still running, skip

    on completion/death/timeout:
      finalizeTask() handles everything:
        - mark_surfaced (on success)
        - remove inflight signal
        - update scheduled task last_run/fail_count
        - finalize quest file (if applicable)
        - dispatch log entry
        - remove from running_tasks
```

### 5. Dedup: inflight signals

Rename `inflight_prs.json` → `inflight_signals.json`. Populate from `running_tasks` context instead of a separate `inflight_prs` DB table:

```typescript
function writeInflightSignals(): void {
  const tasks = db.getRunningTasks();
  const signals = tasks
    .map(t => JSON.parse(t.context).signal_id)
    .filter(Boolean);
  writeJson("state/brain_input/inflight_signals.json", signals);
}
```

Brain's dedup check (Step 4a) already skips signals in this list — just update the filename reference.

### 6. Scheduled task re-triggering prevention

`generateScheduledTasks()` checks `running_tasks` for any task with matching `scheduled_task_id` in context. If found, skip — it's still in-flight. No schema change needed.

### 7. Quest state files

Tasks that need persistent state (multi-step dev work, deploy approvals) still get a quest file in `state/quests/active/`. The dispatch mechanism is unified; the quest file is a feature of certain task types, not a separate execution model.

`taskNeedsQuestState(task)` returns true for `type: "quest"` and any other types that need cross-step state.

### 8. Brain changes

- Remove the quest-vs-worker framing from Step 7
- Add `timeout` field documentation to Step 9
- Rename `inflight_prs.json` reference to `inflight_signals.json`
- Brain can still emit `type: "quest"` for multi-step work — this signals "create quest state file," not "use different execution model"

## Changes Required

| File | Change |
|------|--------|
| `src/db.ts` | Add `running_tasks` table + helpers |
| `src/task-manager.ts` (new) | `spawnBackgroundTask()`, `reapTasks()`, `finalizeTask()`, `writeInflightSignals()` |
| `franklin.ts` | Remove `Promise.allSettled()` block, remove `spawnWithTimeout()`, call `reapTasks()` + `writeInflightSignals()` |
| `src/quest-manager.ts` | Delete (logic absorbed into `task-manager.ts`) |
| `src/config.ts` | Add `DEFAULT_TIMEOUT_BY_TYPE` |
| `modes/brain.md` | Update dedup file name, add timeout docs, simplify quest framing |
| `modes/worker_wrapper.md` | Add quest state file awareness (load quest file if referenced in prompt) |
| `server.ts` | Read `running_tasks` table instead of `active_workers.json` |

## Migration

**Phase 1 (additive, non-breaking):**
1. Add `running_tasks` table and DB helpers
2. Create `task-manager.ts` with `spawnBackgroundTask()`, `reapTasks()`, `finalizeTask()`
3. Route quest-type tasks through new path; workers still block (old path)
4. Validate reaper works for quests

**Phase 2 (cut over):**
1. Route all non-script tasks through `spawnBackgroundTask()`
2. Remove `Promise.allSettled()` block, `spawnWithTimeout()`, `quest-manager.ts`
3. Update dashboard to read `running_tasks`
4. Rename inflight file, update brain.md

## Decisions

- **Script tasks stay sync**: No LLM involved, typically < 1s. Backgrounding adds complexity for no benefit.
- **Quest files preserved**: The execution model is unified but quest state files remain for tasks that need persistent cross-step state. `type: "quest"` becomes a semantic hint, not an infra fork.
- **mark_surfaced deferred for all tasks**: Consistent with current quest behavior. Inflight signal tracking prevents re-firing.
- **running_tasks in DB, not in-memory**: Survives crashes. Dashboard always accurate. No stale `active_workers.json`.

## References

- `franklin.ts` — current dispatch loop with `Promise.allSettled()`
- `src/quest-manager.ts` — current quest spawn/reap logic
- `modes/brain.md` — brain delegation and dedup
- Proposal 00009 — original process supervisor design
