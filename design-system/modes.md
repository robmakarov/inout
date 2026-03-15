# Modes

| Mode | Trigger | Key state |
|------|---------|-----------|
| Select | #select-toggle, auto-on | body.select-mode, #select-toggle.active, .select-extra.show |
| Edit | Edit on message | editingMessageId, .msg-editing |
| Reordering | Drag row (DnD) | body.dnd-active, .msg.dragging, .msg-drag-group, .dragging-in-feed, .msg-drag-target, .feed-drop-indicator.visible, .tab.tab-drop-target |
| View menu | #view-toggle | #view-menu.open, fieldPrefs |
| Log dropup | #log-action-btn | #log-dropup-panel.open |
| User modal | #user-btn | backdrop display, aria-hidden |
| Channel modal | + tab | backdrop display |
| Bar reorder | #bar-reorder-toggle (⋯) | body.bar-dnd-mode; reorder buttons in top bar only |
| Scroll btn | scroll position | #scroll-btn.visible |
| Toast | toast() | #toast.show |

Reordering: DnD is the interaction tool (drag row to reorder). Order is saved and synced in realtime for the same user — other devices/tabs see the new order via subscribeOrderRealtime (message_orders + views). Per-user order only; shared channel order for other users would be a separate feature.
Origin and target lines (drop indicator) are broadcast in realtime: same channel subscribers see the dragger’s origin line and moving target line via Supabase broadcast (dnd-{channel}); scroll/resize update positions; hidden while we’re dragging (body.dnd-active).
Exit: Select → setSelectMode(false). Edit → cancelEditingMode/Send. Reordering → dragend. View/Log → outside click. Modals → close/backdrop.
