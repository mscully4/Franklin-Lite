# Ticket Lifecycle Audit

Periodic cross-reference of Jira tickets against GitHub, ArgoCD, and Datadog. Detects stale tickets and advances them with evidence.

---

## Phase 1 — Build the ticket map

Load data from scout results and build a map of active tickets to their PR and deployment status.

### 1a. Load Jira tickets

Read `state/scout_results/jira.json`. Collect all tickets in active statuses: **In Progress**, **In Review**, **IN TESTING**.

Skip non-DEV tickets and tickets with statuses outside these three.

### 1b. Load GitHub PRs

Read `state/scout_results/github.json`. For each `pr_authored` entry, note:
- `jira_key` from `entry.raw.jira_key`
- PR number, repo, URL
- CI status (`ci_failing`, `mergeable_state`, `approved`)
- Whether the PR is merged (check `entry.raw.state === "closed"` and `entry.raw.merged === true`)

Also check `my_activity` entries for `activity_type: "pr_merged"` — these confirm merges even if the PR is no longer in the authored list.

### 1c. Match tickets to PRs

For each Jira ticket, find its PR by matching the Jira key (e.g., `DEV-1234`) against PR titles and `jira_key` fields. A ticket may have zero or one matching PR.

Build the map:
```
DEV-1234:
  jira_status: "In Review"
  pr: { number: 1127, repo: "crcl-main/platform-notifications", merged: true, ci_green: true }
  service: "platform-notifications"  (from repo name)
```

If no PR is found for a ticket, note it — it may be idle.

---

## Phase 2 — Detect mismatches and take action

For each ticket, apply the first matching rule:

| Jira Status | Condition | Action |
|---|---|---|
| In Progress | PR exists, open, CI green, no changes requested | Transition to **In Review** |
| In Progress | PR merged | Transition to **IN TESTING** + merge comment |
| In Review | PR merged | Transition to **IN TESTING** + merge comment |
| In Review | PR closed without merge | Transition to **In Progress** + comment "PR closed without merge" |
| IN TESTING | Needs staging verification | Go to **Phase 3** |
| IN TESTING | Already has staging evidence (Franklin comment exists) | Go to **Phase 4** (check prod) |
| Any active | No PR and no Jira comment activity in 5+ days | Flag as idle |

### Transition mechanics

Use the `jira-ticket` skill (read `~/DevEnv/skills/jira-ticket/SKILL.md`) to:
1. Transition the ticket status
2. Post a comment with evidence of why the transition happened

**Merge comment template:**
```
PR #{number} ({repo}) was merged. Moving to IN TESTING.

Staging verification is needed before this can move to Done.
Please check that the changes are working correctly in staging and post evidence (logs, screenshots, API responses, Datadog links).
```

### Idle ticket handling

If a ticket has been in an active status with no PR and no Jira comment activity for 5+ days, DM the user:
```
DEV-1234 ({summary}) has been in {status} for {N} days with no PR or recent activity. Want me to do something with it?
```

Do not transition idle tickets — just flag them.

### Deduplication — prior findings

Before DMing or posting comments, read `state/lifecycle_last_flags.json`. This file tracks what was already reported and when:

```json
{
  "DEV-1234": { "flag": "idle", "at": "2026-04-16T22:13:00Z" },
  "DEV-5678": { "flag": "prod_needs_review", "at": "2026-04-16T23:00:00Z" }
}
```

**Rules:**
- If a ticket already has an entry with the **same flag** and the entry is **< 24 hours old**, skip it — do not DM or comment again.
- If the **situation changed** (e.g., was `idle` but now has a PR, or was `prod_needs_review` but now prod is unhealthy), update the entry and report normally.
- After reporting a new finding, upsert the entry with the current timestamp.
- When a ticket is transitioned (e.g., to Done), remove its entry.
- If the file doesn't exist, create it. Keep only tickets that are still in active statuses — prune resolved entries each run.

---

## Phase 3 — Staging verification (IN TESTING tickets)

For each IN TESTING ticket that has a merged PR but no staging verification comment from Franklin:

### 3a. Check ArgoCD staging

Use the `argocd-cli` skill (read `~/DevEnv/skills/argocd-cli/SKILL.md`) to find the staging app for this service. Don't assume a naming convention — search for the service name and filter for staging/stg environments.

Check:
- Is the app synced and healthy?
- What revision is deployed?

### 3b. Check Datadog staging health

Query Datadog for the service in the staging environment (last 30 minutes):

1. **Error rate:**
   ```
   search_datadog_logs: query="service:<service> status:error env:(staging OR stg)", from="now-30m"
   ```

2. **Latency:**
   ```
   get_datadog_metric: queries=["avg:<service>.request.duration{env:staging}"], from="now-30m"
   ```
   (Adjust metric name based on the service — use `search_datadog_metrics` if unsure.)

3. **Alerting monitors:**
   ```
   search_datadog_monitors: query="env:staging <service>"
   ```

### 3c. Post evidence

If staging is healthy (synced, no error spikes, no alerting monitors), post a Jira comment:

```
**Staging verification (automated)**

ArgoCD: {app_name} is Synced and Healthy (revision: {rev})
Datadog: No error spikes in last 30m. {N} errors total (baseline).
Monitors: No alerts.

Changes appear healthy in staging.
```

If unhealthy or degraded, post the findings but do **not** transition. DM the user with concerns.

---

## Phase 4 — Production verification (IN TESTING tickets with staging evidence)

For IN TESTING tickets that already have staging evidence, check if they've been deployed to production.

### 4a. Check ArgoCD production

Use the `argocd-cli` skill to find the production app for this service. Check:
- Is the app synced and healthy?
- Is the deployed revision at or after the merge commit?

If prod is not yet deployed (revision doesn't include the changes), skip — the ticket stays IN TESTING.

### 4b. Assess risk

Determine risk level from the PR:

```bash
gh pr view <number> --repo <repo> --json files,additions,deletions,labels,title
```

**Low risk** (auto-Done eligible):
- Total changes < 50 lines
- Only config files, test files, documentation, dependency bumps
- Labels include "patch", "config", "deps", "docs"
- No files in auth, payment, migration, or schema paths

**High risk** (human review required):
- Migrations (files matching `**/migration/**`, `**/flyway/**`, `**/db/**`)
- Auth/permission changes (files matching `**/auth/**`, `**/permission/**`, `**/security/**`)
- Payment flow changes (files matching `**/payment/**`, `**/payout/**`, `**/transaction/**`)
- New API endpoints (new controller/handler files or route definitions)
- Large changes (> 200 lines)

### 4c. Check Datadog production health

Same checks as Phase 3 but for production environment (`env:production` or `env:prod`).

### 4d. Decide and act

| Risk | Prod Healthy 30+ min | Action |
|------|---------------------|--------|
| Low | Yes | Transition to **Done** + evidence comment |
| Low | No or < 30 min | Post evidence, DM user for review |
| High | Yes | Post evidence, DM user: "Ready for you to mark Done" |
| High | No | Post evidence, DM user with health concerns |

**Done comment template:**
```
**Production verification (automated)**

ArgoCD: {app_name} is Synced and Healthy (revision: {rev})
Datadog: No error spikes in production (last 30m). Latency normal.
Risk: Low ({reason}).

Auto-closing — changes verified in production.
```

---

## Phase 5 — Summary

DM the user with a summary of all actions taken this audit cycle:

```
**Ticket Lifecycle Audit**

Transitioned:
- DEV-1234: In Review -> IN TESTING (PR #1127 merged)
- DEV-5678: IN TESTING -> Done (prod healthy, low risk)

Verified staging:
- DEV-9012: Staging healthy, evidence posted

Needs attention:
- DEV-3456: Prod deployed but high risk — needs your review
- DEV-7890: Idle 7 days in In Progress, no PR

No issues: 3 tickets in expected state
```

Only DM if there were **new** actions taken or **new** issues found (not previously flagged within 24h). Skip the DM if everything is clean or already reported.
