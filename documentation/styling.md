# Styling reference (for humans and AI)

CSS lives in a single `<style>` block in `index.html`. Use this when changing layout, colors, or responsive behavior. **When you add/change variables, breakpoints, or body/class states, update this file.**

---

## 1. CSS variables (`:root`)

| Variable | Typical use |
|----------|-------------|
| `--bg` | Page/app background (#0a0a09). |
| `--bg2` | Slightly lighter panels, hover (#111110). |
| `--line`, `--line2` | Borders (#1e1e1c, #2a2a27). |
| `--dim` | Muted text (#3a3a36). |
| `--muted` | Softer muted (#666660). |
| `--soft` | Secondary text (#999990). |
| `--text` | Primary text (#e2ddd4). |
| `--bright` | Emphasized text (#f0ece3). |
| `--acc`, `--acc2` | Accent (e.g. gold #e8d5a0, #b8a060). |
| `--mono` | Font: DM Mono. |
| `--sans` | Font: Syne. |
| `--vv-top` | Visual viewport top offset (iOS keyboard); set via JS. |

---

## 2. Body and document state classes

| Selector | When applied | Effect (summary) |
|----------|--------------|-------------------|
| `body.loaded` | After init (or 4s timeout) | Hides #app-loader (if it were shown). |
| `body.select-mode` | Select mode on | .obj-checkbox-zone visible; .obj-select-wrap visible; manage-actions visible (mobile: checkbox zone width). |
| `body.dnd-active` | During message drag (reorder) | .obj:hover styles disabled (no background/color/opacity change on hover). |

---

## 3. Breakpoints

- **540px** — Main mobile breakpoint used in several `@media(max-width:540px)` blocks:
  - Message row: user-select none, checkbox zone hidden until select-mode.
  - Header/manage bar/input: fixed positioning, padding adjustments.
  - Feed padding-bottom for fixed input.
  - #field-time / #field-author possibly adjusted.

Use 540px for “mobile” unless a comment or this doc says otherwise.

---

## 4. Key element IDs and their role in layout

- **#app** — Flex column, full viewport height (100vh / 100dvh / 100svh).
- **#feed** — Flex 1, scrollable (overflow-y auto), scrollbar hidden.
- **#feed-inner** — Wraps .obj rows and #empty; min-height for centering empty state.
- **#empty** — Flex center, loader + “Nothing yet” text; shown when no messages.
- **#manage-bar** — Flex row; **#manage-actions** visibility toggled by select mode.
- **#input-area** — Bottom bar; on mobile (540px) fixed to bottom.
- **#app-loader** — display:none in current setup (loader lives in #empty).

---

## 5. Object row classes (`.obj` and children)

| Class | Role |
|-------|------|
| `.obj` | Row container; flex; border-bottom. |
| `.obj:hover` | Background --bg2; time/sender color --text; .obj-select-wrap and .obj-actions visible (unless body.dnd-active). |
| `.obj.obj-selected` | Checkbox checked; same as hover for select-wrap. |
| `.obj.obj-editing` | Row being edited; time/sender/select-wrap/actions visible. |
| `.obj.dragging` | Row being dragged; opacity 0.35. |
| `.obj-drag-target` | Row under drop position; .obj-time, .obj-sender, .obj-text translateX(30px). |
| `.obj-drag-over` | (Legacy; only removed, not added.) |
| `.obj.new-flash` | New message highlight; removed after 800ms. |
| `.obj-time` | Timestamp; font-size 6px; **default display:none**; JS shows from fieldPrefs. |
| `.obj-sender` | Author; **default display:none**; JS shows for non-main when fieldPrefs.showAuthor. |
| `.obj-text` | Message body; flex 1. |
| `.obj-actions` | Del/Move/Exp/Copy; opacity 0 by default, 1 on hover/editing. |
| `.obj-select-wrap`, `.obj-select` | Checkbox; opacity 0 by default, 1 in select-mode or hover. |
| `.feed-drop-indicator` | 4px line; position fixed; visible during DnD reorder. |

---

## 6. Tabs

| Class | Role |
|-------|------|
| `.tab` | Channel tab button. |
| `.tab-active` | Current channel. |
| `.tab-drop-target` | Dragging message over tab (move to channel). |
| `.tab-badge` | Unread count; .show when count > 0. |

---

## 7. Modals and overlays

- **#user-modal-backdrop**, **#channel-modal-backdrop** — Full overlay; display block/flex to show.
- **#log-dropup-panel** — .open to show action log.
- **#toast** — .show with timeout for toast message.

---

## 8. Fonts

- Loaded from Google Fonts: **DM Mono** (300, 400, 500, italic), **Syne** (400–800).
- Default font-family: var(--mono) (DM Mono). Syne used for headings/empty label (--sans).

When you add a new variable, breakpoint, or state-driven class, add a line here so future edits stay consistent.
