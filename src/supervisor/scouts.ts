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
