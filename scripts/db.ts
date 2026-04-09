/**
 * Shared SQLite helper for Franklin state.
 * Database: state/franklin.db
 *
 * Usage:
 *   import { openDb } from "../scripts/db.js";
 *   const db = openDb();
 *   db.upsertSeen("github:pr:crcl-main/wallets-api/3077", "github");
 *   db.getSurfaced("github:pr:crcl-main/wallets-api/3077");
 *   db.markSurfaced("github:pr:crcl-main/wallets-api/3077", { ci_failing: ["lint"] });
 *   db.pruneStale("github", 7);
 */

import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "state", "franklin.db");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS surfaced (
    id               TEXT PRIMARY KEY,
    source           TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    last_surfaced_at TEXT,
    last_seen_at     TEXT NOT NULL,
    state            TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS surfaced_source    ON surfaced(source);
  CREATE INDEX IF NOT EXISTS surfaced_last_seen ON surfaced(last_seen_at);

  CREATE TABLE IF NOT EXISTS slack_inbox (
    event_ts     TEXT PRIMARY KEY,
    channel      TEXT NOT NULL,
    channel_type TEXT NOT NULL,
    user_id      TEXT,
    type         TEXT NOT NULL,
    reaction     TEXT,
    text         TEXT,
    raw          TEXT NOT NULL,
    received_at  TEXT NOT NULL,
    processed    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS slack_inbox_pending ON slack_inbox(processed, event_ts);

  CREATE TABLE IF NOT EXISTS dispatch_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id         TEXT NOT NULL,
    type            TEXT NOT NULL,
    priority        TEXT NOT NULL,
    dispatched_at   TEXT NOT NULL,
    completed_at    TEXT NOT NULL,
    status          TEXT NOT NULL,
    summary         TEXT
  );
  CREATE INDEX IF NOT EXISTS dispatch_log_status ON dispatch_log(status);
  CREATE INDEX IF NOT EXISTS dispatch_log_completed ON dispatch_log(completed_at);
  CREATE INDEX IF NOT EXISTS dispatch_log_type ON dispatch_log(type);

  CREATE TABLE IF NOT EXISTS quests (
    id              TEXT PRIMARY KEY,
    status          TEXT NOT NULL DEFAULT 'active',
    objective       TEXT NOT NULL,
    approach        TEXT NOT NULL DEFAULT '[]',
    requested_by    TEXT,
    source_platform TEXT,
    source_task_id  TEXT,
    ticket_key      TEXT,
    sandbox_path    TEXT,
    pr_url          TEXT,
    outcome         TEXT,
    agent_status    TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS quests_status     ON quests(status);
  CREATE INDEX IF NOT EXISTS quests_created_at ON quests(created_at);
`;

export interface SurfacedRow {
  id: string;
  source: string;
  created_at: string;
  last_surfaced_at: string | null;
  last_seen_at: string;
  state: Record<string, unknown>;
}

export function openDb(path = DB_PATH) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  return {
    /**
     * Mark an entry as seen this run. Creates the row if it doesn't exist.
     * Call this for every entry a scout observes, regardless of whether it changed.
     */
    upsertSeen(id: string, source: string): void {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO surfaced (id, source, created_at, last_seen_at, state)
        VALUES (?, ?, ?, ?, '{}')
        ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
      `).run(id, source, now, now);
    },

    /**
     * Get a surfaced row by ID. Returns null if not found.
     * `state` is parsed from JSON before returning.
     */
    getSurfaced(id: string): SurfacedRow | null {
      const row = db.prepare(`SELECT * FROM surfaced WHERE id = ?`).get(id) as
        | (Omit<SurfacedRow, "state"> & { state: string })
        | undefined;
      if (!row) return null;
      return { ...row, state: JSON.parse(row.state) };
    },

    /**
     * Get all surfaced rows for a source.
     * Used by the brain to load only the signals it needs.
     */
    getBySource(source: string): SurfacedRow[] {
      const rows = db.prepare(`SELECT * FROM surfaced WHERE source = ?`).all(source) as Array<
        Omit<SurfacedRow, "state"> & { state: string }
      >;
      return rows.map((r) => ({ ...r, state: JSON.parse(r.state) }));
    },

    /**
     * Record that the brain surfaced this signal to the user.
     * Stores the current state so the brain can detect changes next time.
     */
    markSurfaced(id: string, state: Record<string, unknown>): void {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE surfaced SET last_surfaced_at = ?, state = ? WHERE id = ?
      `).run(now, JSON.stringify(state), id);
    },

    /**
     * Delete rows for a source that haven't been seen in `days` days.
     * Call at the end of each scout run.
     */
    pruneStale(source: string, days = 7): number {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const result = db.prepare(`
        DELETE FROM surfaced WHERE source = ? AND last_seen_at < ?
      `).run(source, cutoff);
      return result.changes;
    },

    // ── Slack inbox ────────────────────────────────────────────────────────────

    /**
     * Insert a raw Slack event. Ignores duplicate event_ts (at-least-once delivery).
     */
    insertSlackEvent(event: {
      event_ts: string;
      channel: string;
      channel_type: string;
      user_id?: string;
      type: string;
      reaction?: string;
      text?: string;
      raw: Record<string, unknown>;
    }): void {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT OR IGNORE INTO slack_inbox
          (event_ts, channel, channel_type, user_id, type, reaction, text, raw, received_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.event_ts,
        event.channel,
        event.channel_type,
        event.user_id ?? null,
        event.type,
        event.reaction ?? null,
        event.text ?? null,
        JSON.stringify(event.raw),
        now,
      );
    },

    /**
     * Get all unprocessed events in chronological order.
     */
    getPendingSlackEvents(): Array<{
      event_ts: string;
      channel: string;
      channel_type: string;
      user_id: string | null;
      type: string;
      reaction: string | null;
      text: string | null;
      raw: Record<string, unknown>;
      received_at: string;
    }> {
      const rows = db.prepare(`
        SELECT * FROM slack_inbox WHERE processed = 0 ORDER BY event_ts ASC
      `).all() as Array<Record<string, unknown>>;
      return rows.map((r) => ({ ...r, raw: JSON.parse(r.raw as string) })) as ReturnType<typeof this.getPendingSlackEvents>;
    },

    /**
     * Mark events as processed by event_ts.
     */
    markSlackEventsProcessed(eventTs: string[]): void {
      if (eventTs.length === 0) return;
      const placeholders = eventTs.map(() => "?").join(",");
      db.prepare(`UPDATE slack_inbox SET processed = 1 WHERE event_ts IN (${placeholders})`).run(...eventTs);
    },

    /**
     * Prune processed events older than `days` days.
     */
    pruneSlackInbox(days = 2): number {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const result = db.prepare(`DELETE FROM slack_inbox WHERE processed = 1 AND received_at < ?`).run(cutoff);
      return result.changes;
    },

    // ── Dispatch log ──────────────────────────────────────────────────────────

    /**
     * Append a dispatch log entry.
     */
    insertDispatch(entry: {
      task_id: string;
      type: string;
      priority: string;
      dispatched_at: string;
      completed_at: string;
      status: string;
      summary: string | null;
    }): void {
      db.prepare(`
        INSERT INTO dispatch_log (task_id, type, priority, dispatched_at, completed_at, status, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(entry.task_id, entry.type, entry.priority, entry.dispatched_at, entry.completed_at, entry.status, entry.summary);
    },

    /**
     * Get the last task_id from the dispatch log.
     */
    lastTaskId(): string | null {
      const row = db.prepare(`SELECT task_id FROM dispatch_log ORDER BY id DESC LIMIT 1`).get() as { task_id: string } | undefined;
      return row?.task_id ?? null;
    },

    /**
     * Get recent dispatch entries.
     */
    getRecentDispatches(limit = 20): Array<Record<string, unknown>> {
      return db.prepare(`SELECT * FROM dispatch_log ORDER BY id DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>;
    },

    /**
     * Prune dispatch entries older than `days` days.
     */
    pruneDispatchLog(days = 30): number {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const result = db.prepare(`DELETE FROM dispatch_log WHERE completed_at < ?`).run(cutoff);
      return result.changes;
    },

    // ── Quests ─────────────────────────────────────────────────────────────────

    /**
     * Insert or update a quest. Upserts on id.
     */
    upsertQuest(quest: {
      id: string;
      status: string;
      objective: string;
      approach?: string[];
      requested_by?: string;
      source_platform?: string;
      source_task_id?: string;
      ticket_key?: string;
      sandbox_path?: string;
      pr_url?: string;
      outcome?: string;
      agent_status?: string;
    }): void {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO quests (id, status, objective, approach, requested_by, source_platform, source_task_id, ticket_key, sandbox_path, pr_url, outcome, agent_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          objective = excluded.objective,
          approach = excluded.approach,
          requested_by = excluded.requested_by,
          source_platform = excluded.source_platform,
          source_task_id = excluded.source_task_id,
          ticket_key = excluded.ticket_key,
          sandbox_path = excluded.sandbox_path,
          pr_url = excluded.pr_url,
          outcome = excluded.outcome,
          agent_status = excluded.agent_status,
          updated_at = excluded.updated_at
      `).run(
        quest.id,
        quest.status,
        quest.objective,
        JSON.stringify(quest.approach ?? []),
        quest.requested_by ?? null,
        quest.source_platform ?? null,
        quest.source_task_id ?? null,
        quest.ticket_key ?? null,
        quest.sandbox_path ?? null,
        quest.pr_url ?? null,
        quest.outcome ?? null,
        quest.agent_status ?? "pending",
        now,
        now,
      );
    },

    /**
     * Get the next quest ID (max numeric id + 1).
     */
    nextQuestId(): string {
      const row = db.prepare(`SELECT id FROM quests ORDER BY created_at DESC LIMIT 1`).get() as { id: string } | undefined;
      const lastNum = row?.id?.match(/(\d+)/)?.[1] ? parseInt(row.id.match(/(\d+)/)![1], 10) : 0;
      return `quest-${String(lastNum + 1).padStart(8, "0")}`;
    },

    /**
     * Get a quest by ID.
     */
    getQuest(id: string): Record<string, unknown> | null {
      const row = db.prepare(`SELECT * FROM quests WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
      if (!row) return null;
      return { ...row, approach: JSON.parse(row.approach as string) };
    },

    /**
     * Get quests by status.
     */
    getQuestsByStatus(status: string): Array<Record<string, unknown>> {
      const rows = db.prepare(`SELECT * FROM quests WHERE status = ? ORDER BY created_at DESC`).all(status) as Array<Record<string, unknown>>;
      return rows.map((r) => ({ ...r, approach: JSON.parse(r.approach as string) }));
    },

    /**
     * Update quest status and optionally other fields.
     */
    updateQuestStatus(id: string, status: string, fields?: { agent_status?: string; outcome?: string; pr_url?: string }): void {
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE quests SET status = ?, agent_status = COALESCE(?, agent_status), outcome = COALESCE(?, outcome), pr_url = COALESCE(?, pr_url), updated_at = ? WHERE id = ?
      `).run(status, fields?.agent_status ?? null, fields?.outcome ?? null, fields?.pr_url ?? null, now, id);
    },

    close(): void {
      db.close();
    },
  };
}
