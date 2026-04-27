# Telegram Migration Design

**Date:** 2026-04-26  
**Status:** Approved

## Summary

Replace Slack as Franklin's messaging transport with Telegram. Franklin is being converted from a work bot to personal use. The migration removes Slack's complex multi-token auth, search-based scouts, and ops channel monitoring, replacing them with a single grammy-powered Telegram bot using long polling.

---

## What Gets Retired

| File | Reason |
|------|--------|
| `src/scouts/slack.ts` | Telegram delivers all messages natively; no search polling needed |
| `src/scouts/slack_channels.ts` | Ops alert monitoring was work-specific; no equivalent needed |
| `src/slack_conversations.ts` | Slack-specific CLI utility |
| `src/scripts/slack_send.ts` | Replaced by `telegram_send.ts` |
| `@slack/socket-mode`, `@slack/web-api` | Replaced by `grammy` |
| Slack secrets (5 files) | Replaced by single bot token |

## What Gets Added

| File | Purpose |
|------|---------|
| `src/scripts/telegram_send.ts` | Send messages and replies via Telegram bot API |
| `secrets/telegram_bot_token.txt` | Bot token from @BotFather |

## What Changes

| File | Change |
|------|--------|
| `server.ts` | Socket mode block replaced with grammy long polling listener |
| `package.json` | Remove Slack packages, add `grammy` |
| `src/config.ts` | Remove `slack_channels` from `SCOUT_INTERVALS_MS` |
| `state/settings.json` | Add `telegram_user_id` and `telegram_chat_id` to `user_profile`; add `telegram_user_id` to each `authorized_users` entry |
| `franklin.ts` | Update `drainSlackInbox`: replace Slack event type checks (`app_mention`, `reaction_added`, `whiskey`) with Telegram-compatible logic; replace `user_profile.slack_user_id` owner lookup with `user_profile.telegram_user_id`; bypass channel-policy DB check (auth already enforced at intake) |

## What Is Untouched

- DB schema (`slack_inbox` table — rename deferred)
- `franklin.ts` brain/worker dispatch (only inbox draining changes, see above)
- All other scouts (github, jira, gmail, calendar, deploy_poll)
- Dashboard (Express routes, `index.html`)
- `src/filter-signals.ts` — reads from DB, transport-agnostic

---

## Data Flow

### Inbound (Telegram → DB → Franklin)

1. grammy `bot.on("message")` fires in `server.ts` for every incoming DM
2. Auth check: incoming `from.id` must be in `authorized_users[].telegram_user_id` — otherwise ignored silently
3. Accepted messages are written to `slack_inbox` DB table with this mapping:

| DB field | Telegram source |
|----------|----------------|
| `event_ts` | `String(message.date)` (Unix seconds) |
| `channel` | `String(message.chat.id)` |
| `channel_type` | `"im"` (always, DMs only for now) |
| `user_id` | `String(message.from.id)` |
| `type` | `"message"` |
| `text` | `message.text` |
| `thread_ts` | `String(message.reply_to_message?.message_id)` if present |
| `raw` | full Telegram message object |

4. Franklin's brain loop reads from `slack_inbox` unchanged

### Outbound (Franklin → Telegram)

`telegram_send.ts` wraps grammy's bot API:

```
npx tsx src/scripts/telegram_send.ts message --chat_id <id> --text <text> [--reply_to <message_id>]
```

- `--chat_id`: target chat (from `settings.json` → `user_profile.telegram_chat_id`, or per-user)
- `--reply_to`: Telegram message ID (stored in DB as `thread_ts`) for threaded replies

Workers call `telegram_send.ts` where they previously called `slack_send.ts`.

---

## Auth

Incoming messages are accepted only if `from.id` appears in `authorized_users[].telegram_user_id` in `settings.json`. All others are silently ignored. No channel-policy system needed.

---

## Settings Schema Changes

```json
{
  "user_profile": {
    "telegram_user_id": 123456789,
    "telegram_chat_id": 123456789
  },
  "authorized_users": [
    {
      "name": "Mike",
      "telegram_user_id": 123456789
    }
  ]
}
```

`telegram_chat_id` equals `telegram_user_id` for private chats but is kept explicit for clarity. Existing Slack fields in `settings.json` are left in place for now (deferred cleanup).

---

## ID Translation

Slack used floating-point Unix timestamps as message IDs. Telegram uses integer message IDs. Both are stored as strings in `thread_ts`. `telegram_send.ts` parses `thread_ts` back to an integer for `reply_to_message_id`. No other code is aware of this.

---

## Package Changes

```diff
- "@slack/socket-mode": "^2.0.6"
- "@slack/web-api": "^7.15.0"
+ "grammy": "^1.x"
```

---

## Secrets

| Old | New |
|-----|-----|
| `secrets/franklin_user_oauth_token.txt` | removed |
| `secrets/franklin_bot_oauth_token.txt` | removed |
| `secrets/franklin_socket_token.txt` | removed |
| `secrets/franklin_client_secret.txt` | removed |
| `secrets/slack_refresh_token.txt` | removed |
| — | `secrets/telegram_bot_token.txt` |

---

## Out of Scope

- DB schema rename (`slack_inbox` → `telegram_inbox` or similar) — deferred
- Slack field cleanup in `settings.json` — deferred
- Webhook mode (long polling is sufficient for personal use)
- Multi-group or channel support (DMs only for now)
