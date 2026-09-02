# Who is running this command — sourced by .claude/hooks/commit-msg.sh and
# scripts/worktree.sh, which both have to write a file named after the session.
#
# Claude Code exports the session id into tool calls; when it does not, this
# project's most recently touched transcript is, from inside a live session,
# almost certainly our own. Same slug rule as the Stop hook: the session's cwd
# with every non-alphanumeric turned into a dash. A session driving a worktree
# usually still has its cwd in the main checkout, so all three plausible roots
# are searched — here, the repo root, and the main checkout.

# inout_project_dir <dir> -> ~/.claude/projects/<slug>
inout_project_dir() {
    _p=$(cd "$1" 2>/dev/null && pwd -P) || _p="$1"
    printf '%s/.claude/projects/%s' "$HOME" \
        "$(printf '%s' "$_p" | sed 's/[^a-zA-Z0-9]/-/g')"
}

# inout_roots -> every directory a session for this repo might have as its cwd
inout_roots() {
    printf '%s\n' "$PWD"
    git rev-parse --show-toplevel 2>/dev/null || true
    _c=$(git rev-parse --git-common-dir 2>/dev/null) || return 0
    case "$_c" in /*) ;; *) _c="$PWD/$_c" ;; esac
    dirname "$_c"
}

# inout_session_id -> the session id, or empty
inout_session_id() {
    _sid="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-}}"
    if [ -z "$_sid" ]; then
        _list=$(inout_roots | while IFS= read -r _r; do
            [ -n "$_r" ] || continue
            ls -t "$(inout_project_dir "$_r")"/*.jsonl 2>/dev/null | head -1
        done)
        _newest=""
        _oifs="${IFS-}"
        IFS='
'
        for _c in $_list; do
            [ -n "$_c" ] || continue
            if [ -z "$_newest" ] || [ "$_c" -nt "$_newest" ]; then _newest="$_c"; fi
        done
        IFS="$_oifs"
        [ -n "$_newest" ] && _sid=$(basename "$_newest" .jsonl)
    fi
    printf '%s' "$_sid"
}

# inout_transcript <session-id> -> its transcript path, or empty
inout_transcript() {
    inout_roots | while IFS= read -r _r; do
        [ -n "$_r" ] || continue
        _t="$(inout_project_dir "$_r")/$1.jsonl"
        if [ -f "$_t" ]; then
            printf '%s' "$_t"
            break
        fi
    done
}
