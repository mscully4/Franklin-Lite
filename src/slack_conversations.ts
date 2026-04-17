#!/usr/bin/env npx tsx
/**
 * Retrieve conversations and messages from Slack.
 * Usage: npx tsx scripts/slack_conversations.ts <command> [options]
 *
 * Commands:
 *   list    — list all conversations the token can access
 *   fetch   — fetch messages from a channel
 *   thread  — fetch all replies in a thread
 *   react   — add a reaction to a message
 *   scout   — poll search-only Slack sources (runs every 10 min alongside socket mode)
 *
 * ## Architecture
 *
 * Socket Mode (server.js) handles real-time delivery of DMs, @mentions, and
 * reactions — writing raw events to state/slack_inbox.jsonl. Franklin drains
 * that inbox each cycle.
 *
 * This script handles the sources socket mode can't cover, run every 10 min:
 *
 * ### Source 1: Active quest thread replies (non-bot channels)
 * For each active quest with a source.thread_ts in a channel the bot isn't in,
 * fetches replies since last_ts. Tagged `quest_thread_reply`.
 *
 * ### Source 2: Mention searches
 * Uses search.messages (requires user token — bot tokens lack `search:read`):
 *   - `@franklin after:YYYY-MM-DD`     → franklin_name_mention (2d window to
 *                                         guard against search index lag)
 *   - `@<usergroup> after:YYYY-MM-DD`  → usergroup_mention (one search per
 *                                         group, skips the user's own messages)
 *
 * Note: direct @mentions of the bot in channels are delivered via socket
 * (app_mention event) — no search needed for those.
 *
 * ### Deduplication
 * Results deduplicated on (ts, channel), sorted ascending by ts.
 *
 * ### Token refresh
 * The token stored in secrets/franklin_user_oauth_token.txt is a rotatable xoxp
 * user token. If auth.test() returns token_expired or invalid_auth, the script
 * automatically POSTs to oauth.v2.access with the refresh token and client
 * secret, writes the new access token back to disk, and retries.
 */

import { WebClient, ErrorCode } from "@slack/web-api";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SECRETS_DIR = resolve(SCRIPT_DIR, "../secrets");
const ACCESS_TOKEN_FILE = resolve(SECRETS_DIR, "franklin_user_oauth_token.txt");
const REFRESH_TOKEN_FILE = resolve(SECRETS_DIR, "slack_refresh_token.txt");
const CLIENT_SECRET_FILE = resolve(SECRETS_DIR, "franklin_client_secret.txt");
const CLIENT_ID = "1601185624273.8899143856786";

// ── Retry config ─────────────────────────────────────────────────────────────
// Applied to every WebClient instance. Handles both 429 rate limits (via
// Retry-After header) and 5xx server errors (exponential backoff).
const RETRY_CONFIG = {
  retries: 5,
  factor: 2,
  minTimeout: 1000,
  maxTimeout: 30_000,
  randomize: true,
};

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
  if (!result.ok) {
    process.stderr.write(`Token refresh failed: ${result.error}\n`);
    process.exit(1);
  }

  const authedUser = result.authed_user as Record<string, string>;
  const newToken = authedUser.access_token;
  writeFileSync(ACCESS_TOKEN_FILE, newToken + "\n");

  if (authedUser.refresh_token) {
    writeFileSync(REFRESH_TOKEN_FILE, authedUser.refresh_token + "\n");
  }

  return newToken;
}

async function getClient(): Promise<WebClient> {
  let token: string | undefined;

  if (existsSync(ACCESS_TOKEN_FILE)) {
    token = readFileSync(ACCESS_TOKEN_FILE, "utf8").trim();
  } else {
    token = process.env.SLACK_BOT_TOKEN ?? process.env.SLACK_TOKEN;
    if (!token) {
      const fallback = resolve(homedir(), "DevEnv/secrets/slack_access_token.txt");
      if (existsSync(fallback)) token = readFileSync(fallback, "utf8").trim();
    }
  }

  if (!token) {
    process.stderr.write("No Slack token found.\n");
    process.exit(1);
  }

  let client = new WebClient(token, { retryConfig: RETRY_CONFIG });

  // Test token — refresh if expired
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

// ── API helpers ───────────────────────────────────────────────────────────────

type SlackMessage = Record<string, unknown>;

async function getMessages(
  client: WebClient,
  channelId: string,
  limit = 100,
  oldest?: string,
  latest?: string
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;

  while (messages.length < limit) {
    const resp = await client.conversations.history({
      channel: channelId,
      limit: Math.min(limit - messages.length, 200),
      oldest,
      latest,
      cursor,
    });

    messages.push(...((resp.messages as SlackMessage[]) ?? []));
    if (!resp.has_more) break;
    cursor = resp.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  return messages.slice(0, limit);
}

async function getThreadReplies(
  client: WebClient,
  channelId: string,
  threadTs: string
): Promise<SlackMessage[]> {
  const replies: SlackMessage[] = [];
  let cursor: string | undefined;

  while (true) {
    const resp = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 200,
      cursor,
    });

    replies.push(...((resp.messages as SlackMessage[]) ?? []));
    cursor = resp.response_metadata?.next_cursor;
    if (!cursor) break;
  }

  return replies;
}

async function searchMessages(
  client: WebClient,
  query: string,
  count = 100
): Promise<SlackMessage[]> {
  const matches: SlackMessage[] = [];
  let page = 1;

  while (true) {
    const resp = await client.search.messages({ query, count: Math.min(count, 100), page });
    const batch = (resp.messages as { matches?: SlackMessage[] })?.matches ?? [];
    matches.push(...batch);
    const paging = (resp.messages as { paging?: { pages?: number } })?.paging ?? {};
    if (page >= (paging.pages ?? 1) || matches.length >= count) break;
    page++;
  }

  return matches;
}

// ── Scout ─────────────────────────────────────────────────────────────────────

interface ScoutEntry {
  ts: string;
  channel: string;
  thread_ts: string | null;
  author_id: string;
  text: string;
  source: string;
  permalink: string | null;
  quest_id?: string;
}

interface QuestThread {
  channel: string;
  thread_ts: string;
  quest_id?: string;
}

function searchMsgToEntry(m: SlackMessage, source: string): ScoutEntry {
  const channel =
    m.channel && typeof m.channel === "object"
      ? ((m.channel as { id?: string }).id ?? "")
      : ((m.channel as string) ?? "");
  const rawThreadTs = m.thread_ts as string | undefined;
  const isReply = rawThreadTs && rawThreadTs !== (m.ts as string);
  return {
    ts: m.ts as string,
    channel,
    thread_ts: isReply ? rawThreadTs! : null,
    author_id: (m.user as string) ?? "unknown",
    text: (m.text as string) ?? "",
    source,
    permalink: (m.permalink as string) ?? null,
  };
}

async function scout(
  client: WebClient,
  lastTs: string,
  userId: string,
  twoDaysAgo: string,
  yesterday: string,
  questThreads: QuestThread[],
  usergroups: string[]
): Promise<{ last_ts: string; messages: ScoutEntry[] }> {
  const messages: ScoutEntry[] = [];
  const seen = new Set<string>();

  function add(entry: ScoutEntry) {
    const key = `${entry.ts}:${entry.channel}`;
    if (!seen.has(key)) {
      seen.add(key);
      messages.push(entry);
    }
  }

  // ── 1. Active quest thread replies ────────────────────────────────────────
  // Fetches replies in channels the bot may not be subscribed to via socket.
  await Promise.all(
    questThreads.map(async (qt) => {
      try {
        const replies = await getThreadReplies(client, qt.channel, qt.thread_ts);
        for (const reply of replies.slice(1)) {
          if (parseFloat(reply.ts as string) > parseFloat(lastTs)) {
            add({
              ts: reply.ts as string,
              channel: qt.channel,
              thread_ts: qt.thread_ts,
              author_id: (reply.user as string) ?? (reply.bot_id as string) ?? "unknown",
              text: (reply.text as string) ?? "",
              source: "quest_thread_reply",
              permalink: null,
              quest_id: qt.quest_id,
            });
          }
        }
      } catch {
        // ignore individual thread errors
      }
    })
  );

  // ── 2. Mention searches ────────────────────────────────────────────────────
  // search.messages requires user token — bot tokens lack `search:read`.
  // Direct @mentions of the bot are delivered via socket (app_mention) so
  // direct_mention search is no longer needed here.
  const searches: Array<[string, string]> = [
    ["franklin_name_mention", `@franklin after:${twoDaysAgo}`],
    ...usergroups.map((g): [string, string] => [`usergroup_mention`, `@${g} after:${yesterday}`]),
  ];

  await Promise.all(
    searches.map(async ([source, query]) => {
      try {
        const results = await searchMessages(client, query);
        for (const m of results) {
          if (parseFloat(m.ts as string) > parseFloat(lastTs)) {
            if (source === "usergroup_mention" && (m.user as string) === userId) continue;
            add(searchMsgToEntry(m, source));
          }
        }
      } catch (err: unknown) {
        const error = (err as { data?: { error?: string } })?.data?.error;
        if (error === "not_allowed_token_type" || error === "missing_scope") return;
        throw err;
      }
    })
  );

  messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  return { last_ts: lastTs, messages };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    process.stderr.write("Usage: slack_conversations.ts <list|fetch|thread|react|scout> [options]\n");
    process.exit(1);
  }

  const client = await getClient();

  function flag(name: string): string | undefined {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  }
  function hasFlag(name: string): boolean {
    return args.includes(name);
  }

  if (command === "list") {
    const types = flag("--types") ?? "public_channel,private_channel,im,mpim";
    const convos: SlackMessage[] = [];
    let cursor: string | undefined;
    while (true) {
      const resp = await client.conversations.list({ types, limit: 200, cursor });
      convos.push(...((resp.channels as SlackMessage[]) ?? []));
      cursor = resp.response_metadata?.next_cursor;
      if (!cursor) break;
    }
    if (hasFlag("--json")) {
      console.log(JSON.stringify(convos, null, 2));
    } else {
      for (const c of convos) {
        const name = (c.name as string) ?? (c.user as string) ?? (c.id as string);
        const type = c.is_im ? "DM" : c.is_mpim ? "group DM" : c.is_private ? "private" : "public";
        console.log(`${String(c.id).padStart(15)}  [${type.padStart(8)}]  ${name}`);
      }
    }
  } else if (command === "fetch") {
    const channelId = args[1];
    const limit = parseInt(flag("--limit") ?? "100");
    const oldest = flag("--oldest");
    const latest = flag("--latest");
    const withThreads = hasFlag("--threads");
    const asJson = hasFlag("--json");

    const msgs = await getMessages(client, channelId, limit, oldest, latest);

    if (withThreads) {
      for (const msg of msgs) {
        if ((msg.reply_count as number) > 0) {
          (msg as Record<string, unknown>).replies = (
            await getThreadReplies(client, channelId, msg.ts as string)
          ).slice(1);
        }
      }
    }

    if (asJson) {
      console.log(JSON.stringify(msgs, null, 2));
    } else {
      for (const msg of [...msgs].reverse()) {
        const user = (msg.user as string) ?? (msg.bot_id as string) ?? "unknown";
        const ts = new Date(parseFloat(msg.ts as string) * 1000).toISOString();
        const text = ((msg.text as string) ?? "").replace(/\n/g, " ").slice(0, 120);
        console.log(`[${ts}] ${user}: ${text}`);
      }
    }
  } else if (command === "thread") {
    const channelId = args[1];
    const ts = args[2];
    const asJson = hasFlag("--json");
    const replies = await getThreadReplies(client, channelId, ts);
    if (asJson) {
      console.log(JSON.stringify(replies, null, 2));
    } else {
      for (const msg of replies) {
        const user = (msg.user as string) ?? (msg.bot_id as string) ?? "unknown";
        const msgTs = new Date(parseFloat(msg.ts as string) * 1000).toISOString();
        const text = ((msg.text as string) ?? "").replace(/\n/g, " ").slice(0, 120);
        console.log(`[${msgTs}] ${user}: ${text}`);
      }
    }
  } else if (command === "react") {
    const channelId = args[1];
    const ts = args[2];
    const emoji = args[3];
    if (!channelId || !ts || !emoji) {
      process.stderr.write("Usage: react <channel> <ts> <emoji>\n");
      process.exit(1);
    }
    await client.reactions.add({ channel: channelId, name: emoji, timestamp: ts });
    console.log(`Added :${emoji}: to ${channelId}/${ts}`);
  } else if (command === "scout") {
    const lastTs = flag("--last-ts")!;
    const userId = flag("--user-id")!;
    const yesterday = flag("--yesterday")!;
    const twoDaysAgo = flag("--two-days-ago")!;
    const questThreads: QuestThread[] = JSON.parse(flag("--quest-threads") ?? "[]");
    const usergroups = (flag("--usergroups") ?? "stablecoin-solutions-org,stablecoin-console-dev-only")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean);

    const result = await scout(
      client,
      lastTs,
      userId,
      twoDaysAgo,
      yesterday,
      questThreads,
      usergroups
    );
    console.log(JSON.stringify(result));
  } else {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
