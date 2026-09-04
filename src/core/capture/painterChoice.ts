// WHICH PAINTER THE CAPTURE COMPOSITOR USES (task O4).
//
// Three complete backends, tried in this order and each a full fallback for the
// one above it, so no machine loses a path:
//
//   webgpu   importExternalTexture — binds the capture frame's planes where
//            they already are. Removes the upload, which is 40-50 % of the
//            paint (measured 2026-09-04; see compositorWGPU.ts).
//   webgl2   texImage2D + a textured quad. What every take before O4 used.
//   2d       drawImage into an OffscreenCanvas 2D context. Slow (~150 ms per
//            1080p frame) but correct, and the watchdog degrades past it.
//
// THE SWITCH IS ON THE THING BEING REPLACED, which is the repo's rule: a
// backend that lands turned off has landed nothing. `?painter=webgl2` puts a
// take back on the shipped path exactly as it was, and `?painter=2d` reaches
// the floor; the /?test panel carries both as rows so nobody has to type a URL.
// Asking for a backend this machine does not have falls through to the next one
// rather than failing a take — the engine never refuses a record press.
//
//   ?painter=webgpu | webgl2 | 2d      (URL, this take)
//   localStorage['inout.capture.painter']   (sticky)

export type PainterChoice = 'webgpu' | 'webgl2' | '2d'

const FLAG_KEY = 'inout.capture.painter'

let override: PainterChoice | null = null

function parse(v: string | null): PainterChoice | null {
  return v === 'webgpu' || v === 'webgl2' || v === '2d' ? v : null
}

function fromSearch(): PainterChoice | null {
  if (typeof location === 'undefined') return null
  return parse(new URLSearchParams(location.search).get('painter'))
}

function fromStorage(): PainterChoice | null {
  try {
    return parse(localStorage.getItem(FLAG_KEY))
  } catch {
    return null
  }
}

/**
 * WEBGPU BY DEFAULT SINCE 2026-09-04, ON ROBERT'S RULING, AND THE ONE THING IT
 * CHANGES THAT A USER CAN SEE IS THE THING HE RULED ON.
 *
 * The parity rig (`scripts/painter-parity.mjs`) put the two painters on the
 * same frames:
 *
 *   · on a synthetic source they are IDENTICAL — maxAbs 1 of 255, PSNR 110 dB.
 *     Every shape, corner radius, border stroke, feathered edge and blend
 *     agrees, so the shaders and the geometry are not in question and never
 *     were.
 *   · on a REAL NV12 screen frame they differ, systematically, in COLOUR:
 *     13,485 pixels of 2,073,600 by more than one step, 6,552 by more than
 *     four, worst 37, PSNR 55.9 dB. Over the twelve worst pixels the green
 *     channel is identical every time, red is 3-11 higher here and blue 29-37
 *     lower, luma within 2.02 of 255 — WebGPU renders warm saturated content
 *     MORE saturated. `texImage2D` and `importExternalTexture` disagree about
 *     NV12 -> RGB; the drawing does not.
 *
 * He was shown the A/B (~/Downloads/inout-o4) and chose this one. The direction
 * is also the direction O9 is spending GPU headroom to go: the composite keeps
 * 70-75 % of the source's colour against the raw screen's 80-89 %, and this
 * moves it up rather than down.
 *
 * WHAT IT BUYS: on the capture composition — a 3024x1964 NV12 screen into a
 * 1080p composite, screen draw plus camera PiP, behind a real fence — 0.416 ms
 * a frame against WebGL2's 4.059. 3.64 ms, 90 %, 22 % of a 60 fps budget,
 * because WebGL2 uploads the frame once PER DRAW and WebGPU uploads it never.
 *
 * THE THING BEING REPLACED CARRIES THE SWITCH, which is the repo's rule:
 * `?painter=webgl2` is every take made before this, unchanged. A machine
 * without WebGPU is not affected in any way — it gets WebGL2, which is what it
 * had.
 */
export function painterChoice(): PainterChoice {
  return fromSearch() ?? override ?? fromStorage() ?? 'webgpu'
}

export function setPainterChoice(p: PainterChoice | null): void {
  override = p
  try {
    if (p === null) localStorage.removeItem(FLAG_KEY)
    else localStorage.setItem(FLAG_KEY, p)
  } catch {
    /* memory-only */
  }
}
