/**
 * Quest lifecycle management — spawning, tracking, timeout enforcement, and finalization.
 *
 * Usage:
 *   import { initQuestManager, spawnQuestAgent, writeInflightPrs, reapQuests } from "./scripts/quest-manager.js";
 *   initQuestManager(ROOT, appendDispatchLog);
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, createWriteStream } from "fs";
import { join } from "path";
import { openDb } from "./db.js";
import { readJson, writeJson } from "./config.js";
import type { DelegationTask, WorkerResult, DispatchLogEntry } from "./config.js";
import log from "./logger.js";

// ── Module state (set via init) ──────────────────────────────────────────────

let ROOT = "";
let logDispatch: (entry: DispatchLogEntry) => void;

export function initQuestManager(
  root: string,
  appendDispatchLog: (entry: DispatchLogEntry) => void,
): void {
  ROOT = root;
  logDispatch = appendDispatchLog;
}

// ── Constants ────────────────────────────────────────────────────────────────

const QUEST_TIMEOUT_MS = 60 * 60_000; // 60 min
const INFLIGHT_TTL_MS = QUEST_TIMEOUT_MS;

// ── Running quest tracking ───────────────────────────────────────────────────

interface QuestProcess {
  questId: string;
  taskId: string;
  pid: number;
  startedAt: string;
}

const runningQuests: Map<string, QuestProcess> = new Map();

export function getRunningQuests(): ReadonlyMap<string, QuestProcess> {
  return runningQuests;
}

// ── Spawn quest agent ────────────────────────────────────────────────────────

export function spawnQuestAgent(task: DelegationTask): WorkerResult {
  const dispatchedAt = new Date().toISOString();
  const ctx = task.context;

  const activeDir = join(ROOT, "state", "quests", "active");
  const completedDir = join(ROOT, "state", "quests", "completed");
  mkdirSync(activeDir, { recursive: true });
  mkdirSync(completedDir, { recursive: true });

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

  const questLogDir = join(ROOT, "state", "logs", "workers");
  mkdirSync(questLogDir, { recursive: true });
  const questLogFile = join(questLogDir, `${questId}.log`);
  const logStream = createWriteStream(questLogFile, { flags: "w" });

  const child = spawn("claude",
    ["--dangerously-skip-permissions", "--print", "-p",
      `You are Franklin. Read state/quests/active/${questId}.json and execute the quest objective to completion. When done, write state/quests/active/${questId}.agent.json with status "completed" and a result summary.`],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: false },
  );

  // Tee stdout/stderr to log file and console
  if (child.stdout) child.stdout.on("data", (chunk: Buffer) => { process.stdout.write(chunk); logStream.write(chunk); });
  if (child.stderr) child.stderr.on("data", (chunk: Buffer) => { process.stderr.write(chunk); logStream.write(chunk); });

  const pid = child.pid ?? 0;
  runningQuests.set(questId, { questId, taskId: task.id, pid, startedAt: dispatchedAt });

  child.on("close", () => {
    logStream.end();
    runningQuests.delete(questId);
  });

  logDispatch({ task_id: task.id, type: task.type, priority: task.priority,
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

// ── Inflight PR tracking ─────────────────────────────────────────────────────

export function writeInflightPrs(): void {
  const inflightDb = openDb();
  const entries = inflightDb.getInflightPrs();
  const now = Date.now();
  const live: string[] = [];

  for (const entry of entries) {
    const age = now - new Date(entry.started_at).getTime();
    if (age > INFLIGHT_TTL_MS) {
      log.info(` Pruning expired inflight PR: ${entry.signal_id} (${Math.round(age / 60_000)}m old)`);
      inflightDb.removeInflightPr(entry.signal_id);
      continue;
    }
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
  writeJson(join(ROOT, "state", "brain_input", "inflight_prs.json"), live);
}

// ── Quest reaping ────────────────────────────────────────────────────────────

export function reapQuests(): void {
  try {
    const activeDir = join(ROOT, "state", "quests", "active");
    const completedDir = join(ROOT, "state", "quests", "completed");
    if (!existsSync(activeDir)) return;

    const questFiles = readdirSync(activeDir).filter((f) => f.match(/^quest-\d+\.json$/) && !f.includes("agent") && !f.includes("log"));
    for (const qf of questFiles) {
      const quest = readJson<Record<string, unknown>>(join(activeDir, qf));
      if (!quest || quest.status !== "active") continue;
      const qid = qf.replace(".json", "");
      const agentFile = join(activeDir, qf.replace(".json", ".agent.json"));
      const agent = readJson<{ status?: string; result?: unknown; started_at?: string }>(agentFile);

      // Check for timeout
      const tracked = runningQuests.get(qid);
      if (tracked && agent?.status === "running" && agent.started_at) {
        const elapsed = Date.now() - new Date(agent.started_at).getTime();
        if (elapsed > QUEST_TIMEOUT_MS) {
          log.error(` Quest ${qid} timed out after ${Math.round(elapsed / 60_000)}m — killing PID ${tracked.pid}`);
          try { process.kill(tracked.pid, "SIGTERM"); } catch { /* already dead */ }
          setTimeout(() => { try { process.kill(tracked.pid, "SIGKILL"); } catch { /* ok */ } }, 5_000);
          writeJson(agentFile, { ...agent, status: "failed", completed_at: new Date().toISOString(), result: null, error: "timed out" });
          runningQuests.delete(qid);
        } else {
          const mins = Math.round(elapsed / 60_000);
          if (mins > 0 && mins % 10 === 0) log.info(` Quest ${qid} still running (${mins}m elapsed)`);
        }
        continue;
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
        mkdirSync(completedDir, { recursive: true });
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
          logDispatch({ task_id: tracked?.taskId ?? qid, type: "quest", priority: "normal",
            dispatched_at: agent.started_at ?? quest.created_at as string, completed_at: new Date().toISOString(),
            status: finalStatus === "completed" ? "ok" : "error",
            summary: outcome ?? `Quest ${qid} ${finalStatus}` });
        } catch (err) { log.error(` Failed to log quest ${qid}:`, err); }
        runningQuests.delete(qid);
      }
    }
  } catch (err) {
    log.error("Quest reaping error:", err);
  }
}
