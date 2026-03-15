# Optimization plan — insanely optimized

**Riot session: product, backend, UI, design system. Data loss is acceptable but must be warned.**

---

## How optimal the code is (short assessment)

**Overall:** Good for a ~5.7k-line single-file app. No major waste; a few hot paths could be tuned if feeds grow very large (100s of rows) or low-end devices struggle.

| Area | Status | Notes |
|------|--------|--------|
| **Backend** | Good | One subscription per channel; minimal column select; no duplicate fetch on channel switch; order/views batched. Add DB indexes if missing (see checklist). |
| **Scroll** | Good | Scroll save debounced 200ms; listener passive; atBottom/scroll btn updated on scroll. |
| **Feed render** | Good | replaceFeedWithList uses DocumentFragment + replaceChildren; no innerHTML for full feed. |
| **Realtime** | Good | Subscriptions cleaned on teardown; suppress flags avoid feedback loops. |
| **DnD dragover** | Medium | processFeedDragover runs on every dragover event (no RAF/throttle); feedDragoverRaf/feedDragoverLast exist but are only cleared on dragend, not used to throttle. With many rows, consider RAF or 16ms throttle. |
| **Event listeners** | Medium | ~15+ listeners per row (dragstart, dragend, touch, click, actions, checkbox). Fine up to ~100 rows; for 500+ rows, delegated listeners on feed would reduce memory and attach cost. |
| **DOM queries in hot paths** | Medium | processFeedDragover and updateEditingRowFromInput do querySelectorAll('.obj') each time. Cached node lists would go stale (rows reorder); acceptable unless profiling shows cost. |
| **CSS** | Good | contain:layout style on feed; font-display and preconnect in use. content-visibility on rows not applied (could help very long feeds). |
| **Bundle** | N/A | No build; single app.js. Tree-shaking not applicable. |

**Summary:** Optimized enough for typical use (dozens of objects, multiple channels). For very large feeds or weak devices, add dragover throttle and consider event delegation or content-visibility.

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
| **Components** | Header, tabs, feed, .obj row, input area, modals, toasts, manage bar. |
| **States** | body.loaded, body.select-mode, body.dnd-active; .obj.dragging, .obj-selected, .obj-drag-target. |

Keep single source: **docs/styling.md** + **ELEMENTS.md**. New components = add to both.

---

## Session checklist (try in-session)

- [x] Backend: documented; entries select already minimal; no duplicate fetch on switch (reloadForUser does one fetch). DB: add indexes on `entries(channel, created_at)`, `views(user_id, channel)` in Supabase dashboard if not present — **no code change, no data risk.**
- [x] UI: preconnect fonts.gstatic.com; `contain:layout style` on #feed and .obj; font-display=swap already in URL.
- [x] Design system: DIRECTION.md updated with tokens + components; OPTIMIZATION.md references docs/styling.md + ELEMENTS.md.
