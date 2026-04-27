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
