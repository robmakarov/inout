# Modes

| Mode | Trigger | Key state |
|------|---------|-----------|
| Select | #select-toggle, auto-on | body.select-mode, #select-toggle.active, .select-extra.show |
| Edit | Edit on message | editingMessageId, .msg-editing |
| DnD | Drag row | body.dnd-active, .msg.dragging, .msg-drag-group, .dragging-in-feed, .msg-drag-target, .feed-drop-indicator.visible, .tab.tab-drop-target |
| View menu | #view-toggle | #view-menu.open, fieldPrefs |
| Log dropup | #log-action-btn | #log-dropup-panel.open |
| User modal | #user-btn | backdrop display, aria-hidden |
| Channel modal | + tab | backdrop display |
| Scroll btn | scroll position | #scroll-btn.visible |
| Toast | toast() | #toast.show |

Exit: Select → setSelectMode(false). Edit → cancelEditingMode/Send. DnD → dragend. View/Log → outside click. Modals → close/backdrop.
