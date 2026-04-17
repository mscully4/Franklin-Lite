# PR Monitor Playbook

Your job is to **get the PR back to a reviewable state**. The task context tells you exactly what needs fixing — read the `objective` field.

---

## Workflow

1. Read the task context for `repo`, `number`, `ci_failing`, `changes_requested`, `review_comments`, `mergeable_state`, and `objective`.

2. **For CI failures:** invoke the `babysit-pr` skill with the PR number. It will analyze CI logs, make fixes, and push. If babysit-pr can't fix it, DM the user with the failure details.

3. **For review comments / changes requested:** You must address **every single comment** on the PR — do not leave any unresolved.
   - First, fetch ALL review comments and review threads using the GitHub MCP tools or `gh api`.
   - Work through them one by one. For each comment:
     - If it's a code change request: make the fix, commit, and reply to the comment confirming what was changed.
     - If it's a question: reply with the answer on GitHub.
     - If it's a style/naming suggestion: apply it, reply confirming.
     - If you genuinely disagree or the request conflicts with other requirements: reply explaining why and DM the user for a decision. Do not silently skip it.
   - After addressing all comments, push all changes in a single push.
   - **Verify nothing was missed:** re-read the comment list after pushing and confirm every thread has a response.

4. **For merge conflicts** (`mergeable_state: "dirty"`): clone the repo, check out the PR branch, merge the base branch, resolve conflicts, commit, push.

5. **For ready-to-merge notifications** (`approved: true`, CI green, clean): DM the user that the PR is ready to merge. Include the PR URL. **Never merge automatically** — merging requires human approval.

6. **Update the Jira ticket** if `jira_key` is present in the task context (see `playbooks/JiraWorkflow.md` for full workflow):
   - Post a comment summarizing what was fixed (e.g. "Fixed CI lint failure, addressed 3 review comments, rebased on main").
   - Transition the ticket based on the PR's final state after your fixes:
     - CI green + no unresolved comments → `In Review`
     - CI still failing (you couldn't fix it) → keep in `In Progress`
     - PR approved + CI green + mergeable → `In Review` (note in comment: "ready to merge")
     - PR merged → `IN TESTING`
   - **Never transition to Done** — that requires human verification.
   - Use the `update-ticket-after-pr` skill or the `jira-ticket` skill for transitions.
   - If no `jira_key`, skip ticket updates silently.

7. After finishing, **DM the user** with a brief summary of what was fixed/addressed. List each comment that was resolved.

---

## Important

A single pr_monitor task may have multiple issues (CI + comments). Handle all of them in one pass. Never leave a comment unaddressed — every reviewer comment deserves either a code change or a reply.
