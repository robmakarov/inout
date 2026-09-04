# INOUT

Capture (screen/camera/mic/system-audio) → edit → one MP4 → share (file/cloud). Elastic everywhere,
native at maximum later, one engine behind `src/core/types.ts` (DECISIONS 2026-09-02).

NO HUMAN READS ANY DOC HERE (Robert 2026-09-02: "i dont read docs at all and no human will"). Every file
in `.ai/` and `docs/` is for agents: CURRENT truth only, compressed, no narrative. When state changes,
rewrite or delete the stale line; never append a log — git history is the archive. Sole exception:
`.ai/DECISIONS` is an append-only ledger of Robert's rulings (quote his words, date them).
Read first: `.ai/STATE` (what is true now), `.ai/ARCH` (how it is built), `.ai/TASKS` (roadmap, READY
map, task specs, operating rules — evidence gates are mandatory). `BACKLOG.md` = bugs and ideas
(Robert dumps to Inbox; whoever picks one up triages it; done items are deleted on sight).
`.ai/PROPOSALS` = designs offered to Robert and NOT decided — nothing there is a task, nothing there is
built without his word, and every entry names what it would take away (2026-09-03, DECISIONS robert
(23): before proposing an engine, name what it removes; if the answer is anything, it is not a
proposal). Accepted → it becomes a TASKS row and the entry is deleted; refused → deleted, one line in
DECISIONS.
`docs/*.md` = agent playbooks, one per instrument, listed in `docs/INDEX.md`; `docs/FLAGS.md` = every
switch and its default — keep it current when a default moves.

NO LINKS WITH PARAMETERS. Robert 2026-08-30: "i m tired of your links with parametres, make me one
link /?text with panel of settings we testing all the time" — every switch he might press is a row in
the `/?test` panel (`src/app/components/TestPanel.tsx`), with a hint in plain words saying what to DO
with it, and the URL flag exists only as the same storage read a different way. A knob you tell him to
type is a knob you did not finish. AND A DEFECT FIX SHIPS ON: the frozen rule protects behaviour the
USER CHOSE, it is not a licence to land a fix disabled — the thing being replaced is what carries the
switch (2026-09-03: "you did fix and turned it off so you fucking did nothing?").

Talking to Robert: he wants answers and a recommendation, not a menu. When something needs his call,
ask through the AskUserQuestion UI (2-4 clickable options, recommended first), never a prose list of
questions. Explain jargon in plain words the first time. Behaviour a user can see or hear changes
only with his yes; never break a working path (every new engine ships capability-gated with the
current path as fallback); the engine never refuses a record press.

- Contracts: `src/core/types.ts` is authoritative; `src/core` never imports from `src/app`.
- Dev: `npm run dev` · check: `npm run typecheck && npm test` · e2e without permissions: `?synthetic=1`.
- **Live: https://inout-kappa.vercel.app — Vercel auto-builds `main` on push. THIS is where agents
  verify.** `preview_start { url: "https://inout-kappa.vercel.app/?synthetic=1" }` and drive it; the
  deployed build is the working copy. Test knobs (`?dead=`, `?die=`, `?killenc=`, `?slowstop=`) are in
  docs/FLAGS.md; `?slow=` is LIVE (G6e measured it on prod: 183 ms → 6079 ms with `slow=mic:6000`). Verify
  in the app, not from the code — three sessions in a row shipped capture fixes "argued from the
  ordering" and the bug survived all three. https://inout-kappa-two.vercel.app is the same build on a
  second ORIGIN, used only as the screen-wedge discriminator (docs/SCREEN_WEDGE.md).
  **A TAB LEFT OPEN ACROSS A DEPLOY IS TESTING THE OLD BUILD** (PWA service worker, cache `inout-v1`).
  Bust it before judging anything:
  `(async()=>{for(const r of await navigator.serviceWorker.getRegistrations())await r.unregister();for(const k of await caches.keys())await caches.delete(k)})()`
  then reload; to be certain, compare a chunk hash from `ls dist/assets` against
  `performance.getEntriesByType('resource')`.
  **THE BROWSER PANE IS HIDDEN WHENEVER ROBERT IS NOT LOOKING AT THIS SESSION** (it was hidden in the
  session that wrote this line while he typed). Hidden = Chrome does not composite it (a pane
  screenshot times out at 5 s — 113 times, 4.6M tokens across sessions) and clamps its timers to 1 Hz
  (a `?synthetic=1` take in it is a ~2 fps take, never a rate, fps or elastic test). Text, DOM,
  console and JS all work hidden. A PICTURE comes from `node scripts/see.mjs [url] --shot=<png>` (real
  Chrome, ~3 s, then Read the png); the pane screenshot only after `tabs_context` says displayed — the
  global pane-guard hook (`~/.claude/hooks/pane-guard.py`) refuses it otherwise, do not fight it.
- Local server, ONLY when a fix must be seen before it is pushed: the preview launcher cannot start
  `npm run dev` from this repo because it lives in `~/Downloads`, which macOS TCC does not grant to the
  launcher's process (`EPERM: uv_cwd`). Don't re-debug it: `node scripts/mirror-watch.mjs &` from Bash
  live-syncs to `/tmp/inout-dev`, then `preview_start { name: "inout-tmp" }` serves it on 5174 with HMR.
  From a second worktree run mirror-watch from THAT worktree, and replace a symlinked `node_modules`
  with a real copy (`rsync -a "<main>/node_modules/" /tmp/inout-dev/node_modules/`). Deletable the day
  the repo moves out of `~/Downloads` (Robert's call; recommended).
- `proto/style.html` and `proto/neon.html` (the proto UI's two tabs; each links to the other) are
  opened off disk with `file://` and never served: one self-contained file each, no `<script src>`,
  no `<link>`, no fetch, no modules, no external assets (fonts are embedded data: URLs); state
  persists through the URL fragment first because `localStorage` can be refused on `file://`. A
  picture of either: `node scripts/see.mjs "file:///…/proto/neon.html#p=editor" --shot=<png>`.

Auto-commit: a Stop hook (`.claude/hooks/auto-commit.py`) commits and pushes when a session ends. It
commits the files THIS session edited, and files no live session claims only when it is the last
session standing. **Name your own commit** before you finish: `printf 'subject\n\nbody\n' |
.claude/hooks/commit-msg.sh` — otherwise the hook commits your work under a message saying you named
none. Files edited through Bash (`sed`, heredoc) are claimed only when the command reads as a write;
edit files you care about through the Edit/Write tools.
Four rules are enforced, not advice (T1) — `npm run drill` proves each in ~2 s, and each one is a
REFUSED commit (exit 2, loud, nothing touched): HEAD must still be on the branch this session edited
on · a worktree another live session owns is not yours to commit · unclaimed files are never swept
while another session is live · a task branch commits locally and is NEVER pushed to `main`.
**ONE TASK, ONE WORKTREE**: `scripts/worktree.sh <id>` cuts `~/.inout-worktrees/inout-<id>` on `task/<id>` with
node_modules, settings and an owner marker. Sessions in one checkout share one HEAD and one index —
another session's `git checkout` moves you (2026-09-02: H2b landed on `main` that way). Land the work
FROM THE MAIN CHECKOUT (`git merge --ff-only task/<id>`); never move the `main` ref from a worktree
other sessions commit into.

Deploy guard: every push is gated. `scripts/build-gate.sh` builds the exact pushed commit and runs its
tests (~7 s, throwaway worktree) from both `.githooks/pre-push` (repo hooks live in tracked
`.githooks/`, wired via local `core.hooksPath`) and the Stop hook's own `--no-verify` push. A failing
commit stays local and says so; `INOUT_AUTOCOMMIT_NO_GATE=1` pushes blind. `npm run oracle` is NOT in
the hook (a timing gate whose cold run reads near its band); it stays the per-task merge gate. Prove
prod serves HEAD: `node scripts/verify-deploy.mjs` (polls live entry-asset hashes; for docs-only
commits it waits on Vercel's GitHub commit status instead).

Roadmap protocol: Robert saying `roadmap` = print the READY map from `.ai/TASKS` (unblocked tasks,
parallel-safe combos, cost bands) and wait — start nothing. `go <id>` = execute that ONE task per the
TASKS operating rules (own branch or worktree, gates, merge). Several ids named = take the first, say
the rest need parallel sessions. After any merge, update the READY map. When a task finishes, remind
Robert which tasks are parallel-runnable. Heavy runs are announced and never run while Robert uses
the machine (8 GB M3: size rigs down).
