# DnD (drag and drop) — views-agnostic design

So that DnD works in the **feed**, **table**, **graphs**, and **horizontal** (or any future) view, the implementation should follow a single abstraction. The current feed + tab DnD can be refactored toward this over time.

**Animations:** All DnD visuals and timings use CSS variables defined in **animations.md** (DnD tokens): --dnd-nudge-duration, --dnd-nudge-offset, --dnd-indicator-duration, --dnd-spirit-fly-duration, --dnd-spirit-fade-duration, --dnd-drop-line-color, --dnd-target-bg, --dnd-idle-opacity, --dnd-placeholder-opacity, --dnd-ghost-opacity, --dnd-spirit-shadow, --dnd-spirit-radius. Use these in feed, table, and any future view so DnD looks and feels consistent.

---

## 1. Payload: always object IDs (layout-agnostic)

- **What is dragged:** Objects (messages). Identify them by **id** (and optionally count for multi-select).
- **dataTransfer:** Keep using `application/x-inout-msg-id` (single) and optionally a list for multi-drag. No view-specific data (no "feed row" or "table cell" in the payload).
- **Consequence:** Any view (feed, table, graph) that renders the same objects can start a drag; any registered drop zone can accept it. The same payload works for reorder-in-feed, move-to-tab, reorder-in-table, drop-on-graph-slot, etc.

---

## 2. Drop zone interface (each view registers a zone)

Each place that can accept a drop (feed list, tab bar, table body, graph area, etc.) is a **drop zone** with a small, consistent API. A single DnD controller uses this so it doesn’t depend on feed-specific DOM.

**Zone shape (conceptual):**

- **id** — e.g. `'feed'`, `'tab'`, `'table'`, `'graph'`.
- **hitTest(clientX, clientY)**  
  - Returns `null` if (x,y) is outside this zone, or an **insert point** object if inside.  
  - Insert point is **opaque to the controller** (zone-specific). Examples:  
    - Feed: `{ insertBeforeNode, wantAppend }` or `{ index }`.  
    - Tab: `{ channel }`.  
    - Table: `{ rowIndex }` or `{ rowIndex, colIndex }` if needed.  
    - Horizontal list: `{ index }` (index in horizontal order).
- **getIndicatorRect(insertPoint)**  
  - Returns a rect `{ left, top, width, height }` in viewport coordinates for drawing the drop indicator (line or highlight).  
  - **Vertical list (feed):** horizontal line → `height: 4`, `width` = zone width.  
  - **Horizontal list:** vertical line → `width: 4`, `height` = zone height.  
  - **Table:** e.g. horizontal line between rows (same as feed) or vertical between columns; or a full-cell highlight.  
  - **Tab:** no line; zone can use CSS class on tab (e.g. `.tab-drop-target`) instead; return `null` or “use element highlight”.
- **commit(ids, insertPoint)**  
  - Applies the drop: reorder in list, move to channel, insert at table row, etc.  
  - Can be async (e.g. moveSingleMessage).  
  - Receives the same insert point shape returned by hitTest.

**Priority / order:** If multiple zones hit (e.g. feed and tab both under cursor), the controller can use a fixed order (e.g. tab first, then feed) or z-index so only one zone is active per (x,y).

---

## 3. Single dragover handler (controller)

- **One** place handles `dragover` (and optionally `dragenter`/`dragleave`): e.g. document or a DnD layer.
- On dragover:
  1. Get `clientX`, `clientY`.
  2. For each registered zone (in priority order), call `zone.hitTest(clientX, clientY)`.
  3. First non-null result wins → **activeZone**, **activeInsertPoint**.
  4. If active zone has `getIndicatorRect`, show the global drop indicator at that rect (or let the zone draw its own, e.g. tab highlight).
  5. Store activeZone + activeInsertPoint for the next drop.
- On **drop**:
  1. Read payload (ids) from dataTransfer.
  2. Call `activeZone.commit(ids, activeInsertPoint)`.
  3. Hide indicator, clear active zone/insert point.
- On **dragend**: always hide indicator and clear active zone (even if drop was on another zone or cancelled).

This way, **feed** is just one zone (vertical list), **table** is another (rows, or rows+columns), **tabs** another (move to channel), **graph** another (e.g. “slot” or “node” as insert point). Layout (vertical vs horizontal) only changes how hitTest and getIndicatorRect are implemented.

---

## 4. Indicator rendering

- **Global indicator:** One shared element (e.g. `.feed-drop-indicator` generalized to `.dnd-drop-indicator`) positioned with `left, top, width, height`.  
  - Vertical list: `width = zone width`, `height = 4`, `top = lineY - 2`.  
  - Horizontal list: `height = zone height`, `width = 4`, `left = lineX - 2`.  
  - Table: same as list (e.g. horizontal line between rows); or a second type “vertical line” for between columns.
- **Element highlight:** Some zones (tabs) only need a class on the target element (e.g. `.tab-drop-target`). No global line. getIndicatorRect can return null and the zone sets/clears the class in hitTest (or the controller calls zone.setHighlight(insertPoint)).

So: one API for “where to draw the line” (rect), and optionally “highlight this element” (class), keeps DnD working for table and horizontal without special cases in the controller.

---

## 5. Drag image / spirit

- **Current:** Feed clones the row for setDragImage / spirit.
- **Views-agnostic options:**  
  - **A)** Each view that can start a drag provides a **getDragImage(draggedElement)** → Node (or { node, offsetX, offsetY }). Controller uses that for setDragImage and for the floating spirit. Table view would return a table-row clone; feed keeps row clone; graph could return a small card.  
  - **B)** One **generic** drag preview (e.g. “1 item” / “3 items” + first line of text). Same for all views; no view-specific clone. Easiest for tables/graphs.

Recommendation: start with (B) for new views; optionally add (A) later so table row looks like a row while dragging.

---

## 6. What each view implements

| View       | hitTest(clientX, clientY)     | getIndicatorRect(insertPoint)   | commit(ids, insertPoint)        |
|-----------|------------------------------|----------------------------------|----------------------------------|
| Feed      | Y → row index / insertBefore  | Horizontal line between rows    | Reorder in feed DOM + save order |
| Tab       | Over tab → { channel }       | null (use .tab-drop-target)     | moveSingleMessage(id, channel)  |
| Table     | Y (and X if columns) → row   | Line between rows (or columns)   | Reorder by index, re-render      |
| Horizontal list | X → index              | Vertical line between items      | Reorder by index, re-render      |
| Graph     | Over slot/card → slot id      | Highlight slot or null          | Assign to slot / reorder nodes   |

---

## 7. Making existing code match (refactor steps)

1. **Extract feed drop logic** into a `feedDropZone`: hitTest (current Y/row logic), getIndicatorRect (current line), commit (current insertBefore/appendChild + recomputeOrderFromDOM).
2. **Extract tab drop logic** into a `tabDropZone`: hitTest (elementFromPoint or tab under cursor), getIndicatorRect = null, commit = moveSingleMessage.
3. **Introduce a small DnD controller**: register feed and tab zones; on document (or feed + tab container) dragover, run hitTest loop and show indicator / set tab highlight; on drop, call active zone commit.
4. **Keep** dragstart/dragend on the **draggable elements** (feed row, later table row, etc.); they only set dataTransfer and optionally provide drag image. They don’t need to know which zone will handle the drop.
5. When adding **table** (or horizontal) view: implement tableDropZone with hitTest (row index from Y, or column from X for horizontal), getIndicatorRect (line between rows or columns), commit (update order and re-render). Register it in the same controller. No change to feed or tab logic.

This keeps DnD working everywhere: same payload, same controller, only the drop zones and their geometry (vertical vs horizontal vs table vs graph) differ.
