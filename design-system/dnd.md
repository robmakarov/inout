# DnD (views-agnostic)

DnD is the **interaction tool for reordering mode**: user reorders by dragging; reordering mode is the mode, DnD is how it’s done.
**Realtime origin/target lines:** When someone drags in a channel, other clients viewing that channel see their origin line and target (drop) line via broadcast (channel `dnd-{channel}`): dnd_start (origin with lastDraggedId + insertBeforeId, draggingIds), dnd_move (target, throttled), dnd_end. **Whole reorder in realtime:** After a successful drop the sender broadcasts dnd_dropped (newOrder, movedIds). Other clients apply the new order immediately (suppressOrderApplyUntil so DB event is ignored), run applyMessageOrderToDOM(), and add .msg-remote-reorder to moved rows for a short opacity-in animation (staggered), then remove the class. Origin line is drawn at the **bottom of the last dragged row** (lastDraggedId) so the border is correct across devices; target uses insertBeforeId. **Remote ghost:** draggingIds from dnd_start; receiver finds rows with those ids, unions their viewport rects, shows a fixed overlay (`.remote-origin-ghost`) at that position; left-edge cue via inset box-shadow (same side as local); updated on scroll/resize; hidden on dnd_end. **Remote spirit:** cursorY in dnd_start and dnd_move; receiver shows `.remote-drag-spirit` (same look as local spirit) at feed center X and clamped cursorY; hidden on dnd_end. Long-press threshold for touch drag: 200ms. Remote lines use same tokens; positions updated on feed scroll/resize; not shown while local user is dragging. Mobile receive: scroll listener uses getElementById; channel compare trimmed; apply retries once if feed empty; visibility re-subscribe after 100ms.
Use animations.md DnD tokens in feed, table, graph so DnD stays consistent.

**Payload:** object ids only (application/x-inout-msg-id). No view-specific data.

**Drop zone:** id, hitTest(x,y)→insertPoint, getIndicatorRect(insertPoint)→rect, commit(ids, insertPoint). Controller: one dragover handler, hitTest zones in order, show indicator, on drop call activeZone.commit.

**Views:** Feed = Y→insertBefore + line. Tab = over tab→channel, .tab-drop-target. Table = row index + line. Horizontal = X→index + vertical line. Graph = slot + highlight.

**Refactor:** Extract feed/tab into zones; one controller; add table/graph as new zones. Drag image: (A) view provides clone or (B) generic "N items".
