# INOUT

Capture (screen/camera/mic/system-audio) → trim → synthesize one MP4 → share (file/cloud).

Assignments and operating rules live in `.ai/TASKS` — one branch per task, evidence gates pasted as measured numbers in a handoff appended under the task. Nothing outside that file is an assignment. Robert decides product; everything technical is settled here, on evidence.

Internal state lives in `.ai/` (STATE, ARCH, DECISIONS) — read those first, keep them current, keep them compressed.
Doc rule: every doc holds CURRENT truth only — when state changes, rewrite/delete stale lines, never append a log; git history is the archive. Sole exception: `.ai/DECISIONS` is an append-only ledger. BACKLOG: done items are deleted on sight. Human context: `CONTEXT.md` — update it when decisions or state change materially. Bug/idea dumps: `BACKLOG.md` (Robert dumps to Inbox; whoever picks it up triages and tags severity). Task specs + operating rules: `.ai/TASKS` (evidence gates are mandatory).

- Contracts: `src/core/types.ts` is authoritative; modules implement it.
- `src/core` never imports from `src/app`.
- Dev: `npm run dev` · check: `npm run typecheck && npm test` · e2e without permissions: append `?synthetic=1`.
