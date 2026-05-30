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
 * Smart entrypoint: accepts either
 *
 *   (a) a personal Luma iCal subscription URL — `https://api.lu.ma/ics/get?...`
 *       The signed token in the query string IS the user's auth. Pull all
 *       upcoming + past events the user has RSVP'd to or hosts.
 *   (b) one or many Luma event URLs separated by whitespace / commas /
 *       newlines — fetched individually from public event pages.
 *
 * Returns the union of fetched events, deduped by id.
 */
export async function fetchLumaFromInput(input: string): Promise<LumaEvent[]> {
  const trimmed = input.trim();
  if (!trimmed) throw new LumaFetchError("Empty input", input);

  if (isLumaIcsUrl(trimmed)) {
    return fetchLumaEventsFromIcsUrl(trimmed);
  }

  const urls = parseEventUrls(trimmed);
  if (urls.length === 0) {
    throw new LumaFetchError(
      "No Luma input found. Paste either your personal calendar subscription URL (Luma → Settings → Calendar) or one or more event URLs like https://lu.ma/abc123.",
      input,
    );
  }

  return fetchLumaEventsFromUrls(urls);
}

export function isLumaIcsUrl(input: string): boolean {
  try {
    const u = new URL(input.trim());
    return (
      (u.hostname === "api.lu.ma" || u.hostname === "lu.ma") &&
      u.pathname.startsWith("/ics/")
    );
  } catch {
    return false;
  }
}

/**
 * Parse a free-text blob and return any lu.ma / luma.com event URLs in it.
 * Skips profile URLs (`/u/...` or bare username paths) since they need the
 * authed user-events API that isn't public.
 */
export function parseEventUrls(input: string): string[] {
  const tokens = input
    .split(/[\s,]+/)
    .map(t => t.trim())
    .filter(Boolean);

  const urls: string[] = [];
  for (const tok of tokens) {
    const url = normalizeEventUrl(tok);
    if (url) urls.push(url);
  }
  return Array.from(new Set(urls));
}

function normalizeEventUrl(token: string): string | null {
  // Accept bare slugs (≥6 alnum chars, no slash) as short event codes too
  let candidate = token;
  if (!/^https?:\/\//i.test(candidate) && !/^lu\.ma|^luma\.com/i.test(candidate)) {
    // Bare slug like "h7h9r7bw" → treat as short event code
    if (/^[a-zA-Z0-9_-]{4,}$/.test(candidate)) {
      return `${LUMA_BASE}/${candidate}`;
    }
    return null;
  }
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  // Normalize luma.com → lu.ma
  if (u.hostname === "luma.com" || u.hostname === "www.luma.com") {
    u.hostname = "lu.ma";
  }
  if (u.hostname !== "lu.ma" && u.hostname !== "www.lu.ma") return null;
  // Strip query (?tk=, etc.) and trailing slash
  u.search = "";
  u.hash = "";
  const pathSegments = u.pathname.split("/").filter(Boolean);
  if (pathSegments.length === 0) return null;
  // Skip profile URLs explicitly
  if (pathSegments[0] === "u" || pathSegments[0] === "user") return null;
  return u.toString().replace(/\/$/, "");
}

/**
 * Fetch a batch of event URLs in parallel. Failures are surfaced as
 * fetch errors with the offending URL but don't abort the batch — the
 * caller gets back as many successful events as we could pull.
 */
export async function fetchLumaEventsFromUrls(urls: string[]): Promise<LumaEvent[]> {
  const settled = await Promise.allSettled(urls.map(u => fetchLumaEventByUrl(u)));
  const events: LumaEvent[] = [];
  const errors: LumaFetchError[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") {
      events.push(r.value);
    } else {
      errors.push(
        r.reason instanceof LumaFetchError
          ? r.reason
          : new LumaFetchError(String(r.reason), "(unknown)"),
      );
    }
  }
  if (events.length === 0 && errors.length > 0) {
    // Every URL failed — bubble up the first error so the UI can surface it
    throw errors[0];
  }
  return dedupeById(events);
}

/**
 * Fetch the user's full Luma calendar (RSVPs + hosted) via their personal
 * iCal subscription URL. The signed token in the URL acts as auth — no
 * OAuth needed.
 *
 * Returns events derived from VEVENT blocks. URLs and ids come from the
 * URL/UID properties Luma emits.
 */
export async function fetchLumaEventsFromIcsUrl(icsUrl: string): Promise<LumaEvent[]> {
  let res: Response;
  try {
    res = await fetch(icsUrl, {
      headers: {
        "user-agent": UA,
        "accept": "text/calendar, text/plain",
      },
      redirect: "follow",
    });
  } catch (err) {
    throw new LumaFetchError(`Network error fetching iCal: ${(err as Error).message}`, icsUrl);
  }
  if (!res.ok) {
    throw new LumaFetchError(
      `iCal fetch failed (HTTP ${res.status}). Double-check the URL is your personal subscription link from Luma → Settings → Calendar.`,
      icsUrl,
      res.status,
    );
  }
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) {
    throw new LumaFetchError(
      "Response wasn't an iCal feed. The URL needs to be Luma's personal calendar subscription link.",
      icsUrl,
    );
  }
  return parseIcsToEvents(text);
}

function parseIcsToEvents(ics: string): LumaEvent[] {
  const lines = unfoldIcsLines(ics);
  const events: LumaEvent[] = [];
  let current: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
    } else if (line === "END:VEVENT") {
      if (current) {
        const ev = icsBlockToEvent(current);
        if (ev) events.push(ev);
      }
      current = null;
    } else if (current) {
      const sepIdx = line.indexOf(":");
      if (sepIdx === -1) continue;
      const left = line.slice(0, sepIdx);
      const value = decodeIcsText(line.slice(sepIdx + 1));
      // left can be "DTSTART;TZID=America/Los_Angeles" — strip params for key
      const semi = left.indexOf(";");
      const key = semi === -1 ? left : left.slice(0, semi);
      current[key.toUpperCase()] = value;
    }
  }
  return dedupeById(events);
}

function unfoldIcsLines(ics: string): string[] {
  const raw = ics.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if (line.length === 0) continue;
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function decodeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function icsBlockToEvent(block: Record<string, string>): LumaEvent | null {
  const url = block.URL ?? "";
  const summary = block.SUMMARY ?? "";
  const dtstart = block.DTSTART ?? "";
  if (!summary || !dtstart) return null;

  const id = block.UID ?? (url ? deriveIdFromUrl(url) : summary);

  return {
    id: String(id),
    title: summary,
    host: extractHostFromIcsDescription(block.DESCRIPTION ?? "") ?? "Unknown host",
    datetime: icsDateToIso(dtstart),
    endDatetime: block.DTEND ? icsDateToIso(block.DTEND) : undefined,
    url: url || `${LUMA_BASE}/`,
    description: block.DESCRIPTION,
    location: block.LOCATION,
    source: "luma",
    raw: block,
  };
}

function icsDateToIso(value: string): string {
  // Formats: 20260530T130000Z | 20260530T130000 | 20260530
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/);
  if (!m) return value;
  const [, y, mo, d, hh, mm, ss, z] = m;
  if (!hh) return `${y}-${mo}-${d}T00:00:00${z === "Z" ? "Z" : ""}`;
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}${z === "Z" ? "Z" : ""}`;
}

function extractHostFromIcsDescription(desc: string): string | null {
  // Luma's DESCRIPTION often contains "Hosted by <name>" early on
  const m = desc.match(/Hosted by ([^\n]+)/i);
  return m?.[1]?.trim() ?? null;
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
  // organizer can be: string | object | array (Luma puts orgs + people in one array)
  type Org = { name?: string; url?: string; "@type"?: string };
  const orgRaw = item.organizer as string | Org | Array<string | Org> | undefined;
  let organizerName = "Unknown host";
  let organizerUrl: string | undefined;
  if (Array.isArray(orgRaw)) {
    // Pick the first Organization if present, else first Person, else first item.
    const orgs = orgRaw.filter(
      (o): o is Org => typeof o === "object" && o !== null,
    );
    const firstOrg =
      orgs.find(o => o["@type"] === "Organization") ??
      orgs.find(o => o["@type"] === "Person") ??
      orgs[0];
    if (firstOrg) {
      organizerName = firstOrg.name ?? organizerName;
      organizerUrl = firstOrg.url;
    } else if (typeof orgRaw[0] === "string") {
      organizerName = orgRaw[0];
    }
  } else if (typeof orgRaw === "string") {
    organizerName = orgRaw;
  } else if (orgRaw && typeof orgRaw === "object") {
    organizerName = orgRaw.name ?? organizerName;
    organizerUrl = orgRaw.url;
  }

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
    hostUrl: organizerUrl,
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
