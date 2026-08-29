/**
 * G2 — ONE PAINTER FOR EVERY SYNTHETIC SOURCE IN THIS REPO.
 *
 * The implementation lives in `@core/capture/synthetic`, which is the file that
 * has to own it: that module IS the product's synthetic source (everything
 * behind `?synthetic=1`), so a second copy here is exactly the five-copies-of-
 * one-palette mistake R1 fix 10 paid for. This module is the door the
 * experimental rigs come through, and it carries the reason.
 *
 * WHY NOT PLAIN requestAnimationFrame. A synthetic source is a canvas handed to
 * `captureStream()`, and such a track emits a frame only when the canvas is
 * PAINTED. rAF is the COMPOSITOR's clock, so under exactly the load these rigs
 * exist to create it degrades along with everything else — and a starved SOURCE
 * reads downstream as a starved PIPELINE: the tail band calls it tail loss, the
 * fps band calls it degradation, and the rig has been measuring itself.
 *
 * WHY NOT PLAIN setInterval. A headed run should keep painting on the display's
 * own clock, because that is the environment a sync number is supposed to
 * describe. So rAF stays primary and an interval watchdog sits behind it,
 * painting only when rAF has been quiet for longer than one frame period.
 *
 * THE ROADMAP'S STATED REASON IS REFUTED, and this is where it is written down:
 * "a headless page runs rAF at 0" is false on this Chrome. `npm run exp --
 * rigsource` reads rAF at 120 Hz headless and 120 Hz headed, with the
 * rAF-painted track delivering 30.2 of 30 fps in both. rAF is not dead. It is
 * merely not independent of the thing under test, which is worse, because it
 * fails only in the runs that matter.
 */
export { paintLoop, type PaintLoop } from '@core/capture/synthetic'
