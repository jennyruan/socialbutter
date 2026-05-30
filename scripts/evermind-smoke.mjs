#!/usr/bin/env node
// Smoke test for Evermind API wiring.
// Run: node scripts/evermind-smoke.mjs
// Requires: EVERMIND_API_KEY in env.

const API = "https://api.evermind.ai";
const KEY = process.env.EVERMIND_API_KEY;

if (!KEY) {
  console.error("EVERMIND_API_KEY not set. Add to ~/.zshenv and `source` it.");
  process.exit(1);
}

const userId = "buttersocial_demo_user";
const sessionId = `smoke_${Date.now()}`;

async function call(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, ok: res.ok, body: json };
}

console.log(`→ Writing memory for user=${userId} session=${sessionId}`);
const write = await call("/api/v1/memories", {
  user_id: userId,
  session_id: sessionId,
  messages: [
    {
      role: "user",
      timestamp: Date.now(),
      content:
        "I went to a web3-only happy hour two weeks ago and it drained me. I want events with mixed AI/infra folks instead.",
    },
  ],
});
console.log(`  status=${write.status}`, JSON.stringify(write.body, null, 2));

if (!write.ok) {
  console.error("Write failed — stopping before search.");
  process.exit(1);
}

console.log(`\n→ Searching memories for: "what kinds of events drain me?"`);
const search = await call("/api/v1/memories/search", {
  query: "what kinds of events drain me",
  filters: { user_id: userId },
  method: "hybrid",
  top_k: 5,
});
console.log(`  status=${search.status}`, JSON.stringify(search.body, null, 2));

console.log(
  search.ok
    ? "\n✅ Evermind wired. Write + search both returned 2xx."
    : "\n❌ Search failed — see body above for the schema mismatch."
);
