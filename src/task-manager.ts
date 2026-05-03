/**
 * Unified task lifecycle — spawn, track, reap, finalize.
 *
 * Replaces the dual worker/quest model with a single background task model.
 * All LLM tasks are fire-and-forget; a reaper collects results each cycle.
 * Script tasks still run synchronously (no LLM, no benefit to backgrounding).
 *
 * Usage:
 *   import { initTaskManager, spawnBackgroundTask, reapTasks, writeInflightSignals } from "./src/task-manager.js";
 *   initTaskManager(ROOT, appendDispatchLog);
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, createWriteStream } from "fs";
import { join } from "path";
import { openDb } from "./db.js";
import { readJson, readJsonWithSchema, writeJson, resolveTaskTimeout, WorkerResultSchema } from "./config.js";
import type { DelegationTask, WorkerResult, DispatchLogEntry } from "./config.js";
import log from "./logger.js";
import { z } from "zod";

// ── Module state (set via init) ──────────────────────────────────────────────

let ROOT = "";
let logDispatch: (entry: DispatchLogEntry) => void;

export function initTaskManager(
  root: string,
  appendDispatchLog: (entry: DispatchLogEntry) => void,
): void {
  ROOT = root;
  logDispatch = appendDispatchLog;
  recoverStaleQuests();
}

/**
 * Startup recovery — clean up quests orphaned by a previous supervisor crash/stop.
 *
 * Two orphan paths:
 *   1. running_tasks rows whose processes are dead → finalize as error
 *   2. active/ quest files with no matching running_tasks row → move to completed/ as failed
 */
function recoverStaleQuests(): void {
  const activeDir = join(ROOT, "state", "quests", "active");
  const completedDir = join(ROOT, "state", "quests", "completed");
  mkdirSync(activeDir, { recursive: true });
  mkdirSync(completedDir, { recursive: true });

  const db = openDb();
  const now = new Date().toISOString();

  // ── Path 1: DB rows with dead PIDs ────────────────────────────────────────
  const tasks = db.getRunningTasks();
  const trackedQuestIds = new Set<string>();

  for (const task of tasks) {
    if (task.quest_id) trackedQuestIds.add(task.quest_id);

    let alive = false;
    if (task.pid) {
      try { process.kill(task.pid, 0); alive = true; } catch { /* dead */ }
    }
    if (alive) continue; // still running from a previous session (rare but possible)

    log.warn(` Recovering orphaned task ${task.task_id} (PID ${task.pid ?? "none"} dead)`);
    const WORKER_RESULTS_DIR = join(ROOT, "state", "worker_results");
    mkdirSync(WORKER_RESULTS_DIR, { recursive: true });
    const resultFile = join(WORKER_RESULTS_DIR, `${task.task_id}.json`);
    const orphanResult: WorkerResult = {
      task_id: task.task_id,
      status: "error",
      completed_at: now,
      summary: "Recovered on startup — previous supervisor session ended while task was running",
      error: "orphaned",
    };
    writeJson(resultFile, orphanResult);
    finalizeTask(task, orphanResult);
  }

  // ── Path 2: active/ quest files with no DB tracking row ───────────────────
  let questFiles: string[];
  try {
    questFiles = readdirSync(activeDir)
      .filter((f: string) => /^quest-\d+\.json$/.test(f) && !f.includes("agent"));
  } catch { return; }

  for (const qf of questFiles) {
    const questId = qf.replace(".json", "");
    if (trackedQuestIds.has(questId)) continue; // handled by path 1

    log.warn(` Recovering untracked active quest ${questId}`);
    const questFile = join(activeDir, `${questId}.json`);
    const quest = readJson<Record<string, unknown>>(questFile);
    if (quest) {
      quest.status = "failed";
      quest.agent_status = "failed";
      quest.outcome = "Recovered on startup — no running task found";
      quest.updated_at = now;
      writeJson(questFile, quest);
    }

    const agentFile = join(activeDir, `${questId}.agent.json`);
    writeJson(agentFile, {
      status: "failed",
      started_at: (quest as Record<string, unknown>)?.created_at ?? now,
      completed_at: now,
      result: null,
      error: "orphaned — recovered on startup",
    });

    for (const suffix of [".json", ".agent.json", ".log.json"]) {
      const src = join(activeDir, questId + suffix);
      const dst = join(completedDir, questId + suffix);
      try { renameSync(src, dst); } catch { /* file may not exist */ }
    }

    db.updateQuestStatus(questId, "failed", {
      agent_status: "failed",
      outcome: "Recovered on startup — no running task found",
    });
  }

  db.close();
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Task types that get a persistent quest state file. */
const QUEST_STATE_TYPES = new Set(["quest"]);

function taskNeedsQuestState(task: DelegationTask): boolean {
  return QUEST_STATE_TYPES.has(task.type);
}

// ── Quest state file creation ───────────────────────────────────────────────

function createQuestState(task: DelegationTask, dispatchedAt: string): string {
  const ctx = task.context;
  const activeDir = join(ROOT, "state", "quests", "active");
  const completedDir = join(ROOT, "state", "quests", "completed");
  mkdirSync(activeDir, { recursive: true });
  mkdirSync(completedDir, { recursive: true });

  const questDb = openDb();
  const questId = questDb.nextQuestId();

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
    context: ctx,
    mark_surfaced: task.mark_surfaced ?? null,
    approval: { status: "auto_approved" },
    sandbox_path: ctx.sandbox_path ?? null,
    pr_url: null,
    outcome: null,
    skill_updates: [],
    agent_status: "running",
  });

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

  // Write agent status file
  const agentStatusFile = join(activeDir, `${questId}.agent.json`);
  writeJson(agentStatusFile, { status: "running", started_at: dispatchedAt, completed_at: null, result: null, error: null });

  return questId;
}

// ── Spawn background task ───────────────────────────────────────────────────

export function spawnBackgroundTask(task: DelegationTask): void {
  const dispatchedAt = new Date().toISOString();
  const timeoutMs = resolveTaskTimeout(task);
  const needsQuest = taskNeedsQuestState(task);
  let questId: string | null = null;

  if (needsQuest) {
    questId = createQuestState(task, dispatchedAt);
  }

  // Insert into running_tasks table
  const taskDb = openDb();
  taskDb.insertRunningTask({
    task_id: task.id,
    type: task.type,
    priority: task.priority,
    pid: null,
    timeout_ms: timeoutMs,
    quest_id: questId,
    dispatched_at: dispatchedAt,
    mark_surfaced: task.mark_surfaced ? JSON.stringify(task.mark_surfaced) : null,
    context: JSON.stringify(task.context),
  });
  taskDb.close();

  // Build prompt
  const questRef = questId ? ` Quest state: ${ROOT}/state/quests/active/${questId}.json` : "";
  const promptArg = `Franklin codebase: ${ROOT}. Read ${ROOT}/modes/worker_wrapper.md and execute. The task ID is ${task.id}.${questRef}`;

  // Spawn claude process
  const child = spawn("claude",
    ["--dangerously-skip-permissions", "--print", "--output-format", "json", "-p", promptArg],
    { cwd: "/tmp", stdio: ["ignore", "pipe", "pipe"], detached: false },
  );

  const pid = child.pid ?? 0;

  // Update PID in DB
  const pidDb = openDb();
  pidDb.updateRunningTaskPid(task.id, pid);
  pidDb.close();

  // Log file
  const logDir = join(ROOT, "state", "logs", "workers");
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, `${task.id}.json`);
  const logStream = createWriteStream(logFile, { flags: "w" });

  if (child.stdout) child.stdout.on("data", (chunk: Buffer) => { process.stdout.write(chunk); logStream.write(chunk); });
  if (child.stderr) child.stderr.on("data", (chunk: Buffer) => { process.stderr.write(chunk); logStream.write(chunk); });

  child.on("close", () => {
    logStream.end();
  });

  log.info(` Spawned ${task.type} task ${task.id} (PID ${pid}, timeout ${timeoutMs / 60_000}m)${questId ? ` quest=${questId}` : ""}`);

  logDispatch({
    task_id: task.id,
    type: task.type,
    priority: task.priority,
    dispatched_at: dispatchedAt,
    completed_at: dispatchedAt,
    status: "ok",
    summary: `Spawned ${task.type} task (PID ${pid})${questId ? ` quest=${questId}` : ""}`,
  });
}

// ── Finalize a completed/failed/timed-out task ──────────────────────────────

interface RunningTaskRow {
  task_id: string;
  type: string;
  priority: string;
  pid: number | null;
  timeout_ms: number;
  quest_id: string | null;
  dispatched_at: string;
  mark_surfaced: string | null;
  context: string;
}

function finalizeTask(
  taskRow: RunningTaskRow,
  result: WorkerResult,
): void {
  const reapDb = openDb();
  const context = JSON.parse(taskRow.context);

  // 1. Apply deferred mark_surfaced (on success only)
  if (result.status === "ok" && taskRow.mark_surfaced) {
    const ms = JSON.parse(taskRow.mark_surfaced);
    log.info(` markSurfaced: ${ms.id}`);
    reapDb.markSurfaced(ms.id, ms.state);
  }

  // 2. Remove inflight signal
  const signalId = context.signal_id as string | undefined;
  if (signalId) {
    reapDb.removeInflightPr(signalId);
  }

  // 3. Finalize quest state file (if applicable)
  if (taskRow.quest_id) {
    const activeDir = join(ROOT, "state", "quests", "active");
    const completedDir = join(ROOT, "state", "quests", "completed");
    const qid = taskRow.quest_id;
    const finalStatus = result.status === "ok" ? "completed" : "failed";

    // Update quest file
    const questFile = join(activeDir, `${qid}.json`);
    const quest = readJson<Record<string, unknown>>(questFile);
    if (quest) {
      quest.status = finalStatus;
      quest.agent_status = finalStatus;
      quest.outcome = result.summary ?? `agent ${finalStatus}`;
      quest.updated_at = new Date().toISOString();
      writeJson(questFile, quest);
    }

    // Update agent status file
    const agentFile = join(activeDir, `${qid}.agent.json`);
    writeJson(agentFile, {
      status: finalStatus,
      started_at: taskRow.dispatched_at,
      completed_at: result.completed_at,
      result: result.summary,
      error: result.error ?? null,
    });

    // Move to completed
    mkdirSync(completedDir, { recursive: true });
    for (const suffix of [".json", ".agent.json", ".log.json"]) {
      const src = join(activeDir, qid + suffix);
      const dst = join(completedDir, qid + suffix);
      try { renameSync(src, dst); } catch { /* file may not exist */ }
    }

    // Update DB
    reapDb.updateQuestStatus(qid, finalStatus, {
      agent_status: finalStatus,
      outcome: result.summary ?? undefined,
    });
  }

  // 4. Dispatch log (final result)
  logDispatch({
    task_id: taskRow.task_id,
    type: taskRow.type,
    priority: taskRow.priority,
    dispatched_at: taskRow.dispatched_at,
    completed_at: result.completed_at,
    status: result.status === "ok" ? "ok" : "error",
    summary: result.summary,
  });

  // 5. Remove from running_tasks
  reapDb.removeRunningTask(taskRow.task_id);
  reapDb.close();
}

// ── Reaper — runs each cycle to collect completed tasks ─────────────────────

export function reapTasks(): {
  completed: Array<{ taskId: string; scheduledTaskId?: string; status: "ok" | "error" }>;
} {
  const WORKER_RESULTS_DIR = join(ROOT, "state", "worker_results");
  const reapDb = openDb();
  const tasks = reapDb.getRunningTasks();
  reapDb.close();

  const completed: Array<{ taskId: string; scheduledTaskId?: string; status: "ok" | "error" }> = [];

  for (const task of tasks) {
    const elapsed = Date.now() - new Date(task.dispatched_at).getTime();

    // Check if process is still alive
    let alive = false;
    if (task.pid) {
      try { process.kill(task.pid, 0); alive = true; } catch { /* dead */ }
    }

    // Check for result file
    const resultFile = join(WORKER_RESULTS_DIR, `${task.task_id}.json`);
    const result = readJsonWithSchema(resultFile, WorkerResultSchema);

    if (result) {
      // Task completed normally
      log.info(` Reaping completed task ${task.task_id} (${result.status})`);
      const ctx = JSON.parse(task.context);
      completed.push({ taskId: task.task_id, scheduledTaskId: ctx.scheduled_task_id, status: result.status === "ok" ? "ok" : "error" });
      finalizeTask(task, result);
      continue;
    }

    if (!alive && task.pid) {
      // Process died without writing a result
      log.error(` Task ${task.task_id} process died (PID ${task.pid}) without writing result`);
      const deadResult: WorkerResult = {
        task_id: task.task_id,
        status: "error",
        completed_at: new Date().toISOString(),
        summary: "Process exited without writing result",
        error: "process died",
      };
      writeJson(resultFile, deadResult);
      const ctx = JSON.parse(task.context);
      completed.push({ taskId: task.task_id, scheduledTaskId: ctx.scheduled_task_id, status: "error" });
      finalizeTask(task, deadResult);
      continue;
    }

    if (elapsed > task.timeout_ms) {
      // Timeout — kill and finalize
      log.error(` Task ${task.task_id} timed out after ${Math.round(elapsed / 60_000)}m — killing PID ${task.pid}`);
      if (task.pid) {
        try { process.kill(task.pid, "SIGTERM"); } catch { /* already dead */ }
        setTimeout(() => { try { process.kill(task.pid!, "SIGKILL"); } catch { /* ok */ } }, 5_000);
      }
      const timeoutResult: WorkerResult = {
        task_id: task.task_id,
        status: "error",
        completed_at: new Date().toISOString(),
        summary: `Timed out after ${Math.round(elapsed / 60_000)}m`,
        error: "timeout",
      };
      writeJson(resultFile, timeoutResult);
      const ctx = JSON.parse(task.context);
      completed.push({ taskId: task.task_id, scheduledTaskId: ctx.scheduled_task_id, status: "error" });
      finalizeTask(task, timeoutResult);
      continue;
    }

    // Still running — periodic progress log
    const mins = Math.round(elapsed / 60_000);
    if (mins > 0 && mins % 5 === 0) {
      log.info(` Task ${task.task_id} still running (${mins}m elapsed, timeout ${task.timeout_ms / 60_000}m)`);
    }
  }

  return { completed };
}

// ── Inflight signals — replaces inflight_prs.json ───────────────────────────

export function writeInflightSignals(): void {
  const sigDb = openDb();
  const tasks = sigDb.getRunningTasks();
  const signals: string[] = [];

  for (const task of tasks) {
    try {
      const ctx = JSON.parse(task.context);
      if (ctx.signal_id) signals.push(ctx.signal_id);
    } catch { /* bad JSON, skip */ }
  }

  // Also include PRs from active quests that have a pr_url (quests may update this mid-run)
  const activeDir = join(ROOT, "state", "quests", "active");
  try {
    const questFiles = readdirSync(activeDir).filter((f: string) => f.match(/^quest-\d+\.json$/) && !f.includes("agent") && !f.includes("log"));
    for (const qf of questFiles) {
      const quest = readJson<Record<string, unknown>>(join(activeDir, qf));
      if (!quest || quest.status !== "active") continue;
      const prUrl = quest.pr_url as string | null;
      if (prUrl) {
        const match = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
        if (match) {
          const signalId = `github:pr:${match[1]}/${match[2]}`;
          if (!signals.includes(signalId)) signals.push(signalId);
        }
      }
    }
  } catch { /* active dir may not exist yet */ }

  sigDb.close();
  mkdirSync(join(ROOT, "state", "brain_input"), { recursive: true });
  writeJson(join(ROOT, "state", "brain_input", "inflight_signals.json"), signals);
}
