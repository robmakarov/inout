#!/usr/bin/env python3
"""Stop-hook auto-commit that stays inside its own lane.

The old hook was `git add -A && git commit -m "wip: auto-commit (agent)"`. With two
sessions live in one worktree that is a race: whoever stops first sweeps the other
session's half-finished files into its commit, under its message. Commit 3e4df1d is
the evidence — `setChannelActive` work in src/core carrying 118/90 lines of a
separate session's proto/style.html wedge morph.

This commits only what this session may claim:

    to_commit = dirty - (claimed_by_other_live_sessions - mine)

`mine` is every file this session wrote through Write/Edit/MultiEdit/NotebookEdit,
read out of its own transcript. Another session's claim wins over a blind sweep, but
never over my own edits, and files nobody claims (build output, lockfiles, a stray
Bash write) still get swept so nothing rots uncommitted.

A session releases its claims when its own Stop hook finishes (a done-marker newer
than its transcript). Sessions killed without a Stop release after CLAIM_HOURS.

Message: if the session left one in .git/inout-autocommit/msg/<session_id>, that is
the commit message and the placeholder never appears. Otherwise the generated
message names the session and the files, so a sweep is at least traceable.

Env overrides: INOUT_AUTOCOMMIT_CLAIM_HOURS, INOUT_AUTOCOMMIT_BRANCH,
INOUT_AUTOCOMMIT_NO_PUSH.
"""

import json
import os
import subprocess
import sys
import time

EDIT_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
PATH_KEYS = ("file_path", "notebook_path")

CLAIM_HOURS = float(os.environ.get("INOUT_AUTOCOMMIT_CLAIM_HOURS", "6"))
BRANCH = os.environ.get("INOUT_AUTOCOMMIT_BRANCH", "main")
NO_PUSH = os.environ.get("INOUT_AUTOCOMMIT_NO_PUSH", "") not in ("", "0", "false")

LOCK_STALE_SECS = 600
LOCK_WAIT_SECS = 90


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


# ---------------------------------------------------------------- transcripts

def _extract(line):
    """Repo-absolute file paths written by the edit tools in one transcript line."""
    if '"tool_use"' not in line:
        return ()
    try:
        rec = json.loads(line)
    except ValueError:
        return ()
    msg = rec.get("message")
    if not isinstance(msg, dict):
        return ()
    content = msg.get("content")
    if not isinstance(content, list):
        return ()
    out = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        if block.get("name") not in EDIT_TOOLS:
            continue
        inp = block.get("input")
        if not isinstance(inp, dict):
            continue
        for key in PATH_KEYS:
            val = inp.get(key)
            if isinstance(val, str) and val:
                out.append(val)
    return out


def touched_files(transcript, cache_dir):
    """Paths edited in `transcript`, parsing only the tail appended since last call.

    Transcripts are append-only JSONL, so a byte offset plus the paths found so far
    is a sound cache. Any inconsistency (file shrank, unreadable cache) re-parses
    from zero.
    """
    try:
        size = os.path.getsize(transcript)
    except OSError:
        return set()

    key = os.path.basename(transcript) + ".json"
    cache_file = os.path.join(cache_dir, key)
    offset, paths = 0, []
    try:
        with open(cache_file) as f:
            cached = json.load(f)
        if cached.get("size", 0) <= size:
            offset = cached.get("offset", 0)
            paths = cached.get("paths", [])
    except (OSError, ValueError):
        pass
    if offset > size:
        offset, paths = 0, []

    found = set(paths)
    try:
        with open(transcript, "r", errors="replace") as f:
            f.seek(offset)
            for line in f:
                found.update(_extract(line))
            end = f.tell()
    except OSError:
        return found

    try:
        tmp = cache_file + ".tmp"
        with open(tmp, "w") as f:
            json.dump({"offset": end, "size": size, "paths": sorted(found)}, f)
        os.replace(tmp, cache_file)
    except OSError:
        pass
    return found


def other_session_claims(project_dir, my_session, state_dir, cache_dir):
    """Files claimed by other sessions that are still live.

    Live = transcript touched within CLAIM_HOURS and not released. A session
    releases by writing done/<sid> after its Stop hook commits; if it edits again
    afterwards its transcript outruns the marker and it re-claims.
    """
    claims = set()
    if not project_dir or not os.path.isdir(project_dir):
        return claims
    cutoff = time.time() - CLAIM_HOURS * 3600
    done_dir = os.path.join(state_dir, "done")
    try:
        entries = os.listdir(project_dir)
    except OSError:
        return claims

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
    return claims


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


# --------------------------------------------------------------------- main

def build_message(state_dir, session_id, paths):
    """Session-authored message if there is one, else a traceable generated one."""
    msg_file = os.path.join(state_dir, "msg", session_id)
    try:
        with open(msg_file) as f:
            text = f.read().strip()
        if text:
            try:
                os.remove(msg_file)  # one message, one commit
            except OSError:
                pass
            return text, True
    except OSError:
        pass

    tops = sorted({p.split("/")[0] if "/" in p else p for p in paths})
    scope = ", ".join(tops[:3]) + ("…" if len(tops) > 3 else "")
    subject = "wip: unattributed sweep in %s (%d file%s)" % (
        scope, len(paths), "" if len(paths) == 1 else "s")
    body = "\n".join(
        ["", "No session-authored message; committed by the Stop hook.",
         "Session: %s" % session_id, ""] + ["  %s" % p for p in sorted(paths)[:40]]
        + (["  … and %d more" % (len(paths) - 40)] if len(paths) > 40 else []))
    return subject + "\n" + body, False


def main():
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        payload = {}

    session_id = payload.get("session_id") or "unknown"
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
    state_dir = os.path.join(gd, "inout-autocommit")
    cache_dir = os.path.join(state_dir, "cache")
    for d in (state_dir, cache_dir, os.path.join(state_dir, "done"),
              os.path.join(state_dir, "msg")):
        os.makedirs(d, exist_ok=True)

    blocker = in_progress(repo)
    if blocker:
        print(log(state_dir, "skip: %s in progress" % blocker))
        return 0

    mine = set()
    if transcript and os.path.exists(transcript):
        for abs_path in touched_files(transcript, cache_dir):
            rel = rel_to_repo(repo, abs_path)
            if rel:
                mine.add(rel)

    project_dir = os.path.dirname(transcript) if transcript else ""
    theirs = set()
    for abs_path in other_session_claims(project_dir, session_id, state_dir, cache_dir):
        rel = rel_to_repo(repo, abs_path)
        if rel:
            theirs.add(rel)

    with Lock(os.path.join(state_dir, "lock")) as lock:
        if not lock.held:
            log(state_dir, "warning: lock timeout, proceeding unlocked")

        dirty = dirty_paths(repo)
        held_back = sorted((theirs - mine) & set(dirty))
        to_commit = sorted(p for p in dirty if p not in theirs or p in mine)

        if not to_commit:
            msg = "nothing to commit"
            if held_back:
                msg += " (%d file%s left to other live session%s)" % (
                    len(held_back), "" if len(held_back) == 1 else "s",
                    "" if len(held_back) == 1 else "s")
            print(log(state_dir, msg))
            _release(state_dir, session_id)
            return 0

        message, authored = build_message(state_dir, session_id, to_commit)

        spec = "\0".join(to_commit)
        add = subprocess.run(
            ["git", "-C", repo, "add", "--pathspec-from-file=-",
             "--pathspec-file-nul", "--"],
            input=spec, capture_output=True, text=True)
        if add.returncode != 0:
            print(log(state_dir, "git add failed: %s" % add.stderr.strip()))
            return 0

        # --only keeps another session's staged-but-uncommitted files out of this commit.
        commit = subprocess.run(
            ["git", "-C", repo, "commit", "-q", "--no-verify", "--only",
             "-m", message, "--pathspec-from-file=-", "--pathspec-file-nul"],
            input=spec, capture_output=True, text=True)
        if commit.returncode != 0:
            err = (commit.stdout + commit.stderr).strip()
            if "nothing to commit" in err or "no changes added" in err:
                print(log(state_dir, "nothing to commit after add"))
                _release(state_dir, session_id)
                return 0
            print(log(state_dir, "git commit failed: %s" % err))
            return 0

        sha = git(repo, "rev-parse", "--short", "HEAD").stdout.strip()
        line = "committed %s: %d file%s%s%s" % (
            sha, len(to_commit), "" if len(to_commit) == 1 else "s",
            "" if authored else " (generated message)",
            "" if not held_back else "; left %d to other live session(s): %s" % (
                len(held_back), ", ".join(held_back[:5])))
        print(log(state_dir, line))

        if not NO_PUSH:
            push = subprocess.run(
                ["git", "-C", repo, "push", "-q", "--no-verify", "origin",
                 "HEAD:%s" % BRANCH], capture_output=True, text=True)
            if push.returncode != 0:
                print(log(state_dir, "push failed (commit is safe locally): %s"
                          % (push.stderr or push.stdout).strip()))
            else:
                log(state_dir, "pushed %s to %s" % (sha, BRANCH))

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
