---
id: proposal-00004
title: Meeting Transcript Processing
status: implemented
created: 2026-04-04
updated: 2026-04-05
implemented_at: 2026-04-05
---

# Meeting Transcript Processing

## Problem

Franklin has access to Google Meet transcripts via `gws meet conferenceRecords.transcripts` but currently does nothing with them post-meeting. Processing every meeting indiscriminately would be noisy and wasteful — many calendar events are large all-hands, socials, or recurring series the user doesn't care about.

## Goals

- Automatically summarize meetings the user cares about: decisions, action items, open questions
- Create quests for action items assigned to the user
- Skip meetings the user didn't attend or didn't transcribe
- Let the user opt specific recurring series in/out without touching code

---

## Design

### Gate Checks (in order, cheapest first)

Before fetching any transcript, Franklin checks three gates:

1. **Did you join?** — `gws meet conferenceRecords.participants list` filtered by user email. If not present, skip entirely.
2. **Was it transcribed?** — `gws meet transcripts list` on the conference record. If empty, skip silently.
3. **Is this series opted in?** — check `state/meeting_series.json` (see below). If no entry matches, skip.

---

### Config: `state/meeting_series.json`

Controls which recurring series get processed. Default for any unrecognized series is **skip** — this is an opt-in system.

File starts empty. Franklin populates it over time based on your responses to DMs.

```json
{
  "defaults": {
    "process_transcript": false,
    "min_duration_minutes": 10,
    "max_attendees": 50
  },
  "series": [],
  "pending": []
}
```

After a few meetings, a typical populated file might look like:

```json
{
  "defaults": {
    "process_transcript": false,
    "min_duration_minutes": 10,
    "max_attendees": 50
  },
  "series": [
    {
      "title_pattern": "Dev Console Standup",
      "recurring_event_id": "abc123",
      "process_transcript": true
    },
    {
      "title_pattern": "Friday Social",
      "recurring_event_id": "xyz789",
      "process_transcript": false
    }
  ],
  "pending": [
    {
      "title_pattern": "Vibebox Office Hours",
      "recurring_event_id": "def456",
      "last_asked": "2026-04-04T10:00:00Z"
    }
  ]
}
```

**Fields:**
- `title_pattern` — substring match against the calendar event title (case-insensitive)
- `recurring_event_id` — Google Calendar recurringEventId for exact matching; preferred over title_pattern when available
- `process_transcript` — true to process, false to explicitly block
- `min_duration_minutes` — optional per-series override
- `max_attendees` — optional per-series override; skip if attendance exceeded this

One-off meetings (no recurringEventId on the calendar event) are skipped by default. They can be opted in by adding an entry with no `recurring_event_id` and matching on `title_pattern`.

---

### Auto-Discovery

`meeting_series.json` starts empty — Franklin never writes entries on its own. Instead:

Each cycle, when a meeting ends that passed gates 1 and 2 (you joined, it was transcribed) but has no matching entry in `meeting_series.json`, Franklin DMs the user once per series:

> New recurring meeting detected: **"<title>"** — transcript available. Want me to summarize these going forward? Reply `yes` or `no`.

On `yes`: Franklin adds an opted-in entry to `meeting_series.json` and processes the current transcript immediately.
On `no`: Franklin adds an opted-out entry so it never asks again.
No reply: Franklin asks again next time a transcript is available for that series (bounded to once per 7 days to avoid spam).

Franklin tracks which series it has already asked about in `state/meeting_series.json` under a `pending` key so it doesn't re-ask within the cooldown window.

---

### Subagent Extraction Spec

Franklin spawns a general-purpose subagent with the full transcript text and meeting metadata. The subagent is asked to extract the following structured output:

**Always extract:**
- `action_items_mine` — action items explicitly or implicitly assigned to the user
- `action_items_others` — action items assigned to other attendees (owner name + task)
- `decisions` — conclusions reached; things that were agreed or resolved
- `open_questions` — unresolved questions or blockers raised but not answered
- `previous_meeting_references` — any references to prior discussions, past decisions, or unresolved items from earlier meetings (e.g. "as we discussed last week") — used to link to related quests or prior summaries in vector memory

**Extract when present:**
- `metrics` — any specific numbers mentioned (error rates, latency, conversion, revenue, etc.) with context
- `design_decisions` — architectural or technical choices made, trade-offs discussed
- `key_topics` — high-level list of topics covered (2–5 bullet points max)
- `deadlines` — dates or timeframes mentioned that didn't become formal action items

This is the general framework. Per-series overrides (e.g. skip `key_topics` for standups, always extract `metrics` for technical syncs) can be added to `meeting_series.json` entries later as needed.

The subagent returns a single JSON object with these fields. Missing fields are omitted rather than returned as empty arrays.

### Processing Flow (post-meeting, inside GWS monitor cycle)

```
for each meeting that ended in the last cycle:
  1. Gate 1: participant check → skip if user not present
  2. Gate 2: series config check → skip if no matching entry with process_transcript=true
             (avoids unnecessary Meet API calls for unrecognized/opted-out series)
  3. Gate 3: transcript check → skip if no transcript available
  4. Fetch all transcript entries (paginate)
  5. Spawn subagent with transcript entries + meeting metadata
     → returns structured extraction (see above)
  6. Write summary to state/meetings/<YYYY-MM-DD>-<slugified-title>.json
  7. Upsert prose summary into Chroma (collection: "meetings")
  8. DM user with summary + osascript Hero sound
  9. Create quests for action items in action_items_mine
  10. Store transcript name + summary file path on each quest for reference
```

Note: gate order swapped from naive order — series config checked before hitting the Meet API.

### Summary Storage

`state/meetings/<YYYY-MM-DD>-<slugified-title>.json`:

```json
{
  "date": "2026-04-04",
  "title": "Dev Console Standup",
  "recurring_event_id": "abc123",
  "conference_record": "conferenceRecords/xyz",
  "transcript_name": "conferenceRecords/xyz/transcripts/abc",
  "duration_minutes": 32,
  "attendees": ["michael.scully@circle.com", "priya@circle.com"],
  "action_items_mine": ["Follow up with Xavier on the auth migration PR"],
  "action_items_others": [
    { "owner": "Priya", "task": "Update the runbook by EOD" }
  ],
  "decisions": ["Shifting release cutoff to Thursday"],
  "open_questions": ["Do we need a feature flag for the new dashboard route?"],
  "previous_meeting_references": ["Circling back on the auth migration discussion from last week"],
  "metrics": ["Error rate on /v2/payments sitting at 0.3% over the last 24h"],
  "design_decisions": [],
  "key_topics": ["Release timeline", "Auth migration", "Dashboard feature flag"],
  "deadlines": ["Release cutoff Thursday"]
}
```

### Vector Memory

After writing to disk, Franklin composes a short prose narrative from the extracted fields and upserts it into Chroma (collection: `meetings`). Prose is used rather than raw JSON because embedding models retrieve semantically against natural language more reliably.

Example document:
> "Dev Console Standup on 2026-04-04. Key topics: release timeline, auth migration, dashboard feature flag. Decided to shift release cutoff to Thursday. Michael to follow up with Xavier on the auth migration PR. Open question: do we need a feature flag for the new dashboard route?"

Metadata stored alongside: `date`, `title`, `recurring_event_id`, `summary_path` (path to the full JSON file on disk). When a vector search returns this chunk, Franklin loads the full structured summary from `summary_path` if it needs the complete data.

---

### DM Format

```
📝 Dev Console Standup — 10:00am (32 min)

Decisions:
• Shifting release cutoff to Thursday

Action items:
• You: Follow up with Xavier on the auth migration PR
• Priya: Update the runbook by EOD

Open questions:
• Do we need a feature flag for the new dashboard route?
```

---

## Changes Required

| File | Change |
|---|---|
| `integrations/GWS.md` | Replace post-meeting section with gate-check + processing flow |
| `state/meeting_series.json` | Lazy-initialized — Franklin creates the empty skeleton on first read if missing |
| `modes/RUN.md` | No change needed — GWS monitor already runs each cycle |

---

## Out of Scope

- Storing full transcript text (only the summary is kept)
- Retroactive processing of past meetings
- Non-Meet platforms (Zoom, Teams)
