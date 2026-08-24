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
  /** How often the picture is looked at, ms — the floor on any spacing. */
  sampleIntervalMs: number
  /** Pages this take may spend. Spacing is derived from what is left of it. */
  budget: number
  /** Longest the pace may stretch, however long the recording is. */
  maxGapMs: number
  /**
   * vsPrev share that counts as MOTION: while the picture is moving this much
   * from sample to sample, the pace is suspended and every sample is a page.
   */
  motionFrac: number
  /** How long a burst keeps running after the motion stops, ms. */
  burstTailMs: number
  /**
   * Longest a burst may run before the ordinary pace takes over again.
   *
   * A UI TRANSITION IS SHORT AND A SCROLL IS NOT. Both read as motion, and on
   * PO's real take an unbounded burst rule turned 97 s into 189 pages and
   * 177k tokens — because a page being scrolled kept the pace suspended for
   * seconds at a time. Capping the burst keeps every animation (they finish
   * well inside this) and throttles anything that just keeps moving.
   */
  burstMaxMs: number
  /** A change smaller than this share of the frame gets a full-res crop. */
  cropMaxAreaFrac: number
  /** How close to the cursor's last rest a change must land to be "at cursor". */
  atCursorRadiusFrac: number
  /** Movement below this is the same place (caret blink, cursor jitter). */
  stillRadiusFrac: number
}

/**
 * Frames a take may spend, and this number is NOT ours to choose freely.
 *
 * The file exists to be uploaded to an AI, and the readers it targets cap a PDF
 * at 100 PAGES (Claude chat and API both; other assistants are in the same
 * range). A 186-page file is not a richer export, it is a rejected one. So the
 * ceiling is 100 pages minus the index, and the whole question becomes WHERE to
 * spend them — which is what the pace and the burst rule are for.
 *
 * V1 spent 60 on a 97 s take, one page every 2.5 s, and PO's verdict was "it
 * loses way too much frames": a whole sequence — typing into a field, the
 * button turning active, the click, the tab switch — fell between two pages.
 * The use is an agent RECREATING a UI and its animations, which needs the
 * moments themselves, not a summary of them.
 */
export const KEYFRAME_BUDGET = 96
const MAX_GAP_CEIL_MS = 8_000
/**
 * How far ahead of an even spend a burst may run.
 *
 * Bursts ignore the pace, so without this the first minute of an active
 * recording eats the budget and the last minute gets nothing. Twelve pages of
 * credit is enough for any single transition and small enough that the end of
 * the take is still funded.
 */
const BURST_LOOKAHEAD_PAGES = 12

/**
 * The spacing floor, recomputed after every page from what is LEFT.
 *
 * A fixed floor is wrong at both ends: it starves a short take and bankrupts a
 * long one. This spends freely while the budget is ahead of the clock — a
 * 30 s take is sampled as densely as the analysis looks — and stretches only
 * when the recording is spending faster than it can afford. Suppression is
 * never a loss: the reference frame does not advance, so a change held back is
 * the change that fires at the next allowed instant.
 */
export function paceMs(
  remainingMs: number,
  remainingBudget: number,
  sampleIntervalMs: number,
  maxGapMs = MAX_GAP_CEIL_MS,
): number {
  if (remainingBudget <= 0) return maxGapMs
  const spread = remainingMs / remainingBudget
  return Math.min(maxGapMs, Math.max(sampleIntervalMs, Math.round(spread)))
}

export function defaultSelectorConfig(sampleIntervalMs: number): SelectorConfig {
  return {
    // 1.2 % of a 160×90 grid ≈ 170 cells ≈ a 160 px square at 1080p: a menu, a
    // dialog, a scroll, a panel repainting. V1 asked for 3 % and a real UI
    // rarely changes that much at once.
    bigFrac: 0.012,
    // 0.12 % ≈ 17 cells ≈ a typed word, a button turning active, a checkbox.
    // This can sit below a cursor pair (~8-16 cells) only because the pointer
    // is MASKED OUT of the content metric — see delta.pointerMask.
    smallFrac: 0.0012,
    tinyFrac: 0.0025,
    persistSamples: 2,
    sampleIntervalMs,
    budget: KEYFRAME_BUDGET,
    maxGapMs: MAX_GAP_CEIL_MS,
    // While the picture moves this much between two looks, it is animating and
    // the pace steps aside: an animation an agent has to reproduce is exactly
    // the thing a spacing floor destroys.
    motionFrac: 0.004,
    burstTailMs: 400,
    burstMaxMs: 1200,
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
  /** Output ms the total run lasts — the pace reads what is LEFT of it. */
  durationMs: number
  /** While set, the picture is moving and the pace is suspended until this ms. */
  burstUntilMs: number | null
  /** When the current run of motion began — a burst is capped, motion is not. */
  burstStartedMs: number | null
  /**
   * Consecutive samples that moved. ONE is a discrete change (a tooltip opens,
   * a tab switches); TWO or more is something animating. Only the second kind
   * suspends the pace, or a tooltip would be treated as an animation and lose
   * the close-up that makes it readable.
   */
  movingRun: number
  /** Pages spent inside bursts — evidence that the motion rule is doing work. */
  burstPages: number
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
  /** This page is part of a motion burst — one frame of something animating. */
  inBurst: boolean
  classification: Classification
  /** Full-res crop region for this page, when the change is small enough. */
  crop: Rect | null
  /** Pointer position read out of THIS sample, if the taxonomy found one. */
  pointer: Pointer | null
  /** The emitted change landed where the cursor last rested (click inference). */
  atCursor: boolean
}

export function initSelector(
  outputDurationMs: number,
  sampleIntervalMs: number,
  config?: Partial<SelectorConfig>,
): SelectorState {
  return {
    config: { ...defaultSelectorConfig(sampleIntervalMs), ...config },
    emitted: 0,
    lastKeyframeMs: null,
    pending: null,
    pointer: null,
    still: null,
    durationMs: outputDurationMs,
    burstUntilMs: null,
    burstStartedMs: null,
    movingRun: 0,
    burstPages: 0,
  }
}

/** What the pace allows RIGHT NOW, from what is left of the take and the budget. */
export function currentPaceMs(state: SelectorState, atOutMs: number): number {
  const c = state.config
  return paceMs(
    Math.max(0, state.durationMs - atOutMs),
    c.budget - state.emitted,
    c.sampleIntervalMs,
    c.maxGapMs,
  )
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
        inBurst: false,
        classification: 'first',
        crop: null,
        pointer: null,
        atCursor: false,
      },
    }
  }

  // MOTION SUSPENDS THE PACE. Something animating is precisely what a spacing
  // floor destroys, and reproducing animation is what PO uses this file for, so
  // while the picture keeps moving between looks, every look is a page.
  const movingNow = obs.vsPrev.changedFrac >= c.motionFrac
  next.movingRun = movingNow ? state.movingRun + 1 : 0
  // One sample of change is an EVENT; a run of them is MOTION. Only motion
  // earns a burst — the difference between a menu opening (one change, worth a
  // close-up) and a menu sliding open (a sequence, worth frames).
  const moving = movingNow && next.movingRun >= 2
  if (moving) {
    next.burstUntilMs = obs.atOutMs + c.burstTailMs
    next.burstStartedMs = state.burstStartedMs ?? obs.atOutMs
  }
  const withinTail = !moving && state.burstUntilMs !== null && obs.atOutMs <= state.burstUntilMs
  if (!moving && !withinTail) {
    next.burstUntilMs = null
    next.burstStartedMs = null
  }
  // A transition is over in a fraction of a second; anything still moving after
  // the cap is a scroll or a video, and pays the ordinary pace for the rest.
  const started = next.burstStartedMs ?? state.burstStartedMs
  const burstExpired = started !== null && obs.atOutMs - started > c.burstMaxMs
  const inBurst = withinTail && !burstExpired

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
      inBurst: false,
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
  const bursting = (moving && !burstExpired) || inBurst
  let reason: KeyframeReason | null = null
  if (bursting) {
    // Inside a burst the bar is the motion itself: the picture moved since the
    // last page, so this is a frame of the movement and the agent needs it.
    if (ref.changedFrac >= c.smallFrac) reason = 'content'
    next.pending = null
  } else if (ref.changedFrac >= c.bigFrac) {
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
  // so the page fires at the next instant the pace allows. A burst ignores it —
  // that is the whole point of a burst — but still spends from the budget, so a
  // recording of continuous motion pays for itself later rather than running
  // the file to thousands of pages.
  const gap = currentPaceMs(state, obs.atOutMs)
  // WHAT MAY BE SPENT BY NOW. An even spend, plus a credit a burst can borrow
  // against — and the credit shrinks to nothing by the end of the take. Without
  // the shrink, an active opening spends the file out: measured on PO's take,
  // the budget ran dry at 84 s of 97 and the last thirteen seconds simply were
  // not in the file. A recording must be covered end to end before any part of
  // it is covered densely.
  const progress = state.durationMs > 0 ? Math.min(1, obs.atOutMs / state.durationMs) : 1
  const allowance = c.budget * progress + BURST_LOOKAHEAD_PAGES * (1 - progress)
  if (state.emitted >= Math.min(c.budget, allowance)) return deny()
  const burstNow = bursting
  if (!burstNow && state.lastKeyframeMs !== null && obs.atOutMs - state.lastKeyframeMs < gap) {
    return deny()
  }

  // No close-up inside a burst: the point of a crop is detail on a small change
  // that the 1024 px view renders too small to read, and a frame of motion has
  // no such region — it also doubled the token price of PO's real take.
  const crop = !burstNow && ref.bbox && ref.bboxAreaFrac < c.cropMaxAreaFrac ? ref.bbox : null
  const atCursor =
    !!state.pointer && !!ref.centroid && distanceFrac(state.pointer, ref.centroid) < c.atCursorRadiusFrac
  next.emitted = state.emitted + 1
  next.lastKeyframeMs = obs.atOutMs
  next.pending = null
  if (burstNow) next.burstPages = state.burstPages + 1
  return {
    state: next,
    decision: {
      keyframe: true,
      reason,
      inBurst: burstNow,
      classification: reason === 'persistent' ? 'small' : 'content',
      crop,
      pointer,
      atCursor,
    },
  }
}
