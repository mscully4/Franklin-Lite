---
id: proposal-00005
title: Stagger Scout Intervals by Phase Offset
status: implemented
created: 2026-04-05
updated: 2026-04-05
implemented_at: 2026-04-05
---

## Problem

Scouts with the same interval fire simultaneously every cycle, creating bursts of parallel API calls at predictable moments. The 10-min group (`slack_channels`, `github`, `jira`) is the worst offender — three scouts all hitting different APIs at the same instant every 10 minutes.

## Research

Current scout intervals:
- **2 min:** `slack_mentions`, `gws_calendar`
- **10 min:** `slack_channels`, `github`, `jira`
- **30 min:** `gws_gmail`, `gws_tasks`

The due-check is: `now - scout_last_run[scout] >= interval_sec`. When `scout_last_run` is missing, the scout is treated as never run — meaning all scouts fire on the very first loop and stay in lockstep thereafter.

## Proposal

Add a `phase_sec` offset to each scout. Change the missing-entry initialization rule: instead of treating a missing entry as "never run" (fires immediately), initialize `scout_last_run[scout] = now - interval_sec + phase_sec`. The scout then first fires after `phase_sec` seconds and stays staggered on all subsequent cycles. The due-check logic is unchanged.

## Design

Phase assignments spread load evenly within each interval group:

| Scout | Interval | Phase |
|---|---|---|
| `slack_mentions` | 2 min | 0s |
| `gws_calendar` | 2 min | 60s |
| `slack_channels` | 10 min | 0s |
| `github` | 10 min | 180s (3 min) |
| `jira` | 10 min | 420s (7 min) |
| `gws_gmail` | 30 min | 0s |
| `gws_tasks` | 30 min | 900s (15 min) |

Existing `scout_last_run` entries in `last_run.json` are unaffected — staggering only applies when an entry is absent (fresh installs or scouts added later).

## Implementation Plan

1. Update the scout table in `modes/RUN.md` to add a `Phase` column.
2. Update the initialization rule prose to reference `phase_sec`.

## Open Questions

None.

## References

- `modes/RUN.md` — scout scheduling logic
