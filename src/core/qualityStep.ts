/**
 * THE ONE QUALITY CHOICE, MADE BEFORE THE TAKE (task UI1).
 *
 * Robert, 2026-08-30: "make chatgpt/claudecode effort-like slider for our
 * quality choosing … make it not possible to choose higher quality that was
 * choosen before start of record to save resources on other processes".
 *
 * Quality used to be TWO decisions that could not see each other: capture ran
 * at whatever the source offered (STATE's "capture is at the source's own
 * resolution"), and the export ladder was picked afterwards out of
 * `compose/quality.ts`. So the expensive half — the encoders that run while the
 * take is live — was never told what the user actually wanted, and a user who
 * only ever exports 720p still paid 3024x1964 of encoder for every second of
 * every take.
 *
 * This file is the single ceiling both halves read. It is a CEILING and not a
 * target: a 720p webcam recorded at the 1440p step is still a 720p take,
 * exactly as it always was. Nothing here ever asks a source for more than it
 * has.
 *
 * WHAT EACH STEP BINDS, and they are the flags F15/F18 already built rather
 * than new machinery:
 *   · `frame.captureCeilingLongEdge()` — the long edge capture may ask for.
 *   · `frame.sourceResEnabled()` — max only: the source's own resolution.
 *   · `rate.captureRateCeiling()` — max only: 60 fps (Robert's ruling for this
 *     step, 2026-08-30: "max - maximum resolution, 60 fps, all maximum").
 *   · `compose/quality.tiersForTake()` — the export ladder stops here.
 *
 * THE TAKE CARRIES THE STEP IT WAS RECORDED UNDER (`Recording.qualityStep`), so
 * a take opened from the takes list is capped by what was chosen for IT and not
 * by where the slider happens to sit now. A take with no step recorded — every
 * take made before this existed — is uncapped, which is exactly the behaviour
 * those files were made under.
 *
 *   ?qstep=540p|720p|1080p|1440p|max     (this load only)
 *   localStorage['inout.quality.step']   (sticky — the slider writes it)
 */

export type QualityStepId = '540p' | '720p' | '1080p' | '1440p' | 'max'

export interface QualityStep {
  id: QualityStepId
  /** What the slider says. */
  label: string
  /**
   * The long edge capture may ask for, px. `Infinity` is "the source's own",
   * and callers putting this in a constraint MUST check `Number.isFinite`
   * first: `{ max: Infinity }` is not a constraint, it is a bug.
   */
  longEdge: number
  /** The frame-rate ceiling this step records at. */
  fps: number
  /** One line under the slider — what this step costs and what it buys. */
  note: string
}

/**
 * FIVE STEPS, AND THEY ARE THE EXPORT LADDER'S OWN. `compose/quality.ts`
 * measured those four rungs 35-95 % apart in file size (F7b) and rejected the
 * ones whose numbers were noise; there is no second opinion about what a step
 * is worth having. `max` is F18's source step, which has no size of its own
 * because it is a different number on every machine.
 */
export const QUALITY_STEPS: QualityStep[] = [
  {
    id: '540p',
    label: '540p',
    longEdge: 960,
    fps: 30,
    note: 'Smallest files and the lightest take. Screen text will be soft.',
  },
  {
    id: '720p',
    label: '720p',
    longEdge: 1280,
    fps: 30,
    note: 'Small files, easy on the machine. Fine for a talking head.',
  },
  {
    id: '1080p',
    label: '1080p',
    longEdge: 1920,
    fps: 30,
    note: 'The balance: sharp enough to read code, light enough to record anything.',
  },
  {
    id: '1440p',
    label: '1440p',
    longEdge: 2560,
    fps: 30,
    note: 'Crisp screen text. Bigger files and more work for the encoder.',
  },
  {
    id: 'max',
    label: 'Max',
    longEdge: Number.POSITIVE_INFINITY,
    fps: 60,
    note: 'Your screen’s own resolution at 60 fps, nothing held back. Heaviest on the machine.',
  },
]

export const DEFAULT_QUALITY_STEP: QualityStepId = '1080p'

const ORDER: QualityStepId[] = QUALITY_STEPS.map((s) => s.id)

export function isQualityStepId(v: unknown): v is QualityStepId {
  return typeof v === 'string' && (ORDER as string[]).includes(v)
}

export function qualityStepById(id: string | null | undefined): QualityStep {
  return QUALITY_STEPS.find((s) => s.id === id) ?? QUALITY_STEPS.find((s) => s.id === DEFAULT_QUALITY_STEP)!
}

/** Where a step sits on the ladder — 0 is the smallest. Unknown ids read as the default's. */
export function qualityStepIndex(id: string | null | undefined): number {
  const i = ORDER.indexOf(id as QualityStepId)
  return i >= 0 ? i : ORDER.indexOf(DEFAULT_QUALITY_STEP)
}

/** Is `id` at or below `ceiling`? The whole of what "no higher than you chose" means. */
export function stepAtOrBelow(id: string | null | undefined, ceiling: string | null | undefined): boolean {
  return qualityStepIndex(id) <= qualityStepIndex(ceiling)
}

const STORAGE_KEY = 'inout.quality.step'

function fromSearch(): QualityStepId | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('qstep')
  return isQualityStepId(v) ? v : null
}

function fromStorage(): QualityStepId | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isQualityStepId(v) ? v : null
  } catch {
    return null
  }
}

/**
 * Held in the module as well as in storage — a rig runs in a worker and a test
 * runs in node, and neither has localStorage. Same shape as frame.ts's
 * override, and for the same reason.
 */
let override: QualityStepId | null = null

/** The ceiling this load records and exports under. */
export function loadQualityStep(): QualityStepId {
  return fromSearch() ?? override ?? fromStorage() ?? DEFAULT_QUALITY_STEP
}

export function setQualityStep(id: QualityStepId | null): void {
  override = id
  try {
    if (id === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, id)
  } catch {
    /* memory-only — the in-module value above still holds this load */
  }
}

/** The step object for this load. */
export function currentQualityStep(): QualityStep {
  return qualityStepById(loadQualityStep())
}
