#!/usr/bin/env npx tsx
/**
 * Slack channels scout — polls channels that need API-based history reads.
 *
 * Channels:
 *   - #warn-developer-services (C03GX4SM7RN) — ops alerts, filtered to team services
 *
 * Note: #deploy-bot is handled via Socket Mode → channel signal handlers
 * (see scripts/channel-signals.ts).
 *
 * Writes results to state/scout_results/slack_channels.json and upserts to franklin.db.
 *
 * Usage: npx tsx scripts/scouts/slack_channels.ts
 */

import { WebClient, ErrorCode } from "@slack/web-api";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { readJson } from "../config.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb } from "../db.js";
import { createLogger } from "../logger.js";
import { matchesTeamService } from "../channel-signals.js";
const log = createLogger("slack_channels");

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SECRETS_DIR = join(ROOT, "secrets");
const RESULT_FILE = join(ROOT, "state", "scout_results", "slack_channels.json");
const ACCESS_TOKEN_FILE = join(SECRETS_DIR, "franklin_user_oauth_token.txt");
const REFRESH_TOKEN_FILE = join(SECRETS_DIR, "slack_refresh_token.txt");
const CLIENT_SECRET_FILE = join(SECRETS_DIR, "franklin_client_secret.txt");
const CLIENT_ID = "1601185624273.8899143856786";

const WARN_CHANNEL = "C03GX4SM7RN";       // #warn-developer-services

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChannelEntry {
  id: string;
  source: "ops_alert" | "deploy_approval";
  ts: string;
  channel: string;
  author_id: string;
  text: string;
  permalink: string | null;
  service: string | null;        // extracted service name, if identifiable
  deploy_description: string | null;
}

type SlackMessage = Record<string, unknown>;

// ── Token management (shared pattern with slack.ts) ─────────────────────────

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

  let client = new WebClient(token, { retryConfig: { retries: 3 } });
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
      client = new WebClient(token, { retryConfig: { retries: 3 } });
    } else {
      throw err;
    }
  }
  return client;
}

// ── Channel pollers ─────────────────────────────────────────────────────────

async function pollWarnChannel(
  client: WebClient,
  lastTs: string,
  errors: string[],
): Promise<ChannelEntry[]> {
  const entries: ChannelEntry[] = [];
  try {
    const resp = await client.conversations.history({
      channel: WARN_CHANNEL,
      oldest: lastTs,
      limit: 50,
    });
    for (const msg of (resp.messages as SlackMessage[]) ?? []) {
      const text = (msg.text as string) ?? "";
      const service = matchesTeamService(text);
      if (!service) continue; // only care about team services
      entries.push({
        id: `slack:ops_alert:${WARN_CHANNEL}/${msg.ts as string}`,
        source: "ops_alert",
        ts: msg.ts as string,
        channel: WARN_CHANNEL,
        author_id: (msg.user as string) ?? (msg.bot_id as string) ?? "unknown",
        text,
        permalink: null,
        service,
        deploy_description: null,
      });
    }
  } catch (e: unknown) {
    errors.push(`warn_channel: ${(e as Error).message?.slice(0, 150)}`);
  }
  return entries;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const collectedAt = new Date().toISOString();
  const errors: string[] = [];

  const lastRun = readJson<{ scout_last_run?: Record<string, string> }>(
    join(ROOT, "state", "last_run.json"),
  );

  // Use last scout run time as cursor, fall back to 1h ago
  const lastScoutTs = lastRun?.scout_last_run?.slack_channels;
  const lastTs = lastScoutTs
    ? String(new Date(lastScoutTs).getTime() / 1000)
    : String((Date.now() - 60 * 60 * 1000) / 1000);

  log.info(`Polling channels from ts=${lastTs}`);

  const client = await getClient();
  const allEntries: ChannelEntry[] = [];
  const seen = new Set<string>();

  function add(entries: ChannelEntry[]) {
    for (const e of entries) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        allEntries.push(e);
      }
    }
  }

  add(await pollWarnChannel(client, lastTs, errors));

  allEntries.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

  const result = {
    scout: "slack_channels",
    collected_at: collectedAt,
    status: errors.length === 0 ? "ok" : "error",
    error: errors.length > 0 ? errors.join("; ") : null,
    entries: allEntries,
  };

  mkdirSync(join(ROOT, "state", "scout_results"), { recursive: true });
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

  const db = openDb();
  for (const entry of allEntries) {
    db.upsertSeen(entry.id, "slack_channels");
  }
  const pruned = db.pruneStale("slack_channels");
  db.close();

  log.info(`${allEntries.length} entries, ${errors.length} errors, ${pruned} pruned → ${RESULT_FILE}`);
}

main().catch((err) => {
  log.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
