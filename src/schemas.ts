/**
 * Zod schemas for Franklin's core data types.
 *
 * Single source of truth — TypeScript types are derived via z.infer.
 * Import schemas for runtime validation; import types for type annotations.
 */

import { z } from "zod";

// ── DelegationTask ──────────────────────────────────────────────────────────

export const DelegationTaskSchema = z.object({
  id: z.string(),
  type: z.string(),
  priority: z.string(),
  kind: z.enum(["worker", "script"]).optional(),
  command: z.string().optional(),
  timeout: z.number().optional(),
  context: z.record(z.string(), z.any()),
  mark_surfaced: z
    .object({
      id: z.string(),
      state: z.record(z.string(), z.any()),
    })
    .nullable()
    .optional(),
});

export type DelegationTask = z.infer<typeof DelegationTaskSchema>;

// ── WorkerResult ────────────────────────────────────────────────────────────

export const WorkerResultSchema = z.object({
  task_id: z.string(),
  status: z.enum(["ok", "error", "skipped", "needs_info"]),
  completed_at: z.string(),
  summary: z.string(),
  error: z.string().nullable(),
});

export type WorkerResult = z.infer<typeof WorkerResultSchema>;

// ── ScheduledTask ───────────────────────────────────────────────────────────

export const ScheduledTaskSchema = z.object({
  id: z.string(),
  every: z.string(),
  type: z.string(),
  priority: z.string(),
  kind: z.enum(["worker", "script"]).optional(),
  command: z.string().optional(),
  timeout: z.number().optional(),
  display_description: z.string().optional(),
  context: z.record(z.string(), z.any()),
  last_run: z.string().nullable().optional(),
  fail_count: z.number().optional(),
  last_fail: z.string().nullable().optional(),
});

export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

// ── Settings ────────────────────────────────────────────────────────────────

export const SettingsSchema = z.object({
  name: z.string(),
  mode: z.string(),
  owner_user_id: z.string().optional(),
  timezone: z.string().optional(),
  avatar: z.string().optional(),
  user_profile: z.object({
    name: z.string(),
    telegram_user_id: z.number().int(),
    telegram_chat_id: z.number().int(),
    tone: z.string(),
  }),
  authorized_users: z.array(
    z.object({
      name: z.string(),
      telegram_user_id: z.number().int(),
    }),
  ),
  integrations: z.array(z.string()),
  disabled_scouts: z.array(z.string()).optional(),
  feature_flags: z.record(z.string(), z.unknown()).optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;

// ── Delegation (wrapper used in delegation.json) ────────────────────────────

const MarkSurfacedEntrySchema = z.object({
  id: z.string(),
  state: z.record(z.string(), z.any()),
});

export const DelegationSchema = z.object({
  generated_at: z.string(),
  tasks: z.array(DelegationTaskSchema),
  mark_surfaced_only: z.array(MarkSurfacedEntrySchema).optional(),
});

export type Delegation = z.infer<typeof DelegationSchema>;
