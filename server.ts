import express from "express";
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Client, GatewayIntentBits, Partials } from "discord.js";
import { openDb } from "./src/db/index.js";
import { SCOUT_INTERVALS_MS, readJson, writeJson } from "./src/config.js";
import { createLogger } from "./src/logger.js";
const log = createLogger("server");

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE = join(__dirname, "state");
const BRAIN_INPUT = join(STATE, "brain_input");
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

  // Pre-compute quest cost map from dispatch_log
  const questCostMap = new Map<string, number>();
  for (const entry of db.getCostEntriesSince(null)) {
    if (!entry.quest_id) continue;
    questCostMap.set(entry.quest_id, (questCostMap.get(entry.quest_id) ?? 0) + (entry.cost_usd ?? 0));
  }

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
    const costUSD = questCostMap.get(quest.id as string) ?? 0;
    return {
      id: quest.id,
      objective: quest.objective,
      status: quest.status,
      createdAgo: timeAgo(quest.created_at as string),
      agentStatus: quest.agent_status,
      prUrl: quest.pr_url ?? null,
      category: quest.category ?? null,
      costUSD: costUSD > 0 ? costUSD : null,
      workerModel: (quest.worker_model as string) ?? null,
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
      const costUSD = questCostMap.get(quest.id as string) ?? 0;
      return {
        id: quest.id,
        objective: (quest.objective as string) ?? "",
        outcome: (quest.outcome as string) ?? "",
        updatedAgo: timeAgo(updatedAt),
        prUrl: (quest.pr_url as string) ?? null,
        status: quest.status,
        category: quest.category ?? null,
        costUSD: costUSD > 0 ? costUSD : null,
        workerModel: (quest.worker_model as string) ?? null,
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

  const recentDmReplies = db.getRecentDmReplies(15).map((r) => ({
    ...r,
    completedAgo: timeAgo(r.completed_at as string),
  }));

  const recentScheduledRuns = db.getRecentScheduledRuns(20).map((r) => ({
    ...r,
    completedAgo: timeAgo(r.completed_at as string),
  }));

  // Scheduled tasks
  const scheduledTasks = (readJson<Array<{ id: string; every: string; kind?: string; display_description?: string; context: { objective?: string; skill?: string }; last_run?: string; fail_count?: number }>>(join(STATE, "scheduled_tasks.json")) ?? [])
    .map((t) => ({ id: t.id, every: t.every, kind: t.kind ?? "worker", description: t.display_description ?? t.context?.skill ?? t.id, lastRun: t.last_run ?? null, lastRunAgo: timeAgo(t.last_run ?? null), failCount: t.fail_count ?? 0 }));

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
    recentDmReplies,
    recentScheduledRuns,
    activeQuests,
    completedQuests,
    meetings,
    scheduledTasks,
    channelPolicies: db.listChannelPolicies(),
    channelUserRules: db.listUserRules(),
    serverTime: new Date().toISOString(),
  });
});

// ── Metrics API ──────────────────────────────────────────────────────────────

function addUsageToTotals(totals: Record<string, ModelUsageEntry>, raw: string): boolean {
  let any = false;
  for (const line of raw.split("\n")) {
    try {
      const d = JSON.parse(line) as { modelUsage?: Record<string, Omit<ModelUsageEntry, "tasks">> };
      if (!d.modelUsage) continue;
      any = true;
      for (const [model, usage] of Object.entries(d.modelUsage)) {
        const t = totals[model] ?? (totals[model] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, tasks: 0 });
        t.inputTokens += usage.inputTokens ?? 0;
        t.outputTokens += usage.outputTokens ?? 0;
        t.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
        t.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
        t.costUSD += usage.costUSD ?? 0;
        t.tasks += 1;
      }
    } catch { /* skip unparseable lines */ }
  }
  return any;
}

function aggregateTokenUsage(since: string | null): Record<string, ModelUsageEntry> {
  const LOGS_DIR = join(STATE, "logs", "workers");
  const taskIds = new Set(db.getTaskIdsSince(since));
  const totals: Record<string, ModelUsageEntry> = {};
  let files: string[];
  try { files = readdirSync(LOGS_DIR).filter(f => f.endsWith(".json")); } catch { return totals; }
  for (const file of files) {
    const taskId = file.replace(".json", "");
    if (since && !taskIds.has(taskId)) continue;
    const raw = (() => { try { return readFileSync(join(LOGS_DIR, file), "utf8"); } catch { return null; } })();
    if (!raw) continue;
    addUsageToTotals(totals, raw);
  }
  const BRAIN_DIR = join(STATE, "logs", "brain");
  const sinceMs = since ? new Date(since).getTime() : 0;
  let brainFiles: string[];
  try { brainFiles = readdirSync(BRAIN_DIR).filter(f => /^brain-\d+\.json$/.test(f)); } catch { brainFiles = []; }
  for (const file of brainFiles) {
    const m = file.match(/^brain-(\d+)\.json$/);
    if (!m) continue;
    if (since && Number(m[1]) < sinceMs) continue;
    const raw = (() => { try { return readFileSync(join(BRAIN_DIR, file), "utf8"); } catch { return null; } })();
    if (!raw) continue;
    addUsageToTotals(totals, raw);
  }
  return totals;
}

function aggregateBrainUsage(since: string | null): { invocations: number; costUSD: number } {
  const BRAIN_DIR = join(STATE, "logs", "brain");
  const sinceMs = since ? new Date(since).getTime() : 0;
  const tokenUsage: Record<string, ModelUsageEntry> = {};
  let invocations = 0;
  let files: string[];
  try { files = readdirSync(BRAIN_DIR).filter(f => /^brain-\d+\.json$/.test(f)); } catch { return { invocations: 0, costUSD: 0 }; }
  for (const file of files) {
    const m = file.match(/^brain-(\d+)\.json$/);
    if (!m) continue;
    if (since && Number(m[1]) < sinceMs) continue;
    const raw = (() => { try { return readFileSync(join(BRAIN_DIR, file), "utf8"); } catch { return null; } })();
    if (!raw) continue;
    if (addUsageToTotals(tokenUsage, raw)) invocations += 1;
  }
  const costUSD = Object.values(tokenUsage).reduce((s, m) => s + m.costUSD, 0);
  return { invocations, costUSD };
}

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
    const tokenUsage = aggregateTokenUsage(since);
    const brain = aggregateBrainUsage(since);
    const totalCostUSD = Object.values(tokenUsage).reduce((s, m) => s + m.costUSD, 0);
    result[name] = {
      ...metrics,
      messagesSent: actions["message_sent"] ?? 0,
      prsCreated: actions["pr_created"] ?? 0,
      commitsPushed: actions["commit_pushed"] ?? 0,
      actions,
      tokenUsage,
      brain,
      totalCostUSD,
    };
  }

  res.json({ periods: result, serverTime: now.toISOString() });
});

// ── Costs API ─────────────────────────────────────────────────────────────────

type CostSource = "worker" | "brain";

type DailyBucket = {
  date: string;
  total: number;
  byModel: Record<string, number>;
  byModelSource: Record<CostSource, Record<string, number>>;
  bySource: Record<CostSource, number>;
};

type ModelUsageEntry = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  tasks: number;
};

function emptySource(): Record<CostSource, Record<string, number>> {
  return { worker: {}, brain: {} };
}

function dateInTz(iso: string | number, tz: string): string {
  const d = typeof iso === "number" ? new Date(iso) : new Date(iso);
  return d.toLocaleDateString("en-CA", { timeZone: tz });
}

app.get("/api/costs", (req, res) => {
  const days = Math.max(1, Math.min(180, parseInt(String(req.query.days ?? "30"), 10) || 30));
  const tzSettings = readJson<{ timezone?: string }>(join(STATE, "settings.json"));
  const tz = tzSettings?.timezone ?? "America/Chicago";

  const now = new Date();
  const todayStr = dateInTz(now.getTime(), tz);
  const startDay = new Date(todayStr + "T00:00:00");
  startDay.setDate(startDay.getDate() - (days - 1));
  const sinceIso = startDay.toISOString();

  const dayList: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startDay);
    d.setDate(d.getDate() + i);
    dayList.push(d.toLocaleDateString("en-CA", { timeZone: tz }));
  }
  const dailyMap: Record<string, DailyBucket> = {};
  for (const date of dayList) {
    dailyMap[date] = { date, total: 0, byModel: {}, byModelSource: emptySource(), bySource: { worker: 0, brain: 0 } };
  }

  const bySourceModel: Record<CostSource, Record<string, ModelUsageEntry>> = { worker: {}, brain: {} };
  const sourceTotals: Record<CostSource, { costUSD: number; tasks: number }> = {
    worker: { costUSD: 0, tasks: 0 },
    brain: { costUSD: 0, tasks: 0 },
  };

  function addUsage(source: CostSource, bucket: DailyBucket, model: string, usage: Omit<ModelUsageEntry, "tasks">, incTask: boolean): number {
    const cost = usage.costUSD ?? 0;
    bucket.byModel[model] = (bucket.byModel[model] ?? 0) + cost;
    bucket.byModelSource[source][model] = (bucket.byModelSource[source][model] ?? 0) + cost;
    bucket.bySource[source] += cost;
    bucket.total += cost;

    const slot = bySourceModel[source];
    const t = slot[model] ?? (slot[model] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, tasks: 0 });
    t.inputTokens += usage.inputTokens ?? 0;
    t.outputTokens += usage.outputTokens ?? 0;
    t.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    t.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    t.costUSD += cost;
    if (incTask) t.tasks += 1;
    sourceTotals[source].costUSD += cost;
    return cost;
  }

  const LOGS_DIR = join(STATE, "logs", "workers");
  const entries = db.getCostEntriesSince(sinceIso);

  for (const entry of entries) {
    const date = dateInTz(entry.completed_at, tz);
    const bucket = dailyMap[date];
    if (!bucket) continue;

    const raw = (() => { try { return readFileSync(join(LOGS_DIR, `${entry.task_id}.json`), "utf8"); } catch { return null; } })();
    let attributed = 0;
    let firstModel = true;
    if (raw) {
      for (const line of raw.split("\n")) {
        try {
          const d = JSON.parse(line) as { modelUsage?: Record<string, Omit<ModelUsageEntry, "tasks">> };
          if (!d.modelUsage) continue;
          for (const [model, usage] of Object.entries(d.modelUsage)) {
            attributed += addUsage("worker", bucket, model, usage, firstModel);
          }
          firstModel = false;
        } catch { /* skip */ }
      }
    }
    const remainder = entry.cost_usd - attributed;
    if (remainder > 0.01) {
      addUsage("worker", bucket, "unknown", { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: remainder }, attributed === 0);
    }
    sourceTotals.worker.tasks += 1;
  }

  const BRAIN_DIR = join(STATE, "logs", "brain");
  const sinceMs = startDay.getTime();
  let brainFiles: string[];
  try { brainFiles = readdirSync(BRAIN_DIR).filter(f => /^brain-\d+\.json$/.test(f)); } catch { brainFiles = []; }
  let brainInvocations = 0;
  for (const file of brainFiles) {
    const m = file.match(/^brain-(\d+)\.json$/);
    if (!m) continue;
    const ms = Number(m[1]);
    if (ms < sinceMs) continue;
    const raw = (() => { try { return readFileSync(join(BRAIN_DIR, file), "utf8"); } catch { return null; } })();
    if (!raw) continue;
    const date = dateInTz(ms, tz);
    const bucket = dailyMap[date];
    if (!bucket) continue;
    let any = false;
    let firstModel = true;
    for (const line of raw.split("\n")) {
      try {
        const d = JSON.parse(line) as { modelUsage?: Record<string, Omit<ModelUsageEntry, "tasks">> };
        if (!d.modelUsage) continue;
        any = true;
        for (const [model, usage] of Object.entries(d.modelUsage)) {
          addUsage("brain", bucket, model, usage, firstModel);
        }
        firstModel = false;
      } catch { /* skip */ }
    }
    if (any) {
      brainInvocations += 1;
      sourceTotals.brain.tasks += 1;
    }
  }

  const daily = dayList.map(d => dailyMap[d]);
  const total = daily.reduce((s, b) => s + b.total, 0);

  const models: Array<{ source: CostSource; name: string; share: number } & ModelUsageEntry> = [];
  for (const source of ["worker", "brain"] as CostSource[]) {
    for (const [name, u] of Object.entries(bySourceModel[source])) {
      models.push({ source, name, ...u, share: total > 0 ? u.costUSD / total : 0 });
    }
  }
  models.sort((a, b) => b.costUSD - a.costUSD);

  const byCategory = db.getCostByCategory(sinceIso);

  res.json({
    days,
    timezone: tz,
    since: sinceIso,
    serverTime: now.toISOString(),
    total,
    avgPerDay: total / days,
    daily,
    models,
    bySource: {
      worker: { costUSD: sourceTotals.worker.costUSD, tasks: sourceTotals.worker.tasks, share: total > 0 ? sourceTotals.worker.costUSD / total : 0 },
      brain:  { costUSD: sourceTotals.brain.costUSD,  invocations: brainInvocations,           share: total > 0 ? sourceTotals.brain.costUSD  / total : 0 },
    },
    byCategory,
  });
});

app.get("/", (_req, res) => res.sendFile(join(__dirname, "index.html")));
app.get("/costs", (_req, res) => res.sendFile(join(__dirname, "costs.html")));
app.get("/avatar.png", (_req, res) => res.sendFile(join(__dirname, "Franklin-Avatar.png")));


app.post("/api/scheduled/:id/reset", (req, res) => {
  const id = req.params.id;
  const file = join(STATE, "scheduled_tasks.json");
  const tasks = readJson<Array<Record<string, unknown>>>(file) ?? [];
  const job = tasks.find((t) => t.id === id);
  if (!job) { res.status(404).json({ error: "task not found" }); return; }
  job.fail_count = 0;
  job.last_fail = null;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(tasks, null, 2));
  renameSync(tmp, file);
  res.json({ ok: true });
});

app.listen(PORT, "0.0.0.0", () => {
  log.info(`Franklin dashboard → http://localhost:${PORT}`);
});

// ── Discord Bot ───────────────────────────────────────────────────────────────

const DISCORD_HEARTBEAT_FILE = join(STATE, "discord_bot.json");

function writeDiscordHeartbeat(status: string): void {
  writeFileSync(
    DISCORD_HEARTBEAT_FILE,
    JSON.stringify({ status, updated_at: new Date().toISOString() }) + "\n",
  );
}

function getDiscordToken(): string {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error("DISCORD_BOT_TOKEN not set — check .env file");
  return token;
}

(async () => {
  const discordToken = getDiscordToken();

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
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    if (!authorizedDiscordIds.has(msg.author.id)) return;

    writeDiscordHeartbeat("connected");
    log.info(`[discord] message from=${msg.author.id} channel=${msg.channelId} text=${msg.content.slice(0, 80)}`);

    let threadId: string;
    let threadContext: Array<{ author: string; text: string; ts: string }> = [];

    if (msg.channel.isThread()) {
      threadId = msg.channelId;
      try {
        const messages = await msg.channel.messages.fetch({ limit: 50 });
        threadContext = [...messages.values()]
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
          .filter((m) => m.content)
          .map((m) => ({ author: m.author.username, text: m.content, ts: m.id }));
      } catch (err) {
        log.warn(`[discord] failed to fetch thread history: ${(err as Error).message}`);
        threadContext = [{ author: msg.author.username, text: msg.content, ts: msg.id }];
      }
    } else {
      // If this is a reply, fetch the referenced message for context
      if (msg.reference?.messageId) {
        try {
          const refMsg = await msg.channel.messages.fetch(msg.reference.messageId);
          if (refMsg?.content) {
            threadContext.push({ author: refMsg.author.username, text: refMsg.content, ts: refMsg.id });
          }
        } catch (err) {
          log.warn(`[discord] failed to fetch referenced message ${msg.reference.messageId}: ${(err as Error).message}`);
        }
      }
      try {
        const thread = await msg.startThread({
          name: msg.content.slice(0, 100) || "Conversation",
        });
        threadId = thread.id;
      } catch (err) {
        log.error(`[discord] failed to create thread: ${(err as Error).message}`);
        threadId = msg.channelId;
      }
      threadContext.push({ author: msg.author.username, text: msg.content, ts: msg.id });
    }

    const inboxFile = join(BRAIN_INPUT, "discord_inbox.json");
    mkdirSync(BRAIN_INPUT, { recursive: true });
    const inbox = readJson<Array<Record<string, unknown>>>(inboxFile) ?? [];
    if (!inbox.some((e) => e.event_ts === msg.id)) {
      inbox.push({
        event_ts: msg.id,
        channel: threadId,
        channel_type: "im",
        user_id: msg.author.id,
        type: "message",
        text: msg.content,
        thread_ts: threadId,
        thread_context: threadContext,
        received_at: new Date().toISOString(),
      });
      writeJson(inboxFile, inbox);
    }

    try {
      await msg.react('🦝');
    } catch (err) {
      log.warn(`[discord] failed to react to message: ${(err as Error).message}`);
    }
  });

  client.on("messageReactionAdd", async (reaction, user) => {
    if (user.bot) return;

    // Fetch partials if needed
    const fullReaction = reaction.partial ? await reaction.fetch().catch(() => null) : reaction;
    if (!fullReaction) return;
    const msg = fullReaction.message.partial
      ? await fullReaction.message.fetch().catch(() => null)
      : fullReaction.message;
    if (!msg) return;

    // Only handle reactions on embeds with Franklin metadata in the footer
    const footer = msg.embeds[0]?.footer?.text;
    if (!footer) return;

    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(footer);
    } catch {
      return;
    }
    if (!meta.sub_type) return;

    const emoji = fullReaction.emoji.name ?? "";
    const userId = typeof user.id === "string" ? user.id : "";

    const rxnFile = join(BRAIN_INPUT, "discord_reactions.json");
    mkdirSync(BRAIN_INPUT, { recursive: true });
    const rxns = readJson<Array<Record<string, unknown>>>(rxnFile) ?? [];
    if (!rxns.some((r) => r.message_id === msg.id && r.user_id === userId && r.emoji === emoji)) {
      rxns.push({
        message_id: msg.id,
        channel_id: msg.channelId,
        user_id: userId,
        emoji,
        reacted_at: new Date().toISOString(),
        sub_type: meta.sub_type,
        meta,
      });
      writeJson(rxnFile, rxns);
    }

    log.info(`[discord] reaction ${emoji} on message ${msg.id} from ${userId} (sub_type=${meta.sub_type})`);
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
