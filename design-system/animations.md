# Animations

Rules for animation in the app. Code should use these (variables/names/durations) so behavior stays consistent.

## Tokens (use in CSS)

- **Durations:** fast 0.1s, normal 0.2s, slow 0.35s
- **Easing:** ease-out; smooth = cubic-bezier(0.2, 0.8, 0.2, 1)

## Keyframes (reusable)

- **anim-fade-in** — opacity 0 → 1
- **anim-slide-up** — opacity 0→1, translateY(8px)→0
- **anim-slide-down** — opacity 0→1, translateY(-4px)→0
- **anim-slide-in-right** — opacity 0→1, translateX(10px)→0

## DnD tokens (use in CSS)

- **--dnd-nudge-duration** — how long the drop-target row nudge takes (e.g. 0.12s)
- **--dnd-nudge-offset** — how far the target row shifts (e.g. 40px)
- **--dnd-indicator-duration** — drop line position snap (e.g. 0.06s)
- **--dnd-spirit-fly-duration** / **--dnd-spirit-fade-duration** — fly-to-tab clone (e.g. 0.4s, 0.35s)
- **--dnd-drop-line-color**, **--dnd-drop-line-height** — insert-position line
- **--dnd-origin-line-color** — fixed line at drag start
- **--dnd-target-bg** — row under cursor highlight
- **--dnd-idle-opacity** — non-dragged rows during drag (e.g. 0.68)
- **--dnd-idle-bg** — background of non-dragged rows during drag (e.g. var(--line)), slightly darker so draggable stands out
- **--dnd-placeholder-opacity** — .dragging-in-feed rows when not using in-place look (e.g. 0.35)
- **--dnd-ghost-opacity** — origin ghost copies (e.g. 0.5)
- **--dnd-spirit-shadow**, **--dnd-spirit-radius** — cursor-following clone
- **--dnd-stack-drop-in-duration** — after drop, reordered block (single or stack) plays same entrance animation; .msg-dnd-just-dropped applied then removed.
- **--dnd-stack-stagger-step** — delay between each row in the stack drop-in animation (e.g. 0.03s); JS uses 30ms per row so the stack lands in sequence.
- **--dnd-spirit-stack-max-visible** — max rows shown in the stack spirit under cursor (e.g. 4); rest show as "+N".

**Rule:** During body.dnd-active, .msg has no transition/animation (except .msg-drag-nudge-right) so layout and drop line don’t jump. **In-place look:** floating spirit is hidden; dragged row(s) stay in place and look hovered (--bg2); other rows use --dnd-idle-bg and --dnd-idle-opacity with no hover. Fly-to-tab still uses clone. **Stack of objects:** (1) Placeholder rows in feed (.dragging-in-feed, .msg-drag-group) share a left-edge cue (inset box-shadow) so they read as one block. (2) After reorder drop, the inserted block gets .msg-dnd-just-dropped and msgin with --dnd-stack-drop-in-duration, staggered by --dnd-stack-stagger-step per row so the stack lands in sequence.

## Where used

- **Drawer (account modal):** slide-in from right, 0.18s ease
- **Message row (.msg):** on appear, slide down + fade, 0.2s ease
- **Empty state:** optional fade + slide up
- **Loader:** spin (rings), bars (moving gradient), pulse (online dot)
- **DnD:** see DnD tokens above; nudge uses --dnd-nudge-duration; spirit/fly use --dnd-spirit-*; drop line uses --dnd-indicator-duration; stack/single after drop uses --dnd-stack-drop-in-duration and .msg-dnd-just-dropped.
- **Toast, scroll btn:** opacity/transform ~0.2s
- **Buttons/inputs:** hover/transition ~0.1–0.2s

## Utility classes

- .anim-fade-in, .anim-slide-up, .anim-slide-down, .anim-slide-in-right — apply the keyframe with normal duration and ease-out.
