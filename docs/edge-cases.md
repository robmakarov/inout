# Edge cases and conventions (for humans and AI)

Gotchas, “don’t do this,” and patterns to follow. **When you fix or discover a new gotcha, add it here.**

---

## 1. Script and HTML

- **No literal `</script>` in JS strings** — If you ever put a string like `"</script>"` inside the inline script, the HTML parser will close the script tag early. Use `'</scr' + 'ipt>'` or `<\/script>` (or avoid the substring).
- **Single entry point** — The app runs from one `<script>` at the end of `index.html`. There is no separate bundle loaded in production; `app/` and `bundle.js` exist in repo but are not used by the live app.

---

## 2. Supabase and auth

- **Guard `sb`** — Supabase client is created in a try/catch; `sb` can be null if the script fails or Supabase is blocked. Before calling `sb.from(...)` or `sb.auth`, check `sb` or wrap in try/catch so a missing backend doesn’t break the whole app.
- **RLS** — Entries are visible only if user is sender or in `channel_members`. Inserts must use `user_id = auth.uid()`. Don’t assume client can read/write arbitrary rows.
- **Realtime feedback loops** — When we upsert `views` or order, the same client gets a realtime event. We use **suppressNextViewApply** / **suppressNextOrderApply** and **suppressOrderApplyUntil** so we don’t re-apply and overwrite or flicker. When adding new realtime-driven writes, consider a similar suppress flag.

---

## 3. View prefs and “flash” on refresh

- **Time/Author default** — `.msg-time` and `.msg-sender` are `display:none` in CSS so they never “flash” visible before view prefs load. JS shows them from **fieldPrefs** in **createMsgRow** and **applyFieldPrefsToMessages**.
- **Load order** — **loadMessageOrderForCurrentChannel** and **loadFieldPrefsForCurrentChannel** run before **loadMessages** so fieldPrefs are set before any row is created. Keep this order when changing init.

---

## 4. Scroll and persistence

- **Scroll is per-channel** — **channelScroll** Map + **SCROLL_STATE_KEY** in localStorage. On switch we save current feed scroll, then restore the new channel’s scroll in **reloadForUser** (or scrollBottom if none).
- **Debounce** — Scroll listener updates **channelScroll** and calls **saveScrollState** with a 200ms debounce so we don’t write localStorage on every scroll tick.

---

## 5. Selection and drag-select

- **Content coordinates for drag-select** — **applyDragSelectRect** uses content Y (scroll-relative), not viewport Y, so the selection rect doesn’t “move” when the feed scrolls. Row positions use the same coordinate system (getBoundingClientRect + feedRect + scrollTop).
- **pointerDownOnSelectArea** — Set on mousedown on checkbox zone so the next dragstart (if any) is prevented and we don’t start a message drag when the user meant to drag-select.

---

## 6. DnD reorder

- **body.dnd-active** — Added on dragstart (mouse or touch long-press), removed on dragend. Disables .msg:hover so rows don’t blink as the cursor moves.
- **feedDropIndicatorEl** — Created on first need, appended to document.body. Position fixed; .visible toggled in processFeedDragover and cleared on drop/dragend/dragleave.
- **.msg-drag-target** — Applied to the single row that is the current drop target; its time/sender/text shift 30px right. Removed when target changes or drag ends.
- **flipAnimateShift** — Currently a no-op (was causing an extra “ghost” line). Reorder is immediate.

---

## 7. Loader and empty state

- **Loader in #empty** — The rings+bars loader lives inside **#empty** in the feed. **#app-loader** is display:none. So the only visible loader is in the feed empty state.
- **ensureLoaderMinDisplay** — **loadMessages** and **replaceFeedWithList** await this so the loader is visible at least 1.2s (loaderMinUntil set in **go()**).

---

## 8. LocalStorage keys

- All keys are prefixed (e.g. inout_channels_v1). Don’t change key names without handling migration or old keys.
- **WAS_EDITING_KEY** — If set, init clears input and placeholder so we don’t show “editing” state from a previous session on load.

---

## 9. Focus and modals

- **focusMessageInput** — Called after many actions (send, cancel edit, drag end, etc.). Modals and interactive elements (buttons, links) are excluded from “steal focus” so clicking them doesn’t immediately refocus the textarea in a bad way (see isInteractive in setupFocusOnFirstInteraction).

---

## 10. Conventions for edits

- **No new global state libraries** — Prefer existing globals and small functions.
- **Keep build-free** — App should run by opening index.html or serving the repo statically.
- **Preserve dark theme** — Use :root variables; don’t introduce one-off colors unless necessary.
- **When adding DOM or state** — Update **ELEMENTS.md** (root). When adding/changing a function, update **docs/functions-index.md**. When changing init or realtime, update **docs/architecture.md**. When changing CSS vars or state classes, update **docs/styling.md**.

Adding a short note here when you fix a subtle bug or add a new convention helps both humans and AI avoid regressions.
