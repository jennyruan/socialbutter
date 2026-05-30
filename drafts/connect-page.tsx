// Connect-to-Luma page — move to app/connect/page.tsx after scaffold.
//
// Single screen: input box + "Import" button. On import, calls the Luma
// route handler and renders real events as cards in AMGINA design language
// (cream/paper/ink/amber, square corners, 2px ink borders, bs-* classes).
//
// NO mock data anywhere — empty state is empty until the user imports.

"use client";

import { useState } from "react";
import type { LumaEvent } from "@/lib/luma";

export default function ConnectPage() {
  const [input, setInput] = useState("");
  const [events, setEvents] = useState<LumaEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importedFrom, setImportedFrom] = useState<string | null>(null);

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/luma/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? `Import failed (HTTP ${res.status})`);
      }
      setEvents(data.events ?? []);
      setImportedFrom(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bs-page">
      <header className="bs-header">
        <div className="bs-header-left">
          <span className="bs-header-greeting">ButterSocial</span>
          <span className="bs-header-sub">
            Pick the events worth your time
          </span>
        </div>
      </header>

      <main className="bs-main">
        <section className="bs-card bs-connect-card">
          <h2 className="bs-section-title">Connect your Luma</h2>
          <p className="bs-help-text">
            Enter your Luma username (e.g.{" "}
            <code className="bs-mono">jennyruan</code>) or paste a profile /
            event URL. ButterSocial fetches your real events live from{" "}
            <code className="bs-mono">lu.ma</code> — no mock data.
          </p>

          <form onSubmit={handleImport} className="bs-form">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="jennyruan  or  https://lu.ma/jennyruan"
              className="bs-input"
              disabled={loading}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="submit"
              className="bs-btn-primary"
              disabled={loading || !input.trim()}
            >
              {loading ? "Importing…" : "Import"}
            </button>
          </form>

          {error && (
            <div className="bs-error" role="alert">
              <strong>Couldn't import:</strong> {error}
            </div>
          )}
        </section>

        {events.length > 0 && (
          <section className="bs-events-section">
            <div className="bs-events-header">
              <h2 className="bs-section-title">
                {events.length} event{events.length === 1 ? "" : "s"}
              </h2>
              {importedFrom && (
                <span className="bs-mono bs-events-source">
                  from {importedFrom}
                </span>
              )}
            </div>
            <div className="bs-event-grid">
              {events
                .slice()
                .sort((a, b) => (a.datetime < b.datetime ? -1 : 1))
                .map((ev) => (
                  <EventCard key={ev.id} event={ev} />
                ))}
            </div>
          </section>
        )}

        {!loading && !error && events.length === 0 && importedFrom && (
          <div className="bs-empty">
            No public events found for that input.
          </div>
        )}
      </main>
    </div>
  );
}

function EventCard({ event }: { event: LumaEvent }) {
  const when = formatWhen(event.datetime);
  return (
    <article className="bs-card bs-event-card">
      <div className="bs-event-when bs-mono">{when}</div>
      <h3 className="bs-event-title">{event.title}</h3>
      <div className="bs-event-host">by {event.host}</div>
      {event.location && (
        <div className="bs-event-location">{event.location}</div>
      )}
      <a
        href={event.url}
        target="_blank"
        rel="noopener noreferrer"
        className="bs-link"
      >
        Open on Luma →
      </a>
    </article>
  );
}

function formatWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
