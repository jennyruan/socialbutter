// Smoke test for the offline heuristic scorer.
// Run: pnpm heuristic:smoke   (tsx scripts/heuristic-smoke.ts)
//
// Deterministic, no network. Covers the full rule matrix from the plan.

import assert from "node:assert/strict";
import { scoreEventHeuristic } from "../lib/heuristic";
import type { RankableEvent } from "../lib/agent";
import type { CalendarEvent } from "../lib/calendar";

const ev = (over: Partial<RankableEvent> = {}): RankableEvent => ({
  id: "e1",
  title: "Founders Dinner",
  url: "https://lu.ma/x",
  datetime: "2026-09-01T18:00:00-07:00",
  endDatetime: "2026-09-01T20:00:00-07:00",
  ...over,
});

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("heuristic-smoke:");

check("small + NO high-value → skip", () => {
  const r = scoreEventHeuristic(ev(), { attendeeCount: 30, highValueAttendees: false });
  assert.equal(r.decision, "skip");
  assert.ok(r.score < 40);
  assert.ok(r.cons.length > 0);
});

check("small + high-value → go", () => {
  const r = scoreEventHeuristic(ev(), { attendeeCount: 30, highValueAttendees: true });
  assert.equal(r.decision, "go");
  assert.ok(r.score >= 80);
});

check("large → go (better odds)", () => {
  const r = scoreEventHeuristic(ev(), { attendeeCount: 300 });
  assert.equal(r.decision, "go");
});

check("mid-size → maybe", () => {
  const r = scoreEventHeuristic(ev(), { attendeeCount: 100 });
  assert.equal(r.decision, "maybe");
});

check("unknown size → maybe with a note", () => {
  const r = scoreEventHeuristic(ev(), {});
  assert.equal(r.decision, "maybe");
  assert.ok(r.cons.some((c) => /unknown/i.test(c)));
});

check("calendar conflict → forced skip regardless of size", () => {
  const busyEvents: CalendarEvent[] = [
    {
      id: "b1",
      title: "Investor call",
      host: "me",
      datetime: "2026-09-01T18:30:00-07:00",
      endDatetime: "2026-09-01T19:00:00-07:00",
      source: "ics",
      sourceLabel: "Calendar",
    },
  ];
  const r = scoreEventHeuristic(ev(), { attendeeCount: 300, highValueAttendees: true, busyEvents });
  assert.equal(r.decision, "skip");
  assert.ok(r.cons.some((c) => /conflict/i.test(c)));
});

check("goal keyword boosts score AND lifts a mid-size maybe→go", () => {
  const base = scoreEventHeuristic(ev({ title: "AI Infra Mixer" }), { attendeeCount: 100 });
  const boosted = scoreEventHeuristic(ev({ title: "AI Infra Mixer" }), {
    attendeeCount: 100,
    goalKeywords: ["ai infra"],
  });
  assert.equal(base.decision, "maybe", "mid-size without keyword is a maybe");
  assert.equal(boosted.decision, "go", "keyword lifts mid-size maybe→go");
  assert.ok(boosted.score > base.score);
  assert.ok(boosted.pros.some((p) => /keyword/i.test(p)));
});

check("score always clamped 0–100", () => {
  const r = scoreEventHeuristic(ev(), {
    attendeeCount: 300,
    highValueAttendees: true,
    goalKeywords: ["founders"],
  });
  assert.ok(r.score >= 0 && r.score <= 100);
});

console.log(`\nheuristic-smoke: ${passed} checks passed`);
