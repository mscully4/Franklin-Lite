import { spawn } from "child_process";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SCOUT_INTERVALS_MS, readJson, readJsonWithSchema, writeJson, DelegationSchema } from "../config.js";
import type { DelegationTask, Delegation } from "../config.js";
import { initTaskManager, reapTasks, writeInflightSignals } from "./task-manager.js";
import { openDb } from "../db/index.js";
import { checkLock, writeLock, deleteLock, readLock } from "./lock.js";
import { readLastRun, writeLastRun, isScoutDue, runStartupChecks, runScout } from "./scouts.js";
import {
  appendDispatchLog, runBrain,
  generateScheduledTasks,
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

    const reaped = reapTasks();
    for (const r of reaped.completed) {
      if (r.scheduledTaskId) updateScheduledTaskResult(r.scheduledTaskId, r.status);
    }

    const scheduledTasks = generateScheduledTasks();
    writeInflightSignals();

    const signals = readJson<unknown[]>(join(ROOT, "state", "brain_input", "signals.json")) ?? [];
    const hasBrainWork = signals.length > 0 || scheduledTasks.length > 0;
    let brainTasks: DelegationTask[] = [];
    let markSurfacedOnly: Delegation["mark_surfaced_only"] = [];
    if (hasBrainWork) {
      runBrain();
      const brainDelegation = readJsonWithSchema(DELEGATION_FILE, DelegationSchema);
      brainTasks = brainDelegation?.tasks ?? [];
      markSurfacedOnly = brainDelegation?.mark_surfaced_only ?? [];
    } else {
      log.debug("No signals — skipping brain");
    }

    const allTasks = [...scheduledTasks, ...brainTasks];

    if (allTasks.length) {
      const idDb = openDb();
      const ids = idDb.nextTaskIds(allTasks.length);
      idDb.close();
      allTasks.forEach((t, i) => { t.id = ids[i]; });
    }

    if (allTasks.length) {
      const merged = { generated_at: new Date().toISOString(), tasks: allTasks };
      writeJson(DELEGATION_FILE, merged);
      log.info(` Dispatching ${allTasks.length} task(s) (${scheduledTasks.length} sched, ${brainTasks.length} brain)...`);
      dispatchTasks(merged);
    } else {
      log.debug("No tasks this cycle");
    }

    if (markSurfacedOnly.length) {
      const msDb = openDb();
      for (const entry of markSurfacedOnly) {
        log.info(` markSurfacedOnly: ${entry.id}`);
        msDb.markSurfaced(entry.id, entry.state);
      }
      msDb.close();
      log.info(` Marked ${markSurfacedOnly.length} signal(s) as surfaced (no task dispatched)`);
    }

    const todayLocal = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`;
    if (lastRun.last_prune_date !== todayLocal) {
      const pruneDb = openDb();
      const dispatches = pruneDb.pruneDispatchLog(30);
      pruneDb.close();
      if (dispatches) log.info(` Pruned ${dispatches} dispatch entries`);
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
