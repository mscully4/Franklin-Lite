---
id: proposal-00012
title: Automated Jira Ticket Lifecycle
status: implemented
implemented_at: 2026-04-16
created: 2026-04-16
updated: 2026-04-16
---

## Problem

Tickets get stuck because no single component owns the full lifecycle. The scouts collect data independently — Jira knows ticket status, GitHub knows PR status, ArgoCD knows deployment status, Datadog knows service health — but nothing cross-references them.

Common failures:

1. **PR merged, ticket stuck in "In Review"** — the GitHub scout collects `pr_merged` activity events, but `filter-signals.ts` never surfaces them to the brain. The brain's Step 4d logic to emit `jira_update` tasks for merged PRs has never fired.

2. **Ticket in "IN TESTING", nobody verifies staging** — ticket lands in IN TESTING after a merge, but nobody checks ArgoCD to confirm the code is deployed or Datadog to confirm it's healthy. Ticket sits until a human remembers.

3. **Code deployed to prod, ticket stuck in "IN TESTING"** — changes ship to production but the ticket never moves to Done because no automation connects ArgoCD prod deployment status to Jira.

4. **Idle tickets** — a ticket has been "In Progress" for a week with no commits, no PR, no comments. Nobody notices.

## Solution

Two-part fix: an immediate event-driven patch plus a periodic cross-referencing audit.

### Part 1: Surface PR merge events (event-driven)

Add `my_activity` handling to `src/filter-signals.ts` so `pr_merged` events reach the brain via `signals.json`. The brain's existing Step 4d already knows how to emit `jira_update` tasks for merged PRs — it just never receives the signal.

This fixes the most common stuck-ticket scenario (merged PR + stale ticket) within one cycle.

### Part 2: Scheduled ticket lifecycle audit (cross-referencing)

A scheduled task that runs every 30 minutes on weekdays, spawning a quest to audit all active tickets against GitHub, ArgoCD, and Datadog.

This catches everything event-driven signals miss: merges during downtime, deployments between cycles, tickets stuck for days, ArgoCD deployments that complete minutes after the cycle.

## Design

### Part 1: filter-signals.ts change

Add a block after the `review_request` handling (~line 109):

```typescript
} else if (entry.type === "my_activity") {
  const activityType = entry.raw.activity_type as string | undefined;
  if (activityType === "pr_merged") {
    const current = { merged: true };
    const row = db.getSurfaced(entry.id);
    if (!row?.last_surfaced_at) {
      signals.push({ id: entry.id, source: "github", is_new: true, previous_state: {}, current_state: current, entry });
    }
  }
}
```

PR merge events surface once (like Gmail) — once surfaced, never re-fire.

### Part 2: Ticket lifecycle audit

#### Scheduled task

```json
{
  "id": "ticket-lifecycle-audit",
  "every": "30m",
  "type": "scheduled",
  "priority": "normal",
  "display_description": "Audit ticket lifecycle across Jira/GitHub/ArgoCD",
  "context": {
    "objective": "Read playbooks/TicketLifecycleAudit.md and execute."
  }
}
```

#### Playbook: `playbooks/TicketLifecycleAudit.md`

The quest agent follows these phases:

**Phase 1 — Build the ticket map**

Load `state/scout_results/jira.json` and `state/scout_results/github.json`. For each active DEV ticket (In Progress, In Review, IN TESTING), find its matching PR by Jira key (from PR title or `jira_key` field).

Build a map:
```
DEV-1234:
  jira_status: "In Review"
  pr_number: 1127
  pr_repo: "crcl-main/platform-notifications"
  pr_merged: true
  pr_merged_at: "2026-04-15T..."
  pr_ci_status: "green"
  service: "platform-notifications"
```

**Phase 2 — Detect mismatches**

| Jira Status | Condition | Action |
|---|---|---|
| In Progress | PR open + CI green | Transition → In Review |
| In Progress | PR merged | Transition → IN TESTING |
| In Review | PR merged | Transition → IN TESTING + comment with merge info |
| In Review | PR closed (not merged) | Transition → In Progress + comment "PR closed without merge" |
| IN TESTING | Need staging verification | → Phase 3 |
| IN TESTING | Need prod verification | → Phase 4 |
| Any active | No PR, no Jira activity for 5+ days | DM user: "DEV-1234 idle" |

**Phase 3 — Staging verification (for IN TESTING tickets)**

Use `argocd-cli` skill to check `stg-pay-<service>-us-east-1`:
- Is the app synced and healthy?
- Does the deployed revision match the merge commit?

Use Datadog MCP tools to check staging health:
- Error rate for the service in `env:staging` (last 30 min)
- Any alerting monitors for the service?

If healthy for 30+ min, post a Jira comment with:
- ArgoCD staging status (revision, sync state, health)
- Datadog error rate + latency
- "Staging verified by Franklin — changes appear healthy"

**Phase 4 — Production verification (for IN TESTING tickets with staging evidence)**

Use `argocd-cli` skill to check `prod-pay-<service>-us-east-1`:
- Is the app deployed with a revision at or after the merge commit?

If yes, assess risk and decide:

**Risk assessment:**
- **Low risk** (auto-Done eligible): config changes, dependency bumps, test-only changes, small fixes (<50 lines), documentation
- **High risk** (human review): migrations, auth/permission changes, payment flow changes, new API endpoints, large refactors (>200 lines)
- Inferred from: PR diff size, file paths touched, PR labels, PR title keywords

| Risk | Prod Health | Action |
|---|---|---|
| Low | Healthy 30+ min | Transition → Done + evidence comment |
| Low | Unhealthy or <30 min | Post evidence, flag for human review |
| High | Healthy | Post evidence + DM user: "Ready for you to mark Done" |
| High | Unhealthy | Post evidence + DM user with health concerns |

**Phase 5 — Report**

DM user with summary of all actions taken:
- Tickets transitioned (with reasons)
- Staging/prod verification results
- Idle tickets flagged
- Any tickets that need human attention

### Updates to existing files

**`playbooks/JiraWorkflow.md`** — add auto-Done criteria:
- Define what constitutes low-risk vs high-risk changes
- Document that Franklin can auto-Done low-risk tickets with prod evidence
- Document that high-risk tickets get evidence posted but require human Done

**`modes/worker_wrapper.md`** — add to playbook table:
```
| `TicketLifecycleAudit.md` | Scheduled audit: cross-reference Jira/GitHub/ArgoCD/Datadog |
```

## Changes Required

| File | Change |
|------|--------|
| `src/filter-signals.ts` | Add `my_activity` handling for `pr_merged` |
| `playbooks/TicketLifecycleAudit.md` (new) | Full audit playbook |
| `playbooks/JiraWorkflow.md` | Add auto-Done criteria and risk rules |
| `modes/worker_wrapper.md` | Add playbook to table |
| `state/scheduled_tasks.json` | Add `ticket-lifecycle-audit` entry |

## Decisions

- **Scouts stay dumb.** Cross-referencing is the audit quest's job, not the scouts'. Scouts collect, quests reason.
- **Event-driven + periodic.** Part 1 catches merges in real-time. Part 2 catches everything else every 30 min. Belt and suspenders.
- **Auto-Done is opt-in by risk.** Low-risk + healthy prod = auto. High-risk = evidence + human gate. Moving a ticket back is cheap, so err toward automation.
- **30-minute interval.** Frequent enough to feel responsive, infrequent enough to not spam. Each audit run should complete in 5-10 min.

## References

- `src/filter-signals.ts` — signal surfacing (the gap)
- `src/scouts/github.ts` — `my_activity` entries (line 355-409)
- `src/scouts/jira.ts` — ticket data collection
- `playbooks/JiraWorkflow.md` — current transition rules
- `playbooks/DeployApproval.md` — Datadog verification patterns (reusable)
- `~/DevEnv/skills/argocd-cli/SKILL.md` — ArgoCD deployment checking
