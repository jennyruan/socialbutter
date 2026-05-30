// ButterSocial agent — ranking + host-intro drafting.
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

import type { LumaEvent } from "./luma";

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
  event: LumaEvent;
  verdict: Verdict;
}

export interface RankOptions {
  /** What the user is trying to do this week/month. Free text. Steers ranking. */
  goal?: string;
  /** How many memories to retrieve per event for context. Default 5. */
  memoriesPerEvent?: number;
}

// --- Ranking --------------------------------------------------------------

export async function rankEvents(
  events: LumaEvent[],
  deps: { evermind: EvermindClient; llm: LLMClient },
  options: RankOptions = {},
): Promise<RankedEvent[]> {
  if (events.length === 0) return [];

  const topK = options.memoriesPerEvent ?? 5;

  // Pull relevant memory context for each event in parallel.
  const memoryBundles = await Promise.all(
    events.map(async ev => {
      const query = `${ev.title} hosted by ${ev.host}${ev.location ? ` in ${ev.location}` : ""}`;
      const memories = await deps.evermind.searchMemories(query, { topK });
      return { event: ev, memories };
    }),
  );

  // One LLM call ranks the full batch — keeps reasoning consistent across events
  // and gives the model the ability to compare them.
  const systemPrompt = `You are ButterSocial, an agent that decides which networking events a busy founder should attend. Be opinionated. Lean on the user's past feedback. For each event, output a JSON object with:
  - "id": echo of the event id
  - "decision": "go" | "skip" | "maybe"
  - "reason": ONE plain-language sentence, under 30 words, that cites the user's past feedback when applicable
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
  bundles: Array<{ event: LumaEvent; memories: EvermindMemory[] }>,
  goal: string | undefined,
): string {
  const goalLine = goal
    ? `User's goal right now: ${goal.trim()}\n\n`
    : "";

  const eventBlocks = bundles
    .map(({ event, memories }) => {
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

      return `EVENT id=${event.id}
title: ${event.title}
host:  ${event.host}
when:  ${event.datetime}${event.endDatetime ? ` → ${event.endDatetime}` : ""}
where: ${event.location ?? "(unspecified)"}
desc:  ${truncate(event.description ?? "", 300)}

relevant past feedback:
${memoryLines}`;
    })
    .join("\n\n---\n\n");

  return `${goalLine}Rate each event below. Cite memory ids in citationMemoryIds when their content drove your decision.

${eventBlocks}`;
}

function parseVerdictsJSON(raw: string, events: LumaEvent[]): Verdict[] {
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
  event: LumaEvent,
  deps: { evermind: EvermindClient; llm: LLMClient },
): Promise<string> {
  const query = `intro message to event host ${event.host} for ${event.title}`;
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
Host:  ${event.host}
When:  ${event.datetime}
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

// --- Feedback ingestion ---------------------------------------------------

/**
 * Persist the user's reaction to an event ("good rec" / "bad rec" /
 * post-event review) into Evermind so future rankings get sharper.
 */
export async function recordFeedback(
  event: LumaEvent,
  feedback: { sentiment: "positive" | "negative" | "neutral"; note?: string },
  deps: { evermind: EvermindClient },
): Promise<void> {
  const verbal = feedback.sentiment === "positive"
    ? "I clicked with"
    : feedback.sentiment === "negative"
      ? "I did not click with"
      : "I attended";

  const content = `${verbal} the event "${event.title}" hosted by ${event.host} on ${event.datetime}.${feedback.note ? ` Note: ${feedback.note}` : ""}`;

  await deps.evermind.addMemory(content, {
    source: "buttersocial.feedback",
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
