import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  DelegationTaskSchema,
  WorkerResultSchema,
  ScheduledTaskSchema,
  SettingsSchema,
  DelegationSchema,
} from "../schemas.js";

describe("DelegationTaskSchema", () => {
  test("accepts valid task with all fields", () => {
    const data = {
      id: "task-001", type: "dm_reply", priority: "high",
      kind: "worker" as const, context: { text: "hello" },
      mark_surfaced: { id: "sig-1", state: { ci_failing: [] } },
    };
    const result = DelegationTaskSchema.safeParse(data);
    assert.ok(result.success);
    assert.equal(result.data.id, "task-001");
  });

  test("accepts task with mark_surfaced: null", () => {
    const data = {
      id: "task-002", type: "scheduled", priority: "normal",
      context: {}, mark_surfaced: null,
    };
    assert.ok(DelegationTaskSchema.safeParse(data).success);
  });

  test("accepts task without optional fields", () => {
    const data = {
      id: "task-003", type: "dm_reply", priority: "high",
      context: {}, mark_surfaced: null,
    };
    const result = DelegationTaskSchema.safeParse(data);
    assert.ok(result.success);
    assert.equal(result.data.kind, undefined);
  });

  test("rejects task with missing id", () => {
    const data = { type: "x", priority: "x", context: {}, mark_surfaced: null };
    assert.ok(!DelegationTaskSchema.safeParse(data).success);
  });

  test("rejects task with invalid kind", () => {
    const data = {
      id: "x", type: "x", priority: "x", kind: "invalid",
      context: {}, mark_surfaced: null,
    };
    assert.ok(!DelegationTaskSchema.safeParse(data).success);
  });
});

describe("WorkerResultSchema", () => {
  test("accepts valid result", () => {
    const data = {
      task_id: "task-001", status: "ok" as const,
      completed_at: "2026-04-12T00:00:00Z", summary: "done", error: null,
    };
    assert.ok(WorkerResultSchema.safeParse(data).success);
  });

  test("accepts result with error string", () => {
    const data = {
      task_id: "task-001", status: "error" as const,
      completed_at: "2026-04-12T00:00:00Z", summary: "failed", error: "timeout",
    };
    const result = WorkerResultSchema.safeParse(data);
    assert.ok(result.success);
    assert.equal(result.data.error, "timeout");
  });

  test("rejects invalid status enum", () => {
    const data = {
      task_id: "task-001", status: "unknown",
      completed_at: "2026-04-12T00:00:00Z", summary: "done", error: null,
    };
    assert.ok(!WorkerResultSchema.safeParse(data).success);
  });

  test("rejects missing summary", () => {
    const data = {
      task_id: "task-001", status: "ok",
      completed_at: "2026-04-12T00:00:00Z", error: null,
    };
    assert.ok(!WorkerResultSchema.safeParse(data).success);
  });
});

describe("ScheduledTaskSchema", () => {
  test("accepts full scheduled task", () => {
    const data = {
      id: "daily-health-review", every: "weekdays",
      type: "scheduled", priority: "normal",
      context: { objective: "Run health check", skill: "daily-review" },
      last_run: "2026-04-10T00:00:09.043Z",
    };
    assert.ok(ScheduledTaskSchema.safeParse(data).success);
  });

  test("accepts task without optional fields", () => {
    const data = {
      id: "x", every: "30m", type: "scheduled", priority: "normal",
      context: {},
    };
    const result = ScheduledTaskSchema.safeParse(data);
    assert.ok(result.success);
    assert.equal(result.data.last_run, undefined);
    assert.equal(result.data.kind, undefined);
  });

  test("accepts script kind with command", () => {
    const data = {
      id: "cleanup", every: "1h", type: "maintenance", priority: "low",
      kind: "script" as const, command: "echo hi", timeout: 5000,
      context: {},
    };
    assert.ok(ScheduledTaskSchema.safeParse(data).success);
  });

  test("validates array of scheduled tasks", () => {
    const arr = [
      { id: "a", every: "1h", type: "t", priority: "p", context: {} },
      { id: "b", every: "daily", type: "t", priority: "p", context: {}, kind: "script" as const, command: "echo hi" },
    ];
    assert.ok(z.array(ScheduledTaskSchema).safeParse(arr).success);
  });
});

describe("SettingsSchema", () => {
  test("accepts real settings shape with discord fields", () => {
    const data = {
      name: "Franklin", mode: "allow_send", avatar: "Franklin.jpg",
      user_profile: { name: "Mike", discord_user_id: "123456789012345678", tone: "curt but witty" },
      authorized_users: [{ name: "mike", discord_user_id: "123456789012345678" }],
      integrations: ["discord", "gws"],
    };
    assert.ok(SettingsSchema.safeParse(data).success);
  });

  test("accepts multiple authorized users", () => {
    const data = {
      name: "Franklin", mode: "drafts_only",
      user_profile: { name: "Mike", discord_user_id: "111111111111111111", tone: "pro" },
      authorized_users: [
        { name: "mike", discord_user_id: "111111111111111111" },
        { name: "alice", discord_user_id: "222222222222222222" },
      ],
      integrations: [],
    };
    assert.ok(SettingsSchema.safeParse(data).success);
  });

  test("accepts settings with disabled_scouts", () => {
    const data = {
      name: "Franklin", mode: "allow_send",
      user_profile: { name: "Mike", discord_user_id: "111111111111111111", tone: "pro" },
      authorized_users: [{ name: "mike", discord_user_id: "111111111111111111" }],
      integrations: [],
      disabled_scouts: ["gmail", "calendar"],
    };
    const result = SettingsSchema.safeParse(data);
    assert.ok(result.success);
    assert.deepEqual(result.data.disabled_scouts, ["gmail", "calendar"]);
  });

  test("rejects settings missing authorized_users", () => {
    const data = {
      name: "Franklin", mode: "drafts_only",
      user_profile: { name: "Mike", discord_user_id: "111111111111111111", tone: "pro" },
      integrations: [],
    };
    assert.ok(!SettingsSchema.safeParse(data).success);
  });

  test("rejects settings missing user_profile", () => {
    const data = {
      name: "Franklin", mode: "drafts_only",
      authorized_users: [{ name: "mike", discord_user_id: "111111111111111111" }],
      integrations: [],
    };
    assert.ok(!SettingsSchema.safeParse(data).success);
  });

  test("rejects user_profile missing discord_user_id", () => {
    const data = {
      name: "Franklin", mode: "drafts_only",
      user_profile: { name: "Mike", tone: "pro" },
      authorized_users: [{ name: "mike", discord_user_id: "111111111111111111" }],
      integrations: [],
    };
    assert.ok(!SettingsSchema.safeParse(data).success);
  });

  test("rejects authorized_user missing discord_user_id", () => {
    const data = {
      name: "Franklin", mode: "drafts_only",
      user_profile: { name: "Mike", discord_user_id: "111111111111111111", tone: "pro" },
      authorized_users: [{ name: "mike" }],
      integrations: [],
    };
    assert.ok(!SettingsSchema.safeParse(data).success);
  });
});

describe("DelegationSchema", () => {
  test("accepts valid delegation file", () => {
    const data = {
      generated_at: "2026-04-12T23:25:00.000Z",
      tasks: [{ id: "t-1", type: "dm_reply", priority: "high", context: {}, mark_surfaced: null }],
    };
    assert.ok(DelegationSchema.safeParse(data).success);
  });

  test("accepts empty tasks array", () => {
    const data = { generated_at: "2026-04-12T23:25:00.000Z", tasks: [] };
    assert.ok(DelegationSchema.safeParse(data).success);
  });

  test("rejects delegation with invalid task", () => {
    const data = {
      generated_at: "2026-04-12T23:25:00.000Z",
      tasks: [{ id: 123, type: "x" }], // id should be string, missing fields
    };
    assert.ok(!DelegationSchema.safeParse(data).success);
  });
});
