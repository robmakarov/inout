#!/bin/sh
# Name this session's auto-commit. Reads the message on stdin.
#
#   printf 'subject\n\nbody\n' | .claude/hooks/commit-msg.sh
#
# The Stop hook (auto-commit.py) uses it verbatim for the commit it makes when the
# session ends, then deletes it — one message, one commit. Without it you get a
# "wip: unattributed sweep" placeholder.
set -eu

repo=$(git rev-parse --show-toplevel)
gitdir=$(git rev-parse --git-dir)
case "$gitdir" in /*) ;; *) gitdir="$repo/$gitdir" ;; esac

sid="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-}}"
if [ -z "$sid" ]; then
    # Fall back to this project's most recently touched transcript — from inside a
    # live session that is almost certainly our own.
    slug=$(printf '%s' "$repo" | sed 's/[^a-zA-Z0-9]/-/g')
    dir="$HOME/.claude/projects/$slug"
    sid=$(ls -t "$dir"/*.jsonl 2>/dev/null | head -1 | xargs -I{} basename {} .jsonl) || true
fi
[ -n "$sid" ] || { echo "commit-msg: cannot determine session id" >&2; exit 1; }

mkdir -p "$gitdir/inout-autocommit/msg"
cat > "$gitdir/inout-autocommit/msg/$sid"
echo "commit message staged for session $sid"
