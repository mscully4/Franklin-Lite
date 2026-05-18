#!/usr/bin/env npx tsx
/**
 * Publish deal reaction feedback to the franklin-outbox SNS topic.
 *
 * Context (FRANKLIN_TASK_CONTEXT env var):
 *   message_id   — Discord message that was reacted to
 *   channel_id   — Discord channel
 *   user_id      — Discord user who reacted
 *   emoji        — reaction emoji (👍 / 👎)
 *   reacted_at   — ISO timestamp
 *   sub_type     — event sub_type (e.g. "deal-dash")
 *   meta.upc     — product UPC
 *   meta.title   — product title
 *   meta.retailer — retailer name
 */

import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { createLogger } from "../logger.js";

const log = createLogger("sns_publish_feedback");

interface ReactionContext {
  message_id: string;
  channel_id: string;
  user_id: string;
  emoji: string;
  reacted_at: string;
  sub_type: string;
  meta: { upc: string; title: string; retailer: string; [key: string]: unknown };
}

const raw = process.env.FRANKLIN_TASK_CONTEXT;
if (!raw) {
  log.error("FRANKLIN_TASK_CONTEXT not set");
  process.exit(1);
}

let ctx: ReactionContext;
try {
  ctx = JSON.parse(raw) as ReactionContext;
} catch {
  log.error("FRANKLIN_TASK_CONTEXT is not valid JSON");
  process.exit(1);
}

const TOPIC_ARN =
  process.env.SNS_OUTBOX_ARN ??
  "arn:aws:sns:us-east-2:735029168602:franklin-outbox";

const reaction = ctx.emoji === "👍" ? "up" : ctx.emoji === "👎" ? "down" : ctx.emoji;

const event = {
  event: "deal_feedback",
  reaction,
  deal: {
    upc: ctx.meta.upc,
    title: ctx.meta.title,
    retailer: ctx.meta.retailer,
  },
};

const sns = new SNSClient({ region: "us-east-2" });

await sns.send(
  new PublishCommand({
    TopicArn: TOPIC_ARN,
    Message: JSON.stringify(event),
    MessageAttributes: {
      type: { DataType: "String", StringValue: "deal-dash" },
    },
  }),
);

console.log(JSON.stringify({ ok: true, reaction, deal: event.deal }));
log.info(`Published ${reaction} feedback for UPC ${ctx.meta.upc}`);
