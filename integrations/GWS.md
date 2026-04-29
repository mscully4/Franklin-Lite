# Franklin — Google Workspace Guide

Read this file when `"gws"` is in `integrations`. Covers the GWS Monitor (run each cycle) and allowed operations during quest execution.

---

## GWS Monitor (Step 2d)

Run each cycle when `"gws"` is in `integrations`.

### Gmail Triage

Fetch unread inbox:
```bash
gws gmail +triage --format json --max 20 | jq '.messages | map({id, from, subject, date})'
```

For each email in the result:
- From a teammate or manager → DM the user with sender, subject, one-line summary. Log as `info_received`.
- Automated/bot emails (system notifications, marketing) → skip silently.
- Requires a reply → create a quest with the draft reply for user approval.

To read a full email thread: use `gws-gmail` skill with the `id` from above.

### Calendar

Use `gws-calendar-agenda` to check today's and tomorrow's events each cycle.

**`state/calendar.json` is the single source of truth for calendar state.** Schema:
```json
{
  "date": "YYYY-MM-DD",
  "events": [
    { "id": "...", "title": "...", "start": "ISO 8601", "end": "ISO 8601", "attendees": [], "notified": false }
  ]
}
```

Fetch today's events:
```bash
gws calendar +agenda --today --format json | jq '.events | map({summary, start, end, calendar, location})'
```

**Each cycle:**
1. Check if `calendar.json` → `date` matches today. If not, reset to `{ "date": "<today>", "events": [] }`.
2. Fetch today's full event list using the command above. Merge into `calendar.json`:
   - Add new events.
   - Remove dropped meetings → DM user + macOS notification.
   - Update changed fields (title, time) → DM user + macOS notification.
   - Preserve `notified: true` — never reset it.
3. Write the updated `calendar.json`.

**Pre-meeting alerts** — for any event with `notified: false` and start ≤15 min away (and >0 min), fire both in parallel:
1. macOS notification: `osascript -e 'display notification "<title>" with title "Franklin ☕" subtitle "Starting in ~N min" sound name "Hero"'`
2. Slack DM to user with title, time, attendees, and linked docs (use `gws-workflow-meeting-prep`).

Set `notified: true` and save `calendar.json`.

**Post-meeting:** for any meeting that ended in the last cycle, run the following gates in order before doing any processing:

**Gate 1 — Did you join?**
```bash
gws meet conferenceRecords list --params 'filter=start_time>="<start_ISO>" AND start_time<="<end_ISO>"' \
  | jq '[.conferenceRecords[]? | {name, startTime, endTime, spaceId: .space}]'

# Then check participants:
gws meet conferenceRecords participants list --params parent=<conferenceRecord-name> \
  | jq '[.participants[]? | {name, email: .signedinUser.email}]'
```
- If the user's email **is** in the participant list → continue to Gate 2.
- If the user's email **is not** in the participant list → DM the user once per meeting:
  > You weren't in **"<title>"** (<time>, <duration> min) — want me to pull the transcript anyway?

  On `yes`: continue to Gate 2. On `no` or no reply within one cycle: skip silently. Do not re-ask.

**Gate 2 — Is this series opted in?**

Read `state/meeting_series.json` (lazy-initialize with empty skeleton if missing):
```json
{ "defaults": { "process_transcript": false, "min_duration_minutes": 10, "max_attendees": 50 }, "series": [], "pending": [] }
```
Match the calendar event's `recurringEventId` against `series[].recurring_event_id` (exact), or fall back to case-insensitive substring match on `title_pattern`.

- If a matching entry exists with `process_transcript: true` → proceed.
- If a matching entry exists with `process_transcript: false` → skip silently.
- If **no** matching entry exists → check `pending[]` for an entry with the same `recurring_event_id`. If found and `last_asked` is within 7 days, skip. Otherwise, DM the user:
  > New recurring meeting detected: **"<title>"** — transcript available. Want me to summarize these going forward? Reply `yes` or `no`.
  Add/update a `pending` entry with `last_asked: <now>`. On `yes` reply: add an opted-in entry to `series[]`, remove from `pending[]`, and process the transcript. On `no`: add an opted-out entry, remove from `pending[]`.

One-off meetings (no `recurringEventId`) are skipped by default.

**Gate 3 — Was it transcribed?**
```bash
gws meet transcripts list --params conferenceRecord=<conferenceRecord-name> \
  | jq '[.transcripts[]? | {name, startTime}]'
```
If the list is empty, skip silently — transcription may not have been enabled.

**Notes doc** — if the event had a linked doc, check for action items (`gws-drive`). If any mention the user, create quests.

**Transcript processing** — once all three gates pass:

1. Fetch all transcript entries (paginate):
   ```bash
   gws meet transcripts entries list --params parent=<transcript-name> \
     | jq '[.transcriptEntries[]? | {participantName: .participant, text, startTime}]'
   # Paginate using nextPageToken until exhausted
   ```

2. Spawn a general-purpose subagent with the full transcript text and meeting metadata. Ask it to extract:
   - `action_items_mine` — action items assigned to the user
   - `action_items_others` — action items assigned to others `[{owner, task}]`
   - `decisions` — conclusions reached or agreed upon
   - `open_questions` — unresolved questions or blockers
   - `previous_meeting_references` — references to prior discussions (for linking to related quests/summaries)
   - `metrics` — specific numbers mentioned with context (error rates, latency, etc.) — when present
   - `design_decisions` — architectural or technical choices made — when present
   - `key_topics` — 2–5 bullet high-level topics covered — when present
   - `deadlines` — dates/timeframes mentioned that didn't become formal action items — when present

   Missing fields are omitted rather than returned empty. Per-series extraction overrides can be added to `meeting_series.json` entries later as needed.

3. Write summary to `state/meetings/<YYYY>/<MM>/<DD>/<slugified-title>.json` (partitioned by date for faster lookups):
   ```json
   {
     "date": "2026-04-05",
     "title": "Dev Console Standup",
     "recurring_event_id": "abc123",
     "conference_record": "conferenceRecords/xyz",
     "transcript_name": "conferenceRecords/xyz/transcripts/abc",
     "duration_minutes": 32,
     "attendees": ["alice@example.com", "bob@example.com"],
     "action_items_mine": ["Follow up with Alice on the project proposal"],
     "action_items_others": [{ "owner": "Bob", "task": "Send the revised draft by EOD" }],
     "decisions": ["Moving the deadline to Thursday"],
     "open_questions": ["Do we need a follow-up meeting next week?"],
     "previous_meeting_references": ["Circling back on the proposal from last week"],
     "key_topics": ["Project timeline", "Budget", "Next steps"],
     "deadlines": ["Draft due Thursday"]
   }
   ```

4. Upsert a prose narrative into Chroma (collection: `meetings`). Prose embeds better than raw JSON — compose a natural-language summary from the extracted fields:
   > "Weekly Sync on 2026-04-05. Key topics: project timeline, budget, next steps. Decided to move deadline to Thursday. Alice to follow up on the project proposal. Open question: do we need a follow-up meeting next week?"

   Metadata: `date`, `title`, `recurring_event_id`, `summary_path` (full path to the JSON file). When a vector search returns this chunk, load `summary_path` for the full structured data.

   Skill: `python3 ~/DevEnv/skills/vector-memory/memory.py`

5. DM user with summary + osascript Hero sound. Include every non-empty field from the extracted summary:
   ```
   📝 Weekly Sync — 10:00am (32 min)

   Key topics:
   • Project timeline
   • Budget
   • Next steps

   Decisions:
   • Moving deadline to Thursday

   Action items:
   • You: Follow up with Alice on the project proposal
   • Bob: Send the revised draft by EOD

   Open questions:
   • Do we need a follow-up meeting next week?

   Deadlines:
   • Draft due Thursday

   Metrics:
   • Error rate on /v2/payments at 0.3% over last 24h
   ```
   Omit any section that has no entries. Always include action items and decisions if present — these are never optional.

6. For each item in `action_items_mine`:
   - Create a quest with `source.platform: "gws_meet"`. Store `transcript_name` on the quest.
   - DM the user asking whether to create a quest for the action item before doing so.

### Skills

| Skill | When to use |
|---|---|
| ~~`gws-gmail-triage`~~ | Replaced by `gws gmail +triage --format json \| jq` (see above) |
| `gws-gmail` | Read full email threads, send replies (with approval) |
| ~~`gws-calendar-agenda`~~ | Replaced by `gws calendar +agenda --today --format json \| jq` (see above) |
| `gws-workflow-meeting-prep` | Pre-meeting briefing (attendees, agenda, linked docs) |
| `gws-workflow-standup-report` | Generate standup summary on demand |
| `gws-workflow-weekly-digest` | Weekly summary of meetings + email volume |
| `gws-workflow-email-to-task` | Convert an email into a Google Task |
| `gws-drive` | Read docs, check for comments or action items |
| `recipe-find-free-time` | Find a meeting slot across multiple people's calendars |
| `recipe-block-focus-time` | Block focus time on calendar when user asks |

In `drafts_only` mode, draft any outbound emails or calendar changes for user approval. Never send email or create calendar events without explicit approval.

---

## Allowed Operations During Quests

**Read-only access is always allowed:**
- Drive: search and list files, export documents
- Docs: read document content
- Sheets: read spreadsheet data
- Calendar: list events, check availability

**Write operations** (create, edit, delete files/docs/sheets/events, send email) require the quest objective to explicitly require it AND the user to have approved that specific action.

Log all GWS reads in the quest log with `action: "info_received"` and `platform: "gws"`.
