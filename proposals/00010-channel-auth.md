---
id: proposal-00010
title: DB-Backed Channel Auth
status: implemented
created: 2026-04-13
updated: 2026-04-13
---

## Problem

Authorization is binary: a Slack user ID is in `authorized_users` or it isn't. Every authorized user has identical privileges everywhere. There's no way to say:

- "Anyone in #franklin-bot can ask questions, but only Michael can trigger quests"
- "In #team-deploys, Franklin should respond to deploy-related requests from the whole team"
- "In DMs, only the owner can give instructions"

Channel-level control is needed to configure Franklin's behavior based on where he is being interacted with.

## Why Database Over Config File

- **Runtime updates** — "Franklin, allow @jane in this channel" works immediately, no restart
- **Queryable** — enforcement is a SQL lookup, not a file parse + loop
- **Audit** — every policy change gets a timestamp and `updated_by` automatically
- **Dashboard** — `/api/state` can expose policies like it does quests and dispatches
- **Scales** — adding 50 channels doesn't bloat settings.json

## Design

### 1. Settings Change — Add `owner_user_id`

```json
{
  "name": "Franklin",
  "mode": "allow_send",
  "owner_user_id": "U09TE8XTM9A",
  "user_profile": { ... },
  "authorized_users": [ ... ],
  ...
}
```

`owner_user_id` is the **only** user who can mutate channel policies and user rules. The `SettingsSchema` in `scripts/schemas.ts` gets this field added. `authorized_users` keeps its current role as the identity registry for "who Franklin recognizes."

### 2. New DB Tables

```sql
CREATE TABLE IF NOT EXISTS channel_policies (
  channel_id       TEXT PRIMARY KEY,       -- Slack channel ID, or '__default__'
  name             TEXT,                    -- human label, e.g. "franklin-bot"
  trigger_mode     TEXT NOT NULL DEFAULT 'mention',  -- 'all' | 'mention' | 'none'
  allowed_users    TEXT NOT NULL DEFAULT 'owner',    -- 'owner' | 'authorized' | 'any' | JSON array of user IDs
  allowed_tasks    TEXT NOT NULL DEFAULT '["dm_reply"]', -- JSON array: ["dm_reply"] or ["dm_reply","quest"]
  respond_to_bots  INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL,
  updated_by       TEXT                    -- slack user_id of who changed it
);

CREATE TABLE IF NOT EXISTS channel_user_rules (
  channel_id       TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  permission       TEXT NOT NULL DEFAULT 'allow',  -- 'allow' | 'deny'
  allowed_tasks    TEXT,                   -- JSON override, null = inherit from channel policy
  updated_at       TEXT NOT NULL,
  updated_by       TEXT,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS channel_user_rules_user ON channel_user_rules(user_id);
```

### 3. Seed on First Run

The `__default__` row gets created automatically if the table is empty after schema init. It encodes today's behavior: only the owner, mention-only, conversational only.

```typescript
const seed = [
  { id: "__default__", name: "Default",          trigger: "mention", users: "owner",      tasks: '["dm_reply"]',          bots: 0 },
  { id: "im",          name: "Direct Messages",  trigger: "all",     users: "authorized", tasks: '["dm_reply","quest"]',  bots: 0 },
  { id: "C0AS53FFR3K", name: "franklin-bot",     trigger: "all",     users: "authorized", tasks: '["dm_reply","quest"]',  bots: 0 },
];
```

### 4. Resolution Logic

Single method that does the full authorization check:

```typescript
isAllowed(channelId: string, channelType: string, userId: string, ownerId: string): {
  allowed: boolean;
  maxTaskType: "dm_reply" | "quest";
  triggerMode: "all" | "mention" | "none";
  respondToBots: boolean;
}
```

**Resolution order:**

1. **User override** — `SELECT FROM channel_user_rules WHERE channel_id = ? AND user_id = ?`
   - If `permission = 'deny'` → stop, not allowed
   - If `permission = 'allow'` → allowed, use its `allowed_tasks` (or fall through to channel default if null)
2. **Exact channel** — `SELECT FROM channel_policies WHERE channel_id = ?`
3. **DM fallback** — if `channel_type = 'im'` and no exact match, look up `channel_id = 'im'`
4. **Default** — `channel_id = '__default__'`
5. **Hardcoded last resort** — `{ trigger: 'mention', allowed_users: 'owner', tasks: ['dm_reply'], bots: false }`

**`allowed_users` resolution:**

| Value | Meaning |
|---|---|
| `"owner"` | `userId === ownerId` (from `settings.owner_user_id`) |
| `"authorized"` | User is in `settings.authorized_users` |
| `"any"` | Always allowed |
| JSON array | `userId` is in the array |

### 5. Policy Mutation — Owner Only

All write methods (`upsertChannelPolicy`, `upsertUserRule`, `removeUserRule`) take an `updatedBy` user ID and check it against `settings.owner_user_id` before writing. If it doesn't match, they throw.

When Franklin processes a DM like "allow @jane to ask questions in #deploys", the worker checks the requesting user is the owner before calling the DB method.

### 6. DB Helper Methods (added to `scripts/db.ts`)

```typescript
// Read
getChannelPolicy(channelId: string, channelType?: string): ChannelPolicy | null
getUserOverride(channelId: string, userId: string): UserOverride | null
isAllowed(channelId: string, channelType: string, userId: string, ownerId: string): IsAllowedResult
listChannelPolicies(): ChannelPolicy[]
listUserRules(channelId?: string): UserOverride[]

// Write (all check owner_user_id before mutating)
upsertChannelPolicy(policy: ChannelPolicyInput, updatedBy: string): void
upsertUserRule(rule: UserRuleInput, updatedBy: string): void
removeUserRule(channelId: string, userId: string, updatedBy: string): void
```

## Changes Required

| File | Current | After |
|---|---|---|
| `state/settings.json` | No owner field | Add `owner_user_id: "U09TE8XTM9A"` |
| `scripts/schemas.ts` | No `owner_user_id` in schema | Add `owner_user_id: z.string()` to `SettingsSchema` |
| `scripts/db.ts` | No channel tables | Add tables, seed logic, and all helper methods |
| `server.ts` `reactIfAuthorized()` | Flat `authorized_users` set check | Call `db.isAllowed()`, rename to `reactIfAllowed()` |
| `franklin.ts` `generateDmTasks()` | Flat `authorizedIds.has()` + hardcoded trigger logic | Call `db.isAllowed()`, attach `maxTaskType` to task context |
| `modes/brain.md` | No awareness of channel task caps | Receives `max_task_type` in event context; won't create quest if capped at `dm_reply` |
| `modes/worker_wrapper.md` | Scope check for `dm_reply` already exists | No change needed |
| Dashboard `/api/state` | No policy data | Add `channel_policies` and `channel_user_rules` to response |

## Example Scenarios

| Scenario | Policy Hit | Result |
|---|---|---|
| Owner DMs Franklin "fix this bug" | `im`: `trigger=all, users=authorized, tasks=[dm_reply,quest]` | Quest created |
| Random person @mentions Franklin in #general | `__default__`: `users=owner` | Ignored — not owner |
| Owner @mentions Franklin in #general | `__default__`: `users=owner`, user is owner | `dm_reply` task created |
| @jane messages #franklin-bot (after owner grants her) | `channel_user_rules` row: `allow`, `tasks=null` → inherits channel's `[dm_reply,quest]` | Quest allowed |
| @jane tries to change a policy via DM | Worker checks `owner_user_id` | Rejected — not owner |
| Bot posts in #warn-developer-services (configured with `respond_to_bots=1`) | Exact channel match: `users=any, bots=1` | Processed |
| Owner says "block @spambot in #franklin-bot" | Creates `channel_user_rules` row with `permission=deny` | @spambot ignored in that channel |

## Backwards Compatibility

- If `channel_policies` table is empty or missing seed data, the hardcoded last-resort defaults match today's behavior exactly.
- If `owner_user_id` is missing from settings.json, fall back to `user_profile.slack_user_id` (current implicit owner).
- The hardcoded `FRANKLIN_BOT_CHANNEL` constant and the `isDm || isBotChannel || isAppMention` logic in `generateDmTasks()` are replaced by the DB lookup, but the seed data produces identical behavior.
- Existing `settings.json` files keep working. `authorized_users` is still read for identity resolution.

## Slack Management Interface

The owner can manage policies via DM with Franklin:

```
"allow anyone to ask questions in #team-deploys"
→ upsert channel_policies: trigger=mention, allowed_users=any, tasks=[dm_reply]

"let @jane trigger quests in #franklin-bot"
→ upsert channel_user_rules: channel=C0AS53FFR3K, user=U..., permission=allow, tasks=[dm_reply, quest]

"block @spambot in #general"
→ upsert channel_user_rules: permission=deny

"show channel policies"
→ formatted table of channel_policies + channel_user_rules
```

These are handled by the brain recognizing policy-management intent and creating a `dm_reply` task whose worker calls the db methods after verifying owner identity.

## Out of Scope

- **Expiring grants** — not needed per requirements
- **Role-based access beyond owner** — owner is the only privileged role; everyone else is equal
- **Per-channel tone/persona** — separate proposal if needed
- **Encryption at rest for policies** — policies are not secrets
