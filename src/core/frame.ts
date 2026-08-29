/**
 * THE OUTPUT FRAME, DERIVED FROM THE TAKE (task F13).
 *
 * Until F13 the frame was a constant: `DEFAULT_EXPORT_SETTINGS` 1920x1080, four
 * landscape quality steps, a live composite canvas fixed at 1920x1080 and a
 * layout authored against a 1920 width. Nothing in that chain ever asked the
 * take what shape it was, so THE PRODUCT COULD NOT MAKE A VERTICAL VIDEO —
 * measured on prod 2026-08-29, a 4:3 camera-only take drew with `fit: 'cover'`
 * into a 1.778 stage and kept 75 % of its picture height. Apply the same cover
 * to a 9:16 phone camera and 31.6 % of the frame survives. Camera-only is the
 * ONLY take a phone can make (iOS gives browsers no screen capture at all), so
 * on mobile the crop is not an edge case, it is the whole product.
 *
 * WHAT FOLLOWS THE SOURCE, AND WHAT DOES NOT. The frame takes the take's
 * ASPECT; it does not take the take's pixel count. A quality step stays a
 * PIXEL BUDGET — its long edge — so "1080p" means the same amount of picture on
 * every shape, and PO's standing "minimal size" objective is not quietly
 * re-priced by the shape of somebody's monitor. The native-resolution win on a
 * 1440p/4K screen is already delivered by O3c (the step that matches the screen
 * packet-copies the raw channel), and that is where it belongs.
 *
 * ON A 16:9 TAKE EVERY FUNCTION HERE IS THE IDENTITY — 1920/1080, 1280/720,
 * 960/540, 2560/1440 all come back exactly. That is the whole safety net of
 * this task and it is pinned by test.
 */
import type { Recording } from './types'

/** What the product was before F13, and what an unknown take still gets. */
export const DEFAULT_FRAME_ASPECT = 16 / 9

const STORAGE_KEY = 'inout.frame.source'

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('sourceframe')
  return v === '1' ? true : v === '0' ? false : null
}

function fromStorage(): boolean | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/**
 * What `setSourceFrame` last asked for, held in the module as well as in
 * storage — a rig runs in a worker and a test runs in node, and neither has
 * localStorage. Same shape as singleGen.ts's override, and for the same
 * reason: a flag that cannot be set from the gate that proves it is a flag
 * with no evidence behind it.
 */
let override: boolean | null = null

/**
 * Does the frame follow the source on this load?
 *
 * OFF BY DEFAULT, and that is the task's own gate: "PO judges one real phone
 * take by eye before any default moves." Off, every function here answers
 * exactly what the constant answered, so a take made today is the take that was
 * made yesterday — the frozen never-break rule, with the switch as the evidence.
 *
 *   ?sourceframe=1   (this load only)
 *   localStorage['inout.frame.source'] = '1'   (sticky)
 */
export function sourceFrameEnabled(): boolean {
  return fromSearch() ?? override ?? fromStorage() ?? false
}

export function setSourceFrame(on: boolean | null): void {
  override = on
  if (on === null) return
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* storage unavailable — the in-module value above still holds */
  }
}

/**
 * Encoders want even dimensions: 4:2:0 chroma is subsampled by two on both
 * axes, and an odd side is either refused outright or silently rounded by the
 * platform — which is how two files of "the same" geometry stop being
 * packet-compatible. Round rather than floor so a derived side never collapses
 * below the shape that was asked for.
 */
export function evenDim(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

/** width/height, or null when the source never said (old takes, dead tracks). */
export function aspectOf(width?: number | null, height?: number | null): number | null {
  if (!width || !height || width <= 0 || height <= 0) return null
  return width / height
}

/**
 * The frame of the given aspect whose LONG EDGE is `longEdge`.
 *
 * Long edge, not pixel count, because that is what keeps a step's name true:
 * a 9:16 phone take at the "1080p" step is 1080x1920, which is what a phone
 * calls 1080p, and a 16:9 take is 1920x1080 to the pixel.
 */
export function frameForAspect(
  aspect: number,
  longEdge: number,
): { width: number; height: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_FRAME_ASPECT
  const long = evenDim(longEdge)
  return a >= 1
    ? { width: long, height: evenDim(long / a) }
    : { width: evenDim(long * a), height: long }
}

/**
 * THE ONE SCALE EVERY PAINTER USES. The fixed layout is authored at 1920 wide
 * (24 px margins, a 16 px corner radius, a 1.5 px border), and every one of
 * those numbers is multiplied by this. Keyed to the LONG edge rather than the
 * width, or the same PiP border would come out 44 % thinner on a portrait frame
 * than on the landscape frame it was drawn for. Identical to `width / 1920` on
 * every landscape frame, which is every frame this product made before F13.
 */
export function frameScale(width: number, height: number): number {
  return Math.max(width, height) / 1920
}

/**
 * The take's own shape.
 *
 * THE COMPOSITE ANSWERS FIRST WHEN THERE IS ONE, and that is not a detail — it
 * is what stops this function from lying about a take it did not record.
 * A composite is a FILE, written at capture with whatever shape the take had
 * then, and the default export step packet-copies it. If this returned the
 * camera's shape for a take whose composite is landscape, the panel would
 * promise a portrait export and the instant path would hand back the landscape
 * file it copied — the badge and the path disagreeing, which is the exact bug
 * shape O3c's wiring exists to make impossible. So a take made before the frame
 * followed anything stays the take it was, on any load, forever; only takes
 * recorded with the frame following the source come out that way.
 *
 * WITHOUT ONE (`?singlegen=capture`, a composite that never started, and the
 * capture-time question `session.compositeFrame` asks before any composite
 * exists) the SCREEN decides, because a screen-present take draws the screen
 * full-frame and the camera as a PiP: matching the screen leaves the
 * compositor's contain-fit nothing to letterbox, which is both the better
 * picture and what makes the single-generation copy possible. With no screen
 * the camera decides — that take IS the camera. With no video at all (the
 * audio-only waveform promise) there is no source to follow and the constant
 * stands.
 *
 * Pure and total: every unknown answers `DEFAULT_FRAME_ASPECT`, never NaN.
 */
export function takeAspect(recording: Recording): number {
  const composite = aspectOf(recording.composite?.width, recording.composite?.height)
  if (composite !== null) return composite
  const video = recording.channels.filter((c) => c.media === 'video')
  const screen = video.find((c) => c.kind === 'screen')
  const chosen = screen ?? video[0]
  return aspectOf(chosen?.width, chosen?.height) ?? DEFAULT_FRAME_ASPECT
}

/**
 * The aspect this take's output should use ON THIS LOAD — `takeAspect` behind
 * the flag. Every consumer asks this one rather than reading the flag itself,
 * so "off" is provably one code path and not a dozen.
 */
export function frameAspectFor(recording: Recording): number {
  return sourceFrameEnabled() ? takeAspect(recording) : DEFAULT_FRAME_ASPECT
}
