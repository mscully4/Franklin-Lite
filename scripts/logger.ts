/**
 * Shared tslog logger for Franklin.
 *
 * Usage:
 *   import log from "../scripts/logger.js";           // root logger
 *   import { createLogger } from "../scripts/logger.js";
 *   const log = createLogger("github");               // child logger
 *
 * Output:
 *   - Console: pretty-printed (human-readable)
 *   - File: state/logs/franklin.log (JSON lines, rotated daily, 7-day retention)
 */

import { Logger, ILogObj } from "tslog";
import { appendFileSync, mkdirSync, renameSync, readdirSync, unlinkSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LOG_DIR = join(ROOT, "state", "logs");
const LOG_FILE = join(LOG_DIR, "franklin.log");
const RETENTION_DAYS = 7;

mkdirSync(LOG_DIR, { recursive: true });

// ── Log rotation ─────────────────────────────────────────────────────────────

let currentDay = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

function rotateIfNeeded(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today === currentDay) return;

  // Rotate current log to dated file
  if (existsSync(LOG_FILE)) {
    try {
      renameSync(LOG_FILE, join(LOG_DIR, `franklin-${currentDay}.log`));
    } catch { /* another process may have already rotated */ }
  }
  currentDay = today;

  // Prune old logs
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
    for (const f of readdirSync(LOG_DIR)) {
      const match = f.match(/^franklin-(\d{4}-\d{2}-\d{2})\.log$/);
      if (match && new Date(match[1]).getTime() < cutoff) {
        unlinkSync(join(LOG_DIR, f));
      }
    }
  } catch { /* best effort */ }
}

// ── File transport ───────────────────────────────────────────────────────────

function fileTransport(logObj: unknown): void {
  rotateIfNeeded();
  try {
    const obj = logObj as Record<string, unknown>;
    const meta = obj._meta as Record<string, unknown> | undefined;
    const line = JSON.stringify({
      ts: meta?.date ? (meta.date as Date).toISOString() : new Date().toISOString(),
      level: meta?.logLevelName ?? "INFO",
      name: meta?.name ?? "franklin",
      ...obj,
      _meta: undefined,
    });
    appendFileSync(LOG_FILE, line + "\n");
  } catch { /* don't crash on log write failure */ }
}

// ── Logger instance ──────────────────────────────────────────────────────────

const log = new Logger<ILogObj>({
  name: "franklin",
  type: "pretty",
  minLevel: 2, // 0=silly, 1=trace, 2=debug, 3=info, 4=warn, 5=error, 6=fatal
  prettyLogTimeZone: "local",
  prettyLogTemplate: "{{dateIsoStr}} {{logLevelName}}\t[{{name}}] ",
  attachedTransports: [fileTransport],
});

/**
 * Create a child logger with a specific module name.
 */
export function createLogger(name: string): Logger<ILogObj> {
  return log.getSubLogger({ name });
}

export default log;
