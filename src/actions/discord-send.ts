#!/usr/bin/env npx tsx
/**
 * Send Discord messages as the Franklin bot.
 *
 * Usage:
 *   npx tsx src/scripts/discord_send.ts message --channel_id 123456789012345678 --text "hello"
 */

import { REST, Routes } from "discord.js";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createLogger } from "../logger.js";
const log = createLogger("discord");

const SM_SECRET_ID = "franklin/discord-bot-token";
const sm = new SecretsManagerClient({ region: "us-east-2" });

async function getDiscordToken(): Promise<string> {
  const response = await sm.send(new GetSecretValueCommand({ SecretId: SM_SECRET_ID }));
  if (!response.SecretString) throw new Error("Secret has no string value");
  return response.SecretString;
}

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
    if (!args.channel_id || !args.text) {
      log.error("Usage: discord_send.ts message --channel_id <id> --text <text>");
      process.exit(1);
    }
    const token = await getDiscordToken();
    const rest = new REST().setToken(token);
    const data = await rest.post(Routes.channelMessages(args.channel_id), {
      body: { content: args.text },
    }) as { id: string };
    console.log(JSON.stringify({ ok: true, message_id: data.id }));
  } else {
    log.error("Commands: message");
    process.exit(1);
  }
}

main().catch((err) => {
  log.error(JSON.stringify({ ok: false, error: (err as Error).message }));
  process.exit(1);
});
