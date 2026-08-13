// Offline heuristic event scorer — deterministic, no network, no vendors.
//
// Encodes the founder's stated event strategy so SocialButter can score events
// WITHOUT any LLM/Evermind keys (a prior for the LLM, and a working fallback
// when keys are absent):
//
//   • Small events (<= SMALL_MAX attendees) are worth it ONLY if the room holds
//     high-value people (e.g. investors). Otherwise the odds don't justify the
//     time → skip.
//   • Large events (>= LARGE_MIN attendees) → go: better odds of a useful
//     connection even without curation.
//   • Mid-size or unknown size → maybe (needs a human/LLM look).
//   • A hard calendar conflict forces skip regardless of fit.
//   • A goal-keyword hit in the title/description is a positive signal.
//
// The strategy inputs (attendeeCount, highValueAttendees, goalKeywords,
// busyEvents) are NOT part of RankableEvent — they are enrichment the caller
// supplies via opts. This keeps the event contract clean and the function pure.

import type { RankableEvent } from "./agent";
import { eventsToBusySlots, findConflict, type CalendarEvent } from "./calendar";

// --- Tunable constants (kept explicit so smoke tests stay stable) ----------
export const SMALL_MAX = 60; // <= this is a "small" curated-only room
export const LARGE_MIN = 150; // >= this is a "large" better-odds room
export const KEYWORD_BOOST = 12;
export const CLAMP_MIN = 0;
export const CLAMP_MAX = 100;

export type HeuristicDecision = "go" | "maybe" | "skip";

export interface ScoreEventHeuristicOptions {
  /** Known/estimated attendee count. Undefined → size is unknown. */
  attendeeCount?: number;
  /** True when the room is known to hold high-value people (investors, etc.). */
  highValueAttendees?: boolean;
  /** Lowercased-compared keywords tied to the founder's current goals. */
  goalKeywords?: string[];
  /** Calendar events to check for a hard time conflict. */
  busyEvents?: CalendarEvent[];
}

export interface HeuristicScore {
  decision: HeuristicDecision;
  /** 0–100, deterministic. Higher = more worth attending. */
  score: number;
  pros: string[];
  cons: string[];
}

function clamp(n: number): number {
  return Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, Math.round(n)));
}

function keywordHit(event: RankableEvent, goalKeywords?: string[]): string | null {
  if (!goalKeywords || goalKeywords.length === 0) return null;
  const hay = `${event.title ?? ""} ${event.description ?? ""}`.toLowerCase();
  for (const kw of goalKeywords) {
    const k = kw.trim().toLowerCase();
    if (k && hay.includes(k)) return kw;
  }
  return null;
}

/**
 * Score one event against the founder's strategy. Pure + deterministic.
 * pros/cons are pushed in a stable order so assertions are reliable.
 */
export function scoreEventHeuristic(
  event: RankableEvent,
  opts: ScoreEventHeuristicOptions = {},
): HeuristicScore {
  const pros: string[] = [];
  const cons: string[] = [];

  // 1. Hard calendar conflict → skip, short-circuit.
  if (opts.busyEvents && opts.busyEvents.length > 0 && event.datetime) {
    const busy = eventsToBusySlots(opts.busyEvents);
    const conflict = findConflict(
      { datetime: event.datetime, endDatetime: event.endDatetime },
      busy,
      opts.busyEvents,
    );
    if (conflict) {
      cons.push(`Time conflict with "${conflict.title}"`);
      return { decision: "skip", score: clamp(0), pros, cons };
    }
  }

  // 2. Size × attendee-value rule → base decision + score.
  const n = opts.attendeeCount;
  let decision: HeuristicDecision;
  let score: number;

  if (n === undefined) {
    decision = "maybe";
    score = 50;
    cons.push("Attendee count unknown — needs a closer look");
  } else if (n <= SMALL_MAX) {
    if (opts.highValueAttendees) {
      decision = "go";
      score = 82;
      pros.push(`Small room (${n}) but high-value attendees — high signal`);
    } else {
      decision = "skip";
      score = 25;
      cons.push(`Small room (${n}) without high-value attendees — low odds`);
    }
  } else if (n >= LARGE_MIN) {
    decision = "go";
    score = 70;
    pros.push(`Large event (${n}) — good odds of a useful connection`);
    if (opts.highValueAttendees) {
      score = 88;
      pros.push("High-value attendees present");
    }
  } else {
    decision = "maybe";
    score = 55;
    cons.push(`Mid-size event (${n}) — worth a look but not a clear yes`);
    if (opts.highValueAttendees) {
      decision = "go";
      score = 72;
      pros.push("High-value attendees present");
    }
  }

  // 3. Goal-keyword signal → boost + possibly lift a "maybe" to "go".
  const hit = keywordHit(event, opts.goalKeywords);
  if (hit) {
    pros.push(`Matches your goal keyword "${hit}"`);
    score += KEYWORD_BOOST;
    if (decision === "maybe" && score >= 65) decision = "go";
  }

  return { decision, score: clamp(score), pros, cons };
}
