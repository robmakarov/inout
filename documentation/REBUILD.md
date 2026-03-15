# INOUT — Rebuild spec (human + AI)

Single source to rebuild the app from scratch. Keep minimal; extend when behavior changes.

---

## 1. Product

Realtime message app: tabbed feeds (Main + custom channels), Google auth, Supabase. One object class per view: rows with time, author, message text. Create/edit/delete/reorder; optional Time/Author visibility per channel; multi-select (Delete, Move, Export); multi-edit (same single-char changes to all selected); second view (Shift+click tab) with resizable split and DnD between views; remote editing doppelganger (badge); draft/clipboard bubbles; scroll and view prefs persisted.

---

## 2. Stack

| Layer   | Choice                    |
|---------|---------------------------|
| Frontend| Vanilla JS, no framework  |
| Entry   | index.html + styles.css + app.js |
| Auth    | Supabase Auth (Google OAuth, PKCE) |
| Data    | Supabase Postgres + Realtime |
| Hosting | Vercel static             |

No build step. Run: `npx serve -l 4173 .` → `http://localhost:4173`.

---

## 3. File layout

```
/
  index.html       # Shell: head (meta, fonts, Supabase script, sb/doSignIn), body (header, nav, multiview, input-area, modals, scroll btn, toast), <link href="/styles.css">, <script src="/app.js">
  styles.css       # All CSS: :root vars, layout, components, DnD, modals, responsive
  app.js           # All app logic: sb client, DOM refs, state, init(), realtime, DnD, edit, send, etc.
  vercel.json      # SPA: /styles.css, /app.js → self; (.*) → index.html
  README.md        # Overview, run, stack, doc index
  documentation/
    REBUILD.md     # This file — rebuild spec
    README.md      # Doc index
    architecture.md, ELEMENTS.md, styling.md, edge-cases.md, security.md, functions-index.md  # Deep-dives
  design-system/
    components.md, modes.md, animations.md, colors.md, text.md, dnd.md  # UI/UX tokens and behavior
```

Supabase URL/anon key: in index.html (inline script) and in app.js fallback. Replace for fork.

---

## 4. Data model (Supabase)

**entries** — Messages. `id` (bigint PK), `created_at`, `text`, `channel`, `user_id`, `author_name`. Main: `channel='main'`, `user_id=auth.uid()`. Shared: access via channel_members. Realtime: INSERT/UPDATE per channel.

**channel_members** — Who sees a channel. `channel`, `user_id`, `creator_id` (who added). PK (channel, user_id). Only creator can add members. RLS: see security.md.

**views** — Per-user, per-channel config. `user_id`, `channel`, `config` (jsonb: `order`, `showTime`, `showAuthor`). Upsert key (user_id, channel). Realtime for cross-device.

**message_orders** — Optional legacy order; fallback in loadMessageOrderForCurrentChannel.

**action_log** — Optional; user_id, action, details.

Enable Realtime on entries, views (and message_orders if used). RLS on all; see documentation/security.md for full SQL.

---

## 5. Init order

1. Clear WAS_EDITING + input if set (localStorage).
2. Supabase client: use window.sb from index.html or create in app.js; OAuth code exchange if `?code=` in URL.
3. go(): set loaderMinUntil (e.g. +1200ms). If document.readyState === 'loading', wait DOMContentLoaded.
4. init():  
   loadChannelsList → loadScrollState → refreshAuth → (if user) syncChannelsFromServer → setupAuthListener → setupTabs → restoreLastChannel → loadMessageOrderForCurrentChannel → loadFieldPrefsForCurrentChannel → refreshMoveTargets → (if user) loadMessages (await ensureLoaderMinDisplay), subscribeRealtimeAll, setupDraftChannel, subscribeOrderRealtime, subscribeViewRealtime, subscribeActionLog → setupPresence → restore scroll (channelScroll or scrollBottom) → cleanupAuthHash, focus input, setupFocusOnFirstInteraction.
5. done(): clear 4s timeout, markLoaded() (body.loaded, focus input).

Load order/prefs before messages so fieldPrefs exist when creating rows. Realtime after messages so INSERT/UPDATE handlers see DOM.

---

## 6. Auth

refreshAuth(): getSession → currentUser. setupAuthListener(): onAuthStateChange → sign-in: sync channels, reload (load messages, subs); sign-out: clear messages, teardown draft, clear channel subs. signIn(): signInWithOAuth({ provider: 'google' }). signOut(): signOut(). RLS: entries visible if user_id=auth.uid() or (channel, auth.uid()) in channel_members; inserts user_id=auth.uid().

---

## 7. Realtime

- **subscribeRealtimeAll**: entries INSERT/UPDATE per channel → onInsertForChannel (append/reorder), onUpdateForChannel (update row text, clear remote doppelganger).
- **subscribeOrderRealtime**: message_orders → reload order, apply to DOM (use suppressNextOrderApply / suppressOrderApplyUntil to avoid feedback).
- **subscribeViewRealtime**: views → update currentMessageOrder and/or fieldPrefs, apply (suppressNextViewApply).
- **setupDraftChannel**: presence + broadcast draft; broadcastDraft(text); show remote draft bubble; teardownDraftChannel on sign-out.
- **DnD broadcast**: dnd-{channel} for origin/target lines and ghost (see dnd.md).

---

## 8. Key flows

**Channel switch** — switchChannel(ch): save scroll to channelScroll, saveScrollState; currentChannel, persist; updateTabsUI; loadFieldPrefsForCurrentChannel; ensureMembership().then(reloadForUser) or clearMessages. reloadForUser: loadMessageOrderForCurrentChannel, fetchMessagesList, replaceFeedWithList, subscribeRealtimeAll, restore scroll, applyFieldPrefsToMessages.

**Send (input mode)** — send() → sendText(input.value): sb.from('entries').insert({ text, channel, user_id, ... }); clear input; append or reorder row.

**Edit** — Click .obj-text → input.value = row text, input.selectionStart/End = 0 for multi; editingObjectId / editingObjectIds, editingObjectTextMap, originalEditTextForCancel(Map); updateEditingRowFromInput() (doppelganger: before + selection + caret + after); Send → update entries per id from editingObjectTextMap; Escape → restore rows from original, cancelEditingMode. Multi-edit: only single-char insert/delete propagated (applyPrimaryEditToMultiEdit); shorter rows: delete from end when pos past length.

**Reorder** — DnD: dragstart (body.dnd-active, spirit/ghost), dragover (processFeedDragover: .obj-drag-target, feedDropIndicatorEl), drop/dragend (recomputeOrderFromDOM, saveMessageOrderForCurrentChannel, remove spirit). Realtime: broadcast dnd_start/dnd_move/dnd_end; other clients show origin/target lines and ghost; dnd_dropped → apply order, .obj-remote-reorder animation.

**Select** — setSelectMode(true): body.select-mode, #select-toggle.active, #select-extra.show; checkboxes on rows; selectedIds; Delete/Move/Export use selectedIds. Drag-select: rect from pointer; applyDragSelectRect.

**Multiview** — Shift+click tab: open as secondary view (secondaryViewEl, secondaryFeedInner); .tab-secondary-open; resizable .multiview-resizer, --multiview-split in localStorage. DnD between views: getDraggingRowAndSource, animateMessageToView, drop updates entry channel. Realtime: onInsertForChannel / onUpdateForChannel for secondary channel; findObjectRowEl / findObjectRowTextEl work in both feeds.

**Remote editing** — broadcastDraft with authorName, deviceId; showRemoteEditingDoppelganger(id, text, author, deviceId); badge in .obj-text; clearRemoteEditingDoppelganger on UPDATE or cancel.

---

## 9. DOM (IDs and key classes)

**Shell** — #app, #app-loader (hidden), #nav (#tabs), #multiview, .multiview-panels, .view.view-primary (#view-app), .view-secondary, .multiview-resizer, #input-area, #feed (#feed-inner, #empty), #feed-inner-secondary when secondary open.

**Header** — .logo, #online-count (#oc-num), #object-count, #user-btn.

**Manage bar** — #manage-bar, #manage-bar-scroll, #select-toggle (.active), #select-extra (.show), #manage-actions, #delete-selected, #move-target, #move-selected, #export-tab, #view-toggle, #view-menu, #field-time, #field-author, #bar-reorder-toggle.

**Feed** — .feed-inner, #empty, .feed-drop-indicator (.visible). Row: .obj, data-id, .obj-time, .obj-sender, .obj-text (doppelganger + .obj-remote-edit-badge), .obj-checkbox-zone, .obj-select-wrap, .obj-select, .obj-actions, .obj-action-btn. States: .obj-selected, .obj-editing, .obj-drag-target, .dragging, .new-flash, .obj-dnd-just-dropped, .obj-remote-reorder.

**Input** — #msg-input, #send-btn, #clear-input, #clipboard-bubble, #draft-bubble, #log-action-btn, #log-dropup-panel.

**Modals** — #user-modal-backdrop, #user-modal; #channel-modal-backdrop, #channel-modal (#cm-name, #cm-self, #cm-others, #cm-create).

**Tabs** — .tab, data-channel, .tab-active, .tab-secondary-open, .tab-drop-target, .tab-badge.

**Body states** — body.loaded, body.select-mode, body.dnd-active, body.bar-dnd-mode.

---

## 10. State (globals)

Auth: currentUser, sb. Channel: currentChannel, channels, channelSubs, orderSub, viewSub, draftChannel. Order/prefs: currentMessageOrder (or currentObjectOrder), fieldPrefs { showTime, showAuthor }. Scroll: channelScroll (Map). Selection: selectMode, selectedIds. Edit: editingObjectId, editingObjectIds (Set), editingObjectTextMap { id → text }, originalEditTextForCancel(Map). DnD: lastReorderTarget, feedDropIndicatorEl, savedOrderBeforeDrag, dragDropHandled, touchDragState. UI: emptyEl, feedInner, feedEl, input, sendBtn, loaderMinUntil. Realtime feedback: suppressNextOrderApply, suppressNextViewApply, suppressOrderApplyUntil.

---

## 11. LocalStorage keys

CHANNELS_KEY, CURRENT_CHANNEL_KEY, INPUT_STATE_KEY, FIELD_PREFS_KEY, ORDER_STATE_KEY, SCROLL_STATE_KEY (or equivalent names with inout_ prefix and version suffix), WAS_EDITING_KEY, MULTIVIEW_SPLIT_KEY. See app.js for exact constants.

---

## 12. Styling

**:root** — --bg, --bg2, --line, --line2, --dim, --muted, --soft, --text, --bright, --acc, --acc2, --mono, --sans; --vv-top (JS). Colors: #0a0a09, #111110, #1e1e1c, #2a2a27, #3a3a36, #666660, #999990, #e2ddd4, #f0ece3, #e8d5a0, #b8a060. Fonts: DM Mono, Syne (Google Fonts). Breakpoint: 540px (mobile). DnD tokens: --dnd-nudge-duration, --dnd-spirit-fly-duration, --dnd-drop-line-color, etc. (see design-system/animations.md). .obj hover/selected/editing/dragging/drag-target in styling.md and components.md.

---

## 13. Security (RLS)

entries: SELECT where user_id=auth.uid() or (channel, auth.uid()) in channel_members; INSERT with user_id=auth.uid(), channel main or member; UPDATE/DELETE same as SELECT. channel_members: SELECT own + same-channel members; INSERT creator_id=auth.uid(), only owner can add others; DELETE own or owner. views, message_orders: user_id=auth.uid() only. Full SQL: documentation/security.md.

---

## 14. Edge cases

- No literal `</script>` in JS strings (escape or concat).
- Guard sb before Supabase calls (can be null).
- Realtime feedback: use suppressNextViewApply / suppressNextOrderApply / suppressOrderApplyUntil after upserting views/order.
- .obj-time and .obj-sender default display:none; JS shows from fieldPrefs (no flash).
- loadMessageOrder + loadFieldPrefs before loadMessages.
- Scroll: per-channel Map; debounce saveScrollState (~200ms).
- body.dnd-active on dragstart, remove on dragend; disables .obj:hover.
- WAS_EDITING_KEY: init clears input so no stale edit state.
- focusMessageInput: skip when focus on interactive (modal, button) to avoid stealing focus.
- Multiview/secondary: device-only (localStorage); findObjectRowEl searches both feed inners.

---

## 15. Design system (condensed)

**Components** — Header, nav (tabs), multiview (primary + optional secondary + resizer), manage bar, feed (rows .obj), input-area (composer, bubbles, tools), modals, toast, scroll btn. Row: time, sender, text (editable), checkbox, actions. See design-system/components.md.

**Modes** — Input (new object) vs Edit (existing; doppelganger). Select, DnD reorder, view menu, bar reorder, modals. See design-system/modes.md.

**Animations** — fast 0.1s, normal 0.2s; ease-out; anim-fade-in, anim-slide-up; DnD tokens and keyframes in design-system/animations.md. Remote reorder: .obj-remote-reorder staggered.

**Copy** — Placeholder "Say something…"; Send; Account, Sign in, Version, Nickname, Copy ID; New feed, Name, Create; Select, All, None, Delete, Move, Export, View ▾, Time, Author; "↓ new objects"; Paste, Dismiss, Copy, From clipboard, Log. design-system/text.md.

**DnD** — Payload: object ids. Feed: Y → insertBefore + line. Tab: .tab-drop-target, move channel. Realtime: dnd-{channel}, origin/target/ghost. design-system/dnd.md.

---

When changing behavior, update this file and the relevant deep-dive (architecture, ELEMENTS, styling, edge-cases, security, functions-index) or design-system file.
