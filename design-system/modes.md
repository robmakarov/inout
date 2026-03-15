# Modes

UI and interaction modes. How they are toggled, what they affect, and the classes/state involved.

---

## 1. Select mode (manage / multi-select)

**Purpose:** Let the user select multiple messages for Delete, Move, Export.

**Toggle:**
- **On:** Click "Select" (#select-toggle) or when a message is selected while not in select mode (auto-on).
- **Off:** Click "Select" again when it’s active, or when selection becomes empty and it was auto-on.

**State:**
- `selectMode` (boolean) in JS.
- **#select-toggle** has class `.active` when on.
- **.select-extra** (All / None) has class `.show` when on.
- **#manage-actions** gets `.visible` when on (Delete, Move, Export, View).
- **body** has class **.select-mode** when on.

**Effects:**
- In **body.select-mode**: message checkboxes (`.msg-checkbox-zone`, `.msg-select-wrap`) are shown and usable; on mobile they’re hidden until select mode.
- Messages can be selected (`.msg-selected`); drag-select rectangle can add/remove selection (mode `'select'` or `'deselect'` from checkbox state).

**Exit:** setSelectMode(false); selection cleared on All/None, Delete, Move, Export, or when switching channel.

---

## 2. Edit mode (single-message editing)

**Purpose:** User is editing one message’s text in the main input; Send/UI reflect “editing” not “new message”.

**Toggle:**
- **On:** Click “Edit” on a message (msg-action) → `editingMessageId = msg.id`, input populated, placeholder/UI updated.
- **Off:** Cancel (clear input / blur), or Send (submit edit), or undo that restores pre-edit state.

**State:**
- `editingMessageId` (id or null) in JS.
- The row for that message has class **.msg-editing** (only one at a time).

**Effects:**
- **.msg-editing** row: time/sender visible, checkbox zone and msg-actions visible (opacity/pointer-events).
- Input shows the message text; Send submits edit; “Cancel” or equivalent clears editing.

**Exit:** cancelEditingMode() or after successful edit; editingMessageId = null, .msg-editing removed from all rows.

---

## 3. DnD mode (drag and drop)

**Purpose:** Reorder messages in the feed or drag messages to a tab (move to another channel).

**Toggle:**
- **On:** User starts a drag on a message row (dragstart or long-press touch) → body gets **.dnd-active**, row gets **.dragging**; optional **.msg-drag-group** and **.dragging-in-feed** for multi-select drag.
- **Off:** dragend (drop or cancel): body loses .dnd-active, rows lose .dragging / .msg-drag-group / .dragging-in-feed; optionally **.dnd-just-ended** on body briefly.

**State:**
- **body.dnd-active** when any message is being dragged.
- **.msg.dragging** — the row(s) being dragged (spirit/clone shown; origin can show ghosts).
- **.msg.msg-drag-group** — additional rows in a multi-selection drag.
- **.msg.dragging-in-feed** — rows that stay in feed as placeholders during drag.
- **.msg.msg-drag-target** / **.msg-drag-nudge-right** — drop target highlight in feed.
- **.tab.tab-drop-target** — tab is a drop target for moving to channel.
- **.feed-drop-indicator.visible** — line indicator for reorder position.
- Origin ghost overlay / **.msg-origin-ghost** — optional placeholder at original position.

**Animations (tokens in animations.md):**
- All DnD timings and visuals use **:root** tokens: --dnd-nudge-duration, --dnd-nudge-offset, --dnd-indicator-duration, --dnd-spirit-fly-duration, --dnd-spirit-fade-duration, --dnd-drop-line-color, --dnd-target-bg, --dnd-idle-opacity, --dnd-placeholder-opacity, --dnd-ghost-opacity, --dnd-spirit-shadow, --dnd-spirit-radius.
- During DnD, .msg has no transition/animation except .msg-drag-nudge-right (nudge), so the drop line and layout don’t jump. Spirit and fly-clone use the DnD duration tokens.

**Effects:**
- Under body.dnd-active: non-dragging rows use --dnd-idle-opacity and no transition; target row uses --dnd-target-bg and nudge; dragging/drag-group rows have transparent bg and hidden checkboxes/actions.
- Touch: long-press (~300 ms) on a row starts drag (same DnD state).

**Exit:** On dragend, all DnD classes cleared, order saved or move-to-tab applied.

---

## 4. View menu (dropdown open)

**Purpose:** Per-channel view options: show/hide Time, Author.

**Toggle:**
- **On:** Click “View ▾” (#view-toggle) → **#view-menu** gets class **.open**.
- **Off:** Click outside (#view-menu, #view-toggle) or choose option; .open removed.

**State:**
- **#view-menu.open** — dropdown visible.
- **fieldPrefs** in JS: `{ showTime, showAuthor }` per channel; checkboxes #field-time, #field-author reflect and update them.

**Effects:**
- View menu is visible; checkbox changes update fieldPrefs and apply to message rows (time/sender visibility).
- Clicks inside the menu don’t close it (stopPropagation).

**Exit:** Outside click or after changing options; view menu .open removed.

---

## 5. Log dropup (action log panel)

**Purpose:** Show action log in a dropup panel.

**Toggle:**
- **On:** Click “Log” (#log-action-btn) → **#log-dropup-panel** gets class **.open**.
- **Off:** Click outside panel (and not on #log-action-btn), or Escape, or when focus leaves → .open removed.

**State:**
- **#log-dropup-panel.open** — panel visible.

**Effects:**
- Panel shows log entries; closeLogDropup() removes .open.

**Exit:** closeLogDropup(); also on global click, Escape, or blur when appropriate.

---

## 6. Modals (overlays)

**User modal (account):**
- Shown: **#user-modal-backdrop** `display: block`, `aria-hidden="false"`.
- Hidden: `display: none`, `aria-hidden="true"`.
- Toggle: #user-btn opens; #user-close or backdrop click closes. Opening user modal closes channel modal.

**Channel modal (new feed):**
- Shown: **#channel-modal-backdrop** `display` (e.g. block).
- Hidden: display none.
- Toggle: “+” tab (openChannelModal) opens; Cancel / Create closes.

(No body class; visibility is via backdrop display.)

---

## 7. Scroll-to-bottom button

**Purpose:** Show “↓ new messages” when user has scrolled up, so they can jump to bottom.

**State:**
- **#scroll-btn.visible** — button is visible and clickable (opacity 1, pointer-events auto).
- Without .visible: hidden (opacity 0, pointer-events none).

**Logic:**
- **atBottom** (isNearBottom()): when true, scroll handler removes .visible; scrollBottom() also removes .visible.
- When not at bottom, .visible should be added (e.g. in scroll handler when !atBottom); if missing in code, button may never appear.

**Exit:** User scrolls to bottom → .visible removed; or mobile: #scroll-btn hidden by CSS.

---

## 8. Toast

**Purpose:** Temporary message (e.g. “Copied”, errors).

**State:**
- **#toast.show** — toast visible (opacity/transform).
- Removed after a timeout (e.g. 2–3 s).

**Toggle:** JS adds .show and sets timer to remove .show.

---

## Summary table

| Mode / UI        | Toggle / trigger      | Key class / state              | Scope        |
|------------------|-----------------------|---------------------------------|-------------|
| Select mode      | Select btn, auto-on   | body.select-mode, #select-toggle.active, .select-extra.show | Global      |
| Edit mode        | Edit on message       | .msg-editing, editingMessageId  | One row     |
| DnD mode         | Drag message          | body.dnd-active, .msg.dragging   | Session     |
| View menu        | View ▾ click          | #view-menu.open                 | Dropdown    |
| Log dropup       | Log click             | #log-dropup-panel.open          | Dropdown    |
| User modal       | Account click         | Backdrop display + aria-hidden  | Overlay     |
| Channel modal    | + tab click           | Backdrop display                | Overlay     |
| Scroll btn       | Scroll position       | #scroll-btn.visible             | Overlay     |
| Toast            | API (e.g. toast())    | #toast.show                     | Overlay     |
