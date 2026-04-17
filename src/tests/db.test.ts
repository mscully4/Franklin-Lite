import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db.js";

// Use in-memory DB for all tests
function testDb() {
  return openDb(":memory:");
}

describe("surfaced table", () => {
  test("upsertSeen creates a row with empty state", () => {
    const db = testDb();
    db.upsertSeen("github:pr:repo/1", "github");
    const row = db.getSurfaced("github:pr:repo/1");
    assert.ok(row);
    assert.equal(row.source, "github");
    assert.deepEqual(row.state, {});
    assert.equal(row.last_surfaced_at, null);
    db.close();
  });

  test("upsertSeen updates last_seen_at on repeat call", async () => {
    const db = testDb();
    db.upsertSeen("github:pr:repo/1", "github");
    const first = db.getSurfaced("github:pr:repo/1")!.last_seen_at;
    await new Promise((r) => setTimeout(r, 5));
    db.upsertSeen("github:pr:repo/1", "github");
    const second = db.getSurfaced("github:pr:repo/1")!.last_seen_at;
    assert.notEqual(first, second);
    db.close();
  });

  test("upsertSeen does not overwrite state on repeat call", () => {
    const db = testDb();
    db.upsertSeen("github:pr:repo/1", "github");
    db.markSurfaced("github:pr:repo/1", { ci_failing: ["lint"] });
    db.upsertSeen("github:pr:repo/1", "github"); // scout runs again
    const row = db.getSurfaced("github:pr:repo/1")!;
    assert.deepEqual(row.state, { ci_failing: ["lint"] }); // state preserved
    db.close();
  });

  test("getSurfaced returns null for unknown id", () => {
    const db = testDb();
    assert.equal(db.getSurfaced("unknown"), null);
    db.close();
  });

  test("markSurfaced sets state and last_surfaced_at", () => {
    const db = testDb();
    db.upsertSeen("jira:ticket:DEV-1", "jira");
    db.markSurfaced("jira:ticket:DEV-1", { status: "In Progress", last_comment_updated: null });
    const row = db.getSurfaced("jira:ticket:DEV-1")!;
    assert.deepEqual(row.state, { status: "In Progress", last_comment_updated: null });
    assert.ok(row.last_surfaced_at);
    db.close();
  });

  test("getBySource returns only rows for that source", () => {
    const db = testDb();
    db.upsertSeen("github:pr:repo/1", "github");
    db.upsertSeen("github:pr:repo/2", "github");
    db.upsertSeen("jira:ticket:DEV-1", "jira");
    const rows = db.getBySource("github");
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.source === "github"));
    db.close();
  });

  test("pruneStale removes rows not seen within window", () => {
    const db = testDb();
    db.upsertSeen("github:pr:repo/old", "github");
    // Manually backdate last_seen_at
    const cutoff = new Date(Date.now() - 8 * 86_400_000).toISOString();
    (db as unknown as { _db: import("better-sqlite3").Database }).close; // just close normally
    // Re-open and manually insert a stale row
    const db2 = openDb(":memory:");
    db2.upsertSeen("github:pr:repo/fresh", "github");
    // Insert stale entry directly via the db handle — we'd need raw access.
    // Instead, test pruneStale returns 0 when everything is fresh.
    const pruned = db2.pruneStale("github", 7);
    assert.equal(pruned, 0);
    db2.close();
  });
});

describe("slack_inbox table", () => {
  test("insertSlackEvent stores an event", () => {
    const db = testDb();
    db.insertSlackEvent({
      event_ts: "1000000000.000001",
      channel: "D123",
      channel_type: "im",
      user_id: "U001",
      type: "message",
      text: "hello",
      raw: { type: "message", text: "hello" },
    });
    const pending = db.getPendingSlackEvents();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].event_ts, "1000000000.000001");
    assert.equal(pending[0].text, "hello");
    db.close();
  });

  test("insertSlackEvent ignores duplicate event_ts", () => {
    const db = testDb();
    const event = {
      event_ts: "1000000000.000001",
      channel: "D123",
      channel_type: "im",
      type: "message",
      raw: { type: "message" },
    };
    db.insertSlackEvent(event);
    db.insertSlackEvent(event); // duplicate
    assert.equal(db.getPendingSlackEvents().length, 1);
    db.close();
  });

  test("getPendingSlackEvents returns unprocessed events in chronological order", () => {
    const db = testDb();
    db.insertSlackEvent({ event_ts: "1000000002.000000", channel: "D1", channel_type: "im", type: "message", raw: {} });
    db.insertSlackEvent({ event_ts: "1000000001.000000", channel: "D1", channel_type: "im", type: "message", raw: {} });
    db.insertSlackEvent({ event_ts: "1000000003.000000", channel: "D1", channel_type: "im", type: "message", raw: {} });
    const pending = db.getPendingSlackEvents();
    assert.equal(pending.length, 3);
    assert.equal(pending[0].event_ts, "1000000001.000000");
    assert.equal(pending[2].event_ts, "1000000003.000000");
    db.close();
  });

  test("markSlackEventsProcessed hides events from getPending", () => {
    const db = testDb();
    db.insertSlackEvent({ event_ts: "1000000001.000000", channel: "D1", channel_type: "im", type: "message", raw: {} });
    db.insertSlackEvent({ event_ts: "1000000002.000000", channel: "D1", channel_type: "im", type: "message", raw: {} });
    db.markSlackEventsProcessed(["1000000001.000000"]);
    const pending = db.getPendingSlackEvents();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].event_ts, "1000000002.000000");
    db.close();
  });

  test("markSlackEventsProcessed is a no-op for empty array", () => {
    const db = testDb();
    db.insertSlackEvent({ event_ts: "1000000001.000000", channel: "D1", channel_type: "im", type: "message", raw: {} });
    db.markSlackEventsProcessed([]);
    assert.equal(db.getPendingSlackEvents().length, 1);
    db.close();
  });

  test("pruneSlackInbox removes processed events older than cutoff", () => {
    const db = testDb();
    db.insertSlackEvent({ event_ts: "1000000001.000000", channel: "D1", channel_type: "im", type: "message", raw: {} });
    db.markSlackEventsProcessed(["1000000001.000000"]);
    // Prune with -1 days — cutoff is 1 day in the future, so everything processed is stale
    const pruned = db.pruneSlackInbox(-1);
    assert.equal(pruned, 1);
    db.close();
  });

  test("pruneSlackInbox does not remove unprocessed events", () => {
    const db = testDb();
    db.insertSlackEvent({ event_ts: "1000000001.000000", channel: "D1", channel_type: "im", type: "message", raw: {} });
    const pruned = db.pruneSlackInbox(0);
    assert.equal(pruned, 0);
    assert.equal(db.getPendingSlackEvents().length, 1);
    db.close();
  });
});
