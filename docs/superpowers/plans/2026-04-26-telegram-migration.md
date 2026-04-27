# Telegram Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Slack as Franklin's messaging transport with a Telegram bot using grammy long polling, retiring all Slack-specific scouts and the Slack send script.

**Architecture:** grammy runs a long-polling listener in `server.ts` that writes incoming DMs to the existing `slack_inbox` DB table (rename deferred). `telegram_send.ts` replaces `slack_send.ts` for outbound messages. `franklin.ts`'s inbox draining logic is simplified — auth is enforced at intake, so Slack-specific event type checks are removed.

**Tech Stack:** grammy v1.x (Telegram Bot API), existing better-sqlite3 DB, tsx, Node test runner

---

## File Map

| Action | File | What changes |
|--------|------|-------------|
| Delete | `src/scouts/slack.ts` | Retired — search polling not needed |
| Delete | `src/scouts/slack_channels.ts` | Retired — ops channel monitoring |
| Delete | `src/scouts/deploy_poll.ts` | Retired — Slack deploy-bot polling |
| Delete | `src/slack_conversations.ts` | Retired — Slack conversation CLI |
| Delete | `src/scripts/slack_send.ts` | Retired — replaced by telegram_send |
| Create | `src/scripts/telegram_send.ts` | Outbound Telegram messages |
| Create | `secrets/telegram_bot_token.txt` | Bot token (manual step) |
| Modify | `package.json` | Remove Slack packages, add grammy |
| Modify | `src/schemas.ts` | Swap `slack_user_id` → `telegram_user_id`, add `telegram_chat_id` |
| Modify | `src/tests/schemas.test.ts` | Update SettingsSchema tests |
| Modify | `src/config.ts` | Remove `slack_channels`, `deploy_poll` from `SCOUT_INTERVALS_MS` |
| Modify | `server.ts` | Replace socket mode block with grammy long polling |
| Modify | `franklin.ts` | Simplify inbox draining, update health probes |
| Modify | `modes/worker_wrapper.md` | Replace slack_send references with telegram_send |
| Modify | `state/settings.json` | Add `telegram_user_id`, `telegram_chat_id` fields |

---

## Task 1: Get your Telegram bot token

**Files:** `secrets/telegram_bot_token.txt` (manual)

- [ ] **Step 1: Create a bot via @BotFather**

  Open Telegram → search for `@BotFather` → send `/newbot` → follow prompts to pick a name and username. BotFather replies with a token like `7123456789:AAHdqTcv...`.

- [ ] **Step 2: Find your Telegram user ID and chat ID**

  Search for `@userinfobot` in Telegram and send it any message. It replies with your numeric user ID (e.g. `123456789`). For a private DM bot, your chat ID equals your user ID.

  For any other authorized users, have them message `@userinfobot` too and note their IDs.

- [ ] **Step 3: Save the bot token**

  ```bash
  echo "YOUR_BOT_TOKEN_HERE" > secrets/telegram_bot_token.txt
  ```

---

## Task 2: Install grammy, remove Slack packages

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install grammy**

  ```bash
  npm install grammy
  ```

- [ ] **Step 2: Remove Slack packages**

  ```bash
  npm uninstall @slack/socket-mode @slack/web-api
  ```

- [ ] **Step 3: Verify package.json**

  `dependencies` should now contain `"grammy"` and NOT contain `@slack/socket-mode` or `@slack/web-api`.

  ```bash
  node --import tsx/esm --test src/tests/schemas.test.ts
  ```

  Expected: all tests pass (nothing schema-related changed yet).

- [ ] **Step 4: Commit**

  ```bash
  git add package.json package-lock.json
  git commit -m "deps: replace Slack packages with grammy"
  ```

---

## Task 3: Update settings schema

**Files:**
- Modify: `src/schemas.ts`
- Modify: `src/tests/schemas.test.ts`

- [ ] **Step 1: Write the failing tests**

  In `src/tests/schemas.test.ts`, replace the entire `describe("SettingsSchema", ...)` block with:

  ```typescript
  describe("SettingsSchema", () => {
    test("accepts real settings shape with telegram fields", () => {
      const data = {
        name: "Franklin", mode: "allow_send", avatar: "Franklin.jpg",
        user_profile: { name: "Mike", telegram_user_id: 123456789, telegram_chat_id: 123456789, tone: "curt but witty" },
        authorized_users: [{ name: "mike", telegram_user_id: 123456789 }],
        integrations: ["telegram", "jira", "github", "gws"],
      };
      assert.ok(SettingsSchema.safeParse(data).success);
    });

    test("accepts multiple authorized users", () => {
      const data = {
        name: "Franklin", mode: "drafts_only",
        user_profile: { name: "Mike", telegram_user_id: 111, telegram_chat_id: 111, tone: "pro" },
        authorized_users: [
          { name: "mike", telegram_user_id: 111 },
          { name: "alice", telegram_user_id: 222 },
        ],
        integrations: [],
      };
      assert.ok(SettingsSchema.safeParse(data).success);
    });

    test("accepts settings with disabled_scouts", () => {
      const data = {
        name: "Franklin", mode: "allow_send",
        user_profile: { name: "Mike", telegram_user_id: 111, telegram_chat_id: 111, tone: "pro" },
        authorized_users: [{ name: "mike", telegram_user_id: 111 }],
        integrations: [],
        disabled_scouts: ["gmail", "calendar"],
      };
      const result = SettingsSchema.safeParse(data);
      assert.ok(result.success);
      assert.deepEqual(result.data.disabled_scouts, ["gmail", "calendar"]);
    });

    test("rejects settings missing authorized_users", () => {
      const data = {
        name: "Franklin", mode: "drafts_only",
        user_profile: { name: "Mike", telegram_user_id: 111, telegram_chat_id: 111, tone: "pro" },
        integrations: [],
      };
      assert.ok(!SettingsSchema.safeParse(data).success);
    });

    test("rejects settings missing user_profile", () => {
      const data = {
        name: "Franklin", mode: "drafts_only",
        authorized_users: [{ name: "mike", telegram_user_id: 111 }],
        integrations: [],
      };
      assert.ok(!SettingsSchema.safeParse(data).success);
    });

    test("rejects user_profile missing telegram_user_id", () => {
      const data = {
        name: "Franklin", mode: "drafts_only",
        user_profile: { name: "Mike", telegram_chat_id: 111, tone: "pro" },
        authorized_users: [{ name: "mike", telegram_user_id: 111 }],
        integrations: [],
      };
      assert.ok(!SettingsSchema.safeParse(data).success);
    });

    test("rejects authorized_user missing telegram_user_id", () => {
      const data = {
        name: "Franklin", mode: "drafts_only",
        user_profile: { name: "Mike", telegram_user_id: 111, telegram_chat_id: 111, tone: "pro" },
        authorized_users: [{ name: "mike" }],
        integrations: [],
      };
      assert.ok(!SettingsSchema.safeParse(data).success);
    });
  });
  ```

- [ ] **Step 2: Run tests — expect failures**

  ```bash
  node --import tsx/esm --test src/tests/schemas.test.ts 2>&1 | grep -E "pass|fail|error"
  ```

  Expected: SettingsSchema tests fail because schema still has `slack_user_id`.

- [ ] **Step 3: Update the schema**

  In `src/schemas.ts`, replace the `SettingsSchema` definition:

  ```typescript
  export const SettingsSchema = z.object({
    name: z.string(),
    mode: z.string(),
    owner_user_id: z.string().optional(),
    timezone: z.string().optional(),
    avatar: z.string().optional(),
    user_profile: z.object({
      name: z.string(),
      telegram_user_id: z.number().int(),
      telegram_chat_id: z.number().int(),
      tone: z.string(),
    }),
    authorized_users: z.array(
      z.object({
        name: z.string(),
        telegram_user_id: z.number().int(),
      }),
    ),
    integrations: z.array(z.string()),
    disabled_scouts: z.array(z.string()).optional(),
    feature_flags: z.record(z.string(), z.unknown()).optional(),
  });
  ```

  Note: `feature_flags` was in `state/settings.json` but missing from the old schema — add it now.

- [ ] **Step 4: Run tests — expect all pass**

  ```bash
  node --import tsx/esm --test src/tests/schemas.test.ts 2>&1 | grep -E "pass|fail|error"
  ```

  Expected: all SettingsSchema tests pass, all other schema tests still pass.

- [ ] **Step 5: Commit**

  ```bash
  git add src/schemas.ts src/tests/schemas.test.ts
  git commit -m "feat: replace slack_user_id with telegram_user_id in settings schema"
  ```

---

## Task 4: Update `src/config.ts` — remove retired scouts

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Remove `slack_channels` and `deploy_poll` from `SCOUT_INTERVALS_MS`**

  In `src/config.ts`, find `SCOUT_INTERVALS_MS` and remove the two entries:

  ```typescript
  export const SCOUT_INTERVALS_MS: Record<string, number> = {
    github:   10 * 60 * 1000,
    jira:     10 * 60 * 1000,
    gmail:    15 * 60 * 1000,
    calendar: 10 * 60 * 1000,
  };
  ```

- [ ] **Step 2: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit 2>&1 | head -20
  ```

  Expected: no errors (or only pre-existing errors unrelated to this change).

- [ ] **Step 3: Commit**

  ```bash
  git add src/config.ts
  git commit -m "feat: remove slack_channels and deploy_poll from scout intervals"
  ```

---

## Task 5: Create `src/scripts/telegram_send.ts`

**Files:**
- Create: `src/scripts/telegram_send.ts`

- [ ] **Step 1: Create the send script**

  Create `src/scripts/telegram_send.ts`:

  ```typescript
  #!/usr/bin/env npx tsx
  /**
   * Send Telegram messages as the Franklin bot.
   *
   * Usage:
   *   npx tsx src/scripts/telegram_send.ts message --chat_id 123456789 --text "hello"
   *   npx tsx src/scripts/telegram_send.ts message --chat_id 123456789 --text "reply" --reply_to 42
   */

  import { Bot } from "grammy";
  import { readFileSync } from "fs";
  import { join, dirname } from "path";
  import { fileURLToPath } from "url";
  import { createLogger } from "../logger.js";
  const log = createLogger("telegram");

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const ROOT = join(__dirname, "..", "..");
  const TOKEN_FILE = join(ROOT, "secrets", "telegram_bot_token.txt");

  const token = readFileSync(TOKEN_FILE, "utf8").trim();
  const bot = new Bot(token);

  function parseArgs(args: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith("--") && i + 1 < args.length) {
        result[args[i].slice(2)] = args[i + 1];
        i++;
      }
    }
    return result;
  }

  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  async function main() {
    if (command === "message") {
      if (!args.chat_id || !args.text) {
        log.error("Usage: telegram_send.ts message --chat_id <id> --text <text> [--reply_to <message_id>]");
        process.exit(1);
      }
      const chatId = parseInt(args.chat_id, 10);
      const replyTo = args.reply_to ? parseInt(args.reply_to, 10) : undefined;
      const result = await bot.api.sendMessage(chatId, args.text, {
        ...(replyTo ? { reply_parameters: { message_id: replyTo } } : {}),
      });
      console.log(JSON.stringify({ ok: true, message_id: result.message_id }));
    } else {
      log.error("Commands: message");
      process.exit(1);
    }
  }

  main().catch((err) => {
    log.error(JSON.stringify({ ok: false, error: (err as Error).message }));
    process.exit(1);
  });
  ```

- [ ] **Step 2: Smoke test (requires bot token from Task 1)**

  Send yourself a test message. Replace `YOUR_CHAT_ID` with your Telegram user ID:

  ```bash
  npx tsx src/scripts/telegram_send.ts message --chat_id YOUR_CHAT_ID --text "Franklin is online"
  ```

  Expected: message appears in Telegram, stdout shows `{"ok":true,"message_id":...}`.

- [ ] **Step 3: Commit**

  ```bash
  git add src/scripts/telegram_send.ts
  git commit -m "feat: add telegram_send.ts outbound messaging script"
  ```

---

## Task 6: Replace socket mode with grammy in `server.ts`

**Files:**
- Modify: `server.ts`

- [ ] **Step 1: Remove all Slack socket mode imports and code**

  At the top of `server.ts`, remove these imports:

  ```typescript
  import { SocketModeClient } from "@slack/socket-mode";
  import { WebClient } from "@slack/web-api";
  ```

  Then delete everything from the comment `// ── Socket Mode ───` to the end of the file (the entire socket mode block, including `acquireSocketLock`, `releaseSocketLock`, `slog`, `botClient`, `reactIfAllowed`, `writeSocketHeartbeat`, `handleSlackEvent`, and the `if (existsSync(SOCKET_TOKEN_FILE)...)` block with all event handlers).

- [ ] **Step 2: Add grammy long polling listener**

  At the end of `server.ts` (after `app.listen(...)`), add:

  ```typescript
  // ── Telegram Bot (long polling) ───────────────────────────────────────────────

  import { Bot } from "grammy";

  const TELEGRAM_TOKEN_FILE = join(__dirname, "secrets", "telegram_bot_token.txt");
  const TELEGRAM_HEARTBEAT_FILE = join(STATE, "telegram_bot.json");

  function writeTelegramHeartbeat(status: string): void {
    writeFileSync(
      TELEGRAM_HEARTBEAT_FILE,
      JSON.stringify({ status, updated_at: new Date().toISOString() }) + "\n",
    );
  }

  if (existsSync(TELEGRAM_TOKEN_FILE)) {
    const telegramToken = readFileSync(TELEGRAM_TOKEN_FILE, "utf8").trim();

    const settingsForAuth = readJson<{
      authorized_users?: Array<{ telegram_user_id?: number }>;
    }>(join(STATE, "settings.json"));
    const authorizedTelegramIds = new Set(
      (settingsForAuth?.authorized_users ?? [])
        .map((u) => u.telegram_user_id)
        .filter((id): id is number => typeof id === "number"),
    );

    const telegramBot = new Bot(telegramToken);

    telegramBot.on("message", (ctx) => {
      const msg = ctx.message;
      const fromId = msg.from?.id;
      if (!fromId || !authorizedTelegramIds.has(fromId)) return;

      writeTelegramHeartbeat("connected");
      log.info(`[telegram] message from=${fromId} chat=${msg.chat.id} text=${(msg.text ?? "").slice(0, 80)}`);

      db.insertSlackEvent({
        event_ts: String(msg.date),
        channel: String(msg.chat.id),
        channel_type: "im",
        user_id: String(fromId),
        type: "message",
        text: msg.text,
        thread_ts: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
        raw: msg,
      });
    });

    telegramBot.catch((err) => {
      log.error(`[telegram] error: ${err.message}`);
      writeTelegramHeartbeat("error");
    });

    telegramBot.start({
      onStart: () => {
        log.info("[telegram] bot started (long polling)");
        writeTelegramHeartbeat("connected");
      },
    });
  } else {
    log.warn("Telegram bot token not found — Telegram bot disabled.");
  }
  ```

  Note: move `import { Bot } from "grammy"` to the top of `server.ts` with the other imports — TypeScript requires top-level imports at the top of the file.

- [ ] **Step 3: Update the `/api/state` socket status block**

  Find this block in the `/api/state` route handler:

  ```typescript
  // Socket status
  const socketData = readJson<{ status: string; updated_at: string }>(join(STATE, "slack_socket.json"));
  const socketStatus = socketData?.status ?? "unknown";
  const socketStale = isStale(socketData?.updated_at ?? null, 300);
  ```

  Replace with:

  ```typescript
  // Telegram bot status
  const socketData = readJson<{ status: string; updated_at: string }>(join(STATE, "telegram_bot.json"));
  const socketStatus = socketData?.status ?? "unknown";
  const socketStale = isStale(socketData?.updated_at ?? null, 300);
  ```

- [ ] **Step 4: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: no new errors.

- [ ] **Step 5: Start server and verify bot connects**

  ```bash
  npx tsx server.ts &
  ```

  Wait ~5 seconds, then:

  ```bash
  cat state/telegram_bot.json
  ```

  Expected: `{"status":"connected","updated_at":"..."}`.

  Send yourself a message via Telegram. Then:

  ```bash
  sqlite3 franklin.db "SELECT event_ts, channel, user_id, text FROM slack_inbox ORDER BY received_at DESC LIMIT 3;"
  ```

  Expected: your message appears in the DB.

  Stop the server: `kill %1`

- [ ] **Step 6: Commit**

  ```bash
  git add server.ts
  git commit -m "feat: replace Slack socket mode with grammy long polling in server.ts"
  ```

---

## Task 7: Simplify inbox draining in `franklin.ts`

**Files:**
- Modify: `franklin.ts`

- [ ] **Step 1: Remove `FRANKLIN_BOT_USER_ID` and `fetchThreadContext`**

  Delete these two items entirely from `franklin.ts`:

  ```typescript
  const FRANKLIN_BOT_USER_ID = "U0AS0UZGW6L";
  ```

  ```typescript
  function fetchThreadContext(channel: string, threadTs: string): string | null {
    // ... entire function
  }
  ```

- [ ] **Step 2: Replace `generateDmTasks`**

  Replace the entire `generateDmTasks` function with:

  ```typescript
  function generateDmTasks(): DelegationTask[] {
    const inboxFile = join(ROOT, "state", "brain_input", "slack_inbox.json");
    const inbox = readJson<SlackInboxEvent[]>(inboxFile) ?? [];
    if (!inbox.length) return [];

    const settings = readJsonWithSchema(SETTINGS_FILE, SettingsSchema);
    const authorizedIds = new Set(
      (settings?.authorized_users ?? []).map((u) => String(u.telegram_user_id)),
    );
    const mode = settings?.mode ?? "drafts_only";

    const tasks: DelegationTask[] = [];

    for (const event of inbox) {
      if (!event.user_id) continue;
      if (!authorizedIds.has(event.user_id)) continue;

      tasks.push({
        id: `dm-${event.event_ts}`,
        type: "dm_reply",
        priority: "high",
        context: {
          event_ts: event.event_ts,
          channel: event.channel,
          channel_type: event.channel_type,
          user_id: event.user_id,
          text: event.text ?? null,
          type: event.type,
          reaction: null,
          thread_ts: event.thread_ts ?? null,
          thread_context: null,
          source_tag: "dm",
          quest_id: null,
          mode,
          max_task_type: "quest",
        },
        mark_surfaced: null,
      });
    }

    const annotatedInbox = inbox.map((event) => {
      if (!event.user_id || !authorizedIds.has(event.user_id)) {
        return { ...event, max_task_type: null };
      }
      return { ...event, max_task_type: "quest" };
    });
    writeJson(inboxFile, annotatedInbox);

    if (tasks.length) {
      log.info(` Generated ${tasks.length} dm_reply task(s) from inbox`);
    }
    return tasks;
  }
  ```

- [ ] **Step 3: Update `HEALTH_PROBES`**

  Replace the current `HEALTH_PROBES` constant:

  ```typescript
  const HEALTH_PROBES: Record<string, { cmd: string; label: string }> = {
    github:   { cmd: "gh auth status",                                          label: "GitHub CLI" },
    jira:     { cmd: `test -f ${join(ROOT, "secrets", "jira_api_token.txt")}`,  label: "Jira API token" },
    gmail:    { cmd: "which gws",                                               label: "Gmail (gws CLI)" },
    calendar: { cmd: "which gws",                                               label: "Calendar (gws CLI)" },
  };
  ```

- [ ] **Step 4: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: no errors from the changes above. If `execSync` is now unused (only `fetchThreadContext` used it), remove the `execSync` import from `franklin.ts` if TypeScript warns.

- [ ] **Step 5: Commit**

  ```bash
  git add franklin.ts
  git commit -m "feat: simplify inbox draining in franklin.ts for Telegram"
  ```

---

## Task 8: Delete retired files

**Files:**
- Delete: `src/scouts/slack.ts`
- Delete: `src/scouts/slack_channels.ts`
- Delete: `src/scouts/deploy_poll.ts`
- Delete: `src/slack_conversations.ts`
- Delete: `src/scripts/slack_send.ts`

- [ ] **Step 1: Delete the files**

  ```bash
  git rm src/scouts/slack.ts src/scouts/slack_channels.ts src/scouts/deploy_poll.ts src/slack_conversations.ts src/scripts/slack_send.ts
  ```

- [ ] **Step 2: Check for remaining references**

  ```bash
  grep -rn "slack_conversations\|slack_send\|deploy_poll\|slack_channels\|scouts/slack" \
    --include="*.ts" --include="*.md" . \
    | grep -v "node_modules" \
    | grep -v "docs/superpowers"
  ```

  Expected: no results (or only results in files you've already updated). Fix any remaining references.

- [ ] **Step 3: Verify TypeScript compiles**

  ```bash
  npx tsc --noEmit 2>&1 | head -30
  ```

  Expected: no errors.

- [ ] **Step 4: Commit**

  ```bash
  git commit -m "feat: remove retired Slack scouts and scripts"
  ```

---

## Task 9: Update `state/settings.json`

**Files:**
- Modify: `state/settings.json`

- [ ] **Step 1: Add Telegram fields**

  Replace `slack_user_id` with `telegram_user_id` in `user_profile` and `authorized_users`. Add `telegram_chat_id` to `user_profile`. Fill in your actual Telegram user IDs from Task 1 Step 2.

  Example (replace numeric IDs with real ones):

  ```json
  {
    "name": "Franklin",
    "mode": "allow_send",
    "timezone": "America/Chicago",
    "avatar": "Franklin.jpg",
    "user_profile": {
      "name": "Michael Scully",
      "telegram_user_id": YOUR_TELEGRAM_USER_ID,
      "telegram_chat_id": YOUR_TELEGRAM_USER_ID,
      "tone": "curt but witty, with an air of mystery — says just enough to get the point across, leaves people wondering a little. Keeps it professional."
    },
    "authorized_users": [
      {
        "name": "michael-scully",
        "telegram_user_id": YOUR_TELEGRAM_USER_ID
      }
    ],
    "feature_flags": {
      "skip_docker": true
    },
    "integrations": ["telegram", "jira", "github", "gws"]
  }
  ```

  Remove `owner_user_id` (Slack-specific). Remove any authorized users you don't want on the Telegram bot — or add their `telegram_user_id` values for each one you're keeping.

- [ ] **Step 2: Validate against schema**

  Create a temp file `validate_settings.ts`:
  ```typescript
  import { readFileSync } from "fs";
  import { SettingsSchema } from "./src/schemas.js";
  const data = JSON.parse(readFileSync("state/settings.json", "utf8"));
  const result = SettingsSchema.safeParse(data);
  if (result.success) console.log("OK");
  else console.error(JSON.stringify(result.error.issues, null, 2));
  ```

  Run it:
  ```bash
  npx tsx validate_settings.ts && rm validate_settings.ts
  ```

  Expected: prints `OK`.

- [ ] **Step 3: Commit**

  ```bash
  git add state/settings.json
  git commit -m "feat: update settings.json with Telegram user IDs"
  ```

---

## Task 10: Update `modes/worker_wrapper.md`

**Files:**
- Modify: `modes/worker_wrapper.md`

- [ ] **Step 1: Replace the messaging section**

  Find the "When messaging the user" block (around line 216–228) and replace with:

  ```markdown
  When messaging the user (Telegram DMs):

  - Keep responses concise. Lead with the answer.
  - **Send as the Franklin bot** using the send script:

    ```bash
    npx tsx src/scripts/telegram_send.ts message --chat_id <chat_id> --text "<message>" [--reply_to <message_id>]
    ```

    - `chat_id`: from task context `channel` field
    - `reply_to`: from task context `thread_ts` field (if present, to reply in-thread)

  - Never send messages via any other tool — only `telegram_send.ts`.
  ```

- [ ] **Step 2: Remove Slack-specific references**

  Search for and remove/replace any remaining Slack references in `modes/worker_wrapper.md`:

  ```bash
  grep -n "slack\|Slack\|MCP.*slack\|slack_conversations\|slack_send" modes/worker_wrapper.md
  ```

  For each hit:
  - References to reading Slack threads → remove (no equivalent for Telegram DMs)
  - References to MCP Slack tools → remove
  - References to `#deploy-bot`, Slack channel IDs → remove
  - References to `slack_conversations.ts` → remove

- [ ] **Step 3: Commit**

  ```bash
  git add modes/worker_wrapper.md
  git commit -m "docs: update worker_wrapper.md for Telegram messaging"
  ```

---

## Task 11: End-to-end smoke test

- [ ] **Step 1: Run all tests**

  ```bash
  node --import tsx/esm --test src/tests/*.test.ts
  ```

  Expected: all tests pass.

- [ ] **Step 2: Start server**

  ```bash
  npx tsx server.ts
  ```

  Expected: logs show `[telegram] bot started (long polling)` and no errors.

- [ ] **Step 3: Send a test DM**

  Send a message to your Franklin bot from Telegram. Wait ~2 seconds, then:

  ```bash
  sqlite3 franklin.db "SELECT event_ts, channel, user_id, text FROM slack_inbox WHERE processed = 0 ORDER BY received_at DESC LIMIT 5;"
  ```

  Expected: your message appears with `processed = 0` (sqlite3 shows unprocessed rows).

- [ ] **Step 4: Test outbound reply**

  ```bash
  npx tsx src/scripts/telegram_send.ts message --chat_id YOUR_CHAT_ID --text "Test reply from Franklin"
  ```

  Expected: message appears in Telegram.

- [ ] **Step 5: Run franklin in status mode**

  ```bash
  npx tsx franklin.ts status
  ```

  Expected: no crashes, no references to missing Slack tokens.
