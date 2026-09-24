// Executable smoke harness for the /rank feature (contract A27).
// Run: pnpm rank:smoke  (tsx --tsconfig scripts/tsconfig.smoke.json ...)
//
// Exercises the highest-risk claims against the REAL route handler and the
// REAL /rank card component — no server, no network, deterministic:
//   (i)   a >1 MB raw body ⇒ 413 BEFORE parse, with NO Content-Length header
//   (ii)  with LLM_API_KEY+EVERMIND_API_KEY set, heuristicOnly:true makes zero
//         outbound fetch calls and returns rankingSource:"heuristic"
//   (iii) {"events":[]} ⇒ 200 with ranked:[], count:0
//   (iv)  duplicate-title events (distinct ids) ⇒ one RankedItem each
//   (v)   XSS proven at the render layer: (a) `git grep dangerouslySetInnerHTML`
//         over app/rank returns nothing, AND (b) a <script> title renders as
//         escaped text (not an element) and a javascript: url is never a live href
// Plus a few contract-critical guards: javascript: url ⇒ event.url === "",
// duplicate/blank id ⇒ 400, >200 events ⇒ 413.

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { POST } from "../app/api/rank/route";
import { RankCard, type RankCardItem } from "../app/rank/RankCard";
import { parsePastedEvents, parseBusyCalendar } from "../app/rank/parse";
import { splitImportInput, importWarnings, importedToRankable } from "../app/rank/import";
import { detectSource, type CalendarEvent } from "../lib/calendar";

const DECISIONS = new Set(["go", "maybe", "skip"]);

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function callJson(payload: unknown): Promise<{ status: number; data: any }> {
  const req = new Request("http://localhost/api/rank", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const res = await POST(req);
  return { status: res.status, data: await res.json() };
}

function bigStream(totalBytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024).fill(65); // 'A'
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      sent += chunk.byteLength;
    },
  });
}

async function main() {
  console.log("rank-smoke:");

  // (i) >1 MB raw body ⇒ 413 before parse, no Content-Length.
  await check("(i) >1MB body ⇒ 413 before parse, no Content-Length header", async () => {
    const req = new Request("http://localhost/api/rank", {
      method: "POST",
      body: bigStream(2 * 1024 * 1024),
      // @ts-expect-error duplex is required by Node/undici for a stream body
      duplex: "half",
    });
    assert.equal(req.headers.get("content-length"), null, "precondition: no Content-Length");
    const res = await POST(req);
    assert.equal(res.status, 413);
  });

  // (i-b) >1 MB raw body with a LYING (too-small) Content-Length ⇒ still 413.
  // Proves the cap is enforced by counting streamed bytes, not by trusting the
  // header — a spoofed Content-Length cannot bypass the DoS guard.
  await check("(i-b) >1MB body + false small Content-Length ⇒ still 413", async () => {
    const req = new Request("http://localhost/api/rank", {
      method: "POST",
      headers: { "content-length": "10" }, // lie: real body is 2 MB
      body: bigStream(2 * 1024 * 1024),
      // @ts-expect-error duplex is required by Node/undici for a stream body
      duplex: "half",
    });
    const res = await POST(req);
    assert.equal(res.status, 413);
  });

  // (ii) keys set + heuristicOnly ⇒ zero fetch calls, rankingSource heuristic.
  await check("(ii) keys set + heuristicOnly ⇒ 0 LLM calls, rankingSource=heuristic", async () => {
    process.env.LLM_API_KEY = "test-llm-key";
    process.env.EVERMIND_API_KEY = "test-evermind-key";
    const origFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = ((...args: unknown[]) => {
      fetchCalls++;
      return (origFetch as (...a: unknown[]) => Promise<Response>)(...args);
    }) as typeof fetch;
    try {
      const { status, data } = await callJson({
        events: [{ id: "paste-0", title: "AI Infra Dinner", url: "" }],
        heuristicOnly: true,
      });
      assert.equal(status, 200);
      assert.equal(data.rankingSource, "heuristic");
      assert.equal(fetchCalls, 0, "no outbound fetch on the heuristic path");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  // Also: heuristic path succeeds with keys UNSET.
  await check("heuristicOnly succeeds with vendor keys unset", async () => {
    delete process.env.LLM_API_KEY;
    delete process.env.EVERMIND_API_KEY;
    const { status, data } = await callJson({
      events: [{ id: "paste-0", title: "Founders Mixer", url: "" }],
      heuristicOnly: true,
    });
    assert.equal(status, 200);
    assert.equal(data.rankingSource, "heuristic");
    assert.equal(data.count, 1);
    assert.ok(Number.isInteger(data.ranked[0].score));
  });

  // (iii) empty events ⇒ 200 [].
  await check("(iii) {events:[]} ⇒ 200 ranked:[] count:0", async () => {
    const { status, data } = await callJson({ events: [] });
    assert.equal(status, 200);
    assert.deepEqual(data.ranked, []);
    assert.equal(data.count, 0);
  });

  // (iv) duplicate titles, distinct ids ⇒ one item each.
  await check("(iv) duplicate titles distinct ids ⇒ one item each", async () => {
    const { status, data } = await callJson({
      events: [
        { id: "paste-0", title: "Dinner", url: "" },
        { id: "paste-1", title: "Dinner", url: "" },
      ],
      heuristicOnly: true,
    });
    assert.equal(status, 200);
    assert.equal(data.ranked.length, 2);
    assert.equal(data.count, 2);
  });

  // Contract guards: javascript: url normalized to "" in the API response.
  await check("javascript: url ⇒ response event.url === ''", async () => {
    const { status, data } = await callJson({
      events: [{ id: "paste-0", title: "Sketchy", url: "javascript:alert(1)" }],
      heuristicOnly: true,
    });
    assert.equal(status, 200);
    assert.equal(data.ranked[0].event.url, "");
  });

  await check("blank/missing id ⇒ 400", async () => {
    const r1 = await callJson({ events: [{ id: "", title: "x", url: "" }] });
    assert.equal(r1.status, 400);
    const r2 = await callJson({ events: [{ title: "x", url: "" }] });
    assert.equal(r2.status, 400);
  });

  await check("duplicate id ⇒ 400", async () => {
    const { status } = await callJson({
      events: [
        { id: "dup", title: "a", url: "" },
        { id: "dup", title: "b", url: "" },
      ],
    });
    assert.equal(status, 400);
  });

  await check(">200 events ⇒ 413", async () => {
    const events = Array.from({ length: 201 }, (_, i) => ({ id: `paste-${i}`, title: `E${i}`, url: "" }));
    const { status } = await callJson({ events });
    assert.equal(status, 413);
  });

  await check("missing events array ⇒ 400; invalid JSON ⇒ 400 (no 500)", async () => {
    const r1 = await callJson({ foo: "bar" });
    assert.equal(r1.status, 400);
    const req = new Request("http://localhost/api/rank", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req);
    assert.equal(res.status, 400);
  });

  await check("deterministic: identical payload ⇒ identical decision/score/pros/cons", async () => {
    const payload = {
      events: [{ id: "paste-0", title: "AI Infra Dinner", url: "" }],
      goalKeywords: ["ai infra"],
      enrichment: { "paste-0": { attendeeCount: 40, highValueAttendees: true } },
      heuristicOnly: true,
    };
    const a = await callJson(payload);
    const b = await callJson(payload);
    assert.deepEqual(a.data.ranked[0].decision, b.data.ranked[0].decision);
    assert.deepEqual(a.data.ranked[0].score, b.data.ranked[0].score);
    assert.deepEqual(a.data.ranked[0].pros, b.data.ranked[0].pros);
    assert.deepEqual(a.data.ranked[0].cons, b.data.ranked[0].cons);
  });

  // (v)(a) no dangerouslySetInnerHTML anywhere in the /rank view.
  await check("(v)(a) git grep dangerouslySetInnerHTML over app/rank ⇒ nothing", () => {
    let out = "";
    try {
      out = execSync("git grep -n dangerouslySetInnerHTML -- app/rank", { encoding: "utf8" });
    } catch (e) {
      // git grep exits 1 with no matches — that's the pass case.
      out = (e as { stdout?: string }).stdout ?? "";
    }
    assert.equal(out.trim(), "", `unexpected dangerouslySetInnerHTML:\n${out}`);
  });

  // (v)(b) render-layer proof: <script> title escaped, javascript: url not a live href.
  await check("(v)(b) <script> title renders escaped; javascript: url is not a live href", () => {
    const item: RankCardItem = {
      event: {
        id: "paste-0",
        title: "<script>alert(1)</script>",
        url: "javascript:alert(1)",
        location: "<img src=x onerror=alert(2)>",
      },
      decision: "go",
      score: 82,
      pros: ["<b>bold pro</b>"],
      cons: [],
    };
    const html = renderToStaticMarkup(<RankCard item={item} />);
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "title must be escaped");
    assert.ok(!html.includes("<script>alert(1)</script>"), "no live <script> element");
    assert.ok(!html.includes('href="javascript:'), "javascript: never becomes an href");
    assert.ok(!/onerror=/.test(html) || html.includes("&lt;img"), "location must be escaped");
  });

  // ---------------------------------------------------------------------
  // Broadened per-assertion coverage (A03–A29). Black-box against the REAL
  // route + REAL card + REAL parser so a code-running Evaluator can verify
  // without playwright.
  // ---------------------------------------------------------------------

  // A03/A04/A05/A06 — extended shape, decision domain, score, pros/cons.
  await check("A03/A04/A05/A06 response shape: event+verdict+decision/score/pros/cons", async () => {
    const { status, data } = await callJson({
      events: [{ id: "paste-0", title: "AI Infra Dinner", url: "" }],
      enrichment: { "paste-0": { attendeeCount: 200 } },
      heuristicOnly: true,
    });
    assert.equal(status, 200);
    assert.equal(data.rankingSource, "heuristic");
    const item = data.ranked[0];
    // A03: preserved + added keys all present.
    assert.ok(item.event && item.verdict, "event + verdict preserved");
    assert.ok(typeof item.verdict.decision === "string", "verdict.decision present");
    assert.ok(Array.isArray(item.verdict.citationMemoryIds), "verdict.citationMemoryIds present");
    // A04: decision domain + equals verdict.decision.
    assert.ok(DECISIONS.has(item.decision), "decision in {go,maybe,skip}");
    assert.equal(item.decision, item.verdict.decision, "decision equals verdict.decision");
    // A05: heuristic score integer in [0,100].
    assert.ok(Number.isInteger(item.score) && item.score >= 0 && item.score <= 100, "score int [0,100]");
    // A06: pros + cons arrays, union non-empty.
    assert.ok(Array.isArray(item.pros) && Array.isArray(item.cons), "pros/cons arrays");
    assert.ok(item.pros.length + item.cons.length > 0, "pros∪cons non-empty");
  });

  // A07 — go has ≥1 pros, skip has ≥1 cons. A08 — pros/cons share no string.
  await check("A07/A08 go⇒≥1 pro, skip⇒≥1 con, pros∩cons empty", async () => {
    const { data } = await callJson({
      events: [
        { id: "go1", title: "Big Summit", url: "" }, // large ⇒ go
        { id: "skip1", title: "Tiny meetup", url: "" }, // small no-hv ⇒ skip
      ],
      enrichment: {
        go1: { attendeeCount: 300 },
        skip1: { attendeeCount: 10, highValueAttendees: false },
      },
      heuristicOnly: true,
    });
    for (const it of data.ranked) {
      if (it.decision === "go") assert.ok(it.pros.length >= 1, "go ⇒ ≥1 pro");
      if (it.decision === "skip") assert.ok(it.cons.length >= 1, "skip ⇒ ≥1 con");
      const overlap = it.pros.filter((p: string) => it.cons.includes(p));
      assert.equal(overlap.length, 0, `pros/cons overlap: ${overlap.join(", ")}`);
    }
  });

  // A09 — documented decision bands.
  await check("A09 bands: conflict⇒skip, ≤60 no-hv⇒skip, ≥150⇒go, unknown⇒maybe", async () => {
    const { data } = await callJson({
      events: [
        { id: "small", title: "Small no-hv", url: "" },
        { id: "large", title: "Large room", url: "" },
        { id: "unknown", title: "Unknown size", url: "" },
        { id: "conflict", title: "Clashes", url: "", datetime: "2026-09-04T18:00:00-07:00" },
      ],
      enrichment: {
        small: { attendeeCount: 40, highValueAttendees: false },
        large: { attendeeCount: 200 },
        conflict: { attendeeCount: 500 }, // huge, but conflict forces skip
      },
      busyEvents: [
        { id: "busy", title: "Standing dinner", datetime: "2026-09-04T18:30:00-07:00", source: "ics" },
      ],
      heuristicOnly: true,
    });
    const by: Record<string, any> = {};
    for (const it of data.ranked) by[it.event.id] = it;
    assert.equal(by.small.decision, "skip", "≤60 no-hv ⇒ skip");
    assert.equal(by.large.decision, "go", "≥150 ⇒ go");
    assert.equal(by.unknown.decision, "maybe", "unknown size ⇒ maybe");
    assert.equal(by.conflict.decision, "skip", "hard conflict ⇒ skip");
  });

  // A11 — ordering: go>maybe>skip, then score desc, stable ties.
  await check("A11 ordering go>maybe>skip, score desc, stable ties", async () => {
    const { data } = await callJson({
      events: [
        { id: "s", title: "skip one", url: "" },
        { id: "g1", title: "go lower", url: "" },
        { id: "m", title: "maybe one", url: "" },
        { id: "g2", title: "go higher", url: "" },
      ],
      enrichment: {
        s: { attendeeCount: 10 }, // skip
        g1: { attendeeCount: 160 }, // go, score 70
        m: {}, // maybe
        g2: { attendeeCount: 160, highValueAttendees: true }, // go, score 88
      },
      heuristicOnly: true,
    });
    const ids = data.ranked.map((r: any) => r.event.id);
    assert.deepEqual(ids, ["g2", "g1", "m", "s"], `unexpected order: ${ids.join(",")}`);
    const rank = (d: string) => (d === "go" ? 2 : d === "maybe" ? 1 : 0);
    for (let i = 1; i < data.ranked.length; i++) {
      const a = data.ranked[i - 1];
      const b = data.ranked[i];
      assert.ok(
        rank(a.decision) > rank(b.decision) ||
          (rank(a.decision) === rank(b.decision) && a.score >= b.score),
        "ordering invariant holds",
      );
    }
  });

  // A14 — id+title only ⇒ scored item, no throw.
  await check("A14 id+title only ⇒ scored RankedItem (graceful)", async () => {
    const { status, data } = await callJson({
      events: [{ id: "paste-0", title: "Bare event" }],
      heuristicOnly: true,
    });
    assert.equal(status, 200);
    assert.equal(data.ranked.length, 1);
    assert.ok(Number.isInteger(data.ranked[0].score));
    assert.ok(DECISIONS.has(data.ranked[0].decision));
  });

  // A19 — 20-event batch under 1s locally.
  await check("A19 20-event batch < 1s", async () => {
    const events = Array.from({ length: 20 }, (_, i) => ({ id: `paste-${i}`, title: `Event ${i}`, url: "" }));
    const start = process.hrtime.bigint();
    const { status, data } = await callJson({ events, heuristicOnly: true });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(status, 200);
    assert.equal(data.count, 20);
    assert.ok(ms < 1000, `took ${ms.toFixed(1)}ms (must be <1000ms)`);
  });

  // A20 — event-specific signal referenced in rationale.
  await check("A20 rationale references the specific signal", async () => {
    const { data } = await callJson({
      events: [{ id: "paste-0", title: "AI Infra Dinner", url: "" }],
      goalKeywords: ["ai infra"],
      enrichment: { "paste-0": { attendeeCount: 42, highValueAttendees: true } },
      heuristicOnly: true,
    });
    const it = data.ranked[0];
    const blob = [...it.pros, ...it.cons].join(" ").toLowerCase();
    assert.ok(blob.includes("42"), "references the specific attendee count");
    assert.ok(blob.includes("ai infra"), "references the matched goal keyword");
  });

  // A23 — score rendered in the card equals the API score (no display drift).
  await check("A23 card renders the exact numeric score", async () => {
    const { data } = await callJson({
      events: [{ id: "paste-0", title: "Scored", url: "" }],
      enrichment: { "paste-0": { attendeeCount: 200, highValueAttendees: true } },
      heuristicOnly: true,
    });
    const it = data.ranked[0] as RankCardItem;
    const html = renderToStaticMarkup(<RankCard item={it} />);
    assert.ok(html.includes(String(it.score)), `card must show score ${it.score}`);
    assert.ok(html.includes("/100"), "card shows 0–100 scale");
  });

  // A10/A21 — card renders title, a distinguishable decision badge with a text
  // label + accessible aria-label (colour never the sole signal).
  await check("A10/A21 card: title + labelled/aria decision badge per state", () => {
    for (const decision of ["go", "maybe", "skip"] as const) {
      const html = renderToStaticMarkup(
        <RankCard
          item={{
            event: { id: "x", title: "Badge Test", url: "" },
            decision,
            score: 50,
            pros: decision === "skip" ? [] : ["a pro"],
            cons: decision === "skip" ? ["a con"] : [],
          }}
        />,
      );
      assert.ok(html.includes("Badge Test"), "renders the title");
      assert.ok(html.includes(`sb-rank-badge-${decision}`), "state-specific badge class");
      assert.ok(html.includes(`Recommendation: ${decision}`), "accessible aria-label present");
      assert.ok(/GO|MAYBE|SKIP/.test(html), "badge carries a text label, not colour alone");
    }
  });

  // A02/A18 — parser ships zero sample data; empty/blank input ⇒ no events.
  await check("A02/A18 empty & blank paste ⇒ zero events (no sample data)", () => {
    assert.deepEqual(parsePastedEvents(""), { events: [], error: null });
    assert.deepEqual(parsePastedEvents("   \n  \n"), { events: [], error: null });
    // Line + JSON modes assign stable paste-<i> ids and keep duplicate titles.
    const lines = parsePastedEvents("Dinner @ SoMa | 2026-09-04T18:00:00-07:00\nDinner");
    assert.equal(lines.error, null);
    assert.deepEqual(lines.events.map((e) => e.id), ["paste-0", "paste-1"]);
    assert.equal(lines.events[0].location, "SoMa");
    const bad = parsePastedEvents("[ {not json ]");
    assert.ok(bad.error && bad.events.length === 0, "malformed JSON ⇒ inline error, no crash");
  });

  // A29 — hostile field shapes still return 200 well-formed (no 500).
  await check("A29 hostile field shapes ⇒ 200 well-formed RankedItem", async () => {
    const { status, data } = await callJson({
      events: [
        {
          id: "paste-0",
          title: "Hostile",
          url: 12345, // non-string url
          host: { evil: true }, // non-string dropped
          location: ["x"], // non-string dropped
          datetime: 99, // non-string dropped
          description: "y".repeat(5000), // oversized ⇒ truncated
        },
      ],
      goalKeywords: ["ok", 5, null], // non-strings filtered
      busyEvents: [{ nonsense: true }, "garbage"], // malformed ⇒ ignored
      enrichment: {
        "paste-0": { attendeeCount: -3, highValueAttendees: "yes" }, // both ignored
      },
      heuristicOnly: true,
    });
    assert.equal(status, 200);
    const it = data.ranked[0];
    assert.equal(it.event.url, "", "non-string url ⇒ ''");
    assert.equal(it.event.host, undefined, "non-string host dropped");
    assert.ok(it.event.description.length <= 2000, "description truncated");
    assert.ok(DECISIONS.has(it.decision) && Number.isInteger(it.score), "still well-formed");
  });

  // A29 — a valid http(s) url longer than 2048 chars is capped server-side.
  await check("A29 oversized http(s) url ⇒ capped at 2048 chars", async () => {
    const longUrl = "https://example.com/" + "a".repeat(3000);
    const { status, data } = await callJson({
      events: [{ id: "paste-0", title: "Long URL", url: longUrl }],
      heuristicOnly: true,
    });
    assert.equal(status, 200);
    assert.ok(
      data.ranked[0].event.url.length <= 2048,
      `url must be capped at 2048, got ${data.ranked[0].event.url.length}`,
    );
    assert.ok(data.ranked[0].event.url.startsWith("https://example.com/"), "scheme/host preserved");
  });

  // =====================================================================
  // sb-calendar-align — busy-calendar conflict assertions (contract A20).
  // Black-box against the REAL route + REAL card. Times all carry an explicit
  // offset so instants are unambiguous regardless of the runner's TZ.
  // =====================================================================

  // Shared valid busy title used across overlap tests.
  const BUSY_AT_1830 = { id: "b1", title: "Standing dinner", datetime: "2026-09-04T18:30:00-07:00" };

  // A20(i) — overlap ⇒ skip + conflict.title == the colliding busy title.
  await check("A20(i) overlapping event ⇒ skip + conflict names the busy entry", async () => {
    const { status, data } = await callJson({
      events: [{ id: "e1", title: "Founders Mixer", url: "", datetime: "2026-09-04T18:00:00-07:00" }],
      enrichment: { e1: { attendeeCount: 300 } }, // would be "go" if not for the conflict
      busyEvents: [BUSY_AT_1830],
      heuristicOnly: true,
    });
    assert.equal(status, 200);
    const it = data.ranked[0];
    assert.equal(it.decision, "skip", "hard conflict ⇒ skip");
    assert.ok(it.conflict, "conflict object present");
    assert.equal(it.conflict.title, "Standing dinner", "names the colliding busy entry");
    assert.equal(it.conflictChecked, true, "conflict was actually checked");
    assert.ok(
      it.cons.some((c: string) => /Time conflict/.test(c)),
      "cons carries the Time conflict string",
    );
  });

  // A20(ii) — no overlap ⇒ conflict null + not calendar-skipped + conflictChecked true.
  await check("A20(ii) non-overlapping event ⇒ conflict null, not calendar-skipped", async () => {
    const { data } = await callJson({
      events: [{ id: "e1", title: "Morning Coffee", url: "", datetime: "2026-09-04T09:00:00-07:00" }],
      enrichment: { e1: { attendeeCount: 300 } },
      busyEvents: [BUSY_AT_1830],
      heuristicOnly: true,
    });
    const it = data.ranked[0];
    assert.equal(it.conflict, null, "no conflict ⇒ null");
    assert.equal(it.decision, "go", "decision from normal rules, not calendar");
    assert.equal(it.conflictChecked, true, "a precise time against a busy calendar ⇒ checked");
  });

  // A20(iii) — index-alignment guard: a dropped-malformed AND a valid
  // non-overlapping busy entry BEFORE the real one ⇒ named conflict is correct.
  await check("A20(iii) malformed+non-overlapping busy before real ⇒ correct name", async () => {
    const { data } = await callJson({
      events: [{ id: "e1", title: "Evening Talk", url: "", datetime: "2026-09-04T18:00:00-07:00" }],
      busyEvents: [
        { id: "m", title: "Dropped (no date)", datetime: "not-a-date" }, // dropped by normalize
        { id: "am", title: "Morning standup", datetime: "2026-09-04T09:00:00-07:00" }, // valid, no overlap
        { id: "pm", title: "Evening dinner", datetime: "2026-09-04T18:30:00-07:00" }, // the real overlap
      ],
      heuristicOnly: true,
    });
    const it = data.ranked[0];
    assert.equal(it.decision, "skip");
    assert.equal(it.conflict.title, "Evening dinner", "names the RIGHT entry, not a mis-indexed one");
  });

  // A20(iv) — candidate with an inverted (end<=start) endDatetime overlapping a
  // busy slot ⇒ still skip + conflict (window falls back to start+1h, A15).
  await check("A20(iv) inverted candidate endDatetime ⇒ still skip + conflict", async () => {
    const { data } = await callJson({
      events: [
        {
          id: "e1",
          title: "Inverted End",
          url: "",
          datetime: "2026-09-04T18:00:00-07:00",
          endDatetime: "2026-09-04T17:00:00-07:00", // inverted ⇒ ignored, window = start+1h
        },
      ],
      busyEvents: [BUSY_AT_1830],
      heuristicOnly: true,
    });
    const it = data.ranked[0];
    assert.equal(it.decision, "skip", "inverted end doesn't miss the overlap");
    assert.equal(it.conflict.title, "Standing dinner");
  });

  // A20(v) — >1000 busyEvents ⇒ busyTruncated:true, 200, no crash.
  await check("A20(v) >1000 busyEvents ⇒ busyTruncated:true, 200, no crash", async () => {
    const busyEvents = Array.from({ length: 1001 }, (_, i) => ({
      id: `b${i}`,
      title: `Busy ${i}`,
      datetime: "2026-09-04T09:00:00-07:00",
    }));
    const { status, data } = await callJson({
      events: [{ id: "e1", title: "Overflow", url: "", datetime: "2026-09-04T12:00:00-07:00" }],
      busyEvents,
      heuristicOnly: true,
    });
    assert.equal(status, 200);
    assert.equal(data.busyTruncated, true, "overflow flagged, not silently dropped");
    assert.equal(data.busyConsidered, 1000, "considered exactly the cap");
  });

  // A20(vi) — a 250-char busy title ⇒ conflict.title length ≤ 200.
  await check("A20(vi) 250-char busy title ⇒ conflict.title ≤ 200", async () => {
    const { data } = await callJson({
      events: [{ id: "e1", title: "Amplify", url: "", datetime: "2026-09-04T18:00:00-07:00" }],
      busyEvents: [{ id: "b", title: "X".repeat(250), datetime: "2026-09-04T18:30:00-07:00" }],
      heuristicOnly: true,
    });
    const it = data.ranked[0];
    assert.equal(it.decision, "skip");
    assert.ok(it.conflict.title.length <= 200, `title capped, got ${it.conflict.title.length}`);
  });

  // A20(vi-b) — date-only busy value ⇒ dropped + busySkipped, never a midnight slot.
  await check("A20(vi-b) date-only busy value ⇒ dropped + busySkipped", async () => {
    const { data } = await callJson({
      events: [{ id: "e1", title: "Midnight?", url: "", datetime: "2026-09-04T00:30:00-07:00" }],
      busyEvents: [{ id: "b", title: "All day", datetime: "2026-09-04" }],
      heuristicOnly: true,
    });
    const it = data.ranked[0];
    assert.equal(data.busySkipped, 1, "date-only entry counted as skipped");
    assert.equal(data.busyConsidered, 0, "no valid busy slot formed");
    assert.equal(it.conflict, null, "no silent midnight conflict");
  });

  // A20(vi-c) — offset-less/naive busy value ⇒ dropped + busySkipped (no server-TZ ambiguity).
  await check("A20(vi-c) offset-less busy value ⇒ dropped + busySkipped", async () => {
    const { data } = await callJson({
      events: [{ id: "e1", title: "Naive", url: "", datetime: "2026-09-04T18:00:00-07:00" }],
      busyEvents: [{ id: "b", title: "Naive dinner", datetime: "2026-09-04T18:00" }],
      heuristicOnly: true,
    });
    assert.equal(data.busySkipped, 1, "offset-less entry counted as skipped");
    assert.equal(data.busyConsidered, 0, "no ambiguous slot formed");
    assert.equal(data.ranked[0].conflict, null);
  });

  // A20(vi-d) — offset-less candidate endDatetime ⇒ treated as absent (start+1h);
  // a candidate whose datetime lacks time+offset ⇒ conflictChecked:false.
  await check("A20(vi-d) offset-less end ⇒ start+1h; imprecise datetime ⇒ conflictChecked:false", async () => {
    const r1 = await callJson({
      events: [
        {
          id: "e1",
          title: "Loose end",
          url: "",
          datetime: "2026-09-04T18:00:00-07:00",
          endDatetime: "2026-09-04T23:00", // offset-less ⇒ ignored, window = start+1h
        },
      ],
      busyEvents: [BUSY_AT_1830],
      heuristicOnly: true,
    });
    assert.equal(r1.data.ranked[0].decision, "skip", "1h fallback still catches the 18:30 overlap");

    const r2 = await callJson({
      events: [{ id: "e1", title: "Imprecise", url: "", datetime: "2026-09-04T18:00" }], // no offset
      busyEvents: [BUSY_AT_1830],
      heuristicOnly: true,
    });
    const it2 = r2.data.ranked[0];
    assert.equal(it2.conflictChecked, false, "imprecise datetime ⇒ not checked");
    assert.equal(it2.conflict, null, "not a false conflict");
    assert.notEqual(it2.decision, undefined, "still scored normally");
  });

  // A20(vii) — a <script> busy title renders ESCAPED in the conflict banner.
  await check("A20(vii) <script> busy title renders escaped in the conflict banner", () => {
    const item: RankCardItem = {
      event: { id: "e1", title: "Safe title", url: "" },
      decision: "skip",
      score: 0,
      pros: [],
      cons: ['Time conflict with "x"'],
      conflict: { title: "<script>alert(1)</script>", datetime: "2026-09-04T18:30:00-07:00" },
      conflictChecked: true,
    };
    const html = renderToStaticMarkup(<RankCard item={item} calendarProvided />);
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "conflict title escaped");
    assert.ok(!html.includes("<script>alert(1)</script>"), "no live <script> element");
    assert.ok(/Calendar conflict/.test(html), "distinct conflict banner rendered");
  });

  // A21/A04 — busy accounting present on every 200 path, default 0/false/0.
  await check("A21/A04 busy meta present + defaults 0/false/0 with no busyEvents", async () => {
    const empty = await callJson({ events: [] });
    assert.equal(empty.data.busyConsidered, 0);
    assert.equal(empty.data.busyTruncated, false);
    assert.equal(empty.data.busySkipped, 0);
    const heur = await callJson({ events: [{ id: "e1", title: "No cal", url: "" }], heuristicOnly: true });
    assert.equal(heur.data.busyConsidered, 0);
    assert.equal(heur.data.busyTruncated, false);
    assert.equal(heur.data.busySkipped, 0);
    // No busy calendar ⇒ conflictChecked false for all items (nothing to check).
    assert.equal(heur.data.ranked[0].conflictChecked, false);
    assert.equal(heur.data.ranked[0].conflict, null);
  });

  // A20(vii)/card — non-conflicting card shows NO banner even with calendar provided.
  await check("non-conflicting card shows no conflict banner", () => {
    const html = renderToStaticMarkup(
      <RankCard
        item={{
          event: { id: "e1", title: "Clear", url: "" },
          decision: "go",
          score: 80,
          pros: ["a pro"],
          cons: [],
          conflict: null,
          conflictChecked: true,
        }}
        calendarProvided
      />,
    );
    assert.ok(!/Calendar conflict/.test(html), "no banner when no conflict");
    assert.ok(!/check your calendar/.test(html), "no couldn't-check note when checked");
  });

  // Card: imprecise event with calendar provided ⇒ "couldn't check" note (not all-clear).
  await check("imprecise event + calendar ⇒ couldn't-check note, not all-clear", () => {
    const html = renderToStaticMarkup(
      <RankCard
        item={{
          event: { id: "e1", title: "Imprecise", url: "" },
          decision: "maybe",
          score: 50,
          pros: [],
          cons: ["Attendee count unknown — needs a closer look"],
          conflict: null,
          conflictChecked: false,
        }}
        calendarProvided
      />,
    );
    assert.ok(/check your calendar/.test(html), "shows couldn't-check note");
  });

  // Client parser: busy lines without a datetime are dropped + counted (A03).
  await check("parseBusyCalendar drops datetime-less lines + counts skipped", () => {
    const r = parseBusyCalendar(
      "Standing dinner | 2026-09-04T18:30:00-07:00\nNo datetime here\nGym | 2026-09-05T07:00:00-07:00",
    );
    assert.equal(r.error, null);
    assert.equal(r.events.length, 2, "two valid busy entries");
    assert.equal(r.skipped, 1, "one datetime-less line skipped");
    assert.deepEqual(r.events.map((e) => e.id), ["busy-0", "busy-1"], "stable busy-<i> ids");
    // JSON mode + no sample data on empty input.
    assert.deepEqual(parseBusyCalendar(""), { events: [], skipped: 0, error: null });
    const j = parseBusyCalendar('[{"title":"X","datetime":"2026-09-04T18:00:00-07:00"},{"title":"Y"}]');
    assert.equal(j.events.length, 1);
    assert.equal(j.skipped, 1, "object missing datetime skipped");
  });

  // =====================================================================
  // sb-rank-url-import — paste-a-link import (spec art_qGXLTdaf).
  // The splitter is pure (no fetch): these checks pin its classification,
  // line preservation, and the composed merge shape the client sends to
  // /api/rank. End-to-end URL fetches are verified live in the PR E2E.
  // =====================================================================

  // URL1 — classification: every supported URL form lifts out as a token,
  // in input order; case-insensitive schemes.
  await check("URL1 splitter: webcal / https-ics / scheme'd lu.ma / bare lu.ma+luma.com ⇒ url tokens, in order", () => {
    const s = splitImportInput(
      "webcal://cal.example.com/feed.ics\n" +
        "HTTPS://CAL.EXAMPLE.COM/holidays.ics\n" +
        "https://lu.ma/h7h9r7bw\n" +
        "lu.ma/z9z8z8z8\n" +
        "luma.com/abc-defg\n" +
        "https://api.lu.ma/ics/get?entity=calendar&id=cal_x",
    );
    assert.deepEqual(s.urls, [
      "webcal://cal.example.com/feed.ics",
      "HTTPS://CAL.EXAMPLE.COM/holidays.ics",
      "https://lu.ma/h7h9r7bw",
      "lu.ma/z9z8z8z8",
      "luma.com/abc-defg",
      "https://api.lu.ma/ics/get?entity=calendar&id=cal_x",
    ]);
    assert.equal(s.unsupported.length, 0);
    assert.equal(s.rest.trim(), "", "a fully-URL paste leaves no residual text");
  });

  // URL2 — tokenization matches the import route's rule (whitespace/commas);
  // prose containing the word "webcal" and bare slugs are NOT url tokens.
  await check("URL2 splitter: comma separation; no false positive on 'webcal' prose or bare slugs", () => {
    const comma = splitImportInput("https://lu.ma/h7h9r7bw,webcal://cal.example.com/f.ics,lu.ma/z9z8z8z8");
    assert.equal(comma.urls.length, 3, "commas split tokens like the route does");
    const prose = splitImportInput("Our webcal feeds sync nightly\nDinner @ SoMa | 2026-09-04T18:00:00-07:00");
    assert.deepEqual(prose.urls, [], "the word 'webcal' alone is not a URL");
    assert.deepEqual(prose.unsupported, []);
    assert.equal(prose.rest, "Our webcal feeds sync nightly\nDinner @ SoMa | 2026-09-04T18:00:00-07:00", "URL-free input passes through byte-for-byte");
    // The import route's own parser claims bare 4+ char slugs (short event
    // codes) — the /rank splitter must NOT, or every word becomes a fetch.
    const bare = splitImportInput("h7h9r7bw");
    assert.deepEqual(bare.urls, []);
    assert.deepEqual(bare.unsupported, []);
    assert.equal(bare.rest, "h7h9r7bw");
  });

  // URL3 — mixed URL + line: the URL lifts out, the real lines survive for
  // line-mode parsing with stable paste-<i> ids.
  await check("URL3 splitter: mixed URL+lines ⇒ rest keeps the two real lines", () => {
    const s = splitImportInput(
      "Dinner @ SoMa | 2026-09-04T18:00:00-07:00\nhttps://lu.ma/h7h9r7bw\nMeetup @ Warehouse",
    );
    assert.deepEqual(s.urls, ["https://lu.ma/h7h9r7bw"]);
    const parsed = parsePastedEvents(s.rest);
    assert.equal(parsed.error, null);
    assert.equal(parsed.events.length, 2, "line-mode sees exactly the real lines");
    assert.equal(parsed.events[0].title, "Dinner");
    assert.equal(parsed.events[1].title, "Meetup");
    assert.deepEqual(parsed.events.map((e) => e.id), ["paste-0", "paste-1"]);
  });

  // URL4 — REGRESSION (the defect this spec fixes): a bare URL line used to
  // become a junk event titled with the URL string. Through the composed
  // path it must route to the importer instead, leaving no title-event.
  await check("URL4 regression: URL-only line ⇒ import token, zero junk title-events", () => {
    const s = splitImportInput("https://lu.ma/h7h9r7bw");
    assert.equal(s.urls.length, 1);
    assert.deepEqual(parsePastedEvents(s.rest).events, [], "no junk event from the composed path");
    // Documents the defect: the raw parser (unsplit) still manufactures a
    // title-event from a URL line — the page must always split first.
    const junk = parsePastedEvents("https://lu.ma/h7h9r7bw");
    assert.equal(junk.events.length, 1);
    assert.equal(junk.events[0].title, "https://lu.ma/h7h9r7bw");
  });

  // URL5 — scheme'd tokens the import route would silently drop are caught
  // client-side as unsupported (warned, never fetched, never dropped silently).
  await check("URL5 splitter: unsupported tokens ⇒ flagged; prose colons stay text", () => {
    const s = splitImportInput(
      "mailto:x@y.z\njavascript:alert(1)\nhttps://example.com/not-a-calendar\nhttps://lu.ma/u/profile\nNote: dinner at eight",
    );
    assert.deepEqual(s.unsupported, [
      "mailto:x@y.z",
      "javascript:alert(1)",
      "https://example.com/not-a-calendar",
      "https://lu.ma/u/profile",
    ]);
    assert.deepEqual(s.urls, []);
    assert.equal(s.rest.trim(), "Note: dinner at eight", "a trailing colon is prose, not a scheme");
  });

  // URL6 — importWarnings: per-URL errors and unsupported tokens become
  // visible warnings; empty inputs produce none.
  await check("URL6 importWarnings: unsupported + per-URL errors ⇒ warnings; none when empty", () => {
    assert.deepEqual(importWarnings([], []), []);
    const w = importWarnings(
      ["mailto:x@y.z"],
      [{ url: "https://lu.ma/gone", message: "Response wasn't an iCal feed" }],
    );
    assert.equal(w.length, 2);
    assert.ok(w[0].includes("mailto:x@y.z"), "unsupported token named in the warning");
    assert.ok(w[1].includes("https://lu.ma/gone") && w[1].includes("Response wasn't an iCal feed"), "per-URL failure named in the warning");
  });

  // URL7 — detectSource rule (committed fix): lu.ma hosts are subscriptions
  // only for /ics/ paths; event and profile pages reach the Luma fetcher.
  await check("URL7 detectSource: lu.ma /ics/ ⇒ subscription; event/profile pages ⇒ null", () => {
    assert.equal(detectSource("https://lu.ma/h7h9r7bw"), null, "event page must not misroute to the ICS fetcher");
    assert.equal(detectSource("https://lu.ma/u/someone"), null, "profile page too");
    const sub = detectSource("https://api.lu.ma/ics/get?entity=calendar&id=cal_x");
    assert.ok(sub && sub.source === "luma", "api.lu.ma/ics/ is a Luma subscription");
    const shape = detectSource("https://lu.ma/ics/get?entity=calendar&id=cal_x");
    assert.ok(shape && shape.source === "luma", "/ics/ path shape is a Luma subscription");
    const webcal = detectSource("webcal://cal.example.com/feed.ics");
    assert.ok(webcal && webcal.source === "ics", "webcal stays a subscription");
  });

  // URL8 — conflict integrity: an imported busy event (the exact shape
  // /api/calendar/import returns, mapped by importedToRankable) collides
  // exactly like a pasted busy line — skip + named conflict + checked.
  await check("URL8 imported strict-instant busy event ⇒ skip + named conflict + busyConsidered 1", async () => {
    const imported: CalendarEvent = {
      id: "imp-1",
      title: "Imported standing dinner",
      host: "cal.example.com",
      datetime: "2026-09-04T18:30:00-07:00",
      endDatetime: "2026-09-04T20:30:00-07:00",
      url: "https://cal.example.com/feed.ics",
      source: "ics",
      sourceLabel: "cal.example.com",
    };
    const mapped = importedToRankable(imported);
    assert.equal(mapped.url, "https://cal.example.com/feed.ics");
    assert.equal(mapped.source, "ics");
    const { status, data } = await callJson({
      events: [{ id: "e1", title: "Founders Mixer", url: "", datetime: "2026-09-04T18:00:00-07:00" }],
      enrichment: { e1: { attendeeCount: 300 } },
      busyEvents: [mapped],
      heuristicOnly: true,
    });
    assert.equal(status, 200);
    const it = data.ranked[0];
    assert.equal(it.decision, "skip", "imported busy entry forces the skip");
    assert.equal(it.conflict.title, "Imported standing dinner");
    assert.equal(it.conflictChecked, true);
    assert.equal(data.busyConsidered, 1, "a strict-instant slot formed from the import");
    assert.equal(data.busySkipped, 0);
  });

  // URL9 — busy-box composition with a date-only feed (the US-holiday E2E
  // expectation, Amendment 1): strict-gate drops with honest accounting,
  // no fabricated conflicts.
  await check("URL9 imported date-only busy entries ⇒ busySkipped accounting, no fake conflicts", async () => {
    const { status, data } = await callJson({
      events: [{ id: "e1", title: "Any event", url: "", datetime: "2026-09-04T18:00:00-07:00" }],
      busyEvents: [
        importedToRankable({
          id: "hol-1",
          title: "Constructed holiday",
          host: "calendar.google.com",
          datetime: "2026-09-04", // date-only DTSTART normalization output
          url: "https://cal.example.com/holidays.ics",
          source: "google",
          sourceLabel: "Google Calendar",
        }),
      ],
      heuristicOnly: true,
    });
    assert.equal(status, 200);
    assert.equal(data.busySkipped, 1, "date-only import counted as skipped");
    assert.equal(data.busyConsidered, 0, "no ambiguous slot formed");
    assert.equal(data.ranked[0].conflict, null, "no fabricated conflict");
    assert.equal(data.ranked[0].conflictChecked, false, "nothing usable to check against");
  });

  console.log(`\nrank-smoke: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
