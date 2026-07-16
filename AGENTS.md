# INOUT

Capture (screen/camera/mic/system-audio) → trim → synthesize one MP4 → share (file/cloud).

Default role for coding agents reading this file: **EE** (execution engineer). Before touching anything, read your role brief in `.ai/ROLES` (EE section) and your assignments + operating rules in `.ai/TASKS`. EE reads ONLY `.ai/TASKS`, `.ai/ARCH`, `src/*`; works on `ee/<task-id>` branches; never touches main or `.ai/*` except appending handoff notes (with measured GATES numbers) to its task in `.ai/TASKS`. TD reviews and merges. If a different role was explicitly assigned to this session, that brief in `.ai/ROLES` wins.

Internal state lives in `.ai/` (STATE, ARCH, DECISIONS) — EE reads only what its brief allows; other roles read those first, keep them current, keep them compressed.
Doc rule: every doc holds CURRENT truth only — when state changes, rewrite/delete stale lines, never append a log; git history is the archive. Sole exception: `.ai/DECISIONS` is an append-only ledger. BACKLOG: done items are deleted on sight. Human/PM context: `CONTEXT.md` — update it when decisions or state change materially. Bug/idea dumps: `BACKLOG.md` (PO dumps to Inbox, PM triages, TD tags severity). EE task assignments + operating rules: `.ai/TASKS` (TD-authored; evidence gates are mandatory).

- Contracts: `src/core/types.ts` is authoritative; modules implement it.
- `src/core` never imports from `src/app`.
- Dev: `npm run dev` · check: `npm run typecheck && npm test` · e2e without permissions: append `?synthetic=1`.
