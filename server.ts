import express from "express";
import { readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { openDb } from "./scripts/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, "state");
const PORT = 7070;

const app = express();
const db = openDb();

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJSON<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { return null; }
}

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
  const lock = readJSON<Record<string, string>>(join(STATE, "franklin.lock"));
  const lastRun = readJSON<Record<string, unknown>>(join(STATE, "last_run.json"));

  const heartbeatTs = lock?.last_heartbeat ?? null;
  const running = !isStale(heartbeatTs, 300);

  const SCOUT_INTERVALS: Record<string, number> = {
    github: 10,
    jira: 10,
    gmail: 15,
    calendar: 10,
  };
  const scoutLastRun = (lastRun?.scout_last_run ?? {}) as Record<string, string>;
  const scouts = Object.entries(SCOUT_INTERVALS).map(([name, intervalMin]) => {
    const last = scoutLastRun[name] ?? null;
    return { name, last, lastAgo: timeAgo(last), intervalMin, overdue: isStale(last, intervalMin * 60 * 1.5) };
  });

  const activeDir = join(STATE, "quests", "active");
  const activeQuests = readQuestDir(activeDir).map((file) => {
    const quest = readJSON<Record<string, unknown>>(join(activeDir, file));
    if (!quest) return null;
    const logFile = file.replace(".json", ".log.json");
    const logs = (readJSON<Array<Record<string, unknown>>>(join(activeDir, logFile)) ?? []);
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
    };
  }).filter(Boolean);

  const completedDir = join(STATE, "quests", "completed");
  const completedQuests = readQuestDir(completedDir)
    .map((file) => {
      const quest = readJSON<Record<string, unknown>>(join(completedDir, file));
      if (!quest) return null;
      return { id: quest.id, objective: ((quest.objective as string) ?? "").slice(0, 80), updatedAgo: timeAgo(quest.updated_at as string) };
    })
    .filter(Boolean)
    .slice(-5)
    .reverse();

  // Calendar
  const calendar = readJSON<{ events?: Array<{ title: string; start: string; end: string; notified?: boolean; location?: string; meetingUrl?: string; transcript_available?: boolean }> }>(join(STATE, "calendar.json"));
  const now = Date.now();
  const nowDate = new Date();
  const today = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, "0")}-${String(nowDate.getDate()).padStart(2, "0")}`;
  const meetings = (calendar?.events ?? [])
    .filter((e) => e.start.includes("T")) // skip all-day events
    .filter((e) => {
      const d = new Date(e.start);
      const eventDay = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      return eventDay === today;
    })
    .filter((e) => new Date(e.start).getTime() > now - 30 * 60_000) // include meetings started <30min ago
    .map((e) => ({ title: e.title, start: e.start, end: e.end, location: e.location ?? "", meetingUrl: e.meetingUrl ?? "", notified: e.notified ?? false, transcript_available: e.transcript_available ?? false }))
    .slice(0, 8);

  // Socket status
  const socketData = readJSON<{ status: string; updated_at: string }>(join(STATE, "slack_socket.json"));
  const socketStatus = socketData?.status ?? "unknown";
  const socketStale = isStale(socketData?.updated_at ?? null, 300);

  // Active workers and recent dispatch history
  const activeWorkersData = readJSON<{ updated_at: string; workers: Array<{ task_id: string; type: string; priority: string; started_at: string }> }>(join(STATE, "active_workers.json"));
  const activeWorkers = (activeWorkersData?.workers ?? []).map((w) => ({
    ...w,
    startedAgo: timeAgo(w.started_at),
  }));

  const recentDispatches = db.getRecentDispatches(20).map((r) => ({
    ...r,
    completedAgo: timeAgo(r.completed_at as string),
  }));

  // Scheduled tasks
  const scheduledTasks = (readJSON<Array<{ id: string; every: string; kind?: string; context: { objective?: string; skill?: string }; last_run?: string }>>(join(STATE, "scheduled_tasks.json")) ?? [])
    .map((t) => ({ id: t.id, every: t.every, kind: t.kind ?? "worker", objective: t.context?.objective ?? t.context?.skill ?? t.id, lastRun: t.last_run ?? null, lastRunAgo: timeAgo(t.last_run ?? null) }));

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
    slackInboxPending: pending,
    serverTime: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => res.sendFile(join(__dirname, "index.html")));
app.get("/avatar.png", (_req, res) => res.sendFile(join(__dirname, "Franklin-Avatar.png")));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Franklin dashboard → http://localhost:${PORT}`);
});

// ── Socket Mode ───────────────────────────────────────────────────────────────

const SOCKET_TOKEN_FILE = join(__dirname, "secrets", "franklin_socket_token.txt");
const BOT_TOKEN_FILE = join(__dirname, "secrets", "franklin_bot_oauth_token.txt");
const SOCKET_HEARTBEAT_FILE = join(STATE, "slack_socket.json");
const SOCKET_LOCK_FILE = join(STATE, "socket.lock");
const SERVER_LOG = join(STATE, "server.log");

function acquireSocketLock(): boolean {
  if (existsSync(SOCKET_LOCK_FILE)) {
    const pid = parseInt(readFileSync(SOCKET_LOCK_FILE, "utf8").trim(), 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0); // throws if process is dead
        console.warn(`[socket] lock held by pid ${pid} — skipping socket startup`);
        return false;
      } catch {
        // stale lock, proceed
      }
    }
  }
  writeFileSync(SOCKET_LOCK_FILE, String(process.pid));
  return true;
}

function releaseSocketLock(): void {
  try {
    if (existsSync(SOCKET_LOCK_FILE)) {
      const pid = parseInt(readFileSync(SOCKET_LOCK_FILE, "utf8").trim(), 10);
      if (pid === process.pid) unlinkSync(SOCKET_LOCK_FILE);
    }
  } catch { /* ignore */ }
}

process.on("exit", releaseSocketLock);
process.on("SIGINT", () => { releaseSocketLock(); process.exit(0); });
process.on("SIGTERM", () => { releaseSocketLock(); process.exit(0); });

function slog(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
  appendFileSync(SERVER_LOG, line);
}

// ── Slack bot client for reactions ────────────────────────────────────────────

function getAuthorizedUserIds(): Set<string> {
  try {
    const settings = JSON.parse(readFileSync(join(STATE, "settings.json"), "utf8"));
    return new Set((settings.authorized_users ?? []).map((u: { slack_user_id: string }) => u.slack_user_id));
  } catch { return new Set(); }
}

let botClient: WebClient | null = null;
if (existsSync(BOT_TOKEN_FILE)) {
  botClient = new WebClient(readFileSync(BOT_TOKEN_FILE, "utf8").trim());
}

async function reactIfAuthorized(event: Record<string, unknown>): Promise<void> {
  if (!botClient) return;
  const userId = event.user as string | undefined;
  if (!userId || !getAuthorizedUserIds().has(userId)) return;
  const channel = event.channel as string | undefined;
  const ts = (event.event_ts ?? event.ts) as string | undefined;
  if (!channel || !ts) return;
  try {
    await botClient.reactions.add({ channel, name: "raccoon", timestamp: ts });
    slog(`[react] 🦝 channel=${channel} ts=${ts}`);
  } catch (err: unknown) {
    const code = (err as { data?: { error?: string } })?.data?.error;
    if (code !== "already_reacted") slog(`[react] failed: ${code}`);
  }
}

function writeSocketHeartbeat(status: string): void {
  writeFileSync(SOCKET_HEARTBEAT_FILE, JSON.stringify({ status, updated_at: new Date().toISOString() }) + "\n");
}

function handleSlackEvent(event: Record<string, unknown>): void {
  writeSocketHeartbeat("connected");
  const eventTs = (event.event_ts ?? event.ts) as string;
  if (!eventTs) {
    slog(`[socket] event missing event_ts, skipping: ${JSON.stringify(event).slice(0, 100)}`);
    return;
  }

  const type = event.type as string;

  if (type === "reaction_added" && event.reaction === "raccoon") return;

  // Ignore Franklin's own outbound messages — the MCP Slack tool appends this suffix
  const text = (event.text as string) ?? "";
  if (text.includes("*Sent using*")) return;

  const channel = (event.channel as string) ?? "";
  const channelType = (event.channel_type as string) ?? "channel";

  slog(`[socket] ${type} channel=${channel} channel_type=${channelType} user=${event.user ?? "?"} ts=${eventTs}`);

  db.insertSlackEvent({
    event_ts: eventTs,
    channel,
    channel_type: channelType,
    user_id: event.user as string | undefined,
    type,
    reaction: event.reaction as string | undefined,
    text: event.text as string | undefined,
    raw: event,
  });

  // React immediately — but not to Franklin's own outbound messages
  if (!text.includes("*Sent using*")) {
    reactIfAuthorized(event).catch(() => {});
  }
}

if (existsSync(SOCKET_TOKEN_FILE) && acquireSocketLock()) {
  const appToken = readFileSync(SOCKET_TOKEN_FILE, "utf8").trim();
  const socketClient = new SocketModeClient({ appToken, pingPongMaxTimeoutMs: 10_000 });

  socketClient.on("message", async ({ event, ack }) => {
    await ack();
    try {
      handleSlackEvent(event as Record<string, unknown>);
    } catch (err: unknown) {
      slog(`[socket] handleSlackEvent error (message): ${(err as Error).message}`);
    }
  });

  socketClient.on("app_mention", async ({ event, ack }) => {
    await ack();
    try {
      handleSlackEvent(event as Record<string, unknown>);
    } catch (err: unknown) {
      slog(`[socket] handleSlackEvent error (app_mention): ${(err as Error).message}`);
    }
  });

  socketClient.on("reaction_added", async ({ event, ack }) => {
    await ack();
    try {
      handleSlackEvent(event as Record<string, unknown>);
    } catch (err: unknown) {
      slog(`[socket] handleSlackEvent error (reaction_added): ${(err as Error).message}`);
    }
  });

  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  socketClient.on("connected", () => {
    slog("[socket] connected");
    writeSocketHeartbeat("connected");
    // Keep heartbeat fresh even when no messages arrive
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => writeSocketHeartbeat("connected"), 60_000);
  });

  socketClient.on("disconnected", (reason?: string) => {
    slog(`[socket] disconnected reason=${reason ?? "unknown"}`);
    writeSocketHeartbeat("disconnected");
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  });

  socketClient.on("error", (err: Error) => {
    slog(`[socket] error: ${err.message} stack=${err.stack?.split("\n")[1]?.trim()}`);
    writeSocketHeartbeat("error");
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  });

  socketClient.start().catch((err: Error) => {
    console.error("Slack socket failed to start:", err.message);
    writeSocketHeartbeat("error");
  });
} else {
  console.warn("Slack socket token not found — socket mode disabled.");
}
