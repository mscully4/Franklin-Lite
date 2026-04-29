---
id: proposal-00013
title: Reduce PR monitor timeout waste via state-aware polling
status: proposed
created: 2026-04-17
source: review-franklin
---

## Problem

Over the last 7 days, pr_monitor had a 75.8% success rate (100 ok, 10 errors, 22 timeouts out of 132 dispatches). 51 successful dispatches returned "no action needed" -- monitoring PRs that hadn't changed. The 22 timeouts at 600s each plus 23 scheduled timeouts at 2403s each totaled 19.6 hours of wasted compute. Timeouts cluster at hours 01, 03, 04 UTC.

## Solution

1. **State-hash dedup:** Before dispatching pr_monitor, compare current PR state (head SHA, review status, CI status) against last successful check. Skip if unchanged.
2. **Adaptive polling interval:** PRs with no changes for 2+ cycles get their polling interval doubled (up to 30m). Any state change resets to default.
3. **Root-cause the GraphQL errors:** 10 errors suggest GitHub API rate limits or insufficient OAuth scopes. Log the exact error response and add retry-with-backoff for transient failures.

## Changes Required

| File | Change |
|------|--------|
| src/scouts/github.ts | Add PR state hash tracking; compare before emitting monitor signal |
| modes/brain.md | Update PR monitor dispatch logic to respect state-hash freshness |
| state/settings.json | Add `pr_monitor_max_interval_ms` config (default 1800000) |
