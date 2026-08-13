import { NextResponse } from "next/server";
// Type-only import so the heuristic path never loads lib/agent (or its
// transitive vendor clients). rankEvents is imported dynamically in the LLM path.
import type { RankableEvent, RankedEvent, Verdict } from "@/lib/agent";
import type { CalendarEvent } from "@/lib/calendar";
import { parseStrictInstant } from "@/lib/calendar";
import { scoreEventHeuristic, type ScoreEventHeuristicOptions } from "@/lib/heuristic";
import { normalizeUrl } from "@/lib/url-safe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// --- Hard limits (the trust boundary) ------------------------------------
const BODY_BYTE_CAP = 1_048_576; // 1 MB raw bytes, enforced BEFORE JSON.parse
const MAX_EVENTS = 200;

// Busy-calendar trust boundary.
const MAX_BUSY = 1000; // checked-entry cap; overflow ⇒ busyTruncated:true
const CAP_BUSY_TITLE = 200; // a giant pasted title can't be amplified into conflict.title
const CAP_BUSY_SHORT = 500; // id / host / source / sourceLabel

// Field length caps (graceful truncation, never rejection).
const CAP_TITLE = 500;
const CAP_URL = 2048;
const CAP_SHORT = 500; // host / location / source / datetime / endDatetime
const CAP_DESC = 2000;

/**
 * Extended response item. Backward compatible: `event` + `verdict` are the
 * pre-existing keys /connect reads; `decision`/`score`/`pros`/`cons` are added.
 * On the heuristic path score is an integer [0,100] and pros/cons are real.
 * On the LLM path score is null and pros/cons are [] (never fabricated).
 */
interface RankedItem {
  event: RankableEvent;
  verdict: Verdict;
  decision: "go" | "maybe" | "skip";
  score: number | null;
  pros: string[];
  cons: string[];
  /** The colliding busy entry, or null when no hard conflict / not checked. */
  conflict: { title: string; datetime: string } | null;
  /** True only when a busy calendar was sent AND the event's time was placeable. */
  conflictChecked: boolean;
}

/** Busy-calendar normalization result — carries honest accounting for the response. */
interface BusyResult {
  events: CalendarEvent[];
  /** How many entries actually participated in conflict detection. */
  considered: number;
  /** How many entries were dropped as invalid (unparseable / date-only / offset-less). */
  skipped: number;
  /** True when more than MAX_BUSY entries were sent (overflow silently unused). */
  truncated: boolean;
}

interface RankBody {
  events?: unknown;
  goal?: unknown;
  goalKeywords?: unknown;
  busyEvents?: unknown;
  enrichment?: unknown;
  heuristicOnly?: unknown;
}

class BodyTooLargeError extends Error {}

function haveVendorKeys(): boolean {
  return Boolean(process.env.LLM_API_KEY) && Boolean(process.env.EVERMIND_API_KEY);
}

/**
 * Read the request body under a hard raw-byte cap, WITHOUT trusting
 * Content-Length. Throws BodyTooLargeError as soon as the cap is exceeded —
 * before any JSON.parse — whether or not a Content-Length header is present.
 */
async function readBodyCapped(req: Request): Promise<string> {
  const body = req.body;
  if (!body) {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > BODY_BYTE_CAP) throw new BodyTooLargeError();
    return text;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > BODY_BYTE_CAP) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError();
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Optional string field: keep only if a string, drop otherwise, then cap. */
function optString(v: unknown, cap: number): string | undefined {
  return typeof v === "string" ? truncate(v, cap) : undefined;
}

/**
 * Validate + normalize one raw event at the server trust boundary.
 * Returns the normalized event, or an error string (⇒ HTTP 400) for the
 * hard-required fields (id, title).
 */
function normalizeEvent(raw: unknown): { event: RankableEvent } | { error: string } {
  if (!isPlainObject(raw)) return { error: "Each event must be an object" };

  const id = raw.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    return { error: "Each event needs a non-empty string 'id'" };
  }

  const title = raw.title;
  if (typeof title !== "string" || title.trim().length === 0) {
    return { error: "Each event needs a non-empty string 'title'" };
  }

  const event: RankableEvent = {
    id,
    title: truncate(title, CAP_TITLE),
    url: truncate(normalizeUrl(raw.url), CAP_URL), // scheme-checked → "" if unsafe; capped at 2048
  };
  const host = optString(raw.host, CAP_SHORT);
  if (host !== undefined) event.host = host;
  const location = optString(raw.location, CAP_SHORT);
  if (location !== undefined) event.location = location;
  const source = optString(raw.source, CAP_SHORT);
  if (source !== undefined) event.source = source;
  const datetime = optString(raw.datetime, CAP_SHORT);
  if (datetime !== undefined) event.datetime = datetime;
  const endDatetime = optString(raw.endDatetime, CAP_SHORT);
  if (endDatetime !== undefined) event.endDatetime = endDatetime;
  const description = optString(raw.description, CAP_DESC);
  if (description !== undefined) event.description = description;

  return { event };
}

/** Keep only well-typed enrichment signals; ignore hostile shapes silently. */
function normalizeEnrichment(raw: unknown): Record<string, ScoreEventHeuristicOptions> {
  const out: Record<string, ScoreEventHeuristicOptions> = {};
  if (!isPlainObject(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (!isPlainObject(v)) continue;
    const opts: ScoreEventHeuristicOptions = {};
    if (typeof v.attendeeCount === "number" && Number.isFinite(v.attendeeCount) && v.attendeeCount >= 0) {
      opts.attendeeCount = v.attendeeCount;
    }
    if (typeof v.highValueAttendees === "boolean") {
      opts.highValueAttendees = v.highValueAttendees;
    }
    out[id] = opts;
  }
  return out;
}

function normalizeGoalKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === "string");
}

/**
 * Normalize the busy calendar at the trust boundary. Per-entry validation
 * (never index-misaligned, never throws):
 *  - Only the first MAX_BUSY entries are checked; overflow ⇒ truncated:true.
 *  - `datetime` MUST be a strict instant (explicit time + offset). Date-only
 *    (`2026-09-04`) and offset-less (`2026-09-04T18:00`) values are dropped and
 *    counted in `skipped` — no silent midnight slot, no server-TZ ambiguity.
 *  - `endDatetime` that is not a strict instant is treated as ABSENT (→ the
 *    slot's window falls back to start+1h), never parsed in server TZ.
 *  - Every string field is length-capped (title ≤ 200) so a giant pasted title
 *    can't be echoed/amplified into the response.
 */
function normalizeBusyEvents(raw: unknown): BusyResult {
  if (!Array.isArray(raw)) return { events: [], considered: 0, skipped: 0, truncated: false };
  const truncated = raw.length > MAX_BUSY;
  const slice = truncated ? raw.slice(0, MAX_BUSY) : raw;
  const events: CalendarEvent[] = [];
  let skipped = 0;
  for (const e of slice) {
    if (!isPlainObject(e) || parseStrictInstant(e.datetime) === null) {
      skipped++;
      continue;
    }
    const endStrict =
      typeof e.endDatetime === "string" && parseStrictInstant(e.endDatetime) !== null
        ? e.endDatetime
        : undefined;
    events.push({
      id: typeof e.id === "string" ? truncate(e.id, CAP_BUSY_SHORT) : "",
      title:
        typeof e.title === "string" && e.title.trim()
          ? truncate(e.title, CAP_BUSY_TITLE)
          : "a calendar event",
      host: typeof e.host === "string" ? truncate(e.host, CAP_BUSY_SHORT) : "",
      datetime: e.datetime as string,
      endDatetime: endStrict,
      source: (typeof e.source === "string" ? truncate(e.source, CAP_BUSY_SHORT) : "ics") as CalendarEvent["source"],
      sourceLabel: typeof e.sourceLabel === "string" ? truncate(e.sourceLabel, CAP_BUSY_SHORT) : "Calendar",
    });
  }
  return { events, considered: events.length, skipped, truncated };
}

/**
 * Deterministic, vendor-free ranking → extended RankedItem[].
 * Ordering: decision rank (go>maybe>skip), then score desc, ties broken by
 * original input index (stable), exactly one output item per input event.
 */
function rankHeuristic(
  events: RankableEvent[],
  goalKeywords: string[],
  busyEvents: CalendarEvent[],
  enrichment: Record<string, ScoreEventHeuristicOptions>,
): RankedItem[] {
  const rankOf = (d: string) => (d === "go" ? 2 : d === "maybe" ? 1 : 0);
  return events
    .map((event, index) => {
      const opts: ScoreEventHeuristicOptions = {
        goalKeywords,
        busyEvents,
        ...(enrichment[event.id] ?? {}),
      };
      const h = scoreEventHeuristic(event, opts);
      const detail = [...h.pros, ...h.cons];
      const reason =
        detail.length > 0
          ? detail.join("; ")
          : h.decision === "go"
            ? "Worth your time"
            : "Not a clear yes";
      const item: RankedItem = {
        event,
        verdict: { decision: h.decision, reason, citationMemoryIds: [] },
        decision: h.decision,
        score: h.score,
        pros: h.pros,
        cons: h.cons,
        conflict: h.conflict,
        conflictChecked: h.conflictChecked,
      };
      return { item, score: h.score, index };
    })
    .sort(
      (a, b) =>
        rankOf(b.item.decision) - rankOf(a.item.decision) ||
        b.score - a.score ||
        a.index - b.index,
    )
    .map((x) => x.item);
}

export async function POST(req: Request) {
  // 1. Pre-parse byte cap (does NOT trust Content-Length).
  let text: string;
  try {
    text = await readBodyCapped(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json({ error: "Request body too large (max 1 MB)" }, { status: 413 });
    }
    return NextResponse.json({ error: "Could not read request body" }, { status: 400 });
  }

  // 2. Parse.
  let body: RankBody;
  try {
    body = JSON.parse(text) as RankBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isPlainObject(body)) {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
  }

  // 3. events must be an array (missing ⇒ 400). Empty array is a valid 200.
  if (!Array.isArray(body.events)) {
    return NextResponse.json({ error: "Missing 'events' array" }, { status: 400 });
  }
  const rawEvents = body.events;

  const heuristicOnly = body.heuristicOnly === true;
  const useHeuristic = heuristicOnly || !haveVendorKeys();
  const rankingSource = useHeuristic ? "heuristic" : "llm";

  // Busy-calendar accounting is present on EVERY 200 path (empty / heuristic /
  // LLM) so the client always sees a consistent shape — defaults to 0/false/0
  // when no busyEvents were sent.
  const busy = normalizeBusyEvents(body.busyEvents);
  const busyMeta = {
    busyConsidered: busy.considered,
    busyTruncated: busy.truncated,
    busySkipped: busy.skipped,
  };

  if (rawEvents.length === 0) {
    return NextResponse.json({ ranked: [], count: 0, rankingSource, ...busyMeta });
  }
  if (rawEvents.length > MAX_EVENTS) {
    return NextResponse.json(
      { error: `Too many events (max ${MAX_EVENTS})` },
      { status: 413 },
    );
  }

  // 4. Normalize + validate every event (server is the trust boundary).
  const events: RankableEvent[] = [];
  const seenIds = new Set<string>();
  for (const raw of rawEvents) {
    const res = normalizeEvent(raw);
    if ("error" in res) {
      return NextResponse.json({ error: res.error }, { status: 400 });
    }
    if (seenIds.has(res.event.id)) {
      return NextResponse.json(
        { error: `Duplicate event id "${res.event.id}" — ids must be unique` },
        { status: 400 },
      );
    }
    seenIds.add(res.event.id);
    events.push(res.event);
  }

  const goalKeywords = normalizeGoalKeywords(body.goalKeywords);
  const busyEvents = busy.events;
  const enrichment = normalizeEnrichment(body.enrichment);

  // 5a. Offline heuristic path — authoritative decision/score/pros/cons.
  if (useHeuristic) {
    const ranked = rankHeuristic(events, goalKeywords, busyEvents, enrichment);
    return NextResponse.json({ ranked, count: ranked.length, rankingSource: "heuristic", ...busyMeta });
  }

  // 5b. LLM path — preserve input order; never fabricate a numeric score.
  try {
    const { rankEvents } = await import("@/lib/agent");
    const { getEvermind } = await import("@/lib/evermind");
    const { getLLM } = await import("@/lib/llm");
    const rankedEvents: RankedEvent[] = await rankEvents(
      events,
      { evermind: getEvermind(), llm: getLLM() },
      { goal: typeof body.goal === "string" ? body.goal : undefined, busyEvents },
    );
    const ranked: RankedItem[] = rankedEvents.map((r) => ({
      event: r.event,
      verdict: r.verdict,
      decision: r.verdict.decision,
      score: null,
      pros: [],
      cons: [],
      // The vendor path keeps its own conflict handling inside verdict.reason;
      // this slice wires the structured conflict field only on the heuristic
      // path that /rank uses. Shape stays consistent via null / false.
      conflict: null,
      conflictChecked: false,
    }));
    return NextResponse.json({ ranked, count: ranked.length, rankingSource: "llm", ...busyMeta });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
