# Components

## Layout
Header is always fixed (position:fixed; top:0); nothing moves it. Everything below = App (#app has padding-top for header; content: #manage-bar, #feed, #input-area). #app-loader, #feed, #feed-inner.

## Header
header, .logo, .header-right, #online-count, #msg-count, #user-btn (.signed-in)

## Manage bar
#manage-bar, #select-toggle (.active), .select-extra (.show), .manage-btn, #move-target, #view-toggle, #view-menu (.open)

## Feed
#empty, .loader-inner, .feed-drop-indicator (.visible)
.msg — .msg-sender, .msg-time, .msg-text, .msg-checkbox-zone, .msg-select, .msg-actions, .msg-action-btn
**Hover-revealed controls** (select-wrap, actions, time/sender styling) are part of the row: they show accessible actions for this object in this view; same hover boundary as the row.
States: .msg-selected, .msg-editing, .msg-drag-target, .msg-drag-nudge-right, .new-flash, .dragging, .msg-drag-group, .dragging-in-feed, .msg-dnd-just-dropped
.msg-origin-ghost, .origin-ghost-overlay | .msg-drag-spirit, .msg-drag-spirit-stack, .msg-drag-spirit-row, .msg-drag-spirit-stack-more | .msg-fly-clone
.tab — .tab-active, .tab-shared, .tab-badge, .tab-new, .tab-close, .tab-drop-target

## Input
#input-area, #tabs, #clipboard-bubble, #draft-bubble, .draft-btn, .input-wrap, #msg-input, .clear-input-btn, #send-btn, .input-tools, #clipboard-button, #log-action-btn (.error-signal), #log-dropup-panel (.open)

## Overlays
#scroll-btn (.visible), #toast (.show)

## Modals
#user-modal-backdrop + #user-modal: .um-top, .um-title, #user-close, .um-section, .um-btn, .um-btn-primary, #um-auth-btn, #um-nick-save, #um-copy-id, etc.
#channel-modal-backdrop + #channel-modal: .cm-title, .cm-field, .cm-btn, .cm-btn-primary, #cm-name, #cm-cancel, #cm-create

## Primitives
Buttons: .manage-btn, .um-btn, .um-btn-primary, .cm-btn, .draft-btn, .msg-action-btn. Inputs: .cm-input, #msg-input.
