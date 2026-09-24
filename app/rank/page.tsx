"use client";

import { useState } from "react";
import { parsePastedEvents, parseBusyCalendar } from "./parse";
import { RankCard, type RankCardItem } from "./RankCard";
import { splitImportInput, importWarnings, importedToRankable } from "./import";
import type { RankableEvent } from "@/lib/agent";
import type { CalendarEvent } from "@/lib/calendar";

// Keyless, immediately-usable ranked-events view. The user pastes their own
// events, ranks them through the offline heuristic path of /api/rank, and sees
// each event's decision, 0–100 score, and distinct pros/cons. No accounts, no
// API keys, no LLM, no persistence, and NO prefilled/sample data.

// Format instructions ONLY — no sample/example event data (contract A02).
const PLACEHOLDER = `Paste your events — one per line, using this format:

  Title @ Location | <ISO datetime>

Only the title is required; "@ Location" and "| <ISO datetime>" are optional.

You can also paste calendar subscription URLs (webcal:// or https://…ics) or
Luma event URLs (https://lu.ma/<event>), mixed in freely with the lines above.

— or paste a JSON array of event objects, each with a "title" (and optional "url", "datetime", "location").`;

// Format instructions ONLY for the busy calendar — no sample/example data.
const BUSY_PLACEHOLDER = `Optional — paste your existing commitments so conflicts get flagged:

  Title | <ISO datetime with offset, e.g. 2026-09-04T18:00:00-07:00>

A datetime is REQUIRED (lines without one are skipped) — but a pasted calendar
subscription URL (webcal:// or https://…ics) is exempt: fetching supplies the
datetimes.

— or a JSON array of { "title", "datetime", "endDatetime"? } objects.`;

// What the import route returns for one box's URL tokens: imported events
// plus per-URL soft failures (hard failures throw — see importUrlTokens).
interface ImportOutcome {
  events: CalendarEvent[];
  errors: Array<{ url: string; message: string }>;
}

// Fetch one box's URL tokens through the existing calendar import route.
// Non-OK response ⇒ throw (the rank aborts with a visible error); per-URL
// failures ride back in errors[] and render as warnings.
async function importUrlTokens(urls: string[]): Promise<ImportOutcome> {
  const res = await fetch("/api/calendar/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: urls.join("\n") }),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // handled below — an unparseable body is a hard failure
  }
  if (!res.ok) {
    const message =
      (data as { error?: string } | null)?.error ?? `Import failed (HTTP ${res.status})`;
    throw new Error(message);
  }
  if (data === null || typeof data !== "object") {
    throw new Error(`Import returned an unparseable response (HTTP ${res.status}).`);
  }
  const parsed = data as { events?: CalendarEvent[]; errors?: ImportOutcome["errors"] };
  return { events: parsed.events ?? [], errors: parsed.errors ?? [] };
}

export default function RankPage() {
  const [text, setText] = useState("");
  const [busyText, setBusyText] = useState("");
  const [keywords, setKeywords] = useState("");
  const [items, setItems] = useState<RankCardItem[] | null>(null);
  const [rankingSource, setRankingSource] = useState<string | null>(null);
  const [calendarProvided, setCalendarProvided] = useState(false);
  const [calendarWarning, setCalendarWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRank() {
    setError(null);
    setCalendarWarning(null);

    // 1. Split both boxes: URL tokens detour through /api/calendar/import;
    // the remainder parses exactly as before.
    const ev = splitImportInput(text);
    const busy = splitImportInput(busyText);

    const { events: pasted, error: parseError } = parsePastedEvents(ev.rest);
    if (parseError) {
      setError(parseError);
      return;
    }
    if (pasted.length === 0 && ev.urls.length === 0) {
      setError("Paste at least one event above (one per line, a JSON array, or a calendar/Luma event URL).");
      return;
    }

    const busyParsed = parseBusyCalendar(busy.rest);
    if (busyParsed.error) {
      setError(busyParsed.error);
      return;
    }
    const busyProvided = busyText.trim().length > 0;

    const goalKeywords = keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    setLoading(true);
    try {
      // 2. Import URL tokens — one call per box, so each box's imports merge
      // into the right payload: the route's response is a flat list with no
      // per-URL attribution, and an event must not become its own busy slot.
      const [evImport, busyImport] = await Promise.all([
        ev.urls.length > 0 ? importUrlTokens(ev.urls) : null,
        busy.urls.length > 0 ? importUrlTokens(busy.urls) : null,
      ]);
      const importedEvents = (evImport?.events ?? []).map(importedToRankable);
      const importedBusy = busyImport?.events ?? [];

      if (importedEvents.length === 0 && pasted.length === 0) {
        // Everything was URL tokens and none of it produced an event.
        const detail = evImport?.errors[0];
        throw new Error(
          detail
            ? `Import failed: ${detail.url}: ${detail.message}`
            : "No events came back from the pasted URL(s). Paste them as lines or JSON instead.",
        );
      }

      // 3. Merge: imported events rank like pasted ones; imported busy
      // entries carry strict-instant datetimes, so the existing conflict
      // gate treats them exactly like pasted busy lines.
      const events: RankableEvent[] = [...pasted, ...importedEvents];
      const busyEvents = [...busyParsed.events, ...importedBusy];

      // 4. Rank exactly as before — /api/rank is untouched by URL import.
      const res = await fetch("/api/rank", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          events,
          goalKeywords,
          busyEvents,
          heuristicOnly: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Ranking failed (HTTP ${res.status})`);
      setItems((data.ranked ?? []) as RankCardItem[]);
      setRankingSource(data.rankingSource ?? null);
      setCalendarProvided(busyProvided);

      // Surface honest accounting: import outcomes (unsupported tokens,
      // per-URL failures) + client-dropped lines + server-dropped entries +
      // truncation. Never a silent false negative.
      const warnings: string[] = importWarnings(
        [...ev.unsupported, ...busy.unsupported],
        [...(evImport?.errors ?? []), ...(busyImport?.errors ?? [])],
      );
      if (busyParsed.skipped > 0) {
        warnings.push(
          `${busyParsed.skipped} calendar ${busyParsed.skipped === 1 ? "entry" : "entries"} skipped for missing a datetime.`,
        );
      }
      if (typeof data.busySkipped === "number" && data.busySkipped > 0) {
        warnings.push(
          `${data.busySkipped} calendar ${data.busySkipped === 1 ? "entry" : "entries"} ignored — a datetime needs an explicit time and timezone offset (e.g. 2026-09-04T18:00:00-07:00).`,
        );
      }
      if (data.busyTruncated) {
        warnings.push("Only the first 1000 calendar entries were checked.");
      }
      setCalendarWarning(warnings.length > 0 ? warnings.join(" ") : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="sb-page">
      <header className="sb-header">
        <div className="sb-header-left">
          <span className="sb-header-greeting">SocialButter</span>
          <span className="sb-header-sub">Rank your events — no sign-in, no keys.</span>
        </div>
      </header>

      <main className="sb-main">
        <section className="sb-card sb-connect-card">
          <h2 className="sb-section-title">Rank events</h2>
          <p className="sb-help-text">
            Paste the events you&apos;re weighing. SocialButter scores each one
            offline — go / maybe / skip, a 0–100 score, and the reasons why. Your
            data never leaves this request; nothing is stored.
          </p>

          <label className="sb-help-text" htmlFor="sb-rank-input">
            <strong>Your events</strong> — one per line (<code className="sb-mono">Title @ Location | ISO datetime</code>,
            only the title is required), a JSON array, or a calendar subscription / Luma event URL.
          </label>
          <textarea
            id="sb-rank-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={PLACEHOLDER}
            className="sb-input sb-textarea"
            rows={8}
            spellCheck={false}
            disabled={loading}
          />

          <label className="sb-help-text" htmlFor="sb-rank-busy">
            <strong>Your busy calendar</strong> (optional) — one per line
            (<code className="sb-mono">Title | ISO datetime</code>, datetime required),
            a JSON array, or a calendar subscription URL (URL lines don&apos;t need
            a datetime). Events that overlap get flagged as conflicts.
          </label>
          <textarea
            id="sb-rank-busy"
            value={busyText}
            onChange={(e) => setBusyText(e.target.value)}
            placeholder={BUSY_PLACEHOLDER}
            className="sb-input sb-textarea"
            rows={5}
            spellCheck={false}
            disabled={loading}
          />

          <label className="sb-help-text" htmlFor="sb-rank-keywords">
            <strong>Goal keywords</strong> (optional, comma-separated) — events
            matching these get a boost.
          </label>
          <input
            id="sb-rank-keywords"
            type="text"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="ai infra, founders, investors"
            className="sb-input"
            spellCheck={false}
            disabled={loading}
          />

          <button type="button" className="sb-btn-primary" onClick={handleRank} disabled={loading}>
            {loading ? "Ranking…" : "Rank my events"}
          </button>

          {error && (
            <div className="sb-error" role="alert">
              <strong>Couldn&apos;t rank:</strong> {error}
            </div>
          )}
        </section>

        {items === null ? (
          <EmptyState />
        ) : items.length === 0 ? (
          <EmptyState />
        ) : (
          <section className="sb-events-section">
            <div className="sb-events-header">
              <h2 className="sb-section-title">
                {items.length} ranked event{items.length === 1 ? "" : "s"}
              </h2>
              {rankingSource && <span className="sb-mono sb-events-source">source: {rankingSource}</span>}
            </div>
            {calendarWarning && (
              <div className="sb-error sb-rank-cal-warning" role="status">
                {calendarWarning}
              </div>
            )}
            <div className="sb-event-grid">
              {items.map((item) => (
                <RankCard key={item.event.id} item={item} calendarProvided={calendarProvided} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <section className="sb-card sb-rank-empty">
      <h2 className="sb-section-title">No events ranked yet</h2>
      <p className="sb-help-text">
        Paste your events above and hit <strong>Rank my events</strong>. Three
        ways to enter them:
      </p>
      <ul className="sb-help-text sb-rank-empty-list">
        <li>
          <strong>One per line:</strong> <code className="sb-mono">Title</code>, optionally{" "}
          <code className="sb-mono">@ Location</code> and <code className="sb-mono">| ISO datetime</code>. Blank lines are ignored.
        </li>
        <li>
          <strong>JSON array:</strong> objects with a required <code className="sb-mono">title</code> plus optional{" "}
          <code className="sb-mono">url</code>, <code className="sb-mono">datetime</code>, <code className="sb-mono">location</code>.
        </li>
        <li>
          <strong>URLs:</strong> calendar subscription links (<code className="sb-mono">webcal://</code> or{" "}
          <code className="sb-mono">https://…ics</code>) or Luma event links (<code className="sb-mono">lu.ma/…</code>),
          mixed in with the formats above.
        </li>
      </ul>
      <p className="sb-help-text">No accounts, no API keys, no sample data — just your events.</p>
    </section>
  );
}
