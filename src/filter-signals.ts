#!/usr/bin/env npx tsx
/**
 * Filter signals before spawning the brain.
 *
 * For slack (one-shot events):
 *   - Drains pending events from slack_inbox table
 *   - Marks them processed immediately (at-least-once: if the brain
 *     crashes before handling, they won't re-surface — acceptable)
 *
 * Writes:
 *   state/brain_input/signals.json     changed stateful signals
 *   state/brain_input/slack_inbox.json drained inbox events
 *
 * Usage: npx tsx scripts/filter-signals.ts
 */

import { writeFileSync, mkdirSync } from "fs";
import { readJson } from "./config.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb } from "./db.js";
import { createLogger } from "./logger.js";
const log = createLogger("filter");
import type { GmailEntry } from "./scouts/gmail.js";
import { CHANNEL_SIGNAL_HANDLERS } from "./channel-signals.js";
import type { ChannelEntry } from "./channel-signals.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "state", "brain_input");

mkdirSync(OUT_DIR, { recursive: true });

export function statesEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Signal shape written to brain_input/signals.json ─────────────────────────

interface Signal {
  id: string;
  source: "gmail" | "slack_deploy" | "slack_alert";
  is_new: boolean;                        // true = never surfaced before
  previous_state: Record<string, unknown>;
  current_state: Record<string, unknown>;
  entry: GmailEntry | ChannelEntry;  // full entry for brain context
}

// ── Main ──────────────────────────────────────────────────────────────────────

const db = openDb();
const signals: Signal[] = [];

// ── Gmail ─────────────────────────────────────────────────────────────────────

const gmailResult = readJson<{ status: string; entries: GmailEntry[] }>(
  join(ROOT, "state", "scout_results", "gmail.json")
);

if (gmailResult?.status === "ok" || gmailResult?.status === "error") {
  for (const entry of gmailResult.entries ?? []) {
    if (entry.is_automated) continue; // noise filter — automated emails never surface
    const row = db.getSurfaced(entry.id);
    if (!row || !row.last_surfaced_at) {
      // Never surfaced — pass through
      signals.push({
        id: entry.id,
        source: "gmail",
        is_new: true,
        previous_state: {},
        current_state: { surfaced: true },
        entry,
      });
    }
    // Already surfaced → skip (emails don't change state)
  }
}

// ── Slack inbox (Socket Mode) ─────────────────────────────────────────────
// Partition pending events:
//   1. Handler matches → signal (brain processes as quest/task)
//   2. Known handler channel but no match → drop (noise that doesn't involve owner)
//   3. No handler for channel → slack_inbox.json (DM task generation)

const settings = readJson<{ user_profile?: { discord_user_id?: string } }>(
  join(ROOT, "state", "settings.json")
);
const ownerUserId = settings?.user_profile?.discord_user_id ?? "";

type ThreadMessage = { author: string; text: string; ts: string };
type InboxEvent = ReturnType<typeof db.getPendingSlackEvents>[number] & { thread_context: ThreadMessage[] | null };

const pendingEvents = db.getPendingSlackEvents();
const handlerChannels = new Set(CHANNEL_SIGNAL_HANDLERS.map((h) => h.channel));
const inboxEvents: InboxEvent[] = [];
let channelSignalCount = 0;

for (const event of pendingEvents) {
  const handler = CHANNEL_SIGNAL_HANDLERS.find(
    (h) => h.channel === event.channel && h.matches(event, ownerUserId),
  );
  if (handler) {
    const entry = handler.toEntry(event);
    const row = db.getSurfaced(entry.id);
    if (!row || !row.last_surfaced_at) {
      signals.push({
        id: entry.id,
        source: handler.signalSource as Signal["source"],
        is_new: true,
        previous_state: {},
        current_state: { surfaced: true },
        entry,
      });
      channelSignalCount++;
    }
  } else if (!handlerChannels.has(event.channel)) {
    const threadContext = (event.raw as Record<string, unknown>)?.thread_context;
    inboxEvents.push({
      ...event,
      thread_context: Array.isArray(threadContext) ? (threadContext as ThreadMessage[]) : null,
    });
  }
  // else: known handler channel but criteria not met → drop silently
}

if (pendingEvents.length > 0) {
  db.markSlackEventsProcessed(pendingEvents.map((e) => e.event_ts));
}

writeFileSync(join(OUT_DIR, "signals.json"), JSON.stringify(signals, null, 2));
writeFileSync(join(OUT_DIR, "slack_inbox.json"), JSON.stringify(inboxEvents, null, 2));

db.close();

log.info(
  `${signals.length} changed signals (${channelSignalCount} from socket channels), ` +
  `${inboxEvents.length} slack inbox events → ${OUT_DIR}`
);
