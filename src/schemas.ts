/**
 * Zod schemas for Franklin's core data types.
 *
 * Single source of truth — TypeScript types are derived via z.infer.
 * Import schemas for runtime validation; import types for type annotations.
 */

import { z } from "zod";

// ── QuestCategory ───────────────────────────────────────────────────────────

export const QuestCategorySchema = z.enum([
  // Scout-driven
  "calendar_prep",
  "email_triage",

  // Scheduled
  "maintenance",

  // Brain picks for ad-hoc Discord pings
  "user_question",
  "user_task",
  "research",

  "other",
]);

export type QuestCategory = z.infer<typeof QuestCategorySchema>;

// ── DelegationTask ──────────────────────────────────────────────────────────

export const DelegationTaskSchema = z.object({
  id: z.string(),
  type: z.string(),
  priority: z.string().default("normal"),
  kind: z.enum(["worker", "script"]).optional(),
  command: z.string().optional(),
  timeout: z.number().optional(),
  dedup_key: z.string(),
  category: QuestCategorySchema.optional(),
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
  category: QuestCategorySchema.optional(),
  context: z.record(z.string(), z.any()),
  last_run: z.string().nullable().optional(),
  fail_count: z.number().optional(),
  last_fail: z.string().nullable().optional(),
  disabled: z.boolean().optional(),
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
    discord_user_id: z.string(),
    tone: z.string(),
  }),
  authorized_users: z.array(
    z.object({
      name: z.string(),
      discord_user_id: z.string(),
    }),
  ),
  integrations: z.array(
    z.union([
      z.string(),
      z.object({
        name: z.string(),
        description: z.string().optional(),
        env: z.array(z.string()).optional(),
      }),
    ]),
  ),
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

// ── Event handlers (state/event_handlers.json) ───────────────────────────────

export const EventHandlerSchema = z.object({
  id: z.string(),
  event_type: z.string(),
  sub_type: z.string().nullable(),
  kind: z.enum(["script", "worker"]),
  command: z.string().optional(),
  timeout: z.number().optional(),
  description: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export type EventHandler = z.infer<typeof EventHandlerSchema>;

// ── Reaction events (state/brain_input/discord_reactions.json) ───────────────

export const ReactionEventSchema = z.object({
  message_id: z.string(),
  channel_id: z.string(),
  user_id: z.string(),
  emoji: z.string(),
  reacted_at: z.string(),
  sub_type: z.string(),
  meta: z.record(z.string(), z.unknown()),
});

export type ReactionEvent = z.infer<typeof ReactionEventSchema>;
