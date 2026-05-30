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
            Paste your <strong>personal Luma calendar URL</strong> to pull
            every event you&apos;ve RSVP&apos;d to or hosted — ButterSocial
            refreshes on every load. Find it at{" "}
            <a
              href="https://lu.ma/settings/calendar"
              target="_blank"
              rel="noopener noreferrer"
              className="bs-link"
            >
              Luma → Settings → Calendar
            </a>{" "}
            (look for the <code className="bs-mono">api.lu.ma/ics/...</code>
            link). Or paste individual{" "}
            <code className="bs-mono">lu.ma/&lt;event&gt;</code> URLs — one
            per line. All data fetched live, no mocks.
          </p>

          <form onSubmit={handleImport} className="bs-form bs-form-vertical">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                "https://api.lu.ma/ics/get?entity=user&id=…&token=…\n\n— or —\n\nhttps://lu.ma/h7h9r7bw\nhttps://lu.ma/abc123"
              }
              className="bs-input bs-textarea"
              disabled={loading}
              autoFocus
              spellCheck={false}
              rows={5}
            />
            <button
              type="submit"
              className="bs-btn-primary"
              disabled={loading || !input.trim()}
            >
              {loading ? "Connecting…" : "Connect Luma"}
            </button>
          </form>

          {error && (
            <div className="bs-error" role="alert">
              <strong>Couldn&apos;t import:</strong> {error}
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
                  from {importedFrom.slice(0, 60)}
                  {importedFrom.length > 60 ? "…" : ""}
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
            No events found for that input.
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
