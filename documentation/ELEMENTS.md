# INOUT — Objects, elements, conditions, and functions

Reference for humans and AI: which DOM elements and JS objects exist, under what conditions they apply, and which functions read or set them. All code lives in `index.html`.

---

## 1. Body / document state

| State | When set | Cleared when | Functions that set it | Effect (CSS) |
|-------|----------|--------------|------------------------|--------------|
| `body.loaded` | After init completes (or 4s timeout) | Never removed | `markLoaded()` | Hides `#app-loader` (splash). Not used to show/hide `#app` in current code. |
| `body.select-mode` | User turns on Select mode | User turns off Select | `setSelectMode(true)` / `setSelectMode(false)` | Checkbox zones visible on rows; manage bar actions visible; `.msg-select-wrap` visible. |
| `body.dnd-active` | Drag starts (mouse or touch long-press) | Drag ends | Row `dragstart` adds; row `dragend` / touch end remove | Disables `.msg:hover` styling so rows don’t blink during reorder. |

---

## 2. DOM elements by ID (and what controls them)

### App shell

| ID | Purpose | Conditions / visibility | Functions that mutate or read |
|----|---------|-------------------------|--------------------------------|
| `#app` | Main app container (header, manage bar, feed, input) | Always visible after load | — |
| `#app-loader` | Full-screen splash (loader animation) | `display:none` in CSS; not used as visible splash in current flow | — |
| `#feed` | Scrollable message list container | — | Scroll listener: updates `channelScroll`, `atBottom`, scroll btn. `scrollBottom()`, scroll restore in init/reloadForUser. |
| `#feed-inner` | Wrapper for message rows and `#empty` | — | `replaceFeedWithList()`, `renderInitialMessages()`, `applyMessageOrderToDOM()`, `showEmptyIfNoMessages()` append/clear children. |
| `#empty` | Empty state (loader + “Nothing yet.”) | Shown when feed has no `.msg` children; removed when any message is added | `showEmptyIfNoMessages()` appends to feed-inner; `createMsgRow()` / `replaceFeedWithList()` remove when adding rows. |
| `#manage-bar` | Select / Delete / Move / Export / View bar | — | `setSelectMode()` toggles visibility of `#manage-actions`. |
| `#input-area` | Tabs + input + tools | — | — |

### Header and counts

| ID | Purpose | Conditions | Functions |
|----|---------|------------|-----------|
| `#online-count`, `#oc-num` | Presence count | — | Presence subscription updates `ocNum.textContent`. |
| `#msg-count` | Message count label | — | `updateMsgCount()`, `msgCountEl.textContent = ...`. |
| `#user-btn` | Account button | — | Opens user modal. |

### Input and send

| ID | Purpose | Conditions | Functions |
|----|---------|------------|-----------|
| `#msg-input` | Message textarea | — | `input.value`, `autoResize()`, `sendBtn.disabled` tied to content; `saveInputGlobal()` / restore; focus helpers. |
| `#clear-input` | Clear textarea button | — | `updateClearInputBtn()` toggles disabled. |
| `#send-btn` | Send message button | — | Disabled when input empty; click sends via Supabase `entries.insert`. |
| `#tabs` | Channel tab strip | — | `renderTabs()` fills; tab click calls `switchChannel(ch)`. |

### Select mode and view

| ID | Purpose | Conditions | Functions |
|----|---------|------------|-----------|
| `#select-toggle` | Toggle Select mode | — | `setSelectMode()`; `selectToggle.classList.toggle('active', selectMode)`. |
| `#select-extra` | All / None buttons wrapper | — | `selectExtra.classList.toggle('show', selectMode)`. |
| `#select-all`, `#select-none` | Select all / none | — | Update `selectedIds` and row `.msg-selected` / checkbox. |
| `#delete-selected`, `#move-target`, `#move-selected`, `#export-tab` | Bulk actions | — | Delete/move/export selected message IDs. |
| `#view-toggle`, `#view-menu` | View dropdown | — | Toggle menu open. |
| `#field-time`, `#field-author` | Time/Author checkboxes | — | `loadFieldPrefsForCurrentChannel()`, `applyFieldPrefsUI()` set checked; change handlers call `saveFieldPrefsForCurrentChannel()`. |

### Modals and bubbles

| ID | Purpose | Conditions | Functions |
|----|---------|------------|-----------|
| `#user-modal-backdrop`, `#user-modal` | Account modal | `umBackdrop.style.display` | `openUserModal()`, `closeUserModal()`. |
| `#channel-modal-backdrop`, `#channel-modal`, `#cm-name`, `#cm-self`, `#cm-others`, `#cm-cancel`, `#cm-create` | Create/ share channel modal | `cmBackdrop.style.display` | `openChannelModal()`, `closeChannelModal()`, `createChannelFromModal()`. |
| `#clipboard-bubble`, `#clipboard-bubble-text`, `#clipboard-paste`, `#clipboard-dismiss`, `#clipboard-button` | Paste-from-clipboard UI | Shown when clipboard has content and matches draft logic | — |
| `#draft-bubble`, `#draft-bubble-text`, `#draft-copy`, `#draft-send`, `#draft-clear` | Remote draft from other device | Shown when realtime draft received | — |
| `#log-action-btn`, `#log-dropup-panel`, `#log-dropup-body` | Action log dropdown | `logDropupPanel.classList.add/remove('open')` | `openLogDropup()`, `closeLogDropup()`; error state: `logActionBtn.classList.add('error-signal'|'error-signal-faded')`. |

### Other

| ID | Purpose | Conditions | Functions |
|----|---------|------------|-----------|
| `#scroll-btn` | “↓ new messages” button | Visible when not at bottom | `scrollBtn.classList.add/remove('visible')` from scroll handler and `scrollBottom()`. |
| `#toast` | Toast message | `toastEl.classList.add('show')` with timeout then remove | `toast(msg, dur)`. |

---

## 3. Dynamically created or key class-based elements

### Feed drop indicator (no ID)

| What | Purpose | Conditions | Functions |
|------|---------|------------|-----------|
| `feedDropIndicatorEl` (div.feed-drop-indicator) | Line showing drop position during DnD reorder | Created on first need; `.visible` when cursor over feed with valid drop target | `processFeedDragover()` sets position and adds `visible`; `dragend` / `drop` / `dragleave` remove `visible`. |

### Message rows (`.msg`)

| Class or attribute | When added | When removed | Set by / effect |
|--------------------|------------|--------------|------------------|
| `.msg` | Every message row | — | `createMsgRow()`. |
| `data-id` | Row created | — | Entry `id`; used for order, selection, delete/move. |
| `.msg-selected` | Checkbox checked or drag-select over row | Checkbox unchecked, select-none, or drop | Selection state; `selectedIds` sync. |
| `.msg-editing` | User clicks row to edit | Cancel or send | One row at a time; `editingMessageId`; input shows message text. |
| `.msg.dragging` | Drag started (mouse or touch) | Drag ended | Row is being reordered; opacity 0.35. |
| `.msg-drag-target` | Cursor over feed at drop position; this row is the target | Cursor leaves or drop | `processFeedDragover()`; content (time, sender, text) shifts 30px right. |
| `.msg-drag-over` | (Legacy; currently only removed, not added) | dragend / drop / dragleave | — |
| `.new-flash` | New message inserted (realtime) | After 800ms | `setTimeout(… remove, 800)`. |

### Message row children (classes)

| Class | Purpose | Visibility / conditions | Functions |
|-------|---------|--------------------------|-----------|
| `.msg-time` | Timestamp | `fieldPrefs.showTime`; in createMsgRow and `applyFieldPrefsToMessages()` | `formatTime()`; display toggled by view prefs. |
| `.msg-sender` | Author name | Main feed always hidden; other channels by `fieldPrefs.showAuthor` | Same apply logic. |
| `.msg-text` | Message body | Always visible | Linkify; click to edit. |
| `.msg-actions` | Del / Move / Exp / Copy | Visible on hover (or when `body.dnd-active` disabled); always in `.msg-editing` | — |
| `.msg-select-wrap`, `.msg-select` | Checkbox for selection | Visible in select mode or on hover; `.msg-select-wrap` opacity 0 by default | `setSelectMode()`; checkbox change updates `selectedIds`. |
| `.msg-checkbox-zone` | Wrapper for checkbox (touch/click target) | Same as select-wrap | Drag-select logic. |

### Tabs (`.tab`)

| Class or attribute | When added | When removed | Set by / effect |
|--------------------|------------|--------------|------------------|
| `.tab` | Each channel tab | — | `renderTabs()`. |
| `data-channel` | Channel name | — | `switchChannel(ch)` on click. |
| `.tab-active` | Current channel | Channel switch | `updateTabsUI()`. |
| `.tab-drop-target` | Dragging message over tab for move | dragleave / drop | Tab dragover/dragleave. |
| `.tab-badge` | Unread count | — | `updateTabBadge(ch)` adds `.show` when count > 0. |

---

## 4. Global JS state (objects and variables)

### Auth and user

| Variable | Type | Meaning | Set by / read by |
|----------|------|---------|-------------------|
| `currentUser` | object \| null | Signed-in user (Supabase auth) | `refreshAuth()`, auth state listener; used for RLS, views, order, draft. |
| `sb` | Supabase client | Supabase client (or null if init fails) | Created once at script top; all Supabase calls use it. |

### Channel and feed

| Variable | Type | Meaning | Set by / read by |
|----------|------|---------|-------------------|
| `currentChannel` | string | Active tab channel name | `switchChannel(ch)`; `restoreLastChannel()`; load/save from localStorage. |
| `channels` | string[] | List of channel names (main first) | `loadChannelsList()`; `createChannelFromModal()`; `deleteChannel()`. |
| `currentMessageOrder` | number[] | Ordered entry IDs for current channel | `loadMessageOrderForCurrentChannel()`; `applyMessageOrderToDOM()`; `recomputeOrderFromDOM()`; `saveMessageOrderForCurrentChannel()`. |
| `channelScroll` | Map<string, number> | Per-channel scroll position | Scroll listener; `loadScrollState()`; `saveScrollState()`; `switchChannel()` saves; init/reloadForUser restore. |
| `channelSubs` | Map | Realtime subscriptions per channel | `subscribeRealtimeAll()`; unsubscribe on channel switch. |
| `viewSub`, `orderSub` | Realtime subscription | Views and order sync | `subscribeViewRealtime()`, `subscribeOrderRealtime()`. |

### View preferences (Time / Author)

| Variable | Type | Meaning | Set by / read by |
|----------|------|---------|-------------------|
| `fieldPrefs` | `{ showTime, showAuthor }` | Per-channel view settings | `loadFieldPrefsForCurrentChannel()` (from Supabase or localStorage); `saveFieldPrefsForCurrentChannel()`; checkbox handlers; `applyFieldPrefsToMessages()`, `createMsgRow()` use for visibility. |

### Selection

| Variable | Type | Meaning | Set by / read by |
|----------|------|---------|-------------------|
| `selectedIds` | Set<number> | Selected message IDs | Checkbox and drag-select; select-all/none; delete/move/export. |
| `selectMode` | boolean | Select mode on/off | `setSelectMode(on)`; `updateSelectionUI()` may turn on if any selected. |
| `selectModeAutoOn` | boolean | Auto-enter select when first item selected | — |
| `dragSelectActive`, `dragSelectStarted`, `dragSelectJustEnded`, `dragSelectToggledByTouch` | booleans | Drag-select state (prevent accidental toggle) | Checkbox-zone and row drag-select handlers. |
| `pointerDownOnSelectArea` | boolean | Mousedown on checkbox zone (suppress drag) | Checkbox zone mousedown/touch. |

### DnD reorder

| Variable | Type | Meaning | Set by / read by |
|----------|------|---------|-------------------|
| `dragImageEl` | element \| null | Invisible 1×1 div for setDragImage | Created on first dragstart. |
| `lastReorderTarget` | object \| null | { insertBefore, wantAppend } to avoid duplicate DOM moves | `processFeedDragover()`. |
| `feedDragoverRaf`, `feedDragoverLast` | RAF throttle | Throttle dragover processing | Feed dragover listener. |
| `savedOrderBeforeDrag`, `dragDropHandled` | array, boolean | For revert or commit on dragend | dragstart/dragend. |
| `touchDragState` | object | Long-press drag on mobile | `setupTouchDragHandlers()`. |

### Edge scroll and loader

| Variable | Type | Meaning | Set by / read by |
|----------|------|---------|-------------------|
| `edgeScrollIntervalId`, `edgeScrollLastY`, `edgeScrollLastX` | number | Edge-scroll during drag | `scrollFeedAtTouchEdge()`, `updateEdgeScroll()`, `clearEdgeScrollInterval()`. |
| `loaderMinUntil` | number | Timestamp until which loader must stay visible | Set in `go()`; `ensureLoaderMinDisplay()` waits. |

### Other

| Variable | Type | Meaning | Set by / read by |
|----------|------|---------|-------------------|
| `msgCount` | number | Number of messages in feed | `replaceFeedWithList()`, `renderInitialMessages()`, `createMsgRow()` (emptyEl remove). |
| `atBottom` | boolean | Feed scrolled to bottom | Scroll listener, `scrollBottom()`, `isNearBottom()`. |
| `emptyEl` | element | Reference to `#empty` | `showEmptyIfNoMessages()`, `createMsgRow()`. |
| `feedInner`, `feedEl` | elements | References to `#feed-inner`, `#feed` | All feed DOM updates. |
| `seenIds` | Set | Message IDs already rendered (avoid duplicates) | `createMsgRow()`; cleared in `replaceFeedWithList()`. |
| `editingMessageId` | number \| null | Row being edited | Click row to edit; cancel/send clear. |
| `suppressNextOrderApply`, `suppressNextViewApply`, `suppressOrderApplyUntil` | boolean, number | Avoid feedback loops from realtime | Order/view save and subscribe. |

---

## 5. LocalStorage keys (conditions and functions)

| Key constant | Stored value | Read by | Written by |
|--------------|--------------|---------|------------|
| `CHANNELS_KEY` ('inout_channels_v1') | Custom channel names (no main) | `loadChannelsList()` | `saveChannelsList()` |
| `CURRENT_CHANNEL_KEY` | Current channel name | `restoreLastChannel()` | `switchChannel()` |
| `INPUT_STATE_KEY` | Draft input text | Restore on init | `saveInputGlobal()` |
| `FIELD_PREFS_KEY` | `{ [channel]: { showTime, showAuthor } }` | `loadFieldPrefsForCurrentChannel()` (fallback) | `saveFieldPrefsForCurrentChannel()` |
| `ORDER_STATE_KEY` | `{ [user+channel]: order[] }` | `loadOrderFromLocal()` | `saveOrderToLocal()` |
| `SCROLL_STATE_KEY` | `{ [channel]: scrollTop }` | `loadScrollState()` | `saveScrollState()` (debounced on scroll) |
| `WAS_EDITING_KEY` | '1' when editing | Init clears and clears input | Set when entering edit mode |

---

## 6. Key functions that affect multiple elements or state

| Function | What it does (elements / state) |
|----------|----------------------------------|
| `init()` | Loads channels, scroll, auth, tabs, view prefs, messages; restores scroll; calls `markLoaded()`. |
| `loadFieldPrefsForCurrentChannel()` | Fetches view from Supabase (or localStorage); sets `fieldPrefs`; updates `#field-time`, `#field-author`; calls `applyFieldPrefsToMessages()`. |
| `applyFieldPrefsToMessages()` | For each `.msg`: sets `.msg-time` and `.msg-sender` display from `fieldPrefs`; calls `applyFieldPrefsUI()`. |
| `applyFieldPrefsUI()` | Sets `#field-time`.checked and `#field-author`.checked (and author disabled on main) from `fieldPrefs`. |
| `setSelectMode(on)` | Sets `selectMode`; toggles `#select-toggle.active`, `#select-extra.show`, `body.select-mode`, `#manage-actions.visible`. |
| `updateSelectionUI()` | Enables/disables delete/move/export; may call `setSelectMode(true)` if any selected. |
| `showEmptyIfNoMessages()` | If no `.msg` in feed-inner, appends `emptyEl` to feed-inner (with fadin if re-added). |
| `processFeedDragover(ev)` | Computes drop target; adds `.msg-drag-target` to target row; shows `feedDropIndicatorEl`; may move dragging row (insertBefore/appendChild). |
| `markLoaded()` | Adds `body.loaded`; focuses input. |

---

## 7. Supabase tables and client usage (summary)

- **entries**: select (feed), insert (send), update (edit), delete. Realtime INSERT/UPDATE per channel.
- **channel_members**: select (who can see channel), insert (share). Used for RLS and sharing UI.
- **views**: select (order + showTime/showAuthor), upsert (save order and view prefs). Realtime for cross-device.
- **message_orders**: optional legacy order; fallback in `loadMessageOrderForCurrentChannel()`.
- **action_log**: optional insert for logging (e.g. view changes).

All access is via `sb` (Supabase client). RLS enforces: entries visible if user is sender or in `channel_members`; views and order by `user_id`.
