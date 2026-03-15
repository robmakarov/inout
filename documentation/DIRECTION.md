# DIRECTION

**Product, rules, team, process. One source of truth. If a command breaks a * rule → warn first.**

---

## PRODUCT MODEL (what we build)

- **Product = base for user objects.** UI exists to **input and output** those objects — nothing else is first-class.
- **Each user has their own base** (their object tables). They **can give access** to other users; those users can **input and read/edit** within the shared scope.
- **Tables of objects have a view** — how they’re shown and ordered is part of the model.
- **Goals**: Safe for market. As fast as possible. **Super minimal** in operations and data.

**Terminology:** **Object** = the entity (what was called “message” or “entry”). An object has **basic parameters** (id, created_at, channel, user_id, author_name, …) and a **message** — the message is the **text** of the object (the content). So: object = row; message = its text.

---

## * RULES (product, DB, code, UI — never break these)

- * **Minimal operations** — Fewest API calls, subscriptions, and writes needed. No extra round-trips.
- * **Minimal data** — Smallest schema and payloads; only store and send what’s needed for the product model.
- * **Safe for market** — Access only by explicit grant; no data visible without permission. RLS and auth enforce it.
- * **Only the user who added you can grant access** — If user A did not add user B, B can never see A’s data. No see-through, no transitive sharing. (Permissions / read-only etc. later.)
- * **Delete = permanent on server** — What the app deletes is removed from the database for good. No soft delete, no trash/recycle bin.
- * **Fast** — Design for low latency and few operations; avoid bloat that slows reads/writes or UI.

---

## TEAM

| Role        | Who        |
|------------|------------|
| Lead designer | You (human) |
| Lead engineer  | AI (Cursor) |

---

## PROCESS

- **Riot session** — Session where we check the product is going the right way and change anything that isn’t. Use this file: enforce * rules, update facts and process here.

---

## CURRENT STATE vs PRODUCT MODEL (fit)

| Model | Current state | Fit |
|------|----------------|-----|
| **Product = base for objects; UI = I/O** | Feed shows entries; input sends, edit/delete change them. No other first-class entity. | ✅ Fits |
| **Each user has own base** | Main = private (user_id + channel 'main'). Channels = extra “tables” for that user. | ✅ Fits |
| **User can give access; others input + read/edit** | `channel_members`: add user_id to channel → they see it and can send/edit/delete. RLS enforces. | ✅ Fits |
| **Tables have a view** | `views` per user+channel: order + showTime, showAuthor. Realtime sync. | ✅ Fits |
| **Safe for market** | RLS: entries only if owner or in channel_members; views/members scoped by user. | ✅ Fits |
| **Minimal operations / data** | One fetch per channel; select only needed columns; subs per channel. Order in both `message_orders` and `views.config` = can trim. | ⚠️ Good, can trim |
| **Fast** | Realtime; view/order in one row; containment + small payloads. | ✅ Fits |

**Extras (not in model):** action_log, draft presence, scroll/input in localStorage — UX only, don’t break model.

---

## PLANNED (user preferences, same on all devices)

- **Hotkeys** — User can set their own hotkeys for any action; optional different layouts. Stored per user, synced across all devices (desktop + mobile).
- **App settings** — User can change app settings; saved to their profile and synced everywhere (all devices, including mobile). Same mechanism: server-side by user_id, so every device sees the same prefs.

(Implies: prefs/hotkeys in DB keyed by user_id, not just localStorage; Realtime or load-on-init so all devices stay in sync.)

---

## PRODUCT FACTS (short, structured)

- INOUT = single-page app; one `index.html` (HTML + CSS + JS), no build. Supabase (Auth, Postgres, Realtime). Vercel static.
- **Current shape of the model**: Objects = entries (DB rows). Each object has basic params + message (text). User’s base = Main feed (private) + channel tables. Sharing = channel_members; granted users can input + read/edit. View = order + show Time/Author per channel; persisted in `views`. Delete in app = hard delete on server.

## DESIGN SYSTEM (tokens + components)

- **Tokens**: `:root` in index.html — `--bg`, `--bg2`, `--line`, `--text`, `--bright`, `--acc`, `--mono`, `--sans`. See docs/styling.md.
- **Components**: header, #tabs, #feed / .msg, #input-area, #manage-bar, modals, toasts. States: body.loaded, body.select-mode, body.dnd-active; .msg.dragging, .msg-selected, .msg-drag-target.
- Single source: docs/styling.md + ELEMENTS.md. New component = add to both.

---

*When you see * in my message = new or updated rule. If a command conflicts with a * rule, say: "⚠️ Conflicts with rule: …" and ask before changing.*
