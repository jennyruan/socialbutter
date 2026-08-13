// Pure parser for the /rank paste control. No React, no network — testable.
//
// Accepts EITHER:
//   (a) a JSON array of event objects (each must include a `title`), OR
//   (b) one event per non-blank line: `Title` optionally ` @ Location`
//       and ` | <ISO datetime>`. Only Title is required.
//
// Each parsed event gets a stable, unique id = "paste-<index>" in input order.
// Duplicate titles are kept as distinct events. No fabricated/sample data — an
// empty or blank input yields zero events (the caller shows an empty state).

export interface ParsedEvent {
  id: string;
  title: string;
  url: string;
  datetime?: string;
  location?: string;
}

export interface ParseResult {
  events: ParsedEvent[];
  error: string | null;
}

export function parsePastedEvents(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { events: [], error: null };

  if (trimmed.startsWith("[")) return parseJsonMode(trimmed);
  return parseLineMode(raw);
}

function parseJsonMode(trimmed: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return { events: [], error: "That doesn't look like valid JSON. Check for a stray comma or quote." };
  }
  if (!Array.isArray(data)) {
    return { events: [], error: "JSON must be an array of event objects." };
  }
  const events: ParsedEvent[] = [];
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { events: [], error: `Item ${i + 1} is not an event object.` };
    }
    const rec = item as Record<string, unknown>;
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    if (!title) {
      return { events: [], error: `Item ${i + 1} is missing a "title".` };
    }
    const ev: ParsedEvent = {
      id: `paste-${i}`,
      title,
      url: typeof rec.url === "string" ? rec.url : "",
    };
    if (typeof rec.datetime === "string" && rec.datetime.trim()) ev.datetime = rec.datetime.trim();
    if (typeof rec.location === "string" && rec.location.trim()) ev.location = rec.location.trim();
    events.push(ev);
  }
  return { events, error: null };
}

function parseLineMode(raw: string): ParseResult {
  const lines = raw.split("\n");
  const events: ParsedEvent[] = [];
  let index = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue; // blank lines ignored
    let rest = t;
    let datetime: string | undefined;
    let location: string | undefined;

    const pipe = rest.lastIndexOf(" | ");
    if (pipe !== -1) {
      const dt = rest.slice(pipe + 3).trim();
      if (dt) datetime = dt;
      rest = rest.slice(0, pipe).trim();
    }
    const at = rest.lastIndexOf(" @ ");
    if (at !== -1) {
      const loc = rest.slice(at + 3).trim();
      if (loc) location = loc;
      rest = rest.slice(0, at).trim();
    }
    const title = rest.trim();
    if (!title) continue;

    const ev: ParsedEvent = { id: `paste-${index}`, title, url: "" };
    if (datetime) ev.datetime = datetime;
    if (location) ev.location = location;
    events.push(ev);
    index++;
  }
  return { events, error: null };
}
