// Generic iCalendar (RFC 5545) parser. Source-agnostic.
//
// Used by Luma, Apple iCloud, Google Calendar, and any other provider that
// exposes a public/signed ICS subscription URL. The parser only extracts the
// VEVENT fields SocialButter actually uses; ignores VTIMEZONE/VALARM bodies.

export interface IcsEvent {
  uid: string;
  summary: string;
  dtstart: string;        // ISO 8601 (best-effort from ICS forms)
  dtend?: string;
  url?: string;
  description?: string;
  location?: string;
  organizer?: string;
  /** Raw key/value pairs from the VEVENT block — for source-specific extraction. */
  raw: Record<string, string>;
}

export class IcsFetchError extends Error {
  constructor(message: string, public readonly url: string, public readonly status?: number) {
    super(message);
    this.name = "IcsFetchError";
  }
}

const UA = "Mozilla/5.0 (compatible; SocialButter/0.1; +https://github.com/jennyruan/socialbutter)";

/**
 * Fetch an ICS feed by URL. `webcal://` is rewritten to `https://`.
 * Throws IcsFetchError on network/HTTP/format issues.
 */
export async function fetchIcs(rawUrl: string): Promise<string> {
  const url = normalizeIcsUrl(rawUrl);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "user-agent": UA,
        "accept": "text/calendar, text/plain, */*",
      },
      redirect: "follow",
    });
  } catch (err) {
    throw new IcsFetchError(`Network error fetching iCal: ${(err as Error).message}`, url);
  }
  if (!res.ok) {
    throw new IcsFetchError(`iCal fetch failed (HTTP ${res.status}).`, url, res.status);
  }
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) {
    throw new IcsFetchError(
      "Response wasn't an iCal feed. Confirm the URL is a calendar subscription link.",
      url,
    );
  }
  return text;
}

/** Rewrite `webcal://` (Apple's protocol) to `https://`. */
export function normalizeIcsUrl(input: string): string {
  const trimmed = input.trim();
  if (/^webcal:\/\//i.test(trimmed)) {
    return "https://" + trimmed.slice("webcal://".length);
  }
  return trimmed;
}

/** Parse an ICS text body into VEVENT records. */
export function parseIcs(ics: string): IcsEvent[] {
  const lines = unfoldIcsLines(ics);
  const events: IcsEvent[] = [];
  let current: Record<string, string> | null = null;
  let depth = 0; // ignore nested VALARM blocks
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      depth = 0;
    } else if (line === "END:VEVENT") {
      if (current) {
        const ev = blockToEvent(current);
        if (ev) events.push(ev);
      }
      current = null;
    } else if (current) {
      // Skip nested blocks (VALARM, etc.) — only top-level VEVENT props
      if (line.startsWith("BEGIN:")) { depth++; continue; }
      if (line.startsWith("END:"))   { depth--; continue; }
      if (depth > 0) continue;
      const sepIdx = line.indexOf(":");
      if (sepIdx === -1) continue;
      const left = line.slice(0, sepIdx);
      const value = decodeIcsText(line.slice(sepIdx + 1));
      const semi = left.indexOf(";");
      const key = (semi === -1 ? left : left.slice(0, semi)).toUpperCase();
      // Don't clobber repeated keys; keep first non-empty value
      if (!current[key]) current[key] = value;
    }
  }
  return events;
}

function blockToEvent(block: Record<string, string>): IcsEvent | null {
  const summary = block.SUMMARY ?? "";
  const dtstart = block.DTSTART ?? "";
  if (!summary || !dtstart) return null;
  const uid = block.UID ?? block.URL ?? summary;
  return {
    uid,
    summary,
    dtstart: icsDateToIso(dtstart),
    dtend: block.DTEND ? icsDateToIso(block.DTEND) : undefined,
    url: block.URL,
    description: block.DESCRIPTION,
    location: block.LOCATION,
    organizer: extractOrganizerName(block.ORGANIZER),
    raw: block,
  };
}

/** Unfold RFC 5545 line continuations (lines starting with space/tab). */
export function unfoldIcsLines(ics: string): string[] {
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

export function decodeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** Parse 20260530T130000Z | 20260530T130000 | 20260530 → ISO 8601. */
export function icsDateToIso(value: string): string {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/);
  if (!m) return value;
  const [, y, mo, d, hh, mm, ss, z] = m;
  if (!hh) return `${y}-${mo}-${d}T00:00:00${z === "Z" ? "Z" : ""}`;
  return `${y}-${mo}-${d}T${hh}:${mm}:${ss}${z === "Z" ? "Z" : ""}`;
}

function extractOrganizerName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // ORGANIZER values look like "CN=<name>:mailto:<addr>" or sometimes just
  // "mailto:<addr>" (per RFC 5545). Prefer the CN display name if present.
  const cn = value.match(/CN=([^:;]+)/i);
  if (cn) return cn[1].trim();
  const mailto = value.match(/mailto:([^\s]+)/i);
  if (mailto) return mailto[1].trim();
  return value.trim() || undefined;
}
