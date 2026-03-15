# Animations

## Tokens
- Durations: fast 0.1s, normal 0.2s, slow 0.35s
- Easing: ease-out; smooth = cubic-bezier(0.2, 0.8, 0.2, 1)

## Keyframes
- anim-fade-in, anim-slide-up, anim-slide-down, anim-slide-in-right (opacity + translate)

## DnD tokens (:root)
- --dnd-nudge-duration, --dnd-nudge-offset, --dnd-indicator-duration
- --dnd-spirit-fly-duration, --dnd-spirit-fade-duration
- --dnd-drop-line-color, --dnd-drop-line-height, --dnd-origin-line-color
- --dnd-target-bg, --dnd-idle-opacity, --dnd-idle-bg, --dnd-placeholder-opacity, --dnd-ghost-opacity
- --dnd-spirit-shadow, --dnd-spirit-radius
- --dnd-stack-drop-in-duration, --dnd-stack-stagger-step, --dnd-spirit-stack-max-visible

**DnD:** body.dnd-active → .msg no transition except .msg-drag-nudge-right. Spirit hidden (in-place); dragged = hover look; others = --dnd-idle-bg/opacity, no hover. Stack: left-edge cue on placeholders; drop-in staggered.

## Where used
- Modal: slide-in-right 0.18s. Message row: msgin 0.2s. DnD: tokens above. Toast/scroll: ~0.2s. Buttons: ~0.1–0.2s.
