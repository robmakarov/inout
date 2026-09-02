#!/bin/sh
# Name this session's auto-commit. Reads the message on stdin.
#
#   printf 'subject\n\nbody\n' | .claude/hooks/commit-msg.sh
#
# The Stop hook (auto-commit.py) uses it verbatim for the commit it makes when the
# session ends, then deletes it — one message, one commit. Without it the hook
# commits your files under a generated message that says the session named none.
#
# The message goes in the COMMON git dir, so it survives being staged from one
# worktree and read from another (T1).
set -eu

repo=$(git rev-parse --show-toplevel)
gitdir=$(git rev-parse --git-common-dir)
case "$gitdir" in /*) ;; *) gitdir="$repo/$gitdir" ;; esac

. "$repo/scripts/lib/session.sh"
sid=$(inout_session_id)
[ -n "$sid" ] || { echo "commit-msg: cannot determine session id" >&2; exit 1; }

mkdir -p "$gitdir/inout-autocommit/msg"
cat > "$gitdir/inout-autocommit/msg/$sid"
echo "commit message staged for session $sid"
