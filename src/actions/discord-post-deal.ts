#!/usr/bin/env npx tsx
/**
 * Post a deal-dash deal as a Discord embed.
 *
 * Context (FRANKLIN_TASK_CONTEXT env var):
 *   payload.upc        — product UPC
 *   payload.title      — product title
 *   payload.retailer   — retailer name
 *   payload.price      — sale price (optional)
 *   payload.original_price — original price (optional)
 *   payload.url        — deal URL (optional)
 *   payload.channel_id — Discord channel to post to
 *   sqs_message_id     — for SQS acking (handled by supervisor)
 */

import { REST, Routes } from "discord.js";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createLogger } from "../logger.js";

const log = createLogger("discord_post_deal");

interface DealPayload {
  upc: string;
  title: string;
  retailer: string;
  price?: number;
  original_price?: number;
  url?: string;
  channel_id: string;
}

interface TaskContext {
  payload: DealPayload;
  sqs_message_id: string;
}

const raw = process.env.FRANKLIN_TASK_CONTEXT;
if (!raw) {
  log.error("FRANKLIN_TASK_CONTEXT not set");
  process.exit(1);
}

let ctx: TaskContext;
try {
  ctx = JSON.parse(raw) as TaskContext;
} catch {
  log.error("FRANKLIN_TASK_CONTEXT is not valid JSON");
  process.exit(1);
}

const deal = ctx.payload;
if (!deal.channel_id) {
  log.error("payload.channel_id is required");
  process.exit(1);
}

const sm = new SecretsManagerClient({ region: "us-east-2" });
const tokenResponse = await sm.send(
  new GetSecretValueCommand({ SecretId: "franklin/discord-bot-token" }),
);
if (!tokenResponse.SecretString) {
  log.error("Discord bot token secret has no value");
  process.exit(1);
}

const rest = new REST().setToken(tokenResponse.SecretString);

const fields = [
  { name: "Retailer", value: deal.retailer, inline: true },
  { name: "UPC", value: deal.upc, inline: true },
];
if (deal.price !== undefined) {
  fields.push({ name: "Price", value: `$${deal.price}`, inline: true });
}
if (deal.original_price !== undefined) {
  fields.push({ name: "Original", value: `$${deal.original_price}`, inline: true });
}

// Footer encodes metadata so the reaction gateway can recover it without a local state file
const footerMeta = JSON.stringify({
  sub_type: "deal-dash",
  upc: deal.upc,
  title: deal.title,
  retailer: deal.retailer,
});

const embed = {
  title: deal.title,
  ...(deal.url ? { url: deal.url } : {}),
  fields,
  footer: { text: footerMeta },
  color: 0x00b4d8,
};

const response = await rest.post(Routes.channelMessages(deal.channel_id), {
  body: { embeds: [embed] },
}) as { id: string };

console.log(JSON.stringify({ ok: true, message_id: response.id }));
log.info(`Posted deal "${deal.title}" → message_id=${response.id}`);
