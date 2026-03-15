# Code reference — variables, functions, constants (app.js)

Short description of every top-level constant, variable, and function in the app. No classes (vanilla JS). Update this file when you add or rename any of these.

---

## Constants

### Config / API
| Name | Description |
|------|--------------|
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_ANON` | Supabase anon (publishable) key. |
| `STRIPE_PUBLISHABLE_KEY` | Stripe publishable key (optional). |
| `STRIPE_PRICE_ID` | Stripe price ID for subscription (optional). |

### LocalStorage keys
| Name | Description |
|------|--------------|
| `CHANNELS_KEY` | Custom channel list (no main). |
| `LEFT_CHANNELS_KEY` | Left-side tab order / state. |
| `CURRENT_CHANNEL_KEY` | Last active channel. |
| `SECONDARY_VIEW_KEY` | Channel open in second panel. |
| `MULTIVIEW_SPLIT_KEY` | Resizer split ratio (e.g. 0.5). |
| `INPUT_STATE_KEY` | Draft input text. |
| `FIELD_PREFS_KEY` | Per-channel showTime / showAuthor (and viewMode). |
| `ORDER_STATE_KEY` | Per user+channel order backup. |
| `SCROLL_STATE_KEY` | Per-channel scroll position. |
| `WAS_EDITING_KEY` | Set when in edit mode; init clears input if set. |
| `AUTH_BACKUP_KEY` | Backup auth user. |

### DOM refs (elements)
| Name | Description |
|------|--------------|
| `feedInner` | `#feed-inner` (primary feed content). |
| `feedEl` | `#feed` (scrollable feed container). |
| `inputArea` | `#input-area`. |
| `input` | `#object-input` (main textarea). |
| `sendBtn` | Send button. |
| `clearInputBtn` | Clear input button. |
| `emptyEl` | `#empty` (empty state node). |
| `scrollBtn` | Scroll-to-bottom button. |
| `ocNum` | Online count number element. |
| `objectCountEl` | Object count label. |
| `toastEl` | Toast container. |
| `userBtn` | Account button. |
| `umBackdrop`, `umClose`, `umAuthStatus`, `umAuthBtn`, `umUserId`, `umCopyIdBtn`, `umNickname`, `umNickSave`, `umVersionBadge`, `umUpgradeBtn` | User modal elements. |
| `tabsEl` | Tab strip container. |
| `clipboardBubble`, `clipboardBubbleTxt`, `clipboardPasteBtn`, `clipboardDismissBtn`, `clipboardButton` | Clipboard bubble elements. |
| `selectToggle`, `selectExtra`, `selectAllBtn`, `selectNoneBtn`, `manageActions` | Select mode bar. |
| `deleteSelectedBtn`, `moveSelectedBtn`, `moveTargetSelect`, `exportTabBtn` | Bulk action elements. |
| `fieldTimeChk`, `fieldAuthorChk`, `viewVisualSelect`, `viewToggleBtn`, `viewMenu` | View menu and field prefs. |
| `draftBubble`, `draftBubbleTxt`, `draftCopyBtn`, `draftSendBtn`, `draftClearBtn` | Draft bubble. |
| `cmBackdrop`, `cmName`, `cmSelf`, `cmOthers`, `cmCancel`, `cmCreate` | Channel modal. |
| `logActionBtn`, `logDropupPanel`, `logDropupBody` | Action log dropup. |

### Other constants
| Name | Description |
|------|--------------|
| `seenIds` | Set of object IDs already rendered (avoid duplicates). |
| `channelScroll` | Map channel → scrollTop. |
| `unreadCounts` | Map channel → unread count. |
| `sharedChannels` | Set of channel names that are shared. |
| `selectedIds` | Set of selected object IDs. |
| `TYPING_COMMIT_MS` | Ms before typing segment is committed (undo). |
| `MAX_TYPING_UNDO` | Max undo stack size for typing. |
| `formatTimeCacheMax` | Max entries in formatTime cache. |

---

## Variables (state)

### Backend / auth
| Name | Description |
|------|--------------|
| `sb` | Supabase client (or null). |
| `_oauthCallbackPromise` | Promise for OAuth code exchange. |
| `stripe` | Stripe instance or null. |
| `currentUser` | Signed-in user object or null. |

### Channel / feed
| Name | Description |
|------|--------------|
| `currentChannel` | Active channel name. |
| `channels` | Array of channel names (main first). |
| `secondaryViewChannel` | Channel in second panel, or null. |
| `channelSubs` | Map of realtime subscriptions per channel. |
| `orderSub` | Realtime subscription for message_orders. |
| `viewSub` | Realtime subscription for views. |
| `draftChannel` | Realtime channel for draft. |
| `currentObjectOrder` | Ordered array of object IDs for current channel. |
| `objectCount` | Number of objects in primary feed. |
| `leftChannels` | Set of channel names (left tabs). |
| `globalObjectNum` | Counter for object numbering. |

### UI / scroll
| Name | Description |
|------|--------------|
| `atBottom` | True if feed scrolled near bottom. |
| `presenceCh` | Presence channel. |
| `toastTimer` | Timeout id for toast hide. |
| `loaderMinUntil` | Timestamp until which loader must stay visible. |
| `fieldPrefs` | `{ showTime, showAuthor, viewMode }` for current channel. |
| `suppressNextOrderApply` | Skip next order realtime apply. |
| `suppressNextViewApply` | Skip next view realtime apply. |
| `suppressOrderApplyUntil` | Ignore order/view applies until this timestamp. |

### Selection
| Name | Description |
|------|--------------|
| `selectMode` | True when select mode is on. |
| `selectModeAutoOn` | Auto-enter select when first item selected. |
| `dragSelectActive`, `dragSelectStarted`, `dragSelectJustEnded`, `dragSelectToggledByTouch` | Drag-select state. |
| `dragSelectMode` | 'select' or 'deselect'. |
| `pointerDownOnSelectArea` | True when pointer down on checkbox zone (suppress row drag). |

### Edit
| Name | Description |
|------|--------------|
| `editingObjectId` | ID of object being edited, or null. |
| `editingObjectIds` | Set of IDs in multi-edit, or null. |
| `editingObjectTextMap` | Map id → draft text (multi-edit). |
| `originalEditTextForCancel` | Single-edit text for cancel. |
| `originalEditTextForCancelMap` | Map id → original text (multi-edit cancel). |
| `editTypingUndoStack`, `editTypingCommitTimer` | Typing undo and commit timer. |

### DnD (reorder)
| Name | Description |
|------|--------------|
| `edgeScrollIntervalId`, `edgeScrollLastY`, `edgeScrollLastX` | Edge-scroll during drag. |
| `dragImageEl` | Invisible 1×1 div for setDragImage. |
| `lastReorderTarget` | `{ insertBefore, wantAppend }` to avoid duplicate DOM moves. |
| `touchDragState` | Long-press drag state (mobile). |
| `dragDropHandled` | True when drop has been processed. |
| `savedOrderBeforeDrag` | Order before drag (for revert). |
| `dragSelectedRows` | Rows being dragged. |
| `originGhostRows`, `draggedRowsStored`, `originGhostsActive` | Origin ghost overlay state. |
| `lastDropInsertBefore`, `lastWantAppend` | Last drop target. |
| `originInsertBefore`, `dndOriginInsertBefore`, `dndOriginWantAppend`, `dndOriginLineY` | Origin line state. |
| `dndStackFormTimer` | Timer for stack-form animation. |
| `feedDropIndicatorEl` | Drop line element. |
| `feedDropOriginEl` | Origin line element. |
| `originContentTop`, `originContentHeight`, `originGhostOverlayEl` | Origin ghost geometry. |

### DnD realtime (remote)
| Name | Description |
|------|--------------|
| `dndBroadcastChannel` | BroadcastChannel for dnd-{channel}. |
| `dndChannelReady` | True when channel is ready. |
| `remoteDnd` | Current remote DnD payload. |
| `remoteDropOriginEl`, `remoteDropTargetEl`, `remoteGhostEl`, `remoteSpiritEl` | Remote DnD UI elements. |
| `dndBroadcastThrottle` | Throttle for broadcast. |
| `remoteDndScrollResize` | Listener for scroll/resize (update remote lines). |
| `applyRemoteDndLinesRetry` | Retry timeout for applying remote lines. |

### Draft / remote editing
| Name | Description |
|------|--------------|
| `latestRemoteDraft` | Last draft text from other device. |
| `latestClipboardText` | Clipboard text for paste bubble. |
| `lastRemoteEditingId` | ID showing remote doppelganger. |
| `savedTextForRemote` | Map id → text to restore when remote edit clears. |

### Multiview
| Name | Description |
|------|--------------|
| `secondaryViewEl` | Second panel container. |
| `secondaryFeedInner` | Second panel feed-inner. |
| `secondaryFeedEl` | Second panel feed scroll container. |
| `multiviewResizerEl` | Resizer element. |

### Log / undo
| Name | Description |
|------|--------------|
| `undoStack` | Undo action stack. |
| `actionLog` | Action log entries. |
| `actionLogSub` | Realtime sub for action_log. |
| `logErrorSignalTimer` | Timer for error badge fade. |
| `formatTimeCache` | Cache for formatTime results. |

### Device / identity
| Name | Description |
|------|--------------|
| `myId` | Random device/session id (e.g. crypto.randomUUID()). |

---

## Functions

### Scroll and loader
| Function | Description |
|----------|-------------|
| `loadScrollState()` | Read scroll positions from localStorage into channelScroll. |
| `saveScrollState()` | Write channelScroll to localStorage (debounced). |
| `clearEdgeScrollInterval()` | Stop edge-scroll timer. |
| `scrollFeedAtTouchEdge(clientY, clientX)` | Scroll feed when pointer near top/bottom edge; returns true if scrolled. |
| `tickEdgeScroll()` | One tick of edge scroll. |
| `updateEdgeScroll(clientY, clientX)` | Start/stop edge-scroll interval from pointer position. |
| `ensureLoaderMinDisplay()` | Promise that resolves after loaderMinUntil. |
| `markLoaded()` | Add body.loaded, focus input. |
| `go()` | Entry: set loader min time, run init on DOM ready, then markLoaded. |

### Selection
| Function | Description |
|----------|-------------|
| `applyDragSelectRect(feedInner, feedEl, startYContent, currentYClient, mode, startRowStates)` | Apply select/deselect to rows overlapping rect. |
| `toggleRowAtY(feedInner, clientY)` | Toggle checkbox of row under clientY. |
| `setSelectMode(on)` | Set selectMode, update toggle/extra, body.select-mode, manage-actions. |
| `updateSelectionUI()` | Update delete/move/export enabled; may turn on select mode. |

### Log and undo
| Function | Description |
|----------|-------------|
| `logAction(action, details, opts)` | Push to actionLog, update badge, optionally insert action_log. |
| `logError(message)` | Push error to actionLog, update badge, insert action_log. |
| `getLastEventCaption()` | Return short caption for last log entry. |
| `updateLogBadge()` | Update log button badge. |
| `renderLogDropup()` | Fill log dropup panel. |
| `openLogDropup()`, `closeLogDropup()` | Show/hide log panel. |
| `pushUndo(action)` | Push to undoStack. |
| `undoLastAction()` | Pop undo stack and revert. |

### Editing and focus
| Function | Description |
|----------|-------------|
| `updateEditingRowHighlight()` | Add/remove .obj-editing on row matching editingObjectId. |
| `restoreEditingRowsOnCancel()` | Restore all editing rows from originalEditTextForCancel(Map). |
| `reactivateInputMode(opts)` | Clear edit state, restore placeholder, focus input. |
| `cancelEditingMode(clearInput)` | Clear editingObjectId/editingObjectIds, restore rows, placeholder. |
| `focusMainInput()` | input.focus(). |
| `setupFocusOnFirstInteraction()` | Focus input on first tap/click outside modals. |
| `applyPrimaryEditToMultiEdit(newPrimary)` | Apply same single-char edit to all ids in editingObjectTextMap. |
| `updateEditingRowFromInput()` | Update doppelganger in each row from input value and selection. |
| `commitTypingSegment()` | Push current input to editTypingUndoStack. |

### Origin ghost / line (DnD)
| Function | Description |
|----------|-------------|
| `getDraggingRowAndSource()` | Return { rowEl, feedInner, isSecondary } for current drag. |
| `updateOriginLinePosition()` | Reposition origin line on scroll/resize. |
| `showDropOriginLine()`, `hideDropOriginLine()` | Show/hide origin line. |
| `showOriginGhostOverlay(block)` | Show ghost overlay for dragged block. |
| `removeOriginGhostOverlay()` | Remove ghost overlay. |
| `createOriginGhostFromRow(row)` | Create ghost element from row. |
| `insertOriginGhostsAndDetachRows(block)` | Insert ghosts, detach rows. |
| `removeOriginGhostsAndInsertRows()` | Remove ghosts, re-insert rows. |

### Tabs and badges
| Function | Description |
|----------|-------------|
| `updateTabBadge(ch)` | Set tab badge text and .show for channel. |
| `updateAllTabBadges()` | Update badges for all channels. |
| `refreshMoveTargets()` | Populate move-target select. |
| `isNearBottom()` | True if feed scroll near bottom. |
| `restoreLastChannel()` | Set currentChannel from localStorage. |
| `loadChannelsList()` | Load channels from localStorage. |
| `saveChannelsList()` | Save channels to localStorage. |
| `loadObjectOrderForCurrentChannel()` | Load order and fieldPrefs from views/message_orders/local. |
| `saveObjectOrderForCurrentChannel()` | Save currentObjectOrder to local + message_orders + views. |
| `loadOrderFromLocal()` | Return order array from localStorage. |
| `saveOrderToLocal()` | Write currentObjectOrder to localStorage. |
| `recomputeOrderFromDOM()` | Set currentObjectOrder from DOM .obj order. |
| `applyObjectOrderToDOM()` | Reorder .obj nodes to match currentObjectOrder. |

### Init and modals
| Function | Description |
|----------|-------------|
| `init(done)` | Full startup: channels, scroll, auth, tabs, prefs, messages, realtime, presence, scroll restore. |
| `openUserModal()`, `closeUserModal()` | Show/hide user modal. |
| `openChannelModal()`, `closeChannelModal()` | Show/hide channel modal. |

### Auth
| Function | Description |
|----------|-------------|
| `refreshAuth()` | getSession, set currentUser. |
| `setupAuthListener()` | onAuthStateChange: reload or clear. |
| `reloadForUser()` | Load order, fetch objects, replaceFeedWithList, subscribe realtime, restore scroll. |
| `clearObjects()` | Clear feed-inner, show empty, reset objectCount. |
| `signIn()` | signInWithOAuth Google. |
| `signOut()` | signOut. |
| `copyUserId()` | Copy currentUser.id to clipboard. |
| `cleanupAuthHash()` | Remove hash from URL after OAuth. |
| `setupFullscreenOnFirstTap()` | Request fullscreen on first tap (mobile). |
| `updateAuthUI()` | Update modal auth status and copy-ID UI. |
| `saveNickname()` | Save nickname to Supabase user metadata. |
| `ensureOAuthCallbackProcessed()` | Wait for OAuth code exchange. |
| `ensureMembership()` | Ensure current user in currentChannel (insert channel_members). |

### Load and feed
| Function | Description |
|----------|-------------|
| `fetchObjectsList()` | Supabase entries for currentChannel, sorted by currentObjectOrder. |
| `fetchObjectsListForChannel(ch)` | Entries for given channel. |
| `loadObjects()` | Fetch list, ensureLoaderMinDisplay, then renderInitialObjects if any. |
| `replaceFeedWithList(list)` | ensureLoaderMinDisplay, build rows, replace feed-inner. |
| `replaceFeedWithListInto(list, targetFeedInner)` | Render list into given feed-inner (e.g. secondary). |
| `renderInitialObjects(list)` | hideEmpty, createObjectRow for each, append fragment. |
| `sortObjectsByOrder(list, order)` | Sort list by order array (IDs). |
| `hideEmptyInFeed(feedInnerEl)` | Remove empty state from feed. |
| `showEmptyIfNoObjects()` | Append emptyEl to feed-inner if no .obj. |

### Realtime
| Function | Description |
|----------|-------------|
| `subscribeRealtimeAll()` | Subscribe to entries INSERT/UPDATE per channel. |
| `updateObjectRowText(objId, textValue)` | Update .obj-text for row (primary or secondary feed). |
| `findObjectRowTextEl(objId)` | Return .obj-text element for id (either feed). |
| `findObjectRowEl(objId)` | Return .obj row element for id (either feed). |
| `onUpdateForChannel(ch, row)` | Handle realtime UPDATE: update row text or clear remote doppelganger. |
| `onInsertForChannel(ch, msg)` | Handle realtime INSERT: append or reorder row (primary or secondary). |
| `subscribeOrderRealtime()` | message_orders changes → reload order, apply DOM. |
| `subscribeViewRealtime()` | views changes → update order/fieldPrefs, apply. |
| `subscribeActionLog()` | action_log INSERTs (optional). |

### Presence and draft
| Function | Description |
|----------|-------------|
| `setupPresence()` | Presence channel for online count. |
| `setupDraftChannel()` | Realtime draft broadcast. |
| `teardownDraftChannel()` | Unsubscribe draft. |
| `broadcastDraft(text)` | Send draft to other devices. |
| `showRemoteEditingDoppelganger(objId, text, authorName, deviceId)` | Show remote edit badge and doppelganger. |
| `clearRemoteEditingDoppelganger(objId, skipRestore)` | Clear remote doppelganger, optionally restore text. |
| `showDraftBubble(text)` | Show draft bubble. |
| `hideDraftBubble()` | Hide draft bubble. |
| `showClipboardBubble(text)` | Show clipboard paste bubble. |
| `hideClipboardBubble()` | Hide clipboard bubble. |

### DnD broadcast (realtime)
| Function | Description |
|----------|-------------|
| `getLineRectForInsert(feedEl, feedInner, insertBeforeId, wantAppend)` | Return rect for drop line. |
| `getLineRectForOrigin(feedEl, feedInner, lastDraggedId, wantAppend)` | Return rect for origin line. |
| `setupDndBroadcastChannel()` | Create BroadcastChannel, subscribe to dnd-{channel}. |
| `teardownDndBroadcastChannel()` | Close channel, hide remote lines. |
| `applyRemoteDndLines()` | Position remote origin/target/ghost/spirit from remoteDnd. |
| `hideRemoteDndLines()` | Hide remote DnD UI. |
| `broadcastDndStart()` | Send dnd_start (origin, draggingIds). |
| `broadcastDndMove()` | Send dnd_move (target). |
| `broadcastDndEnd()` | Send dnd_end. |
| `broadcastDndDropped(newOrder, movedIds)` | Send dnd_dropped. |

### Multiview
| Function | Description |
|----------|-------------|
| `saveSecondaryViewState()` | Persist secondary channel and split to localStorage. |
| `restoreSecondaryView()` | Restore second panel from localStorage. |
| `setupSecondaryFeedDnd()` | DnD handlers for secondary feed. |
| `closeSecondaryView()` | Close second panel. |
| `applyMultiviewSplit(ratio)` | Set --multiview-split, save to localStorage. |
| `setupMultiviewResizer(resizerEl, panelsEl)` | Draggable resizer. |
| `openSecondaryView(ch)` | Open channel ch in second panel. |
| `toggleSecondaryView(ch)` | Open ch in second or close if already open. |

### Input and field prefs
| Function | Description |
|----------|-------------|
| `restoreInputGlobal()` | Restore input value from localStorage. |
| `saveInputGlobal()` | Save input value to localStorage. |
| `updateClearInputBtn()` | Enable/disable clear input button. |
| `applyFieldPrefsUI()` | Set #field-time and #field-author checked from fieldPrefs. |
| `loadFieldPrefsForCurrentChannel()` | Load view prefs from Supabase or localStorage; apply. |
| `saveFieldPrefsForCurrentChannel()` | Save fieldPrefs to localStorage and Supabase views. |
| `applyFieldPrefsToObjects()` | Set .obj-time and .obj-sender display; applyFieldPrefsUI. |

### Render
| Function | Description |
|----------|-------------|
| `createObjectHeaderRow()` | Table header row (Time, Author, Value, Actions). |
| `createObjectRow(obj, isNew, options)` | Build one .obj row (time, sender, text, actions, checkbox). |
| `appendMsg(msg, isNew)` | createObjectRow and append; showEmptyIfNoMessages if needed. |
| `setupTouchDragHandlers()` | One-time setup for touch long-press drag. |

### Channels
| Function | Description |
|----------|-------------|
| `switchChannel(ch)` | Save scroll, set currentChannel, load prefs, reload or clear. |
| `createChannelFromModal()` | Create channel (name + members), save channels, renderTabs. |
| `deleteChannel(ch)` | Remove channel; if current, switch to main. |
| `syncChannelsFromServer()` | Load channel list from server. |
| `refreshSharedFlags()` | Set sharedChannels from server. |

### Send and actions
| Function | Description |
|----------|-------------|
| `send()` | Send input.value via sendText. |
| `sendText(text)` | Insert or update entry, clear input, update UI. |
| `deleteSingleObject(id)` | Delete one entry, remove row. |
| `moveSingleObject(id, targetChannel)` | Update entry channel, optionally animate. |
| `exportSingleObject(id)` | Export one object as file. |
| `animateObjectToTab(rowEl, tabEl, onDone)` | Animate row flying to tab. |
| `animateObjectToView(rowEl, targetFeedEl, onDone)` | Animate row flying to feed (e.g. secondary). |

### DnD (feed reorder)
| Function | Description |
|----------|-------------|
| `processFeedDragover(ev)` | Compute drop target; set .obj-drag-target; show feedDropIndicatorEl; insertBefore/appendChild. |

### Utils
| Function | Description |
|----------|-------------|
| `formatTime(iso)` | Format ISO date as time string (cached). |
| `escapeHtml(s)` | Escape &, <, >, ". |
| `linkify(s)` | Wrap URLs in <a> tags. |
| `toast(msg, dur)` | Show toast; clear previous timer. |
| `humanError(message)` | Map error message to user-friendly string. |

### IIFEs (run at load)
| Name | Description |
|------|-------------|
| `runCodeExchange()` | Exchange OAuth code for session if ?code= in URL. |
| `attachAuthButtonEarly()` | Wire um-auth-btn to signIn. |
| `setupVisualViewportPinning()` | Set --vv-top from visualViewport. |
| `ensureModalsClosedOnLoad()` | Hide modals on load. |
| `setupProfileAndModalsEarly()` | Wire user-btn and user modal open/close. |
| `initBarReorder()` | Bar reorder DnD (⋯ button). |
| `go()` | Set loaderMinUntil, run init on DOM ready, markLoaded. |
| `profileButtonFallback()` | Fallback user modal / sign-in if sb not yet global. |

---

When you add or rename a variable, constant, or function, add or update its entry here (and in functions-index.md for functions).
