# Functions index (for humans and AI)

One-line purpose of each function in `index.html`. Use to find the right function or see surface area. **When adding or changing a function, add or update its entry here.**

---

## Scroll and loader

| Function | Purpose |
|----------|---------|
| `loadScrollState()` | Read scroll positions from localStorage into channelScroll. |
| `saveScrollState()` | Write channelScroll to localStorage. |
| `clearEdgeScrollInterval()` | Stop edge-scroll timer. |
| `scrollFeedAtTouchEdge(clientY, clientX)` | Scroll feed when pointer near top/bottom edge (returns true if scrolled). |
| `tickEdgeScroll()` | One tick of edge scroll (calls scrollFeedAtTouchEdge). |
| `updateEdgeScroll(clientY, clientX)` | Start/stop edge-scroll interval from pointer position. |
| `ensureLoaderMinDisplay()` | Promise that resolves after loaderMinUntil (min 1.2s loader display). |
| `markLoaded()` | Add body.loaded, focus input. |
| `go()` | Entry: set loader min time, run init on DOM ready, then markLoaded. |

---

## Selection (drag-select and checkboxes)

| Function | Purpose |
|----------|---------|
| `applyDragSelectRect(feedInner, feedEl, startYContent, currentYClient, mode, startRowStates)` | Apply select/deselect to rows overlapping rect (content coords). |
| `toggleRowAtY(feedInner, clientY)` | Toggle checkbox of the row under clientY. |
| `setSelectMode(on)` | Set selectMode, update select toggle/extra, body.select-mode, manage-actions visibility. |
| `updateSelectionUI()` | Update delete/move/export enabled state; may turn on select mode if any selected. |

---

## Log and undo

| Function | Purpose |
|----------|---------|
| `logAction(action, details, opts)` | Push to actionLog, update badge, optionally insert into Supabase action_log. |
| `logError(message)` | Push error to actionLog, update badge, insert to action_log. |
| `getLastEventCaption()` | Return short caption for last log entry. |
| `updateLogBadge()` | Update log button badge text/count. |
| `renderLogDropup()` | Fill log dropup panel with actionLog entries. |
| `openLogDropup()` | Show log panel (classList add open). |
| `closeLogDropup()` | Hide log panel. |
| `pushUndo(action)` | Push action to undoStack. |
| `undoLastAction()` | Pop undo stack and revert (e.g. view prefs, order). |

---

## Editing and focus

| Function | Purpose |
|----------|---------|
| `updateEditingRowHighlight()` | Add/remove .msg-editing on row matching editingMessageId. |
| `cancelEditingMode(clearInput)` | Clear editingMessageId, remove msg-editing, restore placeholder. |
| `focusMessageInput()` | input.focus(). |
| `setupFocusOnFirstInteraction()` | Focus input on first tap/click outside modals. |

---

## Tabs and badges

| Function | Purpose |
|----------|---------|
| `updateTabBadge(ch)` | Set tab badge text and .show for channel ch from unreadCounts. |
| `updateAllTabBadges()` | Update badges for all channels. |
| `refreshMoveTargets()` | Populate move-target select with other channels. |
| `isNearBottom()` | True if feed scroll near bottom (for scroll btn). |
| `restoreLastChannel()` | Set currentChannel from localStorage. |
| `loadChannelsList()` | Load channels array from localStorage. |
| `saveChannelsList()` | Save channels to localStorage. |
| `loadMessageOrderForCurrentChannel()` | Load order (+ fieldPrefs from views) from Supabase or fallbacks. |
| `saveMessageOrderForCurrentChannel()` | Save currentMessageOrder to local + Supabase (message_orders + views). |
| `loadOrderFromLocal()` | Return order array from localStorage for current user+channel. |
| `saveOrderToLocal()` | Write currentMessageOrder to localStorage. |
| `hideEmpty()` | Remove emptyEl from DOM. |
| `updateMsgCount()` | Set msgCountEl text from msgCount. |
| `setupTabs()` | renderTabs(). |
| `updateTabsUI()` | Set .tab-active on current channel tab. |
| `renderTabs()` | Build tab buttons for each channel, wire click and drag. |

---

## Init and auth

| Function | Purpose |
|----------|---------|
| `init()` | Full startup: channels, scroll, auth, tabs, prefs, messages, realtime, presence, scroll restore. |
| `openUserModal()` | Show user modal. |
| `closeUserModal()` | Hide user modal. |
| `refreshAuth()` | getSession, set currentUser. |
| `setupAuthListener()` | onAuthStateChange: reload or clear. |
| `reloadForUser()` | Load order, fetch messages, replaceFeedWithList, subscribe realtime, restore scroll. |
| `clearMessages()` | Clear feed-inner, show empty, reset msgCount. |
| `signIn()` | signInWithOAuth Google. |
| `signOut()` | signOut. |
| `copyUserId()` | Copy currentUser.id to clipboard. |
| `cleanupAuthHash()` | Remove hash from URL after OAuth. |
| `setupFullscreenOnFirstTap()` | Request fullscreen on first tap (mobile). |
| `updateAuthUI()` | Update modal auth status and copy-ID UI. |
| `saveNickname()` | Save nickname to Supabase user metadata. |

---

## Feed and messages

| Function | Purpose |
|----------|---------|
| `fetchMessagesList()` | Supabase entries for currentChannel, sorted by currentMessageOrder. |
| `loadMessages()` | Fetch list, ensureLoaderMinDisplay, then renderInitialMessages if any. |
| `replaceFeedWithList(list)` | ensureLoaderMinDisplay, build rows, replace feed-inner content. |
| `subscribeRealtimeAll()` | Subscribe to entries INSERT/UPDATE per channel. |
| `updateMessageRowText(msgId, text)` | Update .msg-text for row with data-id. |
| `onUpdateForChannel(ch, row)` | Handle realtime UPDATE: update row text or cancel edit. |
| `subscribeOrderRealtime()` | message_orders changes → reload order, apply to DOM. |
| `subscribeViewRealtime()` | views changes → update order and/or fieldPrefs, apply. |
| `subscribeActionLog()` | action_log INSERTs (optional). |
| `onInsertForChannel(ch, msg)` | Handle realtime INSERT: append or reorder row. |
| `setupPresence()` | Presence channel for online count. |
| `setupDraftChannel()` | Realtime draft broadcast. |
| `teardownDraftChannel()` | Unsubscribe draft. |
| `broadcastDraft(text)` | Send draft to other devices. |
| `showDraftBubble(text)` | Show draft bubble. |
| `hideDraftBubble()` | Hide draft bubble. |
| `showClipboardBubble(text)` | Show clipboard paste bubble. |
| `hideClipboardBubble()` | Hide clipboard bubble. |
| `showEmptyIfNoMessages()` | Append emptyEl to feed-inner if no .msg. |
| `restoreInputGlobal()` | Restore input value from localStorage. |
| `saveInputGlobal()` | Save input value to localStorage. |
| `updateClearInputBtn()` | Enable/disable clear input button. |
| `applyFieldPrefsUI()` | Set #field-time and #field-author checked from fieldPrefs. |
| `loadFieldPrefsForCurrentChannel()` | Load view prefs from Supabase views or localStorage; apply to UI and messages. |
| `saveFieldPrefsForCurrentChannel()` | Save fieldPrefs to localStorage and Supabase views. |
| `applyFieldPrefsToMessages()` | Set .msg-time and .msg-sender display on all rows from fieldPrefs; applyFieldPrefsUI. |
| `setupTouchDragHandlers()` | One-time setup for touch long-press drag. |
| `createMsgRow(msg, isNew)` | Build one .msg row (time, sender, text, actions, checkbox); apply fieldPrefs. |
| `appendMsg(msg, isNew)` | createMsgRow and append to feed-inner; showEmptyIfNoMessages if needed. |
| `sortMessagesByOrder(list, order)` | Sort message list by order array (IDs). |
| `renderInitialMessages(list)` | hideEmpty, createMsgRow for each, append fragment. |
| `recomputeOrderFromDOM()` | Set currentMessageOrder from DOM .msg order. |
| `applyMessageOrderToDOM()` | Reorder .msg nodes to match currentMessageOrder. |
| `flipAnimateShift(...)` | No-op (was FLIP animation; disabled). |

---

## Channels and modals

| Function | Purpose |
|----------|---------|
| `switchChannel(ch)` | Save scroll, set currentChannel, load field prefs, reload or clear. |
| `openChannelModal()` | Show create-channel modal. |
| `closeChannelModal()` | Hide modal. |
| `createChannelFromModal()` | Create channel (name + members), save channels, renderTabs. |
| `deleteChannel(ch)` | Remove channel, clear members; if current, switch to main. |
| `ensureMembership()` | Ensure current user is in currentChannel (insert channel_members). |
| `syncChannelsFromServer()` | Load channel list from server (e.g. channel_members). |
| `refreshSharedFlags()` | Set sharedChannels from server. |

---

## Send and actions

| Function | Purpose |
|----------|---------|
| `send()` | Send input.value via sendText. |
| `sendText(text)` | Insert entry, clear input, update UI. |
| `deleteSingleMessage(id)` | Delete one entry; remove row. |
| `animateMessageToTab(rowEl, tabEl, onDone)` | Animate row flying to tab (move UX). |
| `moveSingleMessage(id, targetChannel)` | Update entry channel, optionally animate. |
| `exportSingleMessage(id)` | Export one message as file. |
| (Export all) | Handled in export button: fetch entries, build file, download. |

---

## DnD (reorder and drop indicator)

| Function | Purpose |
|----------|---------|
| `processFeedDragover(ev)` | Compute drop target; set .msg-drag-target on row; show feedDropIndicatorEl; insertBefore/appendChild dragging row. |

Event listeners (not listed above): feed dragover/drop/dragleave, document dragover (outside feed), row dragstart/dragend, tab dragover/dragleave/drop. Clean up .msg-drag-target and feedDropIndicatorEl on dragend/drop.

---

When you add or rename a function, add or update its row in the right section so humans and AI can find it.
