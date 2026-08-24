#!/bin/sh
# Mirror the tree to /tmp so the preview launcher can actually run it.
#
# WHY THIS EXISTS: the agent's preview spawner has no TCC access to ~/Downloads.
# Every process it starts with this project as its cwd dies at bootstrap with
# `EPERM: uv_cwd` — before npm, before vite, before any config is read — so the
# app could not be launched or watched at all (three sessions gave up here and
# shipped capture fixes "argued from the code" instead of verified). /tmp it can
# read. This is a SNAPSHOT: re-run after editing, then reload the preview.
#
#   sh scripts/mirror-for-preview.sh && open the "inout-tmp" preview (port 5174)
#
# The excludes are ROOTED (leading /) on purpose — an unanchored `dist` also
# eats node_modules/vite/dist and the mirror will not boot.
set -eu
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-/tmp/inout-dev}"
mkdir -p "$DEST"
rsync -a --delete \
  --exclude '/.git' \
  --exclude '/dist' \
  --exclude '/.ai' \
  --exclude '*.mp4' \
  "$SRC/" "$DEST/"
echo "mirrored $SRC -> $DEST"
