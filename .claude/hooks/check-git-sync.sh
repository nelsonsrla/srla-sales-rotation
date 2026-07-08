#!/usr/bin/env bash
# SessionStart hook — warn (never mutate) when the local branch is not level
# with origin, so we always edit against the latest pushed files.
# See CLAUDE.md Rule 22 (Single Source of Truth / Cross-Device Sync).
#
# Read-only by design: it fetches and reports. It NEVER pulls, resets, or
# changes the working tree — reconciling is left to a human (Nelson's global
# "project device refresh" rule: never clobber local work).
set -u

# Resolve the repo this hook belongs to, device-independently.
REPO="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$REPO" ] && exit 0
cd "$REPO" 2>/dev/null || exit 0

# Bail quietly if this isn't a git working tree.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# Refresh remote refs (quiet; failures are non-fatal so an offline start still works).
git fetch --quiet 2>/dev/null

LOCAL=$(git rev-parse @ 2>/dev/null)
REMOTE=$(git rev-parse @{u} 2>/dev/null)
BASE=$(git merge-base @ @{u} 2>/dev/null)

# No upstream configured, or already level with origin -> nothing to report.
[ -z "$REMOTE" ] && exit 0
[ "$LOCAL" = "$REMOTE" ] && exit 0

if [ "$LOCAL" = "$BASE" ]; then
  N=$(git rev-list --count @..@{u} 2>/dev/null)
  MSG="This repo is $N commit(s) BEHIND origin. Pull the latest before editing: git pull --ff-only (CLAUDE.md Rule 22)."
elif [ "$REMOTE" = "$BASE" ]; then
  N=$(git rev-list --count @{u}..@ 2>/dev/null)
  MSG="This repo is $N local commit(s) AHEAD of origin (unpushed). Safe to edit; push when ready."
else
  MSG="This repo has DIVERGED from origin (local and remote each have unique commits). Do NOT auto-pull — reconcile manually (CLAUDE.md Rule 22)."
fi

# additionalContext -> injected into Claude's context; systemMessage -> shown to the user.
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"GIT SYNC CHECK: %s"},"systemMessage":"\xe2\x9a\xa0\xef\xb8\x8f GIT SYNC: %s"}\n' "$MSG" "$MSG"
