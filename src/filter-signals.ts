#!/usr/bin/env npx tsx
/**
 * Filter signals before spawning the brain.
 *
 * For stateful sources (github, jira):
 *   - Extracts a canonical state object from each scout entry
 *   - Compares against the last-stored state in franklin.db
 *   - Only passes through entries where something changed
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
import type { GithubEntry } from "./scouts/github.js";
import type { JiraEntry } from "./scouts/jira.js";
import type { GmailEntry } from "./scouts/gmail.js";
import { CHANNEL_SIGNAL_HANDLERS } from "./channel-signals.js";
import type { ChannelEntry } from "./channel-signals.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT_DIR = join(ROOT, "state", "brain_input");

mkdirSync(OUT_DIR, { recursive: true });

// ── State extractors ───────────────────────────────────────────────────────────
// Each returns the canonical object stored in the DB and compared next cycle.

export function githubState(entry: GithubEntry): Record<string, unknown> {
  return {
    ci_failing: (entry.raw.ci_failing as string[]) ?? [],
    changes_requested: (entry.raw.changes_requested as string[]) ?? [],
    approved: (entry.raw.approved as boolean) ?? false,
    mergeable_state: (entry.raw.mergeable_state as string) ?? "unknown",
    review_comments: (entry.raw.review_comments as number) ?? 0,
  };
}

export function jiraState(entry: JiraEntry): Record<string, unknown> {
  return {
    status: entry.status,
    last_comment_updated: entry.last_comment?.updated ?? null,
  };
}

export function statesEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Signal shape written to brain_input/signals.json ─────────────────────────

interface Signal {
  id: string;
  source: "github" | "jira" | "gmail" | "slack_deploy" | "slack_alert";
  is_new: boolean;                        // true = never surfaced before
  previous_state: Record<string, unknown>;
  current_state: Record<string, unknown>;
  entry: GithubEntry | JiraEntry | GmailEntry | ChannelEntry;  // full entry for brain context
}

// ── Main ──────────────────────────────────────────────────────────────────────

const db = openDb();
const signals: Signal[] = [];

// ── GitHub ────────────────────────────────────────────────────────────────────

const githubResult = readJson<{ status: string; entries: GithubEntry[] }>(
  join(ROOT, "state", "scout_results", "github.json")
);

export function githubReviewState(entry: GithubEntry): Record<string, unknown> {
  return {
    reviewed_by_me: (entry.raw.reviewed_by_me as boolean) ?? false,
  };
}

if (githubResult?.status === "ok" || githubResult?.status === "error") {
  for (const entry of githubResult.entries ?? []) {
    if (entry.type === "pr_authored") {
      const current = githubState(entry);
      const row = db.getSurfaced(entry.id);
      const previous = row?.state ?? {};
      if (!statesEqual(current, previous)) {
        signals.push({ id: entry.id, source: "github", is_new: !row, previous_state: previous, current_state: current, entry });
      }
    } else if (entry.type === "review_request") {
      const current = githubReviewState(entry);
      const row = db.getSurfaced(entry.id);
      const previous = row?.state ?? {};
      if (!statesEqual(current, previous)) {
        signals.push({ id: entry.id, source: "github", is_new: !row, previous_state: previous, current_state: current, entry });
      }
    } else if (entry.type === "my_activity") {
      const activityType = (entry.raw as Record<string, unknown>).activity_type as string | undefined;
      if (activityType === "pr_merged") {
        // PR merge events surface once — once surfaced, never re-fire (like Gmail)
        const current = { merged: true };
        const row = db.getSurfaced(entry.id);
        if (!row?.last_surfaced_at) {
          signals.push({ id: entry.id, source: "github", is_new: true, previous_state: {}, current_state: current, entry });
        }
      }
    }
  }
}

// ── Jira ──────────────────────────────────────────────────────────────────────

const jiraResult = readJson<{ status: string; entries: JiraEntry[] }>(
  join(ROOT, "state", "scout_results", "jira.json")
);

if (jiraResult?.status === "ok" || jiraResult?.status === "error") {
  for (const entry of jiraResult.entries ?? []) {
    const current = jiraState(entry);
    const row = db.getSurfaced(entry.id);
    const previous = row?.state ?? {};
    if (!statesEqual(current, previous)) {
      signals.push({ id: entry.id, source: "jira", is_new: !row, previous_state: previous, current_state: current, entry });
    }
  }
}

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

// ── Slack channels (ops alerts — still polled via scout) ────────────────────

const channelResult = readJson<{ status: string; entries: ChannelEntry[] }>(
  join(ROOT, "state", "scout_results", "slack_channels.json")
);

if (channelResult?.status === "ok" || channelResult?.status === "error") {
  for (const entry of channelResult.entries ?? []) {
    const row = db.getSurfaced(entry.id);
    if (!row || !row.last_surfaced_at) {
      signals.push({
        id: entry.id,
        source: entry.source === "ops_alert" ? "slack_alert" : "slack_deploy",
        is_new: true,
        previous_state: {},
        current_state: { surfaced: true },
        entry,
      });
    }
  }
}

// ── Slack inbox (Socket Mode) ─────────────────────────────────────────────
// Partition pending events:
//   1. Handler matches → signal (brain processes as quest/task)
//   2. Known handler channel but no match → drop (noise that doesn't involve owner)
//   3. No handler for channel → slack_inbox.json (DM task generation)

const settings = readJson<{ owner_user_id?: string; user_profile?: { slack_user_id?: string } }>(
  join(ROOT, "state", "settings.json")
);
const ownerUserId = settings?.owner_user_id ?? settings?.user_profile?.slack_user_id ?? "";

const pendingEvents = db.getPendingSlackEvents();
const handlerChannels = new Set(CHANNEL_SIGNAL_HANDLERS.map((h) => h.channel));
const inboxEvents: typeof pendingEvents = [];
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
    inboxEvents.push(event);
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
