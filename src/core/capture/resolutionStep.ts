/**
 * A RESOLUTION STEP A RAW CHANNEL CAN FOLLOW — task O16, from Robert's own
 * question: "why resolution cannot go safely, make it go up safely too".
 *
 * THE ANSWER IS THAT IT CAN, AND THE MACHINERY ALREADY EXISTS. What could not
 * work is what used to ship: a raw channel's VideoEncoder is configured ONCE and
 * an MP4 track carries ONE frame size in its sample description, so a mid-file
 * size change is not representable. captureLadder.ts therefore moves only the
 * RATE now, and its own header records what the old resolution steps actually
 * did — Chrome UPSCALED every frame back to the configured size, straight out of
 * Robert's console: `display stepped 3024x1964@30 → 2217x1440@30` and then, at
 * stop, `screen channel recorded 3024x1964 (the track said 2217x1440)`. The step
 * cost more than it saved.
 *
 * BUT A CHANNEL IS ALREADY ALLOWED SEVERAL RECORDINGS. F6 built exactly this for
 * pause/resume: closeSegment ends the current file and keeps the device, resume
 * opens segment N+1 on the SAME track with its own startOffsetMs, and the
 * timeline and the render already compose a kind that appears as several
 * non-overlapping segments (core/types.ts says so in the setChannelActive
 * contract). A resolution step is that move without the gap: close the segment,
 * reopen at the new size.
 *
 * WHAT THIS IS *NOT*, and the distinction is Robert's own ruling: it is NOT a
 * load ladder. "If something needs to be dropped it must be fps not resolution,
 * but you must make it work max resolution 60 fps" — so backpressure is still
 * captureLadder's, still rate-only, and nothing here fires because the machine
 * is busy. What fires here is the SOURCE ITSELF CHANGING SIZE: the user changes
 * display resolution, or resizes the shared window, mid-take. Today that is the
 * upscaling bug above, silently, in every take it happens in.
 *
 * THE COST, STATED: a raw channel with two segments of different geometry cannot
 * be packet-copied as one file, so the take's own-resolution export (F18's
 * source step, O3c's single generation) declines for a stepped take. It DECLINES
 * rather than lies, which is the gate. The default-tier instant export is
 * unaffected — that one copies the composite, which is one continuous file at
 * one size throughout, so the common case keeps its instant path. That is a
 * smaller cost than the task assumed.
 *
 * This file is the DECISION only, and pure, because the thing it has to get
 * right is not the file surgery — it is not thrashing. A window being dragged to
 * a new size emits a continuous stream of sizes, and a segment per size would
 * shred the take into hundreds of files.
 */

/** What the encoder for the current segment was configured with. */
export interface SegmentGeometry {
  width: number
  height: number
}

export interface StepInput {
  /** What the encoder is currently writing. */
  current: SegmentGeometry
  /** What the track is delivering right now. */
  observed: SegmentGeometry | null
  /** performance.now(). */
  nowMs: number
  /** When `observed` first differed from `current` by more than the threshold.
   *  Null when it has not differed. */
  differingSinceMs: number | null
  /** When the last step completed, so a step cannot immediately cause another. */
  lastStepAtMs: number | null
  /** Segments opened so far on this channel, this take. */
  stepsTaken: number
}

/**
 * How long the new size has to hold still before a segment is spent on it.
 *
 * A window drag emits sizes continuously; a display-mode change settles at once.
 * 1.5 s is long enough that a drag produces ONE step at the size the user let go
 * at, and short enough that a real change is followed while the take is still
 * about the same thing.
 */
export const SETTLE_MS = 1_500

/** No two steps closer together than this, whatever the source does. */
export const COOLDOWN_MS = 5_000

/**
 * A hard stop on how much of a take can be spent stepping. A source that
 * oscillates forever must cost a bounded number of files, not an unbounded one —
 * after this the channel keeps the size it has and the composite carries the
 * change, exactly as it did before this task.
 */
export const MAX_STEPS_PER_TAKE = 8

/**
 * Ignore changes below this, in either dimension. Capturers report jitter of a
 * pixel or two, and `evenDown` in the capture path can legitimately move a side
 * by one — a segment boundary is far too expensive to spend on that.
 */
export const MIN_DELTA_PX = 16

export function differsMeaningfully(a: SegmentGeometry, b: SegmentGeometry | null): boolean {
  if (!b) return false
  if (!(b.width > 0) || !(b.height > 0)) return false
  return Math.abs(a.width - b.width) >= MIN_DELTA_PX || Math.abs(a.height - b.height) >= MIN_DELTA_PX
}

export interface StepVerdict {
  /** The geometry the next segment should be opened at. */
  to: SegmentGeometry
  why: string
}

/**
 * Should the screen channel close its segment and reopen at the observed size?
 *
 * Null means no, which is the answer on the overwhelming majority of ticks — a
 * source that is not changing size never reaches the settle clause at all.
 */
export function stepVerdict(input: StepInput): StepVerdict | null {
  const { current, observed, nowMs, differingSinceMs, lastStepAtMs, stepsTaken } = input
  if (!observed) return null
  if (!differsMeaningfully(current, observed)) return null
  if (stepsTaken >= MAX_STEPS_PER_TAKE) return null
  if (lastStepAtMs !== null && nowMs - lastStepAtMs < COOLDOWN_MS) return null
  if (differingSinceMs === null || nowMs - differingSinceMs < SETTLE_MS) return null
  const bigger = observed.width * observed.height > current.width * current.height
  return {
    to: { width: observed.width, height: observed.height },
    why:
      `the source is ${observed.width}x${observed.height} and this segment was opened at ` +
      `${current.width}x${current.height} — ${bigger ? 'following it UP' : 'following it down'}, ` +
      `held for ${Math.round((nowMs - differingSinceMs) / 100) / 10}s`,
  }
}

const FLAG_KEY = 'inout.capture.resstep'

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('resstep')
  return v === '1' ? true : v === '0' ? false : null
}

function fromStorage(): boolean | null {
  try {
    const v = localStorage.getItem(FLAG_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

let override: boolean | null = null

/**
 * OFF BY DEFAULT. It changes the FILES a take produces — a stepped take has two
 * screen segments where it used to have one — and the O3c/F18 native copy
 * declines on it. That is a capture change and capture changes are Robert's.
 * Off, `stepVerdict` is never consulted and a take is exactly the take it was.
 */
export function resolutionStepEnabled(): boolean {
  return fromSearch() ?? override ?? fromStorage() ?? false
}

export function setResolutionStep(on: boolean | null): void {
  override = on
  try {
    if (on === null) localStorage.removeItem(FLAG_KEY)
    else localStorage.setItem(FLAG_KEY, on ? '1' : '0')
  } catch {
    /* memory-only */
  }
}
