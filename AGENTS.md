# INOUT

Capture (screen/camera/mic/system-audio) → trim → synthesize one MP4 → share (file/cloud).

Internal state lives in `.ai/` (STATE, ARCH, DECISIONS) — read those first, keep them current, keep them compressed.
Doc rule: every doc holds CURRENT truth only — when state changes, rewrite/delete stale lines, never append a log; git history is the archive. Sole exception: `.ai/DECISIONS` is an append-only ledger. BACKLOG: done items are deleted on sight. Human/PM context: `CONTEXT.md` — update it when decisions or state change materially. Bug/idea dumps: `BACKLOG.md` (PO dumps to Inbox, PM triages, TD tags severity). EE task assignments + operating rules: `.ai/TASKS` (TD-authored; evidence gates are mandatory).

- Contracts: `src/core/types.ts` is authoritative; modules implement it.
- `src/core` never imports from `src/app`.
- Dev: `npm run dev` · check: `npm run typecheck && npm test` · e2e without permissions: append `?synthetic=1`.
