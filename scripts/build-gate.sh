#!/bin/sh
# Deploy-guard, prevention half. Born from aa39084: a leftover staged file made
# the pushed commit fail typecheck on Vercel and prod silently served the
# previous build for hours. A commit that does not build must never be pushed.
#
# Builds the EXACT commit in a throwaway worktree — not the shared worktree,
# which may carry another live session's half-finished files that would pass or
# fail a build the commit itself would not. node_modules is symlinked in, so
# the build is the same tsc + vite Vercel runs, in ~5 s.
#
# Usage: build-gate.sh <sha>
# Exit 0: the commit builds; its entry-asset list is cached under
# $GIT_DIR/inout-gate/<sha> for scripts/verify-deploy.mjs to reuse.
# Non-zero: DO NOT PUSH (the failing output is printed, last 40 lines).
set -eu

sha_arg="${1:?usage: build-gate.sh <sha>}"

# git exports GIT_DIR/GIT_INDEX_FILE into hooks; inside the temp worktree they
# would point every git call at the wrong repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE 2>/dev/null || true

repo="$(git rev-parse --show-toplevel)"
sha="$(git -C "$repo" rev-parse --verify "$sha_arg^{commit}")"
gitdir="$(git -C "$repo" rev-parse --absolute-git-dir)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/inout-gate.XXXXXX")"
cleanup() {
  git -C "$repo" worktree remove --force "$tmp" >/dev/null 2>&1 \
    || { rm -rf "$tmp"; git -C "$repo" worktree prune >/dev/null 2>&1 || true; }
}
trap cleanup EXIT

git -C "$repo" worktree add --quiet --detach "$tmp" "$sha"
ln -s "$repo/node_modules" "$tmp/node_modules"

echo "build-gate: building $(git -C "$repo" rev-parse --short "$sha") (tsc + vite, commit contents only)" >&2
if ! (cd "$tmp" && npm run --silent build) >"$tmp/build.log" 2>&1; then
  echo "build-gate: FAIL — commit $sha does not build. Last 40 lines:" >&2
  tail -40 "$tmp/build.log" >&2
  exit 1
fi

mkdir -p "$gitdir/inout-gate"
grep -o '/assets/[^"]*' "$tmp/dist/index.html" | sort >"$gitdir/inout-gate/$sha"
echo "build-gate: PASS — $sha builds clean" >&2
