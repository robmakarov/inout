/**
 * THE OUTPUT FRAME RATE, DERIVED FROM THE TAKE (task F15).
 *
 * Until F15 the rate was a constant, the same shape as the 1920x1080 rule Robert
 * rejected in F13: `DEFAULT_EXPORT_SETTINGS.fps` is 30, all four quality steps
 * are `fps: 30`, both composite engines paint at 30 — and capture asked the OS
 * for `frameRate: { ideal: 30, max: 30 }`, a MAX, so a 60 fps game tab or a
 * 60 fps camera was throttled AT THE SOURCE. The justification in acquire.ts
 * was "every frame above 30 is encoded twice and then dropped at export",
 * which is only true because the export is 30. An output constant reaching
 * back to cap the input.
 *
 * RULED YES BY ROBERT 2026-08-29: "i want every device to record best quality it
 * can, 60 fps". So the rate FOLLOWS THE SOURCE up to 60 — deliberately not a
 * new 60 constant, which would rebuild the shape that was rejected.
 *
 * IT ONLY EVER GOES UP. A 24 fps webcam still records and exports at 30, as it
 * always has: the ceiling is what moved, not the floor. Following a slow source
 * DOWN would be a different change (it would shrink files, which is Robert's
 * standing objective, and it would move takes that work today), and it is not
 * this task's. Because the floor cannot move, a source at or below 30 is
 * byte-identical to what it was before this file existed — that is the whole
 * safety net, and it is pinned by test.
 *
 * WHAT IS GATED BY THE FLAG AND WHAT IS NOT. The flag governs what gets
 * RECORDED: with it off, capture asks for 30 exactly as before and every take
 * is a 30 fps take. The EXPORT side is not gated — it reads the rate out of the
 * take, and a take that holds no rate (every take made before this shipped) is
 * 30. So turning the flag off cannot strand a 60 fps file behind a 30 fps
 * export step that would have to re-render it down; a take exports at the rate
 * it was recorded at, the same sentence F13 writes about shape.
 */
import { MAX_OUTPUT_LONG_EDGE } from './frame'
import { currentQualityStep } from './qualityStep'
import { DEFAULT_EXPORT_SETTINGS, type Recording } from './types'

/** What the product was before F15, and what a take with no rate still gets. */
export const DEFAULT_FRAME_RATE = DEFAULT_EXPORT_SETTINGS.fps

/**
 * The ceiling Robert ruled for. Not a target: nothing asks a 30 fps source to
 * become this, and a source that offers less is recorded at what it offers
 * (floored at DEFAULT_FRAME_RATE — see the note above).
 */
export const MAX_FRAME_RATE = 60

/**
 * MAY THIS SURFACE BE RECORDED ABOVE 30 fps?
 *
 * THE RULE IS STRUCTURAL, and it replaces a measured pixel-rate constant that
 * was standing in for exactly the thing this product already knows: a surface
 * may run at the full rate when it is within what the product can EXPORT. Above
 * that there is no picture to protect — those pixels can never reach a file —
 * so the honest answer is to bound the SIZE (acquire.ts does, at capture) and
 * let the rate alone.
 *
 * ROBERT'S ORDER OF SACRIFICE, and it is his and not an inference: "if
 * something needs to be dropped it must be fps not resolution, but you must
 * make it work max resolution 60 fps". So resolution is never traded for rate
 * here; the only thing this function can do is decline a rate for a surface
 * that is already past the export ceiling, which after capDisplayTrack should
 * not exist. It is the belt on a track that refused to be bounded.
 *
 * WHY NOT A PIXEL-RATE NUMBER: the first version used one (2560x1440x60, the
 * largest configuration measured to sustain 60 on one machine on one evening)
 * and it held a 2560x1662 screen — the exact shape of Robert's, after the
 * export ceiling — at 30, which is the thing he had just said must work. A
 * constant from one machine cannot decide what every machine may attempt. The
 * degradation ladder decides that, from measurement, at the only time anyone
 * can: while the take is running.
 */
export function rateForSurface(
  width: number | undefined,
  height: number | undefined,
  ceiling: number,
  /**
   * What this machine's encoder MEASURED, in pixels per second, or 0 when it
   * has not been measured (encoderWarm.ts, via encoderBudget.ts). Injected
   * rather than imported so this file stays pure and the decision is testable
   * without a browser.
   */
  measuredPixelRate = 0,
): number {
  if (ceiling <= DEFAULT_FRAME_RATE) return ceiling
  if (!width || !height || width <= 0 || height <= 0) return ceiling
  // THE MACHINE ANSWERS, NOT A CONSTANT — 2026-08-30, Robert: "record froze on
  // game tab again … i need 3024x1964/60fps on my computer running easily".
  //
  // The constant below was a SIZE standing in for a CAPABILITY, and this file's
  // own header already said why that is wrong. It also had an accidental cliff
  // that his freeze fell straight through: at a 2559 long edge it allowed 60
  // and at 2561 it forced 30, so the worst case this product can produce —
  // just under the ceiling, at full rate — was the one case nothing checked.
  // And with F18 lifting the capture ceiling, it forced 30 fps at exactly the
  // resolution the flag exists to deliver.
  //
  // Measured on his machine, idle, one hardware AVC encoder: 362 Mpx/s at
  // 1080p, 410 at 2560x1662, 416 at 3024x1964, 435 at 4K. So 3024x1964@60 —
  // 356 Mpx/s — is inside what the hardware can do, and refusing it was a guess
  // overruling a fact.
  //
  // No margin is subtracted: this decides what is worth ATTEMPTING, and
  // captureLadder.ts measures the take as it runs and steps the RATE down when
  // the machine is busier than it was at mount. That is the order of sacrifice
  // Robert set — "if something needs to be dropped it must be fps not
  // resolution" — and it is the only thing that can know about a game.
  const wanted = width * height * ceiling
  if (measuredPixelRate > 0) {
    return wanted <= measuredPixelRate ? ceiling : DEFAULT_FRAME_RATE
  }
  // UNMEASURED: the old constant stands. It is a poor rule, but a machine that
  // could not be asked is not a machine to experiment on.
  return Math.max(width, height) > MAX_OUTPUT_LONG_EDGE ? DEFAULT_FRAME_RATE : ceiling
}

const STORAGE_KEY = 'inout.frame.rate'

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('sourcefps')
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
 * What `setSourceRate` last asked for, held in the module as well as in
 * storage — a rig runs in a worker and a test runs in node, and neither has
 * localStorage. Same shape as frame.ts's override, and for the same reason.
 */
let override: boolean | null = null

/**
 * Does the RATE follow the source on this load?
 *
 * OFF BY DEFAULT: F15's own gate is "one real 60 fps take judged by Robert", and
 * the throughput risk is real — a 60 fps take asks the compositor and the
 * encoder for twice the frames of the take this engine was measured on. The
 * degradation ladder is the safety net (it judges delivered against ARRIVED
 * frames since P0-ladder-static, so a 60 fps source is scored against 60 and
 * steps resolution down before delivery collapses), and it is why this ships
 * flagged rather than defaulted.
 *
 *   ?sourcefps=1   (this load only)
 *   localStorage['inout.frame.rate'] = '1'   (sticky)
 */
export function sourceRateEnabled(): boolean {
  // UI1: THE `max` STEP IS WHAT TURNS THIS ON — Robert, 2026-08-30, on what the
  // top of the slider means: "max - maximum resolution, 60 fps, all maximum".
  // F15's own gate was "one real 60 fps take judged by Robert"; the ruling
  // above is that judgement, scoped to the step where the user has explicitly
  // asked for everything. Every step below it still records at 30, which is
  // byte-identical to what this product did yesterday. `?sourcefps=0` still
  // refuses it for one load.
  return fromSearch() ?? override ?? fromStorage() ?? currentQualityStep().fps >= MAX_FRAME_RATE
}

export function setSourceRate(on: boolean | null): void {
  override = on
  if (on === null) return
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* storage unavailable — the in-module value above still holds */
  }
}

/**
 * A rate a track claims, made safe to record and encode with.
 *
 * Rounded, because capturers report 29.97 / 30.000001 / 59.94 and a fractional
 * rate turns every frame duration into a rounding error the muxer accumulates.
 * Floored at DEFAULT_FRAME_RATE and capped at MAX_FRAME_RATE, so nothing here
 * can make a take slower than the product has always been, or faster than Robert
 * ruled for. Garbage in (0, NaN, absent) answers DEFAULT_FRAME_RATE.
 */
export function normalizeRate(fps: number | null | undefined): number {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) return DEFAULT_FRAME_RATE
  return Math.min(MAX_FRAME_RATE, Math.max(DEFAULT_FRAME_RATE, Math.round(fps)))
}

/** The rate this load may record at: the ceiling, not a request. */
export function captureRateCeiling(): number {
  return sourceRateEnabled() ? MAX_FRAME_RATE : DEFAULT_FRAME_RATE
}

/**
 * The take's own rate.
 *
 * THE COMPOSITE ANSWERS FIRST, for the identical reason `takeAspect` gives:
 * that file is what the default step packet-copies, so if this returned the
 * camera's rate for a take whose composite is 30 the panel would promise a
 * 60 fps export and the copy path would hand back the 30 fps file it copied —
 * the badge and the path disagreeing. Without a composite the SCREEN decides,
 * then the camera, then the constant.
 *
 * Absent means 30 and not "unknown": every take recorded before this field
 * existed was recorded at 30, because capture asked for `max: 30` and nothing
 * downstream could exceed it. That is a fact about those files, not a guess.
 *
 * Pure and total: every unknown answers DEFAULT_FRAME_RATE, never NaN.
 */
export function takeRate(recording: Recording): number {
  if (recording.composite) return normalizeRate(recording.composite.fps)
  const video = recording.channels.filter((c) => c.media === 'video')
  const screen = video.find((c) => c.kind === 'screen')
  return normalizeRate((screen ?? video[0])?.fps)
}
