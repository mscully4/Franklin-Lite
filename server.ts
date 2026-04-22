import express from "express";
import { readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { openDb } from "./src/db.js";
import { SCOUT_INTERVALS_MS, readJson } from "./src/config.js";
import { createLogger } from "./src/logger.js";
const log = createLogger("server");

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, "state");
const PORT = 7070;
const GITHUB_ORG = "crcl-main";

const app = express();
app.use(express.json());
const db = openDb();

const CLAIMED_PRS_FILE = join(STATE, "user_claimed_prs.json");

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

  // Socket status
  const socketData = readJson<{ status: string; updated_at: string }>(join(STATE, "slack_socket.json"));
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

  // Open PRs from GitHub scout
  interface GhScoutEntry { id: string; type: string; title: string; url: string; repo: string; number: number; updated_at: string; raw: Record<string, unknown> }
  const githubScout = readJson<{ entries?: GhScoutEntry[] }>(join(STATE, "scout_results", "github.json"));
  const openPrs = (githubScout?.entries ?? [])
    .filter((e) => e.type === "pr_authored")
    .map((e) => {
      const r = e.raw;
      const ciFailing = (r.ci_failing as string[]) ?? [];
      const mergeableState = (r.mergeable_state as string) ?? "unknown";
      const reviewComments = (r.review_comments as number) ?? 0;
      const approved = (r.approved as boolean) ?? false;
      const changesRequested = (r.changes_requested as string[]) ?? [];
      // Determine status label
      let status = "awaiting review";
      if (ciFailing.length > 0) status = "ci_failing";
      else if (mergeableState === "dirty") status = "conflict";
      else if (mergeableState === "behind") status = "behind";
      else if (changesRequested.length > 0) status = "changes_requested";
      else if (approved && mergeableState === "clean") status = "ready";
      else if (approved) status = "ok";
      else if (mergeableState === "clean" || mergeableState === "blocked" || mergeableState === "unknown") status = "awaiting review";
      return {
        repo: e.repo.replace(`${GITHUB_ORG}/`, ""),
        number: e.number,
        title: e.title,
        url: e.url,
        status,
        ciFailing,
        reviewComments,
        approved,
        mergeableState,
        updatedAgo: timeAgo(e.updated_at),
      };
    });

  // Review requests
  const reviewRequests = (githubScout?.entries ?? [])
    .filter((e) => e.type === "review_request")
    .map((e) => ({
      repo: e.repo.replace(`${GITHUB_ORG}/`, ""),
      number: e.number,
      title: e.title,
      url: e.url,
      author: (e.raw.state as string) ? e.author : e.author,
      reviewedByMe: (e.raw.reviewed_by_me as boolean) ?? false,
      updatedAgo: timeAgo(e.updated_at),
    }));

  // Inflight signals (PRs and other active work)
  const inflightSignals = readJson<string[]>(join(STATE, "brain_input", "inflight_signals.json")) ?? [];
  const inflightPrs = inflightSignals.filter((s) => s.startsWith("github:pr:"));

  // Jira tickets from scout — current sprint only
  interface JiraScoutEntry { id: string; key: string; summary: string; status: string; priority: string; updated: string; labels: string[]; sprint: { name: string; state: string } | null; last_comment: { author: string; body: string; updated: string } | null }
  const jiraScout = readJson<{ entries?: JiraScoutEntry[] }>(join(STATE, "scout_results", "jira.json"));
  const DEV_STATUSES = new Set(["Backlog", "In Progress", "In Review", "IN TESTING"]);
  const jiraTickets = (jiraScout?.entries ?? [])
    .filter((e) => DEV_STATUSES.has(e.status) && e.sprint?.state === "active")
    .map((e) => ({
      key: e.key,
      summary: e.summary,
      status: e.status,
      priority: e.priority,
      sprint: e.sprint?.name ?? null,
      updatedAgo: timeAgo(e.updated),
      lastComment: e.last_comment ? { author: e.last_comment.author, body: e.last_comment.body.slice(0, 100), ago: timeAgo(e.last_comment.updated) } : null,
    }))
    .sort((a, b) => {
      const order = ["In Progress", "In Review", "IN TESTING", "Backlog"];
      return order.indexOf(a.status) - order.indexOf(b.status);
    });

  // Deploys
  const deploys = db.getRecentDeploys(10).map((d) => ({
    ...d,
    createdAgo: timeAgo(d.created_at),
  }));

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
    openPrs,
    reviewRequests,
    inflightPrs,
    claimedPrs: readJson<string[]>(CLAIMED_PRS_FILE) ?? [],
    jiraTickets,
    deploys,
    channelPolicies: db.listChannelPolicies(),
    channelUserRules: db.listUserRules(),
    slackInboxPending: pending,
    serverTime: new Date().toISOString(),
  });
});

// ── Claimed PRs API ──────────────────────────────────────────────────────────

app.post("/api/claim-pr", (req, res) => {
  const { signalId } = req.body as { signalId?: string };
  if (!signalId) return res.status(400).json({ error: "signalId required" });
  const claimed = new Set(readJson<string[]>(CLAIMED_PRS_FILE) ?? []);
  claimed.add(signalId);
  writeFileSync(CLAIMED_PRS_FILE, JSON.stringify([...claimed], null, 2));
  res.json({ ok: true });
});

app.delete("/api/claim-pr", (req, res) => {
  const { signalId } = req.body as { signalId?: string };
  if (!signalId) return res.status(400).json({ error: "signalId required" });
  const claimed = new Set(readJson<string[]>(CLAIMED_PRS_FILE) ?? []);
  claimed.delete(signalId);
  writeFileSync(CLAIMED_PRS_FILE, JSON.stringify([...claimed], null, 2));
  res.json({ ok: true });
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
        log.warn(`Socket lock held by pid ${pid} — skipping socket startup`);
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

// slog replaced by tslog — keeping as alias for minimal diff on socket handlers
function slog(msg: string): void {
  log.info(msg);
}

// ── Slack bot client for reactions ────────────────────────────────────────────

let botClient: WebClient | null = null;
if (existsSync(BOT_TOKEN_FILE)) {
  botClient = new WebClient(readFileSync(BOT_TOKEN_FILE, "utf8").trim());
}

async function reactIfAllowed(event: Record<string, unknown>): Promise<void> {
  if (!botClient) return;
  const userId = event.user as string | undefined;
  if (!userId) return;

  const channel = event.channel as string | undefined;
  const channelType = (event.channel_type as string) ?? "channel";
  const ts = (event.event_ts ?? event.ts) as string | undefined;
  if (!channel || !ts) return;

  // Build authorization context from settings
  let ownerId: string | undefined;
  let authorizedIds = new Set<string>();
  try {
    const settings = JSON.parse(readFileSync(join(STATE, "settings.json"), "utf8"));
    ownerId = settings.owner_user_id ?? settings.user_profile?.slack_user_id;
    authorizedIds = new Set((settings.authorized_users ?? []).map((u: { slack_user_id: string }) => u.slack_user_id));
  } catch { /* fall through with empty sets */ }

  if (!ownerId) return;

  const result = db.isAllowed(channel, channelType, userId, ownerId, authorizedIds);
  if (!result.allowed) return;

  // Respect trigger mode: only react to @mentions unless policy is "all"
  if (result.triggerMode === "mention") {
    const eventType = event.type as string;
    const isDM = channelType === "im";
    const isAppMention = eventType === "app_mention";
    const isWhiskey = eventType === "reaction_added" && event.reaction === "whiskey";
    if (!isDM && !isAppMention && !isWhiskey) return;
  }

  try {
    await botClient.reactions.add({ channel, name: "raccoon", timestamp: ts });
    slog(`[react] raccoon channel=${channel} ts=${ts}`);
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

  // For reaction_added, Slack nests channel inside event.item
  const item = (type === "reaction_added" ? event.item : null) as Record<string, unknown> | null;
  const channel = (event.channel as string) ?? (item?.channel as string) ?? "";
  const channelType = (event.channel_type as string) ?? "channel";

  slog(`[socket] ${type} channel=${channel} channel_type=${channelType} user=${event.user ?? "?"} ts=${eventTs}`);

  const rawThreadTs = event.thread_ts as string | undefined;
  const threadTs = rawThreadTs && rawThreadTs !== eventTs ? rawThreadTs : undefined;

  db.insertSlackEvent({
    event_ts: eventTs,
    channel,
    channel_type: channelType,
    user_id: event.user as string | undefined,
    type,
    reaction: event.reaction as string | undefined,
    text: event.text as string | undefined,
    thread_ts: threadTs,
    raw: event,
  });

  // React immediately — but not to Franklin's own outbound messages
  if (!text.includes("*Sent using*")) {
    reactIfAllowed(event).catch(() => {});
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
    log.error("Slack socket failed to start:", err.message);
    writeSocketHeartbeat("error");
  });
} else {
  log.warn("Slack socket token not found — socket mode disabled.");
}
