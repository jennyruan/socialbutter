// Presentational card for one ranked event. No hooks, no state — pure render,
// so the smoke harness can render it directly (react-dom/server) to prove
// user-supplied text (titles/descriptions) is escaped and that unsafe URLs
// never become live hrefs.

import { safeHref } from "@/lib/url-safe";

export type RankDecision = "go" | "maybe" | "skip";

export interface RankCardEvent {
  id: string;
  title: string;
  url?: string;
  datetime?: string;
  host?: string;
  location?: string;
  description?: string;
}

export interface RankCardItem {
  event: RankCardEvent;
  decision: RankDecision;
  score: number | null;
  pros: string[];
  cons: string[];
}

const BADGE_LABEL: Record<RankDecision, string> = {
  go: "✓ GO",
  maybe: "? MAYBE",
  skip: "✗ SKIP",
};

const BADGE_ARIA: Record<RankDecision, string> = {
  go: "Recommendation: go",
  maybe: "Recommendation: maybe",
  skip: "Recommendation: skip",
};

export function RankCard({ item }: { item: RankCardItem }) {
  const { event, decision, score, pros, cons } = item;
  const href = safeHref(event.url);

  return (
    <article className={`sb-card sb-rank-card sb-rank-${decision}`}>
      <div className="sb-rank-card-top">
        <span className={`sb-rank-badge sb-rank-badge-${decision}`} aria-label={BADGE_ARIA[decision]}>
          {BADGE_LABEL[decision]}
        </span>
        {typeof score === "number" && (
          <span className="sb-rank-score" aria-label={`Score ${score} out of 100`}>
            {score}
            <span className="sb-rank-score-max">/100</span>
          </span>
        )}
      </div>

      <h3 className="sb-event-title">{event.title}</h3>

      <div className="sb-rank-meta sb-mono">
        {event.datetime && <span>{event.datetime}</span>}
        {event.host && <span>by {event.host}</span>}
        {event.location && <span>{event.location}</span>}
      </div>

      {pros.length > 0 && (
        <ul className="sb-rank-list sb-rank-pros">
          {pros.map((p, i) => (
            <li key={i}>
              <span className="sb-rank-tag">Pro</span> {p}
            </li>
          ))}
        </ul>
      )}
      {cons.length > 0 && (
        <ul className="sb-rank-list sb-rank-cons">
          {cons.map((c, i) => (
            <li key={i}>
              <span className="sb-rank-tag">Con</span> {c}
            </li>
          ))}
        </ul>
      )}

      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="sb-link">
          Open →
        </a>
      ) : event.url ? (
        <span className="sb-mono sb-rank-rawurl">{event.url}</span>
      ) : null}
    </article>
  );
}
