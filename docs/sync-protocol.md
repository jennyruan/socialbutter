# Multi-terminal sync protocol

3 Claude Code terminals + 1 zsh, all running against this repo. Conversation
context never crosses terminals. Files on disk + the git remote are the only
real shared state. This doc says how we use them.

---

## Two layers

### Layer 1 — STATUS.md heartbeat (always on)

`STATUS.md` at repo root is an append-only log. After every meaningful
action — commit, decision, blocker, handoff — append one line and push:

```
- HH:MM [tag] short description — files or commit short-sha
```

Every Claude in this project should `tail STATUS.md` at the start of each
turn (CLAUDE.md §7 instructs it to). That's how it sees what other terminals
just did.

### Layer 2 — Auto-sync hook (opt-in, faster)

`.claude/sync-hook.sh` already exists and is executable. It:
- Fetches `origin/main` (3s timeout)
- Fast-forwards if local is clean and behind
- Prints STATUS.md tail + recent `git log` + any uncommitted files

You can run it manually any time:
```bash
bash .claude/sync-hook.sh
```

To wire it to fire **on every UserPromptSubmit** (Claude Code hook system),
create `.claude/settings.json` with this content yourself (Claude can't write
this file because the auto-mode classifier protects hook config):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/jennyr/code/experiments/buttersocial/.claude/sync-hook.sh"
          }
        ]
      }
    ]
  }
}
```

After saving, restart Claude Code in this project (so the project-level
settings load). The hook fires on every prompt and its stdout becomes
additional context for that turn.

**Trade-off:** with the hook, sync happens automatically every prompt
(closest to real-time the harness allows). Without it, you rely on Claude
following the CLAUDE.md instruction to read STATUS.md and `git pull` at
turn start.

---

## How close to real-time is this?

| Layer | When sync happens |
|---|---|
| `git push` | Real-time — pushed commits appear at the remote immediately |
| `git fetch` / `pull` | On demand — each terminal pulls when it runs the script or hook |
| Conversation context | Never crosses terminals (harness limitation) |
| MEMORY.md (`~/.claude/projects/...`) | Re-injected to each terminal's context **on every UserPromptSubmit** |
| Project CLAUDE.md | Re-injected to each terminal's context **on every UserPromptSubmit** |
| STATUS.md | Read by the hook (auto) or by Claude per CLAUDE.md (manual) — at most one prompt behind |

The practical floor: **other terminals see your work the next time their
user sends a prompt**. With the auto-hook, that's literally one keystroke
later. Without it, it's one keystroke + Claude following the protocol.

---

## What to do if things conflict

- `git pull` fails because local is dirty → commit or stash first, then pull.
- `git pull` says diverged → rebase: `git pull --rebase origin main`, resolve
  conflicts, push. If too painful, ask in zsh terminal which terminal owns
  the divergent file and coordinate manually.
- Two terminals touching the same file → CLAUDE.md §4 ownership map should
  prevent this. If it happens, the one with the smaller change yields.
