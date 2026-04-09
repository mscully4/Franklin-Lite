#!/usr/bin/env npx tsx
/**
 * Jira scout — collects assigned issues, recent mentions, and in-progress
 * updates via jira-cli. Writes results to state/scout_results/jira.json
 * and upserts to franklin.db.
 *
 * Auth: reads JIRA_API_TOKEN from secrets/jira_api_token.txt
 * Binary: /opt/homebrew/bin/jira
 *
 * Sources:
 *   1. Assigned non-Done issues (always)
 *   2. Issues updated since last_sync where user was mentioned in comments
 *   3. Latest comment on In Progress / IN TESTING issues
 *
 * Usage: npx tsx scripts/scouts/jira.ts
 */

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb } from "../db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RESULT_FILE = join(ROOT, "state", "scout_results", "jira.json");
const TOKEN_FILE = join(ROOT, "secrets", "jira_api_token.txt");
const JIRA_BIN = "/opt/homebrew/bin/jira";
const JIRA_LOGIN = "michael.scully@circle.com";
const JIRA_USERNAME = "michael.scully"; // used in comment~ text search (@ causes JQL parse issues)

// Statuses that warrant fetching the latest comment for context
const ACTIVE_STATUSES = new Set(["In Progress", "IN TESTING", "In Review", "Code Review"]);

// ── Types ─────────────────────────────────────────────────────────────────────

interface JiraCursor {
  last_sync: string;
}

export interface JiraEntry {
  id: string;           // jira:ticket:DEV-1234
  type: "assigned" | "mentioned";
  key: string;
  summary: string;
  status: string;
  priority: string;
  updated: string;
  labels: string[];
  last_comment: { author: string; body: string; updated: string } | null;
  github_pr_url: string | null;
  raw: Record<string, unknown>;
}

interface JiraIssueRaw {
  key: string;
  fields: {
    summary: string;
    status: { name: string };
    priority: { name: string };
    updated: string;
    labels: string[];
    comment: {
      comments: Array<{
        id: string;
        author: { displayName: string; emailAddress: string };
        body: unknown;
        updated: string;
      }>;
    };
    customfield_10014?: string; // Epic link (often empty)
    [key: string]: unknown;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getToken(): string {
  if (!existsSync(TOKEN_FILE)) throw new Error(`Jira token not found: ${TOKEN_FILE}`);
  return readFileSync(TOKEN_FILE, "utf8").trim();
}

function jiraRaw(jql: string, token: string, errors: string[]): JiraIssueRaw[] {
  try {
    const result = execFileSync(
      JIRA_BIN,
      ["issue", "list", "-q", jql, "--raw"],
      { timeout: 30_000, env: { ...process.env, JIRA_API_TOKEN: token } },
    ).toString();
    if (!result.trim()) return [];
    return JSON.parse(result) as JiraIssueRaw[];
  } catch (e: unknown) {
    // jira-cli exits 1 with "✗ No result found" on stderr when no results
    const code = (e as { status?: number }).status;
    if (code === 1) return [];
    const msg = (e as Error).message?.slice(0, 150) ?? "unknown";
    errors.push(`jira list: ${msg}`);
    return [];
  }
}

function jiraViewRaw(key: string, token: string, errors: string[]): JiraIssueRaw | null {
  try {
    const result = execFileSync(
      JIRA_BIN,
      ["issue", "view", key, "--raw"],
      { timeout: 15_000, env: { ...process.env, JIRA_API_TOKEN: token } },
    ).toString();
    if (!result.trim()) return null;
    return JSON.parse(result) as JiraIssueRaw;
  } catch (e: unknown) {
    errors.push(`jira view ${key}: ${(e as Error).message?.slice(0, 100)}`);
    return null;
  }
}

function extractCommentText(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 300);
  // Atlassian Document Format — grab plain text from first paragraph
  if (typeof body === "object" && body !== null) {
    const doc = body as { content?: Array<{ content?: Array<{ text?: string }> }> };
    const texts: string[] = [];
    for (const block of doc.content ?? []) {
      for (const node of block.content ?? []) {
        if (node.text) texts.push(node.text);
      }
      if (texts.join("").length > 300) break;
    }
    return texts.join("").slice(0, 300);
  }
  return "";
}

function toEntry(issue: JiraIssueRaw, type: JiraEntry["type"]): JiraEntry {
  const f = issue.fields;
  const comments = f.comment?.comments ?? [];
  const lastRaw = comments.at(-1);
  const lastComment = lastRaw
    ? {
        author: lastRaw.author.displayName,
        body: extractCommentText(lastRaw.body),
        updated: lastRaw.updated,
      }
    : null;

  // GitHub PR link sometimes lives in remote links or the description; skip for now
  const githubPrUrl: string | null = null;

  return {
    id: `jira:ticket:${issue.key}`,
    type,
    key: issue.key,
    summary: f.summary,
    status: f.status?.name ?? "Unknown",
    priority: f.priority?.name ?? "Medium",
    updated: f.updated,
    labels: f.labels ?? [],
    last_comment: lastComment,
    github_pr_url: githubPrUrl,
    raw: {
      comment_count: comments.length,
      last_comment_author: lastRaw?.author?.emailAddress ?? null,
    },
  };
}

// ── Sub-pollers ────────────────────────────────────────────────────────────────

function pollAssigned(token: string, errors: string[]): JiraEntry[] {
  console.log("  [jira] Fetching assigned non-Done issues...");
  const issues = jiraRaw(
    "project IS NOT EMPTY AND assignee = currentUser() AND statusCategory != Done",
    token,
    errors,
  );
  console.log(`  [jira] ${issues.length} assigned issues`);
  return issues.map((i) => toEntry(i, "assigned"));
}

function pollMentioned(cursor: JiraCursor, token: string, errors: string[]): JiraEntry[] {
  // Use date 1 day before last_sync to catch any index lag
  const since = new Date(new Date(cursor.last_sync).getTime() - 86_400_000)
    .toISOString()
    .slice(0, 10); // YYYY-MM-DD
  const jql = `project IS NOT EMPTY AND comment ~ '${JIRA_USERNAME}' AND updated >= '${since}'`;
  console.log(`  [jira] Fetching mentions since ${since}...`);
  const issues = jiraRaw(jql, token, errors);
  console.log(`  [jira] ${issues.length} mentioned issues`);
  return issues.map((i) => toEntry(i, "mentioned"));
}

function enrichActiveIssues(entries: JiraEntry[], token: string, errors: string[]): void {
  // For In Progress / IN TESTING entries that came from the list command
  // (which returns minimal comment data), fetch full detail to get latest comment.
  const toFetch = entries.filter(
    (e) => ACTIVE_STATUSES.has(e.status) && e.last_comment === null,
  );
  if (toFetch.length === 0) return;
  console.log(`  [jira] Enriching ${toFetch.length} active issues for latest comment...`);

  for (const entry of toFetch) {
    const detail = jiraViewRaw(entry.key, token, errors);
    if (!detail) continue;
    const full = toEntry(detail, entry.type);
    entry.last_comment = full.last_comment;
    entry.raw = { ...entry.raw, comment_count: full.raw.comment_count };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function readCursor(): JiraCursor {
  try {
    const prev = JSON.parse(readFileSync(RESULT_FILE, "utf8"));
    return prev.cursor ?? defaultCursor();
  } catch {
    return defaultCursor();
  }
}

function defaultCursor(): JiraCursor {
  return { last_sync: new Date(Date.now() - 24 * 3600_000).toISOString() };
}

async function main() {
  const collectedAt = new Date().toISOString();
  const cursor = readCursor();
  const errors: string[] = [];

  const token = getToken();

  const allEntries: JiraEntry[] = [];
  const seen = new Set<string>();

  function add(entries: JiraEntry[]) {
    for (const e of entries) {
      if (!seen.has(e.id)) {
        seen.add(e.id);
        allEntries.push(e);
      }
    }
  }

  add(pollAssigned(token, errors));
  add(pollMentioned(cursor, token, errors));

  // Enrich: fetch latest comment for active issues missing comment data
  enrichActiveIssues(allEntries, token, errors);

  console.log(`  [jira] Total: ${allEntries.length} entries, ${errors.length} errors`);

  const result = {
    scout: "jira",
    collected_at: collectedAt,
    status: errors.length === 0 ? "ok" : "error",
    error: errors.length > 0 ? errors.join("; ") : null,
    cursor: { last_sync: collectedAt } satisfies JiraCursor,
    entries: allEntries,
  };

  mkdirSync(join(ROOT, "state", "scout_results"), { recursive: true });
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

  const db = openDb();
  for (const entry of allEntries) {
    db.upsertSeen(entry.id, "jira");
  }
  const pruned = db.pruneStale("jira");
  db.close();

  console.log(`Jira scout: ${allEntries.length} entries, ${errors.length} errors, ${pruned} pruned → ${RESULT_FILE}`);
}

main().catch((err) => {
  process.stderr.write(`Error: ${(err as Error).message}\n`);
  process.exit(1);
});
