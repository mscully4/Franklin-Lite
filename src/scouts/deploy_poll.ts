#!/usr/bin/env npx tsx
/**
 * Deploy poll scout — polls #deploy-bot for pending deploy approvals.
 *
 * Reads message history, filters for messages @-mentioning the owner,
 * checks reactions to determine status:
 *   - No relevant reactions → "pending" (needs attention)
 *   - :+1: from owner → "approved" (signed off, not yet shipped)
 *   - :ship: → deployed (removed from DB entirely)
 *
 * Syncs the deploys table so the dashboard always shows current state,
 * even on a fresh startup.
 *
 * Usage: npx tsx scripts/scouts/deploy_poll.ts
 */

import { WebClient, ErrorCode } from "@slack/web-api";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { readJson } from "../config.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb } from "../db.js";
import { createLogger } from "../logger.js";
import { matchesTeamService } from "../channel-signals.js";
const log = createLogger("deploy_poll");

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const SECRETS_DIR = join(ROOT, "secrets");
const RESULT_FILE = join(ROOT, "state", "scout_results", "deploy_poll.json");
const ACCESS_TOKEN_FILE = join(SECRETS_DIR, "franklin_user_oauth_token.txt");
const REFRESH_TOKEN_FILE = join(SECRETS_DIR, "slack_refresh_token.txt");
const CLIENT_SECRET_FILE = join(SECRETS_DIR, "franklin_client_secret.txt");
const CLIENT_ID = "1601185624273.8899143856786";

const DEPLOY_CHANNEL = "CTDAN6570"; // #deploy-bot
const LOOKBACK_DAYS = 7;

// ── Token management (shared pattern) ────────────────────────────────────────

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

// ── Types ────────────────────────────────────────────────────────────────────

type SlackMessage = Record<string, unknown>;

interface Reaction {
  name: string;
  users: string[];
  count: number;
}

interface DeployEntry {
  id: string;
  service: string;
  description: string;
  requester: string;
  status: "pending" | "approved";
  message_url: string;
  created_at: string;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const collectedAt = new Date().toISOString();
  const errors: string[] = [];

  const settings = readJson<{
    owner_user_id?: string;
    user_profile?: { slack_user_id?: string };
  }>(join(ROOT, "state", "settings.json"));
  const ownerUserId = settings?.owner_user_id ?? settings?.user_profile?.slack_user_id ?? "";
  if (!ownerUserId) {
    log.error("No owner user ID in settings — cannot determine deploy ownership");
    process.exit(1);
  }

  const oldest = String((Date.now() - LOOKBACK_DAYS * 86_400_000) / 1000);

  log.info(`Polling #deploy-bot for messages mentioning ${ownerUserId} (last ${LOOKBACK_DAYS}d)`);

  const client = await getClient();
  const activeEntries: DeployEntry[] = [];

  try {
    // Paginate through channel history
    let cursor: string | undefined;
    const messages: SlackMessage[] = [];
    while (true) {
      const resp = await client.conversations.history({
        channel: DEPLOY_CHANNEL,
        oldest,
        limit: 200,
        cursor,
      });
      messages.push(...((resp.messages as SlackMessage[]) ?? []));
      if (!resp.has_more) break;
      cursor = resp.response_metadata?.next_cursor;
      if (!cursor) break;
    }

    // Sort all messages newest-first (pagination with `oldest` param can mix ordering across pages)
    messages.sort((a, b) => parseFloat(b.ts as string) - parseFloat(a.ts as string));

    // Keep only the most recent message per service.
    const seenServices = new Set<string>();

    for (const msg of messages) {
      const text = (msg.text as string) ?? "";

      // Only care about messages that @-mention the owner
      if (!text.includes(`<@${ownerUserId}>`)) continue;

      const service = matchesTeamService(text) ?? "unknown";
      if (seenServices.has(service)) continue; // older message for same service — skip
      seenServices.add(service);

      const reactions = (msg.reactions as Reaction[] | undefined) ?? [];
      const hasShip = reactions.some((r) => r.name === "ship");
      if (hasShip) continue; // deployed — don't track

      const hasThumbsUp = reactions.some(
        (r) => r.name === "+1" && r.users.includes(ownerUserId),
      );

      const ts = msg.ts as string;
      const requester = (msg.user as string) ?? (msg.bot_id as string) ?? "unknown";
      const msgUrl = `https://circlefin.slack.com/archives/${DEPLOY_CHANNEL}/p${ts.replace(".", "")}`;

      activeEntries.push({
        id: `deploy:${DEPLOY_CHANNEL}/${ts}`,
        service,
        description: text.slice(0, 500),
        requester,
        status: hasThumbsUp ? "approved" : "pending",
        message_url: msgUrl,
        created_at: new Date(parseFloat(ts) * 1000).toISOString(),
      });
    }
  } catch (e: unknown) {
    errors.push(`deploy_poll: ${(e as Error).message?.slice(0, 200)}`);
  }

  // Sync to DB
  const db = openDb();
  const activeIds: string[] = [];

  for (const entry of activeEntries) {
    db.upsertDeployIfNew(entry);
    activeIds.push(entry.id);
  }

  const removed = db.removeDeploysNotIn(activeIds);
  db.close();

  // Write scout result
  const result = {
    scout: "deploy_poll",
    collected_at: collectedAt,
    status: errors.length === 0 ? "ok" : "error",
    error: errors.length > 0 ? errors.join("; ") : null,
    pending: activeEntries.filter((e) => e.status === "pending").length,
    approved: activeEntries.filter((e) => e.status === "approved").length,
    total: activeEntries.length,
    removed,
  };

  mkdirSync(join(ROOT, "state", "scout_results"), { recursive: true });
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

  log.info(
    `${activeEntries.length} active deploys (${result.pending} pending, ${result.approved} approved), ` +
    `${removed} removed → ${RESULT_FILE}`
  );
}

main().catch((err) => {
  log.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
