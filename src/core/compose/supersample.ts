/**
 * O9(a) — ALIGNED SUPERSAMPLING IN THE EXPORT DRAW.
 *
 * Robert 2026-08-29: "I WANT 100% COLORS". The measured chain (green, the worst
 * channel) is raw screen 80.0 % → composite 70.3 % → render 67.3 %, and the
 * ceiling ladder (X15(e), `exp x15e`) reads 1x 80.0 · 1.5x 90.1 · 2x 94.7 ·
 * 4:4:4 99.3. Two different losses hide in those two tables and this file
 * addresses ONE of them, so nobody reads it as the whole answer:
 *
 *   THE ENCODE'S LOSS is 4:2:0 subsampling at the DELIVERY size. Nothing drawn
 *   before the encoder can undo it; that is what O9(b)'s 4:4:4 rung is for.
 *
 *   THE DRAW'S LOSS is ours, and it is what this file removes. Every source
 *   frame bigger than the output — a native-res screen channel at 3024x1964
 *   delivered at 1920x1080, which is the shipped default (`?nativeres=1`) — is
 *   MINIFIED by a single bilinear `drawImage`. A bilinear tap reads a 2x2
 *   neighbourhood when a 1.6x reduction needs the average of ~2.5x2.5, so
 *   thin coloured glyphs are sampled rather than averaged: some of their pixels
 *   are simply not read. Glyphs are a minority of the area, so what aliasing
 *   does to them is not noise — it is a systematic dilution towards the page,
 *   and `chromaRows` reads it as saturation that did not survive.
 *
 * THE FIX IS THE OLDEST ONE IN GRAPHICS: draw the whole composition into a
 * canvas an integer multiple of the output, then reduce it in one aligned step.
 * Every output pixel then averages an exact NxN block of draw pixels, which is
 * the box filter the minification wanted in the first place.
 *
 * WHY IT IS AFFORDABLE, and it is the same measurement that kept WebGPU out of
 * Phase 1: the draw is 535 ms of a 27,370 ms export loop (3600 frames,
 * native-res fixture) = 1.95 %, against 21,705 ms of encode wait. 2x linear is
 * 4x the draw — still under 8 % of the loop — and it costs the encoder NOTHING,
 * because the file that reaches the encoder is exactly the size it was.
 *
 * ALIGNED, and the word is load-bearing. A factor whose product is not a whole
 * even number of pixels puts the reduction back on a resampler with a fractional
 * phase, which is the artefact this is removing. So a factor is used only when
 * `width*f` and `height*f` are both whole and even; otherwise the next factor
 * down is tried, and 1 (today's draw, untouched) is always reachable.
 *
 * DEFAULT 1 — OFF — AND THAT IS THE TASK'S OWN GATE, not a hedge: "A/B pairs to
 * ~/Downloads for Robert's eye, and his yes before any default moves" (.ai/TASKS
 * O9). A picture change is his call (conflict rules).
 *
 *   ?ss=2      this load only        ?ss=1.5   ?ss=1 / ?ss=0 / ?ss=off  today's draw
 *   localStorage['inout.compose.ss'] = '2'     (sticky)
 * A URL parameter wins, then storage, then the default. There is a row in
 * `/?test`, which is where a switch belongs.
 *
 * The render runs in a worker with no `localStorage` and a `location` of its own
 * script URL, so this is READ ON THE MAIN THREAD and FORWARDED (pipeline.ts) —
 * the trap that left `?cq=`, `?loudness=` and `?sourceframe=` dead on the
 * shipped path for weeks.
 */

/** The factors this lever offers, biggest first — the ladder x15e measured. */
export const SUPERSAMPLE_FACTORS = [2, 1.5] as const

const STORAGE_KEY = 'inout.compose.ss'

/**
 * A DRAW CANVAS THIS PRODUCT WILL NOT ALLOCATE. 8 GB M3 (CLAUDE.md): a 2x draw
 * of a 3024x1964 source-tier export is 6048x3928 = 23.8 Mpx = 95 MB of RGBA per
 * canvas, and the export already holds decoders, the delivery canvas and the
 * muxer's scratch. The cap steps the factor DOWN rather than refusing, so the
 * lever degrades to today's draw instead of failing an export.
 */
const MAX_DRAW_PX = 16_000_000
/** Chrome's per-side canvas limit is 16384; stay well inside it. */
const MAX_DRAW_SIDE = 8192

function parse(v: string | null): number | null {
  if (v === null) return null
  if (v === 'off' || v === 'false') return 1
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  if (n <= 1) return 1
  return n
}

function fromSearch(): number | null {
  if (typeof location === 'undefined') return null
  return parse(new URLSearchParams(location.search).get('ss'))
}

function fromStorage(): number | null {
  try {
    return parse(localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

/** What the PAGE asks for. 1 = today's draw. */
export function supersampleFactor(): number {
  return fromSearch() ?? fromStorage() ?? 1
}

export function setSupersampleFactor(f: number | null): void {
  try {
    if (f === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, String(f))
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}

/** The worker has neither location nor storage: it is TOLD. */
let override: number | null = null
export function setSupersampleOverride(value: number | null): void {
  override = value
}
export function supersampleActive(): number {
  return override ?? supersampleFactor()
}

export interface SupersampleDraw {
  /** The factor actually used — asked-for, stepped down until it aligns/fits. */
  factor: number
  width: number
  height: number
}

/**
 * The draw size for an output frame, or null for "draw at the output size",
 * which is every take made before this task and is what a factor of 1 means.
 *
 * Pure, so the alignment rule is a unit test and not a screenshot.
 */
export function supersampleDraw(
  width: number,
  height: number,
  asked = supersampleActive(),
): SupersampleDraw | null {
  if (!(asked > 1) || !Number.isFinite(asked)) return null
  if (width <= 0 || height <= 0) return null
  // Try the asked-for factor, then every SMALLER rung on the ladder. A machine
  // or a frame shape that cannot take 2x still gets 1.5x rather than nothing.
  const rungs = [asked, ...SUPERSAMPLE_FACTORS.filter((f) => f < asked)]
  for (const factor of rungs) {
    const w = width * factor
    const h = height * factor
    // ALIGNED: a whole, even number of pixels on both sides, so the reduction
    // is an exact block average and the chroma grid of the delivered frame
    // lands on a whole number of draw pixels.
    if (!Number.isInteger(w) || !Number.isInteger(h) || w % 2 !== 0 || h % 2 !== 0) continue
    if (w > MAX_DRAW_SIDE || h > MAX_DRAW_SIDE) continue
    if (w * h > MAX_DRAW_PX) continue
    return { factor, width: w, height: h }
  }
  return null
}
