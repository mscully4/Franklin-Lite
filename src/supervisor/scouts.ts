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

type IntegrationEntry = string | { name: string; description?: string; env?: string[] };

function resolveIntegrationName(entry: IntegrationEntry): string {
  return typeof entry === "string" ? entry : entry.name;
}

export function checkIntegrations(): void {
  const settings = readJson<{ integrations?: IntegrationEntry[] }>(
    join(ROOT, "state", "settings.json"),
  );
  const integrations = settings?.integrations;
  if (!integrations?.length) return;

  const failures: string[] = [];

  for (const entry of integrations) {
    const name = resolveIntegrationName(entry);
    if (name === "discord") continue; // transport, not a CLI

    // Check CLI binary exists
    try {
      execSync(`which ${name}`, { stdio: "ignore", timeout: 5_000 });
      log.info(` ✓ ${name} CLI`);
    } catch {
      log.error(` ✗ ${name} CLI — not found on $PATH`);
      failures.push(`${name} (CLI missing)`);
      continue; // skip env checks if binary is missing
    }

    // Check required env vars
    if (typeof entry !== "string" && entry.env) {
      for (const v of entry.env) {
        if (process.env[v]) {
          log.info(` ✓ ${name}: ${v}`);
        } else {
          log.error(` ✗ ${name}: ${v} — not set`);
          failures.push(`${name} (missing ${v})`);
        }
      }
    }
  }

  if (failures.length > 0) {
    log.fatal(`Startup failed — integration issues: ${failures.join(", ")}`);
    process.exit(1);
  }
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
