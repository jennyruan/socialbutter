"use client";

import { useState } from "react";
import { parsePastedEvents } from "./parse";
import { RankCard, type RankCardItem } from "./RankCard";

// Keyless, immediately-usable ranked-events view. The user pastes their own
// events, ranks them through the offline heuristic path of /api/rank, and sees
// each event's decision, 0–100 score, and distinct pros/cons. No accounts, no
// API keys, no LLM, no persistence, and NO prefilled/sample data.

// Format instructions ONLY — no sample/example event data (contract A02).
const PLACEHOLDER = `Paste your events — one per line, using this format:

  Title @ Location | <ISO datetime>

Only the title is required; "@ Location" and "| <ISO datetime>" are optional.

— or paste a JSON array of event objects, each with a "title" (and optional "url", "datetime", "location").`;

export default function RankPage() {
  const [text, setText] = useState("");
  const [keywords, setKeywords] = useState("");
  const [items, setItems] = useState<RankCardItem[] | null>(null);
  const [rankingSource, setRankingSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRank() {
    setError(null);
    const { events, error: parseError } = parsePastedEvents(text);
    if (parseError) {
      setError(parseError);
      return;
    }
    if (events.length === 0) {
      setError("Paste at least one event above (one per line, or a JSON array).");
      return;
    }

    const goalKeywords = keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    setLoading(true);
    try {
      const res = await fetch("/api/rank", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events, goalKeywords, heuristicOnly: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Ranking failed (HTTP ${res.status})`);
      setItems((data.ranked ?? []) as RankCardItem[]);
      setRankingSource(data.rankingSource ?? null);
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
            only the title is required), or a JSON array.
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
            <div className="sb-event-grid">
              {items.map((item) => (
                <RankCard key={item.event.id} item={item} />
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
        Paste your events above and hit <strong>Rank my events</strong>. Two ways
        to enter them:
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
      </ul>
      <p className="sb-help-text">No accounts, no API keys, no sample data — just your events.</p>
    </section>
  );
}
