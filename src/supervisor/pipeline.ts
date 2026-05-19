import { execSync, spawnSync } from "child_process";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { openDb } from "../db/index.js";
import {
  readJson, readJsonWithSchema, writeJson,
  ScheduledTaskSchema, SettingsSchema,
} from "../config.js";
import type { DelegationTask, WorkerResult, DispatchLogEntry, Delegation } from "../config.js";
import { spawnBackgroundTask } from "./task-manager.js";
import log from "../logger.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER_RESULTS_DIR = join(ROOT, "state", "worker_results");
const SETTINGS_FILE = join(ROOT, "state", "settings.json");
const SCHEDULED_TASKS_FILE = join(ROOT, "state", "scheduled_tasks.json");
const SCRIPT_TIMEOUT_MS = 60_000;

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
      "Read prompts/brain.md and execute the instructions exactly. Do not stop until state/delegation.json is written.",
    ],
    { cwd: ROOT, stdio: "inherit", timeout: 5 * 60_000 },
  );

  if (result.status !== 0) {
    log.error(` Brain exited with status ${result.status ?? "timeout"}`);
  }
}

// ── Discord DM inbox ────────────────────────────────────────────────────────

const SLACK_INBOX_FILE = join(ROOT, "state", "brain_input", "slack_inbox.json");

type SlackInboxEntry = {
  event_ts: string;
  channel: string;
  channel_type: string;
  user_id: string | null;
  type: string;
  text: string | null;
  thread_ts: string | null;
  thread_context?: Array<{ author: string; text: string; ts: string }> | null;
  received_at: string;
};

export function generateDmTasks(): DelegationTask[] {
  const inbox = readJson<SlackInboxEntry[]>(SLACK_INBOX_FILE) ?? [];
  if (!inbox.length) return [];

  const settings = readJsonWithSchema(SETTINGS_FILE, SettingsSchema);
  const authorizedIds = new Set(
    (settings?.authorized_users ?? []).map((u) => u.discord_user_id),
  );

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
        thread_ts: event.thread_ts ?? null,
        thread_context: event.thread_context ?? null,
        source_tag: "discord_dm",
        mode: settings?.mode ?? "drafts_only",
      },
      mark_surfaced: null,
    });
  }

  // Clear the inbox so events don't re-fire
  writeJson(SLACK_INBOX_FILE, []);

  if (tasks.length) {
    log.info(` Generated ${tasks.length} dm_reply task(s) from Discord inbox`);
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
      const lastRunDay = lastRunInTz
        ? `${lastRunInTz.getFullYear()}-${String(lastRunInTz.getMonth() + 1).padStart(2, "0")}-${String(lastRunInTz.getDate()).padStart(2, "0")}`
        : null;
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
      const schedId = task.context.scheduled_task_id as string | undefined;
      if (schedId) {
        updateScheduledTaskResult(schedId, result.status === "ok" ? "ok" : "error");
      }
      continue;
    }

    spawnBackgroundTask(task);
  }
}
