#!/usr/bin/env npx tsx
/**
 * Calendar scout — fetches today's events via gws CLI.
 * Writes results to state/scout_results/calendar.json.
 *
 * Tracks events by ID. State in franklin.db:
 *   id = "calendar:event:<event_id>"
 *   state = { start, end, title }
 *
 * Usage: npx tsx scripts/scouts/calendar.ts
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { openDb } from "../db.js";
import { createLogger } from "../logger.js";
const log = createLogger("calendar");

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const RESULT_FILE = join(ROOT, "state", "scout_results", "calendar.json");
const STATE_FILE = join(ROOT, "state", "calendar.json");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CalendarEntry {
  id: string;           // "calendar:event:<event_id>"
  event_id: string;
  title: string;
  start: string;        // ISO 8601
  end: string;          // ISO 8601
  calendar: string;
  location: string;
  meetingUrl: string;   // Google Meet, Zoom, or other conference URL
  attendees: string[];
  transcript_available: boolean;
  conference_record: string | null;
  transcript_name: string | null;
}

interface GwsEvent {
  id?: string;
  summary?: string;
  start?: string | { dateTime?: string; date?: string };
  end?: string | { dateTime?: string; date?: string };
  calendar?: string;
  location?: string;
  attendees?: Array<{ email?: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTime(val: string | { dateTime?: string; date?: string } | undefined): string {
  if (!val) return "";
  if (typeof val === "string") return val;
  return val.dateTime ?? val.date ?? "";
}

function runGws(args: string): GwsEvent[] {
  try {
    const raw = execSync(`gws calendar +agenda ${args} --format json`, {
      timeout: 30_000,
    }).toString();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : (parsed.events ?? []);
  } catch {
    return [];
  }
}

// ── Transcript discovery ─────────────────────────────────────────────────────

interface ConferenceRecord {
  name: string;
  startTime?: string;
  endTime?: string;
}

interface Transcript {
  name: string;
  startTime?: string;
}

/**
 * Find conference records that overlap with the given time window.
 * Returns the conference record name (e.g. "conferenceRecords/abc123").
 */
function findConferenceRecord(startIso: string, endIso: string, errors: string[]): string | null {
  try {
    const filter = `start_time>="${startIso}" AND start_time<="${endIso}"`;
    const raw = execSync(
      `gws meet conferenceRecords list --params 'filter=${filter}' --format json`,
      { timeout: 15_000 },
    ).toString();
    const parsed = JSON.parse(raw);
    const records: ConferenceRecord[] = parsed.conferenceRecords ?? (Array.isArray(parsed) ? parsed : []);
    return records.length > 0 ? records[0].name : null;
  } catch (e: unknown) {
    errors.push(`meet lookup: ${(e as Error).message?.slice(0, 100)}`);
    return null;
  }
}

/**
 * Check if a transcript exists for a conference record.
 * Returns the transcript name if found, null otherwise.
 */
function findTranscript(conferenceRecord: string, errors: string[]): string | null {
  try {
    const raw = execSync(
      `gws meet conferenceRecords transcripts list --params 'parent=${conferenceRecord}' --format json`,
      { timeout: 15_000 },
    ).toString();
    const parsed = JSON.parse(raw);
    const transcripts: Transcript[] = parsed.transcripts ?? (Array.isArray(parsed) ? parsed : []);
    return transcripts.length > 0 ? transcripts[0].name : null;
  } catch {
    // No transcript — not an error, just not available
    return null;
  }
}

// ── Meeting URL extraction ──────────────────────────────────────────────────

interface RawCalendarEvent {
  id?: string;
  summary?: string;
  hangoutLink?: string;
  location?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
}

/**
 * Fetch raw Calendar API events to get hangoutLink/conferenceData that +agenda strips.
 * Returns a map of event summary (title) → meeting URL, since +agenda doesn't return event IDs.
 */
function fetchMeetingUrls(dateFlag: string, errors: string[]): Map<string, string> {
  const urls = new Map<string, string>();
  try {
    const now = new Date();
    let timeMin: string, timeMax: string;
    if (dateFlag === "--today") {
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      const end = new Date(now); end.setHours(23, 59, 59, 999);
      timeMin = start.toISOString();
      timeMax = end.toISOString();
    } else {
      const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
      const start = new Date(tomorrow); start.setHours(0, 0, 0, 0);
      const end = new Date(tomorrow); end.setHours(23, 59, 59, 999);
      timeMin = start.toISOString();
      timeMax = end.toISOString();
    }
    const params = JSON.stringify({ calendarId: "primary", timeMin, timeMax, singleEvents: true, orderBy: "startTime" });
    const raw = execSync(`gws calendar events list --params '${params}' --format json`, { timeout: 15_000 }).toString();
    const parsed = JSON.parse(raw);
    const items: RawCalendarEvent[] = parsed.items ?? (Array.isArray(parsed) ? parsed : []);
    for (const item of items) {
      const summary = item.summary ?? "";
      if (!summary) continue;
      const url = item.hangoutLink
        ?? item.conferenceData?.entryPoints?.find(ep => ep.entryPointType === "video")?.uri
        ?? (item.location?.startsWith("http") ? item.location : "");
      if (url) urls.set(summary, url);
    }
  } catch (e: unknown) {
    errors.push(`raw-api ${dateFlag}: ${(e as Error).message?.slice(0, 100)}`);
  }
  return urls;
}

/**
 * Extract meeting URL from location or pre-fetched raw data.
 */
function extractMeetingUrl(location: string, title: string, rawUrls: Map<string, string>): string {
  // Check raw API data first (has hangoutLink)
  const raw = rawUrls.get(title);
  if (raw) return raw;
  // Fall back to location if it looks like a URL
  if (location.startsWith("http")) return location;
  return "";
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const collectedAt = new Date().toISOString();
  const errors: string[] = [];
  const entries: CalendarEntry[] = [];
  const seen = new Set<string>();

  // Fetch today only
  for (const flag of ["--today"]) {
    // Get meeting URLs from raw API (hangoutLink, conferenceData)
    const rawUrls = fetchMeetingUrls(flag, errors);

    let events: GwsEvent[];
    try {
      events = runGws(flag);
    } catch (e: unknown) {
      errors.push(`${flag}: ${(e as Error).message?.slice(0, 150)}`);
      continue;
    }

    for (const evt of events) {
      const eventId = evt.id ?? evt.summary ?? "";
      if (!eventId || seen.has(eventId)) continue;
      seen.add(eventId);

      const location = evt.location ?? "";
      entries.push({
        id: `calendar:event:${eventId}`,
        event_id: eventId,
        title: evt.summary ?? "(no title)",
        start: parseTime(evt.start),
        end: parseTime(evt.end),
        calendar: evt.calendar ?? "",
        location,
        meetingUrl: extractMeetingUrl(location, evt.summary ?? "", rawUrls),
        attendees: (evt.attendees ?? []).map((a) => a.email ?? "").filter(Boolean),
        transcript_available: false,
        conference_record: null,
        transcript_name: null,
      });
    }
  }

  // Sort by start time
  entries.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  // Check for transcripts on meetings that ended in the last 2 hours
  const now = Date.now();
  const transcriptWindow = 2 * 60 * 60_000;

  // Preserve transcript data from previous scout result
  const prevResult = (() => {
    try { return JSON.parse(readFileSync(RESULT_FILE, "utf8")); }
    catch { return { entries: [] }; }
  })();
  const prevTranscripts = new Map<string, { conference_record: string | null; transcript_name: string | null }>();
  for (const e of prevResult.entries ?? []) {
    if (e.transcript_available) {
      prevTranscripts.set(e.event_id, { conference_record: e.conference_record, transcript_name: e.transcript_name });
    }
  }

  for (const entry of entries) {
    const endTime = new Date(entry.end).getTime();
    if (!entry.end || isNaN(endTime)) continue;

    // Already discovered transcript from a previous run
    const prev = prevTranscripts.get(entry.event_id);
    if (prev) {
      entry.transcript_available = true;
      entry.conference_record = prev.conference_record;
      entry.transcript_name = prev.transcript_name;
      continue;
    }

    // Only check meetings that ended recently (not future, not too old)
    if (endTime > now || now - endTime > transcriptWindow) continue;

    const confRecord = findConferenceRecord(entry.start, entry.end, errors);
    if (!confRecord) continue;

    entry.conference_record = confRecord;
    const transcript = findTranscript(confRecord, errors);
    if (transcript) {
      entry.transcript_available = true;
      entry.transcript_name = transcript;
      log.info(`Transcript found for "${entry.title}": ${transcript}`);
    }
  }

  // Write scout result
  const result = {
    scout: "calendar",
    collected_at: collectedAt,
    status: errors.length === 0 ? "ok" : "error",
    error: errors.length > 0 ? errors.join("; ") : null,
    entries,
  };

  mkdirSync(join(ROOT, "state", "scout_results"), { recursive: true });
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));

  // Write state/calendar.json for dashboard and pre-meeting alerts
  const nowLocal = new Date();
  const today = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, "0")}-${String(nowLocal.getDate()).padStart(2, "0")}`;
  const prevState = (() => {
    try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); }
    catch { return { date: "", events: [] }; }
  })();

  // Preserve notified flags from previous state
  const prevNotified = new Map<string, boolean>();
  if (prevState.date === today) {
    for (const e of prevState.events ?? []) {
      prevNotified.set(e.id ?? e.title, e.notified ?? false);
    }
  }

  const calendarState = {
    date: today,
    events: entries.map((e) => ({
      id: e.event_id,
      title: e.title,
      start: e.start,
      end: e.end,
      attendees: e.attendees,
      location: e.location,
      meetingUrl: e.meetingUrl,
      notified: prevNotified.get(e.event_id) ?? false,
      transcript_available: e.transcript_available,
      conference_record: e.conference_record,
      transcript_name: e.transcript_name,
    })),
  };
  writeFileSync(STATE_FILE, JSON.stringify(calendarState, null, 2));

  // Upsert into DB
  const db = openDb();
  for (const entry of entries) {
    db.upsertSeen(entry.id, "calendar");
  }
  const pruned = db.pruneStale("calendar", 3);
  db.close();

  log.info(`${entries.length} events, ${errors.length} errors, ${pruned} pruned -> ${RESULT_FILE}`);
}

main();
