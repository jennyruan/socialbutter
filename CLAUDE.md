# ButterSocial — project rules

Hackathon project. Beta Fund × Evermind "One Person Company", SF 2026-05-30.
Read `README.md` first for the locked one-page design (user / data model /
demo script / scope / time-box).

---

## 1. Push to main (overrides global Branch Safety)

This is a hackathon repo with multiple Claude terminals + a human all
contributing in parallel for ~3 hours. Branch-and-PR friction is unaffordable.

**Rules:**
- Commit and push directly to `main`. No feature branches. No PRs.
- Print `git diff origin/main --stat` before every push **but do not pause
  for confirmation** — print, push, move on.
- Use the global commit message format (Co-Authored-By trailer included).
- If a push fails because someone else pushed, pull --rebase and retry.

This rule supersedes the global `~/.claude/CLAUDE.md` Branch Safety and
Pre-Push Review sections **for this repo only**.

---

## 2. No mock data

**All data must be real.** No fixtures, no hardcoded sample events, no
fake users, no dummy Evermind memories, no Lorem Ipsum.

Why: the demo's wow moment depends on Evermind retrieving Jenny's *actual*
past event feedback on screen. Mock data breaks the story and is obvious to
judges who've seen 50 demos that day.

**How to apply:**
- Luma fetcher hits the real `lu.ma` site (HTML scrape / JSON-LD / __NEXT_DATA__).
- Evermind reads/writes go to a real Evermind instance.
- Butterbase persistence goes to a real Butterbase project.
- Jenny's actual past events from her Luma profile are the demo dataset.
- If a vendor SDK isn't wired up yet, leave the call site as a clearly
  marked `TODO: wire Evermind here` rather than substituting a fake value.

---

## 3. Design language — mirror AMGINA

Visual language follows `~/code/experiments/amgina/app/globals.css`.

**Tokens (day theme):**
- `--cream` `#F5EFE0` (app bg) · `--paper` `#FBF7EC` (panes) · `--ink` `#2B2B2B` (text/borders)
- `--amber` `#D4A657` (primary accent) · `--coral` `#D46A6A` (warm accent)

**Type:** `LXGW WenKai Screen`, `Noto Sans SC`, system-ui (sans).
`JetBrains Mono` (mono).

**Shape:** 2px ink borders, `border-radius: 0` on cards, square 36×36 icon
buttons, sticky header.

**Class prefix:** use `bs-*` (ButterSocial) mirroring AMGINA's `amg-*`.
E.g. `bs-card`, `bs-header`, `bs-fab`, `bs-icon-btn`.

Draft tokens live at `drafts/bs-tokens.css` — merge into `app/globals.css`
when scaffold lands.

---

## 4. Multi-terminal coordination

3 Claude terminals + 1 zsh open in parallel. To avoid collisions:

**Ownership map** (update this section as work shifts):
- **Terminal A (Opus, design + Luma + UI):** `lib/luma.ts`, `drafts/`, README, this file
- **Terminal B (tools + backend):** scaffold (`package.json`, `next.config.ts`, `app/layout.tsx`, `app/globals.css`, `tsconfig.json`), Butterbase MCP wiring, Evermind SDK wiring, `.env.local`
- **Terminal C:** TBD — claim a slice in this file before editing

**Protocol:**
- Before editing any file, `git pull --rebase` + check `git status`.
- After landing a change, `git push` immediately so others see it.
- If you're about to edit a file outside your ownership slice, comment in this
  file or ping in zsh terminal first.

---

## 5. File layout (target post-scaffold)

```
buttersocial/
├── app/
│   ├── layout.tsx              ← Terminal B (scaffold)
│   ├── globals.css             ← Terminal B (merge drafts/bs-tokens.css in)
│   ├── page.tsx                ← landing / dashboard
│   ├── connect/
│   │   └── page.tsx            ← from drafts/connect-page.tsx
│   └── api/
│       └── luma/
│           └── import/
│               └── route.ts    ← from drafts/luma-import-route.ts
├── lib/
│   ├── luma.ts                 ← Luma fetcher (DONE)
│   ├── evermind.ts             ← Terminal B
│   └── butterbase.ts           ← Terminal B
├── drafts/                     ← pre-scaffold staging, delete after migration
├── CLAUDE.md
└── README.md
```

**Post-scaffold migration:**
1. Move `drafts/connect-page.tsx` → `app/connect/page.tsx`
2. Move `drafts/luma-import-route.ts` → `app/api/luma/import/route.ts`
3. Merge `drafts/bs-tokens.css` contents into `app/globals.css`
4. Delete `drafts/`
5. Add LXGW WenKai font (Google Fonts: `https://fonts.googleapis.com/...`
   or self-host) in `app/layout.tsx`

---

## 6. Sync ritual (read this every turn)

3 Claude Code terminals are running in parallel. Conversation context
never crosses terminals; only files + git do. To stay current:

**At the start of every turn in this project, run:**
```bash
bash .claude/sync-hook.sh
```

This script auto-fetches `origin/main`, fast-forwards if you're clean and
behind, then prints `STATUS.md` tail + recent `git log` + any uncommitted
files. Output goes into your context.

**After every meaningful action** (commit, decision, blocker, handoff),
append one line to `STATUS.md` and push immediately:
```
- HH:MM [tag] short description — files or commit short-sha
```

Pick a `tag` at session start (A, B, C, or a topic like "luma", "scaffold")
and keep using it.

**Optional auto-fire:** if Jenny enables the UserPromptSubmit hook
(`docs/sync-protocol.md` has the JSON), the script fires automatically
every prompt — closest to real-time the harness allows.

See `docs/sync-protocol.md` for details and conflict handling.

---

## 7. Submission checklist (4:00pm hard deadline)

- [ ] App running locally and screencast-able
- [ ] Evermind memory retrieval visible in demo flow
- [ ] Butterbase persistence working (event + attendance write)
- [ ] Luma data is real (Jenny's actual profile)
- [ ] 3-slide deck in master Google Slides
- [ ] ≤2-min video demo recorded (OBS) and embedded
- [ ] Submitted via Butterbase MCP
