# Optimization plan — insanely optimized

**Riot session: product, backend, UI, design system. Data loss is acceptable but must be warned.**

---

## ⚠️ DATA RISK (warn before doing)

- **Backend**: Changing Supabase queries, RLS, or schema can **lose or hide data**, break realtime, or change who sees what. Always say: *"⚠️ Data risk: …"* before changing.
- **Order/views**: `views`, `message_orders`, `channel_members` — writes affect persistence and cross-device sync. Warn on structural changes.

---

## Backend (Supabase)

| Goal | Action | Data risk? |
|------|--------|------------|
| Fewer round-trips | Batch reads where possible; avoid duplicate fetches for same channel. | Low if read-only. |
| Smaller payloads | Select only needed columns (already: `id, created_at, text, channel, user_id, author_name`). | None. |
| Realtime | One subscription per channel; unsubscribe on switch. Already in place. | Changing filters = ⚠️ can hide events. |
| Indexes | Postgres indexes on `entries(channel, created_at)`, `views(user_id, channel)`, `channel_members(channel, user_id)`. | None (DB only). |

---

## UI (CSS, layout, DOM)

| Goal | Action |
|------|--------|
| Paint/layout | `contain: layout style` on feed; `content-visibility` on message rows if many. |
| Fonts | `font-display: swap` (or in Google Fonts URL); preconnect already present. |
| Repaints | Avoid broad selectors; use classes; reduce `box-shadow`/blur in hot paths. |
| Listeners | Prefer one delegated listener over many (e.g. feed click vs per-row). |

---

## Design system (components / tokens)

| Layer | What |
|-------|------|
| **Tokens** | `:root` vars (already in styling.md): --bg, --text, --acc, --mono, --sans, etc. |
| **Components** | Header, tabs, feed, .msg row, input area, modals, toasts, manage bar. |
| **States** | body.loaded, body.select-mode, body.dnd-active; .msg.dragging, .msg-selected, .msg-drag-target. |

Keep single source: **docs/styling.md** + **ELEMENTS.md**. New components = add to both.

---

## Session checklist (try in-session)

- [x] Backend: documented; entries select already minimal; no duplicate fetch on switch (reloadForUser does one fetch). DB: add indexes on `entries(channel, created_at)`, `views(user_id, channel)` in Supabase dashboard if not present — **no code change, no data risk.**
- [x] UI: preconnect fonts.gstatic.com; `contain:layout style` on #feed and .msg; font-display=swap already in URL.
- [x] Design system: DIRECTION.md updated with tokens + components; OPTIMIZATION.md references docs/styling.md + ELEMENTS.md.
