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
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb } from "./scripts/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const LOCK_FILE = join(ROOT, "state", "franklin.lock");
const DELEGATION_FILE = join(ROOT, "state", "delegation.json");
const LAST_RUN_FILE = join(ROOT, "state", "last_run.json");
const WORKER_RESULTS_DIR = join(ROOT, "state", "worker_results");

const CYCLE_INTERVAL_MS = 30 * 1000;
const LOCK_STALE_MS = 3 * 60 * 1000;
const WORKER_TIMEOUT_MS = 10 * 60_000;
const DISPATCH_LOG = join(ROOT, "state", "dispatch_log.jsonl");
const ACTIVE_WORKERS_FILE = join(ROOT, "state", "active_workers.json");

// Scout intervals in ms — add new scouts here
const SCOUT_INTERVALS_MS: Record<string, number> = {
  github: 10 * 60 * 1000,
  jira: 10 * 60 * 1000,
  gmail: 15 * 60 * 1000,
  calendar: 10 * 60 * 1000,
};

const SETTINGS_FILE = join(ROOT, "state", "settings.json");
const SCHEDULED_TASKS_FILE = join(ROOT, "state", "scheduled_tasks.json");


// ── JSON helpers ───────────────────────────────────────────────────────────────

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

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
    console.log(`[franklin] Stale lock (heartbeat ${Math.round(ageMs / 1000)}s old) — overriding.`);
    return true;
  }

  try {
    process.kill(lock.pid, 0); // throws ESRCH if dead
    return false; // process is alive
  } catch {
    console.log(`[franklin] Lock PID ${lock.pid} is dead — overriding.`);
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

// ── Scout runner ───────────────────────────────────────────────────────────────

function runScout(name: string): void {
  console.log(`[franklin] Running ${name} scout...`);
  try {
    execSync(`npx tsx scripts/scouts/${name}.ts`, {
      cwd: ROOT,
      stdio: "inherit",
      timeout: 120_000,
    });
  } catch (e: unknown) {
    console.error(`[franklin] ${name} scout failed: ${(e as Error).message?.slice(0, 200)}`);
  }
}

function runFilterSignals(): void {
  console.log("[franklin] Running filter-signals...");
  try {
    execSync("npx tsx scripts/filter-signals.ts", {
      cwd: ROOT,
      stdio: "inherit",
      timeout: 30_000,
    });
  } catch (e: unknown) {
    console.error(`[franklin] filter-signals failed: ${(e as Error).message?.slice(0, 200)}`);
  }
}

// ── DM task generation ────────────────────────────────────────────────────────
// Deterministic: every DM from an authorized user gets a dm_reply task.
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
  received_at: string;
}

interface Settings {
  authorized_users: Array<{ slack_user_id: string; name: string }>;
  mode?: string;
}

function generateDmTasks(): DelegationTask[] {
  const inbox = readJson<SlackInboxEvent[]>(join(ROOT, "state", "brain_input", "slack_inbox.json")) ?? [];
  if (!inbox.length) return [];

  const settings = readJson<Settings>(SETTINGS_FILE);
  const authorizedIds = new Set((settings?.authorized_users ?? []).map((u) => u.slack_user_id));
  const mode = (settings as unknown as Record<string, unknown>)?.mode as string ?? "drafts_only";

  const tasks: DelegationTask[] = [];

  for (const event of inbox) {
    if (!event.user_id || !authorizedIds.has(event.user_id)) continue;

    const source_tag =
      event.type === "reaction_added" ? "whiskey" :
      event.channel_type === "im" ? "dm" :
      event.type === "app_mention" ? "mention" : "channel_msg";

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
        source_tag,
        quest_id: null,
        mode,
      },
      mark_surfaced: null,
    });
  }

  if (tasks.length) {
    console.log(`[franklin] Generated ${tasks.length} dm_reply task(s) from inbox`);
  }
  return tasks;
}

// ── Scheduled tasks ──────────────────────────────────────────────────────────

interface ScheduledTask {
  id: string;
  every: string;        // human-readable interval: "24h", "30m", "7d", "weekdays"
  type: string;
  priority: string;
  context: Record<string, unknown>;
  last_run?: string;    // ISO 8601 — tracked in the file itself
}

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
  const scheduled = readJson<ScheduledTask[]>(SCHEDULED_TASKS_FILE) ?? [];
  if (!scheduled.length) return [];

  const now = new Date();
  const tasks: DelegationTask[] = [];
  let changed = false;

  for (const job of scheduled) {
    const parsed = parseInterval(job.every);
    if (!parsed) {
      console.error(`[franklin] Bad interval "${job.every}" on scheduled task ${job.id} — skipping`);
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
    console.log(`[franklin] Generated ${tasks.length} scheduled task(s)`);
  }
  return tasks;
}

// ── Brain ──────────────────────────────────────────────────────────────────────

function runBrain(): void {
  console.log("[franklin] Spawning brain...");
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
    console.error(`[franklin] Brain exited with status ${result.status ?? "timeout"}`);
  }
}

// ── Worker dispatch ────────────────────────────────────────────────────────────

interface DelegationTask {
  id: string;
  type: string;
  priority: string;
  context: Record<string, unknown>;
  mark_surfaced: { id: string; state: Record<string, unknown> } | null;
}

interface Delegation {
  generated_at: string;
  tasks: DelegationTask[];
}

interface WorkerResult {
  task_id: string;
  status: "ok" | "error" | "skipped" | "needs_info";
  completed_at: string;
  summary: string;
  error: string | null;
}

// ── Dispatch log ──────────────────────────────────────────────────────────────

interface DispatchLogEntry {
  task_id: string;
  type: string;
  priority: string;
  dispatched_at: string;
  completed_at: string;
  status: "ok" | "error" | "skipped" | "timeout" | "no_worker" | "needs_info";
  summary: string | null;
}

function appendDispatchLog(entry: DispatchLogEntry): void {
  // Write to both DB and JSONL (JSONL kept for backward compat with dashboard until migrated)
  appendFileSync(DISPATCH_LOG, JSON.stringify(entry) + "\n");
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

async function runQuestAgent(task: DelegationTask): Promise<WorkerResult | null> {
  const dispatchedAt = new Date().toISOString();
  const ctx = task.context;

  const activeDir = join(ROOT, "state", "quests", "active");
  const completedDir = join(ROOT, "state", "quests", "completed");
  mkdirSync(activeDir, { recursive: true });
  mkdirSync(completedDir, { recursive: true });

  // Get next quest ID from DB
  const questDb0 = openDb();
  const questId = questDb0.nextQuestId();
  questDb0.close();

  const questFile = join(activeDir, `${questId}.json`);
  writeJson(questFile, {
    $schema: "quest-schema",
    id: questId,
    status: "active",
    created_at: dispatchedAt,
    updated_at: dispatchedAt,
    requested_by: "franklin_brain",
    source: { platform: "delegation", task_id: task.id },
    objective: ctx.objective ?? "No objective specified",
    approach: ctx.approach ?? [],
    approval: { status: "auto_approved" },
    sandbox_path: ctx.sandbox_path ?? null,
    pr_url: null,
    outcome: null,
    skill_updates: [],
    agent_status: "running",
  });

  // Persist to DB
  const questDb = openDb();
  questDb.upsertQuest({
    id: questId,
    status: "active",
    objective: (ctx.objective as string) ?? "No objective specified",
    approach: (ctx.approach as string[]) ?? [],
    requested_by: "franklin_brain",
    source_platform: "delegation",
    source_task_id: task.id,
    agent_status: "running",
  });
  questDb.close();

  console.log(`[franklin] Created ${questId} — spawning quest agent...`);

  const agentStatusFile = join(activeDir, `${questId}.agent.json`);
  writeJson(agentStatusFile, { status: "running", started_at: dispatchedAt, completed_at: null, result: null, error: null });

  const { exitCode, timedOut } = await spawnWithTimeout(
    ["--dangerously-skip-permissions", "--print", "-p",
      `You are Franklin. Read state/quests/active/${questId}.json and execute the quest objective to completion. When done, write state/quests/active/${questId}.agent.json with status "completed" and a result summary.`],
    WORKER_TIMEOUT_MS * 6, // quests get 60 min
  );

  const completedAt = new Date().toISOString();
  const agentStatus = readJson<{ status: string; result: string | null }>(agentStatusFile);

  const finalStatus = timedOut ? "timeout" : exitCode === 0 ? "ok" : "error";
  const questFinalStatus = timedOut ? "failed" : exitCode === 0 ? "completed" : "failed";

  // Update DB
  const questDb2 = openDb();
  questDb2.updateQuestStatus(questId, questFinalStatus, {
    agent_status: finalStatus === "ok" ? "completed" : "failed",
    outcome: agentStatus?.result ?? (timedOut ? "timed out" : null),
  });
  questDb2.close();

  appendDispatchLog({ task_id: task.id, type: task.type, priority: task.priority,
    dispatched_at: dispatchedAt, completed_at: completedAt,
    status: finalStatus,
    summary: agentStatus?.result ?? (timedOut ? "quest agent timed out" : null) });

  return {
    task_id: task.id,
    status: timedOut ? "error" : exitCode === 0 ? "ok" : "error",
    completed_at: completedAt,
    summary: agentStatus?.result ?? `Quest ${questId} ${timedOut ? "timed out" : "completed"}`,
    error: timedOut ? "timed out" : null,
  };
}

async function runWorker(task: DelegationTask): Promise<WorkerResult | null> {
  const dispatchedAt = new Date().toISOString();

  // Quest tasks get their own long-running agent, not a worker
  if (task.type === "quest") return runQuestAgent(task);

  console.log(`[franklin] Spawning ${task.type} worker for ${task.id}...`);
  mkdirSync(WORKER_RESULTS_DIR, { recursive: true });

  const { exitCode, timedOut } = await spawnWithTimeout(
    ["--dangerously-skip-permissions", "--print", "-p",
      `Read modes/worker_wrapper.md and execute. The task ID is ${task.id}.`],
    WORKER_TIMEOUT_MS,
  );

  const completedAt = new Date().toISOString();

  if (timedOut) {
    console.error(`[franklin] ${task.type}/${task.id} timed out after ${WORKER_TIMEOUT_MS / 60_000}m — killed`);
    appendDispatchLog({ task_id: task.id, type: task.type, priority: task.priority,
      dispatched_at: dispatchedAt, completed_at: completedAt, status: "timeout", summary: "worker timed out" });
    return null;
  }

  if (exitCode !== 0) {
    console.error(`[franklin] ${task.type}/${task.id} exited with code ${exitCode}`);
  }

  const workerResult = readJson<WorkerResult>(join(WORKER_RESULTS_DIR, `${task.id}.json`));
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

  // Run all workers concurrently — each writes to its own result file, SQLite WAL handles DB contention
  const results = await Promise.all(delegation.tasks.map((task) => runWorker(task)));

  writeJson(ACTIVE_WORKERS_FILE, { updated_at: new Date().toISOString(), workers: [] });

  const db = openDb();
  for (let i = 0; i < delegation.tasks.length; i++) {
    const task = delegation.tasks[i];
    const result = results[i];
    if (result?.status === "ok" && task.mark_surfaced) {
      const { id, state } = task.mark_surfaced;
      console.log(`[franklin] markSurfaced: ${id}`);
      db.markSurfaced(id, state);
    }
  }
  db.close();
}

// ── Server child process ──────────────────────────────────────────────────────

let serverChild: ReturnType<typeof spawn> | null = null;

function startServer(): void {
  if (serverChild && !serverChild.killed) return;

  console.log("[franklin] Starting server...");
  serverChild = spawn("npx", ["tsx", "server.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    detached: false,
  });

  serverChild.on("exit", (code, signal) => {
    if (signal === "SIGTERM" || signal === "SIGINT") return; // intentional shutdown
    console.log(`[franklin] Server exited (code=${code ?? "?"}, signal=${signal ?? "none"}) — will restart next cycle`);
    serverChild = null;
  });

  serverChild.on("error", (err) => {
    console.error(`[franklin] Server spawn error: ${err.message}`);
    serverChild = null;
  });
}

// ── Cycle ──────────────────────────────────────────────────────────────────────

async function runCycle(startedAt: string): Promise<void> {
  const cycleStart = new Date().toISOString();
  console.log(`\n[franklin] ── Cycle at ${cycleStart} ──`);

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
    console.log("[franklin] No scouts due this cycle");
  }

  // filter-signals always runs (drains slack inbox each cycle)
  runFilterSignals();

  // Generate deterministic tasks
  const dmTasks = generateDmTasks();
  const scheduledTasks = generateScheduledTasks();

  // Brain tick — handles GitHub/Jira/Gmail signals
  runBrain();

  // Merge: dm tasks + scheduled tasks + brain's tasks
  const brainDelegation = readJson<Delegation>(DELEGATION_FILE);
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
    console.log(`[franklin] Dispatching ${allTasks.length} task(s) (${dmTasks.length} dm, ${scheduledTasks.length} sched, ${brainTasks.length} brain)...`);
    await dispatchWorkers(merged);
  } else {
    console.log("[franklin] No tasks this cycle");
  }

  // Daily housekeeping — prune old data (once per day)
  const todayLocal = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`;
  if (lastRun.last_prune_date !== todayLocal) {
    const pruneDb = openDb();
    const dispatches = pruneDb.pruneDispatchLog(30);
    const inbox = pruneDb.pruneSlackInbox(2);
    pruneDb.close();
    if (dispatches || inbox) {
      console.log(`[franklin] Pruned ${dispatches} dispatch entries, ${inbox} inbox events`);
    }
    lastRun.last_prune_date = todayLocal;
  }

  // Write last_run
  lastRun.last_run_completed = new Date().toISOString();
  writeJson(LAST_RUN_FILE, lastRun);

  const elapsedSec = ((Date.now() - new Date(cycleStart).getTime()) / 1000).toFixed(1);
  console.log(`[franklin] Cycle complete in ${elapsedSec}s`);
}

// ── Status command ─────────────────────────────────────────────────────────────

function printStatus(): void {
  const lock = readJson<LockFile>(LOCK_FILE);
  const lastRun = readLastRun();

  console.log("=== Franklin Status ===");

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
    console.log(`PID:            ${lock.pid} (${isAlive ? "alive" : "DEAD"})`);
    console.log(`Started:        ${lock.started_at}`);
    console.log(`Last heartbeat: ${lock.last_heartbeat} (${Math.round(ageMs / 1000)}s ago)`);
  } else {
    console.log("Not running (no lock file)");
  }

  console.log(`\nLast run completed: ${lastRun.last_run_completed ?? "never"}`);

  if (Object.keys(lastRun.scout_last_run).length > 0) {
    console.log("Scout last run:");
    for (const [scout, ts] of Object.entries(lastRun.scout_last_run)) {
      const ageSec = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
      const nextDueSec = Math.max(0, Math.round(((SCOUT_INTERVALS_MS[scout] ?? 0) - (Date.now() - new Date(ts).getTime())) / 1000));
      console.log(`  ${scout}: last ran ${ageSec}s ago, next in ${nextDueSec}s`);
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
  console.error("[franklin] Another instance is already running. Run `npx tsx franklin.ts status` to check.");
  process.exit(1);
}

mkdirSync(join(ROOT, "state"), { recursive: true });
const startedAt = new Date().toISOString();
writeLock(startedAt);
console.log(`[franklin] Starting (PID ${process.pid}) at ${startedAt}`);

// Graceful shutdown
function shutdown(signal: string): void {
  console.log(`\n[franklin] ${signal} received — shutting down...`);
  if (serverChild) {
    serverChild.kill("SIGTERM");
  }
  deleteLock();
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error("[franklin] Uncaught exception:", err);
  // Keep running — don't let a transient error kill the loop
});

process.on("unhandledRejection", (reason) => {
  console.error("[franklin] Unhandled rejection:", reason);
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
