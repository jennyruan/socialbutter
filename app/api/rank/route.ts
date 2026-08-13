import { NextResponse } from "next/server";
// Type-only import so the heuristic path never loads lib/agent (or its
// transitive vendor clients). rankEvents is imported dynamically in the LLM path.
import type { RankableEvent, RankedEvent } from "@/lib/agent";
import type { CalendarEvent } from "@/lib/calendar";
import { scoreEventHeuristic, type ScoreEventHeuristicOptions } from "@/lib/heuristic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface RankBody {
  events?: RankableEvent[];
  goal?: string;
  goalKeywords?: string[];
  busyEvents?: CalendarEvent[];
  /** Per-event strategy enrichment (attendeeCount, highValueAttendees, ...), keyed by event id. */
  enrichment?: Record<string, ScoreEventHeuristicOptions>;
  /** Force the offline heuristic path (skips all LLM/Evermind calls). */
  heuristicOnly?: boolean;
}

function haveVendorKeys(): boolean {
  return Boolean(process.env.LLM_API_KEY) && Boolean(process.env.EVERMIND_API_KEY);
}

/**
 * Deterministic, vendor-free ranking. Returns exactly RankedEvent[] — the SAME
 * item shape as the LLM path (no extra per-item fields). The heuristic score is
 * used only to order results, then dropped so the response shape is identical.
 */
function rankHeuristic(body: RankBody, events: RankableEvent[]): RankedEvent[] {
  const rankOf = (d: string) => (d === "go" ? 2 : d === "maybe" ? 1 : 0);
  return events
    .map((event) => {
      const opts: ScoreEventHeuristicOptions = {
        goalKeywords: body.goalKeywords,
        busyEvents: body.busyEvents,
        ...(body.enrichment?.[event.id] ?? {}),
      };
      const h = scoreEventHeuristic(event, opts);
      const detail = [...h.pros, ...h.cons];
      const reason = detail.length > 0 ? detail.join("; ") : h.decision === "go" ? "Worth your time" : "Not a clear yes";
      const ranked: RankedEvent = { event, verdict: { decision: h.decision, reason, citationMemoryIds: [] } };
      return { ranked, score: h.score };
    })
    // Best first: go > maybe > skip, then by score.
    .sort((a, b) => rankOf(b.ranked.verdict.decision) - rankOf(a.ranked.verdict.decision) || b.score - a.score)
    .map((x) => x.ranked);
}

export async function POST(req: Request) {
  let body: RankBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) {
    return NextResponse.json({ error: "Missing or empty 'events' array" }, { status: 400 });
  }

  // Offline heuristic path — explicit, or automatic fallback when vendor keys
  // are absent (so the endpoint works without an LLM/Evermind account).
  if (body.heuristicOnly || !haveVendorKeys()) {
    const ranked = rankHeuristic(body, events);
    return NextResponse.json({ ranked, count: ranked.length, rankingSource: "heuristic" });
  }

  try {
    // Deferred imports so the vendor path (and lib/agent) is only loaded when
    // actually used — the heuristic path above never touches vendor code.
    const { rankEvents } = await import("@/lib/agent");
    const { getEvermind } = await import("@/lib/evermind");
    const { getLLM } = await import("@/lib/llm");
    const ranked = await rankEvents(
      events,
      { evermind: getEvermind(), llm: getLLM() },
      { goal: body.goal, busyEvents: body.busyEvents },
    );
    return NextResponse.json({ ranked, count: ranked.length, rankingSource: "llm" });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
