#!/usr/bin/env npx tsx
/**
 * Slack scout — covers search-only sources that socket mode can't reach.
 * Writes results to state/scout_results/slack.json and upserts to franklin.db.
 *
 * Sources:
 *   1. Active quest thread replies in channels the bot isn't in
 *   2. @franklin name mentions (2-day window for search index lag)
 *   3. Usergroup mentions
 *
 * Note: DMs, direct @mentions, and reactions are delivered in real-time by
 * server.ts via socket mode → the slack_inbox DB table.
 *
 * Usage: npx tsx scripts/scouts/slack.ts
 */

import { WebClient, ErrorCode } from "@slack/web-api";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { readJson } from "../config.js";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { openDb } from "../db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SECRETS_DIR = join(ROOT, "secrets");
const RESULT_FILE = join(ROOT, "state", "scout_results", "slack.json");
const ACCESS_TOKEN_FILE = join(SECRETS_DIR, "franklin_user_oauth_token.txt");
const REFRESH_TOKEN_FILE = join(SECRETS_DIR, "slack_refresh_token.txt");
const CLIENT_SECRET_FILE = join(SECRETS_DIR, "franklin_client_secret.txt");
const CLIENT_ID = "1601185624273.8899143856786";
const USERGROUPS = ["stablecoin-solutions-org", "stablecoin-console-dev-only"];

const RETRY_CONFIG = {
  retries: 5,
  factor: 2,
  minTimeout: 1000,
  maxTimeout: 30_000,
  randomize: true,
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SlackEntry {
  id: string;           // slack:{source}:{channel}/{ts}
  source: string;       // quest_thread_reply | franklin_name_mention | usergroup_mention
  ts: string;
  channel: string;
  thread_ts: string | null;
  author_id: string;
  text: string;
  permalink: string | null;
  quest_id: string | null;
}

interface QuestThread {
  channel: string;
  thread_ts: string;
  quest_id: string;
}

type SlackMessage = Record<string, unknown>;

// ── Token management ──────────────────────────────────────────────────────────

async function refreshAccessToken(): Promise<string> {
  const refreshToken = readFileSync(REFRESH_TOKEN_FILE, "utf8").trim();
  const clientSecret = readFileSync(CLIENT_SECRET_FILE, "utf8").trim();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  const resp = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const result = (await resp.json()) as Record<string, unknown>;
  if (!result.ok) throw new Error(`Token refresh failed: ${result.error}`);
  const authedUser = result.authed_user as Record<string, string>;
  writeFileSync(ACCESS_TOKEN_FILE, authedUser.access_token + "\n");
  if (authedUser.refresh_token) writeFileSync(REFRESH_TOKEN_FILE, authedUser.refresh_token + "\n");
  return authedUser.access_token;
}

async function getClient(): Promise<WebClient> {
  let token = existsSync(ACCESS_TOKEN_FILE) ? readFileSync(ACCESS_TOKEN_FILE, "utf8").trim() : undefined;
  if (!token) throw new Error("No Slack token found at " + ACCESS_TOKEN_FILE);

  let client = new WebClient(token, { retryConfig: RETRY_CONFIG });
  try {
    await client.auth.test();
  } catch (err: unknown) {
    const isExpired =
      err instanceof Error &&
      "code" in err &&
      (err as { code: string }).code === ErrorCode.PlatformError &&
      "data" in err &&
      ((err as { data: { error: string } }).data.error === "token_expired" ||
        (err as { data: { error: string } }).data.error === "invalid_auth");
    if (isExpired && existsSync(REFRESH_TOKEN_FILE) && existsSync(CLIENT_SECRET_FILE)) {
      token = await refreshAccessToken();
      client = new WebClient(token, { retryConfig: RETRY_CONFIG });
    } else {
      throw err;
    }
  }
  return client;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dateStr(offsetDays: number): string {
  const d = new Date(Date.now() - offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function loadQuestThreads(): QuestThread[] {
  const activeDir = join(ROOT, "state", "quests", "active");
  if (!existsSync(activeDir)) return [];
  const threads: QuestThread[] = [];
  for (const file of readdirSync(activeDir)) {
    if (!file.endsWith(".json") || file.includes(".log")) continue;
    const quest = readJson<{ id: string; source?: { channel?: string; thread_ts?: string } }>(
      join(activeDir, file)
    );
    if (quest?.source?.channel && quest.source.thread_ts) {
      threads.push({
        channel: quest.source.channel,
        thread_ts: quest.source.thread_ts,
        quest_id: quest.id,
      });
    }
  }
  return threads;
}

// ── Sub-scouts ────────────────────────────────────────────────────────────────

async function pollQuestThreads(
  client: WebClient,
  threads: QuestThread[],
  lastTs: string,
  errors: string[],
): Promise<SlackEntry[]> {
  const entries: SlackEntry[] = [];
  await Promise.all(
    threads.map(async (qt) => {
      try {
        const resp = await client.conversations.replies({ channel: qt.channel, ts: qt.thread_ts, limit: 200 });
        for (const msg of ((resp.messages as SlackMessage[]) ?? []).slice(1)) {
          if (parseFloat(msg.ts as string) > parseFloat(lastTs)) {
            entries.push({
              id: `slack:quest_thread_reply:${qt.channel}/${msg.ts as string}`,
              source: "quest_thread_reply",
              ts: msg.ts as string,
              channel: qt.channel,
              thread_ts: qt.thread_ts,
              author_id: (msg.user as string) ?? (msg.bot_id as string) ?? "unknown",
              text: (msg.text as string) ?? "",
              permalink: null,
              quest_id: qt.quest_id,
            });
          }
        }
      } catch (e: unknown) {
        errors.push(`quest_thread ${qt.quest_id}: ${(e as Error).message?.slice(0, 100)}`);
      }
    })
  );
  return entries;
}

async function pollMentions(
  client: WebClient,
  userId: string,
  lastTs: string,
  errors: string[],
): Promise<SlackEntry[]> {
  const entries: SlackEntry[] = [];
  const searches: Array<{ source: string; query: string; skipSelf: boolean }> = [
    { source: "franklin_name_mention", query: `@franklin after:${dateStr(2)}`, skipSelf: false },
    ...USERGROUPS.map((g) => ({ source: "usergroup_mention", query: `@${g} after:${dateStr(1)}`, skipSelf: true })),
  ];

  await Promise.all(
    searches.map(async ({ source, query, skipSelf }) => {
      try {
        let page = 1;
        while (true) {
          const resp = await client.search.messages({ query, count: 100, page });
          const matches = (resp.messages as { matches?: SlackMessage[] })?.matches ?? [];
          for (const m of matches) {
            if (parseFloat(m.ts as string) <= parseFloat(lastTs)) continue;
            if (skipSelf && (m.user as string) === userId) continue;
            const channel =
              m.channel && typeof m.channel === "object"
                ? ((m.channel as { id?: string }).id ?? "")
                : ((m.channel as string) ?? "");
            const rawThreadTs = m.thread_ts as string | undefined;
            const isReply = rawThreadTs && rawThreadTs !== (m.ts as string);
            entries.push({
              id: `slack:${source}:${channel}/${m.ts as string}`,
              source,
              ts: m.ts as string,
              channel,
              thread_ts: isReply ? rawThreadTs! : null,
              author_id: (m.user as string) ?? "unknown",
              text: (m.text as string) ?? "",
              permalink: (m.permalink as string) ?? null,
              quest_id: null,
            });
          }
          const paging = (resp.messages as { paging?: { pages?: number } })?.paging ?? {};
          if (page >= (paging.pages ?? 1)) break;
          page++;
        }
      } catch (e: unknown) {
        const code = (e as { data?: { error?: string } })?.data?.error;
        if (code === "not_allowed_token_type" || code === "missing_scope") return;
        errors.push(`${source}: ${(e as Error).message?.slice(0, 100)}`);
      }
    })
  );

  return entries;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const collectedAt = new Date().toISOString();
  const errors: string[] = [];

  const lastRun = readJson<{ last_drain_ts?: string; scout_last_run?: Record<string, string> }>(
    join(ROOT, "state", "last_run.json")
  );
  const settings = readJson<{ user_profile?: { slack_user_id?: string } }>(
    join(ROOT, "state", "settings.json")
  );
  const lastTs = lastRun?.last_drain_ts ?? "0";
  const userId = settings?.user_profile?.slack_user_id ?? "";

  console.log(`[slack] Polling from ts=${lastTs}`);

  const client = await getClient();
  const questThreads = loadQuestThreads();
  console.log(`[slack] ${questThreads.length} active quest threads`);

  const allEntries: SlackEntry[] = [];
  const seen = new Set<string>();

  function add(entries: SlackEntry[]) {
    for (const e of entries) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        allEntries.push(e);
      }
    }
  }

  add(await pollQuestThreads(client, questThreads, lastTs, errors));
  add(await pollMentions(client, userId, lastTs, errors));

  allEntries.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  console.log(`[slack] ${allEntries.length} entries, ${errors.length} errors`);

  const result = {
    scout: "slack",
    collected_at: collectedAt,
    status: errors.length === 0 ? "ok" : "error",
    error: errors.length > 0 ? errors.join("; ") : null,
    entries: allEntries,
  };

  mkdirSync(join(ROOT, "state", "scout_results"), { recursive: true });
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

  const db = openDb();
  for (const entry of allEntries) {
    db.upsertSeen(entry.id, "slack");
  }
  const pruned = db.pruneStale("slack");
  db.close();

  console.log(`Slack scout: ${allEntries.length} entries, ${errors.length} errors, ${pruned} pruned → ${RESULT_FILE}`);
}

main().catch((err) => {
  process.stderr.write(`Error: ${(err as Error).message}\n`);
  process.exit(1);
});
