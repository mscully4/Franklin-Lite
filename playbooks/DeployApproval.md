# Deploy Approval Playbook

When a deploy approval is requested in `#deploy-bot` and the owner is tagged, Franklin verifies the deploy is safe and DMs a recommendation with evidence.

---

## Phase 0 — Check for prior review

Before doing any work, read the deploy-bot thread to check if Franklin has already posted a review:

```
npx tsx src/scripts/slack_conversations.ts thread CTDAN6570 <thread_ts> --json
```

If a prior Franklin review exists in the thread:
- Extract its recommendation (`Looks safe`, `Hold`, `Insufficient data`) and the commit SHA it reviewed.
- Compare the SHA against the current deploy SHA. If it's the **same SHA and same recommendation**, skip all remaining phases — do not re-post, do not DM. Exit silently.
- If the SHA changed or the recommendation would change based on new data, continue and use `is_refresh: true` in Phase 5 so the post is prefixed "🔄 Updated review".

---

## Phase 1 — Extract change info

Parse the deploy-bot message to identify what's being deployed, then isolate the owner's changes.

1. Extract the service name (should be in quest context as `service`)
2. Extract PR number or commit SHA from the message text — deploy-bot typically includes a link or ref
3. If a PR number is found:
   ```
   gh pr view <number> --repo crcl-main/<service> --json title,body,commits,files
   ```
4. If only a commit range or SHA:
   ```
   gh api repos/crcl-main/<service>/compare/<base>...<head> --jq '.commits[] | {sha: .sha, message: .commit.message, author: .author.login}'
   ```
5. If neither can be extracted, note the gap and proceed to Phase 2 with generic checks only

### 1b. Isolate the owner's commits

Filter the commit list to those authored by the owner (the person tagged for approval). Use their GitHub username from `state/settings.json` → `github_username`.

```
gh api repos/crcl-main/<service>/compare/<base>...<head> \
  --jq '.commits[] | select(.author.login == "<github_username>") | {sha: .sha, message: .commit.message}'
```

For each of the owner's commits, pull the diff to understand the functional changes:

```
gh api repos/crcl-main/<service>/commits/<sha> --jq '.files[] | {filename, patch}'
```

### 1c. Characterize each change

For each commit, identify:

- **What changed:** new/modified logic branches, updated conditions, added endpoints, changed calculations
- **Expected observable behavior:** what log messages, metric changes, or API responses should appear if this code is running correctly
- **Risk surface:** is this a new code path, a modification to an existing one, a config change, a migration

**Output:** list of the owner's commits with diffs, a description of each functional change, and a set of **validation targets** — specific log patterns, metric signals, or resource names to look for in Phase 3.

---

## Phase 2 — Query prior deploy knowledge

Before checking Datadog, query vector memory for learnings from past deploys of this service:

```bash
echo '{"op":"query","collection":"*","text":"deploy <service> staging health baseline","k":5}' \
  | python3 ~/DevEnv/skills/vector-memory/memory.py
```

Look for: error rate baselines, known flaky signals to ignore, env tag conventions (`env:staging` vs `env:stg`), service-specific endpoints to watch, past incidents during deploys. Factor anything relevant (distance < 0.3) into your Datadog checks below.

---

## Phase 3 — Datadog staging health

**Before querying:** Run a quick probe to confirm Datadog is accessible:

```
search_datadog_monitors(query="", max_tokens=100)
```

If this call fails (auth error, MCP token expired, connection refused), **abort the entire review** — do not post to the thread, do not DM the owner. Exit silently. The deploy-bot thread will show no reply; this is intentional.

Query Datadog for the service's staging environment. All queries should target `env:staging` (or `env:stg` — check vector memory results or service notes for which tag applies).

### 3a. Error rate (last 30 minutes)

```
service:<service> env:staging status:error
```

Use `search_datadog_logs` to sample recent errors. Use `analyze_datadog_logs` to count errors grouped by status:

```sql
SELECT status, count(*) FROM logs GROUP BY status
```

Flag if error count is elevated compared to the prior 30-minute window.

### 3b. Latency (last 30 minutes)

Query APM spans for the service:

```
service:<service> env:staging
```

Use `aggregate_spans` to get p50/p99 duration. Compare against baseline if available.

### 3c. Alerting monitors

Use `search_datadog_monitors` filtered to the service name. Flag any monitors in `Alert` or `Warn` state.

### 3d. Functional validation (critical — requires Phase 1c output)

This is the most important check. The absence of errors does **not** mean a change is working — it may mean the new code path is never being reached. For each validation target from Phase 1c:

**Positive signal checks:**

- Search logs for messages that indicate the new/modified code path is actually executing. Look for log lines that would only appear if the new logic branch is hit (e.g., new log statements added in the diff, messages from functions that were modified).
  ```
  service:<service> env:staging "<log pattern from diff>"
  ```
- If an existing logic branch was changed (e.g., a condition was updated), look for logs from **both** the old and new behavior. If only the old pattern appears, the new code may not be deployed yet or not being reached.
- If new endpoints or routes were added, search spans for those `resource_name` values — they should show traffic if the endpoint is live.
- If a calculation or return value changed, check for downstream effects (API response patterns, metric values shifting).

**Negative signal checks:**

- Search for errors specifically on the changed code paths, not just service-wide errors
- If DB migrations are in the changeset, check for DB-related errors
- If error handling was modified, verify the new error paths aren't firing unexpectedly

**No-traffic detection:**

- If a changed code path shows **zero** log lines or spans in staging, flag this explicitly. Possible causes:
  - Deploy hasn't propagated yet
  - The code path requires specific input to trigger
  - The change is behind a feature flag that isn't enabled in staging
  - Something is wrong

Report each validation target as one of:
| Status | Meaning |
|---|---|
| **Verified** | Positive log/metric evidence that the change is executing correctly |
| **No errors but unverified** | No failures, but no positive evidence the code path is being hit |
| **Errors detected** | The changed code path is producing errors |
| **No traffic** | Zero signals for this code path — cannot validate |

---

## Phase 4 — Decision

Classify the deploy into one of four recommendations:

| Recommendation | Criteria |
|---|---|
| **Looks safe — verified** | All validation targets show positive evidence of correct execution, no elevated errors, latency normal, no alerting monitors |
| **Looks safe — unverified** | No errors or concerning signals, but one or more changes lack positive evidence of execution. Flag which changes couldn't be validated and why. |
| **Hold — concerns found** | Errors on changed code paths, latency spike, alerting monitors, or high-risk changes (migrations, auth, payments) with no positive signals |
| **Insufficient data** | No staging traffic for the service, change info couldn't be extracted, or all validation targets show "no traffic" |

The key distinction: **"no errors" is not the same as "working."** Always prefer evidence of correct behavior over absence of failure.

---

## Phase 5 — Post results

Post in two places: a thread reply in `#deploy-bot` (so the requester and team can see it) and a DM to the owner.

### 5a. Thread reply in #deploy-bot

Reply to the original deploy-bot message using its `message_url` timestamp as `thread_ts`. Extract the channel and timestamp from the quest context's `message_url` (format: `https://circlefin.slack.com/archives/CTDAN6570/p<ts_without_dot>`).

If `is_refresh` is true, prefix the message with "🔄 **Updated review**" instead of "🔍 **Deploy review**".

Post a concise summary:

```
🔍 Deploy review: <service>

**Recommendation:** <Looks safe — verified / Looks safe — unverified / Hold / Insufficient data>

**Summary:** <1-2 sentence description of what's changing>

**Service health (30m):**
- Error rate: <count> errors (<trend>)
- Latency p99: <value>
- Alerting monitors: <none / list>

**Functional validation:**
- <change description> → <Verified / Unverified / Errors / No traffic>
- ...

<if Hold or Insufficient data, add: **Action needed:** <what to check or fix>>
```

### 5b. DM the owner

**Skip this step if `is_refresh` is true** — the owner was already notified on the first check. Only DM again if the recommendation changed (e.g. from "safe" to "hold").

Send a DM with the full evidence. Structure:

```
Deploy approval: <service>

**Summary:** <1-2 sentence description of what's changing>

**Your commits:** <count> commits
- <sha short> — <message> → <Verified / Unverified / Errors / No traffic>
- ...

**Recommendation:** <Looks safe — verified / Looks safe — unverified / Hold / Insufficient data>

**Functional validation:**
For each of your changes, what we looked for and what we found:
- <change description>: <what log/metric pattern was searched> → <result with specific evidence or "not found">
- ...

**Service health (30m):**
- Error rate: <count> errors (<trend vs prior window>)
- Latency p99: <value>
- Alerting monitors: <none / list>

**Gaps:** <anything that couldn't be checked and why>
```

If the recommendation is "Hold", lead with the specific concern. If "unverified", explain what evidence was missing and suggest how to trigger the code path if possible.

---

## Phase 6 — Persist

Call `db.insertDeploy()` with:

| Field | Value |
|---|---|
| `id` | `deploy_id` from quest context (e.g. `deploy:CTDAN6570/1776182661.852439`) |
| `service` | Service name |
| `description` | Deploy description from message |
| `requester` | Author of the deploy-bot message |
| `recommendation` | One of: `safe`, `hold`, `insufficient_data` |
| `evidence` | JSON string of the structured evidence |
| `message_url` | Permalink to the deploy-bot message if available |

---

## Service notes

Static config facts that apply to every deploy for a service. For accumulated learnings (baselines, past incidents, gotchas), use vector memory — Phase 2 queries for these automatically.

| Service | Env tag | Notes |
|---|---|---|
| `credits-manager` | `env:stg` | SuspensionManager fires every ~1min. Delinquency API gets regular traffic. 4 hosts typical. Burst-dedup guard (DEV-6361) requires an already-suspended entity to validate — rarely triggerable in stg. |
| `developer-dashboard-service` | `env:stg` | Version tag in DD uses full git SHA. CDS shadow mode runs in staging — watch for `"CDS shadow mode: detected differences"` warnings. |
| `entitlement-service` | `env:stg` | SQS workers: EntitlementUpdateWorker (high traffic), AccountStateChangeEntitlementRevokeWorker (infrequent — triggered by account state change SNS) |
| `platform-notifications` | `env:stg` | DD service name: `notifications`. Flyway migration logs not instrumented in DD. "Delivery worker failed" at info level is normal staging behavior (unreachable webhook endpoints). |
| `wallets-api` | | |
