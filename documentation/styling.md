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
| `body.select-mode` | Select mode on | .msg-checkbox-zone visible; .msg-select-wrap visible; manage-actions visible (mobile: checkbox zone width). |
| `body.dnd-active` | During message drag (reorder) | .msg:hover styles disabled (no background/color/opacity change on hover). |

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
- **#feed-inner** — Wraps .msg rows and #empty; min-height for centering empty state.
- **#empty** — Flex center, loader + “Nothing yet” text; shown when no messages.
- **#manage-bar** — Flex row; **#manage-actions** visibility toggled by select mode.
- **#input-area** — Bottom bar; on mobile (540px) fixed to bottom.
- **#app-loader** — display:none in current setup (loader lives in #empty).

---

## 5. Message row classes (`.msg` and children)

| Class | Role |
|-------|------|
| `.msg` | Row container; flex; border-bottom. |
| `.msg:hover` | Background --bg2; time/sender color --text; .msg-select-wrap and .msg-actions visible (unless body.dnd-active). |
| `.msg.msg-selected` | Checkbox checked; same as hover for select-wrap. |
| `.msg.msg-editing` | Row being edited; time/sender/select-wrap/actions visible. |
| `.msg.dragging` | Row being dragged; opacity 0.35. |
| `.msg-drag-target` | Row under drop position; .msg-time, .msg-sender, .msg-text translateX(30px). |
| `.msg-drag-over` | (Legacy; only removed, not added.) |
| `.msg.new-flash` | New message highlight; removed after 800ms. |
| `.msg-time` | Timestamp; font-size 6px; **default display:none**; JS shows from fieldPrefs. |
| `.msg-sender` | Author; **default display:none**; JS shows for non-main when fieldPrefs.showAuthor. |
| `.msg-text` | Message body; flex 1. |
| `.msg-actions` | Del/Move/Exp/Copy; opacity 0 by default, 1 on hover/editing. |
| `.msg-select-wrap`, `.msg-select` | Checkbox; opacity 0 by default, 1 in select-mode or hover. |
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
