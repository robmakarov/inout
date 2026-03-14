# Architecture and flows (for humans and AI)

High-level order of operations and data flow. All code is in `index.html`.

---

## 1. Page load and init order

1. **HTML parsed** — Body, `#app-loader`, `#app` (header, manage bar, feed with `#empty`, input area), modals, toast, scroll btn. One large `<script>` at end of body runs after DOM is ready (or on DOMContentLoaded).
2. **Script runs** — Supabase client created (`sb`). DOM refs and globals defined. `go()` is invoked immediately.
3. **go()** — Sets `loaderMinUntil = Date.now() + 1200`. If `document.readyState === 'loading'`, waits for `DOMContentLoaded`; then calls `init().catch(...).finally(done)`. Else calls `init().catch(...).finally(done)` directly. `done()` clears a 4s timeout and calls `markLoaded()` (adds `body.loaded`, focuses input).
4. **init()** (async) — Order of operations:
   - Clear editing state from localStorage if needed.
   - **loadChannelsList()** — channels from localStorage.
   - **loadScrollState()** — channelScroll from localStorage.
   - **refreshAuth()** — currentUser from Supabase auth.
   - If currentUser: **syncChannelsFromServer()**.
   - **setupAuthListener()** — on auth change, reload or clear.
   - **setupTabs()** → renderTabs().
   - **restoreLastChannel()** — currentChannel from localStorage.
   - **loadMessageOrderForCurrentChannel()** — order + fieldPrefs from Supabase `views` (or fallbacks).
   - **loadFieldPrefsForCurrentChannel()** — view prefs from Supabase `views` (or localStorage); updates checkboxes and applies to messages.
   - **refreshMoveTargets()**.
   - If currentUser: **loadMessages()** (await ensureLoaderMinDisplay, then renderInitialMessages or leave empty), **subscribeRealtimeAll()**, **setupDraftChannel()**, **subscribeOrderRealtime()**, **subscribeViewRealtime()**, **subscribeActionLog()**.
   - **setupPresence()**.
   - **Restore scroll** — from channelScroll for currentChannel (double rAF), else scrollBottom().
   - **cleanupAuthHash()**, **setupFullscreenOnFirstTap()**, focus input, **setupFocusOnFirstInteraction()**.

So: **channels and scroll** load first, then **auth**, then **tabs and last channel**, then **order and view prefs** (so they’re ready before messages render), then **messages** (with minimum loader time), then **realtime** and **presence**.

---

## 2. Auth flow

- **refreshAuth()** — `sb.auth.getSession()` → sets `currentUser` (or null). No redirect; call on init and after sign-in/sign-out.
- **setupAuthListener()** — `sb.auth.onAuthStateChange()` → on sign-in: sync channels, then reload (load messages, subscriptions). On sign-out: clear messages, teardown draft, clear channel subs.
- Sign-in: **signIn()** → `sb.auth.signInWithOAuth({ provider: 'google' })`. Return to app; auth listener runs.
- Sign-out: **signOut()** → `sb.auth.signOut()`. Listener runs and clears state.
- RLS: entries visible if `user_id = auth.uid()` or (channel, auth.uid()) in `channel_members`. Views and order scoped by `user_id`.

---

## 3. Realtime lifecycle

- **subscribeRealtimeAll()** — Unsubscribes all channelSubs, then for each channel subscribes to `entries` INSERT/UPDATE (postgres_changes). On INSERT → **onInsertForChannel(ch, payload)** (append or reorder). On UPDATE → **onUpdateForChannel** (update row text).
- **subscribeOrderRealtime()** — `message_orders` for current user; on change loads order and applies to DOM.
- **subscribeViewRealtime()** — `views` for current user; on change updates `currentMessageOrder` and/or `fieldPrefs`, saves to local, applies to DOM and messages.
- **subscribeActionLog()** — `action_log` INSERTs for current user (optional).
- **setupDraftChannel()** — Realtime presence/broadcast for draft text; **teardownDraftChannel()** on sign-out.
- On **switchChannel(ch)** we do **not** resubscribe entries (all channels already subscribed). We call **reloadForUser()** which replaces feed and re-subscribes realtime (subscribeRealtimeAll again). Order and view subs are global (user-scoped), not per-channel.

---

## 4. Data flow (Supabase ↔ state ↔ DOM)

- **Entries (messages)**  
  - **Read**: `fetchMessagesList()` → Supabase `entries` for currentChannel (and user for main) → sorted by `currentMessageOrder` → **renderInitialMessages(list)** or **replaceFeedWithList(list)** → **createMsgRow()** per message.  
  - **Write**: Send → `sb.from('entries').insert(...)`. Edit → `.update({ text })`. Delete → `.delete().in('id', ids)`.  
  - **Realtime**: INSERT/UPDATE → onInsertForChannel / onUpdateForChannel → DOM update or append.

- **Order**  
  - **Read**: `loadMessageOrderForCurrentChannel()` → `views.config.order` (or message_orders, or localStorage).  
  - **Write**: Reorder (DnD or move) → **recomputeOrderFromDOM()** or explicit order → **saveMessageOrderForCurrentChannel()** → localStorage + Supabase `message_orders` + **views** (upsert config.order).  
  - **Realtime**: `subscribeOrderRealtime` / **subscribeViewRealtime** → reload order, apply to DOM.

- **View prefs (Time/Author)**  
  - **Read**: `loadFieldPrefsForCurrentChannel()` → Supabase `views.config` (showTime, showAuthor) or localStorage.  
  - **Write**: Checkbox change → **saveFieldPrefsForCurrentChannel()** → localStorage + Supabase `views` upsert.  
  - **Realtime**: **subscribeViewRealtime** → update fieldPrefs, **applyFieldPrefsToMessages()**, **applyFieldPrefsUI()**.

- **Scroll**  
  - **Read**: On init/reload: `channelScroll.get(currentChannel)` (from localStorage via loadScrollState).  
  - **Write**: Scroll listener (debounced) → channelScroll.set + **saveScrollState()**. **switchChannel()** saves current feed scroll before switching.

---

## 5. Channel switch flow

- **switchChannel(ch)** — If same channel, return. Save current feed scroll to channelScroll and **saveScrollState()**. Set currentChannel, persist to localStorage. Update tabs UI, badges, move targets. **loadFieldPrefsForCurrentChannel()** for new channel. If currentUser: **ensureMembership().then(reloadForUser)**. Else **clearMessages()**.
- **reloadForUser()** — loadMessageOrderForCurrentChannel, fetchMessagesList, **replaceFeedWithList(list)** (with ensureLoaderMinDisplay), subscribeRealtimeAll, restore scroll from channelScroll (or scrollBottom), applyFieldPrefsToMessages.

---

## 6. Where state lives

- **Server**: Supabase (entries, channel_members, views, message_orders, action_log). Realtime pushes changes to client.
- **Client memory**: currentUser, currentChannel, channels, currentMessageOrder, fieldPrefs, channelScroll, selectedIds, selectMode, editingMessageId, etc. See **ELEMENTS.md** (root) for full list.
- **Client persistence**: localStorage (channels, current channel, input draft, field prefs, order backup, scroll, “was editing”). See **ELEMENTS.md** for keys.
- **DOM**: Reflects state; updated by apply* and render* functions. No separate “store”; read from DOM when needed (e.g. order from .msg rows).

Keeping this file updated: when you change init order, add/remove a subscription, or change how order/view/scroll are loaded or saved, update the relevant section above.
