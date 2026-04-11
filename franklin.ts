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
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, renameSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb } from "./scripts/db.js";
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
const DISPATCH_LOG = join(ROOT, "state", "dispatch_log.jsonl");
const ACTIVE_WORKERS_FILE = join(ROOT, "state", "active_workers.json");

// Scout intervals in ms — add new scouts here
const SCOUT_INTERVALS_MS: Record<string, number> = {
  github: 10 * 60 * 1000,
  jira: 10 * 60 * 1000,
  gmail: 15 * 60 * 1000,
  calendar: 10 * 60 * 1000,
  slack_channels: 10 * 60 * 1000,
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

    const isDm = event.channel_type === "im";
    const isAppMention = event.type === "app_mention";
    const isReaction = event.type === "reaction_added";
    const textMentionsFranklin = (event.text ?? "").includes(`<@${FRANKLIN_BOT_USER_ID}>`);

    // In channels/groups, only respond if Franklin is explicitly mentioned or reacted to
    if (!isDm && !isAppMention && !isReaction && !textMentionsFranklin) continue;

    const source_tag =
      isReaction && event.reaction === "whiskey" ? "whiskey" :
      isReaction ? "reaction" :
      isDm ? "dm" :
      isAppMention || textMentionsFranklin ? "mention" : "channel_msg";

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
    log.info(` Generated ${tasks.length} dm_reply task(s) from inbox`);
  }
  return tasks;
}

// ── Scheduled tasks ──────────────────────────────────────────────────────────

interface ScheduledTask {
  id: string;
  every: string;        // human-readable interval: "24h", "30m", "7d", "weekdays"
  type: string;
  priority: string;
  kind?: "worker" | "script";  // "worker" (default) = Claude LLM, "script" = direct shell
  command?: string;             // shell command for kind: "script"
  timeout?: number;             // ms, for kind: "script" (default 60s)
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

interface DelegationTask {
  id: string;
  type: string;
  priority: string;
  kind?: "worker" | "script";
  command?: string;
  timeout?: number;
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

const QUEST_TIMEOUT_MS = 60 * 60_000; // 60 min

// Track running quest agent processes so the reaper can check on them
interface QuestProcess {
  questId: string;
  taskId: string;
  pid: number;
  startedAt: string;
}
const runningQuests: Map<string, QuestProcess> = new Map();

/**
 * Spawn a quest agent as a background process. Returns immediately — the
 * reaper (running each cycle) handles finalization when the agent completes.
 */
function spawnQuestAgent(task: DelegationTask): WorkerResult {
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

  log.info(` Created ${questId} — spawning quest agent (fire-and-forget)...`);

  const agentStatusFile = join(activeDir, `${questId}.agent.json`);
  writeJson(agentStatusFile, { status: "running", started_at: dispatchedAt, completed_at: null, result: null, error: null });

  // Spawn detached — don't block the cycle
  const child = spawn("claude",
    ["--dangerously-skip-permissions", "--print", "-p",
      `You are Franklin. Read state/quests/active/${questId}.json and execute the quest objective to completion. When done, write state/quests/active/${questId}.agent.json with status "completed" and a result summary.`],
    { cwd: ROOT, stdio: "inherit", detached: false },
  );

  const pid = child.pid ?? 0;
  runningQuests.set(questId, { questId, taskId: task.id, pid, startedAt: dispatchedAt });

  // When the process exits, remove from tracking (reaper handles finalization)
  child.on("close", () => {
    runningQuests.delete(questId);
  });

  appendDispatchLog({ task_id: task.id, type: task.type, priority: task.priority,
    dispatched_at: dispatchedAt, completed_at: dispatchedAt,
    status: "ok", summary: `Spawned quest ${questId} (PID ${pid})` });

  return {
    task_id: task.id,
    status: "ok",
    completed_at: dispatchedAt,
    summary: `Spawned quest ${questId}`,
    error: null,
  };
}

const INFLIGHT_TTL_MS = QUEST_TIMEOUT_MS; // same as quest timeout (60 min)
const INFLIGHT_PRS_FILE = join(ROOT, "state", "brain_input", "inflight_prs.json");

/**
 * Prune stale entries and write the inflight PRs snapshot for the brain.
 * Called each cycle before the brain runs.
 */
function writeInflightPrs(): void {
  const inflightDb = openDb();
  const entries = inflightDb.getInflightPrs();
  const now = Date.now();
  const live: string[] = [];

  for (const entry of entries) {
    // Prune if TTL expired
    const age = now - new Date(entry.started_at).getTime();
    if (age > INFLIGHT_TTL_MS) {
      log.info(` Pruning expired inflight PR: ${entry.signal_id} (${Math.round(age / 60_000)}m old)`);
      inflightDb.removeInflightPr(entry.signal_id);
      continue;
    }
    // Prune if PID is dead
    if (entry.pid) {
      try { process.kill(entry.pid, 0); } catch {
        log.info(` Pruning dead inflight PR: ${entry.signal_id} (PID ${entry.pid} dead)`);
        inflightDb.removeInflightPr(entry.signal_id);
        continue;
      }
    }
    live.push(entry.signal_id);
  }

  // Also include PRs from active quests that have a pr_url
  const activeDir = join(ROOT, "state", "quests", "active");
  try {
    const questFiles = readdirSync(activeDir).filter((f: string) => f.match(/^quest-\d+\.json$/) && !f.includes("agent") && !f.includes("log"));
    for (const qf of questFiles) {
      const quest = readJson<Record<string, unknown>>(join(activeDir, qf));
      if (!quest || quest.status !== "active") continue;
      const prUrl = quest.pr_url as string | null;
      if (prUrl) {
        // Extract signal_id from PR URL: https://github.com/crcl-main/repo/pull/123 → github:pr:crcl-main/repo/123
        const match = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
        if (match) {
          const signalId = `github:pr:${match[1]}/${match[2]}`;
          if (!live.includes(signalId)) live.push(signalId);
        }
      }
    }
  } catch { /* active dir may not exist yet */ }

  inflightDb.close();
  mkdirSync(join(ROOT, "state", "brain_input"), { recursive: true });
  writeJson(INFLIGHT_PRS_FILE, live);
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
  try {
    const activeDir = join("state", "quests", "active");
    const completedDir = join("state", "quests", "completed");
    const questFiles = readdirSync(activeDir).filter((f) => f.match(/^quest-\d+\.json$/) && !f.includes("agent") && !f.includes("log"));
    for (const qf of questFiles) {
      const quest = readJson<Record<string, unknown>>(join(activeDir, qf));
      if (!quest || quest.status !== "active") continue;
      const qid = qf.replace(".json", "");
      const agentFile = join(activeDir, qf.replace(".json", ".agent.json"));
      const agent = readJson<{ status?: string; result?: unknown; started_at?: string }>(agentFile);

      // Check for timeout — kill the process if it's been running too long
      const tracked = runningQuests.get(qid);
      if (tracked && agent?.status === "running" && agent.started_at) {
        const elapsed = Date.now() - new Date(agent.started_at).getTime();
        if (elapsed > QUEST_TIMEOUT_MS) {
          log.error(` Quest ${qid} timed out after ${Math.round(elapsed / 60_000)}m — killing PID ${tracked.pid}`);
          try { process.kill(tracked.pid, "SIGTERM"); } catch { /* already dead */ }
          setTimeout(() => { try { process.kill(tracked.pid, "SIGKILL"); } catch { /* ok */ } }, 5_000);
          // Write agent status so next reap cycle finalizes it
          writeJson(agentFile, { ...agent, status: "failed", completed_at: new Date().toISOString(), result: null, error: "timed out" });
          runningQuests.delete(qid);
        } else {
          const mins = Math.round(elapsed / 60_000);
          if (mins > 0 && mins % 10 === 0) log.info(` Quest ${qid} still running (${mins}m elapsed)`);
        }
        continue; // still running or just killed — finalize next cycle
      }

      // Finalize completed/failed quests
      if (agent && (agent.status === "completed" || agent.status === "failed")) {
        const rawResult = agent.result;
        const outcome = rawResult == null ? null : typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
        const finalStatus = agent.status === "completed" ? "completed" : "failed";
        log.info(` Finalizing quest ${qid} (agent=${agent.status})`);
        quest.status = finalStatus;
        quest.agent_status = finalStatus;
        quest.outcome = outcome ?? `agent ${agent.status}`;
        quest.updated_at = new Date().toISOString();
        writeJson(join(activeDir, qf), quest);
        // Move to completed
        for (const suffix of [".json", ".agent.json", ".log.json"]) {
          const src = join(activeDir, qid + suffix);
          const dst = join(completedDir, qid + suffix);
          try { renameSync(src, dst); } catch { /* file may not exist */ }
        }
        // Update DB
        try {
          const reapDb = openDb();
          reapDb.updateQuestStatus(qid, finalStatus, { agent_status: finalStatus, outcome: outcome ?? undefined });
          reapDb.close();
        } catch (err) { log.error(` Failed to update DB for quest ${qid}:`, err); }
        // Dispatch log
        try {
          appendDispatchLog({ task_id: tracked?.taskId ?? qid, type: "quest", priority: "normal",
            dispatched_at: agent.started_at ?? quest.created_at as string, completed_at: new Date().toISOString(),
            status: finalStatus === "completed" ? "ok" : "error",
            summary: outcome ?? `Quest ${qid} ${finalStatus}` });
        } catch (err) { log.error(` Failed to log quest ${qid}:`, err); }
        runningQuests.delete(qid);
      }
    }
  } catch (err) {
    log.error("Quest check-in error:", err);
  }

  // Generate deterministic tasks
  const dmTasks = generateDmTasks();
  const scheduledTasks = generateScheduledTasks();

  // Write inflight PRs snapshot — prunes stale entries, informs brain of in-progress work
  writeInflightPrs();

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
