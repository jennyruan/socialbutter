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
import { parsePastedEvents } from "../app/rank/parse";

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

  console.log(`\nrank-smoke: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
