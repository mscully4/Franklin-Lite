/**
 * Channel signal handlers — registry of typed handler objects that route
 * Socket Mode inbox events from specific channels into the signals pipeline.
 *
 * To add a new channel: push a handler onto CHANNEL_SIGNAL_HANDLERS.
 * filter-signals.ts iterates the registry automatically — no changes needed there.
 */

// ── Shared types ────────────────────────────────────────────────────────────

/** Shape returned by db.getPendingSlackEvents() */
export interface SlackInboxEvent {
  event_ts: string;
  channel: string;
  channel_type: string;
  user_id: string | null;
  type: string;
  reaction: string | null;
  text: string | null;
  raw: Record<string, unknown>;
  received_at: string;
}

/** Structured entry shape the brain expects for channel-sourced signals */
export interface ChannelEntry {
  id: string;
  source: "ops_alert" | "deploy_approval";
  ts: string;
  channel: string;
  author_id: string;
  text: string;
  permalink: string | null;
  service: string | null;
  deploy_description: string | null;
}

export interface ChannelSignalHandler {
  /** Channel ID to match against */
  channel: string;
  /** Signal source name for the brain (e.g. "slack_deploy") */
  signalSource: string;
  /** Return true if this event should become a signal */
  matches(event: SlackInboxEvent, ownerUserId: string): boolean;
  /** Map raw inbox event to a ChannelEntry for the brain */
  toEntry(event: SlackInboxEvent): ChannelEntry;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

export const TEAM_SERVICES = [
  "credits-manager",
  "developer-dashboard-service",
  "entitlement-service",
  "platform-notifications",
  "wallets-api",
];

export function matchesTeamService(text: string): string | null {
  const lower = text.toLowerCase();
  for (const svc of TEAM_SERVICES) {
    if (lower.includes(svc)) return svc;
  }
  return null;
}

// ── Handler registry ────────────────────────────────────────────────────────
// Deploy-bot is now handled by the deploy_poll scout (state-based polling)
// rather than Socket Mode events. This registry is for future channel handlers.

export const CHANNEL_SIGNAL_HANDLERS: ChannelSignalHandler[] = [];
