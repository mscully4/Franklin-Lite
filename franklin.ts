#!/usr/bin/env npx tsx
/**
 * Franklin — Process Supervisor
 *
 * Orchestrates the scout → filter → brain → worker pipeline.
 *
 * Usage:
 *   npx tsx franklin.ts                    Start the supervisor loop
 *   npx tsx franklin.ts status             Print current status and exit
 *   npx tsx franklin.ts --only=gmail        Run only the gmail scout
 *   npx tsx franklin.ts --skip=calendar    Skip specific scouts
 */

import { spawn, spawnSync, execSync } from "child_process";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb } from "./src/db.js";
import { z } from "zod";
import { SCOUT_INTERVALS_MS, readJson, readJsonWithSchema, writeJson } from "./src/config.js";
import { SettingsSchema, ScheduledTaskSchema, DelegationSchema } from "./src/config.js";
import type { DelegationTask, WorkerResult, DispatchLogEntry, Delegation } from "./src/config.js";
import { initTaskManager, spawnBackgroundTask, reapTasks, writeInflightSignals } from "./src/task-manager.js";
import log from "./src/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const LOCK_FILE = join(ROOT, "state", "franklin.lock");
const DELEGATION_FILE = join(ROOT, "state", "delegation.json");
const LAST_RUN_FILE = join(ROOT, "state", "last_run.json");
const WORKER_RESULTS_DIR = join(ROOT, "state", "worker_results");
const WORKER_LOGS_DIR = join(ROOT, "state", "logs", "workers");

const CYCLE_INTERVAL_MS = 30 * 1000;
const LOCK_STALE_MS = 3 * 60 * 1000;
const SCRIPT_TIMEOUT_MS = 60_000; // default for kind: "script" tasks

const SETTINGS_FILE = join(ROOT, "state", "settings.json");
const SCHEDULED_TASKS_FILE = join(ROOT, "state", "scheduled_tasks.json");


// ── Helpers ────────────────────────────────────────────────────────────────────

// ── Lock file ──────────────────────────────────────────────────────────────────

interface LockFile {
  pid: number;
  started_at: string;
  last_heartbeat: string;
}

/**
 * Returns true if it's safe to start (no live instance running).
 */
function checkLock(): boolean {
  const lock = readJson<LockFile>(LOCK_FILE);
  if (!lock) return true;

  const ageMs = Date.now() - new Date(lock.last_heartbeat).getTime();
  if (ageMs >= LOCK_STALE_MS) {
    log.info(` Stale lock (heartbeat ${Math.round(ageMs / 1000)}s old) — overriding.`);
    return true;
  }

  try {
    process.kill(lock.pid, 0); // throws ESRCH if dead
    return false; // process is alive
  } catch {
    log.info(` Lock PID ${lock.pid} is dead — overriding.`);
    return true;
  }
}

function writeLock(startedAt: string): void {
  writeJson(LOCK_FILE, {
    pid: process.pid,
    started_at: startedAt,
    last_heartbeat: new Date().toISOString(),
  });
}

function deleteLock(): void {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    // ignore
  }
}

// ── Last-run state ─────────────────────────────────────────────────────────────

interface LastRun {
  last_run_completed: string | null;
  last_drain_ts: string | null;
  last_prune_date: string | null;
  scout_last_run: Record<string, string>;
}

function readLastRun(): LastRun {
  return (
    readJson<LastRun>(LAST_RUN_FILE) ?? {
      last_run_completed: null,
      last_drain_ts: null,
      last_prune_date: null,
      scout_last_run: {},
    }
  );
}

function isScoutDue(name: string, lastRun: LastRun): boolean {
  const lastRanAt = lastRun.scout_last_run[name];
  if (!lastRanAt) return true;
  const intervalMs = SCOUT_INTERVALS_MS[name] ?? Infinity;
  return Date.now() - new Date(lastRanAt).getTime() >= intervalMs;
}

// ── Startup health checks ─────────────────────────────────────────────────────

const HEALTH_PROBES: Record<string, { cmd: string; label: string }> = {
  gmail:    { cmd: "which gws",                                               label: "Gmail (gws CLI)" },
  calendar: { cmd: "which gws",                                               label: "Calendar (gws CLI)" },
};

function runStartupChecks(enabledScouts: string[]): void {
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
    const msg = `Startup failed — unreachable: ${failures.join(", ")}`;
    log.fatal(msg);
    process.exit(1);
  }

  log.info("All health checks passed.");
}

// ── Scout runner ───────────────────────────────────────────────────────────────

function runScout(name: string): void {
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

function runFilterSignals(): void {
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

// ── DM task generation ────────────────────────────────────────────────────────
// Deterministic: every DM from an authorized Telegram user gets a dm_reply task.
// Auth is enforced at intake in server.ts — only authorized IDs ever reach the file.
// Does NOT go through the brain — avoids LLM dropping messages.

interface SlackInboxEvent {
  event_ts: string;
  channel: string;
  channel_type: string;
  user_id?: string;
  type: string;
  reaction?: string;
  text?: string;
  thread_ts?: string;
  thread_context?: Array<{ author: string; text: string; ts: string }> | null;
  received_at: string;
}

function generateDmTasks(): DelegationTask[] {
  const inboxFile = join(ROOT, "state", "brain_input", "slack_inbox.json");
  const inbox = readJson<SlackInboxEvent[]>(inboxFile) ?? [];
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
  // Strip optional @HH:MM suffix (e.g. "weekdays@08:00", "daily@09:30")
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

function generateScheduledTasks(): DelegationTask[] {
  const scheduled = readJsonWithSchema(SCHEDULED_TASKS_FILE, z.array(ScheduledTaskSchema)) ?? [];
  if (!scheduled.length) return [];

  // Use owner's timezone for day-of-week and "today" calculations.
  // System is UTC, but scheduled tasks should respect the user's local time.
  const ownerTz = readJson<{ timezone?: string; user_profile?: { timezone?: string } }>(SETTINGS_FILE)?.timezone ?? "America/Chicago";
  const now = new Date();
  const nowLocal = new Date(now.toLocaleString("en-US", { timeZone: ownerTz }));
  const tasks: DelegationTask[] = [];
  let changed = false;

  // Open DB once to check for in-flight scheduled tasks
  const schedDb = openDb();

  for (const job of scheduled) {
    if (job.disabled) continue;
    // Skip if this scheduled task is already running (background task not yet reaped)
    if (schedDb.hasRunningTaskWithScheduledId(job.id)) continue;
    const parsed = parseInterval(job.every);
    if (!parsed) {
      log.error(` Bad interval "${job.every}" on scheduled task ${job.id} — skipping`);
      continue;
    }

    // Skip tasks that have failed 3+ consecutive times — wait for manual reset
    if ((job.fail_count ?? 0) >= 3) {
      log.warn(` Scheduled task ${job.id} has failed ${job.fail_count} consecutive times — skipping until manual reset`);
      continue;
    }

    // Exponential backoff with jitter for failed tasks: 5m, 10m, 20m...
    const failCount = job.fail_count ?? 0;
    if (failCount > 0 && job.last_fail) {
      const backoffBase = 5 * 60_000; // 5 minutes
      const backoffMs = backoffBase * Math.pow(2, failCount - 1);
      const jitter = Math.random() * backoffMs * 0.3; // up to 30% jitter
      const elapsed = now.getTime() - new Date(job.last_fail).getTime();
      if (elapsed < backoffMs + jitter) continue;
    }

    if (parsed.weekdaysOnly) {
      const day = nowLocal.getDay();
      if (day === 0 || day === 6) continue;
    }

    if (parsed.dailyOnce) {
      // Fire once per day — skip if already ran today (owner's local time)
      const today = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, "0")}-${String(nowLocal.getDate()).padStart(2, "0")}`;
      const lastRunInTz = job.last_run ? new Date(new Date(job.last_run).toLocaleString("en-US", { timeZone: ownerTz })) : null;
      const lastRunDay = lastRunInTz ? `${lastRunInTz.getFullYear()}-${String(lastRunInTz.getMonth() + 1).padStart(2, "0")}-${String(lastRunInTz.getDate()).padStart(2, "0")}` : null;
      if (lastRunDay === today) continue;
      // If an @HH:MM time is specified, don't fire until that local time
      if (parsed.afterTime) {
        const localHour = nowLocal.getHours();
        const localMinute = nowLocal.getMinutes();
        if (localHour < parsed.afterTime.hour || (localHour === parsed.afterTime.hour && localMinute < parsed.afterTime.minute)) continue;
      }
    } else {
      // Interval-based — due if never run, or interval has elapsed
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

// ── Brain ──────────────────────────────────────────────────────────────────────

function runBrain(): void {
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

// ── Worker dispatch ────────────────────────────────────────────────────────────

// ── Dispatch log ──────────────────────────────────────────────────────────────

function appendDispatchLog(entry: DispatchLogEntry): void {
  const logDb = openDb();
  logDb.insertDispatch(entry);
  logDb.close();
}

// ── Script task runner (synchronous, no LLM) ────────────────────────────────

function runScriptTask(task: DelegationTask): WorkerResult {
  const dispatchedAt = new Date().toISOString();
  const timeoutMs = task.timeout ?? SCRIPT_TIMEOUT_MS;

  if (!task.command) {
    const result: WorkerResult = { task_id: task.id, status: "error", completed_at: new Date().toISOString(),
      summary: "Script task missing 'command' field", error: "no command" };
    writeJson(join(WORKER_RESULTS_DIR, `${task.id}.json`), result);
    appendDispatchLog({ task_id: task.id, type: task.type, priority: task.priority,
      dispatched_at: dispatchedAt, completed_at: result.completed_at, status: "error", summary: result.summary });
    return result;
  }

  log.info(` Running script ${task.id}: ${task.command}`);
  mkdirSync(WORKER_RESULTS_DIR, { recursive: true });

  let stdout = "";
  let status: WorkerResult["status"] = "ok";
  let error: string | null = null;
  try {
    stdout = execSync(task.command, { cwd: ROOT, timeout: timeoutMs, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err: unknown) {
    status = "error";
    const e = err as { status?: number; killed?: boolean; stderr?: string; stdout?: string };
    stdout = (e.stdout ?? "").trim();
    error = e.killed ? `timed out after ${timeoutMs / 1000}s` : (e.stderr ?? "").trim().slice(-500) || `exit code ${e.status}`;
    log.error(` Script ${task.id} failed:`, error);
  }

  const completedAt = new Date().toISOString();
  const summary = stdout.slice(-500) || (status === "ok" ? "completed" : error);
  const result: WorkerResult = { task_id: task.id, status, completed_at: completedAt, summary: summary ?? "completed", error };

  writeJson(join(WORKER_RESULTS_DIR, `${task.id}.json`), result);
  appendDispatchLog({ task_id: task.id, type: task.type, priority: task.priority,
    dispatched_at: dispatchedAt, completed_at: completedAt, status, summary: result.summary });

  return result;
}

// ── Dispatch — fire-and-forget for LLM tasks, sync for scripts ──────────────

function dispatchTasks(delegation: Delegation): void {
  for (const task of delegation.tasks) {
    if (task.kind === "script") {
      // Script tasks run synchronously — no LLM involved
      const result = runScriptTask(task);
      // Apply mark_surfaced inline for scripts (they complete immediately)
      if (result.status === "ok" && task.mark_surfaced) {
        const sdb = openDb();
        log.info(` markSurfaced: ${task.mark_surfaced.id}`);
        sdb.markSurfaced(task.mark_surfaced.id, task.mark_surfaced.state);
        sdb.close();
      }
      // Update scheduled task bookkeeping inline for scripts
      const schedId = task.context.scheduled_task_id as string | undefined;
      if (schedId) {
        updateScheduledTaskResult(schedId, result.status === "ok" ? "ok" : "error");
      }
      continue;
    }

    // Everything else is fire-and-forget — reaper collects results next cycle
    spawnBackgroundTask(task);
  }
}

// ── Scheduled task result bookkeeping ───────────────────────────────────────

function updateScheduledTaskResult(schedId: string, status: "ok" | "error"): void {
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

// ── Server child process ──────────────────────────────────────────────────────

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
    if (signal === "SIGTERM" || signal === "SIGINT") return; // intentional shutdown
    log.info(` Server exited (code=${code ?? "?"}, signal=${signal ?? "none"}) — will restart next cycle`);
    serverChild = null;
  });

  serverChild.on("error", (err) => {
    log.error(` Server spawn error: ${err.message}`);
    serverChild = null;
  });
}

// ── Cycle ──────────────────────────────────────────────────────────────────────

function runCycle(startedAt: string): void {
  const cycleStart = new Date().toISOString();
  log.info(`── Cycle at ${cycleStart} ──`);

  // Keep heartbeat fresh throughout the cycle — scouts, brain, and workers
  // can block for many minutes; a single write at cycle-start goes stale.
  writeLock(startedAt);
  const heartbeat = setInterval(() => writeLock(startedAt), 30_000);
  const stopHeartbeat = () => clearInterval(heartbeat);
  try {

  const lastRun = readLastRun();

  // Run due scouts (respect --only, --skip, and settings.disabled_scouts)
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

  if (!anyScoutRan) {
    log.debug("No scouts due this cycle");
  }

  // filter-signals always runs (drains slack inbox each cycle)
  runFilterSignals();

  // Reap completed/failed/timed-out background tasks from previous cycles
  const reaped = reapTasks();

  // Update scheduled task bookkeeping for reaped background tasks
  for (const r of reaped.completed) {
    if (r.scheduledTaskId) {
      updateScheduledTaskResult(r.scheduledTaskId, r.status);
    }
  }

  // Generate deterministic tasks
  const dmTasks = generateDmTasks();
  const scheduledTasks = generateScheduledTasks();

  // Write inflight signals snapshot — informs brain of in-progress work
  writeInflightSignals();

  // Brain tick — only run if there's something to process
  const signals = readJson<unknown[]>(join(ROOT, "state", "brain_input", "signals.json")) ?? [];
  const hasBrainWork = signals.length > 0 || dmTasks.length > 0 || scheduledTasks.length > 0;
  if (hasBrainWork) {
    runBrain();
  } else {
    log.debug("No signals — skipping brain");
  }

  // Merge: dm tasks + scheduled tasks + brain's tasks
  const brainDelegation = readJsonWithSchema(DELEGATION_FILE, DelegationSchema);
  const brainTasks = brainDelegation?.tasks ?? [];
  const allTasks = [...dmTasks, ...scheduledTasks, ...brainTasks];

  // Assign globally unique task IDs from DB counter (atomic across processes)
  if (allTasks.length) {
    const idDb = openDb();
    const ids = idDb.nextTaskIds(allTasks.length);
    idDb.close();
    allTasks.forEach((t, i) => { t.id = ids[i]; });
  }

  if (allTasks.length) {
    const merged: Delegation = { generated_at: new Date().toISOString(), tasks: allTasks };
    writeJson(DELEGATION_FILE, merged);
    log.info(` Dispatching ${allTasks.length} task(s) (${dmTasks.length} dm, ${scheduledTasks.length} sched, ${brainTasks.length} brain)...`);
    dispatchTasks(merged);
  } else {
    log.debug("No tasks this cycle");
  }

  // Process mark_surfaced_only — advance signal state without dispatching tasks
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

  // Daily housekeeping — prune old data (once per day)
  const todayLocal = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`;
  if (lastRun.last_prune_date !== todayLocal) {
    const pruneDb = openDb();
    const dispatches = pruneDb.pruneDispatchLog(30);
    const inbox = pruneDb.pruneSlackInbox(2);
    pruneDb.close();
    if (dispatches || inbox) {
      log.info(` Pruned ${dispatches} dispatch entries, ${inbox} inbox events`);
    }
    lastRun.last_prune_date = todayLocal;
  }

  // Write last_run
  lastRun.last_run_completed = new Date().toISOString();
  writeJson(LAST_RUN_FILE, lastRun);

  const elapsedSec = ((Date.now() - new Date(cycleStart).getTime()) / 1000).toFixed(1);
  log.info(` Cycle complete in ${elapsedSec}s`);
  } finally {
    stopHeartbeat();
  }
}

// ── Status command ─────────────────────────────────────────────────────────────

function printStatus(): void {
  const lock = readJson<LockFile>(LOCK_FILE);
  const lastRun = readLastRun();

  log.info("=== Franklin Status ===");

  if (lock) {
    const ageMs = Date.now() - new Date(lock.last_heartbeat).getTime();
    const isAlive = (() => {
      try {
        process.kill(lock.pid, 0);
        return true;
      } catch {
        return false;
      }
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

// ── Main ───────────────────────────────────────────────────────────────────────

// ── CLI parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

// --only=gmail,calendar  → run only these scouts
// --skip=gmail           → skip these scouts
const cliOnlyScouts = args.find((a) => a.startsWith("--only="))?.split("=")[1]?.split(",") ?? null;
const cliSkipScouts = new Set(args.find((a) => a.startsWith("--skip="))?.split("=")[1]?.split(",") ?? []);

if (command === "status") {
  printStatus();
  process.exit(0);
}

if (!checkLock()) {
  log.error("Another instance is already running. Run `npx tsx franklin.ts status` to check.");
  process.exit(1);
}

mkdirSync(join(ROOT, "state"), { recursive: true });

// Determine which scouts are enabled and run health checks
const settings = readJson<{ disabled_scouts?: string[] }>(SETTINGS_FILE);
const disabledScouts = new Set(settings?.disabled_scouts ?? []);
const enabledScouts = Object.keys(SCOUT_INTERVALS_MS).filter((s) => {
  if (cliOnlyScouts && !cliOnlyScouts.includes(s)) return false;
  if (cliSkipScouts.has(s)) return false;
  if (disabledScouts.has(s)) return false;
  return true;
});
runStartupChecks(enabledScouts);

// Initialize task manager with root path and dispatch logger
initTaskManager(ROOT, appendDispatchLog);

const startedAt = new Date().toISOString();
writeLock(startedAt);
log.info(` Starting (PID ${process.pid}) at ${startedAt}`);

// Graceful shutdown
function shutdown(signal: string): void {
  log.warn(`${signal} received — shutting down...`);
  if (serverChild) {
    serverChild.kill("SIGTERM");
  }
  deleteLock();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  log.fatal("Uncaught exception:", err);
  // Keep running — don't let a transient error kill the loop
});

process.on("unhandledRejection", (reason) => {
  log.fatal("Unhandled rejection:", reason);
});

// Run cycles sequentially with a fixed gap between completions.
// Using setTimeout chains (not setInterval) prevents overlapping cycles if a
// cycle takes longer than CYCLE_INTERVAL_MS.
function loop(): void {
  startServer(); // no-op if already running; restarts if it crashed
  runCycle(startedAt);
  const timer = setTimeout(() => loop(), CYCLE_INTERVAL_MS);
  timer.ref();
}

loop();
