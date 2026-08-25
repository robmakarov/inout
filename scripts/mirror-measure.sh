#!/bin/sh
# Mirror the WORKING TREE to /tmp and run a long rig there.
#
# WHY THIS EXISTS, and it cost a session 25 minutes to relearn: every rig in
# this repo (`npm run exp`, the oracle) spawns an ephemeral vite server on THIS
# worktree. Vite watches the files. So editing anything while a rig runs reloads
# the harness page through HMR and the run dies quietly — the node process sits
# there at 0 % CPU until its timeout, and the log stays on "ephemeral server on
# …" forever. STATE has said "run long cells from a /tmp mirror" since
# 2026-08-25; this is that sentence as a command, including the uncommitted
# changes a `git archive HEAD` mirror would silently leave out.
#
#   sh scripts/mirror-measure.sh exp -- o4clock '{"takeMs":20000}'
#   sh scripts/mirror-measure.sh oracle --cold=3
#
# Everything after the script name is passed to `npm run` inside the mirror.
# node_modules is symlinked, not copied.
set -eu
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${INOUT_MEASURE_DIR:-/tmp/inout-measure}"
mkdir -p "$DEST"
rsync -a --delete \
  --exclude '/.git' \
  --exclude '/dist' \
  --exclude '/node_modules' \
  --exclude '*.mp4' \
  "$SRC/" "$DEST/"
[ -e "$DEST/node_modules" ] || ln -s "$SRC/node_modules" "$DEST/node_modules"
echo "mirrored $SRC -> $DEST; running: npm run $*"
cd "$DEST"
exec npm run "$@"
