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

  CREATE TABLE IF NOT EXISTS inflight_prs (
    signal_id       TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL,
    pid             INTEGER,
    started_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deploys (
    id              TEXT PRIMARY KEY,
    service         TEXT NOT NULL,
    description     TEXT,
    requester       TEXT,
    recommendation  TEXT,
    evidence        TEXT,
    evidence_at     TEXT,
    message_url     TEXT UNIQUE,
    status          TEXT NOT NULL DEFAULT 'pending',
    created_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS deploys_created ON deploys(created_at);

  CREATE TABLE IF NOT EXISTS channel_policies (
    channel_id       TEXT PRIMARY KEY,
    name             TEXT,
    trigger_mode     TEXT NOT NULL DEFAULT 'mention',
    allowed_users    TEXT NOT NULL DEFAULT 'owner',
    allowed_tasks    TEXT NOT NULL DEFAULT '["dm_reply"]',
    respond_to_bots  INTEGER NOT NULL DEFAULT 0,
    updated_at       TEXT NOT NULL,
    updated_by       TEXT
  );

  CREATE TABLE IF NOT EXISTS channel_user_rules (
    channel_id       TEXT NOT NULL,
    user_id          TEXT NOT NULL,
    permission       TEXT NOT NULL DEFAULT 'allow',
    allowed_tasks    TEXT,
    updated_at       TEXT NOT NULL,
    updated_by       TEXT,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS channel_user_rules_user ON channel_user_rules(user_id);

  CREATE TABLE IF NOT EXISTS running_tasks (
    task_id         TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    priority        TEXT NOT NULL,
    pid             INTEGER,
    timeout_ms      INTEGER NOT NULL,
    quest_id        TEXT,
    dispatched_at   TEXT NOT NULL,
    mark_surfaced   TEXT,
    context         TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS counters (
    name             TEXT PRIMARY KEY,
    value            INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO counters (name, value) VALUES ('task_id', 0);
`;

export interface IsAllowedResult {
  allowed: boolean;
  maxTaskType: "dm_reply" | "quest";
  triggerMode: "all" | "mention" | "none";
  respondToBots: boolean;
}

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

  // Migrations: add columns to deploys if missing
  const deployCols = db.pragma("table_info(deploys)") as Array<{ name: string }>;
  if (!deployCols.some((c) => c.name === "status")) {
    db.exec(`ALTER TABLE deploys ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`);
  }
  if (!deployCols.some((c) => c.name === "evidence_at")) {
    db.exec(`ALTER TABLE deploys ADD COLUMN evidence_at TEXT`);
  }

  // Seed default channel policies if the table is empty
  const policyCount = (db.prepare("SELECT COUNT(*) as cnt FROM channel_policies").get() as { cnt: number }).cnt;
  if (policyCount === 0) {
    const now = new Date().toISOString();
    const seedStmt = db.prepare(
      "INSERT INTO channel_policies (channel_id, name, trigger_mode, allowed_users, allowed_tasks, respond_to_bots, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    seedStmt.run("__default__", "Default",          "mention", "owner",      '["dm_reply"]',          0, now, null);
    seedStmt.run("im",          "Direct Messages",  "all",     "authorized", '["dm_reply","quest"]',  0, now, null);
    seedStmt.run("C0AS53FFR3K", "franklin-bot",     "all",     "authorized", '["dm_reply","quest"]',  0, now, null);
  }

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
     * Atomically reserve `count` task IDs and return them.
     * Uses the counters table so IDs are unique across processes.
     */
    nextTaskIds(count: number): string[] {
      const update = db.prepare(`UPDATE counters SET value = value + ? WHERE name = 'task_id'`);
      const select = db.prepare(`SELECT value FROM counters WHERE name = 'task_id'`);
      const ids: string[] = [];
      db.transaction(() => {
        update.run(count);
        const row = select.get() as { value: number };
        const end = row.value;
        for (let i = count; i >= 1; i--) {
          ids.push(`task-${String(end - i + 1).padStart(8, "0")}`);
        }
      })();
      return ids;
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
      const row = db.prepare(`SELECT id FROM quests ORDER BY id DESC LIMIT 1`).get() as { id: string } | undefined;
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

    // ── Inflight PRs ────────────────────────────────────────────────────────

    /**
     * Record that a worker/quest is actively working on a PR.
     */
    addInflightPr(signalId: string, taskId: string, pid: number | null): void {
      db.prepare(`
        INSERT OR REPLACE INTO inflight_prs (signal_id, task_id, pid, started_at)
        VALUES (?, ?, ?, ?)
      `).run(signalId, taskId, pid, new Date().toISOString());
    },

    /**
     * Remove an inflight PR entry (worker finished or was cleaned up).
     */
    removeInflightPr(signalId: string): void {
      db.prepare(`DELETE FROM inflight_prs WHERE signal_id = ?`).run(signalId);
    },

    /**
     * Get all inflight PR entries.
     */
    getInflightPrs(): Array<{ signal_id: string; task_id: string; pid: number | null; started_at: string }> {
      return db.prepare(`SELECT * FROM inflight_prs`).all() as Array<{
        signal_id: string; task_id: string; pid: number | null; started_at: string;
      }>;
    },

    // ── Running tasks ──────────────────────────────────────────────────────

    insertRunningTask(task: {
      task_id: string; type: string; priority: string; pid: number | null;
      timeout_ms: number; quest_id: string | null; dispatched_at: string;
      mark_surfaced: string | null; context: string;
    }): void {
      db.prepare(`
        INSERT OR REPLACE INTO running_tasks (task_id, type, priority, pid, timeout_ms, quest_id, dispatched_at, mark_surfaced, context)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(task.task_id, task.type, task.priority, task.pid, task.timeout_ms, task.quest_id, task.dispatched_at, task.mark_surfaced, task.context);
    },

    updateRunningTaskPid(taskId: string, pid: number): void {
      db.prepare(`UPDATE running_tasks SET pid = ? WHERE task_id = ?`).run(pid, taskId);
    },

    getRunningTasks(): Array<{
      task_id: string; type: string; priority: string; pid: number | null;
      timeout_ms: number; quest_id: string | null; dispatched_at: string;
      mark_surfaced: string | null; context: string;
    }> {
      return db.prepare(`SELECT * FROM running_tasks`).all() as ReturnType<typeof this.getRunningTasks>;
    },

    removeRunningTask(taskId: string): void {
      db.prepare(`DELETE FROM running_tasks WHERE task_id = ?`).run(taskId);
    },

    hasRunningTaskWithScheduledId(scheduledTaskId: string): boolean {
      const row = db.prepare(
        `SELECT 1 FROM running_tasks WHERE json_extract(context, '$.scheduled_task_id') = ? LIMIT 1`
      ).get(scheduledTaskId);
      return !!row;
    },

    // ── Metrics ─────────────────────────────────────────────────────────────

    /**
     * Aggregate dispatch_log, quest, and deploy counts since a given ISO timestamp.
     * Pass null for all-time.
     */
    getMetrics(since: string | null): {
      tasks: number;
      byType: Record<string, number>;
      byStatus: Record<string, number>;
      quests: number;
      questsWithPr: number;
      deploys: number;
    } {
      const whereClause = since ? `WHERE completed_at >= ?` : ``;
      const params = since ? [since] : [];

      // Dispatch counts by type and status
      const rows = db.prepare(
        `SELECT type, status, COUNT(*) as cnt FROM dispatch_log ${whereClause} GROUP BY type, status`
      ).all(...params) as Array<{ type: string; status: string; cnt: number }>;

      const byType: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      let tasks = 0;
      for (const r of rows) {
        byType[r.type] = (byType[r.type] ?? 0) + r.cnt;
        byStatus[r.status] = (byStatus[r.status] ?? 0) + r.cnt;
        tasks += r.cnt;
      }

      // Quest counts
      const questWhere = since ? `WHERE status = 'completed' AND updated_at >= ?` : `WHERE status = 'completed'`;
      const questParams = since ? [since] : [];
      const questRow = db.prepare(
        `SELECT COUNT(*) as cnt FROM quests ${questWhere}`
      ).get(...questParams) as { cnt: number };

      const questPrWhere = since
        ? `WHERE status = 'completed' AND pr_url IS NOT NULL AND updated_at >= ?`
        : `WHERE status = 'completed' AND pr_url IS NOT NULL`;
      const questPrRow = db.prepare(
        `SELECT COUNT(*) as cnt FROM quests ${questPrWhere}`
      ).get(...questParams) as { cnt: number };

      // Deploy counts
      const deployWhere = since ? `WHERE created_at >= ?` : ``;
      const deployRow = db.prepare(
        `SELECT COUNT(*) as cnt FROM deploys ${deployWhere}`
      ).get(...params) as { cnt: number };

      return {
        tasks,
        byType,
        byStatus,
        quests: questRow.cnt,
        questsWithPr: questPrRow.cnt,
        deploys: deployRow.cnt,
      };
    },

    // ── Deploys ──────────────────────────────────────────────────────────────

    insertDeploy(entry: {
      id: string;
      service: string;
      description?: string;
      requester?: string;
      recommendation?: string;
      evidence?: string;
      message_url?: string;
    }): void {
      const now = new Date().toISOString();
      const evidenceAt = entry.evidence ? now : null;
      db.prepare(`
        INSERT OR REPLACE INTO deploys (id, service, description, requester, recommendation, evidence, evidence_at, message_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(entry.id, entry.service, entry.description ?? null, entry.requester ?? null, entry.recommendation ?? null, entry.evidence ?? null, evidenceAt, entry.message_url ?? null, now);
    },

    /**
     * Insert a deploy only if its ID doesn't already exist (preserves recommendation/evidence).
     * Updates status on existing entries.
     */
    upsertDeployIfNew(entry: {
      id: string;
      service: string;
      description?: string;
      requester?: string;
      status?: string;
      message_url?: string;
      created_at?: string;
    }): void {
      const now = entry.created_at ?? new Date().toISOString();
      db.prepare(`
        INSERT INTO deploys (id, service, description, requester, status, message_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status
      `).run(entry.id, entry.service, entry.description ?? null, entry.requester ?? null, entry.status ?? "pending", entry.message_url ?? null, now);
    },

    /**
     * Remove deploys whose ID is not in the given active set.
     */
    removeDeploysNotIn(activeIds: string[]): number {
      if (!activeIds.length) {
        const result = db.prepare(`DELETE FROM deploys`).run();
        return result.changes;
      }
      const placeholders = activeIds.map(() => "?").join(",");
      const result = db.prepare(`DELETE FROM deploys WHERE id NOT IN (${placeholders})`).run(...activeIds);
      return result.changes;
    },

    getRecentDeploys(limit = 10): Array<{
      id: string;
      service: string;
      description: string | null;
      requester: string | null;
      recommendation: string | null;
      evidence: string | null;
      message_url: string | null;
      status: string;
      created_at: string;
    }> {
      return db.prepare(`SELECT * FROM deploys ORDER BY created_at DESC LIMIT ?`).all(limit) as ReturnType<typeof this.getRecentDeploys>;
    },

    getPendingDeploysNeedingReview(): Array<{
      id: string;
      service: string;
      description: string | null;
      requester: string | null;
      message_url: string | null;
      status: string;
      created_at: string;
      evidence_at: string | null;
    }> {
      const staleThreshold = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      return db.prepare(
        `SELECT id, service, description, requester, message_url, status, created_at, evidence_at
         FROM deploys WHERE status = 'pending'
           AND (evidence IS NULL OR evidence = '' OR evidence_at < ?)
         ORDER BY created_at ASC`
      ).all(staleThreshold) as ReturnType<typeof this.getPendingDeploysNeedingReview>;
    },

    pruneDeploys(days = 7): number {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const result = db.prepare(`DELETE FROM deploys WHERE created_at < ?`).run(cutoff);
      return result.changes;
    },

    // ── Channel auth ──────────────────────────────────────────────────────────

    getChannelPolicy(channelId: string): {
      channel_id: string; name: string | null; trigger_mode: string;
      allowed_users: string; allowed_tasks: string[]; respond_to_bots: boolean;
      updated_at: string; updated_by: string | null;
    } | null {
      const row = db.prepare(`SELECT * FROM channel_policies WHERE channel_id = ?`).get(channelId) as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        channel_id: row.channel_id as string,
        name: row.name as string | null,
        trigger_mode: row.trigger_mode as string,
        allowed_users: row.allowed_users as string,
        allowed_tasks: JSON.parse(row.allowed_tasks as string),
        respond_to_bots: Boolean(row.respond_to_bots),
        updated_at: row.updated_at as string,
        updated_by: row.updated_by as string | null,
      };
    },

    resolveChannelPolicy(channelId: string, channelType: string): {
      channel_id: string; name: string | null; trigger_mode: string;
      allowed_users: string; allowed_tasks: string[]; respond_to_bots: boolean;
    } {
      const LAST_RESORT = {
        channel_id: "__hardcoded__", name: null, trigger_mode: "mention" as const,
        allowed_users: "owner", allowed_tasks: ["dm_reply"], respond_to_bots: false,
      };
      // 1. Exact channel match
      const exact = this.getChannelPolicy(channelId);
      if (exact) return exact;
      // 2. DM fallback
      if (channelType === "im") {
        const im = this.getChannelPolicy("im");
        if (im) return im;
      }
      // 3. Default
      const def = this.getChannelPolicy("__default__");
      if (def) return def;
      // 4. Hardcoded last resort
      return LAST_RESORT;
    },

    getUserOverride(channelId: string, userId: string): {
      permission: string; allowed_tasks: string[] | null;
    } | null {
      const row = db.prepare(
        `SELECT permission, allowed_tasks FROM channel_user_rules WHERE channel_id = ? AND user_id = ?`
      ).get(channelId, userId) as { permission: string; allowed_tasks: string | null } | undefined;
      if (!row) return null;
      return {
        permission: row.permission,
        allowed_tasks: row.allowed_tasks ? JSON.parse(row.allowed_tasks) : null,
      };
    },

    isAllowed(
      channelId: string, channelType: string, userId: string,
      ownerId: string, authorizedIds: Set<string>,
    ): IsAllowedResult {
      const NOT_ALLOWED: IsAllowedResult = { allowed: false, maxTaskType: "dm_reply", triggerMode: "none", respondToBots: false };

      // 1. Check per-user override
      const override = this.getUserOverride(channelId, userId);
      if (override?.permission === "deny") return NOT_ALLOWED;

      // 2. Resolve channel policy
      const policy = this.resolveChannelPolicy(channelId, channelType);

      // 3. Check allowed_users (unless user has an explicit allow override)
      if (!override) {
        const users = policy.allowed_users;
        if (users === "owner" && userId !== ownerId) return NOT_ALLOWED;
        if (users === "authorized" && !authorizedIds.has(userId)) return NOT_ALLOWED;
        if (users !== "owner" && users !== "authorized" && users !== "any") {
          // JSON array of user IDs
          try {
            const arr = JSON.parse(users) as string[];
            if (!arr.includes(userId)) return NOT_ALLOWED;
          } catch { return NOT_ALLOWED; }
        }
      }

      // 4. Determine max task type from override or policy
      const tasks = override?.allowed_tasks ?? policy.allowed_tasks;
      const maxTaskType = tasks.includes("quest") ? "quest" as const : "dm_reply" as const;

      return {
        allowed: true,
        maxTaskType,
        triggerMode: policy.trigger_mode as "all" | "mention" | "none",
        respondToBots: policy.respond_to_bots,
      };
    },

    listChannelPolicies(): Array<{
      channel_id: string; name: string | null; trigger_mode: string;
      allowed_users: string; allowed_tasks: string[]; respond_to_bots: boolean;
      updated_at: string; updated_by: string | null;
    }> {
      const rows = db.prepare(`SELECT * FROM channel_policies ORDER BY channel_id`).all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        channel_id: row.channel_id as string,
        name: row.name as string | null,
        trigger_mode: row.trigger_mode as string,
        allowed_users: row.allowed_users as string,
        allowed_tasks: JSON.parse(row.allowed_tasks as string),
        respond_to_bots: Boolean(row.respond_to_bots),
        updated_at: row.updated_at as string,
        updated_by: row.updated_by as string | null,
      }));
    },

    listUserRules(channelId?: string): Array<{
      channel_id: string; user_id: string; permission: string;
      allowed_tasks: string[] | null; updated_at: string; updated_by: string | null;
    }> {
      const query = channelId
        ? db.prepare(`SELECT * FROM channel_user_rules WHERE channel_id = ? ORDER BY user_id`)
        : db.prepare(`SELECT * FROM channel_user_rules ORDER BY channel_id, user_id`);
      const rows = (channelId ? query.all(channelId) : query.all()) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        channel_id: row.channel_id as string,
        user_id: row.user_id as string,
        permission: row.permission as string,
        allowed_tasks: row.allowed_tasks ? JSON.parse(row.allowed_tasks as string) : null,
        updated_at: row.updated_at as string,
        updated_by: row.updated_by as string | null,
      }));
    },

    upsertChannelPolicy(fields: {
      channel_id: string; name?: string; trigger_mode: string;
      allowed_users: string; allowed_tasks: string[]; respond_to_bots: boolean;
    }, updatedBy: string): void {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO channel_policies (channel_id, name, trigger_mode, allowed_users, allowed_tasks, respond_to_bots, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          name = excluded.name,
          trigger_mode = excluded.trigger_mode,
          allowed_users = excluded.allowed_users,
          allowed_tasks = excluded.allowed_tasks,
          respond_to_bots = excluded.respond_to_bots,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `).run(
        fields.channel_id, fields.name ?? null, fields.trigger_mode,
        fields.allowed_users, JSON.stringify(fields.allowed_tasks),
        fields.respond_to_bots ? 1 : 0, now, updatedBy,
      );
    },

    upsertUserRule(fields: {
      channel_id: string; user_id: string; permission: string;
      allowed_tasks?: string[];
    }, updatedBy: string): void {
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO channel_user_rules (channel_id, user_id, permission, allowed_tasks, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id, user_id) DO UPDATE SET
          permission = excluded.permission,
          allowed_tasks = excluded.allowed_tasks,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `).run(
        fields.channel_id, fields.user_id, fields.permission,
        fields.allowed_tasks ? JSON.stringify(fields.allowed_tasks) : null,
        now, updatedBy,
      );
    },

    removeUserRule(channelId: string, userId: string): void {
      db.prepare(`DELETE FROM channel_user_rules WHERE channel_id = ? AND user_id = ?`).run(channelId, userId);
    },

    close(): void {
      db.close();
    },
  };
}
