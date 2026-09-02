#!/usr/bin/env python3
"""The drill that proves two sessions cannot clobber each other (T1).

`npm run drill` — ~2 s, no network, no build. It builds a throwaway repo with a
local bare origin, writes fake Claude Code transcripts for two or three sessions,
and runs the REAL Stop hook (.claude/hooks/auto-commit.py) against them. Every
rule in that hook's header gets one case here, and each case asserts what the repo
looks like afterwards — the commit's files, its subject, what stayed dirty, and
whether origin moved.

Cases

  1 no clobber      two live sessions, disjoint files: each commit carries only
                    its own session's files, and the push still happens on main.
  2 wrong branch    edits made on task/x, HEAD now on main: refused with exit 2,
                    nothing committed, nothing touched (and exit 0 without a
                    second refusal when Claude is already re-invoked).
  3 no placeholder  a session that named no message commits its own files under a
                    message that names it; the `wip: unattributed sweep` subject
                    appears only later, on the file nobody claimed, once no other
                    session is live — and that commit carries nothing else.
  4 foreign worktree  a worktree scripts/worktree.sh cut for a live session is
                    refused to everyone else, and committed by its owner.
  5 push guard      a commit on a task branch stays local; origin/main does not
                    move.

Written as one file with no imports beyond the standard library on purpose: a
drill that needs a toolchain is a drill nobody runs.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

# INOUT_DRILL_HOOK points the drill at another copy of the hook — that is how the
# checks below were shown to be capable of failing: run it against the pre-T1 hook
# and cases 2-5 go red (a gate that cannot fail is not a gate).
HOOK = os.environ.get("INOUT_DRILL_HOOK") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    os.pardir, ".claude", "hooks", "auto-commit.py")

failures = []
notes = []


def check(name, ok, detail=""):
    (notes if ok else failures).append(name)
    print("  %s %s%s" % ("PASS" if ok else "FAIL", name,
                         "" if ok else "\n       %s" % detail))


def git(repo, *args, **kw):
    return subprocess.run(["git", "-C", repo] + list(args),
                          capture_output=True, text=True, **kw)


def write(path, text):
    with open(path, "w") as f:
        f.write(text)


def transcript(path, session, cwd, branch, claims, extra_branch=None):
    """A transcript the hook will read: one tool_use record per claimed file."""
    lines = []
    for i, claim in enumerate(claims):
        rec = {
            "type": "assistant",
            "sessionId": session,
            "cwd": cwd,
            "gitBranch": (extra_branch if (extra_branch and i == 0) else branch),
            "message": {"role": "assistant", "content": [
                {"type": "tool_use", "name": "Write", "id": "t%d" % i,
                 "input": {"file_path": claim}}]},
        }
        lines.append(json.dumps(rec))
    if not claims:  # a live session that has claimed nothing yet
        lines.append(json.dumps({"type": "user", "sessionId": session, "cwd": cwd,
                                 "gitBranch": branch, "message": {"role": "user",
                                                                  "content": "hi"}}))
    write(path, "\n".join(lines) + "\n")
    return path


def run_hook(repo, session, transcript_path, stop_hook_active=False):
    env = dict(os.environ)
    env.pop("CLAUDE_PROJECT_DIR", None)
    env["INOUT_AUTOCOMMIT_NO_GATE"] = "1"
    payload = {"session_id": session, "transcript_path": transcript_path,
               "cwd": repo, "stop_hook_active": stop_hook_active}
    return subprocess.run([sys.executable, HOOK], input=json.dumps(payload),
                          capture_output=True, text=True, env=env)


def head(repo, ref="HEAD"):
    return git(repo, "rev-parse", ref).stdout.strip()


def subject(repo, ref="HEAD"):
    return git(repo, "log", "-1", "--format=%s", ref).stdout.strip()


def files_in(repo, ref="HEAD"):
    out = git(repo, "show", "--name-only", "--format=", ref).stdout.split()
    return sorted(out)


def dirty(repo):
    return sorted(l[3:] for l in
                  git(repo, "status", "--porcelain", "--untracked-files=all")
                  .stdout.splitlines())


def stage_message(repo, session, text):
    common = git(repo, "rev-parse", "--absolute-git-dir").stdout.strip()
    d = os.path.join(common, "inout-autocommit", "msg")
    os.makedirs(d, exist_ok=True)
    write(os.path.join(d, session), text)


def release(repo, session):
    """Mark a session as stopped, the way its own Stop hook would."""
    common = git(repo, "rev-parse", "--absolute-git-dir").stdout.strip()
    d = os.path.join(common, "inout-autocommit", "done")
    os.makedirs(d, exist_ok=True)
    write(os.path.join(d, session), str(time.time()))
    os.utime(os.path.join(d, session), None)


def setup(root):
    origin = os.path.join(root, "origin.git")
    repo = os.path.join(root, "repo")
    subprocess.run(["git", "init", "--quiet", "--bare", "-b", "main", origin],
                   check=True, capture_output=True)
    subprocess.run(["git", "init", "--quiet", "-b", "main", repo],
                   check=True, capture_output=True)
    for k, v in (("user.email", "drill@inout.test"), ("user.name", "drill"),
                 ("commit.gpgsign", "false")):
        git(repo, "config", k, v)
    write(os.path.join(repo, "seed.txt"), "seed\n")
    git(repo, "add", "seed.txt")
    git(repo, "commit", "--quiet", "--no-verify", "-m", "seed")
    git(repo, "remote", "add", "origin", origin)
    git(repo, "push", "--quiet", "origin", "HEAD:main")
    os.makedirs(os.path.join(root, "projects"))
    return origin, repo


# ------------------------------------------------------------------ the cases

def case_no_clobber(root, origin, repo):
    print("\n1 no clobber — two live sessions, disjoint files")
    a, b = "sess-a", "sess-b"
    write(os.path.join(repo, "a.txt"), "a\n")
    write(os.path.join(repo, "b.txt"), "b\n")
    ta = transcript(os.path.join(root, "projects", a + ".jsonl"), a, repo, "main",
                    [os.path.join(repo, "a.txt")])
    tb = transcript(os.path.join(root, "projects", b + ".jsonl"), b, repo, "main",
                    [os.path.join(repo, "b.txt")])
    stage_message(repo, a, "feat: A's work\n")
    stage_message(repo, b, "feat: B's work\n")

    r = run_hook(repo, a, ta)
    check("A commits only a.txt", files_in(repo) == ["a.txt"],
          "committed %s (%s)" % (files_in(repo), r.stdout.strip()))
    check("A uses A's message", subject(repo) == "feat: A's work", subject(repo))
    check("b.txt is left dirty", "b.txt" in dirty(repo), str(dirty(repo)))

    r = run_hook(repo, b, tb)
    check("B commits only b.txt", files_in(repo) == ["b.txt"],
          "committed %s (%s)" % (files_in(repo), r.stdout.strip()))
    check("B uses B's message", subject(repo) == "feat: B's work", subject(repo))
    check("nothing left dirty", dirty(repo) == [], str(dirty(repo)))
    check("both are pushed to origin/main",
          head(repo) == git(origin, "rev-parse", "main").stdout.strip(),
          "local %s vs origin %s" % (head(repo),
                                     git(origin, "rev-parse", "main").stdout.strip()))
    release(repo, a)
    release(repo, b)


def case_wrong_branch(root, origin, repo):
    print("\n2 wrong branch — edits on task/x, HEAD moved to main")
    c = "sess-c"
    write(os.path.join(repo, "c.txt"), "c\n")
    tc = transcript(os.path.join(root, "projects", c + ".jsonl"), c, repo, "task/x",
                    [os.path.join(repo, "c.txt")])
    stage_message(repo, c, "feat: C's work\n")
    before = head(repo)

    r = run_hook(repo, c, tc)
    check("refused with exit 2", r.returncode == 2, "exit %d" % r.returncode)
    check("says REFUSED on stderr", "REFUSED" in r.stderr, r.stderr.strip()[:200])
    check("names both branches",
          "task/x" in r.stderr and "main" in r.stderr, r.stderr.strip()[:200])
    check("nothing committed", head(repo) == before, "%s -> %s" % (before, head(repo)))
    check("c.txt still dirty", "c.txt" in dirty(repo), str(dirty(repo)))

    r = run_hook(repo, c, tc, stop_hook_active=True)
    check("no second refusal when already re-invoked", r.returncode == 0,
          "exit %d" % r.returncode)
    check("still nothing committed", head(repo) == before, head(repo))

    # Put HEAD where the work was done and it commits, as the refusal said it would.
    git(repo, "checkout", "--quiet", "-b", "task/x")
    r = run_hook(repo, c, tc)
    check("commits once HEAD is back on task/x", files_in(repo) == ["c.txt"],
          "%s (%s)" % (files_in(repo), r.stdout.strip()))
    return c


def case_push_guard(root, origin, repo, sess_c):
    print("\n5 push guard — a task branch's tip is not pushed to main")
    origin_main = git(origin, "rev-parse", "main").stdout.strip()
    check("origin/main did not move for the task-branch commit",
          origin_main != head(repo), "origin %s == local %s" % (origin_main, head(repo)))
    log = open(os.path.join(git(repo, "rev-parse", "--absolute-git-dir").stdout.strip(),
                            "inout-autocommit", "log")).read()
    check("says why it did not push", "NOT PUSHED" in log, log[-300:])
    git(repo, "checkout", "--quiet", "main")


def case_placeholder(root, origin, repo):
    print("\n3 no placeholder on a live session's files")
    d, e = "sess-d", "sess-e"
    write(os.path.join(repo, "d.txt"), "d\n")
    write(os.path.join(repo, "leftover.txt"), "nobody claims me\n")
    td = transcript(os.path.join(root, "projects", d + ".jsonl"), d, repo, "main",
                    [os.path.join(repo, "d.txt")])
    te = transcript(os.path.join(root, "projects", e + ".jsonl"), e, repo, "main", [])

    r = run_hook(repo, d, td)
    check("D commits only its own file", files_in(repo) == ["d.txt"],
          "%s (%s)" % (files_in(repo), r.stdout.strip()))
    check("subject is not the placeholder",
          "unattributed sweep" not in subject(repo), subject(repo))
    check("subject says the session named no message",
          "named no message" in subject(repo), subject(repo))
    check("the unclaimed file waits while E is live",
          "leftover.txt" in dirty(repo), str(dirty(repo)))

    release(repo, e)
    os.utime(te, (time.time() - 3600, time.time() - 3600))  # E stopped an hour ago
    r = run_hook(repo, d, td)
    check("the last session standing sweeps it", files_in(repo) == ["leftover.txt"],
          "%s (%s)" % (files_in(repo), r.stdout.strip()))
    check("and only then is the subject the placeholder",
          subject(repo).startswith("wip: unattributed sweep"), subject(repo))
    release(repo, d)


def case_foreign_worktree(root, origin, repo):
    print("\n4 foreign worktree — cut for a live session, refused to everyone else")
    f, g = "sess-f", "sess-g"
    wt = os.path.join(root, "wt-f")
    git(repo, "worktree", "add", "--quiet", "-b", "task/f", wt, "main")
    wgd = git(wt, "rev-parse", "--absolute-git-dir").stdout.strip()
    tf = transcript(os.path.join(root, "projects", f + ".jsonl"), f, wt, "task/f",
                    [os.path.join(wt, "f.txt")])
    tg = transcript(os.path.join(root, "projects", g + ".jsonl"), g, repo, "task/f",
                    [os.path.join(wt, "f.txt")])
    write(os.path.join(wgd, "inout-owner"), json.dumps(
        {"session": f, "transcript": tf, "branch": "task/f", "dir": wt,
         "created": time.time()}))
    write(os.path.join(wt, "f.txt"), "f\n")
    before = head(wt)

    r = run_hook(wt, g, tg)
    check("G is refused in F's worktree", r.returncode == 2, "exit %d" % r.returncode)
    check("the refusal names the owner", f in r.stderr, r.stderr.strip()[:200])
    check("nothing committed by G", head(wt) == before, head(wt))

    r = run_hook(wt, f, tf)
    check("F commits in its own worktree", files_in(wt) == ["f.txt"],
          "%s (%s)" % (files_in(wt), r.stdout.strip()))
    check("F's commit stays off main",
          git(origin, "rev-parse", "main").stdout.strip() != head(wt), "pushed")

    # An abandoned worktree unlocks: the owner released, so G may sweep it.
    release(repo, f)
    os.utime(tf, (time.time() - 3600, time.time() - 3600))
    write(os.path.join(wt, "h.txt"), "h\n")
    r = run_hook(wt, g, tg)
    check("released worktree is no longer fenced", r.returncode == 0,
          "exit %d: %s" % (r.returncode, r.stderr.strip()[:200]))
    git(repo, "worktree", "remove", "--force", wt)


def main():
    if not os.path.exists(HOOK):
        sys.exit("drill: no hook at %s" % HOOK)
    root = tempfile.mkdtemp(prefix="inout-drill.")
    print("drill: %s" % root)
    try:
        origin, repo = setup(root)
        case_no_clobber(root, origin, repo)
        sess_c = case_wrong_branch(root, origin, repo)
        case_push_guard(root, origin, repo, sess_c)
        case_placeholder(root, origin, repo)
        case_foreign_worktree(root, origin, repo)
    finally:
        if failures:
            print("\ndrill: %d of %d checks FAILED — sandbox kept at %s"
                  % (len(failures), len(failures) + len(notes), root))
        else:
            shutil.rmtree(root, ignore_errors=True)
    if failures:
        for name in failures:
            print("  - %s" % name)
        return 1
    print("\ndrill: %d checks pass — parallel sessions cannot clobber each other"
          % len(notes))
    return 0


if __name__ == "__main__":
    sys.exit(main())
