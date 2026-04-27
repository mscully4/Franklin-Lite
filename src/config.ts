/**
 * Shared constants and helpers used across Franklin modules.
 */

import { readFileSync, writeFileSync } from "fs";
import { z } from "zod";
import log from "./logger.js";

// Re-export schemas and types from the canonical source
export {
  DelegationTaskSchema,
  WorkerResultSchema,
  ScheduledTaskSchema,
  SettingsSchema,
  DelegationSchema,
} from "./schemas.js";

export type {
  DelegationTask,
  WorkerResult,
  ScheduledTask,
  Settings,
  Delegation,
} from "./schemas.js";

/** Scout polling intervals in milliseconds. Single source of truth. */
export const SCOUT_INTERVALS_MS: Record<string, number> = {
  github: 10 * 60 * 1000,
  jira: 10 * 60 * 1000,
  gmail: 15 * 60 * 1000,
  calendar: 10 * 60 * 1000,
};

/** Default task timeouts by type. Brain can override with `timeout` on any task. */
export const DEFAULT_TIMEOUT_BY_TYPE: Record<string, number> = {
  dm_reply:        10 * 60_000,  // 10 min
  email_notify:     5 * 60_000,  //  5 min
  jira_update:      5 * 60_000,  //  5 min
  pr_monitor:      60 * 60_000,  // 60 min
  quest:           60 * 60_000,  // 60 min
  scheduled:       10 * 60_000,  // 10 min
};

const DEFAULT_TASK_TIMEOUT_MS = 10 * 60_000; // fallback for unknown types

/** Resolve effective timeout for a task. */
export function resolveTaskTimeout(task: { type: string; timeout?: number }): number {
  return task.timeout ?? DEFAULT_TIMEOUT_BY_TYPE[task.type] ?? DEFAULT_TASK_TIMEOUT_MS;
}

// ── Shared interfaces (Phase 2 — not yet schema-ified) ──────────────────────

export interface DispatchLogEntry {
  task_id: string;
  type: string;
  priority: string;
  dispatched_at: string;
  completed_at: string;
  status: "ok" | "error" | "skipped" | "timeout" | "no_worker" | "needs_info";
  summary: string | null;
}

// ── JSON helpers ─────────────────────────────────────────────────────────────

/** Write data as pretty-printed JSON. */
export function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

/** Read and parse a JSON file, returning null on any error. */
export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/**
 * Read a JSON file and validate it against a Zod schema.
 * Returns the validated data, or null on file-read error or validation failure.
 * Validation errors are logged at warn level with field-level detail.
 */
export function readJsonWithSchema<T extends z.ZodTypeAny>(
  path: string,
  schema: T,
): z.infer<T> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i: z.ZodIssue) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    log.warn(`Validation failed for ${path}:\n${issues}`);
    return null;
  }
  return result.data;
}
