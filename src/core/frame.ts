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
 * every shape, and Robert's standing "minimal size" objective is not quietly
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

/**
 * THE LARGEST PICTURE THIS PRODUCT CAN DELIVER — the long edge of the biggest
 * export step (1440p). Nothing above it can ever reach a file, so nothing above
 * it is worth capturing, encoding, writing to disk, or downscaling on every
 * composite tick. Tied to QUALITY_TIERS by test.
 *
 * It is the bound on CAPTURE (acquire.ts) and the bound on what may be recorded
 * at 60 fps (rate.ts), and those are the same question asked twice: what can
 * this product actually hand back?
 */
export const MAX_OUTPUT_LONG_EDGE = 2560

const SOURCE_RES_KEY = 'inout.frame.sourceres'

function sourceResFromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('sourceres')
  return v === '1' ? true : v === '0' ? false : null
}

function sourceResFromStorage(): boolean | null {
  try {
    const v = localStorage.getItem(SOURCE_RES_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

let sourceResOverride: boolean | null = null

/**
 * DOES THE OUTPUT GO ALL THE WAY UP TO THE USER'S OWN SCREEN? — task F18,
 * Robert: "i want 3024x1964 or whatever users resolution is on roadmap".
 *
 * The ladder stopped at 1440p for INHERITED reasons, not decided ones: F7/F7b
 * chose 540p/720p/1080p/1440p by measured file-size separation on a product
 * whose capture was hard-capped at 1080p, O6 later made the 1440p step real
 * detail, and nobody asked what sits above it. MAX_OUTPUT_LONG_EDGE above is
 * one constant bounding both the ladder and capture, so lifting it lifts both.
 *
 * OFF BY DEFAULT, and the task itself says why: capturing 3024x1964 instead of
 * 2560x1662 is 40 % more pixels through the encoders O15 just finished counting,
 * which is exactly where Robert's freeze lived. Behind a flag the cost is his to
 * find rather than everyone's. `?encoderbudget=1` is its companion — that one
 * bounds a machine that has already been seen to collapse.
 */
export function sourceResEnabled(): boolean {
  return sourceResFromSearch() ?? sourceResOverride ?? sourceResFromStorage() ?? false
}

export function setSourceRes(on: boolean | null): void {
  sourceResOverride = on
  try {
    if (on === null) localStorage.removeItem(SOURCE_RES_KEY)
    else localStorage.setItem(SOURCE_RES_KEY, on ? '1' : '0')
  } catch {
    /* memory-only */
  }
}

/**
 * THE LONG EDGE CAPTURE MAY NOT EXCEED on this load. Infinity means "the
 * source's own size" — not a bigger constant, because a constant is what F18
 * exists to remove. Callers must check `Number.isFinite` before putting it in a
 * constraint: `{ max: Infinity }` is not a constraint, it is a bug.
 */
export function captureCeilingLongEdge(): number {
  return sourceResEnabled() ? Number.POSITIVE_INFINITY : MAX_OUTPUT_LONG_EDGE
}

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
 * A DEVICE THAT CANNOT CAPTURE A SCREEN IS A PHONE, and on a phone the
 * landscape constant is never the right answer.
 *
 * OFF on a desktop: the shipped 16:9 behaviour is what every take was made
 * under, and Robert has not yet judged the new one, so nothing moves there.
 * ON where `getDisplayMedia` does not exist at all — the only take such a
 * device can make is camera-only, its camera is held portrait, and the frame it
 * was being handed is a landscape box that crops 68 % of the picture away.
 * There is no working path to protect there; Robert has now reported that same
 * failure twice ("how the fuck mobile will make 1920x1080? its vertical", then
 * "it is still fucking horizontal on phone"). `?sourceframe=0` turns it off.
 */
function phoneDefault(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia !== 'function'
  )
}

/**
 * Does the frame follow the source on this load?
 *
 *   ?sourceframe=1 / ?sourceframe=0   (and it sticks — see below)
 *   localStorage['inout.frame.source']
 */
export function sourceFrameEnabled(): boolean {
  const url = fromSearch()
  if (url !== null) {
    // THIS ONE FLAG STICKS WHEN IT COMES FROM THE URL, against the convention
    // every other switch here follows. The reason is the device it exists for:
    // it is turned on from a PHONE, where there is no console to set
    // localStorage from, and a reload (a PWA relaunch, a wedge recovery) would
    // silently put the take back to landscape between recording and judging it.
    // `?sourceframe=0` turns it off the same way, so the contract stays
    // symmetric and reversible.
    if (url !== (fromStorage() ?? phoneDefault())) setSourceFrame(url)
    return url
  }
  return override ?? fromStorage() ?? phoneDefault()
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

/**
 * The same evenness rule, but never rounding UP — the size a real, arriving
 * picture can be encoded at.
 *
 * `evenDim` rounds to nearest because it DERIVES a side from an aspect and a
 * budget, where landing a pixel short of what was asked for is the worse
 * error. This one is handed an actual frame, and there the worse error is the
 * other way: asking an encoder for a row that the source does not have.
 * Rounding down crops at most one row and one column of a real picture, which
 * is what every encoder on earth does with an odd side — when it does not
 * simply refuse.
 *
 * IT EXISTS BECAUSE THE REFUSAL IS REAL AND IT COST A TAKE ITS SCREEN. AVC
 * cannot encode an odd side; native-res capture (default 2026-08-29) hands the
 * raw channel the MONITOR's own size; and a Mac in a scaled display mode
 * reports odd sizes — 1728x1117 is a stock "More Space" mode. Reproduced on
 * prod: `?synthetic=1&screensize=1728x1117` gives `rawVideo: no supported AVC
 * VideoEncoder config`, the MediaRecorder fallback writes nothing either, and
 * the take comes back "Missing from this take: Screen" with the preview having
 * shown the screen the whole time.
 */
export function evenDown(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2)
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
 * THE SHAPE A DELIVERED PICTURE ASKS FOR, or null when it asks for nothing.
 *
 * THE BUG THIS EXISTS FOR: `MediaStreamTrack.getSettings()` describes the
 * SENSOR. On a phone held portrait it reports 1920x1080 while every frame that
 * arrives is 1080x1920, rotated by the platform. Capture believed the settings,
 * so a phone take was composited into a landscape canvas and cover-cropped, and
 * the editor then cropped the raw portrait channel a second time into the same
 * landscape stage — Robert, having judged exactly that: "preview on phone still
 * wrong proportions and cutted and in editing even more cutted".
 *
 * So the settings are a GUESS and the first frame is the ANSWER. Null means
 * "the guess was right" — which it is on every desktop take, where the two have
 * always agreed, so this can only ever fire where something was already wrong.
 */
export function adoptedFrame(
  current: { width: number; height: number },
  arrived: { width: number; height: number },
  longEdge: number,
): { width: number; height: number } | null {
  if (!arrived.width || !arrived.height || arrived.width <= 0 || arrived.height <= 0) return null
  const want = frameForAspect(arrived.width / arrived.height, longEdge)
  return want.width === current.width && want.height === current.height ? null : want
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
 * THE BIGGEST PICTURE THIS TAKE ACTUALLY HOLDS — task F18's top step.
 *
 * Deliberately NOT `takeAspect`'s composite-first rule, and the difference is
 * the whole point: the composite is written at COMPOSITE_WIDTH (1920) whatever
 * the screen was, so asking it would answer 1920 for a 3024-wide take and the
 * source step would be a step to nowhere. The raw channel is where the take's
 * own resolution actually lives, and O3c's packet copy is what delivers it.
 *
 * THE SCREEN DECIDES where there is one, for the same reason it decides the
 * aspect: a screen-present take draws the screen full-frame. With no screen the
 * camera decides — that take IS the camera.
 *
 * Returns 0 when there is nothing to follow, which every caller reads as "this
 * take has no source step".
 */
export function takeLongEdge(recording: Recording): number {
  const video = recording.channels.filter((c) => c.media === 'video')
  const screen = video.find((c) => c.kind === 'screen')
  const chosen = screen ?? video[0]
  const w = chosen?.width ?? 0
  const h = chosen?.height ?? 0
  if (!(w > 0) || !(h > 0)) return 0
  return Math.max(w, h)
}

/**
 * The aspect this take's output should use ON THIS LOAD — `takeAspect` behind
 * the flag. Every consumer asks this one rather than reading the flag itself,
 * so "off" is provably one code path and not a dozen.
 */
export function frameAspectFor(recording: Recording): number {
  return sourceFrameEnabled() ? takeAspect(recording) : DEFAULT_FRAME_ASPECT
}
