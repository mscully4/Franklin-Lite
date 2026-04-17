import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { githubState, jiraState, statesEqual } from "../filter-signals.js";
import type { GithubEntry } from "../scouts/github.js";
import type { JiraEntry } from "../scouts/jira.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePr(overrides: Partial<GithubEntry["raw"]> = {}): GithubEntry {
  return {
    id: "github:pr:crcl-main/wallets-api/1",
    type: "pr_authored",
    title: "DEV-001: test PR",
    body: "",
    url: "https://github.com/crcl-main/wallets-api/pull/1",
    repo: "crcl-main/wallets-api",
    number: 1,
    author: "michael-scully_crcl",
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-01T00:00:00Z",
    labels: [],
    raw: {
      state: "open",
      jira_key: "DEV-001",
      ci_failing: [],
      changes_requested: [],
      approved: false,
      head_sha: "abc123",
      ...overrides,
    },
  };
}

function makeTicket(overrides: Partial<JiraEntry> = {}): JiraEntry {
  return {
    id: "jira:ticket:DEV-001",
    type: "assigned",
    key: "DEV-001",
    summary: "Test ticket",
    status: "In Progress",
    priority: "Medium",
    updated: "2026-04-01T00:00:00Z",
    labels: [],
    last_comment: null,
    github_pr_url: null,
    raw: {},
    ...overrides,
  };
}

// ── githubState ───────────────────────────────────────────────────────────────

describe("githubState", () => {
  test("extracts ci_failing, changes_requested, approved", () => {
    const entry = makePr({ ci_failing: ["lint"], changes_requested: ["alice"], approved: false });
    assert.deepEqual(githubState(entry), {
      ci_failing: ["lint"],
      changes_requested: ["alice"],
      approved: false,
    });
  });

  test("defaults to empty arrays and false when raw fields are missing", () => {
    const entry = makePr();
    delete (entry.raw as Record<string, unknown>).ci_failing;
    delete (entry.raw as Record<string, unknown>).changes_requested;
    delete (entry.raw as Record<string, unknown>).approved;
    assert.deepEqual(githubState(entry), {
      ci_failing: [],
      changes_requested: [],
      approved: false,
    });
  });

  test("does not include head_sha or other raw fields", () => {
    const entry = makePr({ head_sha: "abc123", jira_key: "DEV-001" });
    const state = githubState(entry);
    assert.equal("head_sha" in state, false);
    assert.equal("jira_key" in state, false);
  });
});

// ── jiraState ─────────────────────────────────────────────────────────────────

describe("jiraState", () => {
  test("extracts status and last_comment_updated", () => {
    const entry = makeTicket({
      status: "In Progress",
      last_comment: { author: "Alice", body: "LGTM", updated: "2026-04-05T10:00:00Z" },
    });
    assert.deepEqual(jiraState(entry), {
      status: "In Progress",
      last_comment_updated: "2026-04-05T10:00:00Z",
    });
  });

  test("last_comment_updated is null when no comment", () => {
    const entry = makeTicket({ status: "Backlog", last_comment: null });
    assert.deepEqual(jiraState(entry), {
      status: "Backlog",
      last_comment_updated: null,
    });
  });
});

// ── statesEqual ───────────────────────────────────────────────────────────────

describe("statesEqual", () => {
  test("equal objects return true", () => {
    assert.ok(statesEqual({ ci_failing: ["lint"], approved: false }, { ci_failing: ["lint"], approved: false }));
  });

  test("different ci_failing returns false", () => {
    assert.ok(!statesEqual({ ci_failing: ["lint"] }, { ci_failing: ["lint", "test"] }));
  });

  test("order of ci_failing items matters", () => {
    // JSON.stringify is order-sensitive — document this behavior
    assert.ok(!statesEqual({ ci_failing: ["a", "b"] }, { ci_failing: ["b", "a"] }));
  });

  test("empty object vs populated returns false", () => {
    assert.ok(!statesEqual({}, { ci_failing: [] }));
  });

  test("two empty objects are equal", () => {
    assert.ok(statesEqual({}, {}));
  });

  test("null values are compared correctly", () => {
    assert.ok(statesEqual({ last_comment_updated: null }, { last_comment_updated: null }));
    assert.ok(!statesEqual({ last_comment_updated: null }, { last_comment_updated: "2026-04-05T10:00:00Z" }));
  });
});

// ── Change detection scenarios ────────────────────────────────────────────────

describe("change detection scenarios", () => {
  test("CI goes from passing to failing — states differ", () => {
    const prev = { ci_failing: [], changes_requested: [], approved: false };
    const curr = githubState(makePr({ ci_failing: ["lint"] }));
    assert.ok(!statesEqual(prev, curr));
  });

  test("CI still failing with same check — states equal (no re-notify)", () => {
    const prev = { ci_failing: ["lint"], changes_requested: [], approved: false };
    const curr = githubState(makePr({ ci_failing: ["lint"] }));
    assert.ok(statesEqual(prev, curr));
  });

  test("new comment on ticket — states differ", () => {
    const prev = { status: "In Progress", last_comment_updated: null };
    const curr = jiraState(makeTicket({
      last_comment: { author: "Alice", body: "update", updated: "2026-04-05T10:00:00Z" },
    }));
    assert.ok(!statesEqual(prev, curr));
  });

  test("ticket status unchanged, same comment — states equal", () => {
    const prev = { status: "In Progress", last_comment_updated: "2026-04-05T10:00:00Z" };
    const curr = jiraState(makeTicket({
      status: "In Progress",
      last_comment: { author: "Alice", body: "update", updated: "2026-04-05T10:00:00Z" },
    }));
    assert.ok(statesEqual(prev, curr));
  });

  test("first-time signal (previous state empty object) — always differs", () => {
    const prev = {};
    const curr = githubState(makePr());
    assert.ok(!statesEqual(prev, curr));
  });
});
