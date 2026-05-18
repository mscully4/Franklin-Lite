# Supervisor Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `franklin.ts` (752 lines) into `src/supervisor/` with four focused modules, leaving `franklin.ts` as a thin entry point.

**Architecture:** Pure refactor — zero behavior change. Extract lock management, scout orchestration, pipeline (brain/dispatch/tasks), and main loop into separate files under `src/supervisor/`. All imports are one-way; no circular deps.

**Tech Stack:** TypeScript, tsx, Node.js child_process

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/supervisor/lock.ts` | Create | Lock file: check, write, delete, read |
| `src/supervisor/scouts.ts` | Create | Scout scheduling, health checks, filter-signals runner, last-run state |
| `src/supervisor/pipeline.ts` | Create | Brain invocation, DM tasks, scheduled tasks, script runner, task dispatch |
| `src/supervisor/index.ts` | Create | Server child, main cycle, status command, CLI parsing, loop |
| `franklin.ts` | Modify | One-line entry point: `import "./src/supervisor/index.js"` |

---

## Task 1: Create `src/supervisor/lock.ts`

**Files:**
- Create: `src/supervisor/lock.ts`

- [ ] **Step 1: Create the file**

```typescript
import { unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readJson, writeJson } from "../config.js";
import log from "../logger.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LOCK_FILE = join(ROOT, "state", "franklin.lock");
const LOCK_STALE_MS = 3 * 60 * 1000;

export interface LockFile {
  pid: number;
  started_at: string;
  last_heartbeat: string;
}

export function readLock(): LockFile | null {
  return readJson<LockFile>(LOCK_FILE);
}

export function checkLock(): boolean {
  const lock = readLock();
  if (!lock) return true;

  const ageMs = Date.now() - new Date(lock.last_heartbeat).getTime();
  if (ageMs >= LOCK_STALE_MS) {
    log.info(` Stale lock (heartbeat ${Math.round(ageMs / 1000)}s old) — overriding.`);
    return true;
  }

  try {
    process.kill(lock.pid, 0);
    return false;
  } catch {
    log.info(` Lock PID ${lock.pid} is dead — overriding.`);
    return true;
  }
}

export function writeLock(startedAt: string): void {
  writeJson(LOCK_FILE, {
    pid: process.pid,
    started_at: startedAt,
    last_heartbeat: new Date().toISOString(),
  });
}

export function deleteLock(): void {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsx --no-cache src/supervisor/lock.ts 2>&1 || true`
Expected: no TypeScript errors (exits with no output or runtime exit, not compilation error)

---

## Task 2: Create `src/supervisor/scouts.ts`

**Files:**
- Create: `src/supervisor/scouts.ts`

- [ ] **Step 1: Create the file**

```typescript
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SCOUT_INTERVALS_MS, readJson, writeJson } from "../config.js";
import log from "../logger.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const LAST_RUN_FILE = join(ROOT, "state", "last_run.json");

export interface LastRun {
  last_run_completed: string | null;
  last_drain_ts: string | null;
  last_prune_date: string | null;
  scout_last_run: Record<string, string>;
}

export function readLastRun(): LastRun {
  return (
    readJson<LastRun>(LAST_RUN_FILE) ?? {
      last_run_completed: null,
      last_drain_ts: null,
      last_prune_date: null,
      scout_last_run: {},
    }
  );
}

export function writeLastRun(lastRun: LastRun): void {
  writeJson(LAST_RUN_FILE, lastRun);
}

export function isScoutDue(name: string, lastRun: LastRun): boolean {
  const lastRanAt = lastRun.scout_last_run[name];
  if (!lastRanAt) return true;
  const intervalMs = SCOUT_INTERVALS_MS[name] ?? Infinity;
  return Date.now() - new Date(lastRanAt).getTime() >= intervalMs;
}

const HEALTH_PROBES: Record<string, { cmd: string; label: string }> = {
  gmail:    { cmd: "which gws", label: "Gmail (gws CLI)" },
  calendar: { cmd: "which gws", label: "Calendar (gws CLI)" },
};

export function runStartupChecks(enabledScouts: string[]): void {
  log.info("Running startup health checks...");
  const failures: string[] = [];

  for (const scout of enabledScouts) {
    const probe = HEALTH_PROBES[scout];
    if (!probe) continue;
    try {
      execSync(probe.cmd, { cwd: ROOT, stdio: "ignore", timeout: 15_000 });
      log.info(` ✓ ${probe.label}`);
    } catch {
      log.error(` ✗ ${probe.label} — unreachable`);
      failures.push(probe.label);
    }
  }

  if (failures.length > 0) {
    log.fatal(`Startup failed — unreachable: ${failures.join(", ")}`);
    process.exit(1);
  }

  log.info("All health checks passed.");
}

export function runScout(name: string): void {
  log.info(` Running ${name} scout...`);
  try {
    execSync(`npx tsx src/scouts/${name}.ts`, {
      cwd: ROOT,
      stdio: "inherit",
      timeout: 120_000,
    });
  } catch (e: unknown) {
    log.error(` ${name} scout failed: ${(e as Error).message?.slice(0, 200)}`);
  }
}

export function runFilterSignals(): void {
  log.info("Running filter-signals...");
  try {
    execSync("npx tsx src/filter-signals.ts", {
      cwd: ROOT,
      stdio: "inherit",
      timeout: 30_000,
    });
  } catch (e: unknown) {
    log.error(` filter-signals failed: ${(e as Error).message?.slice(0, 200)}`);
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsx --no-cache -e "import('./src/supervisor/scouts.js').then(() => console.log('ok'))" 2>&1`
Expected: `ok`

---

## Task 3: Create `src/supervisor/pipeline.ts`

**Files:**
- Create: `src/supervisor/pipeline.ts`

- [ ] **Step 1: Create the file**

```typescript
import { execSync, spawnSync } from "child_process";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { openDb } from "../db.js";
import {
  readJson, readJsonWithSchema, writeJson,
  SettingsSchema, ScheduledTaskSchema, DelegationSchema,
} from "../config.js";
import type { DelegationTask, WorkerResult, DispatchLogEntry, Delegation } from "../config.js";
import { spawnBackgroundTask } from "../task-manager.js";
import { ackSqsMessages } from "../sqs-ack.js";
import log from "../logger.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DELEGATION_FILE = join(ROOT, "state", "delegation.json");
const WORKER_RESULTS_DIR = join(ROOT, "state", "worker_results");
const SETTINGS_FILE = join(ROOT, "state", "settings.json");
const SCHEDULED_TASKS_FILE = join(ROOT, "state", "scheduled_tasks.json");
const SCRIPT_TIMEOUT_MS = 60_000;

type SlackInboxEntry = ReturnType<ReturnType<typeof openDb>["getPendingSlackEvents"]>[number] & {
  thread_context?: Array<{ author: string; text: string; ts: string }> | null;
};

export function appendDispatchLog(entry: DispatchLogEntry): void {
  const logDb = openDb();
  logDb.insertDispatch(entry);
  logDb.close();
}

export function runBrain(): void {
  log.info("Spawning brain...");
  const result = spawnSync(
    "claude",
    [
      "--dangerously-skip-permissions",
      "--print",
      "-p",
      "Read modes/brain.md and execute the instructions exactly. Do not stop until state/delegation.json is written.",
    ],
    { cwd: ROOT, stdio: "inherit", timeout: 5 * 60_000 },
  );

  if (result.status !== 0) {
    log.error(` Brain exited with status ${result.status ?? "timeout"}`);
  }
}

export function generateDmTasks(): DelegationTask[] {
  const inboxFile = join(ROOT, "state", "brain_input", "slack_inbox.json");
  const inbox = readJson<SlackInboxEntry[]>(inboxFile) ?? [];
  if (!inbox.length) return [];

  const settings = readJsonWithSchema(SETTINGS_FILE, SettingsSchema);
  const authorizedIds = new Set(
    (settings?.authorized_users ?? []).map((u) => u.discord_user_id),
  );
  const mode = settings?.mode ?? "drafts_only";

  const tasks: DelegationTask[] = [];

  for (const event of inbox) {
    if (!event.user_id) continue;
    if (!authorizedIds.has(event.user_id)) continue;

    tasks.push({
      id: `dm-${event.event_ts}`,
      type: "dm_reply",
      priority: "high",
      context: {
        event_ts: event.event_ts,
        channel: event.channel,
        channel_type: event.channel_type,
        user_id: event.user_id,
        text: event.text ?? null,
        type: event.type,
        reaction: null,
        thread_ts: event.thread_ts ?? null,
        thread_context: event.thread_context ?? null,
        source_tag: "dm",
        quest_id: null,
        mode,
        max_task_type: "quest",
      },
      mark_surfaced: null,
    });
  }

  const annotatedInbox = inbox.map((event) => {
    if (!event.user_id || !authorizedIds.has(event.user_id)) {
      return { ...event, max_task_type: null };
    }
    return { ...event, max_task_type: "quest" };
  });
  writeJson(inboxFile, annotatedInbox);

  if (tasks.length) {
    log.info(` Generated ${tasks.length} dm_reply task(s) from inbox`);
  }
  return tasks;
}

// ── Scheduled tasks ──────────────────────────────────────────────────────────

const INTERVAL_UNITS: Record<string, number> = {
  m: 60_000,
  h: 60 * 60_000,
  d: 24 * 60 * 60_000,
};

function parseInterval(every: string): { intervalMs: number; weekdaysOnly: boolean; dailyOnce: boolean; afterTime?: { hour: number; minute: number } } | null {
  const timeMatch = every.match(/@(\d{1,2}):(\d{2})$/);
  const afterTime = timeMatch ? { hour: parseInt(timeMatch[1], 10), minute: parseInt(timeMatch[2], 10) } : undefined;
  const base = timeMatch ? every.slice(0, timeMatch.index) : every;

  if (base === "weekdays") return { intervalMs: 24 * 60 * 60_000, weekdaysOnly: true, dailyOnce: true, afterTime };
  if (base === "daily") return { intervalMs: 24 * 60 * 60_000, weekdaysOnly: false, dailyOnce: true, afterTime };
  if (base === "weekly") return { intervalMs: 7 * 24 * 60 * 60_000, weekdaysOnly: false, dailyOnce: false, afterTime };

  const match = base.match(/^(\d+)\s*(m|h|d|w)$/);
  if (!match) return null;
  const units: Record<string, number> = { ...INTERVAL_UNITS, w: 7 * 24 * 60 * 60_000 };
  return { intervalMs: parseInt(match[1], 10) * units[match[2]], weekdaysOnly: false, dailyOnce: false, afterTime };
}

export function generateScheduledTasks(): DelegationTask[] {
  const scheduled = readJsonWithSchema(SCHEDULED_TASKS_FILE, z.array(ScheduledTaskSchema)) ?? [];
  if (!scheduled.length) return [];

  const ownerTz = readJson<{ timezone?: string }>(SETTINGS_FILE)?.timezone ?? "America/Chicago";
  const now = new Date();
  const nowLocal = new Date(now.toLocaleString("en-US", { timeZone: ownerTz }));
  const tasks: DelegationTask[] = [];

  const schedDb = openDb();

  for (const job of scheduled) {
    if (job.disabled) continue;
    if (schedDb.hasRunningTaskWithScheduledId(job.id)) continue;
    const parsed = parseInterval(job.every);
    if (!parsed) {
      log.error(` Bad interval "${job.every}" on scheduled task ${job.id} — skipping`);
      continue;
    }

    if ((job.fail_count ?? 0) >= 3) {
      log.warn(` Scheduled task ${job.id} has failed ${job.fail_count} consecutive times — skipping until manual reset`);
      continue;
    }

    const failCount = job.fail_count ?? 0;
    if (failCount > 0 && job.last_fail) {
      const backoffBase = 5 * 60_000;
      const backoffMs = backoffBase * Math.pow(2, failCount - 1);
      const jitter = Math.random() * backoffMs * 0.3;
      const elapsed = now.getTime() - new Date(job.last_fail).getTime();
      if (elapsed < backoffMs + jitter) continue;
    }

    if (parsed.weekdaysOnly) {
      const day = nowLocal.getDay();
      if (day === 0 || day === 6) continue;
    }

    if (parsed.dailyOnce) {
      const today = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, "0")}-${String(nowLocal.getDate()).padStart(2, "0")}`;
      const lastRunInTz = job.last_run ? new Date(new Date(job.last_run).toLocaleString("en-US", { timeZone: ownerTz })) : null;
      const lastRunDay = lastRunInTz ? `${lastRunInTz.getFullYear()}-${String(lastRunInTz.getMonth() + 1).padStart(2, "0")}-${String(lastRunInTz.getDate()).padStart(2, "0")}` : null;
      if (lastRunDay === today) continue;
      if (parsed.afterTime) {
        const localHour = nowLocal.getHours();
        const localMinute = nowLocal.getMinutes();
        if (localHour < parsed.afterTime.hour || (localHour === parsed.afterTime.hour && localMinute < parsed.afterTime.minute)) continue;
      }
    } else {
      if (job.last_run) {
        const elapsed = now.getTime() - new Date(job.last_run).getTime();
        if (elapsed < parsed.intervalMs) continue;
      }
    }

    tasks.push({
      id: `sched-${job.id}`,
      type: job.type ?? "scheduled",
      priority: job.priority ?? "normal",
      kind: job.kind,
      command: job.command,
      timeout: job.timeout,
      context: { ...job.context, scheduled_task_id: job.id },
      mark_surfaced: null,
    });
  }

  schedDb.close();

  if (tasks.length) {
    log.info(` Generated ${tasks.length} scheduled task(s)`);
  }
  return tasks;
}

export function updateScheduledTaskResult(schedId: string, status: "ok" | "error"): void {
  const scheduled = readJsonWithSchema(SCHEDULED_TASKS_FILE, z.array(ScheduledTaskSchema)) ?? [];
  for (const job of scheduled) {
    if (job.id !== schedId) continue;
    if (status === "ok") {
      job.last_run = new Date().toISOString();
      job.fail_count = 0;
      job.last_fail = null;
      log.info(` Scheduled task ${job.id} succeeded — updated last_run`);
    } else {
      job.fail_count = (job.fail_count ?? 0) + 1;
      job.last_fail = new Date().toISOString();
      log.warn(` Scheduled task ${job.id} failed (fail_count: ${job.fail_count}, next retry in ~${5 * Math.pow(2, job.fail_count - 1)}m)`);
    }
    writeJson(SCHEDULED_TASKS_FILE, scheduled);
    return;
  }
}

// ── Script runner (synchronous, no LLM) ─────────────────────────────────────

function runScriptTask(task: DelegationTask): WorkerResult {
  const dispatchedAt = new Date().toISOString();
  const timeoutMs = task.timeout ?? SCRIPT_TIMEOUT_MS;

  if (!task.command) {
    const result: WorkerResult = {
      task_id: task.id,
      status: "error",
      completed_at: new Date().toISOString(),
      summary: "Script task missing 'command' field",
      error: "no command",
    };
    writeJson(join(WORKER_RESULTS_DIR, `${task.id}.json`), result);
    appendDispatchLog({
      task_id: task.id, type: task.type, priority: task.priority,
      dispatched_at: dispatchedAt, completed_at: result.completed_at,
      status: "error", summary: result.summary,
    });
    return result;
  }

  log.info(` Running script ${task.id}: ${task.command}`);
  mkdirSync(WORKER_RESULTS_DIR, { recursive: true });

  let stdout = "";
  let status: WorkerResult["status"] = "ok";
  let error: string | null = null;
  try {
    stdout = execSync(task.command, {
      cwd: ROOT,
      timeout: timeoutMs,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FRANKLIN_TASK_CONTEXT: JSON.stringify(task.context) },
    }).trim();
  } catch (err: unknown) {
    status = "error";
    const e = err as { status?: number; killed?: boolean; stderr?: string; stdout?: string };
    stdout = (e.stdout ?? "").trim();
    error = e.killed
      ? `timed out after ${timeoutMs / 1000}s`
      : (e.stderr ?? "").trim().slice(-500) || `exit code ${e.status}`;
    log.error(` Script ${task.id} failed:`, error);
  }

  const completedAt = new Date().toISOString();
  const summary = stdout.slice(-500) || (status === "ok" ? "completed" : error);
  const result: WorkerResult = { task_id: task.id, status, completed_at: completedAt, summary: summary ?? "completed", error };

  writeJson(join(WORKER_RESULTS_DIR, `${task.id}.json`), result);
  appendDispatchLog({
    task_id: task.id, type: task.type, priority: task.priority,
    dispatched_at: dispatchedAt, completed_at: completedAt,
    status, summary: result.summary,
  });

  return result;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

export function dispatchTasks(delegation: Delegation): void {
  for (const task of delegation.tasks) {
    if (task.kind === "script") {
      const result = runScriptTask(task);
      if (result.status === "ok" && task.mark_surfaced) {
        const sdb = openDb();
        log.info(` markSurfaced: ${task.mark_surfaced.id}`);
        sdb.markSurfaced(task.mark_surfaced.id, task.mark_surfaced.state);
        sdb.close();
      }
      const sqsId = task.context.sqs_message_id as string | undefined;
      if (result.status === "ok" && sqsId) {
        ackSqsMessages([sqsId]).catch((e: unknown) => {
          log.error(`SQS ack failed for script task ${task.id}: ${(e as Error).message}`);
        });
      }
      const schedId = task.context.scheduled_task_id as string | undefined;
      if (schedId) {
        updateScheduledTaskResult(schedId, result.status === "ok" ? "ok" : "error");
      }
      continue;
    }

    spawnBackgroundTask(task);
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsx --no-cache -e "import('./src/supervisor/pipeline.js').then(() => console.log('ok'))" 2>&1`
Expected: `ok`

---

## Task 4: Create `src/supervisor/index.ts` and slim `franklin.ts`

**Files:**
- Create: `src/supervisor/index.ts`
- Modify: `franklin.ts`

- [ ] **Step 1: Create `src/supervisor/index.ts`**

```typescript
import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SCOUT_INTERVALS_MS, readJson, readJsonWithSchema, writeJson, DelegationSchema } from "../config.js";
import { initTaskManager, reapTasks, writeInflightSignals } from "../task-manager.js";
import { ackSqsMessages } from "../sqs-ack.js";
import { openDb } from "../db.js";
import { checkLock, writeLock, deleteLock, readLock } from "./lock.js";
import { readLastRun, writeLastRun, isScoutDue, runStartupChecks, runScout, runFilterSignals } from "./scouts.js";
import {
  appendDispatchLog, runBrain,
  generateDmTasks, generateScheduledTasks,
  dispatchTasks, updateScheduledTaskResult,
} from "./pipeline.js";
import log from "../logger.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SETTINGS_FILE = join(ROOT, "state", "settings.json");
const DELEGATION_FILE = join(ROOT, "state", "delegation.json");
const CYCLE_INTERVAL_MS = 30 * 1000;

// ── CLI parsing ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const command = args[0];
const cliOnlyScouts = args.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",") ?? null;
const cliSkipScouts = new Set(args.find((a) => a.startsWith("--skip="))?.split("=")[1]?.split(",") ?? []);

// ── Server child process ──────────────────────────────────────────────────
let serverChild: ReturnType<typeof spawn> | null = null;

function startServer(): void {
  if (serverChild && !serverChild.killed) return;
  log.info("Starting server...");
  serverChild = spawn("npx", ["tsx", "server.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    detached: false,
  });
  serverChild.on("exit", (code, signal) => {
    if (signal === "SIGTERM" || signal === "SIGINT") return;
    log.info(` Server exited (code=${code ?? "?"}, signal=${signal ?? "none"}) — will restart next cycle`);
    serverChild = null;
  });
  serverChild.on("error", (err) => {
    log.error(` Server spawn error: ${err.message}`);
    serverChild = null;
  });
}

// ── Status command ──────────────────────────────────────────────────────────
function printStatus(): void {
  const lock = readLock();
  const lastRun = readLastRun();

  log.info("=== Franklin Status ===");

  if (lock) {
    const ageMs = Date.now() - new Date(lock.last_heartbeat).getTime();
    const isAlive = (() => {
      try { process.kill(lock.pid, 0); return true; } catch { return false; }
    })();
    log.info(`PID:            ${lock.pid} (${isAlive ? "alive" : "DEAD"})`);
    log.info(`Started:        ${lock.started_at}`);
    log.info(`Last heartbeat: ${lock.last_heartbeat} (${Math.round(ageMs / 1000)}s ago)`);
  } else {
    log.info("Not running (no lock file)");
  }

  log.info(`Last run completed: ${lastRun.last_run_completed ?? "never"}`);

  if (Object.keys(lastRun.scout_last_run).length > 0) {
    log.info("Scout last run:");
    for (const [scout, ts] of Object.entries(lastRun.scout_last_run)) {
      const ageSec = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
      const nextDueSec = Math.max(0, Math.round(((SCOUT_INTERVALS_MS[scout] ?? 0) - (Date.now() - new Date(ts).getTime())) / 1000));
      log.info(`  ${scout}: last ran ${ageSec}s ago, next in ${nextDueSec}s`);
    }
  }
}

// ── Main cycle ──────────────────────────────────────────────────────────────
function runCycle(startedAt: string): void {
  const cycleStart = new Date().toISOString();
  log.info(`── Cycle at ${cycleStart} ──`);

  writeLock(startedAt);
  const heartbeat = setInterval(() => writeLock(startedAt), 30_000);
  const stopHeartbeat = () => clearInterval(heartbeat);
  try {
    const lastRun = readLastRun();

    const settings = readJson<{ disabled_scouts?: string[] }>(SETTINGS_FILE);
    const disabledScouts = new Set(settings?.disabled_scouts ?? []);
    let anyScoutRan = false;
    for (const scout of Object.keys(SCOUT_INTERVALS_MS)) {
      if (cliOnlyScouts && !cliOnlyScouts.includes(scout)) continue;
      if (cliSkipScouts.has(scout)) continue;
      if (disabledScouts.has(scout)) continue;
      if (isScoutDue(scout, lastRun)) {
        runScout(scout);
        lastRun.scout_last_run[scout] = new Date().toISOString();
        anyScoutRan = true;
      }
    }
    if (!anyScoutRan) log.debug("No scouts due this cycle");

    runFilterSignals();

    const reaped = reapTasks();
    for (const r of reaped.completed) {
      if (r.scheduledTaskId) updateScheduledTaskResult(r.scheduledTaskId, r.status);
    }
    const sqsAcks = reaped.completed
      .filter((r) => r.status === "ok" && r.sqsMessageId)
      .map((r) => r.sqsMessageId!);
    if (sqsAcks.length > 0) {
      ackSqsMessages(sqsAcks).catch((e: unknown) => {
        log.error(`SQS ack failed: ${(e as Error).message?.slice(0, 200)}`);
      });
    }

    const dmTasks = generateDmTasks();
    const scheduledTasks = generateScheduledTasks();
    writeInflightSignals();

    const signals = readJson<unknown[]>(join(ROOT, "state", "brain_input", "signals.json")) ?? [];
    const hasBrainWork = signals.length > 0 || dmTasks.length > 0 || scheduledTasks.length > 0;
    if (hasBrainWork) {
      runBrain();
    } else {
      log.debug("No signals — skipping brain");
    }

    const brainDelegation = readJsonWithSchema(DELEGATION_FILE, DelegationSchema);
    const brainTasks = brainDelegation?.tasks ?? [];
    const allTasks = [...dmTasks, ...scheduledTasks, ...brainTasks];

    if (allTasks.length) {
      const idDb = openDb();
      const ids = idDb.nextTaskIds(allTasks.length);
      idDb.close();
      allTasks.forEach((t, i) => { t.id = ids[i]; });
    }

    if (allTasks.length) {
      const merged = { generated_at: new Date().toISOString(), tasks: allTasks };
      writeJson(DELEGATION_FILE, merged);
      log.info(` Dispatching ${allTasks.length} task(s) (${dmTasks.length} dm, ${scheduledTasks.length} sched, ${brainTasks.length} brain)...`);
      dispatchTasks(merged);
    } else {
      log.debug("No tasks this cycle");
    }

    const markOnly = brainDelegation?.mark_surfaced_only ?? [];
    if (markOnly.length) {
      const msDb = openDb();
      for (const entry of markOnly) {
        log.info(` markSurfacedOnly: ${entry.id}`);
        msDb.markSurfaced(entry.id, entry.state);
      }
      msDb.close();
      log.info(` Marked ${markOnly.length} signal(s) as surfaced (no task dispatched)`);
    }

    const todayLocal = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`;
    if (lastRun.last_prune_date !== todayLocal) {
      const pruneDb = openDb();
      const dispatches = pruneDb.pruneDispatchLog(30);
      const inbox = pruneDb.pruneSlackInbox(2);
      pruneDb.close();
      if (dispatches || inbox) log.info(` Pruned ${dispatches} dispatch entries, ${inbox} inbox events`);
      lastRun.last_prune_date = todayLocal;
    }

    lastRun.last_run_completed = new Date().toISOString();
    writeLastRun(lastRun);

    const elapsedSec = ((Date.now() - new Date(cycleStart).getTime()) / 1000).toFixed(1);
    log.info(` Cycle complete in ${elapsedSec}s`);
  } finally {
    stopHeartbeat();
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

if (command === "status") {
  printStatus();
  process.exit(0);
}

if (!checkLock()) {
  log.error("Another instance is already running. Run `npx tsx franklin.ts status` to check.");
  process.exit(1);
}

mkdirSync(join(ROOT, "state"), { recursive: true });

const settings = readJson<{ disabled_scouts?: string[] }>(SETTINGS_FILE);
const disabledScouts = new Set(settings?.disabled_scouts ?? []);
const enabledScouts = Object.keys(SCOUT_INTERVALS_MS).filter((s) => {
  if (cliOnlyScouts && !cliOnlyScouts.includes(s)) return false;
  if (cliSkipScouts.has(s)) return false;
  if (disabledScouts.has(s)) return false;
  return true;
});
runStartupChecks(enabledScouts);

initTaskManager(ROOT, appendDispatchLog);

const startedAt = new Date().toISOString();
writeLock(startedAt);
log.info(` Starting (PID ${process.pid}) at ${startedAt}`);

function shutdown(signal: string): void {
  log.warn(`${signal} received — shutting down...`);
  if (serverChild) serverChild.kill("SIGTERM");
  deleteLock();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (err) => { log.fatal("Uncaught exception:", err); });
process.on("unhandledRejection", (reason) => { log.fatal("Unhandled rejection:", reason); });

function loop(): void {
  startServer();
  runCycle(startedAt);
  const timer = setTimeout(() => loop(), CYCLE_INTERVAL_MS);
  timer.ref();
}

loop();
```

- [ ] **Step 2: Replace `franklin.ts` with thin entry point**

```typescript
#!/usr/bin/env npx tsx
/**
 * Franklin — Process Supervisor
 *
 * Usage:
 *   npx tsx franklin.ts                    Start the supervisor loop
 *   npx tsx franklin.ts status             Print current status and exit
 *   npx tsx franklin.ts --only=gmail        Run only the gmail scout
 *   npx tsx franklin.ts --skip=calendar    Skip specific scouts
 */
import "./src/supervisor/index.js";
```

---

## Task 5: Verify and commit

- [ ] **Step 1: Run status command (smoke test)**

Run: `npx tsx franklin.ts status 2>&1`
Expected: prints "=== Franklin Status ===" with current state — no TypeScript errors, no uncaught exceptions

- [ ] **Step 2: Run existing tests**

Run: `npx tsx --test src/tests/*.test.ts 2>&1`
Expected: all tests pass (same as before the refactor)

- [ ] **Step 3: Commit**

```bash
git add src/supervisor/lock.ts src/supervisor/scouts.ts src/supervisor/pipeline.ts src/supervisor/index.ts franklin.ts
git commit -m "refactor: split franklin.ts into src/supervisor/ modules

lock.ts — lock file management
scouts.ts — scout scheduling, health checks, filter-signals
pipeline.ts — brain, DM tasks, scheduled tasks, script runner, dispatch
index.ts — server child, main cycle, status command, loop

franklin.ts is now a thin entry point (7 lines)."
```
