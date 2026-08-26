# INOUT

Capture (screen/camera/mic/system-audio) → trim → synthesize one MP4 → share (file/cloud).

Internal state lives in `.ai/` (STATE, ARCH, DECISIONS) — read those first, keep them current, keep them compressed.
Doc rule: every doc holds CURRENT truth only — when state changes, rewrite/delete stale lines, never append a log; git history is the archive. Sole exception: `.ai/DECISIONS` is an append-only ledger. BACKLOG: done items are deleted on sight. Human/PM context: `CONTEXT.md` — update it when decisions or state change materially. Bug/idea dumps: `BACKLOG.md` (PO dumps to Inbox, PM triages, TD tags severity). EE task assignments + operating rules: `.ai/TASKS` (TD-authored; evidence gates are mandatory).

- Contracts: `src/core/types.ts` is authoritative; modules implement it.
- `src/core` never imports from `src/app`.
- Dev: `npm run dev` · check: `npm run typecheck && npm test` · e2e without permissions: append `?synthetic=1`.
- **Live: https://inout-kappa.vercel.app — Vercel auto-builds `main` on push. THIS is where agents
  verify.** `preview_start { url: "https://inout-kappa.vercel.app/?synthetic=1" }` and drive it. Every
  change here is committed and pushed anyway, so the deployed build is the working copy; spinning up a
  local server to look at the same code is wasted tokens. Add `&slow=mic:6000` to reproduce a stuck
  arm without hardware. Verify in the app, not from the code — three sessions in a row shipped capture
  fixes "argued from the ordering" and the bug survived all three.
- Local server, ONLY when a fix must be seen before it is pushed: `npm run dev` cannot be started by
  the preview launcher here — this repo lives in `~/Downloads`, which macOS TCC does not grant to the
  launcher's process, so anything it spawns with this cwd dies on `EPERM: uv_cwd` before vite loads.
  Don't re-debug that. `node scripts/mirror-watch.mjs &` from Bash (which HAS the grant) live-syncs to
  `/tmp/inout-dev`, then `preview_start { name: "inout-tmp" }` serves it on 5174 with working HMR.
  Deletable the day the repo moves out of `~/Downloads` (PO's call), after which plain `npm run dev`
  works for agents too.
- `proto/` is opened off disk and never served. Open `proto/style.html` with `file://` —
  no dev server, no `npm run dev`, not even a static one. It stays one self-contained
  file: no `<script src>`, no `<link>`, no fetch, no modules, no external assets.
  Anything that would only work over http is not allowed in it, and state persists
  through the URL fragment first because `localStorage` can be refused on `file://`.

Auto-commit: a Stop hook (`.claude/hooks/auto-commit.py`) commits and pushes when a session ends.
It commits only the files this session edited, plus files no other live session claims — a second
session in the same worktree keeps its own. **Name your own commit** before you finish:
`printf 'subject\n\nbody\n' | .claude/hooks/commit-msg.sh`. Skip it and you get a
`wip: unattributed sweep …` placeholder, which is a bug to fix, not a default to live with.
Committing by hand also works — the hook then only sweeps what you left behind.

Deploy guard: every push is gated. `scripts/build-gate.sh` builds the exact pushed commit and runs
its tests (~7 s; typecheck is inside `npm run build`; throwaway worktree, so other sessions' dirty
files can't sway the verdict) from both
`.githooks/pre-push` (repo hooks live in tracked `.githooks/`, wired via local `core.hooksPath` —
`.git/hooks` is shadowed by the global hooksPath and does not run) and the Stop hook's own
`--no-verify` push. A commit that fails either stays local and says so loudly;
`INOUT_AUTOCOMMIT_NO_GATE=1` pushes blind. `npm run oracle` is deliberately NOT in the hook — it is
a timing gate whose cold run (what a hook always pays) reads near its band; it stays the per-task
merge gate `.ai/TASKS` already mandates. To prove prod actually serves HEAD after a push:
`node scripts/verify-deploy.mjs` — polls the live entry-asset hashes against a local build of the
same commit; exit 0 only when prod serves this build, loud on failure or timeout. When the commit
changes no bundled output (docs/hooks/scripts), the hashes are already identical and prove nothing —
it says so and waits for Vercel's own success on the GitHub commit-status API instead.

Roadmap protocol: PO saying `roadmap` = print the READY map from `.ai/TASKS` (unblocked tasks,
parallel-safe combos, cost bands) and wait — do not start anything. PO answers `go <id>` → execute
that ONE task per the TASKS operating rules (own branch, gates, TD merge). If PO names several ids,
take the first and say the rest need parallel sessions. After any merge, update the READY map.
When a session finishes its task (or is asked "what now"), remind PO which tasks are currently
parallel-runnable.
