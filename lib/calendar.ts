// Multi-source calendar fetcher.
//
// Detects whether a subscription URL is Luma, Apple iCloud, Google Calendar,
// or a generic ICS feed, fetches it, and returns events normalized to a
// single CalendarEvent shape. No OAuth — relies on the same signed
// subscription URLs each provider already gives users.
//
// Apple Calendar:  System Settings → Apple Account → iCloud → Calendar
//                  Share Calendar → Public Calendar → copy webcal:// URL.
// Google Calendar: Settings → [calendar] → Integrate calendar → Secret
//                  address in iCal format.
// Luma:            Settings → Calendar → api.lu.ma/ics/... URL.
//
// No mocks anywhere (CLAUDE.md §2).

import { fetchIcs, parseIcs, normalizeIcsUrl, IcsFetchError, type IcsEvent } from "./ics";

export type CalendarSource = "luma" | "apple" | "google" | "ics";

export interface CalendarEvent {
  id: string;
  title: string;
  host: string;
  datetime: string;        // ISO 8601 start
  endDatetime?: string;
  url?: string;
  description?: string;
  location?: string;
  source: CalendarSource;
  /** Domain the ICS feed came from — for citing the source in UI/agent output. */
  sourceLabel: string;
  raw?: Record<string, string>;
}

export class CalendarFetchError extends Error {
  constructor(message: string, public readonly url: string, public readonly status?: number) {
    super(message);
    this.name = "CalendarFetchError";
  }
}

// --- Source detection ----------------------------------------------------

/**
 * Classify a subscription URL by host. Falls back to generic "ics" when the
 * URL looks like a calendar feed (webcal:// or path ending in .ics) but the
 * host isn't one we recognize.
 */
export function detectSource(rawUrl: string): { source: CalendarSource; sourceLabel: string } | null {
  const url = normalizeIcsUrl(rawUrl);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();

  if (host === "api.lu.ma" || host === "lu.ma") {
    // On lu.ma hosts, only ICS-feed paths are calendar subscriptions
    // (api.lu.ma/ics/get?... — the only live ICS shape; lu.ma/<anything>
    // serves HTML). Any other path is an event page and must reach the Luma
    // event fetcher instead — fetching it as ICS fails with "Response wasn't
    // an iCal feed". Matches lib/luma.ts isLumaIcsUrl's feed shape.
    if (u.pathname.toLowerCase().startsWith("/ics/")) {
      return { source: "luma", sourceLabel: "Luma" };
    }
    return null;
  }
  if (host.endsWith(".icloud.com") || host === "icloud.com") {
    return { source: "apple", sourceLabel: "Apple Calendar" };
  }
  if (host === "calendar.google.com") {
    return { source: "google", sourceLabel: "Google Calendar" };
  }
  // Last-resort: looks like an ICS feed by shape
  if (/^webcal:/i.test(rawUrl.trim()) || u.pathname.toLowerCase().endsWith(".ics")) {
    return { source: "ics", sourceLabel: host };
  }
  return null;
}

export function isCalendarSubscriptionUrl(input: string): boolean {
  return detectSource(input) !== null;
}

// --- Fetch + normalize ---------------------------------------------------

/**
 * Fetch any supported calendar subscription URL and normalize to CalendarEvent[].
 * Throws CalendarFetchError on detection failure; surfaces fetch errors as
 * CalendarFetchError too (originating IcsFetchError is wrapped for one error type).
 */
export async function fetchCalendarFromUrl(rawUrl: string): Promise<CalendarEvent[]> {
  const detected = detectSource(rawUrl);
  if (!detected) {
    throw new CalendarFetchError(
      "URL doesn't look like a calendar subscription. Expected a webcal:// URL or an https URL ending in .ics (Apple, Google, or Luma).",
      rawUrl,
    );
  }
  const normalized = normalizeIcsUrl(rawUrl);
  let ics: string;
  try {
    ics = await fetchIcs(normalized);
  } catch (err) {
    if (err instanceof IcsFetchError) {
      throw new CalendarFetchError(err.message, err.url, err.status);
    }
    throw err;
  }
  const parsed = parseIcs(ics);
  return parsed.map(e => icsToCalendarEvent(e, detected.source, detected.sourceLabel));
}

/**
 * Fetch many calendar URLs in parallel. Surfaces per-URL errors but returns
 * events from any that succeeded.
 */
export async function fetchCalendarFromUrls(urls: string[]): Promise<{
  events: CalendarEvent[];
  errors: Array<{ url: string; message: string }>;
}> {
  const settled = await Promise.allSettled(urls.map(u => fetchCalendarFromUrl(u)));
  const events: CalendarEvent[] = [];
  const errors: Array<{ url: string; message: string }> = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "fulfilled") {
      events.push(...r.value);
    } else {
      const reason = r.reason;
      errors.push({
        url: urls[i],
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }
  return { events: dedupeById(events), errors };
}

function icsToCalendarEvent(
  e: IcsEvent,
  source: CalendarSource,
  sourceLabel: string,
): CalendarEvent {
  // Source-specific host extraction
  let host = e.organizer ?? "Unknown";
  if (source === "luma") {
    const m = (e.description ?? "").match(/Hosted by ([^\n]+)/i);
    if (m) host = m[1].trim();
  }

  return {
    id: e.uid,
    title: e.summary,
    host,
    datetime: e.dtstart,
    endDatetime: e.dtend,
    url: e.url,
    description: e.description,
    location: e.location,
    source,
    sourceLabel,
    raw: e.raw,
  };
}

function dedupeById(items: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>();
  const out: CalendarEvent[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

// --- Conflict detection (used by agent ranking) --------------------------

const HOUR_MS = 60 * 60 * 1000;

/**
 * A busy window carrying its OWN source event. Pairing the parsed range with
 * its event (instead of a parallel `busyEvents[i]` array) removes the
 * index-alignment footgun: `eventsToBusySlots` skips unparseable entries, so
 * any caller relying on positional mapping would name the WRONG colliding
 * event. Here the slot is self-describing, so conflict naming is correct for
 * every caller (route + agent).
 */
export interface BusySlot {
  start: number;
  end: number;
  event: CalendarEvent;
}

/**
 * Parse an ISO datetime to epoch ms ONLY when it is unambiguous — it must
 * carry an explicit time component (`THH:MM`) AND an explicit timezone offset
 * (`Z` or `±HH:MM`). Date-only (`2026-09-04`) and offset-less/naive
 * (`2026-09-04T18:00`) strings return `null`: the former would silently become
 * a midnight slot, the latter would be interpreted in the SERVER's timezone and
 * produce false or missed conflicts when mixed with offset-bearing calendar
 * data. Requiring the offset makes every compared instant absolute.
 */
const STRICT_INSTANT_RE = /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

export function parseStrictInstant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!STRICT_INSTANT_RE.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

/** True when a datetime is precise enough (time + offset) to place on a timeline. */
export function isPlaceable(datetime: unknown): boolean {
  return parseStrictInstant(datetime) !== null;
}

/**
 * Build the end of a time window. Falls back to `start + 1h` when the end is
 * missing, unparseable, offset-less/date-only, OR inverted/zero-length
 * (`end <= start`) — so a malformed end can never MISS a real overlap.
 */
function windowEnd(start: number, endDatetime: unknown): number {
  const end = parseStrictInstant(endDatetime);
  if (end === null || end <= start) return start + HOUR_MS;
  return end;
}

/**
 * Convert calendar events to self-describing busy slots. Entries whose start is
 * not a strict instant (time + offset) are skipped — they can't be placed on a
 * timeline unambiguously, so they cannot form a conflict.
 */
export function eventsToBusySlots(events: CalendarEvent[]): BusySlot[] {
  const slots: BusySlot[] = [];
  for (const e of events) {
    const start = parseStrictInstant(e.datetime);
    if (start === null) continue;
    slots.push({ start, end: windowEnd(start, e.endDatetime), event: e });
  }
  return slots;
}

/**
 * Find the first busy slot that overlaps the candidate's time window. Returns
 * that slot's OWN event (no positional index mapping), so the named colliding
 * entry is always correct. Returns `null` when the candidate has no placeable
 * start (caller should treat this as "not conflict-checked", not "all clear").
 */
export function findConflict(
  candidate: { datetime?: string; endDatetime?: string },
  slots: BusySlot[],
): CalendarEvent | null {
  const start = parseStrictInstant(candidate.datetime);
  if (start === null) return null;
  const end = windowEnd(start, candidate.endDatetime);
  for (const slot of slots) {
    if (start < slot.end && end > slot.start) return slot.event;
  }
  return null;
}
