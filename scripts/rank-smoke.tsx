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

  console.log(`\nrank-smoke: ${passed} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
