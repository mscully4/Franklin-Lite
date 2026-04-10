# Franklin — Dev Workflow

This document describes how Franklin handles end-to-end development tasks: from ticket creation through a merged PR.

---

## Existing PR

When a quest references an existing PR (e.g. fix CI, address review feedback, continue someone else's work):

1. Resolve the repo name and PR number from the quest or Slack context
2. Clone the fork into the sandbox as normal: `git clone git@github.com-emu:michael-scully_crcl/<repo>.git ~/franklin-sandbox/<quest-id>/<repo>`
3. Add upstream: `git remote add upstream git@github.com-emu:crcl-main/<repo>.git`
4. Check out the PR branch: `gh pr checkout <number>` — this fetches the branch and sets up tracking automatically
5. Set `sandbox_path` on the quest, store `pr_url`
6. Proceed from **Phase 3 (Implement)** — skip ticket creation and planning unless the task warrants it
7. Push fixes to the existing branch; `babysit-pr` picks up from there

If the PR is from a fork you don't own, use `gh pr checkout <number>` — it handles the remote fetch automatically.

---

## Phases

### 1. Ticket

If no Jira ticket exists, create one using the `jira-ticket` skill. Set status to `In Progress`.

If a ticket already exists, transition it to `In Progress`.

Store the ticket key on the quest (`source.ticket_key`).

---

### 2. Planning

Spawn a general-purpose agent to:
- Read the ticket description and acceptance criteria
- Explore the relevant codebase in `~/franklin-sandbox/<quest-id>/<repo-name>`
- Identify any ambiguities, missing context, or decision points that could block implementation
- Return a plan **and** any open questions as structured output

If the agent returns open questions, Franklin:
1. DMs Michael with the questions
2. Sets quest status to `awaiting_clarification`
3. On next loop, when Michael replies, logs the answers on the quest and spawns a **new** planning agent with the original context plus the Q&A included verbatim
4. The second agent produces the finalized plan

If there are no open questions, proceed directly to the plan.

Return the plan to the main loop. Log it on the quest. In `drafts_only` mode, DM Michael with the plan and wait for approval before proceeding. In `allow_send` mode, proceed directly.

---

### 3. Implementation

Spawn a general-purpose agent in the sandbox:

```
~/franklin-sandbox/<quest-id>/<repo-name>
```

The agent:
- Follows the approved plan
- Makes code changes
- Writes or updates tests
- Does not commit to the default branch
- Returns a summary of what changed

Log the full agent response to the quest log.

---

### 4. PR Creation

Before creating the PR, run a local SonarQube scan using the `sonar-scan` skill:
- If issues are found at BLOCKER or HIGH severity, fix them (use `--fix` flag) and re-scan before proceeding.
- MEDIUM and below: fix if straightforward, otherwise proceed and let `babysit-pr` handle them via CI.

Invoke the `create-pr` skill to push the branch and open a PR against `crcl-main/<repo-name>`. The PR description must always end with `Created by Franklin :whiskey::raccoon:`.

Optionally run `analyze-pr` first to self-review before the PR goes up — catches obvious issues before CI runs.

Once the PR is created:
- Store `pr_url` on the quest
- Post a comment on the Jira ticket via `update-ticket-after-pr` (CI status, changed files, Datadog signals)
- If CI is green: transition ticket to `In Review`
- If CI is failing: keep ticket in `In Progress` until CI passes
- DM Michael with the PR URL

See `knowledge/jira_workflow.md` for the full transition rules. Never transition to Done.

---

### 5. CI + Review (babysit-pr) — MANDATORY

**A quest that creates a PR is NOT complete until CI is green and the PR is reviewable.** Do not skip this phase. Do not exit the quest after Phase 4.

Invoke `babysit-pr` with the PR number. This skill runs autonomously until the PR is green:

- Polls CI checks, fixes failures, pushes fixes
- Reads review comments, addresses or pushes back, pushes fixes
- Resolves SonarQube issues
- Notifies reviewers via Slack when ready

Franklin does not need to do anything during this phase — `babysit-pr` handles it. When `babysit-pr` exits (PR green, all comments resolved), DM Michael that the PR is ready to merge.

**Exit criteria:** The quest moves to Phase 6 (Cleanup) only after `babysit-pr` confirms all CI checks pass and review comments are resolved. If `babysit-pr` cannot resolve a failure, DM Michael — do not silently close the quest.

---

### 6. Cleanup

On quest completion:
- `rm -rf ~/franklin-sandbox/<quest-id>`
- Set `sandbox_path` to null on the quest
- Move quest file to `state/quests/completed/`

---

## Skills Used

| Phase | Skill |
|---|---|
| Ticket | `jira-ticket` |
| Pre-PR Sonar scan | `sonar-scan` |
| PR creation | `create-pr` |
| Pre-PR review | `analyze-pr` |
| Post-PR Jira update | `update-ticket-after-pr` |
| CI + review loop | `babysit-pr` |

---

## Clarification Rule

At **any phase**, if a decision point is ambiguous or would meaningfully change the approach, pause and DM Michael rather than guessing. Up-front questions during planning are preferred — once implementation is underway, interruptions are more disruptive. But a mid-implementation question is always better than a wrong assumption. Examples:

- "This change touches both `entitlement-service` and `developer-dashboard-service` — should I update both, or just the one mentioned in the ticket?"
- "The ticket says 'update the endpoint' but there are two candidates. Which one did you mean?"
- "I found an existing test suite for this path, but the tests are broken. Fix them, skip them, or flag for a follow-up ticket?"

Always cite what you found (file, line, or observation) so Michael has enough context to answer quickly.

---

## Notes

- All code work happens in `~/franklin-sandbox/<quest-id>/` — never in `~/Workplace/emu/`
- If the quest is paused mid-implementation, the sandbox directory persists. Resume by checking `sandbox_path` on the quest and skipping the clone step
- Multiple repos: spawn implementation agents in parallel (if independent) or sequentially (if dependent); run `babysit-pr` per repo
- Always use `git@github.com-emu:michael-scully_crcl/<repo>.git` as origin and `git@github.com-emu:crcl-main/<repo>.git` as upstream
