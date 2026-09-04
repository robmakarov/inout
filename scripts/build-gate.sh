#!/bin/sh
# Deploy-guard, prevention half. Born from aa39084: a leftover staged file made
# the pushed commit fail typecheck on Vercel and prod silently served the
# previous build for hours. A commit that does not build must never be pushed.
#
# Runs, on the exact commit, in this order: `npm run build` (which IS
# `tsc --noEmit && vite build`, so typecheck needs no separate step) then
# `npm test`. ~7 s together. The sweep that caused aa39084 is the same
# mechanism that pulls in a semantically broken file, so both push paths check
# both — the auto-commit Stop hook pushes with --no-verify and calls this
# script inline, which is the DOMINANT path in this repo.
#
# `npm run oracle` deliberately stays OUT (2026-08-26, measured): it is a
# TIMING gate, and two runs of one commit on this machine read sync 76.87 ms
# and 37.3 ms against a 90 ms band. The high read was the cold first run in a
# fresh worktree — exactly what a hook always pays — so a pre-push oracle would
# block pushes on machine load rather than on the commit, and a gate that
# flakes just teaches everyone --no-verify. It stays the deliberate MERGE gate
# that .ai/TASKS already makes mandatory per task.
#
# Builds in a throwaway worktree — not the shared worktree, which may carry
# another live session's half-finished files that would pass or fail a check
# the commit itself would not. node_modules is symlinked in, so this is the
# same tsc + vite Vercel runs.
#
# Usage: build-gate.sh <sha>
# Exit 0: the commit builds and its tests pass; the entry-asset list is cached
# under $GIT_DIR/inout-gate/<sha> for scripts/verify-deploy.mjs to reuse.
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

short="$(git -C "$repo" rev-parse --short "$sha")"

run_step() {
  # run_step <label> <logfile> <npm-args...>
  label="$1"; logfile="$2"; shift 2
  if ! (cd "$tmp" && npm "$@") >"$tmp/$logfile" 2>&1; then
    echo "build-gate: FAIL — commit $sha does not $label. Last 40 lines:" >&2
    tail -40 "$tmp/$logfile" >&2
    exit 1
  fi
}

echo "build-gate: checking $short — build (tsc + vite) then tests, commit contents only" >&2
run_step build build.log run --silent build
run_step "pass its tests" test.log test

# U4 part 4: THE SWITCH COUNT ONLY GOES DOWN. A commit that carries more
# switches than prod is serving is refused here, because the alternative —
# noticing in review — is what let 37 of them accumulate unseen. Skipped in
# silence only when the baseline has no registry (the commit that adds it).
# The script travels with the commit, so a commit from before U4 simply has no
# gate to run — and every commit that HAS it also has the registry it reads, so
# any non-zero exit here is a real refusal and not a missing baseline.
if [ -f "$tmp/scripts/switch-gate.mjs" ]; then
  if ! (cd "$tmp" && node scripts/switch-gate.mjs "$sha" origin/main) 2>"$tmp/switch.log"; then
    echo "build-gate: FAIL — the switch count is not allowed to rise." >&2
    cat "$tmp/switch.log" >&2
    exit 1
  fi
  cat "$tmp/switch.log" >&2
fi

mkdir -p "$gitdir/inout-gate"
grep -o '/assets/[^"]*' "$tmp/dist/index.html" | sort >"$gitdir/inout-gate/$sha"
echo "build-gate: PASS — $sha builds clean and its tests pass" >&2
