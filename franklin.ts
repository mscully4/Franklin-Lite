#!/usr/bin/env npx tsx
/**
 * Franklin — Process Supervisor
 *
 * Orchestrates the scout → filter → brain → worker pipeline.
 *
 * Usage:
 *   npx tsx franklin.ts                    Start the supervisor loop
 *   npx tsx franklin.ts status             Print current status and exit
 *   npx tsx franklin.ts --only=github      Run only the github scout
 *   npx tsx franklin.ts --skip=gmail,jira  Skip gmail and jira scouts
 */

import { spawn, spawnSync, execSync } from "child_process";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb } from "./scripts/db.js";
import { z } from "zod";
import { SCOUT_INTERVALS_MS, readJson, readJsonWithSchema, writeJson } from "./scripts/config.js";
import { SettingsSchema, ScheduledTaskSchema, WorkerResultSchema, DelegationSchema } from "./scripts/config.js";
import type { DelegationTask, WorkerResult, DispatchLogEntry, Settings, ScheduledTask, Delegation } from "./scripts/config.js";
import { initQuestManager, spawnQuestAgent, writeInflightPrs, reapQuests } from "./scripts/quest-manager.js";
import log from "./scripts/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const LOCK_FILE = join(ROOT, "state", "franklin.lock");
const DELEGATION_FILE = join(ROOT, "state", "delegation.json");
const LAST_RUN_FILE = join(ROOT, "state", "last_run.json");
const WORKER_RESULTS_DIR = join(ROOT, "state", "worker_results");

const CYCLE_INTERVAL_MS = 30 * 1000;
const LOCK_STALE_MS = 3 * 60 * 1000;
const WORKER_TIMEOUT_MS = 10 * 60_000;
const SCRIPT_TIMEOUT_MS = 60_000; // default for kind: "script" tasks
const ACTIVE_WORKERS_FILE = join(ROOT, "state", "active_workers.json");

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
  github:         { cmd: "gh auth status",                                          label: "GitHub CLI" },
  jira:           { cmd: `test -f ${join(ROOT, "secrets", "jira_api_token.txt")}`,  label: "Jira API token" },
  gmail:          { cmd: "which gws",                                               label: "Gmail (gws CLI)" },
  calendar:       { cmd: "which gws",                                               label: "Calendar (gws CLI)" },
  slack_channels: { cmd: `test -f ${join(ROOT, "secrets", "franklin_user_oauth_token.txt")}`, label: "Slack OAuth token" },
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
    try {
      execSync(`osascript -e 'display notification "${msg}" with title "Franklin ☕" subtitle "Startup aborted" sound name "Blow"'`);
    } catch { /* macOS notification best-effort */ }
    process.exit(1);
  }

  log.info("All health checks passed.");
}

// ── Scout runner ───────────────────────────────────────────────────────────────

function runScout(name: string): void {
  log.info(` Running ${name} scout...`);
  try {
    execSync(`npx tsx scripts/scouts/${name}.ts`, {
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
    execSync("npx tsx scripts/filter-signals.ts", {
      cwd: ROOT,
      stdio: "inherit",
      timeout: 30_000,
    });
  } catch (e: unknown) {
    log.error(` filter-signals failed: ${(e as Error).message?.slice(0, 200)}`);
  }
}

// ── DM task generation ────────────────────────────────────────────────────────
// Deterministic: every DM from an authorized user gets a dm_reply task.
// Channel/group messages only get a task if Franklin is explicitly @-mentioned.
// Does NOT go through the brain — avoids LLM dropping messages.

const FRANKLIN_BOT_USER_ID = "U0AS0UZGW6L";

interface SlackInboxEvent {
  event_ts: string;
  channel: string;
  channel_type: string;
  user_id?: string;
  type: string;
  reaction?: string;
  text?: string;
  thread_ts?: string;
  received_at: string;
}

function fetchThreadContext(channel: string, threadTs: string): string | null {
  try {
    const raw = execSync(
      `npx tsx scripts/slack_conversations.ts thread ${channel} ${threadTs} --json`,
      { cwd: ROOT, timeout: 15_000, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    const messages = JSON.parse(raw) as Array<{ user?: string; text?: string; ts?: string }>;
    // Build a plain-text summary of the thread (parent + replies)
    return messages
      .map((m) => `[${m.user ?? "unknown"}] ${(m.text ?? "").slice(0, 500)}`)
      .join("\n");
  } catch (e: unknown) {
    log.error(` Failed to fetch thread ${channel}/${threadTs}: ${(e as Error).message?.slice(0, 200)}`);
    return null;
  }
}

function generateDmTasks(): DelegationTask[] {
  const inboxFile = join(ROOT, "state", "brain_input", "slack_inbox.json");
  const inbox = readJson<SlackInboxEvent[]>(inboxFile) ?? [];
  if (!inbox.length) return [];

  const settings = readJsonWithSchema(SETTINGS_FILE, SettingsSchema);
  const ownerId = settings?.owner_user_id ?? settings?.user_profile.slack_user_id ?? "";
  const authorizedIds = new Set((settings?.authorized_users ?? []).map((u) => u.slack_user_id));
  const mode = settings?.mode ?? "drafts_only";

  const authDb = openDb();
  const tasks: DelegationTask[] = [];

  for (const event of inbox) {
    if (!event.user_id) continue;

    const result = authDb.isAllowed(event.channel, event.channel_type, event.user_id, ownerId, authorizedIds);
    if (!result.allowed) continue;

    // Trigger mode filtering
    const isAppMention = event.type === "app_mention";
    const isReaction = event.type === "reaction_added";
    const textMentionsFranklin = (event.text ?? "").includes(`<@${FRANKLIN_BOT_USER_ID}>`);

    if (result.triggerMode === "none") continue;
    if (result.triggerMode === "mention" && !isAppMention && !isReaction && !textMentionsFranklin) continue;
    // triggerMode === "all" falls through — process everything

    const isDm = event.channel_type === "im";
    const source_tag =
      isReaction && event.reaction === "whiskey" ? "whiskey" :
      isReaction ? "reaction" :
      isDm ? "dm" :
      isAppMention || textMentionsFranklin ? "mention" : "channel_msg";

    // When the message is a thread reply, fetch the full thread so the worker
    // sees the original request — not just the bare reply text.
    let threadContext: string | null = null;
    if (event.thread_ts && event.thread_ts !== event.event_ts) {
      threadContext = fetchThreadContext(event.channel, event.thread_ts);
    }

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
        reaction: event.reaction ?? null,
        thread_ts: event.thread_ts ?? null,
        thread_context: threadContext,
        source_tag,
        quest_id: null,
        mode,
        max_task_type: result.maxTaskType,
      },
      mark_surfaced: null,
    });
  }

  // Annotate brain_input with max_task_type so the brain knows which events can spawn quests
  const annotatedInbox = inbox.map((event) => {
    if (!event.user_id) return { ...event, max_task_type: null };
    const r = authDb.isAllowed(event.channel, event.channel_type, event.user_id, ownerId, authorizedIds);
    return { ...event, max_task_type: r.allowed ? r.maxTaskType : null };
  });
  writeJson(inboxFile, annotatedInbox);

  authDb.close();

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

function parseInterval(every: string): { intervalMs: number; weekdaysOnly: boolean; dailyOnce: boolean } | null {
  if (every === "weekdays") return { intervalMs: 24 * 60 * 60_000, weekdaysOnly: true, dailyOnce: true };
  if (every === "daily") return { intervalMs: 24 * 60 * 60_000, weekdaysOnly: false, dailyOnce: true };
  if (every === "weekly") return { intervalMs: 7 * 24 * 60 * 60_000, weekdaysOnly: false, dailyOnce: false };

  const match = every.match(/^(\d+)\s*(m|h|d|w)$/);
  if (!match) return null;
  const units: Record<string, number> = { ...INTERVAL_UNITS, w: 7 * 24 * 60 * 60_000 };
  return { intervalMs: parseInt(match[1], 10) * units[match[2]], weekdaysOnly: false, dailyOnce: false };
}

function generateScheduledTasks(): DelegationTask[] {
  const scheduled = readJsonWithSchema(SCHEDULED_TASKS_FILE, z.array(ScheduledTaskSchema)) ?? [];
  if (!scheduled.length) return [];

  const now = new Date();
  const tasks: DelegationTask[] = [];
  let changed = false;

  for (const job of scheduled) {
    const parsed = parseInterval(job.every);
    if (!parsed) {
      log.error(` Bad interval "${job.every}" on scheduled task ${job.id} — skipping`);
      continue;
    }

    if (parsed.weekdaysOnly) {
      const day = now.getDay();
      if (day === 0 || day === 6) continue;
    }

    if (parsed.dailyOnce) {
      // Fire once per day — skip if already ran today (local time)
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const lastRunLocal = job.last_run ? new Date(job.last_run) : null;
      const lastRunDay = lastRunLocal ? `${lastRunLocal.getFullYear()}-${String(lastRunLocal.getMonth() + 1).padStart(2, "0")}-${String(lastRunLocal.getDate()).padStart(2, "0")}` : null;
      if (lastRunDay === today) continue;
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

    job.last_run = now.toISOString();
    changed = true;
  }

  if (changed) {
    writeJson(SCHEDULED_TASKS_FILE, scheduled);
  }

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

// ── Async worker spawn ────────────────────────────────────────────────────────

function spawnWithTimeout(
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd: ROOT, stdio: "inherit" });
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }, 5_000);
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut });
    });
  });
}

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

async function runWorker(task: DelegationTask): Promise<WorkerResult | null> {
  const dispatchedAt = new Date().toISOString();

  // Script tasks run shell commands directly — no LLM
  if (task.kind === "script") return runScriptTask(task);

  // Quest tasks spawn a background agent — don't block the cycle
  if (task.type === "quest") return spawnQuestAgent(task);

  log.info(` Spawning ${task.type} worker for ${task.id}...`);
  mkdirSync(WORKER_RESULTS_DIR, { recursive: true });

  const { exitCode, timedOut } = await spawnWithTimeout(
    ["--dangerously-skip-permissions", "--print", "-p",
      `Read modes/worker_wrapper.md and execute. The task ID is ${task.id}.`],
    WORKER_TIMEOUT_MS,
  );

  const completedAt = new Date().toISOString();

  if (timedOut) {
    log.error(` ${task.type}/${task.id} timed out after ${WORKER_TIMEOUT_MS / 60_000}m — killed`);
    appendDispatchLog({ task_id: task.id, type: task.type, priority: task.priority,
      dispatched_at: dispatchedAt, completed_at: completedAt, status: "timeout", summary: "worker timed out" });
    return null;
  }

  if (exitCode !== 0) {
    log.error(` ${task.type}/${task.id} exited with code ${exitCode}`);
  }

  const workerResult = readJsonWithSchema(join(WORKER_RESULTS_DIR, `${task.id}.json`), WorkerResultSchema);
  appendDispatchLog({ task_id: task.id, type: task.type, priority: task.priority,
    dispatched_at: dispatchedAt, completed_at: completedAt,
    status: workerResult?.status ?? "error", summary: workerResult?.summary ?? null });
  return workerResult;
}

async function dispatchWorkers(delegation: Delegation): Promise<void> {
  // Publish in-flight worker list before spawning so the dashboard can see them
  writeJson(ACTIVE_WORKERS_FILE, {
    updated_at: new Date().toISOString(),
    workers: delegation.tasks.map((t) => ({ task_id: t.id, type: t.type, priority: t.priority, started_at: new Date().toISOString() })),
  });

  // Register pr_monitor tasks as inflight before spawning
  const inflightDb = openDb();
  for (const task of delegation.tasks) {
    if (task.type === "pr_monitor") {
      const signalId = (task.context.signal_id as string) ?? null;
      if (signalId) inflightDb.addInflightPr(signalId, task.id, process.pid);
    }
  }
  inflightDb.close();

  // Run all workers concurrently — allSettled so one failure doesn't kill the rest
  const settled = await Promise.allSettled(delegation.tasks.map((task) => runWorker(task)));

  writeJson(ACTIVE_WORKERS_FILE, { updated_at: new Date().toISOString(), workers: [] });

  const db = openDb();
  for (let i = 0; i < delegation.tasks.length; i++) {
    const task = delegation.tasks[i];
    const outcome = settled[i];
    if (outcome.status === "rejected") {
      log.error(` Worker ${task.id} crashed:`, outcome.reason);
      // Remove from inflight on crash
      if (task.type === "pr_monitor" && task.context.signal_id) {
        db.removeInflightPr(task.context.signal_id as string);
      }
      continue;
    }
    const result = outcome.value;
    if (result?.status === "ok" && task.mark_surfaced) {
      const { id, state } = task.mark_surfaced;
      log.info(` markSurfaced: ${id}`);
      db.markSurfaced(id, state);
    }
    // Remove from inflight when worker completes (success or failure)
    if (task.type === "pr_monitor" && task.context.signal_id) {
      db.removeInflightPr(task.context.signal_id as string);
    }
  }
  db.close();
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

async function runCycle(startedAt: string): Promise<void> {
  const cycleStart = new Date().toISOString();
  log.info(`── Cycle at ${cycleStart} ──`);

  // Update heartbeat
  writeLock(startedAt);

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

  // Check in on quests — finalize completed ones, enforce timeouts
  reapQuests();

  // Generate deterministic tasks
  const dmTasks = generateDmTasks();
  const scheduledTasks = generateScheduledTasks();

  // Write inflight PRs snapshot — prunes stale entries, informs brain of in-progress work
  writeInflightPrs();

  // Brain tick — handles GitHub/Jira/Gmail signals
  runBrain();

  // Merge: dm tasks + scheduled tasks + brain's tasks
  const brainDelegation = readJsonWithSchema(DELEGATION_FILE, DelegationSchema);
  const brainTasks = brainDelegation?.tasks ?? [];
  const allTasks = [...dmTasks, ...scheduledTasks, ...brainTasks];

  // Assign globally unique task IDs from DB
  const idDb = openDb();
  const lastTaskId = idDb.lastTaskId();
  idDb.close();
  const lastNum = lastTaskId?.match(/(\d+)/)?.[1] ? parseInt(lastTaskId.match(/(\d+)/)![1], 10) : 0;
  allTasks.forEach((t, i) => { t.id = `task-${String(lastNum + i + 1).padStart(8, "0")}`; });

  if (allTasks.length) {
    const merged: Delegation = { generated_at: new Date().toISOString(), tasks: allTasks };
    writeJson(DELEGATION_FILE, merged);
    log.info(` Dispatching ${allTasks.length} task(s) (${dmTasks.length} dm, ${scheduledTasks.length} sched, ${brainTasks.length} brain)...`);
    await dispatchWorkers(merged);
  } else {
    log.debug("No tasks this cycle");
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

// --only=github,jira  → run only these scouts
// --skip=gmail,calendar → skip these scouts
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

// Initialize quest manager with root path and dispatch logger
initQuestManager(ROOT, appendDispatchLog);

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
async function loop(): Promise<void> {
  startServer(); // no-op if already running; restarts if it crashed
  await runCycle(startedAt);
  const timer = setTimeout(() => loop(), CYCLE_INTERVAL_MS);
  timer.ref();
}

loop();
