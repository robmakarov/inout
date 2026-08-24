/**
 * Which instants become pages, and what the cursor is (task AI1).
 *
 * A pure reducer over the delta metric: `stepSelection(state, observation)`.
 * Nothing here decodes, draws or encodes, so "dense during motion, near zero
 * when static" and "a wandering cursor is not an event" are unit-testable
 * claims rather than opinions about a video.
 *
 * TWO DIFFS, TWO QUESTIONS. Against the LAST EMITTED KEYFRAME (`vsRef`): how
 * much of the picture an agent already has is now wrong — that is what decides
 * a page. Against the PREVIOUS SAMPLE (`vsPrev`): what is moving right now —
 * that is what the cursor taxonomy reads. A cursor scores tiny on the first and
 * nonzero-but-tiny on the second, forever, which is exactly why it never earns
 * a page and can still be logged as a trail.
 *
 * THE TAXONOMY (PO raised the cursor problem: "it moves every frame but not
 * very useful all the time"):
 *   tiny + moving + transient      → cursor  · never a keyframe, feeds the trail
 *   tiny + stationary + blinking   → caret   · ignored entirely
 *   small but persistent           → content · a keyframe, cropped on it
 *   large                          → content · a keyframe as normal
 *
 * The FILTER is a threshold and ships unconditionally. The TRAIL is a
 * heuristic — reading a pointer out of pixels can be wrong — so it is measured
 * on the rig and reported either way.
 */
import { boxOverlap, distanceFrac, type Blob, type Delta, type Rect } from './delta'

export type Classification = 'first' | 'static' | 'cursor' | 'caret' | 'small' | 'content'
export type KeyframeReason = 'first' | 'content' | 'persistent'

export interface SelectorConfig {
  /** vsRef share above which a change is content on sight. */
  bigFrac: number
  /** vsRef share above which a change is worth a page IF it persists. */
  smallFrac: number
  /** vsPrev share below which a change can only be cursor/caret noise. */
  tinyFrac: number
  /** Consecutive samples a small change must survive to earn its page. */
  persistSamples: number
  /**
   * Floor on the spacing between pages. Derived from the take's own length so
   * the token bill of a long recording stays bounded (see keyframeMinGapMs) —
   * a pace, not a setting.
   */
  minGapMs: number
  /** A change smaller than this share of the frame gets a full-res crop. */
  cropMaxAreaFrac: number
  /** How close to the cursor's last rest a change must land to be "at cursor". */
  atCursorRadiusFrac: number
  /** Movement below this is the same place (caret blink, cursor jitter). */
  stillRadiusFrac: number
}

/** Pages an average take is paced towards; the length of the take does the rest. */
export const TARGET_KEYFRAMES = 60
const MIN_GAP_FLOOR_MS = 500
const MIN_GAP_CEIL_MS = 15_000

/**
 * The pacing floor, derived from the output's own duration.
 *
 * A 30 s take can afford a page every half second; a 20-minute one cannot, and
 * a fixed number would either starve the short take or bankrupt the long one.
 * Suppression is never a loss: the reference frame does not advance, so a
 * change held back is still the change that fires at the next allowed instant.
 */
export function keyframeMinGapMs(outputDurationMs: number): number {
  const paced = outputDurationMs / TARGET_KEYFRAMES
  return Math.min(MIN_GAP_CEIL_MS, Math.max(MIN_GAP_FLOOR_MS, Math.round(paced)))
}

export function defaultSelectorConfig(outputDurationMs: number): SelectorConfig {
  return {
    // 3 % of a 160×90 grid ≈ 430 cells ≈ a 260 px square at 1080p: a dialog, a
    // scroll, a switched window — never a pointer.
    bigFrac: 0.03,
    // 0.25 % ≈ 36 cells ≈ a tooltip or a menu row. A cursor pair is ~8.
    smallFrac: 0.0025,
    tinyFrac: 0.0025,
    persistSamples: 2,
    minGapMs: keyframeMinGapMs(outputDurationMs),
    cropMaxAreaFrac: 0.25,
    atCursorRadiusFrac: 0.12,
    stillRadiusFrac: 0.02,
  }
}

export interface Pointer {
  xFrac: number
  yFrac: number
  atMs: number
  /**
   * False when the reading could be the place the cursor LEFT rather than the
   * place it arrived — the first move of a take has no prior position to
   * disambiguate against. Counted, never hidden.
   */
  confident: boolean
}

export interface SelectorState {
  config: SelectorConfig
  emitted: number
  lastKeyframeMs: number | null
  /** A small change waiting to prove it is content and not a flicker. */
  pending: { bbox: Rect; samples: number } | null
  pointer: Pointer | null
  /** A tiny change that keeps happening in one place — a blinking caret. */
  still: { at: { xFrac: number; yFrac: number }; samples: number } | null
}

export interface SampleObservation {
  index: number
  /** Output-timeline ms of this sample (what we iterate). */
  atOutMs: number
  /** Recording-epoch ms of the same instant (what every timestamp is stated in). */
  atRecMs: number
  /** Against the last emitted keyframe. */
  vsRef: Delta
  /** Against the previous sample. */
  vsPrev: Delta
  /** Connected components of vsPrev — empty when the change is too big to be a pointer. */
  blobsVsPrev: Blob[]
}

export interface Decision {
  keyframe: boolean
  reason: KeyframeReason | null
  classification: Classification
  /** Full-res crop region for this page, when the change is small enough. */
  crop: Rect | null
  /** Pointer position read out of THIS sample, if the taxonomy found one. */
  pointer: Pointer | null
  /** The emitted change landed where the cursor last rested (click inference). */
  atCursor: boolean
}

export function initSelector(outputDurationMs: number, config?: Partial<SelectorConfig>): SelectorState {
  return {
    config: { ...defaultSelectorConfig(outputDurationMs), ...config },
    emitted: 0,
    lastKeyframeMs: null,
    pending: null,
    pointer: null,
    still: null,
  }
}

/**
 * Read a pointer position out of a tiny change.
 *
 * A cursor that moved leaves two marks: where it was and where it is. Which is
 * which is decided by the previous reading — the vacated blob is the one AT the
 * old position, so the new one is the other. With no previous reading the
 * answer is a coin flip between two blobs, and that is reported as
 * `confident: false` rather than smoothed over.
 */
function readPointer(blobs: Blob[], previous: Pointer | null, still: number): Pointer | null {
  if (blobs.length === 0 || blobs.length > 3) return null
  if (blobs.length === 1) {
    // One mark: the cursor appeared, vanished, or is blinking in place. Only
    // useful as a position when it is not the caret case.
    if (still >= 2) return null
    const b = blobs[0]!
    return { ...b.centroid, atMs: 0, confident: previous !== null }
  }
  if (!previous) {
    const b = blobs[0]!
    return { ...b.centroid, atMs: 0, confident: false }
  }
  let best = blobs[0]!
  let bestDist = -1
  for (const b of blobs) {
    const d = distanceFrac(b.centroid, previous)
    if (d > bestDist) {
      bestDist = d
      best = b
    }
  }
  return { ...best.centroid, atMs: 0, confident: true }
}

export function stepSelection(
  state: SelectorState,
  obs: SampleObservation,
): { state: SelectorState; decision: Decision } {
  const c = state.config
  const next: SelectorState = { ...state }

  // The first sample is always a page: an agent with no picture at all cannot
  // be told what changed.
  if (state.emitted === 0 && state.lastKeyframeMs === null) {
    return {
      state: { ...next, emitted: 1, lastKeyframeMs: obs.atOutMs, pending: null },
      decision: {
        keyframe: true,
        reason: 'first',
        classification: 'first',
        crop: null,
        pointer: null,
        atCursor: false,
      },
    }
  }

  // ---- the taxonomy, on the instantaneous diff -----------------------------
  let classification: Classification = 'static'
  let pointer: Pointer | null = null
  const tinyNow = obs.vsPrev.cells > 0 && obs.vsPrev.changedFrac < c.tinyFrac
  if (tinyNow) {
    const centroid = obs.vsPrev.centroid
    const stillHere =
      state.still && centroid && distanceFrac(state.still.at, centroid) < c.stillRadiusFrac
    next.still = stillHere
      ? { at: state.still!.at, samples: state.still!.samples + 1 }
      : centroid
        ? { at: centroid, samples: 1 }
        : null
    // Blinking in one place is a caret: it is not where anything is happening.
    if (next.still && next.still.samples >= 3 && obs.blobsVsPrev.length <= 1) {
      classification = 'caret'
    } else {
      classification = 'cursor'
      const read = readPointer(obs.blobsVsPrev, state.pointer, next.still?.samples ?? 0)
      if (read) {
        pointer = { ...read, atMs: obs.atRecMs }
        next.pointer = pointer
      }
    }
  } else if (obs.vsPrev.cells > 0) {
    next.still = null
    classification = obs.vsPrev.changedFrac >= c.bigFrac ? 'content' : 'small'
  } else {
    next.still = null
  }

  const deny = (): { state: SelectorState; decision: Decision } => ({
    state: next,
    decision: {
      keyframe: false,
      reason: null,
      classification,
      crop: null,
      pointer,
      atCursor: false,
    },
  })

  // A cursor or a caret is never a page, whatever the accumulated diff says.
  // This is the taxonomy's own rule and not a side effect of the threshold, so
  // an unusually large pointer cannot buy itself a page.
  if (classification === 'cursor' || classification === 'caret') {
    next.pending = null
    return deny()
  }

  // ---- the page decision, on the diff against what the agent already has ---
  const ref = obs.vsRef
  let reason: KeyframeReason | null = null
  if (ref.changedFrac >= c.bigFrac) {
    reason = 'content'
    next.pending = null
  } else if (ref.changedFrac >= c.smallFrac && ref.bbox) {
    const carried =
      state.pending && boxOverlap(state.pending.bbox, ref.bbox) >= 0.3
        ? state.pending.samples + 1
        : 1
    next.pending = { bbox: ref.bbox, samples: carried }
    if (carried >= c.persistSamples) reason = 'persistent'
  } else {
    next.pending = null
  }
  if (!reason) return deny()

  // Pace: a change held back keeps its evidence (the reference has not moved),
  // so the page fires at the next instant the pace allows.
  if (state.lastKeyframeMs !== null && obs.atOutMs - state.lastKeyframeMs < c.minGapMs) {
    return deny()
  }

  const crop = ref.bbox && ref.bboxAreaFrac < c.cropMaxAreaFrac ? ref.bbox : null
  const atCursor =
    !!state.pointer && !!ref.centroid && distanceFrac(state.pointer, ref.centroid) < c.atCursorRadiusFrac
  next.emitted = state.emitted + 1
  next.lastKeyframeMs = obs.atOutMs
  next.pending = null
  return {
    state: next,
    decision: {
      keyframe: true,
      reason,
      classification: reason === 'persistent' ? 'small' : 'content',
      crop,
      pointer,
      atCursor,
    },
  }
}
