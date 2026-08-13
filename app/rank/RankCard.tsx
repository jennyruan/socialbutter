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
  /** Colliding busy entry when a hard conflict was found, else null/absent. */
  conflict?: { title: string; datetime: string } | null;
  /** Whether the event's time was precise enough to run conflict detection. */
  conflictChecked?: boolean;
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

export function RankCard({
  item,
  calendarProvided = false,
}: {
  item: RankCardItem;
  /** True when the user pasted a busy calendar — drives the "couldn't check" state. */
  calendarProvided?: boolean;
}) {
  const { event, decision, score, pros, cons, conflict, conflictChecked } = item;
  const href = safeHref(event.url);
  // Distinct calendar states (title/text auto-escaped by JSX — no XSS):
  //  • conflict present  → red banner naming the colliding entry + skip rec
  //  • calendar sent but time not placeable → neutral "couldn't check" note
  //    (NEVER a green all-clear when we didn't actually check)
  const showCantCheck = calendarProvided && !conflictChecked && !conflict;

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

      {conflict && (
        <div className="sb-rank-conflict" role="alert">
          <span className="sb-rank-conflict-tag">⚠ Calendar conflict</span>{" "}
          Overlaps <strong>&ldquo;{conflict.title}&rdquo;</strong> on your busy calendar
          {conflict.datetime ? <span className="sb-mono"> ({conflict.datetime})</span> : null}. Recommend
          you skip this one.
        </div>
      )}
      {showCantCheck && (
        <div className="sb-rank-nocheck">
          Couldn&apos;t check your calendar — this event needs a precise start time (with a timezone
          offset) to compare against your busy blocks.
        </div>
      )}

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
