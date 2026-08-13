import { NextResponse } from "next/server";
// Type-only import so the heuristic path never loads lib/agent (or its
// transitive vendor clients). rankEvents is imported dynamically in the LLM path.
import type { RankableEvent, RankedEvent, Verdict } from "@/lib/agent";
import type { CalendarEvent } from "@/lib/calendar";
import { scoreEventHeuristic, type ScoreEventHeuristicOptions } from "@/lib/heuristic";
import { normalizeUrl } from "@/lib/url-safe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// --- Hard limits (the trust boundary) ------------------------------------
const BODY_BYTE_CAP = 1_048_576; // 1 MB raw bytes, enforced BEFORE JSON.parse
const MAX_EVENTS = 200;

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
    url: normalizeUrl(raw.url), // scheme-checked server-side → "" if unsafe
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

/** Drop malformed calendar entries per-entry (never index-misaligned). */
function normalizeBusyEvents(raw: unknown): CalendarEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: CalendarEvent[] = [];
  for (const e of raw) {
    if (!isPlainObject(e)) continue;
    if (typeof e.datetime !== "string" || Number.isNaN(Date.parse(e.datetime))) continue;
    out.push({
      id: typeof e.id === "string" ? e.id : "",
      title: typeof e.title === "string" && e.title.trim() ? e.title : "a calendar event",
      host: typeof e.host === "string" ? e.host : "",
      datetime: e.datetime,
      endDatetime: typeof e.endDatetime === "string" ? e.endDatetime : undefined,
      source: (typeof e.source === "string" ? e.source : "ics") as CalendarEvent["source"],
      sourceLabel: typeof e.sourceLabel === "string" ? e.sourceLabel : "Calendar",
    });
  }
  return out;
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

  if (rawEvents.length === 0) {
    return NextResponse.json({ ranked: [], count: 0, rankingSource });
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
  const busyEvents = normalizeBusyEvents(body.busyEvents);
  const enrichment = normalizeEnrichment(body.enrichment);

  // 5a. Offline heuristic path — authoritative decision/score/pros/cons.
  if (useHeuristic) {
    const ranked = rankHeuristic(events, goalKeywords, busyEvents, enrichment);
    return NextResponse.json({ ranked, count: ranked.length, rankingSource: "heuristic" });
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
    }));
    return NextResponse.json({ ranked, count: ranked.length, rankingSource: "llm" });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
