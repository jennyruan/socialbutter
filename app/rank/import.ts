// Splits a /rank paste box's raw text into URL tokens (→ /api/calendar/import)
// and residual text (→ the existing parsePastedEvents / parseBusyCalendar).
// Pure and deterministic — no fetch, no React — so it stays testable the same
// way parse.ts is (rank:smoke). The page owns all network calls.

// Client imports the route-side classifiers so "will the import route claim
// this token?" can never drift from the route's own logic. Both libs are
// dependency-free (pure TS; fetch only runs when called).
import { isCalendarSubscriptionUrl } from "@/lib/calendar";
import { parseEventUrls } from "@/lib/luma";
import type { RankableEvent } from "@/lib/agent";
import type { CalendarEvent } from "@/lib/calendar";

export interface SplitResult {
  /** URL tokens in input order: webcal://…, https://…ics, https://lu.ma/<slug>, lu.ma/<slug>. */
  urls: string[];
  /** Everything that is not a URL token — line structure preserved for line-mode parsing. */
  rest: string;
  /** Tokens that looked like a URL but are not a supported import target. Surfaced as a warning, never silently dropped. */
  unsupported: string[];
}

/** Any "scheme:" prefix — https:, webcal:, mailto:, javascript:, … */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):(.*)$/i;
/** Schemes the import route understands. */
const IMPORTABLE_SCHEMES = new Set(["http", "https", "webcal"]);
/** Bare lu.ma/<slug> — scheme-less but unambiguous (spec Amendment 1). */
const BARE_LUMA_RE = /^lu\.ma\/\S+$/i;

type TokenKind = "url" | "unsupported" | "text";

function classifyToken(token: string): TokenKind {
  const m = token.match(SCHEME_RE);
  if (!m) return BARE_LUMA_RE.test(token) ? "url" : "text";
  const [, scheme, after] = m;
  // A colon at the end of a token is prose ("Note:"), not a scheme.
  if (after.length === 0) return "text";
  if (!IMPORTABLE_SCHEMES.has(scheme.toLowerCase())) return "unsupported";
  // The import route claims a scheme'd token as either a calendar
  // subscription or a Luma event URL; anything else it would silently
  // drop, so surface it here instead.
  return isCalendarSubscriptionUrl(token) || parseEventUrls(token).length > 0
    ? "url"
    : "unsupported";
}

/**
 * Split raw paste text into URL tokens and residual text. Line-oriented:
 * lines without URL tokens pass through byte-for-byte (line-mode and JSON
 * parsing see exactly what they saw before); URL tokens are lifted out of
 * their lines. Tokens delimit exactly like the import route tokenizes:
 * runs of whitespace and commas.
 */
export function splitImportInput(raw: string): SplitResult {
  const urls: string[] = [];
  const unsupported: string[] = [];
  const restLines: string[] = [];

  for (const line of raw.split("\n")) {
    const removals: Array<[number, number]> = [];
    let sawUrl = false;
    for (const m of line.matchAll(/[^\s,]+/g)) {
      const kind = classifyToken(m[0]);
      if (kind === "text") continue;
      if (kind === "url") urls.push(m[0]);
      else unsupported.push(m[0]);
      sawUrl = true;
      removals.push([m.index, m.index + m[0].length]);
    }
    if (!sawUrl) {
      restLines.push(line);
      continue;
    }
    // Splice just the URL/unsupported token spans out of the line.
    let residual = "";
    let cursor = 0;
    for (const [start, end] of removals) {
      residual += line.slice(cursor, start);
      cursor = end;
    }
    residual += line.slice(cursor);
    restLines.push(residual);
  }

  return { urls, rest: restLines.join("\n"), unsupported };
}

/**
 * Warning strings for import outcomes — rendered through the page's existing
 * warning channel. Unsupported tokens and per-URL failures are never silent.
 */
export function importWarnings(
  unsupported: string[],
  importErrors: Array<{ url: string; message: string }>,
): string[] {
  const warnings: string[] = [];
  for (const token of unsupported) {
    warnings.push(
      `Couldn't use "${token}" — not a calendar subscription (webcal:// or https://…ics) or a Luma event link.`,
    );
  }
  for (const err of importErrors) {
    warnings.push(`Import failed for ${err.url}: ${err.message}`);
  }
  return warnings;
}

/** CalendarEvent (import route output) → the event shape /api/rank validates. */
export function importedToRankable(e: CalendarEvent): RankableEvent {
  return {
    id: e.id,
    title: e.title,
    host: e.host,
    datetime: e.datetime,
    endDatetime: e.endDatetime,
    url: e.url ?? "",
    location: e.location,
    description: e.description,
    source: e.source,
  };
}
