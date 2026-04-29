---
id: proposal-00014
title: Retire or re-enable 5 stale scouts
status: proposed
created: 2026-04-17
source: review-franklin
---

## Problem

Five scouts (slack_inbox, slack_scout, gws_calendar, gws_gmail, gws_meet) last ran on 2026-04-07 and have not executed since. They are not listed in SCOUT_INTERVALS_MS in config.ts, so the supervisor never schedules them. Meanwhile, brain.md Step 3 expects slack_inbox.json as input, creating a dead reference.

## Solution

Determine intent for each scout:
- **slack_inbox / slack_scout:** Likely replaced by slack_channels scout. If so, remove from last_run.json and update brain.md to remove slack_inbox references.
- **gws_calendar / gws_gmail / gws_meet:** Likely replaced by newer gmail/calendar scouts. If so, clean up stale entries. If gws_calendar provided unique signals (e.g., meeting prep), re-enable by adding to SCOUT_INTERVALS_MS.

## Changes Required

| File | Change |
|------|--------|
| src/config.ts | Either add stale scouts to SCOUT_INTERVALS_MS or document removal |
| state/last_run.json | Remove entries for retired scouts |
| modes/brain.md | Remove/update references to scout outputs that no longer exist |
