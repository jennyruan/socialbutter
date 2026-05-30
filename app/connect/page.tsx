"use client";

import { useMemo, useState } from "react";
import type { LumaEvent } from "@/lib/luma";
import type { DiscoveredEvent, DiscoveredPerson, SocialSource } from "@/lib/social-search";
import type { Verdict, RankableEvent, RankablePerson, PersonVerdict } from "@/lib/agent";

export default function ConnectPage() {
  return (
    <div className="sb-page">
      <header className="sb-header">
        <div className="sb-header-left">
          <ButterflyLogo />
          <span className="sb-header-greeting">SocialButter</span>
          <span className="sb-header-sub">
            Pick the events worth your time
          </span>
        </div>
      </header>

      <main className="sb-main">
        <ConnectLumaSection />
        <FindEventsSection />
        <FindPersonSection />
      </main>
    </div>
  );
}

function ButterflyLogo() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/butterfly.svg" alt="" className="sb-logo" />
  );
}

// =========================================================================
// Section 1 — Connect Luma (real iCal subscription or event URLs)
// =========================================================================

function ConnectLumaSection() {
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
      if (!res.ok) throw new Error(data.error ?? `Import failed (HTTP ${res.status})`);
      setEvents(data.events ?? []);
      setImportedFrom(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }

  const sorted = useMemo(
    () => events.slice().sort((a, b) => (a.datetime < b.datetime ? -1 : 1)),
    [events],
  );

  return (
    <>
      <section className="sb-card sb-connect-card">
        <h2 className="sb-section-title">Connect your Luma</h2>
        <p className="sb-help-text">
          Paste your <strong>personal Luma calendar URL</strong> to pull
          every event you&apos;ve RSVP&apos;d to or hosted. Get it at{" "}
          <a href="https://lu.ma/settings/calendar" target="_blank" rel="noopener noreferrer" className="sb-link">
            Luma → Settings → Calendar
          </a>{" "}
          (the <code className="sb-mono">api.lu.ma/ics/...</code> link). Or
          paste individual <code className="sb-mono">lu.ma/&lt;event&gt;</code>{" "}
          URLs — one per line. All data fetched live, no mocks.
        </p>
        <form onSubmit={handleImport} className="sb-form sb-form-vertical">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={"https://api.lu.ma/ics/get?entity=user&id=…&token=…\n\n— or —\n\nhttps://lu.ma/h7h9r7bw"}
            className="sb-input sb-textarea"
            disabled={loading}
            spellCheck={false}
            rows={5}
          />
          <button type="submit" className="sb-btn-primary" disabled={loading || !input.trim()}>
            {loading ? "Connecting…" : "Connect Luma"}
          </button>
        </form>
        {error && <div className="sb-error" role="alert"><strong>Couldn&apos;t import:</strong> {error}</div>}
      </section>

      {sorted.length > 0 && (
        <EventsListSection
          title={`${sorted.length} event${sorted.length === 1 ? "" : "s"} from Luma`}
          subtitle={importedFrom?.slice(0, 60)}
          events={toRankable(sorted, "luma")}
          renderCard={(re, i) => (
            <LumaEventCard key={re.id} event={sorted[i]} rankable={re} />
          )}
        />
      )}
    </>
  );
}

function LumaEventCard({ event, rankable }: { event: LumaEvent; rankable: RankableEvent }) {
  return (
    <EventCardShell
      title={event.title}
      datetime={event.datetime}
      host={event.host}
      location={event.location}
      url={event.url}
      sourceLabel="Luma"
      footer={<FindAttendeesButton eventUrl={event.url} eventContext={rankable} />}
    />
  );
}

// =========================================================================
// Section 2 — Find events on X / LinkedIn (live browser scrape)
// =========================================================================

function FindEventsSection() {
  const [source, setSource] = useState<SocialSource>("linkedin");
  const [query, setQuery] = useState("");
  const [events, setEvents] = useState<DiscoveredEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/find-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, query: q, limit: 12 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Search failed (HTTP ${res.status})`);
      setEvents(data.events ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <section className="sb-card">
        <h2 className="sb-section-title">Find events on X &amp; LinkedIn</h2>
        <p className="sb-help-text">
          The agent searches the platform live (real browser, your
          logged-in profile). For X it scans recent posts for event
          mentions; for LinkedIn it queries LinkedIn Events directly.
        </p>
        <form onSubmit={handleSearch} className="sb-form sb-form-vertical">
          <SourceToggle source={source} onChange={setSource} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='e.g. "AI infra SF" or "founder dinner"'
            className="sb-input"
            disabled={loading}
            spellCheck={false}
          />
          <button type="submit" className="sb-btn-primary" disabled={loading || !query.trim()}>
            {loading ? "Searching…" : `Search ${labelFor(source)}`}
          </button>
        </form>
        {error && <div className="sb-error" role="alert"><strong>Couldn&apos;t search:</strong> {error}</div>}
      </section>

      {events.length > 0 && (
        <EventsListSection
          title={`${events.length} event${events.length === 1 ? "" : "s"} on ${labelFor(source)}`}
          subtitle={`query: ${query}`}
          events={toRankable(events, source)}
          renderCard={(re, i) => (
            <DiscoveredEventCard key={`${re.source}:${re.url}:${i}`} event={events[i]} />
          )}
        />
      )}
    </>
  );
}

function DiscoveredEventCard({ event }: { event: DiscoveredEvent }) {
  return (
    <EventCardShell
      title={event.title}
      datetime={event.datetime}
      host={event.host}
      location={event.location}
      description={event.description}
      url={event.url}
      sourceLabel={labelFor(event.source as SocialSource | "luma")}
    />
  );
}

// =========================================================================
// Section 3 — Look up a person on X / LinkedIn
// =========================================================================

function FindPersonSection() {
  const [source, setSource] = useState<SocialSource>("linkedin");
  const [input, setInput] = useState("");
  const [person, setPerson] = useState<DiscoveredPerson | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    const v = input.trim();
    if (!v) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/find-people", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, input: v }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Lookup failed (HTTP ${res.status})`);
      setPerson(data.person ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPerson(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <section className="sb-card">
        <h2 className="sb-section-title">Look up a person</h2>
        <p className="sb-help-text">
          Paste a handle (<code className="sb-mono">@name</code>) or full
          profile URL. SocialButter visits the page live and returns bio,
          headline, location, follower count, and recent posts (X only).
          Then the agent can draft a warm intro DM in your voice.
        </p>
        <form onSubmit={handleLookup} className="sb-form sb-form-vertical">
          <SourceToggle source={source} onChange={setSource} />
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              source === "x"
                ? "@jennyruanworks  or  https://x.com/jennyruanworks"
                : "jennyruanworks  or  https://linkedin.com/in/jennyruanworks"
            }
            className="sb-input"
            disabled={loading}
            spellCheck={false}
          />
          <button type="submit" className="sb-btn-primary" disabled={loading || !input.trim()}>
            {loading ? "Looking up…" : `Look up on ${labelFor(source)}`}
          </button>
        </form>
        {error && <div className="sb-error" role="alert"><strong>Couldn&apos;t look up:</strong> {error}</div>}
      </section>

      {person && (
        <section className="sb-events-section">
          <PersonCard person={person} />
        </section>
      )}
    </>
  );
}

// =========================================================================
// Reusable events list with "Rank with Evermind" button
// =========================================================================

function EventsListSection({
  title,
  subtitle,
  events,
  renderCard,
}: {
  title: string;
  subtitle?: string;
  events: RankableEvent[];
  renderCard: (event: RankableEvent, i: number) => React.ReactNode;
}) {
  const [verdicts, setVerdicts] = useState<Map<string, Verdict>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState("");

  async function handleRank() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/rank", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events, goal: goal.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Rank failed (HTTP ${res.status})`);
      const next = new Map<string, Verdict>();
      for (const r of (data.ranked ?? []) as Array<{ event: RankableEvent; verdict: Verdict }>) {
        next.set(r.event.id, r.verdict);
      }
      setVerdicts(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="sb-events-section">
      <div className="sb-events-header">
        <h2 className="sb-section-title">{title}</h2>
        {subtitle && <span className="sb-mono sb-events-source">{subtitle}</span>}
      </div>
      <div className="sb-rank-bar">
        <input
          type="text"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder='Optional goal — e.g. "meet AI infra founders this month"'
          className="sb-input sb-rank-goal"
          disabled={loading}
          spellCheck={false}
        />
        <button
          type="button"
          className="sb-btn-primary"
          onClick={handleRank}
          disabled={loading || events.length === 0}
        >
          {loading ? "Ranking…" : "Rank with Evermind"}
        </button>
      </div>
      {error && <div className="sb-error" role="alert"><strong>Rank failed:</strong> {error}</div>}
      <div className="sb-event-grid">
        {events.map((ev, i) => (
          <VerdictWrapper key={ev.id + i} verdict={verdicts.get(ev.id)}>
            {renderCard(ev, i)}
          </VerdictWrapper>
        ))}
      </div>
    </section>
  );
}

function VerdictWrapper({ verdict, children }: { verdict?: Verdict; children: React.ReactNode }) {
  if (!verdict) return <>{children}</>;
  return (
    <div className={`sb-verdict-wrap sb-verdict-${verdict.decision}`}>
      <div className="sb-verdict-badge">
        {verdict.decision === "go" ? "✓ GO" : verdict.decision === "skip" ? "✗ SKIP" : "? MAYBE"}
      </div>
      {children}
      <div className="sb-verdict-reason">
        <strong>Agent:</strong> {verdict.reason}
        {verdict.citationMemoryIds.length > 0 && (
          <div className="sb-verdict-cites">
            <span className="sb-mono">cited memories:</span>{" "}
            {verdict.citationMemoryIds.map((id, i) => (
              <span key={id + i} className="sb-source-pill">
                {id.slice(0, 8)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// Reusable event card shell + optional footer slot
// =========================================================================

function EventCardShell({
  title,
  datetime,
  host,
  location,
  description,
  url,
  sourceLabel,
  footer,
}: {
  title: string;
  datetime?: string;
  host?: string;
  location?: string;
  description?: string;
  url?: string;
  sourceLabel?: string;
  footer?: React.ReactNode;
}) {
  return (
    <article className="sb-card sb-event-card">
      <div className="sb-mono sb-event-when">
        {datetime ? formatWhen(datetime) : "—"}
        {sourceLabel && <span className="sb-source-pill">{sourceLabel}</span>}
      </div>
      <h3 className="sb-event-title">{title}</h3>
      {host && <div className="sb-event-host">by {host}</div>}
      {location && <div className="sb-event-location">{location}</div>}
      {description && (
        <p className="sb-event-desc">
          {description.slice(0, 220)}{description.length > 220 ? "…" : ""}
        </p>
      )}
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="sb-link">
          Open →
        </a>
      )}
      {footer}
    </article>
  );
}

// --- Find attendees button (Luma cards) ----------------------------------

function FindAttendeesButton({
  eventUrl,
  eventContext,
}: {
  eventUrl: string;
  eventContext: RankableEvent;
}) {
  const [open, setOpen] = useState(false);
  const [attendees, setAttendees] = useState<DiscoveredPerson[]>([]);
  const [ranked, setRanked] = useState<Array<{ person: RankablePerson; verdict: PersonVerdict }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    if (open && attendees.length > 0) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (attendees.length > 0) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/find-attendees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventUrl, rank: true, eventContext, limit: 12 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Attendees fetch failed (HTTP ${res.status})`);
      setAttendees(data.attendees ?? []);
      setRanked(data.ranked ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  const verdictByName = useMemo(() => {
    const m = new Map<string, PersonVerdict>();
    for (const r of ranked) m.set(r.person.name.toLowerCase(), r.verdict);
    return m;
  }, [ranked]);

  return (
    <>
      <button type="button" onClick={handleClick} className="sb-btn-secondary">
        {loading ? "Loading…" : open ? "Hide attendees" : "Find attendees"}
      </button>
      {open && (
        <div className="sb-attendees-panel">
          {error && <div className="sb-error" role="alert">{error}</div>}
          {!loading && attendees.length === 0 && !error && (
            <div className="sb-mono">No guests visible on this event.</div>
          )}
          {attendees.length > 0 && (
            <ul className="sb-attendees-list">
              {attendees.map((p) => {
                const v = verdictByName.get(p.name.toLowerCase());
                return (
                  <li key={p.url || p.name} className={v ? `sb-attendee sb-attendee-${v.decision}` : "sb-attendee"}>
                    {p.avatarUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.avatarUrl} alt="" className="sb-attendee-avatar" />
                    )}
                    <div className="sb-attendee-body">
                      <div className="sb-attendee-name">
                        {p.url ? (
                          <a href={p.url} target="_blank" rel="noopener noreferrer" className="sb-link sb-link-inline">
                            {p.name || p.handle}
                          </a>
                        ) : (
                          p.name || p.handle
                        )}
                        {v && (
                          <span className={`sb-source-pill sb-verdict-pill-${v.decision}`}>
                            {v.decision}
                          </span>
                        )}
                      </div>
                      {v && <div className="sb-attendee-reason">{v.reason}</div>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

// --- Person card with draft-intro button ---------------------------------

function PersonCard({ person }: { person: DiscoveredPerson }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  async function handleDraft() {
    setDraftLoading(true);
    setDraftError(null);
    try {
      const res = await fetch("/api/draft-intro", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ person }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Draft failed (HTTP ${res.status})`);
      setDraft(data.draft ?? "");
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err));
    } finally {
      setDraftLoading(false);
    }
  }

  return (
    <article className="sb-card sb-person-card">
      <div className="sb-person-header">
        {person.avatarUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={person.avatarUrl} alt={`${person.name} avatar`} className="sb-person-avatar" />
        )}
        <div className="sb-person-identity">
          <h3 className="sb-event-title">{person.name}</h3>
          <div className="sb-mono">
            @{person.handle} <span className="sb-source-pill">{person.source}</span>
          </div>
        </div>
      </div>
      {person.headline && <div className="sb-person-headline">{person.headline}</div>}
      {person.bio && <p className="sb-event-desc">{person.bio}</p>}
      <div className="sb-person-meta">
        {person.location && <span>📍 {person.location}</span>}
        {typeof person.followers === "number" && (
          <span>👥 {person.followers.toLocaleString()} followers</span>
        )}
      </div>
      {person.recentPosts && person.recentPosts.length > 0 && (
        <div className="sb-person-posts">
          <div className="sb-mono">Recent posts</div>
          {person.recentPosts.map((p, i) => (
            <div key={i} className="sb-person-post">
              <p>{p.text.slice(0, 220)}{p.text.length > 220 ? "…" : ""}</p>
              {p.postedAt && <span className="sb-mono">{formatWhen(p.postedAt)}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="sb-person-actions">
        <a href={person.url} target="_blank" rel="noopener noreferrer" className="sb-link">
          Open on {labelFor(person.source)} →
        </a>
        <button type="button" onClick={handleDraft} className="sb-btn-secondary" disabled={draftLoading}>
          {draftLoading ? "Drafting…" : draft ? "Re-draft intro" : "Draft intro"}
        </button>
      </div>
      {draftError && <div className="sb-error" role="alert">{draftError}</div>}
      {draft !== null && (
        <div className="sb-draft-box">
          <div className="sb-mono">Agent draft (edit before sending)</div>
          <textarea
            className="sb-input sb-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
          />
        </div>
      )}
    </article>
  );
}

// =========================================================================
// Shared widgets
// =========================================================================

function SourceToggle({
  source,
  onChange,
}: {
  source: SocialSource;
  onChange: (s: SocialSource) => void;
}) {
  return (
    <div className="sb-toggle" role="tablist">
      {(["linkedin", "x"] as SocialSource[]).map((s) => (
        <button
          key={s}
          type="button"
          role="tab"
          aria-selected={source === s}
          className={`sb-toggle-btn ${source === s ? "sb-toggle-active" : ""}`}
          onClick={() => onChange(s)}
        >
          {labelFor(s)}
        </button>
      ))}
    </div>
  );
}

function labelFor(s: SocialSource | "luma"): string {
  if (s === "x") return "X";
  if (s === "linkedin") return "LinkedIn";
  return "Luma";
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

// =========================================================================
// Adapters: shape any event collection into RankableEvent[]
// =========================================================================

function toRankable<T extends { id?: string; title: string; url?: string; host?: string; datetime?: string; endDatetime?: string; location?: string; description?: string }>(
  items: T[],
  source: string,
): RankableEvent[] {
  return items.map((it, i) => ({
    id: it.id ?? `${source}-${i}-${(it.url ?? it.title).slice(0, 40)}`,
    title: it.title,
    host: it.host,
    datetime: it.datetime,
    endDatetime: it.endDatetime,
    url: it.url ?? "",
    location: it.location,
    description: it.description,
    source,
  }));
}
