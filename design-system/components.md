# Components

## Layout
Header is always fixed (position:fixed; top:0); nothing moves it. Everything below = App (#app has padding-top for header; content: #manage-bar, #feed, #input-area). #app-loader, #feed, #feed-inner.

## Header
header, .logo, .header-right, #online-count, #object-count, #user-btn (.signed-in)

## Manage bar (top bar)
#manage-bar — fixed under header, fills width; .bar-scroll (horizontal scroll), .bar-group; #manage-bar-scroll, #manage-actions. Buttons have data-bar-id; reorder via bar-dnd-mode (⋯ toggle). #bar-reorder-toggle, #view-menu (.open)
#select-toggle (.active), .select-extra (.show), .manage-btn, #move-target, #view-toggle

## Feed
#empty, .loader-inner, .feed-drop-indicator (.visible)

### Object row (one class of object)
View mode = visualisation of the **object base**; the current view is for one class of object only. One object = one **.obj** row (object row). Same component in both Feed and Table visual (Table currently uses the same layout as Feed).

**Structure**
- **Object = container of:** (1) text fields (object meta + message property), (2) action buttons on the right.
- **Basic parameters (object meta):** non-editable. Default: `.obj-time`, `.obj-sender`. Styled **secondary** (smaller, muted): 11px, `color: var(--muted)`.
- **Message (primary property):** editable in edit mode. `.obj-text` = main value (more properties can be added later; order = priority, highest to lowest). Styled **primary**: normal size (13px), `color: var(--text)` (white/primary content).
- **Actions:** `.obj-actions` on the right (Del, Move, Exp, Copy, Cut). Actions apply to the whole object row.

**Behavior**
- **Edit:** Click message text → main input loads value; only message(s) are edited; meta (time, author) stay read-only. Row mirrors input in realtime (doppelganger). Send to save, Escape to cancel.
- **Select / reorder / actions:** Checkbox, DnD (middle-line crossing), and action buttons operate on the full object row. Logic unchanged.

.obj — .obj-time, .obj-sender, .obj-text, .obj-checkbox-zone, .obj-select, .obj-actions, .obj-action-btn. **Hover-revealed** select-wrap and actions; same hover boundary as the row.
States: .obj-selected, .obj-editing, .obj-drag-target, .obj-drag-nudge-right, .new-flash, .dragging, .obj-drag-group, .dragging-in-feed, .obj-dnd-just-dropped
.obj-origin-ghost, .origin-ghost-overlay | .obj-drag-spirit, .obj-drag-spirit-stack, .obj-drag-spirit-row, .obj-drag-spirit-stack-more | .obj-fly-clone
.tab — .tab-active, .tab-shared, .tab-badge, .tab-new, .tab-close, .tab-drop-target

## Input
#input-area, #tabs, #clipboard-bubble, #draft-bubble, .draft-btn, .input-wrap, .input-tools, #clipboard-button, #log-action-btn (.error-signal), #log-dropup-panel (.open). **Composer:** .composer (single bar: input + send), .composer-input-wrap, #msg-input, #msg-input-count (.composer-count), .clear-input-btn, #send-btn (.composer-send). Main input is used for both new messages and editing; when editing a message, typing updates the message row in the view in realtime.

## Overlays
#scroll-btn (.visible), #toast (.show)

## Modals
#user-modal-backdrop + #user-modal: .um-top, .um-title, #user-close, .um-section, .um-btn, .um-btn-primary, #um-auth-btn, #um-nick-save, #um-copy-id, etc.
#channel-modal-backdrop + #channel-modal: .cm-title, .cm-field, .cm-btn, .cm-btn-primary, #cm-name, #cm-cancel, #cm-create

## Primitives
Buttons: .manage-btn, .um-btn, .um-btn-primary, .cm-btn, .draft-btn, .obj-action-btn. Inputs: .cm-input, #msg-input.
