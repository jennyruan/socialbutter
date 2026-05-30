// SocialButter agent — ranking + host-intro drafting.
//
// Composes three real systems:
//   1. Luma events  (lib/luma.ts, already real-fetching)
//   2. Evermind memory  (lib/evermind.ts, Terminal B owns)
//   3. An LLM  (any model with a chat-completion HTTP API)
//
// The agent's job is to produce a ranked list where each ranking carries
// a CITATION pointing at the Evermind memory that justified it. The
// citation IS the demo moment — judges see real past feedback being
// retrieved and used.
//
// No mocks. If a dependency isn't wired yet, the call surfaces a clear
// error rather than returning fake data.

import {
  eventsToBusySlots,
  findConflict,
  type CalendarEvent,
} from "./calendar";

// --- Unified rankable types ----------------------------------------------

/**
 * Minimum shape ranking needs. Both LumaEvent and DiscoveredEvent
 * (from lib/social-search.ts) satisfy this structurally so the agent can
 * rank a mixed list across Luma + X + LinkedIn + Google + Apple in one pass.
 */
export interface RankableEvent {
  id: string;
  title: string;
  host?: string;
  datetime?: string;       // ISO if known
  endDatetime?: string;
  url: string;
  location?: string;
  description?: string;
  source?: string;         // "luma" | "x" | "linkedin" | "google" | "apple" | ...
}

/**
 * Minimum shape we need to draft an intro to or rank a person.
 * DiscoveredPerson from lib/social-search.ts satisfies it.
 */
export interface RankablePerson {
  name: string;
  handle?: string;
  url?: string;
  source?: string;          // "x" | "linkedin"
  headline?: string;
  bio?: string;
  location?: string;
  followers?: number;
  recentPosts?: Array<{ text: string; postedAt?: string }>;
}

// --- Public types ---------------------------------------------------------

export interface EvermindMemory {
  id: string;
  content: string;
  createdAt: string;        // ISO
  score?: number;           // similarity score from search
  metadata?: Record<string, unknown>;
}

export interface EvermindClient {
  /** Hybrid-search the user's memories for context relevant to a query. */
  searchMemories(query: string, opts?: { topK?: number }): Promise<EvermindMemory[]>;
  /** Persist a new memory (e.g., user feedback "this event drained me"). */
  addMemory(content: string, metadata?: Record<string, unknown>): Promise<void>;
}

export interface LLMClient {
  /** One-shot chat completion. Returns the model's text. */
  complete(opts: {
    system: string;
    user: string;
    /** Force JSON-mode response when the model supports it. */
    json?: boolean;
    /** Hint how long the output should be. */
    maxTokens?: number;
  }): Promise<string>;
}

export interface Verdict {
  /** "go" — recommended; "skip" — not worth your time; "maybe" — needs more signal. */
  decision: "go" | "skip" | "maybe";
  /** Plain-language reason, <30 words. Reads naturally in a demo card. */
  reason: string;
  /** IDs of Evermind memories that justified this verdict. Drives the on-screen citation chips. */
  citationMemoryIds: string[];
}

export interface RankedEvent {
  event: RankableEvent;
  verdict: Verdict;
}

export interface PersonVerdict {
  /** "meet" — worth reaching out; "skip" — not aligned; "maybe" — needs more signal. */
  decision: "meet" | "skip" | "maybe";
  reason: string;
  citationMemoryIds: string[];
}

export interface RankedPerson {
  person: RankablePerson;
  verdict: PersonVerdict;
}

export interface RankOptions {
  /** What the user is trying to do this week/month. Free text. Steers ranking. */
  goal?: string;
  /** How many memories to retrieve per event for context. Default 5. */
  memoriesPerEvent?: number;
  /**
   * The user's existing calendar (from Apple / Google / Luma subscriptions).
   * Used for hard time-conflict detection — surfaces in the verdict's reason
   * so the demo shows "Skip — conflicts with <calendar event> on <source>".
   */
  busyEvents?: CalendarEvent[];
}

// --- Ranking --------------------------------------------------------------

export async function rankEvents(
  events: RankableEvent[],
  deps: { evermind: EvermindClient; llm: LLMClient },
  options: RankOptions = {},
): Promise<RankedEvent[]> {
  if (events.length === 0) return [];

  const topK = options.memoriesPerEvent ?? 5;

  // Pre-compute calendar conflicts so the LLM can cite them as hard constraints.
  const busyEvents = options.busyEvents ?? [];
  const busySlots = eventsToBusySlots(busyEvents);
  const conflicts = events.map(ev =>
    ev.datetime
      ? findConflict({ datetime: ev.datetime, endDatetime: ev.endDatetime }, busySlots, busyEvents)
      : null,
  );

  // Pull relevant memory context for each event in parallel.
  const memoryBundles = await Promise.all(
    events.map(async (ev, i) => {
      const query = `${ev.title}${ev.host ? ` hosted by ${ev.host}` : ""}${ev.location ? ` in ${ev.location}` : ""}`;
      const memories = await deps.evermind.searchMemories(query, { topK });
      return { event: ev, memories, conflict: conflicts[i] };
    }),
  );

  // One LLM call ranks the full batch — keeps reasoning consistent across events
  // and gives the model the ability to compare them.
  const systemPrompt = `You are SocialButter, an agent that decides which networking events a busy founder should attend. Be opinionated. Lean on the user's past feedback. HARD RULE: if an event has a CALENDAR CONFLICT, decision MUST be "skip" and the reason MUST cite the conflicting calendar event by name and source. For each event, output a JSON object with:
  - "id": echo of the event id
  - "decision": "go" | "skip" | "maybe"
  - "reason": ONE plain-language sentence, under 30 words, citing past feedback or the calendar conflict
  - "citationMemoryIds": array of memory ids that justified the decision (empty array if none applied)

Return JSON: {"verdicts": [{...}, {...}, ...]} — in the same order as the input.`;

  const userPrompt = buildRankingUserPrompt(memoryBundles, options.goal);

  const raw = await deps.llm.complete({
    system: systemPrompt,
    user: userPrompt,
    json: true,
    maxTokens: 800,
  });

  const verdicts = parseVerdictsJSON(raw, events);

  return events.map((ev, i) => ({
    event: ev,
    verdict: verdicts[i],
  }));
}

function buildRankingUserPrompt(
  bundles: Array<{ event: RankableEvent; memories: EvermindMemory[]; conflict: CalendarEvent | null }>,
  goal: string | undefined,
): string {
  const goalLine = goal
    ? `User's goal right now: ${goal.trim()}\n\n`
    : "";

  const eventBlocks = bundles
    .map(({ event, memories, conflict }) => {
      const memoryLines =
        memories.length === 0
          ? "  (no past feedback found that's relevant to this event)"
          : memories
              .map(
                m =>
                  `  - [${m.id}] ${truncate(m.content, 220)}` +
                  (typeof m.score === "number" ? ` (similarity: ${m.score.toFixed(2)})` : ""),
              )
              .join("\n");

      const conflictLine = conflict
        ? `\nCALENDAR CONFLICT: overlaps "${conflict.title}" at ${conflict.datetime} on ${conflict.sourceLabel}. You MUST decide "skip" and cite this in the reason.`
        : "";

      return `EVENT id=${event.id} [source=${event.source ?? "unknown"}]
title: ${event.title}
host:  ${event.host ?? "(unknown)"}
when:  ${event.datetime ?? "(unspecified)"}${event.endDatetime ? ` → ${event.endDatetime}` : ""}
where: ${event.location ?? "(unspecified)"}
desc:  ${truncate(event.description ?? "", 300)}${conflictLine}

relevant past feedback:
${memoryLines}`;
    })
    .join("\n\n---\n\n");

  return `${goalLine}Rate each event below. Cite memory ids in citationMemoryIds when their content drove your decision.

${eventBlocks}`;
}

function parseVerdictsJSON(raw: string, events: RankableEvent[]): Verdict[] {
  // Tolerate code-fence wrapping and chatty preambles
  const json = extractJSONBlob(raw);
  let parsed: { verdicts?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`LLM returned malformed JSON: ${(err as Error).message}\n---raw---\n${raw}`);
  }
  const verdicts = parsed.verdicts ?? [];

  // Re-align to the input order by event.id; fill gaps with "maybe"
  const byId = new Map<string, Verdict>();
  for (const v of verdicts) {
    const id = String(v.id ?? "");
    if (!id) continue;
    byId.set(id, {
      decision: normalizeDecision(v.decision),
      reason: String(v.reason ?? "").trim() || "No reasoning provided.",
      citationMemoryIds: Array.isArray(v.citationMemoryIds)
        ? v.citationMemoryIds.map(String)
        : [],
    });
  }

  return events.map(
    e =>
      byId.get(e.id) ?? {
        decision: "maybe",
        reason: "Agent did not return a verdict for this event.",
        citationMemoryIds: [],
      },
  );
}

function normalizeDecision(d: unknown): Verdict["decision"] {
  const s = String(d ?? "").toLowerCase();
  if (s === "go" || s === "skip" || s === "maybe") return s;
  return "maybe";
}

// --- Host intro draft -----------------------------------------------------

export async function draftHostIntro(
  event: RankableEvent,
  deps: { evermind: EvermindClient; llm: LLMClient },
): Promise<string> {
  const query = `intro message to event host ${event.host ?? ""} for ${event.title}`;
  const memories = await deps.evermind.searchMemories(query, { topK: 6 });

  const systemPrompt = `You draft warm, specific intro messages from a solo founder reaching out to an event host. The user's voice is direct, plays-to-win, and lightly playful. Keep it under 100 words. Always include WHY the user wants to meet this host (use memory context when present). Never invent facts about the host or the user. Output the message body only — no salutation guidance, no "Dear", no signature. Plain text, no markdown.`;

  const memoryBlock =
    memories.length === 0
      ? "(no relevant past feedback or relationships in memory)"
      : memories
          .map((m, i) => `[${i + 1}] ${truncate(m.content, 240)}`)
          .join("\n");

  const userPrompt = `Draft an intro message to the host of this event.

Event: ${event.title}
Host:  ${event.host ?? "(unknown)"}
When:  ${event.datetime ?? "(unspecified)"}
Where: ${event.location ?? "(unspecified)"}
Description: ${truncate(event.description ?? "", 400)}

User's relevant past feedback / context:
${memoryBlock}`;

  const draft = await deps.llm.complete({
    system: systemPrompt,
    user: userPrompt,
    maxTokens: 240,
  });

  return draft.trim();
}

/**
 * Draft an outreach DM to a specific person (X or LinkedIn lookup result).
 * Optional event context lets the agent say "I'm going to be at <event> —
 * want to meet up?" when there's a relevant overlap.
 */
export async function draftPersonIntro(
  person: RankablePerson,
  context: { event?: RankableEvent; goal?: string },
  deps: { evermind: EvermindClient; llm: LLMClient },
): Promise<string> {
  const queryParts = [person.name];
  if (person.headline) queryParts.push(person.headline);
  if (context.event) queryParts.push(`event: ${context.event.title}`);
  if (context.goal) queryParts.push(`goal: ${context.goal}`);
  const memories = await deps.evermind.searchMemories(queryParts.join(" — "), { topK: 6 });

  const systemPrompt = `You draft warm, specific direct messages from a solo founder reaching out to someone they just found on X or LinkedIn. The user's voice is direct, plays-to-win, and lightly playful. Under 80 words. Always include WHY this person specifically — cite something from their headline, bio, or recent post when present. If there's relevant past feedback in memory, weave it in. Never invent facts. Output the message body only, plain text, no salutation/signature/markdown.`;

  const memoryBlock =
    memories.length === 0
      ? "(no relevant past feedback in memory)"
      : memories.map((m, i) => `[${i + 1}] ${truncate(m.content, 220)}`).join("\n");

  const recentPostsBlock = person.recentPosts && person.recentPosts.length > 0
    ? "\nTheir recent posts (most recent first):\n" +
      person.recentPosts.slice(0, 3).map((p, i) => `  [post ${i + 1}] ${truncate(p.text, 200)}`).join("\n")
    : "";

  const eventBlock = context.event
    ? `\nShared event context: I'll be at "${context.event.title}" (${context.event.datetime ?? "tbd"}) — anchor the ask around this when natural.`
    : "";

  const goalLine = context.goal ? `\nUser's current goal: ${context.goal.trim()}` : "";

  const userPrompt = `Draft an intro DM to this person.

Person
  Name:     ${person.name}
  Handle:   ${person.handle ?? "(unknown)"}
  Platform: ${person.source ?? "(unknown)"}
  Headline: ${person.headline ?? "(none)"}
  Bio:      ${truncate(person.bio ?? "(none)", 320)}
  Location: ${person.location ?? "(unknown)"}${recentPostsBlock}${eventBlock}${goalLine}

User's relevant past feedback / context:
${memoryBlock}`;

  const draft = await deps.llm.complete({
    system: systemPrompt,
    user: userPrompt,
    maxTokens: 220,
  });

  return draft.trim();
}

// --- People ranking (attendees / "who should I meet at this event") -------

export async function rankPeople(
  people: RankablePerson[],
  deps: { evermind: EvermindClient; llm: LLMClient },
  options: { goal?: string; eventContext?: RankableEvent; memoriesPerPerson?: number } = {},
): Promise<RankedPerson[]> {
  if (people.length === 0) return [];

  const topK = options.memoriesPerPerson ?? 4;

  const memoryBundles = await Promise.all(
    people.map(async (p) => {
      const query = `${p.name}${p.headline ? ` — ${p.headline}` : ""}${p.bio ? ` — ${truncate(p.bio, 80)}` : ""}`;
      const memories = await deps.evermind.searchMemories(query, { topK });
      return { person: p, memories };
    }),
  );

  const eventLine = options.eventContext
    ? `\nEvent context: "${options.eventContext.title}" at ${options.eventContext.location ?? "(unspecified)"} on ${options.eventContext.datetime ?? "tbd"}`
    : "";
  const goalLine = options.goal ? `\nUser's current goal: ${options.goal.trim()}` : "";

  const systemPrompt = `You decide which people a solo founder should reach out to. Be opinionated. Lean on past feedback patterns (who they've clicked with, who drained them). For each person output JSON:
  - "name": echo of the person's name
  - "decision": "meet" | "skip" | "maybe"
  - "reason": ONE plain-language sentence, under 30 words. Cite past feedback when applicable.
  - "citationMemoryIds": array of memory ids that justified the decision (empty if none).

Return JSON: {"verdicts": [...]} — in the input order.`;

  const personBlocks = memoryBundles.map(({ person, memories }) => {
    const memLines =
      memories.length === 0
        ? "  (no relevant past feedback)"
        : memories.map(m => `  - [${m.id}] ${truncate(m.content, 220)}`).join("\n");
    return `PERSON name="${person.name}" [platform=${person.source ?? "?"}]
  headline: ${person.headline ?? "(none)"}
  bio:      ${truncate(person.bio ?? "(none)", 260)}
  location: ${person.location ?? "(unknown)"}
  followers: ${person.followers ?? "(unknown)"}

relevant past feedback:
${memLines}`;
  }).join("\n\n---\n\n");

  const userPrompt = `${eventLine}${goalLine}\n\nRate each person.\n\n${personBlocks}`;

  const raw = await deps.llm.complete({
    system: systemPrompt,
    user: userPrompt,
    json: true,
    maxTokens: 800,
  });

  const json = extractJSONBlob(raw);
  let parsed: { verdicts?: Array<Record<string, unknown>> };
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`LLM returned malformed JSON for people ranking: ${(err as Error).message}\n${raw}`);
  }
  const verdictsArr = parsed.verdicts ?? [];
  const byName = new Map<string, PersonVerdict>();
  for (const v of verdictsArr) {
    const name = String(v.name ?? "");
    if (!name) continue;
    byName.set(name.toLowerCase(), {
      decision: normalizePersonDecision(v.decision),
      reason: String(v.reason ?? "").trim() || "No reasoning provided.",
      citationMemoryIds: Array.isArray(v.citationMemoryIds)
        ? v.citationMemoryIds.map(String)
        : [],
    });
  }

  return people.map(p => ({
    person: p,
    verdict: byName.get(p.name.toLowerCase()) ?? {
      decision: "maybe",
      reason: "Agent did not return a verdict for this person.",
      citationMemoryIds: [],
    },
  }));
}

function normalizePersonDecision(d: unknown): PersonVerdict["decision"] {
  const s = String(d ?? "").toLowerCase();
  if (s === "meet" || s === "skip" || s === "maybe") return s;
  return "maybe";
}

// --- Feedback ingestion ---------------------------------------------------

/**
 * Persist the user's reaction to an event ("good rec" / "bad rec" /
 * post-event review) into Evermind so future rankings get sharper.
 */
export async function recordFeedback(
  event: RankableEvent,
  feedback: { sentiment: "positive" | "negative" | "neutral"; note?: string },
  deps: { evermind: EvermindClient },
): Promise<void> {
  const verbal = feedback.sentiment === "positive"
    ? "I clicked with"
    : feedback.sentiment === "negative"
      ? "I did not click with"
      : "I attended";

  const content = `${verbal} the event "${event.title}"${event.host ? ` hosted by ${event.host}` : ""}${event.datetime ? ` on ${event.datetime}` : ""}.${feedback.note ? ` Note: ${feedback.note}` : ""}`;

  await deps.evermind.addMemory(content, {
    source: "socialbutter.feedback",
    event_id: event.id,
    event_url: event.url,
    sentiment: feedback.sentiment,
  });
}

// --- Helpers --------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function extractJSONBlob(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1);
  }
  return raw.trim();
}
