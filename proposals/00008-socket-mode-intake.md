---
id: proposal-00008
title: Socket Mode Event Intake
status: approved
created: 2026-04-06
updated: 2026-04-06
---

## Problem

Franklin currently polls Slack every 2 minutes via `scripts/slack_conversations.ts scout`. This has several drawbacks:

1. **Latency** — messages sit unprocessed for up to 2 minutes
2. **Wasted API calls** — the full 24h DM window is re-fetched every cycle even when nothing changed
3. **Complexity** — Franklin owns all timestamp math, passing `--last-ts`, `--dm-oldest`, `--yesterday`, `--two-days-ago` as flags each cycle
4. **Quest trigger friction** — self-tag pattern (`from:<@userId> <@userId>`) is awkward; requires search API

## Proposal

Replace DM/mention polling with a persistent Socket Mode connection that writes events to disk as they arrive. Franklin's cycle agent drains the inbox each cycle — no API calls needed for intake.

## Architecture

### Two processes

**1. Socket server** (`server.js`, always running)
- Opens a WebSocket connection to Slack using `secrets/franklin_socket_token.txt` (`xapp-`)
- Subscribes to: `message.im`, `app_mention`, `reaction_added`, `message.channels`, `message.groups`
  - `message.channels` and `message.groups` only deliver events from channels the bot has been explicitly added to — not a workspace-wide firehose. Franklin must be added to #warn-developer-services and #deploy-bot (CTDAN6570) for those to work.
- Appends each raw event as a JSON line to `state/slack_inbox.jsonl`
- Writes `state/slack_socket.json` heartbeat on connect/disconnect
- Handles reconnection automatically — no data loss on transient disconnects
- Does nothing else — no processing, no Franklin logic

**2. Cycle agent** (Franklin, every 2 minutes)
- Reads `state/slack_inbox.jsonl` from `last_drain_ts` onward
- Normalizes events into the existing `ScoutEntry` shape
- Deduplicates on `event_ts` (Socket Mode has at-least-once delivery) using a `Set<string>` built during the drain pass
- Advances `last_drain_ts` in `last_run.json` after successful processing — this is the cursor, not file presence
- At end of cycle, prunes `slack_inbox.jsonl` by rewriting it without entries older than 48h

**Crash safety:** if Franklin crashes mid-cycle, `last_drain_ts` is not advanced. On restart, events are reprocessed from the last cursor position. The `event_ts` dedup set prevents double-processing within a single drain pass, but cross-cycle dedup relies on `last_drain_ts` being written atomically after the full cycle completes.

### Inbox format

Raw Slack event payloads, one per line:
```jsonl
{"type":"message","channel_type":"im","channel":"D0ARAA01EN8","user":"U09TE8XTM9A","text":"...","ts":"1234567890.123456","event_ts":"1234567890.123456"}
{"type":"reaction_added","user":"U09TE8XTM9A","reaction":"raccoon","item":{"type":"message","channel":"C123","ts":"1234567890.123456"},"event_ts":"1234567890.123456"}
```

Raw payloads means the server stays dumb. If normalization logic changes, old events can be replayed without data loss.

## Quest Trigger Change

The self-tag pattern (`from:<@userId> <@userId>`) is replaced by **DMing the Franklin bot directly**. The bot DM channel (`D0ARAA01EN8`) is the canonical task inbox.

- Simpler for Michael — one place to delegate tasks
- Real-time delivery via socket
- Drops `self_tag` search from `slack_conversations.ts`
- Drops `acknowledged_dm_ts` tracking — bot DM channel is the inbox, not a firehose

## What Stays Poll-Based

Some sources can't be delivered via socket events:

| Source | Why still polled | Interval |
|---|---|---|
| `@franklin` name mentions | Not a real @mention of the bot — search only | 10 min |
| Usergroup mentions | Same — search only | 10 min |
| Quest thread replies (non-DM channels the bot isn't in) | Would require adding bot to every channel | 10 min |
| GitHub, Jira, Calendar, Gmail | External systems, unrelated to Slack | unchanged |

`slack_conversations.ts scout` is trimmed to these three sources only — DMs, self-tag, and self-discovered thread replies (source 3b) are all dropped. Scout interval moves from every cycle to every 10 min.

## Raccoon Reaction Intake

`reaction_added` events land in the inbox immediately. Proposal-00007 (raccoon intake) is implemented on top of this — no `reactions.list` polling needed. The inbox entry has the channel and message ts; Franklin fetches the full thread on drain.

## Reactive Processing (Future)

The 2-minute loop is fine for now. But with the socket in place, reactive processing becomes possible:

- Socket server touches `state/slack_pending` flag when a high-priority event arrives (DM, direct @mention)
- Scheduler notices the flag and spawns a cycle agent immediately rather than waiting for the next tick
- Keeps the loop architecture intact — cycle agent is still ephemeral, state still on disk

Not implementing now, but the socket infrastructure makes it a small addition later.

## Startup & Recovery

**On startup:**
- Socket server connects and starts writing to inbox
- Franklin runs a backfill via `slack_conversations.ts` to cover any gap since last drain
- After backfill, socket is the source of truth

**If socket server goes down:**
- Franklin detects stale `state/slack_socket.json` heartbeat (>5 min old)
- Falls back to `slack_conversations.ts scout` for DM/mention polling
- DMs user: _"Socket server appears down — falling back to polling. Check `server.js`."_

**If Franklin restarts mid-inbox:**
- `last_drain_ts` in `last_run.json` is the resume point — no events lost

## Tokens

| Token | Prefix | Used for |
|---|---|---|
| `secrets/franklin_socket_token.txt` | `xapp-` | WebSocket handshake only — socket server uses no other API calls |
| `secrets/franklin_bot_oauth_token.txt` | `xoxb-` | Posting messages as Franklin (via MCP or WebClient) |
| `secrets/franklin_user_oauth_token.txt` | `xoxp-` | `reactions.add` and `search.messages` — these require a user token; bot token lacks these scopes |

See README for full scope requirements.

## Files Changed

- `server.js` — add Socket Mode client alongside existing Express server
- `scripts/slack_conversations.ts` — remove `dm_new`, `dm_thread_reply`, `self_tag` sources from `scout`; add `react` command
- `modes/RUN.md` — replace Step 2.1 with inbox drain; update quest trigger to bot DM; add socket health check; document `last_drain_ts`
- `state/slack_inbox.jsonl` — new, gitignored
- `state/slack_socket.json` — new heartbeat file

## POC Status

Validated 2026-04-06:
- ✅ Socket Mode connects (`xapp-` token)
- ✅ `message.im` fires on DM to Franklin bot
- ✅ `reaction_added` fires on emoji reaction
- ✅ `reactions.add` works via user token (`xoxp-`)
