# INOUT

Minimal, single-file realtime message app. Tabbed feeds (Main + custom channels), Google auth, Supabase backend, no build step.

---

## For humans

### What it is

- **Static SPA**: One `index.html` (~5k lines) with inlined CSS and JS. No bundler, no framework.
- **Hosting**: Vercel (static). All routes serve `index.html` (see `vercel.json`).
- **Backend**: Supabase (Postgres, Realtime, Auth with Google OAuth, RLS).
- **Optional**: Stripe loaded from CDN for future subscription use.

### Run locally

```bash
npx serve -l 4173 .
```

Open `http://localhost:4173`. Supabase anon key and URL are in `index.html`; replace or use env if you fork.

### Features

- **Auth**: Sign in/out with Google. Copy user ID from header for sharing.
- **Feeds**: “Main” (private to you) + custom channels (tabs). Create/delete tabs; share a channel by adding other users’ Supabase user IDs.
- **Messages**: Realtime send/receive; reorder by drag-and-drop; edit/delete; optional Time/Author visibility per channel (view settings sync across devices).
- **UI**: Dark theme (DM Mono + Syne), sticky header, tab strip, scrollable feed, bottom input (Enter = send, Shift+Enter = newline). Loader animation in empty state. Scroll position and view settings persist across refresh.

### Tech stack

| Layer    | Choice                          |
|----------|----------------------------------|
| Frontend | Vanilla JS, single HTML file     |
| Styling  | Inline `<style>`, CSS variables  |
| Auth     | Supabase Auth (Google OAuth)     |
| Data     | Supabase Postgres + Realtime     |
| Hosting  | Vercel static                    |

---

## For AI / codebase context

Use this section when editing the repo: file layout, data model, where behavior lives, and conventions.

### File layout

```
/
  index.html     # Single entry point: HTML, CSS, and JS inlined (~4968 lines)
  vercel.json    # SPA routing: all paths → index.html
  README.md      # This file
  ELEMENTS.md    # Reference: DOM elements, JS state, conditions, and functions (for humans and AI)
  TODO.txt       # Product/tech backlog (optional reading)
```

There are also `app/state.js`, `app/main.js`, and `bundle.js` in the repo; the **live app uses only `index.html`** (no script tags to bundle.js). All app logic is in one `<script>` at the end of `index.html`.

### Data model (Supabase)

- **`public.entries`** — Messages.
  - Columns: `id` (bigint PK), `created_at` (timestamptz), `text`, `channel`, `user_id` (uuid → auth.users), `author_name` (optional).
  - Main feed: `channel = 'main'` and `user_id = auth.uid()`.
  - Shared channels: access via `channel_members`.

- **`public.channel_members`** — Who can see a channel.
  - Columns: `channel` (text), `user_id` (uuid), `inserted_at`.
  - PK: `(channel, user_id)`.

- **`public.views`** — Per-user, per-channel view config (order + UI prefs).
  - Columns: `user_id`, `channel`, `config` (jsonb: `{ order: number[], showTime: boolean, showAuthor: boolean }`).
  - Conflict: `user_id, channel`. Realtime sync for cross-device view settings.

- **`public.message_orders`** — Legacy per-message order (optional fallback).
  - Columns: `user_id`, `channel`, `entry_id`, `position`.

- **`public.action_log`** — Optional action log (see comment block in code for `create table`).

### Where key behavior lives (in `index.html`)

| Concern            | Where in index.html (approx / search)                    |
|--------------------|----------------------------------------------------------|
| Supabase client    | `supabase.createClient(...)` near top of script         |
| Auth state         | `currentUser`, `refreshAuth()`, `setupAuthListener()`    |
| Channels / tabs    | `channels`, `currentChannel`, `switchChannel()`, `renderTabs()` |
| Feed messages      | `loadMessages()`, `fetchMessagesList()`, `replaceFeedWithList()`, `createMsgRow()` |
| Realtime           | `subscribeRealtimeAll()`, `subscribeViewRealtime()`, `subscribeOrderRealtime()` |
| View prefs         | `fieldPrefs`, `loadFieldPrefsForCurrentChannel()`, `saveFieldPrefsForCurrentChannel()`, `applyFieldPrefsToMessages()` |
| Order / reorder    | `currentMessageOrder`, `loadMessageOrderForCurrentChannel()`, `applyMessageOrderToDOM()`, `saveMessageOrderForCurrentChannel()` |
| DnD reorder        | `processFeedDragover()`, feed `dragover` / `drop` listeners, `flipAnimateShift()` |
| Scroll persistence | `channelScroll`, `loadScrollState()`, `saveScrollState()`, scroll listener on `#feed` |
| Local storage keys | `CHANNELS_KEY`, `CURRENT_CHANNEL_KEY`, `ORDER_STATE_KEY`, `SCROLL_STATE_KEY`, `FIELD_PREFS_KEY`, `INPUT_STATE_KEY` |

### DOM IDs and structure

- **`#app`** — Main app shell (visible after load).
- **`#feed`** — Scrollable message list container; `#feed-inner` holds rows.
- **`#empty`** — Empty state (loader + “Nothing yet”) inside `#feed-inner`.
- **`#msg-input`** — Message textarea; Send button, clear button.
- **`#tabs`** — Channel tab strip (Main + custom).
- **`#manage-bar`** — Select mode toolbar (Select, All, None, Delete, Move, Export, View).
- **View menu** — Checkboxes “Time” and “Author” (`#field-time`, `#field-author`).
- **Modals**: `#user-modal-backdrop`, `#channel-modal-backdrop`.

Message rows: class `.msg`, `data-id` = entry id, `draggable="true"`. Checkbox for select: `.msg-select`; actions: `.msg-actions`.

### Conventions

- **No build**: Keep the app runnable by opening `index.html` or serving the repo statically. No required compile step.
- **Style**: Dark theme; CSS variables in `:root` (`--bg`, `--acc`, `--text`, `--mono`, `--sans`). Fonts: DM Mono, Syne (Google Fonts).
- **Auth**: All Supabase calls that need a user check `currentUser`. RLS enforces per-user and channel_members access.
- **State**: Global vars and one shared Supabase client. No Redux/Vue/React. View/order/scroll persisted in Supabase `views` + localStorage.
- **Realtime**: Subscriptions are per channel / per user; cleanup on sign-out or channel switch (unsubscribe before resubscribe).

### Project prompt (for AI)

When asking an AI to work on this repo, you can say:

> You are editing **INOUT**, a single-file web app (entry point `index.html`) hosted on Vercel, backend Supabase (Postgres + Realtime + Google Auth).  
> - Keep the app build-free and the current dark, minimal style (DM Mono, Syne, CSS variables in index.html).  
> - Auth and visibility: respect RLS; Main feed is per-user; shared channels use `channel_members`.  
> - Preserve UX: realtime feed, tabbed channels, drag reorder, view settings (Time/Author) synced via `views` table, scroll and view prefs persisted, toast notifications, responsive layout.  
> - Prefer small, focused changes; avoid new global state libraries. Read README “For AI / codebase context” for file layout, tables, and where behavior lives.

---

## Supabase setup (reference)

- **Project URL**: `https://<project-ref>.supabase.co`
- **Anon key**: In `index.html` or env; required for client.
- **Tables**: See “Data model (Supabase)” above. Enable Realtime on tables used in subscriptions (`entries`, `views`, etc.).
- **RLS**: `entries` — SELECT where `user_id = auth.uid()` or `(channel, auth.uid())` in `channel_members`. Inserts with `user_id = auth.uid()`. `views` and `channel_members` scoped by `user_id` / membership.

Local dev: run `npx serve -l 4173 .` and open `http://localhost:4173`.
