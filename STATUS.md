# STATUS — multi-terminal heartbeat

Append a line after every meaningful action (commit, decision, blocker, hand-off).
Read the tail of this file at the start of every turn to see what other
terminals are doing.

## Protocol

- Format: `- HH:MM [tag] action — files or commit short-sha`
- `tag` is whatever identifies this terminal: A / B / C, or a topic
  ("luma", "evermind", "scaffold"). Pick at start of session, stick with it.
- **Append-only.** Don't edit past lines.
- **Push immediately** after appending so others see it.
- Heartbeat at least every 15 min even if just "still on X".

## Log

- 13:34 [A] Init: README + first commit `e1bb56d`, GitHub repo created (`jennyruan/buttersocial`, public).
- 13:43 [A] CLAUDE.md (project rules) + Luma fetcher + drafts/ (UI, CSS, route) pushed `a963508`.
- 13:43 [B] Added `.mcp.json` (Butterbase MCP) + `scripts/evermind-smoke.mjs` (API validation).
- 13:52 [A] Pivoted Luma fetcher to URL-paste flow (profile API is private); organizer-array fix `736b617`.
- 14:50 [A] Agent (rank + draft + feedback) + LLM client pushed `93b5f4f`. Awaiting scaffold + `lib/evermind.ts`.
- 15:05 [A] Added STATUS.md + sync-hook for near-real-time coordination.
- 15:18 [A] Luma "connect" via personal iCal subscription URL — `fetchLumaEventsFromIcsUrl` + ICS parser in `lib/luma.ts`; `fetchLumaFromInput` routes ICS-vs-URL-paste; connect UI copy leads with calendar URL.
- 15:25 [A-opus] Verified Evermind LIVE — `scripts/evermind-smoke.mjs` write=202 search=200. Wrote `lib/evermind.ts` (HttpEvermindClient) implementing `EvermindClient`. ⚠️ Writes are async — pre-seed memories minutes before demo, don't seed live.
- 15:37 [A-opus] Scaffolded Next.js 15 + React 19 by hand. App is LIVE on http://localhost:3000/connect — `/api/luma/import` returns real today's-hackathon-event JSON (verified). Added .gitignore for `.next/`, `node_modules/`, `.env*`, `/.claude/settings.json`, `/seed/feedback.json`.
- 15:50 [A] Backstage browser agent shipped. `lib/browser-agent.ts` (Playwright, persistent Chrome profile @ `~/.buttersocial-browser-profile`, humanized delays/typing/scroll, webdriver-flag override, rate-limits LinkedIn=8/hr 25/day). Actions: `rsvpLumaEvent`, `linkedinConnect`, `runBackstageQueue`. One-time login via `node scripts/browser-agent-setup.mjs`. CLI testing via `pnpm exec tsx scripts/browser-agent-run.ts ...`. Added `playwright` + `tsx` to deps.
