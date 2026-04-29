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
  source: string;
  ts: string;
  channel: string;
  author_id: string;
  text: string;
  permalink: string | null;
  service: string | null;
}

export interface ChannelSignalHandler {
  /** Channel ID to match against */
  channel: string;
  /** Signal source name for the brain */
  signalSource: string;
  /** Return true if this event should become a signal */
  matches(event: SlackInboxEvent, ownerUserId: string): boolean;
  /** Map raw inbox event to a ChannelEntry for the brain */
  toEntry(event: SlackInboxEvent): ChannelEntry;
}

// ── Handler registry ────────────────────────────────────────────────────────

export const CHANNEL_SIGNAL_HANDLERS: ChannelSignalHandler[] = [];
