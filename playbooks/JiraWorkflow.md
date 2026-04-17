# Jira Workflow — DEV Board

## Lanes (in order)

Backlog → In Progress → In Review → IN TESTING → Done

## Transition Rules for Franklin

| Event | Target Status |
|-------|--------------|
| Franklin starts working on a ticket (quest created) | In Progress |
| PR created AND CI is green | In Review |
| PR created BUT CI is failing | Stay In Progress — fix CI first |
| PR CI fixed / comments addressed, PR back to reviewable state | In Review |
| PR merged | IN TESTING |
| Verified in staging with evidence | Stay IN TESTING — post evidence comment |
| Deployed to production + healthy + low risk | Done (automated via ticket lifecycle audit) |
| Deployed to production + high risk | Stay IN TESTING — post evidence, DM user |

## What "IN TESTING" means

Once a PR is merged, the ticket moves to IN TESTING. This means:
1. The change should be tested in staging to verify it works
2. Evidence must be posted as a comment on the ticket (logs, screenshots, API responses, dashboard links — whatever proves it works)
3. The ticket stays in IN TESTING until it is deployed to production

Franklin should post a comment reminding that staging verification is needed when transitioning to IN TESTING.

## What "Done" means

Done means the change is deployed to production and verified. Franklin can auto-Done **low-risk** tickets when production deployment is confirmed healthy. High-risk tickets get evidence posted but require human confirmation.

### Auto-Done criteria

Franklin may transition to Done when **all** of these are true:
1. ArgoCD shows the production app is Synced and Healthy with a revision containing the changes
2. Datadog shows no error spikes and normal latency in production for 30+ minutes
3. The change is **low risk**

### Risk assessment

**Low risk** (auto-Done eligible):
- Total PR changes < 50 lines
- Only config files, test files, documentation, dependency bumps
- PR labels include "patch", "config", "deps", "docs"
- No files in auth, payment, migration, or schema paths

**High risk** (human review required):
- Database migrations (`**/migration/**`, `**/flyway/**`, `**/db/**`)
- Auth/permission changes (`**/auth/**`, `**/permission/**`, `**/security/**`)
- Payment flow changes (`**/payment/**`, `**/payout/**`, `**/transaction/**`)
- New API endpoints (new controller/handler files)
- Large changes (> 200 lines)

For high-risk tickets, Franklin posts production evidence and DMs the user to review, but does not transition.

## Notes

- "In Review" means the PR is ready for code review (CI green, no unresolved comments)
- Some non-dev projects have different statuses (EXCEPTION APPROVED, Kandji Auto App Patching, etc.) — leave those alone
- The ticket lifecycle audit (`playbooks/TicketLifecycleAudit.md`) runs every 30 minutes and catches tickets that fall through the cracks
