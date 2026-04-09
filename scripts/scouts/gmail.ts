#!/usr/bin/env npx tsx
/**
 * Gmail scout — fetches unread inbox emails via the gws CLI.
 * Writes results to state/scout_results/gmail.json.
 *
 * Each email is surfaced once. State tracking via franklin.db:
 *   id = "gmail:message:<message_id>"
 *   state = { surfaced: true } once seen
 *
 * Usage: npx tsx scripts/scouts/gmail.ts
 */

import { execSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb } from "../db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RESULT_FILE = join(ROOT, "state", "scout_results", "gmail.json");

// Senders / domains that are always automated noise — skip silently
const AUTOMATED_PATTERNS = [
  /notifications@github\.com/i,
  /noreply@github\.com/i,
  /jira@.*atlassian\.net/i,
  /slack\.com/i,
  /noreply@/i,
  /no-reply@/i,
  /donotreply@/i,
  /automated@/i,
  /robot@/i,
  /alerts@/i,
  /monitoring@/i,
  /support@/i,
  /newsletter@/i,
  /news@/i,
  /marketing@/i,
  /hello@/i,
  /team@/i,
];

function isAutomated(from: string): boolean {
  return AUTOMATED_PATTERNS.some((p) => p.test(from));
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GmailEntry {
  id: string;           // "gmail:message:<message_id>"
  message_id: string;
  thread_id: string;
  subject: string;
  from: string;
  from_email: string;
  date: string;
  snippet: string;
  labels: string[];
  is_automated: boolean;
}

interface GwsMessage {
  id: string;
  threadId?: string;
  from: string;
  subject: string;
  date: string;
  snippet?: string;
  labels?: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/) ?? from.match(/(\S+@\S+)/);
  return match?.[1] ?? from;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const collectedAt = new Date().toISOString();
  const errors: string[] = [];
  const entries: GmailEntry[] = [];

  let raw: string;
  try {
    raw = execSync("gws gmail +triage --format json --max 30", {
      cwd: ROOT,
      timeout: 30_000,
    }).toString();
  } catch (e: unknown) {
    const msg = (e as Error).message?.slice(0, 200) ?? "unknown error";
    console.error(`[gmail] gws command failed: ${msg}`);
    errors.push(msg);
    raw = "{}";
  }

  let messages: GwsMessage[] = [];
  try {
    const parsed = JSON.parse(raw);
    messages = Array.isArray(parsed) ? parsed : (parsed.messages ?? []);
  } catch (e: unknown) {
    errors.push(`JSON parse failed: ${(e as Error).message?.slice(0, 100)}`);
  }

  for (const msg of messages) {
    if (!msg.id) continue;
    const fromEmail = extractEmail(msg.from ?? "");
    entries.push({
      id: `gmail:message:${msg.id}`,
      message_id: msg.id,
      thread_id: msg.threadId ?? msg.id,
      subject: msg.subject ?? "(no subject)",
      from: msg.from ?? "",
      from_email: fromEmail,
      date: msg.date ?? collectedAt,
      snippet: msg.snippet ?? "",
      labels: msg.labels ?? [],
      is_automated: isAutomated(msg.from ?? ""),
    });
  }

  const result = {
    scout: "gmail",
    collected_at: collectedAt,
    status: errors.length === 0 ? "ok" : "error",
    error: errors.length > 0 ? errors.join("; ") : null,
    entries,
  };

  mkdirSync(join(ROOT, "state", "scout_results"), { recursive: true });
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

  // Upsert all seen entries into the DB; prune stale
  const db = openDb();
  for (const entry of entries) {
    db.upsertSeen(entry.id, "gmail");
  }
  const pruned = db.pruneStale("gmail", 14);
  db.close();

  console.log(`Gmail scout: ${entries.length} messages (${entries.filter((e) => !e.is_automated).length} non-automated), ${errors.length} errors, ${pruned} pruned → ${RESULT_FILE}`);
}

main();
