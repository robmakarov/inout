# Components

UI components and their IDs, classes, and states. Code should match this structure and naming.

## Layout

- **#app** — Main shell (flex column, full height)
- **#app-loader** — Splash loader (hidden by default)
- **#feed** — Scrollable feed
- **#feed-inner** — Feed content wrapper

## Header

- **header** — Top bar
- **.logo** — "INOUT" (span = accent "OUT")
- **.header-right** — Right group
- **#online-count** — .dot + #oc-num
- **#msg-count**
- **#user-btn** — Account icon. State: .signed-in

## Manage bar

- **#manage-bar**
- **#select-toggle** — State: .active
- **.select-extra** — State: .show
- **.manage-btn** — Select, All, None, Delete, Move, Export, View
- **#move-target** — select
- **#view-toggle**, **#view-menu** — State: .open
- **#view-menu** — labels + checkboxes Time, Author

## Feed

- **#empty** — Empty state (loader + text)
- **.loader-inner** — .loader-ring, .loader-dash
- **.feed-drop-indicator** — State: .visible
- **.msg** — Message/object row
  - .msg-sender, .msg-time, .msg-text
  - .msg-checkbox-zone, .msg-select, .msg-actions, .msg-action-btn
  - States: .msg-selected, .msg-editing, .msg-drag-target, .msg-drag-nudge-right, .new-flash, .dragging, .msg-drag-group, .dragging-in-feed
- **.msg-origin-ghost**, **.origin-ghost-overlay** — DnD origin
- **.msg-drag-spirit**, **.msg-fly-clone** — DnD spirit/fly
- **.tab** — Channel tab. States: .tab-active, .tab-shared, .tab-badge, .tab-new, .tab-close, .tab-drop-target

## Input area

- **#input-area**
- **#tabs** — Tab strip
- **#clipboard-bubble**, **#draft-bubble** — Bubbles + .draft-btn
- **.input-wrap** — #msg-input, .clear-input-btn, #send-btn
- **.input-tools** — #clipboard-button, .log-dropup-wrap
- **#log-action-btn** — States: .error-signal, .error-signal-faded
- **#log-dropup-panel** — State: .open. Body: .log-event-card (.from-this-device, .error)

## Overlays

- **#scroll-btn** — State: .visible
- **#toast** — State: .show

## Modals

- **#user-modal-backdrop** + **#user-modal**
  - .um-top, .um-title, #user-close
  - .um-section, .um-label, .um-value, .um-row
  - .um-btn, .um-btn-primary
  - #um-auth-status, #um-auth-btn, #um-version-badge, #um-upgrade-btn, #um-nickname, #um-nick-save, #um-user-id, #um-copy-id
- **#channel-modal-backdrop** + **#channel-modal**
  - .cm-title, .cm-field, .cm-label, .cm-input, .cm-hint, .cm-row, .cm-btn, .cm-btn-primary
  - #cm-name, #cm-self, #cm-others, #cm-cancel, #cm-create

## Primitives

- Buttons: .manage-btn, .um-btn, .um-btn-primary, .cm-btn, .cm-btn-primary, .draft-btn, .msg-action-btn
- Inputs: .cm-input, #msg-input
- Labels: .um-label, .cm-label, .um-value, .cm-hint
- Structure: .um-section, .um-row, .cm-field, .cm-row
