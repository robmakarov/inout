# DnD (views-agnostic)

Use animations.md DnD tokens in feed, table, graph so DnD stays consistent.

**Payload:** object ids only (application/x-inout-msg-id). No view-specific data.

**Drop zone:** id, hitTest(x,y)→insertPoint, getIndicatorRect(insertPoint)→rect, commit(ids, insertPoint). Controller: one dragover handler, hitTest zones in order, show indicator, on drop call activeZone.commit.

**Views:** Feed = Y→insertBefore + line. Tab = over tab→channel, .tab-drop-target. Table = row index + line. Horizontal = X→index + vertical line. Graph = slot + highlight.

**Refactor:** Extract feed/tab into zones; one controller; add table/graph as new zones. Drag image: (A) view provides clone or (B) generic "N items".
