import express from "express";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Client, GatewayIntentBits } from "discord.js";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { openDb } from "./src/db.js";
import { SCOUT_INTERVALS_MS, readJson } from "./src/config.js";
import { createLogger } from "./src/logger.js";
const log = createLogger("server");

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, "state");
const PORT = 7070;
const app = express();
app.use(express.json());
const db = openDb();

// ── Helpers ───────────────────────────────────────────────────────────────────


function timeAgo(isoStr: string | null): string {
  if (!isoStr) return "never";
  const delta = (Date.now() - new Date(isoStr).getTime()) / 1000;
  if (delta < 60) return `${Math.floor(delta)}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

function isStale(isoStr: string | null, maxSeconds: number): boolean {
  if (!isoStr) return true;
  return (Date.now() - new Date(isoStr).getTime()) / 1000 > maxSeconds;
}


function readQuestDir(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.match(/^quest-\d+\.json$/) && !f.includes("log"))
      .sort();
  } catch { return []; }
}

// ── Dashboard API ─────────────────────────────────────────────────────────────

app.get("/api/state", (_req, res) => {
  const lock = readJson<Record<string, string>>(join(STATE, "franklin.lock"));
  const lastRun = readJson<Record<string, unknown>>(join(STATE, "last_run.json"));

  const heartbeatTs = lock?.last_heartbeat ?? null;
  const running = !isStale(heartbeatTs, 300);

  const scoutLastRun = (lastRun?.scout_last_run ?? {}) as Record<string, string>;
  const scouts = Object.entries(SCOUT_INTERVALS_MS).map(([name, ms]) => {
    const intervalMin = ms / 60_000;
    const last = scoutLastRun[name] ?? null;
    return { name, last, lastAgo: timeAgo(last), intervalMin, overdue: isStale(last, intervalMin * 60 * 1.5) };
  });

  const activeDir = join(STATE, "quests", "active");
  const activeQuests = readQuestDir(activeDir).map((file) => {
    const quest = readJson<Record<string, unknown>>(join(activeDir, file));
    if (!quest) return null;
    const logFile = file.replace(".json", ".log.json");
    const logs = (readJson<Array<Record<string, unknown>>>(join(activeDir, logFile)) ?? []);
    const recentLogs = logs.slice(-5).reverse().map((e) => ({
      ago: timeAgo(e.timestamp as string),
      action: e.action,
      summary: ((e.summary as string) ?? "").slice(0, 200),
    }));
    return {
      id: quest.id,
      objective: quest.objective,
      status: quest.status,
      createdAgo: timeAgo(quest.created_at as string),
      agentStatus: quest.agent_status,
      prUrl: quest.pr_url ?? null,
      recentLogs,
      logCount: logs.length,
      raw: quest,
    };
  }).filter(Boolean);

  const completedDir = join(STATE, "quests", "completed");
  const recentCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const completedQuests = readQuestDir(completedDir)
    .map((file) => {
      const quest = readJson<Record<string, unknown>>(join(completedDir, file));
      if (!quest) return null;
      const updatedAt = (quest.updated_at as string) ?? "";
      if (updatedAt < recentCutoff) return null;
      return {
        id: quest.id,
        objective: (quest.objective as string) ?? "",
        outcome: (quest.outcome as string) ?? "",
        updatedAgo: timeAgo(updatedAt),
        prUrl: (quest.pr_url as string) ?? null,
        status: quest.status,
        raw: quest,
      };
    })
    .filter(Boolean)
    .slice(-10)
    .reverse();

  // Calendar — use timezone from settings for consistent date comparisons
  const calendar = readJson<{ events?: Array<{ title: string; start: string; end: string; notified?: boolean; location?: string; meetingUrl?: string; transcript_available?: boolean }> }>(join(STATE, "calendar.json"));
  const now = Date.now();
  const userSettings = readJson<{ timezone?: string }>(join(STATE, "settings.json"));
  const tz = userSettings?.timezone ?? "America/Chicago";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  const meetings = (calendar?.events ?? [])
    .filter((e) => e.start.includes("T")) // skip all-day events
    .filter((e) => {
      const eventDay = new Date(e.start).toLocaleDateString("en-CA", { timeZone: tz });
      return eventDay === today;
    })
    .filter((e) => new Date(e.start).getTime() > now - 30 * 60_000) // include meetings started <30min ago
    .map((e) => ({ title: e.title, start: e.start, end: e.end, location: e.location ?? "", meetingUrl: e.meetingUrl ?? "", notified: e.notified ?? false, transcript_available: e.transcript_available ?? false }))
    .slice(0, 8);

  // Discord bot status
  const socketData = readJson<{ status: string; updated_at: string }>(join(STATE, "discord_bot.json"));
  const socketStatus = socketData?.status ?? "unknown";
  const socketStale = isStale(socketData?.updated_at ?? null, 300);

  // Active workers from running_tasks DB table
  const activeWorkers = db.getRunningTasks().map((t) => ({
    task_id: t.task_id,
    type: t.type,
    priority: t.priority,
    started_at: t.dispatched_at,
    startedAgo: timeAgo(t.dispatched_at),
    timeout_ms: t.timeout_ms,
    quest_id: t.quest_id,
  }));

  const recentDispatches = db.getRecentDispatches(20).map((r) => ({
    ...r,
    completedAgo: timeAgo(r.completed_at as string),
  }));

  // Scheduled tasks
  const scheduledTasks = (readJson<Array<{ id: string; every: string; kind?: string; display_description?: string; context: { objective?: string; skill?: string }; last_run?: string }>>(join(STATE, "scheduled_tasks.json")) ?? [])
    .map((t) => ({ id: t.id, every: t.every, kind: t.kind ?? "worker", description: t.display_description ?? t.context?.skill ?? t.id, lastRun: t.last_run ?? null, lastRunAgo: timeAgo(t.last_run ?? null) }));

  // Inbox stats from DB
  const pending = db.getPendingSlackEvents().length;

  res.json({
    running,
    heartbeatAgo: timeAgo(heartbeatTs),
    lastCycleAgo: timeAgo((lastRun?.last_run_completed as string) ?? null),
    scouts,
    socketStatus,
    socketStale,
    socketAgo: timeAgo(socketData?.updated_at ?? null),
    activeWorkers,
    recentDispatches,
    activeQuests,
    completedQuests,
    meetings,
    scheduledTasks,
    channelPolicies: db.listChannelPolicies(),
    channelUserRules: db.listUserRules(),
    slackInboxPending: pending,
    serverTime: new Date().toISOString(),
  });
});

// ── Metrics API ──────────────────────────────────────────────────────────────

function countQuestActions(since: string | null): Record<string, number> {
  const counts: Record<string, number> = {};
  const dirs = [join(STATE, "quests", "completed"), join(STATE, "quests", "active")];
  for (const dir of dirs) {
    let files: string[];
    try { files = readdirSync(dir).filter(f => f.endsWith(".log.json")); } catch { continue; }
    for (const file of files) {
      const logs = readJson<Array<{ timestamp?: string; action?: string }>>(join(dir, file));
      if (!logs) continue;
      for (const entry of logs) {
        if (since && entry.timestamp && entry.timestamp < since) continue;
        const action = entry.action ?? "unknown";
        counts[action] = (counts[action] ?? 0) + 1;
      }
    }
  }
  return counts;
}

app.get("/api/metrics", (_req, res) => {
  const now = new Date();
  const metricsSettings = readJson<{ timezone?: string }>(join(STATE, "settings.json"));
  const mtz = metricsSettings?.timezone ?? "America/Chicago";
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: mtz }); // YYYY-MM-DD in user tz
  const todayStart = new Date(todayStr + "T00:00:00").toISOString();
  const weekStart = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const monthStart = new Date(now.getTime() - 30 * 86_400_000).toISOString();

  const periods: Record<string, { since: string | null }> = {
    today: { since: todayStart },
    week: { since: weekStart },
    month: { since: monthStart },
    all: { since: null },
  };

  const result: Record<string, unknown> = {};
  for (const [name, { since }] of Object.entries(periods)) {
    const metrics = db.getMetrics(since);
    const actions = countQuestActions(since);
    result[name] = {
      ...metrics,
      messagesSent: actions["message_sent"] ?? 0,
      prsCreated: actions["pr_created"] ?? 0,
      commitsPushed: actions["commit_pushed"] ?? 0,
      actions,
    };
  }

  res.json({ periods: result, serverTime: now.toISOString() });
});

app.get("/", (_req, res) => res.sendFile(join(__dirname, "index.html")));
app.get("/avatar.png", (_req, res) => res.sendFile(join(__dirname, "Franklin-Avatar.png")));

app.listen(PORT, "127.0.0.1", () => {
  log.info(`Franklin dashboard → http://localhost:${PORT}`);
});

// ── Discord Bot ───────────────────────────────────────────────────────────────

const DISCORD_HEARTBEAT_FILE = join(STATE, "discord_bot.json");
const sm = new SecretsManagerClient({ region: "us-east-2" });

function writeDiscordHeartbeat(status: string): void {
  writeFileSync(
    DISCORD_HEARTBEAT_FILE,
    JSON.stringify({ status, updated_at: new Date().toISOString() }) + "\n",
  );
}

(async () => {
  let discordToken: string;
  try {
    const response = await sm.send(new GetSecretValueCommand({ SecretId: "franklin/discord-bot-token" }));
    if (!response.SecretString) throw new Error("Secret has no string value");
    discordToken = response.SecretString;
  } catch (err) {
    log.error(`[discord] failed to fetch token from Secrets Manager: ${(err as Error).message}`);
    writeDiscordHeartbeat("error");
    return;
  }

  const settingsForAuth = readJson<{
    authorized_users?: Array<{ discord_user_id?: string }>;
  }>(join(STATE, "settings.json"));
  const authorizedDiscordIds = new Set(
    (settingsForAuth?.authorized_users ?? [])
      .map((u) => u.discord_user_id)
      .filter((id): id is string => typeof id === "string"),
  );

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    if (!authorizedDiscordIds.has(msg.author.id)) return;

    writeDiscordHeartbeat("connected");
    log.info(`[discord] message from=${msg.author.id} channel=${msg.channelId} text=${msg.content.slice(0, 80)}`);

    let threadId: string;

    if (msg.channel.isThread()) {
      threadId = msg.channelId;
    } else {
      try {
        const thread = await msg.startThread({
          name: msg.content.slice(0, 100) || "Conversation",
        });
        threadId = thread.id;
      } catch (err) {
        log.error(`[discord] failed to create thread: ${(err as Error).message}`);
        threadId = msg.channelId;
      }
    }

    db.insertSlackEvent({
      event_ts: msg.id,
      channel: threadId,
      channel_type: "im",
      user_id: msg.author.id,
      type: "message",
      text: msg.content,
      thread_ts: threadId,
      raw: msg.toJSON() as Record<string, unknown>,
    });

    try {
      await msg.react('🦝');
    } catch (err) {
      log.warn(`[discord] failed to react to message: ${(err as Error).message}`);
    }
  });

  client.on("error", (err) => {
    log.error(`[discord] error: ${err.message}`);
    writeDiscordHeartbeat("error");
  });

  const heartbeatInterval = setInterval(() => writeDiscordHeartbeat("connected"), 60_000);

  client.once("ready", () => {
    log.info(`[discord] bot started as ${client.user?.tag}`);
    writeDiscordHeartbeat("connected");
  });

  client.login(discordToken).catch((err) => {
    log.error(`[discord] login failed: ${(err as Error).message}`);
    writeDiscordHeartbeat("error");
    clearInterval(heartbeatInterval);
  });
})();
