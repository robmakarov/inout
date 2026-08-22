# INOUT

Capture (screen/camera/mic/system-audio) → trim → synthesize one MP4 → share (file/cloud).

Internal state lives in `.ai/` (STATE, ARCH, DECISIONS) — read those first, keep them current, keep them compressed.
Doc rule: every doc holds CURRENT truth only — when state changes, rewrite/delete stale lines, never append a log; git history is the archive. Sole exception: `.ai/DECISIONS` is an append-only ledger. BACKLOG: done items are deleted on sight. Human/PM context: `CONTEXT.md` — update it when decisions or state change materially. Bug/idea dumps: `BACKLOG.md` (PO dumps to Inbox, PM triages, TD tags severity). EE task assignments + operating rules: `.ai/TASKS` (TD-authored; evidence gates are mandatory).

- Contracts: `src/core/types.ts` is authoritative; modules implement it.
- `src/core` never imports from `src/app`.
- Dev: `npm run dev` · check: `npm run typecheck && npm test` · e2e without permissions: append `?synthetic=1`.

Roadmap protocol: PO saying `roadmap` = print the READY map from `.ai/TASKS` (unblocked tasks,
parallel-safe combos, cost bands) and wait — do not start anything. PO answers `go <id>` → execute
that ONE task per the TASKS operating rules (own branch, gates, TD merge). If PO names several ids,
take the first and say the rest need parallel sessions. After any merge, update the READY map.
When a session finishes its task (or is asked "what now"), remind PO which tasks are currently
parallel-runnable.
