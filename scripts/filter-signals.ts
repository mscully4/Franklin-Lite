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

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb } from "./db.js";
import type { GithubEntry } from "./scouts/github.js";
import type { JiraEntry } from "./scouts/jira.js";
import type { GmailEntry } from "./scouts/gmail.js";

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
  source: "github" | "jira" | "gmail";
  is_new: boolean;                        // true = never surfaced before
  previous_state: Record<string, unknown>;
  current_state: Record<string, unknown>;
  entry: GithubEntry | JiraEntry | GmailEntry;  // full entry for brain context
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { return null; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const db = openDb();
const signals: Signal[] = [];

// ── GitHub ────────────────────────────────────────────────────────────────────

const githubResult = readJson<{ status: string; entries: GithubEntry[] }>(
  join(ROOT, "state", "scout_results", "github.json")
);

if (githubResult?.status === "ok" || githubResult?.status === "error") {
  for (const entry of githubResult.entries ?? []) {
    if (entry.type !== "pr_authored") continue; // only authored PRs need state tracking for now
    const current = githubState(entry);
    const row = db.getSurfaced(entry.id);
    const previous = row?.state ?? {};
    if (!statesEqual(current, previous)) {
      signals.push({ id: entry.id, source: "github", is_new: !row, previous_state: previous, current_state: current, entry });
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

writeFileSync(join(OUT_DIR, "signals.json"), JSON.stringify(signals, null, 2));

// ── Slack inbox ───────────────────────────────────────────────────────────────

const pendingEvents = db.getPendingSlackEvents();
if (pendingEvents.length > 0) {
  db.markSlackEventsProcessed(pendingEvents.map((e) => e.event_ts));
}
writeFileSync(join(OUT_DIR, "slack_inbox.json"), JSON.stringify(pendingEvents, null, 2));

db.close();

console.log(
  `filter-signals: ${signals.length} changed signals (github/jira), ` +
  `${pendingEvents.length} slack inbox events → ${OUT_DIR}`
);
