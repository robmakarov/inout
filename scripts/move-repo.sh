#!/bin/bash
# MOVE THIS REPO and carry every record keyed by its path (2026-09-04).
#
# Why: the desktop app's preview launcher has no macOS grant for ~/Downloads, so
# `npm run dev` started from here dies on `EPERM: uv_cwd` (re-measured today).
# It starts fine from ~/Documents and from a plain home folder (measured today).
#
# Run from Terminal WITH THE CLAUDE APP QUIT — the app's own session records are
# rewritten, and a running session inside the old folder would lose its cwd:
#
#   bash "/Users/rmakarov/Downloads/inout mvp/scripts/move-repo.sh" "/Users/rmakarov/Documents/inout mvp"
#
# What moves with the folder:
#   1 the repo (one rename, same volume, instant; git remote and Vercel untouched)
#   2 ~/.claude/projects/<slug>  — every transcript, and memory/ (agent memory)
#   3 ~/.claude.json             — the per-project key (permissions, history)
#   4 the desktop app's session records + its permission map, so the session list
#     for this project shows up under the new folder
#   5 .claude/settings.local.json — the Stop hook's fallback path
# Not done here, printed at the end: `org add` for the new path (Robert's to run).
set -euo pipefail

OLD="$(cd "$(dirname "$0")/.." && pwd)"
NEW="${1:?usage: move-repo.sh <new absolute path>}"
case "$NEW" in /*) ;; *) echo "refuse: give an absolute path"; exit 1;; esac
if [ -e "$NEW" ]; then echo "refuse: $NEW already exists"; exit 1; fi
if pgrep -x Claude >/dev/null 2>&1; then echo "refuse: quit the Claude app first (its session records get rewritten)"; exit 1; fi
if [ -n "$(cd "$OLD" && git status --porcelain)" ]; then
  echo "refuse: uncommitted changes in $OLD — the Stop hook commits when the last session closes; wait for it, or commit"; exit 1
fi

slug() { printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g'; }
OLDSLUG="$(slug "$OLD")"; NEWSLUG="$(slug "$NEW")"

# 1 the repo
mkdir -p "$(dirname "$NEW")"
mv "$OLD" "$NEW"
echo "moved  $OLD -> $NEW"

# 2 transcripts + memory
if [ -d "$HOME/.claude/projects/$OLDSLUG" ]; then
  mv "$HOME/.claude/projects/$OLDSLUG" "$HOME/.claude/projects/$NEWSLUG"
  echo "moved  ~/.claude/projects/$OLDSLUG -> $NEWSLUG ($(ls "$HOME/.claude/projects/$NEWSLUG" | grep -c jsonl) transcripts + memory)"
fi

# 3 + 4 + 5: exact-string path rewrites inside JSON files (the path has no JSON-special characters)
python3 - "$OLD" "$NEW" <<'PY'
import glob, os, sys
old, new = sys.argv[1], sys.argv[2]
home = os.path.expanduser('~')
files = [os.path.join(home, '.claude.json'),
         os.path.join(home, 'Library/Application Support/Claude/claude_desktop_config.json'),
         os.path.join(new, '.claude/settings.local.json')]
files += glob.glob(os.path.join(home, 'Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json'))
n = 0
for f in files:
    try:
        s = open(f, encoding='utf-8').read()
    except FileNotFoundError:
        continue
    if old in s:
        open(f, 'w', encoding='utf-8').write(s.replace(old, new))
        n += 1
print(f'rewrote {n} files (~/.claude.json, desktop config, Stop-hook fallback, app session records)')
PY

cat <<EOF

DONE. Now:
  - open "$NEW" in the Claude app (the old sessions are listed under it)
  - in an ~/org session say: org add "$NEW"   (the allowlist still names the old path)
  - the first agent session there deletes the ~/Downloads workaround: the "Local server" paragraph in
    CLAUDE.md and the "inout-tmp" entry in .claude/launch.json — \`preview_start { name: "inout" }\` now works.
EOF
