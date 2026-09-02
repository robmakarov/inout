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
`docs/*.md` = agent playbooks (one per instrument); `docs/FLAGS.md` = every switch and its default —
keep it current when a default moves.

Talking to Robert: he wants answers and a recommendation, not a menu. When something needs his call,
ask through the AskUserQuestion UI (2-4 clickable options, recommended first), never a prose list of
questions. Explain jargon in plain words the first time. Behaviour a user can see or hear changes
only with his yes; never break a working path (every new engine ships capability-gated with the
current path as fallback); the engine never refuses a record press.

- Contracts: `src/core/types.ts` is authoritative; `src/core` never imports from `src/app`.
- Dev: `npm run dev` · check: `npm run typecheck && npm test` · e2e without permissions: `?synthetic=1`.
- **Live: https://inout-kappa.vercel.app — Vercel auto-builds `main` on push. THIS is where agents
  verify.** `preview_start { url: "https://inout-kappa.vercel.app/?synthetic=1" }` and drive it; the
  deployed build is the working copy. `&slow=mic:6000` reproduces a stuck arm without hardware. Verify
  in the app, not from the code — three sessions in a row shipped capture fixes "argued from the
  ordering" and the bug survived all three. https://inout-kappa-two.vercel.app is the same build on a
  second ORIGIN, used only as the screen-wedge discriminator (docs/SCREEN_WEDGE.md).
  **A TAB LEFT OPEN ACROSS A DEPLOY IS TESTING THE OLD BUILD** (PWA service worker, cache `inout-v1`).
  Bust it before judging anything:
  `(async()=>{for(const r of await navigator.serviceWorker.getRegistrations())await r.unregister();for(const k of await caches.keys())await caches.delete(k)})()`
  then reload; to be certain, compare a chunk hash from `ls dist/assets` against
  `performance.getEntriesByType('resource')`.
  **THE HIDDEN BROWSER PANE CLAMPS TIMERS TO 1 Hz**: an agent-driven `?synthetic=1` take in it is a
  ~2 fps take, so it is never a rate, fps or elastic test — use the headed scripts (`scripts/*.mjs`).
- Local server, ONLY when a fix must be seen before it is pushed: the preview launcher cannot start
  `npm run dev` from this repo because it lives in `~/Downloads`, which macOS TCC does not grant to the
  launcher's process (`EPERM: uv_cwd`). Don't re-debug it: `node scripts/mirror-watch.mjs &` from Bash
  live-syncs to `/tmp/inout-dev`, then `preview_start { name: "inout-tmp" }` serves it on 5174 with HMR.
  From a second worktree run mirror-watch from THAT worktree, and replace a symlinked `node_modules`
  with a real copy (`rsync -a "<main>/node_modules/" /tmp/inout-dev/node_modules/`). Deletable the day
  the repo moves out of `~/Downloads` (Robert's call; recommended).
- `proto/style.html` is opened off disk with `file://` and never served: one self-contained file, no
  `<script src>`, no `<link>`, no fetch, no modules, no external assets; state persists through the URL
  fragment first because `localStorage` can be refused on `file://`.

Auto-commit: a Stop hook (`.claude/hooks/auto-commit.py`) commits and pushes when a session ends. It
commits the files this session edited plus files no other live session claims. **Name your own commit**
before you finish: `printf 'subject\n\nbody\n' | .claude/hooks/commit-msg.sh` — a `wip: unattributed
sweep …` placeholder is a bug to fix. Files edited through Bash (`sed`, heredoc) are UNCLAIMED and get
swept by whichever session stops first; edit files you care about through the Edit/Write tools.
**A BRANCH YOU CREATE IS NOT A BRANCH YOU KEEP.** Sessions in this checkout share one HEAD and one
index: another session's `git checkout` moves you, and your next commit lands wherever HEAD points
(2026-09-02, task H2b committed to `main` that way). `git branch --show-current` immediately before
every commit, and take your own worktree for anything that must not ship early — never move the `main`
ref from a worktree other sessions commit into.

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
