#!/usr/bin/env npx tsx
/**
 * GitHub scout — collects PRs, review requests, notifications, and outgoing
 * activity via the gh CLI. Writes results to state/scout_results/github.json.
 *
 * Usage: npx tsx scripts/scouts/github.ts
 *
 * Output shape:
 *   {
 *     scout: "github",
 *     collected_at: ISO 8601,
 *     status: "ok" | "error",
 *     error: string | null,
 *     cursor: GithubCursor,
 *     entries: GithubEntry[]
 *   }
 *
 * Reads cursor from state/scout_results/github.json (previous run).
 * Deduplicates entries on `id` across sub-pollers.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb } from "../db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RESULT_FILE = join(ROOT, "state", "scout_results", "github.json");
const OVERLAP_MS = 5 * 60 * 1000; // 5-min overlap to avoid boundary gaps

const GITHUB_USER = "michael-scully_crcl";
const GITHUB_ORG = "crcl-main";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GithubCursor {
  last_sync: string;
  last_event_id: string | null;
  reviewed_prs: Record<string, { head_sha: string; my_review_sha: string }>;
}

export interface GithubEntry {
  id: string;
  type:
    | "pr_authored"
    | "review_request"
    | "assigned_pr"
    | "assigned_issue"
    | "team_pr"
    | "notification"
    | "my_activity";
  title: string;
  body: string;
  url: string;
  repo: string;
  number: number;
  author: string;
  created_at: string;
  updated_at: string;
  labels: string[];
  raw: Record<string, unknown>;
}

interface GhPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  body: string;
  author: { login: string };
  createdAt: string;
  updatedAt: string;
  labels: Array<{ name: string }>;
  reviews: Array<{ state: string; author: { login: string } }>;
  statusCheckRollup: Array<{ name: string; conclusion: string }>;
}

interface GhSearchItem {
  number: number;
  title: string;
  body: string;
  html_url: string;
  state: string;
  user: { login: string };
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  pull_request?: { html_url: string };
  repository_url: string;
}

interface GhSearchResult {
  items: GhSearchItem[];
}

interface GhReview {
  user: { login: string };
  state: string;
  commit_id: string;
}

interface GhPrDetail {
  head: { sha: string };
  mergeable: boolean | null;
  mergeable_state: string;   // "clean" | "behind" | "dirty" | "blocked" | "unknown"
  rebaseable: boolean;
  review_comments: number;
}

interface GhNotification {
  id: string;
  reason: string;
  subject: { title: string; url: string | null; type: string };
  repository: { full_name: string };
  updated_at: string;
}

interface GhEvent {
  id: string;
  type: string;
  actor: { login: string };
  repo: { name: string };
  payload: Record<string, unknown>;
  created_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ghApi<T>(endpoint: string): T {
  const raw = execSync(`gh api "${endpoint}" --paginate`, { timeout: 30_000 }).toString();
  return JSON.parse(raw) as T;
}

function ghApiOnePage<T>(endpoint: string): T {
  const raw = execSync(`gh api "${endpoint}"`, { timeout: 30_000 }).toString();
  return JSON.parse(raw) as T;
}

function ghApiSafe<T>(endpoint: string, fallback: T, errors: string[]): T {
  try {
    return ghApi<T>(endpoint);
  } catch (e: unknown) {
    const msg = `${endpoint.split("?")[0]}: ${(e as Error).message?.slice(0, 150)}`;
    console.error(`  [github] API error: ${msg}`);
    errors.push(msg);
    return fallback;
  }
}

function repoFromUrl(repoUrl: string): string {
  return repoUrl.replace("https://api.github.com/repos/", "");
}

interface PrState {
  reviewedByMe: boolean;
  reviewState: string | null;
  headSha: string;
  myReviewSha: string | null;
  mergeableState: string;    // "clean" | "behind" | "dirty" | "blocked" | "unknown"
  mergeable: boolean | null;
  reviewComments: number;
}

function getReviewState(
  repo: string,
  number: number,
  cursor: GithubCursor,
  errors: string[],
): PrState {
  const prKey = `${repo}#${number}`;
  const cached = cursor.reviewed_prs[prKey];

  const detail = ghApiSafe<GhPrDetail>(`/repos/${repo}/pulls/${number}`,
    { head: { sha: "" }, mergeable: null, mergeable_state: "unknown", rebaseable: false, review_comments: 0 }, errors);
  const headSha = detail.head.sha;
  const mergeableState = detail.mergeable_state ?? "unknown";
  const mergeable = detail.mergeable ?? null;
  const reviewComments = detail.review_comments ?? 0;

  const reviews = ghApiSafe<GhReview[]>(`/repos/${repo}/pulls/${number}/reviews`, [], errors);
  const myReview = reviews.filter((r) => r.user.login === GITHUB_USER).at(-1);

  const base = { mergeableState, mergeable, reviewComments };
  if (myReview) {
    return { ...base, reviewedByMe: true, reviewState: myReview.state, headSha, myReviewSha: myReview.commit_id };
  }
  if (cached) {
    return { ...base, reviewedByMe: true, reviewState: null, headSha, myReviewSha: cached.my_review_sha };
  }
  return { ...base, reviewedByMe: false, reviewState: null, headSha, myReviewSha: null };
}

function searchItemToEntry(
  item: GhSearchItem,
  type: GithubEntry["type"],
  extra: Record<string, unknown> = {},
): GithubEntry {
  const repo = repoFromUrl(item.repository_url);
  const isPr = !!item.pull_request;
  return {
    id: `github:${isPr ? "pr" : "issue"}:${repo}/${item.number}`,
    type,
    title: item.title,
    body: (item.body ?? "").slice(0, 500),
    url: item.pull_request?.html_url ?? item.html_url,
    repo,
    number: item.number,
    author: item.user.login,
    created_at: item.created_at,
    updated_at: item.updated_at,
    labels: item.labels.map((l) => l.name),
    raw: { state: item.state, ...extra },
  };
}

// ── Sub-pollers ───────────────────────────────────────────────────────────────

function pollAuthoredPrs(cursor: GithubCursor, errors: string[]): GithubEntry[] {
  console.log("  [github] Fetching authored PRs...");
  const result = ghApiSafe<GhSearchResult>(
    `/search/issues?q=author:${GITHUB_USER}+is:pr+is:open+org:${GITHUB_ORG}&per_page=50`,
    { items: [] },
    errors,
  );
  console.log(`  [github] ${result.items.length} authored PRs, fetching CI + review state...`);

  return result.items.map((item, i) => {
    const repo = repoFromUrl(item.repository_url);
    console.log(`  [github]   authored PR ${i + 1}/${result.items.length}: ${repo}#${item.number}`);

    const review = getReviewState(repo, item.number, cursor, errors);

    interface CheckRun { name: string; conclusion: string | null }
    interface CheckRunsResult { check_runs: CheckRun[] }
    const checks = review.headSha
      ? ghApiSafe<CheckRunsResult>(`/repos/${repo}/commits/${review.headSha}/check-runs?per_page=100`, { check_runs: [] }, errors)
      : { check_runs: [] };

    // Deduplicate by name — GitHub can return multiple runs for the same check
    // (e.g. re-runs, stale entries). API returns newest first, so first occurrence wins.
    const latestByName = new Map<string, string | null>();
    for (const c of checks.check_runs) {
      if (!latestByName.has(c.name)) latestByName.set(c.name, c.conclusion);
    }
    const ciFailing = [...latestByName.entries()]
      .filter(([, conclusion]) => conclusion === "failure" || conclusion === "timed_out")
      .map(([name]) => name);

    const jiraKey = item.title.match(/([A-Z]+-\d+)/)?.[1] ?? null;
    return searchItemToEntry(item, "pr_authored", {
      jira_key: jiraKey,
      ci_failing: ciFailing,
      changes_requested: review.reviewState === "CHANGES_REQUESTED" ? [GITHUB_USER] : [],
      approved: review.reviewState === "APPROVED",
      head_sha: review.headSha,
      mergeable_state: review.mergeableState,
      mergeable: review.mergeable,
      review_comments: review.reviewComments,
    });
  });
}

function pollReviewRequests(cursor: GithubCursor, errors: string[]): GithubEntry[] {
  console.log("  [github] Fetching review requests...");
  const result = ghApiSafe<GhSearchResult>(
    `/search/issues?q=review-requested:${GITHUB_USER}+is:pr+is:open+org:${GITHUB_ORG}&per_page=50`,
    { items: [] },
    errors,
  );
  console.log(`  [github] ${result.items.length} review requests`);

  return result.items.map((item, i) => {
    const repo = repoFromUrl(item.repository_url);
    console.log(`  [github]   review state ${i + 1}/${result.items.length}: ${repo}#${item.number}`);
    const review = getReviewState(repo, item.number, cursor, errors);
    return searchItemToEntry(item, "review_request", {
      review_requested: true,
      reviewed_by_me: review.reviewedByMe,
      review_state: review.reviewState,
      head_sha: review.headSha,
      my_review_sha: review.myReviewSha,
    });
  });
}

function pollAssigned(errors: string[]): GithubEntry[] {
  console.log("  [github] Fetching assigned issues/PRs...");
  const result = ghApiSafe<GhSearchResult>(
    `/search/issues?q=assignee:${GITHUB_USER}+is:open+org:${GITHUB_ORG}&per_page=50`,
    { items: [] },
    errors,
  );
  console.log(`  [github] ${result.items.length} assigned items`);
  return result.items.map((item) =>
    searchItemToEntry(item, !!item.pull_request ? "assigned_pr" : "assigned_issue", { assigned: true }),
  );
}

function pollNotifications(cursor: GithubCursor, errors: string[]): GithubEntry[] {
  const since = new Date(new Date(cursor.last_sync).getTime() - OVERLAP_MS).toISOString();
  console.log(`  [github] Fetching notifications since ${since.slice(0, 10)}...`);
  const notifications = ghApiSafe<GhNotification[]>(
    `/notifications?participating=true&per_page=50&since=${since}`,
    [],
    errors,
  );
  console.log(`  [github] ${notifications.length} notifications`);

  const entries: GithubEntry[] = [];
  for (const n of notifications) {
    if (!n.subject.url) continue;
    const match = n.subject.url.match(/\/(pulls|issues)\/(\d+)$/);
    if (!match) continue;
    const repo = n.repository.full_name;
    const number = parseInt(match[2], 10);
    const isPr = match[1] === "pulls";
    entries.push({
      id: `github:${isPr ? "pr" : "issue"}:${repo}/${number}`,
      type: "notification",
      title: n.subject.title,
      body: "",
      url: `https://github.com/${repo}/${isPr ? "pull" : "issues"}/${number}`,
      repo,
      number,
      author: "",
      created_at: n.updated_at,
      updated_at: n.updated_at,
      labels: [],
      raw: {
        notification_reason: n.reason,
        assigned: n.reason === "assign",
        mention: n.reason === "mention",
        review_requested: n.reason === "review_requested",
      },
    });
  }
  return entries;
}

function pollMyActivity(
  cursor: GithubCursor,
  errors: string[],
): { entries: GithubEntry[]; lastEventId: string | null } {
  console.log("  [github] Fetching outgoing activity...");
  let events: GhEvent[];
  try {
    events = ghApiOnePage<GhEvent[]>(`/users/${GITHUB_USER}/events?per_page=100`);
  } catch (e: unknown) {
    errors.push(`activity: ${(e as Error).message?.slice(0, 150)}`);
    return { entries: [], lastEventId: cursor.last_event_id ?? null };
  }

  const cutoff = new Date(cursor.last_sync).getTime() - OVERLAP_MS;
  const stopId = cursor.last_event_id ?? null;
  const entries: GithubEntry[] = [];
  let newLastEventId: string | null = null;

  for (const event of events) {
    if (!newLastEventId) newLastEventId = event.id;
    if (event.id === stopId) break;
    if (new Date(event.created_at).getTime() < cutoff) break;

    const repo = event.repo?.name ?? "";
    const base = {
      id: `github:activity:${event.id}`,
      type: "my_activity" as const,
      author: event.actor?.login ?? "",
      created_at: event.created_at,
      updated_at: event.created_at,
      labels: [] as string[],
      repo,
      number: 0,
    };

    const p = event.payload;
    if (event.type === "PullRequestReviewEvent" && p.action === "submitted" && p.review && p.pull_request) {
      const pr = p.pull_request as { number: number; title: string; html_url: string };
      const review = p.review as { state: string; html_url: string; body: string };
      entries.push({ ...base, number: pr.number, title: pr.title, body: (review.body ?? "").slice(0, 500), url: review.html_url, raw: { activity_type: "review", review_state: review.state } });
    } else if (event.type === "PullRequestEvent" && p.pull_request) {
      const pr = p.pull_request as { number: number; title: string; html_url: string; merged: boolean; body: string };
      if (p.action === "opened" || (p.action === "closed" && pr.merged)) {
        entries.push({ ...base, number: pr.number, title: pr.title, body: (pr.body ?? "").slice(0, 500), url: pr.html_url, raw: { activity_type: p.action === "opened" ? "pr_opened" : "pr_merged" } });
      }
    } else if (event.type === "IssueCommentEvent" && p.action === "created" && p.comment && p.issue) {
      const issue = p.issue as { number: number; title: string; html_url: string; pull_request?: unknown };
      const comment = p.comment as { html_url: string; body: string };
      entries.push({ ...base, number: issue.number, title: issue.title, body: (comment.body ?? "").slice(0, 500), url: comment.html_url, raw: { activity_type: "comment", is_pr: !!issue.pull_request } });
    }
  }

  console.log(`  [github] ${entries.length} activity items`);
  return { entries, lastEventId: newLastEventId ?? stopId };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function readCursor(): GithubCursor {
  try {
    const prev = JSON.parse(readFileSync(RESULT_FILE, "utf8"));
    return prev.cursor ?? defaultCursor();
  } catch {
    return defaultCursor();
  }
}

function defaultCursor(): GithubCursor {
  return {
    last_sync: new Date(Date.now() - 7 * 86400_000).toISOString(),
    last_event_id: null,
    reviewed_prs: {},
  };
}

function main(): void {
  const collectedAt = new Date().toISOString();
  const cursor = readCursor();
  const errors: string[] = [];
  const allEntries: GithubEntry[] = [];
  const seen = new Set<string>();

  function add(entries: GithubEntry[]) {
    for (const e of entries) {
      if (e.title && !seen.has(e.id)) {
        seen.add(e.id);
        allEntries.push(e);
      }
    }
  }

  // Outgoing activity (tracked separately for cursor)
  let lastEventId = cursor.last_event_id ?? null;
  try {
    const activity = pollMyActivity(cursor, errors);
    lastEventId = activity.lastEventId;
    add(activity.entries);
  } catch (e: unknown) {
    errors.push(`activity: ${(e as Error).message?.slice(0, 150)}`);
  }

  for (const pollFn of [
    () => pollAuthoredPrs(cursor, errors),
    () => pollNotifications(cursor, errors),
    () => pollReviewRequests(cursor, errors),
    () => pollAssigned(errors),
  ]) {
    try {
      add(pollFn());
    } catch (e: unknown) {
      errors.push(`sub-poller: ${(e as Error).message?.slice(0, 150)}`);
    }
  }

  // Update reviewed_prs cursor — track review state for next run
  const newReviewedPrs: GithubCursor["reviewed_prs"] = { ...cursor.reviewed_prs };
  for (const entry of allEntries) {
    const r = entry.raw;
    if (r.reviewed_by_me && r.head_sha && r.my_review_sha) {
      newReviewedPrs[`${entry.repo}#${entry.number}`] = {
        head_sha: r.head_sha as string,
        my_review_sha: r.my_review_sha as string,
      };
    }
  }
  // Evict entries for PRs no longer in the result set
  const activePrKeys = new Set(allEntries.filter((e) => !String(e.raw.activity_type)).map((e) => `${e.repo}#${e.number}`));
  for (const key of Object.keys(newReviewedPrs)) {
    if (!activePrKeys.has(key)) delete newReviewedPrs[key];
  }

  const newCursor: GithubCursor = {
    last_sync: collectedAt,
    last_event_id: lastEventId,
    reviewed_prs: newReviewedPrs,
  };

  const result = {
    scout: "github",
    collected_at: collectedAt,
    status: errors.length === 0 ? "ok" : "error",
    error: errors.length > 0 ? errors.join("; ") : null,
    cursor: newCursor,
    entries: allEntries,
  };

  mkdirSync(join(ROOT, "state", "scout_results"), { recursive: true });
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

  // Update surfaced table — mark all observed entries as seen, prune stale
  const db = openDb();
  for (const entry of allEntries) {
    db.upsertSeen(entry.id, "github");
  }
  const pruned = db.pruneStale("github");
  db.close();

  console.log(`GitHub scout: ${allEntries.length} entries, ${errors.length} errors, ${pruned} pruned → ${RESULT_FILE}`);
}

main();
