# ButterSocial

Agent that helps busy professionals decide which events to attend — based on calendar availability, past event feedback, and a self-evolving memory of what works for them.

Built for **Beta Fund × Evermind "One Person Company" Hackathon**, San Francisco, Sat 2026-05-30.

---

## Why

Solo founders and busy professionals get 5–15 event invites a week. They can't tell which are worth their time. Time IS the company. Most existing tools are calendar-passive; we want an agent that ranks, drafts intros, and learns from feedback.

---

## Stack (vendor-locked for prize eligibility)

| Layer | Vendor / Tool |
|---|---|
| Agent memory (self-evolving) | **Evermind** |
| Backend (DB, auth, storage, functions) | **Butterbase** |
| Ranking + draft generation | LLM (TBD which) |
| Frontend | Next.js, single page |
| Submission channel | Butterbase MCP |

---

## Target user (v1)

The solo founder / busy professional at a coworking space who:
- Has 5–15 event invites per week (Luma, email forwards, DMs).
- Has gone to events that wasted their time.
- Wants to network strategically but is tired of being the one doing all the planning.

---

## Data model

**Butterbase tables**
- `events` — id, title, host, datetime, url, source (luma), tags, raw_metadata
- `attendance` — event_id, user_id, status (attended | skipped | recommended), feedback_text, rating (1–5)
- `host_intros` — event_id, draft_message, sent (bool), feedback

**Evermind memory namespace (per user)**
- Past event feedback (what drained you, what energized you)
- Who you clicked with (patterns of host / attendee types)
- Stated goals ("I want to meet AI infra investors this month")

---

## Demo script (3 min — the ONE wow moment is the Evermind retrieval on screen)

**0:00–0:30 — Problem**
> "I'm at a hackathon today. Three weeks ago I went to 11 events. 4 wasted my time. I'm a solo founder. My time IS the company."

**0:30–2:30 — Demo**
1. Paste 3 real Luma event URLs.
2. Agent fetches metadata, calls Evermind for past feedback context.
3. Output card: ranked recommendation with **citations from Evermind memory** shown live on screen — e.g., *"Skip #1: you said two weeks ago that pure-web3 events drain you. Skip #3: time conflict + similar to the event you rated 2/5 last month."*
4. For #2 (the recommended one): a draft host-intro message generated from past patterns of who you've clicked with.
5. User clicks "good rec" → Evermind memory updates live → next ranking gets sharper.

**2:30–3:00 — Vision + ask**
> "Today: pick events. Next: full social ops layer — auto-RSVP, follow-ups, intro chains. Asking for the Beta Fellowship."

---

## Scope (locked 2026-05-30 ~1:25pm)

### ✅ In v1
- Paste Luma URL → fetch metadata (OG tags or pre-fetched fixtures if API blocked)
- Evermind: write past feedback, retrieve as ranking context
- Butterbase: persist events + attendance + intros
- LLM ranking with cited reasoning
- LLM-drafted host intro (DRAFT ONLY, not sent)
- Single-screen UI (paste box + output card)
- Pre-loaded real demo data (Jenny's actual past events)

### ❌ Cut for v1 (do not rebuild)
- LinkedIn / Instagram / X API integration → mock in demo, roadmap slide
- Real outreach sending → live-demo risk too high
- Follow-up auto-send → roadmap
- Real calendar API integration → mock OK
- Recommendation engine over a discovery feed → only rank what user pastes

---

## Time-box

| Time | Task |
|---|---|
| 1:10–1:25 | Lock scope + design (this README) |
| 1:25–1:40 | Butterbase MCP onboarding (unfamiliar tool = highest risk) |
| 1:40–2:50 | Core build: Evermind write/read, LLM rank + draft, Butterbase persistence |
| 2:50–3:20 | Single-screen UI |
| 3:20–3:40 | Preload real demo data, rehearse 2× |
| 3:40–3:58 | Record video (OBS), 3 slides, submit via Butterbase MCP |
| 4:00 | Submit |
| 4:00–5:00 | Live 3-min demos |
| 5:00–5:30 | Voting + awards |

---

## Prize target

**Beta Fellowship — $25K + 8-week pre-accelerator.** Audience-favorite cash is the side prize; the fellowship is the real one.

---

## What this is NOT

This is **not AMGINA**. AMGINA is the locked local-first + E2EE personal AI shell. ButterSocial is a cloud agent on Evermind for a specific GTM-ops use case. Keep stories separate.
