#!/bin/sh
# One task, one worktree — the rule from .ai/TASKS made runnable (T1).
#
# WHY: every session in this checkout shares one HEAD and one index. On 09-01/02
# that cost three incidents in two days — a `git checkout` moved another session's
# HEAD, a Stop hook swept another session's files, and a task's work landed on
# main. A worktree gives a task session its own HEAD, its own index and its own
# dirty files, and the Stop hook (rule 2) will not commit from a worktree while
# the session it was cut for is still live.
#
#   scripts/worktree.sh T1            # -> /tmp/inout-t1 on branch task/t1
#   scripts/worktree.sh T1 origin/main
#
# Re-running it for the same id is a no-op that re-stamps the owner marker, so it
# is safe to call at the start of a session that resumes a task.
#
# Landing the work is deliberately NOT automated: merge from the MAIN checkout
# (never move the main ref from a worktree others commit into) once the task's
# gates are green, then `git worktree remove` here.
set -eu

raw="${1:?usage: worktree.sh <task-id> [start-point]}"
id=$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' \
     | sed 's/-*$//')
[ -n "$id" ] || { echo "worktree: '$raw' is not a usable task id" >&2; exit 1; }

repo=$(git rev-parse --show-toplevel)
. "$repo/scripts/lib/session.sh"

# The MAIN checkout — where main lives and where a task is landed. Running this
# from inside another worktree must not tell you to merge into that one.
common=$(git rev-parse --git-common-dir)
case "$common" in /*) ;; *) common="$repo/$common" ;; esac
main=$(dirname "$common")
# Follow the link if this worktree's own node_modules is one, so the new worktree
# never depends on this one surviving.
mods=$(cd "$repo/node_modules" 2>/dev/null && pwd -P) || mods="$main/node_modules"

dir="${INOUT_WORKTREE_DIR:-${TMPDIR:-/tmp}}"
case "$dir" in */) dir="${dir}inout-$id" ;; *) dir="$dir/inout-$id" ;; esac
branch="task/$id"
start="${2:-}"
if [ -z "$start" ]; then
    if git -C "$repo" show-ref --verify --quiet refs/heads/main; then
        start=main
    else
        start=HEAD
    fi
fi

if [ -d "$dir" ]; then
    echo "worktree: $dir already exists — reusing it" >&2
elif git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$repo" worktree add --quiet "$dir" "$branch"
    echo "worktree: $dir on existing branch $branch" >&2
else
    git -C "$repo" worktree add --quiet -b "$branch" "$dir" "$start"
    echo "worktree: $dir on new branch $branch (from $start)" >&2
fi

# npm needs node_modules present; a symlink is what scripts/build-gate.sh uses and
# it is the same tsc + vite the deploy gate runs.
[ -e "$dir/node_modules" ] || ln -s "$mods" "$dir/node_modules"

# Hooks and permissions are per-project settings, and this file is gitignored, so
# a session started in the worktree would otherwise have neither.
if [ -f "$repo/.claude/settings.local.json" ] \
   && [ ! -f "$dir/.claude/settings.local.json" ]; then
    cp "$repo/.claude/settings.local.json" "$dir/.claude/settings.local.json"
fi

# The owner marker. The Stop hook reads it (rule 2) and refuses to commit from
# this worktree for anyone else while this session is live; it lives in the
# worktree's own git dir, so removing the worktree removes the claim.
sid=$(inout_session_id)
if [ -n "$sid" ]; then
    tx=$(inout_transcript "$sid") || tx=""
    wgd=$(git -C "$dir" rev-parse --absolute-git-dir)
    prev=""
    [ -f "$wgd/inout-owner" ] && prev=$(sed -n 's/.*"session": *"\([^"]*\)".*/\1/p' \
                                        "$wgd/inout-owner")
    if [ -n "$prev" ] && [ "$prev" != "$sid" ]; then
        echo "worktree: WARNING — $dir was cut for session $prev; taking it over" >&2
    fi
    printf '{"session": "%s", "transcript": "%s", "branch": "%s", "dir": "%s", "created": %s}\n' \
        "$sid" "$tx" "$branch" "$dir" "$(date +%s)" > "$wgd/inout-owner"
else
    echo "worktree: WARNING — no session id; the worktree is unclaimed" >&2
fi

cat >&2 <<EOF

  cd $dir                       # work here; npm run typecheck && npm test work as usual
  git -C $dir branch --show-current   # $branch — assert this before every commit

  To watch it in a browser (the mirror the preview launcher can read):
    node $dir/scripts/mirror-watch.mjs /tmp/inout-dev
    rsync -a "$mods/" /tmp/inout-dev/node_modules/                # real copy: TCC
    preview_start { name: "inout-tmp" }                           # port 5174
  Only one worktree at a time may own /tmp/inout-dev.

  When the gates are green, land it FROM THE MAIN CHECKOUT:
    git -C "$main" merge --ff-only $branch && git -C "$main" push
    git -C "$main" worktree remove $dir && git -C "$main" branch -d $branch
EOF
