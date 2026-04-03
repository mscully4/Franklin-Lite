# Franklin — Google Workspace Guide

Read this file when `"gws"` is in `integrations`. Covers the GWS Monitor (run each cycle) and allowed operations during quest execution.

---

## GWS Monitor (Step 2d)

Run each cycle when `"gws"` is in `integrations`.

### Gmail Triage

Use `gws-gmail-triage` to check unread inbox. For each unread email:
- From a teammate or manager → DM the user with sender, subject, one-line summary. Log as `info_received`.
- Automated/bot emails (GitHub, Jira, Slack notifications, marketing) → skip silently.
- Requires a reply → create a quest with the draft reply for user approval.

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

**Each cycle:**
1. Check if `calendar.json` → `date` matches today. If not, reset to `{ "date": "<today>", "events": [] }`.
2. Fetch today's full event list. Merge into `calendar.json`:
   - Add new events.
   - Remove dropped meetings → DM user + macOS notification.
   - Update changed fields (title, time) → DM user + macOS notification.
   - Preserve `notified: true` — never reset it.
3. Write the updated `calendar.json`.

**Pre-meeting alerts** — for any event with `notified: false` and start ≤15 min away (and >0 min), fire both in parallel:
1. macOS notification: `osascript -e 'display notification "<title>" with title "Franklin ☕" subtitle "Starting in ~N min" sound name "Hero"'`
2. Slack DM to user with title, time, attendees, and linked docs (use `gws-workflow-meeting-prep`).

Set `notified: true` and save `calendar.json`.

**Post-meeting:** if a meeting ended in the last hour and had a notes doc, check for action items (`gws-drive`). If action items mention the user, create quests.

### Google Tasks

Use `gws-tasks` to check for overdue or due-today tasks. DM the user if any exist.

### Skills

| Skill | When to use |
|---|---|
| `gws-gmail-triage` | Check unread inbox each cycle |
| `gws-gmail` | Read full email threads, send replies (with approval) |
| `gws-calendar-agenda` | Check today/tomorrow's calendar |
| `gws-workflow-meeting-prep` | Pre-meeting briefing (attendees, agenda, linked docs) |
| `gws-workflow-standup-report` | Generate standup summary on demand |
| `gws-workflow-weekly-digest` | Weekly summary of meetings + email volume |
| `gws-workflow-email-to-task` | Convert an email into a Google Task |
| `gws-tasks` | Check and manage task list |
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
