#!/usr/bin/env npx tsx
/**
 * Send Slack messages and reactions as the Franklin bot.
 *
 * Usage:
 *   npx tsx scripts/slack_send.ts message --channel C123 --text "hello"
 *   npx tsx scripts/slack_send.ts message --channel C123 --text "reply" --thread_ts 1234.5678
 *   npx tsx scripts/slack_send.ts react --channel C123 --ts 1234.5678 --emoji raccoon
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { WebClient } from "@slack/web-api";
import { createLogger } from "./logger.js";
const log = createLogger("slack");

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BOT_TOKEN_FILE = join(ROOT, "secrets", "franklin_bot_oauth_token.txt");

const token = readFileSync(BOT_TOKEN_FILE, "utf8").trim();
const client = new WebClient(token);

const [, , command, ...rest] = process.argv;

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

const args = parseArgs(rest);

async function main() {
  if (command === "message") {
    if (!args.channel || !args.text) {
      log.error("Usage: slack_send.ts message --channel <id> --text <text> [--thread_ts <ts>]");
      process.exit(1);
    }
    const result = await client.chat.postMessage({
      channel: args.channel,
      text: args.text,
      thread_ts: args.thread_ts,
    });
    console.log(JSON.stringify({ ok: result.ok, ts: result.ts, channel: result.channel }));

  } else if (command === "react") {
    if (!args.channel || !args.ts || !args.emoji) {
      log.error("Usage: slack_send.ts react --channel <id> --ts <ts> --emoji <name>");
      process.exit(1);
    }
    const result = await client.reactions.add({
      channel: args.channel,
      timestamp: args.ts,
      name: args.emoji,
    });
    console.log(JSON.stringify({ ok: result.ok }));

  } else {
    log.error("Commands: message, react");
    process.exit(1);
  }
}

main().catch((err) => {
  log.error(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
