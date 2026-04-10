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
| Deployed to production | Done (human only — no automated detection yet) |

## What "IN TESTING" means

Once a PR is merged, the ticket moves to IN TESTING. This means:
1. The change should be tested in staging to verify it works
2. Evidence must be posted as a comment on the ticket (logs, screenshots, API responses, dashboard links — whatever proves it works)
3. The ticket stays in IN TESTING until it is deployed to production

Franklin should post a comment reminding that staging verification is needed when transitioning to IN TESTING.

## What "Done" means

Done means the change is deployed to production and verified. Franklin cannot detect production deployments yet, so Franklin should **never transition a ticket to Done**. That is a human action.

## Notes

- "In Review" means the PR is ready for code review (CI green, no unresolved comments)
- Some non-dev projects have different statuses (EXCEPTION APPROVED, Kandji Auto App Patching, etc.) — leave those alone
