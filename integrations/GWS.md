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
- Automated/bot emails (GitHub, Jira, Slack notifications, marketing) → skip silently.
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
     "attendees": ["michael.scully@circle.com", "priya@circle.com"],
     "action_items_mine": ["Follow up with Xavier on the auth migration PR"],
     "action_items_others": [{ "owner": "Priya", "task": "Update the runbook by EOD" }],
     "decisions": ["Shifting release cutoff to Thursday"],
     "open_questions": ["Do we need a feature flag for the new dashboard route?"],
     "previous_meeting_references": ["Circling back on the auth migration from last week"],
     "metrics": ["Error rate on /v2/payments at 0.3% over last 24h"],
     "key_topics": ["Release timeline", "Auth migration", "Dashboard feature flag"],
     "deadlines": ["Release cutoff Thursday"]
   }
   ```

4. Upsert a prose narrative into Chroma (collection: `meetings`). Prose embeds better than raw JSON — compose a natural-language summary from the extracted fields:
   > "Dev Console Standup on 2026-04-05. Key topics: release timeline, auth migration, dashboard feature flag. Decided to shift release cutoff to Thursday. Michael to follow up with Xavier on the auth migration PR. Open question: do we need a feature flag for the new dashboard route?"

   Metadata: `date`, `title`, `recurring_event_id`, `summary_path` (full path to the JSON file). When a vector search returns this chunk, load `summary_path` for the full structured data.

   Skill: `python3 ~/DevEnv/skills/vector-memory/memory.py`

5. DM user with summary + osascript Hero sound. Include every non-empty field from the extracted summary:
   ```
   📝 Dev Console Standup — 10:00am (32 min)

   Key topics:
   • Release timeline
   • Auth migration
   • Dashboard feature flag

   Decisions:
   • Shifting release cutoff to Thursday

   Action items:
   • You: Follow up with Xavier on the auth migration PR → DEV-1234
   • Priya: Update the runbook by EOD

   Open questions:
   • Do we need a feature flag for the new dashboard route?

   Deadlines:
   • Release cutoff Thursday

   Metrics:
   • Error rate on /v2/payments at 0.3% over last 24h
   ```
   Omit any section that has no entries. Always include action items and decisions if present — these are never optional.

6. For each item in `action_items_mine`:
   - **Infer the Jira project** using meeting context (title, key topics, attendees). If a `jira_project` is set on the series entry in `meeting_series.json`, use that directly. Otherwise, query available epics via `mcp__mcp-atlassian__searchJiraIssuesUsingJql` (`issuetype = Epic AND assignee = currentUser() ORDER BY updated DESC`) and match against the action item and meeting context. If it's still ambiguous, DM the user:
     > What Jira project should I use for action items from **"<title>"**? (e.g. `DEV`, `ARC`) — or reply with an epic key to link directly.
     Pause ticket creation for that item until the user replies. Once set, store `jira_project` on the series entry for future meetings.
   - Create a Jira ticket using the `jira-ticket` skill. Set status to `In Progress`.
   - Create a quest with `source.platform: "gws_meet"`. Store `transcript_name` and the Jira ticket key (`source.ticket_key`) on the quest.
   - Include the Jira ticket URL in the DM summary alongside each action item.

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
