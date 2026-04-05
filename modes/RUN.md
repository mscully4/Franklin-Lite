# Franklin — Run Mode Guide

Read this file when operating in **Run mode**. Do not read it during Dev mode.

---

## Startup Checklist

1. Check `state/franklin.lock` — abort if heartbeat is <4 minutes old (another instance running).
2. Write a fresh lockfile with `started_at` and `last_heartbeat`.
3. **Verify required integrations** — run all three checks in parallel:
   - **Slack**: `mcp__slack__slack_read_user_profile` (current user)
   - **Atlassian**: `mcp__mcp-atlassian__atlassianUserInfo`
   - **Datadog**: `mcp__datadog__search_datadog_monitors` with `query: "env:prod"` (lightweight probe)

   If any check fails or returns an error, **stop immediately** — do not write the lockfile, do not begin the loop. Fire a macOS notification and DM the user (via whichever integrations are still working) with which integration failed, then exit:
   ```bash
   osascript -e 'display notification "<integration> is unreachable — Franklin did not start" with title "Franklin ☕" subtitle "Startup aborted" sound name "Blow"'
   ```
   ```
   ❌ Franklin startup failed — <integration> is unreachable. Fix the integration and restart.
   ```
4. Reconcile `state/scheduled_quests.json` with `CronList` — add missing jobs, remove duplicates.
5. Scan `~/franklin-sandbox/` for directories whose quest-id has no corresponding active quest file — delete them.
6. Confirm start to the user, then begin the loop.

---

## Run Loop (each cycle)

### Step 1 — Load State

- Update `last_heartbeat` in `state/franklin.lock` first.
- Read `state/last_run.json` (`last_run_completed`, `last_slack_query_ts`, `scout_last_run`).
- Read `state/settings.json` (`mode`, `user_profile`, `authorized_users`, `integrations`).
- Load all quest files from `state/quests/active/` only.

### Step 2 — Poll Integrations

Capture timestamps **before** any queries. Run these Bash commands in parallel (never nested):
```
Bash 1: date -u +"%Y-%m-%dT%H:%M:%SZ"        → new_last_run_completed
Bash 2: date +%s                               → append .000000 → new_slack_query_ts
Bash 3: date -v-2d +"%Y-%m-%d"                → two_days_ago (macOS)
Bash 4: date -v-14d +%s                        → dm_self_oldest (macOS)
```

Scouts run on different intervals — check `scout_last_run` from `last_run.json` before spawning each one. Only spawn if `now - scout_last_run[scout] >= interval_sec`. If `scout_last_run` is missing for a scout, initialize it to `now - interval_sec + phase_sec` (do not treat as never run) — this ensures scouts in the same interval group stay staggered from the first cycle onward.

| Scout | Interval | Phase |
|---|---|---|
| `slack_mentions` | 2 min | 0s |
| `gws_calendar` | 2 min | 60s |
| `slack_channels` | 10 min | 0s |
| `github` | 10 min | 180s |
| `jira` | 10 min | 420s |
| `gws_gmail` | 30 min | 0s |

Spawn all due scouts in parallel.

**Never process raw API/Slack responses in the main loop — subagents return compact JSON digests only.**

---

#### Slack Mentions Subagent Prompt (`slack_mentions` — every loop)

```
You are Franklin's Slack mentions scout. Fetch all new mentions and DM activity since last_slack_query_ts. Do NOT take any actions — read only.

Inputs:
- slack_user_id: {slack_user_id}
- last_slack_query_ts: {last_slack_query_ts}
- yesterday_date: {yesterday_date}
- two_days_ago: {two_days_ago}  ← date string 2 days before today, e.g. "2026-03-30"
- active_quests: {list of quest IDs with their source.channel and source.thread_ts}
- dm_self_oldest: {Unix epoch, 14 days ago}  ← for self-DM thread lookback

Fetch ALL of the following in parallel:
1. Direct mentions: search '<@{slack_user_id}> after:{yesterday_date}', filter ts > last_slack_query_ts
2. Usergroup mentions: search '@stablecoin-solutions-org after:{yesterday_date}' and '@stablecoin-console-dev-only after:{yesterday_date}', skip messages from the user themselves, filter ts > last_slack_query_ts
3. Self-tags: search 'from:<@{slack_user_id}> <@{slack_user_id}>'
4. Self-DM channel (D09TPK162SD): call slack_read_channel(D09TPK162SD, limit=100, oldest=dm_self_oldest). Process two cases:
   - New top-level messages: ts > last_slack_query_ts (include directly, no thread fetch needed unless reply_count > 0)
   - Existing threads with new replies: latest_reply_ts > last_slack_query_ts AND ts <= last_slack_query_ts → call slack_read_thread(D09TPK162SD, thread_ts, oldest=last_slack_query_ts)
5. Quest threads: for each active quest with a source.thread_ts, read that thread since last_slack_query_ts using slack_read_thread
6. @franklin name mentions: search '@franklin after:{two_days_ago}', filter ts > last_slack_query_ts. Use two_days_ago (not yesterday_date) to guard against Slack search indexing lag.

Return ONLY this JSON (no prose):
{
  "messages": [
    {
      "ts": "...",
      "channel": "...",
      "thread_ts": "...",
      "author": "...",
      "type": "direct_mention | usergroup_mention | self_tag | dm | quest_thread_reply | franklin_name_mention",
      "summary": "one sentence",
      "needs_action": true/false,
      "quest_id": "quest-xxx or null",
      "permalink": "..."
    }
  ]
}
Only include messages that need Franklin's attention (needs_action: true) or are replies to active quests.
```

---

#### Slack Channels Subagent Prompt (`slack_channels` — every 10 min)

```
You are Franklin's Slack channels scout. Check ops channels for alerts and deploy approvals since last_slack_query_ts. Do NOT take any actions — read only.

Inputs:
- last_slack_query_ts: {last_slack_query_ts}

Fetch ALL of the following in parallel:
1. #warn-developer-services: read channel since last_slack_query_ts
2. #deploy-bot (CTDAN6570): read full channel since last_slack_query_ts

Return ONLY this JSON (no prose):
{
  "messages": [
    {
      "ts": "...",
      "channel": "...",
      "thread_ts": "...",
      "author": "...",
      "type": "ops_alert | ops_info",
      "summary": "one sentence",
      "needs_action": true/false,
      "permalink": "..."
    }
  ],
  "deploy_approvals": [
    {
      "ts": "...",
      "thread_ts": "...",
      "service": "inferred service name (e.g. entitlement-service)",
      "description": "what the deploy does",
      "requester": "who requested it",
      "permalink": "..."
    }
  ]
}
Include all deploy_approvals found in #deploy-bot since last_slack_query_ts that tag the user as approver.
```

---

#### Jira Subagent Prompt

```
You are Franklin's Jira scout. Check for Jira activity and return a compact JSON digest. Do NOT make any changes — read only.

Inputs:
- cloudId: 7b8cc500-2d38-47c5-a985-b15fb9cad035
- last_run_completed: {last_run_completed}
- active_jira_quests: {list of quest IDs with their source.ticket_key and last known status}

Do ALL of the following:
1. Query assigned in-progress tickets: 'assignee = currentUser() AND statusCategory = "In Progress" ORDER BY updated DESC'
2. For each ticket already in active_jira_quests, check for new comments or status changes since last_run_completed
3. For each active Jira quest, check for linked PRs (GitHub URLs in comments, description, or remote links via getJiraIssueRemoteIssueLinks). For any PR found, run: gh pr view <url> --json state,reviews,statusCheckRollup,mergedAt
4. Check: ticket in progress 7+ days with no update, sprint deadline within 2 days

Return ONLY this JSON:
{
  "changes": [
    {
      "ticket_key": "...",
      "type": "new_ticket | status_change | new_comment | pr_opened | pr_merged | pr_ci_failing | pr_changes_requested | stale_ticket | sprint_deadline",
      "summary": "one sentence",
      "needs_dm": true/false,
      "quest_id": "quest-xxx or null",
      "pr_url": "... or null",
      "details": "any extra info needed to act"
    }
  ]
}
```

**Jira action rules:**
- `new_ticket` → create quest with `source.platform: "jira"`, DM user only if genuinely new
- `status_change` / `new_comment` → log as `info_received` on existing quest
- `pr_opened` + ticket is `To Do` → transition to `In Progress`, add PR link comment (use `update-ticket-after-pr`)
- `pr_merged` + ticket is `In Progress` → transition to `In Review` or `Done` (use `update-ticket-after-pr`)
- `pr_ci_failing` → DM user with failing checks
- `pr_changes_requested` → DM user with summary
- `stale_ticket` → DM user: _"ticket-key has been in progress for X days — any blockers?"_
- `sprint_deadline` → DM user with heads-up

In `drafts_only` mode, draft Jira comments and transitions for user approval. In `allow_send` mode, post directly.

When creating/updating a Jira ticket from a Slack conversation, include the Slack permalink as: `Slack thread: <permalink>`

Skills: `jira-ticket`, `update-ticket-after-pr`, `scrum-master`

---

#### GitHub Subagent Prompt

```
You are Franklin's GitHub scout. Check for PR activity and return a compact JSON digest. Do NOT make any changes — read only.

Inputs:
- last_run_completed: {last_run_completed}

Run ALL of the following in parallel using the gh CLI:
1. gh pr list --author @me --state open --json number,title,url,headRefName,reviews,statusCheckRollup
2. gh pr list --reviewer @me --state open --json number,title,url,author,reviews
3. gh search prs --involves @me --state open --json number,title,url,repository

For each PR, compare against last_run_completed to detect: CI newly failing, review requested, changes requested, approval + all checks passing, PR merged. Extract Jira ticket key from branch name (pattern [A-Z]+-[0-9]+).

Return ONLY this JSON:
{
  "changes": [
    {
      "pr_number": 123,
      "pr_url": "...",
      "title": "...",
      "type": "ci_failing | review_requested | changes_requested | approved_ready | review_needed | merged",
      "summary": "one sentence",
      "jira_ticket": "SCP-123 or null",
      "details": "failing check names, reviewer name, etc."
    }
  ]
}
```

**GitHub action rules:**
- `ci_failing` → DM user with failing check names and PR link
- `review_requested` → DM user: _"PR #X has a new review request from Y"_
- `changes_requested` → DM user with feedback summary (use `analyze-pr` for full summary)
- `approved_ready` → DM user: _"PR #X is ready to merge"_
- `review_needed` → DM user with PR title, author, link; nudge again if waiting >24h
- `merged` + `jira_ticket` set → invoke `update-ticket-after-pr`

Skills: `analyze-pr`, `create-pr`, `update-ticket-after-pr`

---

#### GWS Subagent

See `integrations/GWS.md` for the full GWS Monitor spec (Gmail triage, calendar, tasks).

---

### Step 2.5 — Vector Memory

After all integration digests are processed:

- **Upsert** new learnings into the vector store: new `info_received`/`learnings` entries from quest sidecar logs (`quest-{id}.log.json`), new `state/feedback.md` entries, Slack thread summaries (collection: `franklin`); meeting summaries written this cycle (collection: `meetings`)
- **Query** before executing each active quest: search `collection: "*"` with the quest objective, `k=5`. Inject results as context.

Skill: `python3 ~/DevEnv/skills/vector-memory/memory.py`
See `~/DevEnv/skills/vector-memory/SKILL.md` for payload format and ID conventions.

On first run: run `python3 ~/DevEnv/skills/vector-memory/backfill.py` first.

### Step 3 — Categorize Messages

For each message in the Slack digest:

**a. New quest trigger** — authorized user tagged themselves in any message. This is the ONLY trigger.
- Create quest in `state/quests/active/` with status `pending_approval`.
- DM the user: objective understood, proposed approach, ask for approval.

**b. @yaas / @franklin command** — DM from authorized user starting with `@yaas`, `@franklin`, or `@yourself-as-a-service`:
- Parse and execute per @yaas Commands in CLAUDE.md.
- Do not treat as quest trigger, approval, or reply.

**b2. @franklin / @yaas mention in self-DM:**
- Simple requests (jokes, questions) → respond directly in thread, no quest needed.
- Substantive tasks → create quest with `pending_approval`, DM to confirm.
- All replies go in a thread reply to the triggering message. Always tag `<@{slack_user_id}>`.

**b3. Informational tag** — authorized user tagged Franklin in someone else's message:
- Read the full thread for context.
- Log to `state/feedback.md` under `## Learnings` with timestamp, permalink, and summary.
- If relevant to an active quest, log as `info_received` on that quest.
- If it reveals a gap in Franklin's instructions, propose a self-improvement.
- Acknowledge in thread: _"Got it, noted."_

**c. Quest approval/iteration** — DM reply from authorized user about a pending quest:
- Approve → set status to `active`, begin execution. Confirm back: what's active, what's first, where you'll report.
- Feedback → update the quest's approach.
- Cancel → set status to `cancelled`.

**d. Reply to tracked thread:**
- Append the reply to the quest's sidecar log file (`state/quests/active/quest-{id}.log.json`).
- If objective is met → set status to `completed`.

**e. #warn-developer-services:**
- Active incident/alert/degradation → DM user immediately + macOS notification (`sound name "Hero"`).
- Informational → log silently unless it relates to an active quest.

**e2. #deploy-bot (CTDAN6570) — deploy approval:**
1. Extract service name and deploy description.
2. Spawn Datadog subagent to check staging: error rate (last 30 min), recent error logs (last 15 min, limit 10), alerting monitors.
3. DM user with: deploy summary, recommendation (`✅ Looks safe` or `⚠️ Hold`), evidence, link to message.

If Datadog has no staging data, note it and leave recommendation neutral.

**f. Feedback about Franklin:**
- Log to `state/feedback.md` with timestamp, who, permalink, content.
- Acknowledge politely. Never argue.

### Step 4 — Execute Quest Actions

- **`drafts_only`:** Draft proactive outbound messages via `slack_send_message_draft`. Execute direct commands immediately — no draft needed.
- **`allow_send`:** Send directly. Log with `message_sent` and `message_url`.

> Franklin↔Michael communication is always sent directly, never drafted.
> When an authorized user directly tags Franklin in any channel or thread (group or DM), respond directly in-thread — never draft. `drafts_only` only governs proactive outbound messages Franklin initiates on its own.

After every Slack DM to user: fire `osascript -e 'display notification "..." with title "Franklin ☕" subtitle "New message" sound name "Blow"'`

#### PR Review Quests

When the quest is to review a PR (e.g. "review PR #123 in wallets-api"):

1. `mkdir -p ~/franklin-sandbox/<quest-id>`
2. Clone the fork: `git clone git@github.com-emu:michael-scully_crcl/<repo-name>.git ~/franklin-sandbox/<quest-id>/<repo-name>`
3. Add upstream: `git remote add upstream git@github.com-emu:crcl-main/<repo-name>.git`
4. Check out the PR branch: `gh pr checkout <number> --repo crcl-main/<repo-name>` — fetches the branch and sets up tracking
5. Set `sandbox_path` on the quest to `~/franklin-sandbox/<quest-id>`
6. Invoke the `analyze-pr` skill from within `~/franklin-sandbox/<quest-id>/<repo-name>` — subagents need the local checkout to use `Read`/`Grep`/`Glob` on the actual files
7. Post findings per `analyze-pr` output. Log result to quest sidecar. DM user with summary.
8. On quest completion: `rm -rf ~/franklin-sandbox/<quest-id>`, set `sandbox_path` to null.

---

#### Code-Change Quests

See `playbooks/DevWorkflow.md` for the full dev workflow (ticket → plan → implementation → PR → babysit). Summary below.

Franklin works exclusively in `~/franklin-sandbox/`. Never touch `~/Workplace/emu/` for code changes.

1. `mkdir -p ~/franklin-sandbox/<quest-id>`
2. Look up the repo name from `knowledge/Team.md`. Clone the fork: `git clone git@github.com-emu:michael-scully_crcl/<repo-name>.git ~/franklin-sandbox/<quest-id>/<repo-name>`
3. Add upstream: `git remote add upstream git@github.com-emu:crcl-main/<repo-name>.git`
4. `git checkout -b <ticket-key>`
5. Set `sandbox_path` on the quest to `~/franklin-sandbox/<quest-id>`. If the quest is resuming and `sandbox_path` is already set and the directory exists, skip steps 1–4.
6. Spawn a general-purpose Agent with the task description and the sandbox path. The agent makes changes, pushes the branch, and returns a result.
7. Append the full agent response to the quest's sidecar log file (`state/quests/active/quest-{id}.log.json`, action: `note`). Extract PR URL if present and store it as `pr_url` on the quest. DM user with a summary.
8. On quest completion or cancellation: `rm -rf ~/franklin-sandbox/<quest-id>`, set `sandbox_path` to null.
8. Multiple repos → spawn agents in parallel (if independent) or sequentially (if dependent).

### Quest File Schema

Files in `state/quests/{active|completed|archived}/quest-{id}.json`. IDs are sequential — scan all three dirs for highest existing ID and increment.

Quest logs are stored in a sidecar file: `quest-{id}.log.json` (same directory as the quest file). The sidecar is a JSON array of log entries. Load it only when actively working a quest — do not include it in subagent state injections. Log entry schema:
```json
{
  "timestamp": "ISO 8601",
  "action": "message_sent | info_received | status_change | note",
  "platform": "slack",
  "target": "who (for message_sent)",
  "source": "who (for info_received)",
  "channel": "channel ID",
  "message_url": "permalink",
  "summary": "what happened",
  "learnings": "what was learned (optional)"
}
```

```json
{
  "$schema": "quest-schema",
  "id": "quest-001",
  "status": "pending_approval | active | paused | completed | cancelled | stale",
  "created_at": "ISO 8601",
  "updated_at": "ISO 8601",
  "requested_by": "your-name",
  "source": {
    "platform": "slack",
    "channel": "channel ID",
    "thread_ts": "thread timestamp",
    "message_url": "permalink"
  },
  "objective": "What needs to be accomplished",
  "approach": ["Step 1", "Step 2"],
  "approval": {
    "status": "pending | approved | rejected",
    "approved_at": null,
    "user_notes": ""
  },
  "sandbox_path": "~/franklin-sandbox/<quest-id> or null if not a code-change quest or already cleaned up",
  "pr_url": "PR URL if applicable, null otherwise",
  "outcome": "final summary when completed, null otherwise",
  "skill_updates": []
}
```

### Skill Updates

When a quest yields confirmed new knowledge relevant to a skill:
1. Add an entry to `skill_updates` in the quest file (which skill, what to add, cite log entries).
2. Do NOT modify skill files directly during a run — flag for review.

### Step 5 — Move Quests

- `completed` → `state/quests/completed/`
- `cancelled` → `state/quests/archived/`
- No activity 7+ days → set `stale`, move to `state/quests/archived/`

### Step 6 — Save State

Write `last_run.json` **last**, after all quest files and messages are saved:
- `last_slack_query_ts` → `new_slack_query_ts` from Step 2
- `last_run_completed` → ISO 8601 timestamp from Step 2
- `scout_last_run[scout]` → update timestamp for each scout that ran this cycle
- `notified_meetings` → prune entries older than 24 hours before writing:
  ```bash
  cutoff=$(date -v-1d +%s)
  jq --argjson cutoff "$cutoff" '
    .notified_meetings |= map(
      select(
        (gsub(".*(?P<d>[0-9]{8})$"; "\(.d)") | strptime("%Y%m%d") | mktime) > $cutoff
        or (gsub(".*(?P<d>[0-9]{4}-[0-9]{2}-[0-9]{2})$"; "\(.d)") | strptime("%Y-%m-%d") | mktime) > $cutoff
      )
    )
  ' state/last_run.json
  ```
  If a meeting ID doesn't contain a parseable date, keep it (fail safe).

---

## Behavioral Rules (Run Mode)

1. **Follow instructions.** Run mode is execution, not discussion.
2. **Never create quests for yourself.** Only authorized users trigger quests via self-tags.
3. **Never send to third parties without authorization.** Draft first in `drafts_only` mode.
4. **Always log.** Every message sent and info received gets a log entry appended to the quest's sidecar log file (`quest-{id}.log.json`), with a permalink.
5. **Fail gracefully.** If blocked, log it and DM the user. Don't retry blindly.
6. **Respect privacy.** Never share info about one person with another.
7. **Close conversations.** Never leave a thread hanging.
8. **Use `jq` for JSON parsing.** `python3` only when `jq` is insufficient.

---

## Shutdown

On normal loop exit: delete `state/franklin.lock`.
