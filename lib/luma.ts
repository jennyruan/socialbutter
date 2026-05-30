// Luma fetcher — real data only.
//
// Pulls upcoming/past events for a Luma user OR a single event by URL, by
// scraping the public lu.ma pages. Three extraction strategies in order:
//
//   1. __NEXT_DATA__ blob (Luma is a Next.js app; richest payload)
//   2. JSON-LD <script type="application/ld+json"> (schema.org Event)
//   3. OG meta tags (last-resort fallback for title/description)
//
// No fixtures, no mocks (per CLAUDE.md §2).

const LUMA_BASE = "https://lu.ma";
const UA = "Mozilla/5.0 (compatible; ButterSocial/0.1; +https://github.com/jennyruan/buttersocial)";

export interface LumaEvent {
  id: string;
  title: string;
  host: string;
  hostUrl?: string;
  datetime: string;        // ISO 8601
  endDatetime?: string;
  url: string;
  description?: string;
  location?: string;
  source: "luma";
  coverUrl?: string;
  tags?: string[];
  raw?: Record<string, unknown>;
}

export class LumaFetchError extends Error {
  constructor(message: string, public readonly url: string, public readonly status?: number) {
    super(message);
    this.name = "LumaFetchError";
  }
}

// --- Public entrypoints --------------------------------------------------

/**
 * Smart entrypoint: accepts a bare username, profile URL, or event URL and
 * dispatches to the right fetcher.
 *
 *   "jennyruan"                           → fetchLumaUserEvents
 *   "https://lu.ma/jennyruan"             → fetchLumaUserEvents
 *   "lu.ma/jennyruan"                     → fetchLumaUserEvents
 *   "https://lu.ma/abc123"                → fetchLumaEventByUrl (single event)
 *   "https://lu.ma/event/evt-xyz/abc123"  → fetchLumaEventByUrl
 */
export async function fetchLumaFromInput(input: string): Promise<LumaEvent[]> {
  const cleaned = input.trim().replace(/^https?:\/\//, "").replace(/^lu\.ma\//, "");
  if (!cleaned) throw new LumaFetchError("Empty input", input);

  // Event URLs typically contain `/event/` segment or a short slug AFTER user;
  // Luma's permalink scheme isn't perfectly deterministic, so we try user-first
  // and fall back to event-fetch on empty results.
  const segments = cleaned.split("/").filter(Boolean);

  // Heuristic: if first segment is `event` or `e` it's an event link
  if (segments[0] === "event" || segments[0] === "e") {
    const url = `${LUMA_BASE}/${segments.join("/")}`;
    const ev = await fetchLumaEventByUrl(url);
    return [ev];
  }

  // Otherwise try treating it as a username
  const username = segments[0];
  try {
    const events = await fetchLumaUserEvents(username);
    if (events.length > 0) return events;
  } catch (err) {
    // fall through to single-event attempt
  }

  // Fallback: treat as a short event slug
  const url = `${LUMA_BASE}/${segments.join("/")}`;
  const ev = await fetchLumaEventByUrl(url);
  return [ev];
}

/**
 * Fetch all public upcoming + past events for a Luma user by username.
 */
export async function fetchLumaUserEvents(username: string): Promise<LumaEvent[]> {
  const profileUrl = `${LUMA_BASE}/${encodeURIComponent(username)}`;
  const html = await fetchHtml(profileUrl);

  const nextData = extractNextData(html);
  if (nextData) {
    const events = extractEventsFromNextData(nextData);
    if (events.length > 0) return events;
  }

  // If __NEXT_DATA__ didn't yield anything, fall back to JSON-LD list
  const jsonLdEvents = extractJsonLdEvents(html, profileUrl);
  if (jsonLdEvents.length > 0) return jsonLdEvents;

  throw new LumaFetchError(
    `Could not extract any events from ${profileUrl}. Profile may be empty or Luma's page shape changed.`,
    profileUrl,
  );
}

/**
 * Fetch a single Luma event by its full URL.
 */
export async function fetchLumaEventByUrl(url: string): Promise<LumaEvent> {
  const html = await fetchHtml(url);

  // Try __NEXT_DATA__ first — it has organizer, location, description
  const nextData = extractNextData(html);
  if (nextData) {
    const events = extractEventsFromNextData(nextData);
    if (events.length > 0) {
      const match = events.find(e => e.url === url || url.includes(e.id));
      return match ?? events[0];
    }
  }

  // JSON-LD fallback
  const jsonLdEvents = extractJsonLdEvents(html, url);
  if (jsonLdEvents.length > 0) return jsonLdEvents[0];

  // OG-tags final fallback
  return ogTagsToEvent(html, url);
}

// --- HTTP ---------------------------------------------------------------

async function fetchHtml(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "user-agent": UA,
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
  } catch (err) {
    throw new LumaFetchError(`Network error: ${(err as Error).message}`, url);
  }
  if (!res.ok) {
    throw new LumaFetchError(`HTTP ${res.status}`, url, res.status);
  }
  return res.text();
}

// --- Extraction: __NEXT_DATA__ -------------------------------------------

function extractNextData(html: string): unknown | null {
  // Greedy-but-bounded match; the script tag's content can be many MB
  const match = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractEventsFromNextData(data: unknown): LumaEvent[] {
  const found: LumaEvent[] = [];
  const visited = new WeakSet<object>();
  const stack: unknown[] = [data];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (visited.has(node as object)) continue;
    visited.add(node as object);

    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }

    const obj = node as Record<string, unknown>;
    if (looksLikeLumaEvent(obj)) {
      const ev = normalizeLumaEventObject(obj);
      if (ev) found.push(ev);
    }
    for (const value of Object.values(obj)) stack.push(value);
  }

  return dedupeById(found);
}

function looksLikeLumaEvent(obj: Record<string, unknown>): boolean {
  const name = obj.name ?? obj.title;
  const start = obj.start_at ?? obj.startAt ?? obj.start_time ?? obj.start;
  // Must look like a calendar entity, not just any object with a name
  return typeof name === "string" && typeof start === "string" && start.length > 4;
}

function normalizeLumaEventObject(obj: Record<string, unknown>): LumaEvent | null {
  const apiId = (obj.api_id ?? obj.id) as string | undefined;
  const slug = (obj.url ?? obj.slug) as string | undefined;

  const idCandidate = apiId ?? slug;
  if (!idCandidate) return null;

  // Build canonical URL
  let url: string;
  if (typeof slug === "string" && slug.startsWith("http")) {
    url = slug;
  } else if (typeof slug === "string") {
    url = `${LUMA_BASE}/${slug.replace(/^\//, "")}`;
  } else {
    url = `${LUMA_BASE}/${idCandidate}`;
  }

  const host =
    (obj.host_name as string | undefined) ??
    ((obj.hosts as Array<{ name?: string }> | undefined)?.[0]?.name) ??
    ((obj.calendar as { name?: string } | undefined)?.name) ??
    ((obj.organizer as { name?: string } | undefined)?.name) ??
    "Unknown host";

  const location = pickLocation(obj);

  return {
    id: String(idCandidate),
    title: String(obj.name ?? obj.title ?? "Untitled"),
    host: String(host),
    hostUrl: obj.host_url as string | undefined,
    datetime: String(obj.start_at ?? obj.startAt ?? obj.start_time ?? obj.start),
    endDatetime: (obj.end_at ?? obj.endAt ?? obj.end_time ?? obj.end) as string | undefined,
    url,
    description: (obj.description ?? obj.tagline) as string | undefined,
    location,
    source: "luma",
    coverUrl: (obj.cover_url ?? obj.cover ?? obj.image_url) as string | undefined,
    raw: obj,
  };
}

function pickLocation(obj: Record<string, unknown>): string | undefined {
  const geo = obj.geo_address_info as { full_address?: string; address?: string } | undefined;
  if (geo?.full_address) return geo.full_address;
  if (geo?.address) return geo.address;
  if (typeof obj.location === "string") return obj.location;
  const loc = obj.location as { name?: string; address?: string } | undefined;
  if (loc?.name) return loc.name;
  if (loc?.address) return loc.address;
  return undefined;
}

// --- Extraction: JSON-LD --------------------------------------------------

function extractJsonLdEvents(html: string, sourceUrl: string): LumaEvent[] {
  const events: LumaEvent[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    try {
      const parsed = JSON.parse(match[1]);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const t = item["@type"];
        const types = Array.isArray(t) ? t : [t];
        if (types.some((x: unknown) => typeof x === "string" && x.toLowerCase().includes("event"))) {
          events.push(jsonLdToEvent(item, sourceUrl));
        }
      }
    } catch {
      // skip malformed json-ld
    }
  }
  return dedupeById(events);
}

function jsonLdToEvent(item: Record<string, unknown>, sourceUrl: string): LumaEvent {
  const organizer = item.organizer as { name?: string; url?: string } | string | undefined;
  const organizerName =
    typeof organizer === "string"
      ? organizer
      : organizer?.name ?? "Unknown host";

  let locationStr: string | undefined;
  const loc = item.location;
  if (typeof loc === "string") {
    locationStr = loc;
  } else if (loc && typeof loc === "object") {
    const l = loc as { name?: string; address?: { streetAddress?: string } | string };
    if (typeof l.address === "string") locationStr = l.address;
    else if (l.address?.streetAddress) locationStr = l.address.streetAddress;
    else locationStr = l.name;
  }

  const urlField = item.url as string | undefined;
  const url = urlField ?? sourceUrl;

  return {
    id: deriveIdFromUrl(url),
    title: String(item.name ?? "Untitled"),
    host: organizerName,
    hostUrl: typeof organizer === "object" ? organizer?.url : undefined,
    datetime: String(item.startDate ?? ""),
    endDatetime: item.endDate as string | undefined,
    url,
    description: item.description as string | undefined,
    location: locationStr,
    source: "luma",
    coverUrl: item.image as string | undefined,
    raw: item,
  };
}

// --- Extraction: OG tags (last-resort) -----------------------------------

function ogTagsToEvent(html: string, sourceUrl: string): LumaEvent {
  return {
    id: deriveIdFromUrl(sourceUrl),
    title: metaContent(html, "og:title") ?? "Untitled",
    host: "Unknown host",
    datetime: "",
    url: sourceUrl,
    description: metaContent(html, "og:description"),
    coverUrl: metaContent(html, "og:image"),
    source: "luma",
  };
}

function metaContent(html: string, property: string): string | undefined {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escapeRegex(property)}["'][^>]+content=["']([^"']*)["']`,
    "i",
  );
  const m = html.match(re);
  return m?.[1];
}

// --- Helpers --------------------------------------------------------------

function deriveIdFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? url;
  } catch {
    return url;
  }
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
