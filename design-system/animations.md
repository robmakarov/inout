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

## Where used

- **Drawer (account modal):** slide-in from right, 0.18s ease
- **Message row (.msg):** on appear, slide down + fade, 0.2s ease
- **Empty state:** optional fade + slide up
- **Loader:** spin (rings), bars (moving gradient), pulse (online dot)
- **DnD:** nudge 0.12s ease-out; spirit fly 0.4s transform, 0.35s opacity. During DnD: no transition/animation on .msg to avoid layout jump.
- **Toast, scroll btn:** opacity/transform ~0.2s
- **Buttons/inputs:** hover/transition ~0.1–0.2s

## Utility classes

- .anim-fade-in, .anim-slide-up, .anim-slide-down, .anim-slide-in-right — apply the keyframe with normal duration and ease-out.
