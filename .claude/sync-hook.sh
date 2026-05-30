#!/bin/bash
# sync-hook.sh — runs on UserPromptSubmit in this project.
#
# Goal: get each terminal as close to real-time-synced as possible.
# - Quick fetch from origin (3s timeout so a flaky network doesn't stall).
# - Fast-forward main if clean and behind.
# - Print STATUS.md tail + recent git log so the model sees what other
#   terminals just did.
#
# Output is treated as additional context for the user prompt.

set +e  # never fail the prompt because of sync issues

REPO="/Users/jennyr/code/experiments/buttersocial"

# Only run if the current shell is anywhere inside the repo.
case "$PWD" in
  "$REPO"|"$REPO"/*) ;;
  *) exit 0 ;;
esac

cd "$REPO" 2>/dev/null || exit 0

# --- Fetch + auto-ff -------------------------------------------------
timeout 3 git fetch origin main --quiet 2>/dev/null

LOCAL=$(git rev-parse HEAD 2>/dev/null)
REMOTE=$(git rev-parse origin/main 2>/dev/null)
DIRTY_COUNT=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

if [ -n "$LOCAL" ] && [ -n "$REMOTE" ] && [ "$LOCAL" != "$REMOTE" ]; then
  if [ "$DIRTY_COUNT" = "0" ]; then
    if git merge --ff-only origin/main --quiet 2>/dev/null; then
      echo "🔄 Auto-pulled → $(git rev-parse --short HEAD)"
    else
      echo "⚠️  origin/main diverged from local; manual merge needed"
    fi
  else
    echo "⚠️  $DIRTY_COUNT local change(s); skipping auto-pull (commit or stash first)"
  fi
fi

# --- Show heartbeat + recent log ------------------------------------
echo
echo "=== STATUS.md (last 12) ==="
tail -12 STATUS.md 2>/dev/null || echo "(no STATUS.md yet)"

echo
echo "=== git log (last 5) ==="
git log --oneline -5 2>/dev/null

if [ "$DIRTY_COUNT" != "0" ]; then
  echo
  echo "=== uncommitted ($DIRTY_COUNT files) ==="
  git status --short 2>/dev/null | head -10
fi
