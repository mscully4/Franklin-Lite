import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { makeSignalsMethods } from "./signals.js";
import { makeTaskMethods } from "./tasks.js";
import { makeChannelAuthMethods } from "./channel-auth.js";
import { makeDeployMethods } from "./deploys.js";

export type { SurfacedRow } from "./signals.js";
export type { IsAllowedResult } from "./channel-auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "../..", "state", "franklin.db");

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

  CREATE TABLE IF NOT EXISTS dispatch_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id         TEXT NOT NULL,
    type            TEXT NOT NULL,
    priority        TEXT NOT NULL,
    dedup_key       TEXT NOT NULL DEFAULT '',
    dispatched_at   TEXT NOT NULL,
    completed_at    TEXT NOT NULL,
    status          TEXT NOT NULL,
    summary         TEXT,
    quest_id        TEXT,
    category        TEXT,
    cost_usd        REAL
  );
  CREATE INDEX IF NOT EXISTS dispatch_log_status    ON dispatch_log(status);
  CREATE INDEX IF NOT EXISTS dispatch_log_completed ON dispatch_log(completed_at);
  CREATE INDEX IF NOT EXISTS dispatch_log_type      ON dispatch_log(type);

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
    category        TEXT,
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
    context         TEXT NOT NULL DEFAULT '{}',
    assigned_ip     TEXT
  );

  CREATE TABLE IF NOT EXISTS counters (
    name             TEXT PRIMARY KEY,
    value            INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO counters (name, value) VALUES ('task_id', 0);
`;

function applyMigrations(db: InstanceType<typeof Database>): void {
  const deployCols = db.pragma("table_info(deploys)") as Array<{ name: string }>;
  if (!deployCols.some((c) => c.name === "status")) {
    db.exec(`ALTER TABLE deploys ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`);
  }
  if (!deployCols.some((c) => c.name === "evidence_at")) {
    db.exec(`ALTER TABLE deploys ADD COLUMN evidence_at TEXT`);
  }

  const runningCols = db.pragma("table_info(running_tasks)") as Array<{ name: string }>;
  if (!runningCols.some((c) => c.name === "assigned_ip")) {
    db.exec(`ALTER TABLE running_tasks ADD COLUMN assigned_ip TEXT`);
  }

  const dispatchCols = db.pragma("table_info(dispatch_log)") as Array<{ name: string }>;
  if (!dispatchCols.some((c) => c.name === "dedup_key")) {
    db.exec(`ALTER TABLE dispatch_log ADD COLUMN dedup_key TEXT NOT NULL DEFAULT ''`);
  }
  if (!dispatchCols.some((c) => c.name === "quest_id")) {
    db.exec(`ALTER TABLE dispatch_log ADD COLUMN quest_id TEXT`);
  }
  if (!dispatchCols.some((c) => c.name === "category")) {
    db.exec(`ALTER TABLE dispatch_log ADD COLUMN category TEXT`);
  }
  if (!dispatchCols.some((c) => c.name === "cost_usd")) {
    db.exec(`ALTER TABLE dispatch_log ADD COLUMN cost_usd REAL`);
  }

  const questCols = db.pragma("table_info(quests)") as Array<{ name: string }>;
  if (!questCols.some((c) => c.name === "category")) {
    db.exec(`ALTER TABLE quests ADD COLUMN category TEXT`);
  }

  // Deduplicate dispatch_log: keep only the latest row per task_id
  const dupCount = (db.prepare(
    `SELECT COUNT(*) as cnt FROM dispatch_log WHERE id NOT IN (SELECT MAX(id) FROM dispatch_log GROUP BY task_id)`
  ).get() as { cnt: number }).cnt;
  if (dupCount > 0) {
    db.exec(`DELETE FROM dispatch_log WHERE id NOT IN (SELECT MAX(id) FROM dispatch_log GROUP BY task_id)`);
    console.log(`[db] deduplicated dispatch_log: removed ${dupCount} duplicate rows`);
  }

  // Add unique index to prevent future duplicates
  const indices = db.pragma("index_list(dispatch_log)") as Array<{ name: string }>;
  if (!indices.some((i) => i.name === "dispatch_log_task_id_unique")) {
    db.exec(`CREATE UNIQUE INDEX dispatch_log_task_id_unique ON dispatch_log(task_id)`);
  }
}

function seedChannelPolicies(db: InstanceType<typeof Database>): void {
  const policyCount = (db.prepare("SELECT COUNT(*) as cnt FROM channel_policies").get() as { cnt: number }).cnt;
  if (policyCount !== 0) return;

  const now = new Date().toISOString();
  const stmt = db.prepare(
    "INSERT INTO channel_policies (channel_id, name, trigger_mode, allowed_users, allowed_tasks, respond_to_bots, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  stmt.run("__default__", "Default",         "mention", "owner",      '["dm_reply"]',         0, now, null);
  stmt.run("im",          "Direct Messages", "all",     "authorized", '["dm_reply","quest"]', 0, now, null);
  stmt.run("C0AS53FFR3K", "franklin-bot",    "all",     "authorized", '["dm_reply","quest"]', 0, now, null);
}

export function openDb(path = DB_PATH) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  applyMigrations(db);
  seedChannelPolicies(db);

  return {
    ...makeSignalsMethods(db),
    ...makeTaskMethods(db),
    ...makeChannelAuthMethods(db),
    ...makeDeployMethods(db),
    close(): void { db.close(); },
  };
}
