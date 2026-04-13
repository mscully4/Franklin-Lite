---
id: proposal-00007
title: Raccoon Reaction Knowledge Intake
status: implemented
blocked_by: ~Slack app permissions — reactions:read and reactions:write scopes not yet approved~ (unblocked 2026-04-06)
depends_on: proposal-00008 (socket mode — reaction_added events replace reactions.list polling)
created: 2026-04-06
updated: 2026-04-06
---

## Problem

The only way to hand Franklin something to read is to DM him. For messages already open in Slack (a thread, a channel post, a search result), that means copy-pasting context or switching windows. Reactions are faster — one tap, in-place.

## Proposal

React 🥃 `:whiskey:` to any Slack message to flag it for Franklin to absorb. On the next cycle, Franklin reads the full thread for context, absorbs what's relevant into the knowledge base, and optionally creates a quest if something action-worthy emerges.

Franklin reacts 🦝 `:raccoon:` to any message it processes (DMs, @mentions, quest replies) as a general "I've seen this" ACK.

A ✅ `white_check_mark` reaction is added by Franklin after completing knowledge intake to mark it fully handled. This reaction *is* the state — no extra tracking in `last_run.json`.

## How It Works

### Intake (socket)

`reaction_added` events arrive via Socket Mode. Franklin filters for:
- `reaction: "whiskey"` added by an authorized user → emit as `source: "whiskey_reaction"`
- Skip any message that already has a `white_check_mark` reaction from Franklin (dedup)

### Processing (RUN.md)

**General ACK** — Franklin reacts 🦝 `:raccoon:` on any message it processes (DMs, @mentions, quest replies). This is the "I've seen this" signal. Text reply only fires when there's something meaningful to say (quest created, action taken).

**Whiskey intake** — when Franklin sees a `whiskey_reaction` entry:

1. Fetch the full thread via `conversations.replies` (or just the message if not in a thread)
2. Synthesize what's useful — domain knowledge, a decision, context about a person or project, a useful link — and write it to the appropriate file under `knowledge/`
3. If the content implies an action item or task, create a quest (same as a DM would)
4. React ✅ `white_check_mark` to mark intake complete
5. React 🦝 `:raccoon:` (general ACK, same as all other processed messages)

### Marking Processed (new CLI command)

Add `react` command to `scripts/slack_conversations.ts`:

```
npx tsx scripts/slack_conversations.ts react <channel> <ts> <emoji>
```

Wraps `client.reactions.add({ channel, name: emoji, timestamp: ts })`.

### Deduplication

No file-based state needed. The `white_check_mark` reaction on the message is the authoritative "already handled" flag. If Franklin crashes mid-cycle before adding the reaction, the item will simply be re-processed next cycle — safe because knowledge writes are idempotent.

## Required Slack Scopes

| Scope | Used for |
|---|---|
| `reactions:read` | `reactions.list` — find messages Michael reacted to |
| `reactions:write` | `reactions.add` — mark messages as processed |

Both need to be added to the Franklin OAuth app and approved by IT.

## Files Changed

- `scripts/slack_conversations.ts` — add `react` CLI command; add stream 3c to `scout()`
- `modes/RUN.md` — add `raccoon_reaction` handling in the message processing step; document the `white_check_mark` convention
- JSDoc at top of script — document stream 3c

## Open Questions

- Should Franklin DM a brief summary of what it learned from the message? ("Filed away: context on X") — or silent is fine?
- What emoji should Franklin use for the processed marker? `white_check_mark` assumed above but open to change.
