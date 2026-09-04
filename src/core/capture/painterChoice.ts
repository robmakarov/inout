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
 * WEBGL2 IS STILL THE DEFAULT, AND THAT IS A MEASUREMENT AND NOT CAUTION.
 *
 * The gate O4 set was "both painters required identical". They are not, and the
 * parity rig says exactly where (`scripts/painter-parity.mjs`, 2026-09-04):
 *
 *   · on a synthetic canvas source they ARE identical — maxAbs 1 of 255, PSNR
 *     110 dB. Every shape, corner radius, border stroke, feathered edge and
 *     blend agrees. The shaders and the geometry are not in question.
 *   · on a REAL NV12 screen-capture frame they do not. 13,485 pixels of
 *     2,073,600 differ by more than one step, 6,552 by more than four, worst 37
 *     of 255, PSNR 55.9 dB. The difference is systematic and it is COLOUR:
 *     across the twelve worst pixels the green channel is identical every time,
 *     red is 3-11 higher on WebGPU and blue is 29-37 lower, luma within 2 of
 *     255. WebGPU renders warm saturated content more saturated. That is the
 *     NV12 -> RGB conversion differing between `texImage2D` and
 *     `importExternalTexture`, not the drawing.
 *
 * A colour a user can see does not move without Robert's yes — the hard rule,
 * and the one the "a fix ships on" clause does not override, because this is a
 * new engine and not a defect fix. The A/B pair is in ~/Downloads/inout-o4.
 *
 * WHAT IT COSTS TO WAIT, so the trade is on the table rather than buried: on the
 * capture composition (a 3024x1964 NV12 screen into a 1080p composite, screen
 * draw + camera PiP) the paint measures 4.059 ms on WebGL2 against 0.416 ms on
 * WebGPU behind a real fence — 3.64 ms a frame, 90 %, because WebGL2 uploads
 * the frame once per draw and WebGPU uploads it never.
 */
export function painterChoice(): PainterChoice {
  return fromSearch() ?? override ?? fromStorage() ?? 'webgl2'
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
