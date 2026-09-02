#!/usr/bin/env python3
"""Stop-hook auto-commit that stays inside its own lane.

The old hook was `git add -A && git commit -m "wip: auto-commit (agent)"`. With two
sessions live in one worktree that is a race: whoever stops first sweeps the other
session's half-finished files into its commit, under its message. Commit 3e4df1d is
the evidence — `setChannelActive` work in src/core carrying 118/90 lines of a
separate session's proto/style.html wedge morph.

This commits only what this session may claim:

    to_commit = mine + (files nobody claims, but only if no other session is live)

`mine` is every file this session wrote, read out of its own transcript: paths from
Write/Edit/MultiEdit/NotebookEdit, plus paths a Bash command plausibly wrote — a
redirect target, an operand of mv/rm/cp/touch/tee/sed -i, a worktree-mutating git
subcommand, or the fixed set a package manager rewrites. Read-only commands claim
nothing on purpose: one `grep -rn foo src/` would otherwise fence off a whole tree.

A claim may be a file, a directory (claiming everything under it) or a glob.
Another session's claim wins over a blind sweep but never over my own edits, and
files nobody claims are swept by the last session standing (rule 3 below) so
nothing rots uncommitted.

A session releases its claims when its own Stop hook finishes (a done-marker newer
than its transcript). Sessions killed without a Stop release after CLAIM_HOURS.

Message: if the session left one in <common git dir>/inout-autocommit/msg/<id>,
that is the commit message. Otherwise this session's own files are committed under
a generated message that names it, and only files no live session claims can carry
the `wip: unattributed sweep` subject.

Push is gated: scripts/build-gate.sh builds the exact commit and runs its tests
first, because this hook pushes with --no-verify and a non-building push is how
aa39084 left prod silently serving a stale build for hours. This is the dominant
push path in the repo, so it checks the same things the pre-push hook does. A
gate failure blocks the push loudly and keeps the commit local.

T1 (2026-09-02) turns the parallel-session rules into structure, after three
incidents in two days: a session's `git checkout` moved another session's HEAD, a
Stop hook swept another session's Bash-edited files, and a task's work landed on
main. Four rules, each proved by `npm run drill` (scripts/session-drill.py):

  1 BRANCH ASSERT. The transcript records the branch every edit was made on. If
    HEAD is no longer there, the commit is refused loudly and nothing is touched —
    a foreign checkout moved this session, and committing would put the work on
    someone else's branch.
  2 WORKTREE OWNERSHIP. A worktree made by scripts/worktree.sh names its session in
    $GIT_DIR/inout-owner; while that session is live, no other session commits from
    it.
  3 NO BLIND SWEEP WHILE ANYONE ELSE IS LIVE. A file nobody claims may be a live
    session's Bash edit this extractor did not see, so only the last session
    standing sweeps unclaimed files. Nothing rots; it waits.
  4 PUSH ONLY FROM <BRANCH>. A task branch's tip is never pushed to main. It is
    committed locally and the hook says so.

Rule 3 is also why the `wip: unattributed sweep` subject can no longer land on a
session's own work: unnamed work is committed under a message that names the
session, and the placeholder is reserved for files no live session claims.

Env overrides: INOUT_AUTOCOMMIT_CLAIM_HOURS, INOUT_AUTOCOMMIT_BRANCH,
INOUT_AUTOCOMMIT_NO_PUSH, INOUT_AUTOCOMMIT_NO_GATE.
"""

import fnmatch
import json
import os
import re
import shlex
import subprocess
import sys
import time

EDIT_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
PATH_KEYS = ("file_path", "notebook_path")

# Bash attribution. A claim only ever holds a file back from another session's
# blind sweep, so a false claim is cheap and a missed one is the bug — but only if
# reads stay out. `grep -rn foo src/` or `cat proto/style.html` must claim nothing,
# or one read would fence off a whole tree. So: claim from writers, never readers.
SHELL_SEPARATORS = {";", "|", "||", "&", "&&", "\n"}
SHELL_PREFIXES = {"sudo", "command", "nohup", "time", "exec", "builtin", "env", "then",
                  "do", "else", "elif", "if", "while", "until", "for", "!", "{", "("}

# Every non-flag operand is a path this command writes (or removes).
BASH_WRITERS = {
    "mv", "rm", "rmdir", "touch", "mkdir", "ln", "tee", "truncate", "dd", "patch",
    "unzip", "install", "shred", "gzip", "gunzip", "bzip2", "xz", "zip", "rsync",
}
# Only the final operand is the destination; earlier ones are sources being read.
BASH_WRITERS_LAST = {"cp"}
# Mutate the working tree; `git commit`/`status`/`log`/`diff` deliberately absent.
# Split by what the operands mean: these take pathspecs...
GIT_PATH_SUBS = {"add", "rm", "mv", "restore", "apply", "clean"}
# ...these take refs, so only a pathspec after `--` is a path. `git checkout main`
# must not claim a file called "main".
GIT_REF_SUBS = {"checkout", "switch", "reset", "revert", "cherry-pick", "merge",
                "rebase", "pull", "stash"}
# Package managers rewrite a known, fixed set regardless of their arguments.
PKG_MANAGERS = {"npm", "yarn", "pnpm", "bun"}
PKG_WRITE_SUBS = {"install", "i", "ci", "add", "remove", "uninstall", "rm", "un",
                  "update", "upgrade", "link", "unlink", "prune", "dedupe"}
PKG_ARTIFACTS = ("package.json", "package-lock.json", "npm-shrinkwrap.json",
                 "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "node_modules")
# In-place editors: only a write when the in-place flag is present.
INPLACE_EDITORS = {"sed", "perl", "ruby", "gawk"}

_HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")

CLAIM_HOURS = float(os.environ.get("INOUT_AUTOCOMMIT_CLAIM_HOURS", "6"))
BRANCH = os.environ.get("INOUT_AUTOCOMMIT_BRANCH", "main")
NO_PUSH = os.environ.get("INOUT_AUTOCOMMIT_NO_PUSH", "") not in ("", "0", "false")
NO_GATE = os.environ.get("INOUT_AUTOCOMMIT_NO_GATE", "") not in ("", "0", "false")

LOCK_STALE_SECS = 600
LOCK_WAIT_SECS = 90

# Bump whenever _extract learns a new claim kind, so caches written by the older
# extractor are re-read instead of silently under-claiming. 3 added the branch
# each claim was made on.
CACHE_VERSION = 3


def log(state_dir, msg):
    line = "%s  %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        with open(os.path.join(state_dir, "log"), "a") as f:
            f.write(line + "\n")
    except OSError:
        pass
    return line


def git(repo, *args, **kw):
    """Run git, retrying while another process holds index.lock."""
    check = kw.pop("check", False)
    deadline = time.time() + 30
    while True:
        p = subprocess.run(
            ["git", "-C", repo] + list(args),
            capture_output=True,
            text=True,
        )
        if p.returncode == 0 or "index.lock" not in (p.stderr or ""):
            break
        if time.time() > deadline:
            break
        time.sleep(0.4)
    if check and p.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (" ".join(args), p.stderr.strip()))
    return p


# ------------------------------------------------------------ bash attribution

def _strip_heredocs(command):
    """Drop heredoc bodies — they are data, and lexing them invents path tokens."""
    if "<<" not in command:
        return command
    lines = command.split("\n")
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = _HEREDOC.search(line)
        i += 1
        if not m:
            continue
        delim = m.group(2)
        while i < len(lines) and lines[i].strip() != delim:
            i += 1
        i += 1  # skip the terminator too
    return "\n".join(out)


def _segments(command):
    """Split a command line into pipeline segments, tokenised."""
    try:
        lexer = shlex.shlex(_strip_heredocs(command), posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return []  # unbalanced quotes and the like — claim nothing rather than guess
    segs, cur = [], []
    for tok in tokens:
        if tok in SHELL_SEPARATORS:
            segs.append(cur)
            cur = []
        else:
            cur.append(tok)
    segs.append(cur)
    return [s for s in segs if s]


def _operands(argv):
    return [t for t in argv if not t.startswith("-") and not t.startswith("+")]


def _bash_targets(command):
    """Path tokens a shell command plausibly WRITES. Patterns and dirs allowed."""
    targets = []
    for seg in _segments(command):
        # Redirections write their target wherever they appear in the segment.
        for i, tok in enumerate(seg):
            if tok in (">", ">>") and i + 1 < len(seg):
                dest = seg[i + 1]
                if not dest.startswith("&") and dest != "/dev/null":
                    targets.append(dest)
        # Drop redirect operators and their operands; a `< src` is a read, and a
        # `> dest` was already collected above.
        argv, skip = [], False
        for tok in seg:
            if skip:
                skip = False
                continue
            if tok in (">", ">>", "<", "<<", "2>", "&>"):
                skip = True
                continue
            argv.append(tok)
        while argv and (argv[0] in SHELL_PREFIXES or "=" in argv[0].split("/")[0]):
            argv = argv[1:]
        if not argv:
            continue
        cmd = os.path.basename(argv[0])
        rest = argv[1:]

        if cmd in BASH_WRITERS:
            targets += _operands(rest)
        elif cmd in BASH_WRITERS_LAST:
            ops = _operands(rest)
            if ops:
                targets.append(ops[-1])
        elif cmd in INPLACE_EDITORS:
            # -i, --in-place, and clustered forms like perl's -pi or -i.bak.
            if any(a == "--in-place" or
                   (a.startswith("-") and not a.startswith("--")
                    and "i" in a[1:].split(".")[0])
                   for a in rest):
                # `sed -i '' 's/x/y/' file`: keep operands that look like paths,
                # dropping the (possibly empty) backup suffix and the script.
                targets += [o for o in _operands(rest)
                            if o and not re.match(r"^[a-z]([/|,;:!#])", o)]
        elif cmd == "git":
            sub = next((t for t in rest if not t.startswith("-")), None)
            after = rest[rest.index("--") + 1:] if "--" in rest else []
            if sub in GIT_PATH_SUBS:
                targets += [t for t in _operands(rest) if t != sub] + after
            elif sub in GIT_REF_SUBS:
                targets += after  # only what follows `--` is a pathspec
        elif cmd in PKG_MANAGERS:
            sub = next((t for t in rest if not t.startswith("-")), None)
            if sub in PKG_WRITE_SUBS:
                targets += list(PKG_ARTIFACTS)
    return [t for t in targets if _plausible_path(t)]


def _plausible_path(tok):
    """Filter shell noise out of claim candidates.

    `2>&1` lexes into stray `2`/`1`/`>&` fragments, and an unexpanded `$VAR` or
    `$(cmd)` names nothing we can resolve. None of these are paths.
    """
    if not tok or tok in (".", "..", "/") or tok.isdigit():
        return False
    return not any(ch in tok for ch in "&><$`\n")


# ---------------------------------------------------------------- transcripts

def _extract(line):
    """(absolute claims, branch) from one transcript line.

    Claims are edit-tool paths and Bash writes; Bash targets are resolved against
    the record's own cwd, since a command may have run somewhere other than the
    repo root. Claims may be files, directories or globs; see claim_matches.

    The branch is the `gitBranch` the client stamped on the record — where this
    edit was actually made, which is what rule 1 asserts HEAD still points at.
    """
    if '"tool_use"' not in line:
        return (), ""
    try:
        rec = json.loads(line)
    except ValueError:
        return (), ""
    msg = rec.get("message")
    if not isinstance(msg, dict):
        return (), ""
    content = msg.get("content")
    if not isinstance(content, list):
        return (), ""
    cwd = rec.get("cwd") or ""
    out = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        name = block.get("name")
        inp = block.get("input")
        if not isinstance(inp, dict):
            continue
        if name in EDIT_TOOLS:
            for key in PATH_KEYS:
                val = inp.get(key)
                if isinstance(val, str) and val:
                    out.append(val)
        elif name == "Bash":
            command = inp.get("command")
            if not isinstance(command, str) or not command:
                continue
            for target in _bash_targets(command):
                if os.path.isabs(target):
                    out.append(target)
                elif cwd:
                    out.append(os.path.join(cwd, target))
    return out, (rec.get("gitBranch") or "")


def scan_transcript(transcript, cache_dir):
    """What a session claimed, and where it was standing when it did.

    Returns {"paths": set of absolute claims, "branches": [branch, ...]} — the
    branches in the order the session edited on them, consecutive repeats folded,
    so branches[-1] is where its most recent edit happened.

    Parses only the tail appended since the last call: transcripts are append-only
    JSONL, so a byte offset plus what was found so far is a sound cache. Any
    inconsistency (file shrank, unreadable cache) re-parses from zero.
    """
    try:
        size = os.path.getsize(transcript)
    except OSError:
        return {"paths": set(), "branches": []}

    key = os.path.basename(transcript) + ".json"
    cache_file = os.path.join(cache_dir, key)
    offset, paths, branches = 0, [], []
    try:
        with open(cache_file) as f:
            cached = json.load(f)
        # A cache written by an older extractor saw fewer claim kinds; re-read.
        if cached.get("v") == CACHE_VERSION and cached.get("size", 0) <= size:
            offset = cached.get("offset", 0)
            paths = cached.get("paths", [])
            branches = cached.get("branches", [])
    except (OSError, ValueError):
        pass
    if offset > size:
        offset, paths, branches = 0, [], []

    found, seen = set(paths), list(branches)
    try:
        with open(transcript, "r", errors="replace") as f:
            f.seek(offset)
            for line in f:
                claims, branch = _extract(line)
                if not claims:
                    continue
                found.update(claims)
                if branch and (not seen or seen[-1] != branch):
                    seen.append(branch)
            end = f.tell()
    except OSError:
        return {"paths": found, "branches": seen}

    try:
        tmp = cache_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"v": CACHE_VERSION, "offset": end, "size": size,
                       "paths": sorted(found), "branches": seen}, f)
        os.replace(tmp, cache_file)
    except OSError:
        pass
    return {"paths": found, "branches": seen}


def touched_files(transcript, cache_dir):
    """Just the paths — see scan_transcript."""
    return scan_transcript(transcript, cache_dir)["paths"]


def project_transcript_dir(repo):
    """~/.claude/projects/<slug>, where the slug is cwd with non-alphanumerics dashed.

    Only needed when the payload omits transcript_path: without the project dir we
    could not see other sessions' claims and would fall back to sweeping everything,
    which is the bug this hook exists to fix.
    """
    slug = re.sub(r"[^a-zA-Z0-9]", "-", os.path.realpath(repo))
    path = os.path.join(os.path.expanduser("~"), ".claude", "projects", slug)
    return path if os.path.isdir(path) else ""


def other_session_claims(project_dir, my_session, state_dir, cache_dir):
    """(files claimed by other live sessions, the ids of those sessions).

    Live = transcript touched within CLAIM_HOURS and not released. A session
    releases by writing done/<sid> after its Stop hook commits; if it edits again
    afterwards its transcript outruns the marker and it re-claims.

    The id list is what rule 3 reads: while another session is live, files nobody
    claims are left alone, because a claim this extractor missed looks exactly
    like a file nobody owns.
    """
    claims, live = set(), []
    if not project_dir or not os.path.isdir(project_dir):
        return claims, live
    cutoff = time.time() - CLAIM_HOURS * 3600
    done_dir = os.path.join(state_dir, "done")
    try:
        entries = os.listdir(project_dir)
    except OSError:
        return claims, live

    for name in entries:
        if not name.endswith(".jsonl"):
            continue
        sid = name[: -len(".jsonl")]
        if sid == my_session:
            continue
        path = os.path.join(project_dir, name)
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            continue
        if mtime < cutoff:
            continue  # long gone; whatever it left is fair game
        try:
            if os.path.getmtime(os.path.join(done_dir, sid)) >= mtime:
                continue  # already committed its own work
        except OSError:
            pass
        claims |= touched_files(path, cache_dir)
        live.append(sid)
    return claims, live


# ----------------------------------------------------------------- work tree

def dirty_paths(repo):
    """Repo-relative paths of every changed or untracked file."""
    p = git(repo, "status", "--porcelain", "-z", "--untracked-files=all")
    if p.returncode != 0:
        raise RuntimeError("git status failed: %s" % p.stderr.strip())
    fields = p.stdout.split("\0")
    out, i = [], 0
    while i < len(fields):
        rec = fields[i]
        i += 1
        if len(rec) < 4:
            continue
        x, y, path = rec[0], rec[1], rec[3:]
        out.append(path)
        if x in ("R", "C") or y in ("R", "C"):
            if i < len(fields):  # rename/copy: the source path follows
                out.append(fields[i])
                i += 1
    return out


def split_claims(claims):
    """Partition claim strings into exact/dir names and glob patterns."""
    exact, globs = set(), []
    for c in claims:
        c = c.rstrip("/")
        if not c:
            continue
        (globs.append(c) if any(ch in c for ch in "*?[") else exact.add(c))
    return exact, globs


def claim_matches(path, exact, globs):
    """True if `path` is claimed directly, via a claimed ancestor dir, or a glob."""
    if path in exact:
        return True
    parts = path.split("/")
    for i in range(1, len(parts)):
        if "/".join(parts[:i]) in exact:
            return True
    return any(fnmatch.fnmatch(path, g) for g in globs)


def rel_to_repo(repo, path):
    try:
        rel = os.path.relpath(os.path.realpath(path), os.path.realpath(repo))
    except ValueError:
        return None
    if rel.startswith(os.pardir + os.sep) or rel == os.pardir:
        return None
    return rel.replace(os.sep, "/")


def in_progress(repo):
    """Merge/rebase/cherry-pick underway — partial commits are refused, so stay out."""
    p = git(repo, "rev-parse", "--git-dir")
    gd = p.stdout.strip() or ".git"
    if not os.path.isabs(gd):
        gd = os.path.join(repo, gd)
    for marker in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD",
                   "rebase-merge", "rebase-apply"):
        if os.path.exists(os.path.join(gd, marker)):
            return marker
    return None


# ----------------------------------------------------- session boundaries

def current_branch(repo):
    """`git branch --show-current` — empty string on a detached HEAD."""
    return git(repo, "branch", "--show-current").stdout.strip()


def worktree_owner(gd):
    """The session scripts/worktree.sh cut this worktree for, or None.

    The marker sits in the worktree's own git dir ($GIT_DIR/inout-owner), so it
    travels with the worktree and disappears when it is removed.
    """
    try:
        with open(os.path.join(gd, "inout-owner")) as f:
            rec = json.load(f)
    except (OSError, ValueError):
        return None
    return rec if isinstance(rec, dict) and rec.get("session") else None


def owner_is_live(owner, state_dir):
    """True while the owning session is still working (rule 2).

    Same liveness test the file claims use — a transcript touched within
    CLAIM_HOURS and no newer release marker — so an abandoned worktree unlocks
    on its own instead of needing a human.
    """
    try:
        stamp = os.path.getmtime(owner.get("transcript") or "")
    except OSError:
        try:
            stamp = float(owner.get("created") or 0)
        except (TypeError, ValueError):
            stamp = 0.0
    if stamp < time.time() - CLAIM_HOURS * 3600:
        return False
    try:
        return os.path.getmtime(
            os.path.join(state_dir, "done", owner["session"])) < stamp
    except OSError:
        return True


def refuse(state_dir, payload, message):
    """Stop without committing, loudly.

    Exit 2 on a Stop hook puts the text in front of the model instead of burying
    it in a log nobody reads — but only once: `stop_hook_active` says we already
    said it, and blocking twice would spin the session.
    """
    text = log(state_dir, message)
    sys.stderr.write(text + "\n")
    print(text)
    return 0 if payload.get("stop_hook_active") else 2


# --------------------------------------------------------------------- lock

class Lock:
    """Serialize commit+push across sessions sharing this worktree."""

    def __init__(self, path):
        self.path = path
        self.held = False

    def __enter__(self):
        deadline = time.time() + LOCK_WAIT_SECS
        while True:
            try:
                os.mkdir(self.path)
                self.held = True
                return self
            except FileExistsError:
                try:
                    age = time.time() - os.path.getmtime(self.path)
                except OSError:
                    age = 0
                if age > LOCK_STALE_SECS:
                    try:
                        os.rmdir(self.path)
                        continue
                    except OSError:
                        pass
                if time.time() > deadline:
                    return self  # proceed unlocked rather than drop the work
                time.sleep(0.5)

    def __exit__(self, *exc):
        if self.held:
            try:
                os.rmdir(self.path)
            except OSError:
                pass
        return False


def build_gate(repo, sha):
    """Build the exact commit before pushing it; None = safe to push.

    Returns the gate's output tail when the commit does not build. A missing
    gate script passes — an older checkout should not lose its push — but a
    present, failing one blocks: better an unpushed local commit than prod
    silently serving the previous build while Vercel's build fails.
    """
    gate = os.path.join(repo, "scripts", "build-gate.sh")
    if NO_GATE or not os.path.exists(gate):
        return None
    try:
        p = subprocess.run([gate, sha], capture_output=True, text=True, timeout=600)
    except (subprocess.TimeoutExpired, OSError) as exc:
        return "build gate did not run: %r" % (exc,)
    if p.returncode == 0:
        return None
    return "\n".join(((p.stdout or "") + (p.stderr or "")).strip().splitlines()[-25:])


# --------------------------------------------------------------------- main

def authored_message(state_dir, session_id, legacy_dir=""):
    """The message this session staged with commit-msg.sh, consumed once.

    legacy_dir is the pre-T1 per-worktree state directory: a session that staged
    its message before this hook moved state to the common git dir still gets it.
    """
    for base in (state_dir, legacy_dir):
        if not base:
            continue
        msg_file = os.path.join(base, "msg", session_id)
        try:
            with open(msg_file) as f:
                text = f.read().strip()
        except OSError:
            continue
        if text:
            try:
                os.remove(msg_file)  # one message, one commit
            except OSError:
                pass
            return text
    return None


def _scopes(paths):
    tops = sorted({p.split("/")[0] if "/" in p else p for p in paths})
    return ", ".join(tops[:3]) + ("…" if len(tops) > 3 else "")


def _listing(paths):
    return "\n".join(["  %s" % p for p in sorted(paths)[:40]]
                     + (["  … and %d more" % (len(paths) - 40)]
                        if len(paths) > 40 else []))


def mine_message(session_id, paths):
    """Generated message for files THIS session edited but never named.

    Attributed on purpose: the placeholder subject means "nobody owns these", and
    after T1 that has to stay true, so a session's own work never wears it.
    """
    return ("wip: %s (%d file%s) — session named no message\n\n"
            "Committed by the Stop hook from this session's own claims.\n"
            "Name the next one: printf 'subject\\n\\nbody\\n' | "
            ".claude/hooks/commit-msg.sh\n"
            "Session: %s\n\n%s"
            % (_scopes(paths), len(paths), "" if len(paths) == 1 else "s",
               session_id, _listing(paths)))


def sweep_message(session_id, paths):
    """Files no live session claims — the only place the placeholder may appear."""
    return ("wip: unattributed sweep in %s (%d file%s)\n\n"
            "No live session claims these; swept by the last session standing.\n"
            "Session: %s\n\n%s"
            % (_scopes(paths), len(paths), "" if len(paths) == 1 else "s",
               session_id, _listing(paths)))


def commit_paths(repo, state_dir, paths, message):
    """Commit exactly `paths` under `message`; the short sha, or None."""
    spec = "\0".join(paths)
    # `git add` errors out on a pathspec matching neither the worktree nor the
    # index — a fully staged `git rm`/`git mv` source — and one such path would
    # abort the whole commit. Those are already staged, and `git commit --only`
    # carries them by itself, so only feed `add` the paths it can match.
    indexed = set(git(repo, "ls-files", "-z").stdout.split("\0"))
    addable = [p for p in paths
               if p in indexed or os.path.lexists(os.path.join(repo, p))]
    if addable:
        add = subprocess.run(
            ["git", "-C", repo, "add", "-A", "--pathspec-from-file=-",
             "--pathspec-file-nul", "--"],
            input="\0".join(addable), capture_output=True, text=True)
        if add.returncode != 0:
            # Not fatal: commit --only may still capture what is already staged.
            log(state_dir, "git add warning: %s" % add.stderr.strip())

    # --only keeps another session's staged-but-uncommitted files out of this commit.
    commit = subprocess.run(
        ["git", "-C", repo, "commit", "-q", "--no-verify", "--only",
         "-m", message, "--pathspec-from-file=-", "--pathspec-file-nul"],
        input=spec, capture_output=True, text=True)
    if commit.returncode != 0:
        err = (commit.stdout + commit.stderr).strip()
        if "nothing to commit" in err or "no changes added" in err:
            print(log(state_dir, "nothing to commit after add"))
        else:
            print(log(state_dir, "git commit failed: %s" % err))
        return None
    return git(repo, "rev-parse", "--short", "HEAD").stdout.strip()


def main():
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        payload = {}

    # session_id becomes a filename under .git/, so keep it to a safe alphabet.
    session_id = re.sub(r"[^A-Za-z0-9._-]", "_", payload.get("session_id") or "") or "unknown"
    transcript = payload.get("transcript_path") or ""
    repo = os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()

    p = subprocess.run(["git", "-C", repo, "rev-parse", "--show-toplevel"],
                       capture_output=True, text=True)
    if p.returncode != 0:
        return 0
    repo = p.stdout.strip()

    gd = git(repo, "rev-parse", "--git-dir").stdout.strip() or ".git"
    if not os.path.isabs(gd):
        gd = os.path.join(repo, gd)
    # State lives in the COMMON git dir, so every worktree of this repo shares one
    # lock, one release set and one cache — they all push to the same origin, and
    # rule 2 has to read a marker another worktree's session wrote.
    common = git(repo, "rev-parse", "--git-common-dir").stdout.strip() or gd
    if not os.path.isabs(common):
        common = os.path.join(repo, common)
    state_dir = os.path.join(common, "inout-autocommit")
    legacy_dir = os.path.join(gd, "inout-autocommit")  # pre-T1 per-worktree state
    cache_dir = os.path.join(state_dir, "cache")
    for d in (state_dir, cache_dir, os.path.join(state_dir, "done"),
              os.path.join(state_dir, "msg")):
        os.makedirs(d, exist_ok=True)

    blocker = in_progress(repo)
    if blocker:
        print(log(state_dir, "skip: %s in progress" % blocker))
        return 0

    # RULE 2 — a worktree cut for a session that is still working is its own.
    owner = worktree_owner(gd)
    if (owner and owner.get("session") != session_id
            and owner_is_live(owner, state_dir)):
        return refuse(state_dir, payload,
                      "REFUSED: %s is session %s's worktree (scripts/worktree.sh) "
                      "and that session is still live — its files are not mine to "
                      "commit. Take your own: scripts/worktree.sh <task-id>."
                      % (repo, owner.get("session")))

    project_dir = os.path.dirname(transcript) if transcript else ""
    if not project_dir or not os.path.isdir(project_dir):
        project_dir = project_transcript_dir(repo)
        if project_dir and not transcript and session_id != "unknown":
            guess = os.path.join(project_dir, session_id + ".jsonl")
            if os.path.exists(guess):
                transcript = guess

    mine, edit_branches = set(), []
    if transcript and os.path.exists(transcript):
        scope = scan_transcript(transcript, cache_dir)
        edit_branches = scope["branches"]
        for abs_path in scope["paths"]:
            rel = rel_to_repo(repo, abs_path)
            if rel:
                mine.add(rel)
    elif project_dir:
        log(state_dir, "warning: no transcript for %s; claiming nothing, "
                       "sweeping only unclaimed files" % session_id)

    their_claims, live_others = other_session_claims(
        project_dir, session_id, state_dir, cache_dir)
    theirs = set()
    for abs_path in their_claims:
        rel = rel_to_repo(repo, abs_path)
        if rel:
            theirs.add(rel)

    # RULE 1 — commit where the work was done, or do not commit.
    branch = current_branch(repo)
    if edit_branches and branch != edit_branches[-1]:
        return refuse(state_dir, payload,
                      "REFUSED: this session edited on '%s' but HEAD is now '%s'. "
                      "Something moved this checkout under the work — a `git "
                      "checkout` in another session, or a switch left behind. "
                      "Nothing was committed and no file was touched. Put HEAD "
                      "back (git switch %s) and stop again, or commit by hand "
                      "where the work belongs."
                      % (edit_branches[-1], branch or "a detached HEAD",
                         edit_branches[-1]))
    if len(set(edit_branches)) > 1:
        log(state_dir, "warning: this session edited on %s; committing on %s"
            % (" then ".join(edit_branches), branch))

    with Lock(os.path.join(state_dir, "lock")) as lock:
        if not lock.held:
            log(state_dir, "warning: lock timeout, proceeding unlocked")

        dirty = dirty_paths(repo)
        mine_x, mine_g = split_claims(mine)
        their_x, their_g = split_claims(theirs)

        def is_mine(path):
            return claim_matches(path, mine_x, mine_g)

        mine_dirty = sorted(p for p in dirty if is_mine(p))
        theirs_dirty = sorted(p for p in dirty if not is_mine(p)
                              and claim_matches(p, their_x, their_g))
        unclaimed = sorted(set(dirty) - set(mine_dirty) - set(theirs_dirty))

        # RULE 3 — a file nobody claims may be a live session's Bash edit that the
        # extractor did not see, so only the last session standing sweeps.
        sweepable = unclaimed if not live_others else []
        held_back = sorted(theirs_dirty + (unclaimed if live_others else []))

        message = authored_message(state_dir, session_id, legacy_dir)
        plan = []
        if message:
            paths = sorted(mine_dirty + sweepable)
            if paths:
                plan.append((paths, message, "named"))
        else:
            if mine_dirty:
                plan.append((mine_dirty,
                             mine_message(session_id, mine_dirty), "unnamed"))
            if sweepable:
                plan.append((sweepable,
                             sweep_message(session_id, sweepable), "sweep"))

        if not plan:
            msg = "nothing to commit"
            if held_back:
                msg += " (%d file%s held back: %d other session%s live)" % (
                    len(held_back), "" if len(held_back) == 1 else "s",
                    len(live_others), "" if len(live_others) == 1 else "s")
            print(log(state_dir, msg))
            _release(state_dir, session_id)
            return 0

        shas = []
        for paths, text, kind in plan:
            sha = commit_paths(repo, state_dir, paths, text)
            if not sha:
                continue
            shas.append(sha)
            print(log(state_dir, "committed %s: %d %s file%s%s" % (
                sha, len(paths), kind, "" if len(paths) == 1 else "s",
                "" if not held_back else "; held back %d for %d live session(s): %s"
                % (len(held_back), len(live_others), ", ".join(held_back[:5])))))

        if not shas:
            _release(state_dir, session_id)
            return 0

        if not NO_PUSH:
            # RULE 4 — a task branch's tip is never pushed to main.
            if branch != BRANCH:
                print(log(state_dir,
                          "NOT PUSHED: HEAD is '%s' and this hook only pushes '%s'. "
                          "The commit is local and safe; merge it to %s when the "
                          "task's gates are green."
                          % (branch or "detached", BRANCH, BRANCH)))
            else:
                gate_err = build_gate(repo, shas[-1])
                if gate_err is not None:
                    print(log(state_dir,
                              "PUSH BLOCKED — commit %s failed the build gate; prod "
                              "keeps the previous build. Fix and push by hand (the "
                              "pre-push gate re-runs), or INOUT_AUTOCOMMIT_NO_GATE=1 "
                              "to push blind.\n%s" % (shas[-1], gate_err)))
                else:
                    push = subprocess.run(
                        ["git", "-C", repo, "push", "-q", "--no-verify", "origin",
                         "HEAD:%s" % BRANCH], capture_output=True, text=True)
                    if push.returncode != 0:
                        print(log(state_dir, "push failed (commit is safe locally): "
                                  "%s" % (push.stderr or push.stdout).strip()))
                    else:
                        log(state_dir, "pushed %s to %s" % (shas[-1], BRANCH))

        _release(state_dir, session_id)
    return 0

def _release(state_dir, session_id):
    """Drop this session's claims — its work is committed."""
    try:
        with open(os.path.join(state_dir, "done", session_id), "w") as f:
            f.write(str(time.time()))
    except OSError:
        pass


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # never block the session on a hook bug
        sys.stderr.write("auto-commit hook error: %r\n" % (exc,))
        sys.exit(0)
