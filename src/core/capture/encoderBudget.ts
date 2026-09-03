/**
 * HOW MANY ENCODERS MAY A TAKE OPEN, AND AT WHAT SIZES — task O15.
 *
 * Read off Robert's own console, 2026-08-29: a screen+camera take opens THREE
 * hardware AVC encoders — the raw screen channel, the raw camera channel, and
 * the composite — and NOTHING budgets them against each other. On his take that
 * was 3024x1964 (level 5.1) + 1280x720 + 1920x1080 with a game rendering on the
 * same GPU, and the WHOLE MACHINE froze: "some movement on record but after a
 * while freezes and whole screen, not just this tab".
 *
 * The 2026-08-22 entry blamed a 4K surface consumed four times over. This is the
 * same shape one layer up, and it is why the capture ceiling
 * (CAPTURE_MAX_LONG_EDGE) is currently doing the work a budget should do: that
 * ceiling is PER TRACK and a constant, so it answers the same number whether the
 * take opens one encoder or three.
 *
 * WHY THIS IS NOT A PIXEL-RATE CONSTANT, and this file would be wrong if it
 * were. core/rate.ts already tried one and threw it out four commits before this
 * was written: 2560x1440x60, "the largest configuration measured to sustain 60
 * on one machine on one evening", held Robert's own 2560x1662 screen at 30 —
 * the exact thing he had just said must work. Its verdict is the rule here too:
 *
 *   A CONSTANT FROM ONE MACHINE CANNOT DECIDE WHAT EVERY MACHINE MAY ATTEMPT.
 *
 * But rate.ts's answer — let the degradation ladder decide from measurement,
 * while the take runs — cannot cover THIS failure, and that is the whole reason
 * O15 exists as a separate task: the collapse is instant and unrecoverable. A
 * composite that produces nothing in its first second never produces anything,
 * and Robert's machine froze past the point where a page could act at all. A
 * ladder cannot rescue what is already over.
 *
 * SO THE BUDGET IS EARNED, NEVER ASSUMED. This machine's own history is the
 * only number allowed to bound it:
 *
 *   · A take that ran to the end with no ladder step and no composite degrade
 *     RAISES `sustained` — proof this machine carries that load.
 *   · A ladder step or a composite degrade LOWERS `collapsed` — proof it does
 *     not carry that one.
 *   · With no collapse ever recorded there is NO BUDGET AT ALL and this file
 *     changes nothing. A machine is never punished for being unmeasured, and
 *     nobody's first take is bounded by someone else's hardware.
 *   · `sustained` outranks `collapsed` when they disagree: a take that WORKED is
 *     stronger evidence than an older one that did not (the same rule W1 put in
 *     the wedge ladder the same night).
 *
 * MEASURE ALWAYS, ACT ONLY BEHIND THE FLAG. Recording what a take did costs
 * nothing and changes nothing, so it runs unconditionally — which means that
 * when the flag is flipped, the machine already knows what it is capable of
 * instead of needing one more freeze to find out.
 *
 * WHAT THE REDUCTION IS ALLOWED TO BE. Only the screen channel's SIZE, decided
 * before any encoder opens, and only downwards:
 *   · it opens no new encoders (O15's gate, met by construction),
 *   · it costs no editing capability — every channel is still recorded, so
 *     nothing the editor can do today stops being possible,
 *   · and it never happens mid-take, so captureLadder.ts's rule 1 (NEVER CHANGE
 *     THE SIZE) is untouched: a frame size cannot follow a running encoder.
 * Dropping a raw channel outright, or forcing single generation, would each cost
 * a capability and each is Robert's to rule on — this file only reports what
 * they would have saved.
 *
 *   ?encoderbudget=1|0    (this load only)
 *   localStorage['inout.capture.encoderbudget']   (sticky)
 */
import { evenDown } from '../frame'

/** One hardware encoder this take intends to open. */
export interface PlannedEncoder {
  /** 'composite' is the live compositor's; the rest are raw channels. */
  what: string
  width: number
  height: number
  fps: number
}

export interface EncoderPlan {
  encoders: PlannedEncoder[]
  /** Σ w·h·fps — pixels per second across every encoder the take will open. */
  pixelRate: number
}

export function encoderPixelRate(e: PlannedEncoder): number {
  return Math.max(0, e.width) * Math.max(0, e.height) * Math.max(0, e.fps)
}

export function planOf(encoders: PlannedEncoder[]): EncoderPlan {
  return { encoders, pixelRate: encoders.reduce((n, e) => n + encoderPixelRate(e), 0) }
}

/** One line, in the console, before anything opens. This did not exist before
 *  O15: how many encoders a take opened was emergent, and nobody could read it
 *  off anything until the machine had already stopped responding. */
export function describePlan(plan: EncoderPlan): string {
  const parts = plan.encoders.map(
    (e) => `${e.what} ${e.width}x${e.height}@${Math.round(e.fps)}`,
  )
  return `${plan.encoders.length} encoder(s): ${parts.join(' + ')} = ${mpx(plan.pixelRate)} Mpx/s`
}

function mpx(pixelRate: number): string {
  return (pixelRate / 1e6).toFixed(1)
}

/**
 * How much of a known collapse we are willing to attempt again. Not a
 * measurement — a margin, and it is deliberately generous: the number it is
 * applied to is already this machine's own, and shaving a take that would have
 * been fine costs a user pixels for nothing.
 */
export const COLLAPSE_MARGIN = 0.85

/** Below this long edge a screen recording stops being worth having, so the
 *  budget stops cutting and says so instead of quietly delivering a thumbnail. */
export const REDUCTION_FLOOR_LONG_EDGE = 1280

const KEY = 'inout.encoderBudget.v1'

interface BudgetState {
  /** Highest pixel rate carried through a whole take with nothing degrading. */
  sustained: number
  /** Lowest pixel rate at which this machine has been seen to collapse. */
  collapsed: number
  collapses: number
  /**
   * What this machine's video encoder MEASURED, in Mpx/s, idle, at mount
   * (encoderWarm.ts). Unlike `sustained` and `collapsed` this needs no
   * history — it is asked directly, once per launch, so a machine knows what
   * it can attempt on its FIRST take instead of after its first freeze.
   */
  throughput: number
  /**
   * THE FRAME IT WAS MEASURED AT (B14). Mpx/s is not constant across frame
   * sizes — it rises with them (330 at 1920x1080 against ~405 at 3024x1964 on
   * one machine, prod, 2026-09-03) — so the number above means nothing without
   * this, and the take that spends it is entitled to know whether it was
   * measured under its own geometry. 0 = a reading from a build that did not
   * record it, i.e. a 1920x1080 one.
   */
  throughputW: number
  throughputH: number
}

let mem: BudgetState | null = null

function load(): BudgetState {
  if (mem) return mem
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '')
    if (parsed && typeof parsed === 'object') {
      const s = parsed as Partial<BudgetState>
      mem = {
        sustained: num(s.sustained),
        collapsed: num(s.collapsed),
        collapses: num(s.collapses) | 0,
        throughput: num(s.throughput),
        throughputW: num(s.throughputW),
        throughputH: num(s.throughputH),
      }
      return mem
    }
  } catch {
    /* absent, corrupt, or storage refused — memory-only is fine */
  }
  mem = { sustained: 0, collapsed: 0, collapses: 0, throughput: 0, throughputW: 0, throughputH: 0 }
  return mem
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(mem))
  } catch {
    /* memory-only */
  }
}

/**
 * THIS TAKE RAN AND NOTHING DEGRADED. Raises the high-water mark only — a
 * quiet take at a small size says nothing about a big one, and must not be
 * allowed to talk the machine's own proven ceiling down.
 */
export function recordEncoderSustained(pixelRate: number): void {
  if (!(pixelRate > 0)) return
  const s = load()
  if (pixelRate <= s.sustained) return
  s.sustained = pixelRate
  save()
}

/**
 * THIS TAKE COLLAPSED — the rate ladder had to step, or the composite gave up.
 * Lowers the low-water mark only: the smallest load this machine has been seen
 * to fail at is the one worth remembering, and a worse failure later at a
 * bigger size teaches nothing new.
 */
export function recordEncoderCollapse(pixelRate: number, reason: string): void {
  if (!(pixelRate > 0)) return
  const s = load()
  s.collapses += 1
  if (s.collapsed === 0 || pixelRate < s.collapsed) {
    s.collapsed = pixelRate
    console.info(
      `[capture] encoder budget: this machine collapsed at ${mpx(pixelRate)} Mpx/s (${reason}) — ` +
        `remembered, so an equal or larger take can be bounded before it starts (O15)`,
    )
  }
  save()
}

/**
 * WHAT THIS MACHINE MAY ATTEMPT, in pixels per second. 0 = no opinion, which is
 * the answer for every machine that has never collapsed, and is what makes this
 * safe to leave on: no history, no bound, exactly today's behaviour.
 *
 * A take that WORKED outranks an older one that did not, so a machine whose
 * sustained mark is above its collapse mark is never held below its own proven
 * best — the collapse is then read as a transient (a game, a build, another
 * app), which is what it usually was.
 */
export function encoderCeiling(): number {
  const s = load()
  if (s.collapsed === 0) return 0
  return Math.max(s.sustained, s.collapsed * COLLAPSE_MARGIN)
}

export interface BudgetVerdict {
  /** The screen track's new long edge. Never above what it already is. */
  screenLongEdge: number
  why: string
}

/**
 * DOES THIS PLAN FIT, AND IF NOT, WHAT IS THE SCREEN ALLOWED TO BE?
 *
 * Pure — the plan, the ceiling and the composite's geometry go in, a long edge
 * comes out — so the arithmetic is testable without a browser, which is the
 * only way it can be checked at all: the machine this matters on is the one
 * that is about to stop responding.
 *
 * TWO KINDS OF ANSWER, and the first is much better than the second:
 *
 *  1. SNAP TO THE COMPOSITE'S OWN GEOMETRY. If the screen is bigger than the
 *     picture the composite is already making, bringing it down to exactly that
 *     size cuts the raw encoder AND can make the take single-generation
 *     eligible (session.singleGenerationTake wants ch.width === frame.width) —
 *     one whole encoder gone rather than merely smaller. This is O15's own
 *     candidate "make single generation reachable by compositing at the raw
 *     channel's own geometry", arrived at from the other end.
 *  2. SCALE TO FIT. Otherwise take the largest even long edge whose plan fits
 *     under the ceiling, floored at REDUCTION_FLOOR_LONG_EDGE.
 */
/**
 * IS THE COMPOSITE WHAT PUTS THIS TAKE OVER, AND WOULD DROPPING IT HELP?
 *
 * Pure, for the same reason budgetVerdict is: the machine this matters on is
 * the one about to stop responding, so the arithmetic has to be checkable
 * without one.
 *
 * THIS IS TRIED BEFORE ANY REDUCTION IN SIZE, and the order is not a close
 * call. The composite is a DOWNSCALED SECOND COPY of a frame the raw channel
 * already holds, made by its own hardware encoder — dropping it costs no
 * picture at all, where narrowing the screen costs exactly the resolution
 * native-res exists to deliver. Spending picture before spending a redundant
 * encode would be the wrong order every time.
 *
 * Returns the lighter plan even when it is STILL over the ceiling: one encoder
 * fewer is worth having on the way to the size reduction that follows.
 */
export function dropCompositeVerdict(input: {
  plan: EncoderPlan
  ceiling: number
}): { plan: EncoderPlan; why: string } | null {
  const { plan, ceiling } = input
  if (ceiling <= 0) return null
  if (plan.pixelRate <= ceiling) return null
  if (!plan.encoders.some((e) => e.what === 'composite')) return null
  const lighter = planOf(plan.encoders.filter((e) => e.what !== 'composite'))
  return {
    plan: lighter,
    why:
      `${mpx(plan.pixelRate)} Mpx/s is over this machine's ${mpx(ceiling)} Mpx/s budget, and the ` +
      `composite is a downscaled second copy of a picture the raw channel already holds` +
      (lighter.pixelRate <= ceiling ? '' : ' — still over, so the screen is bounded too'),
  }
}

export function budgetVerdict(input: {
  plan: EncoderPlan
  ceiling: number
  /** The screen encoder inside the plan, if the take has one. */
  screen: PlannedEncoder | null
  /** The composite's geometry, so answer 1 above can be preferred. */
  compositeLongEdge: number
}): BudgetVerdict | null {
  const { plan, ceiling, screen, compositeLongEdge } = input
  if (ceiling <= 0 || !screen) return null
  if (plan.pixelRate <= ceiling) return null
  const screenLong = Math.max(screen.width, screen.height)
  if (screenLong <= REDUCTION_FLOOR_LONG_EDGE) return null

  const others = plan.pixelRate - encoderPixelRate(screen)
  const allowed = ceiling - others
  // The screen alone cannot fit under what is left. Cut it to the floor and let
  // the console say so — a bound that silently returns a postage stamp is worse
  // than one that admits the other encoders are the problem.
  if (allowed <= 0) {
    return {
      screenLongEdge: REDUCTION_FLOOR_LONG_EDGE,
      why:
        `the other encoders alone want ${mpx(others)} Mpx/s of a ${mpx(ceiling)} Mpx/s budget — ` +
        `the screen is cut to the floor and the take is still over`,
    }
  }

  // Answer 1: does the composite's own size fit? Prefer it even when a slightly
  // larger size would also fit — the equality is worth more than the pixels.
  if (compositeLongEdge > 0 && compositeLongEdge < screenLong) {
    const scale = compositeLongEdge / screenLong
    if (encoderPixelRate(screen) * scale * scale <= allowed) {
      return {
        screenLongEdge: compositeLongEdge,
        why: `snapped to the composite's own ${compositeLongEdge} long edge, which the plan fits under`,
      }
    }
  }

  // Answer 2: the largest even long edge that fits.
  const scale = Math.sqrt(allowed / encoderPixelRate(screen))
  const fitted = evenDown(Math.floor(screenLong * scale))
  const longEdge = Math.max(REDUCTION_FLOOR_LONG_EDGE, Math.min(screenLong, fitted))
  if (longEdge >= screenLong) return null
  return {
    screenLongEdge: longEdge,
    why: `${mpx(plan.pixelRate)} Mpx/s is over this machine's ${mpx(ceiling)} Mpx/s budget`,
  }
}

const FLAG_KEY = 'inout.capture.encoderbudget'

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('encoderbudget')
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
 * MAY THE BUDGET BOUND THIS TAKE?
 *
 * OFF BY DEFAULT. It changes what gets recorded on a machine with a collapse in
 * its history, which is a capture change, which is Robert's — and the task's own
 * closing gate is his take on his machine with a game running. Off, every
 * measurement still runs and every line still prints: the plan is logged, the
 * outcome is recorded, and nothing is bounded.
 */
/**
 * ON BY DEFAULT SINCE 2026-08-30, on Robert's ruling: "non max video must stop
 * fucking app record."
 *
 * It was off because it changes what gets recorded, which is a capture change,
 * which is his. He has now made it — and what it changes first is the
 * COMPOSITE, not the picture: a downscaled second copy of a frame the raw
 * channel already holds, made by its own hardware encoder, which is the third
 * encoder that freezes his game tab. Max mode already refuses it; auto mode
 * paid for it whatever the machine could carry.
 *
 * THE GUARD THAT MAKES A DEFAULT SAFE IS THE ONE THIS FILE WAS BUILT ON: a
 * machine with no collapse in its own history HAS NO BUDGET, so `encoderCeiling()`
 * is 0 and nothing is bounded. Turning this on cannot punish a machine that has
 * never failed, and it cannot import anyone else's hardware — the number is
 * earned here or it does not exist. Nobody's first take is bounded.
 *
 * `?encoderbudget=0` reverts for one load; the panel switch is sticky.
 */
export function encoderBudgetEnabled(): boolean {
  return fromSearch() ?? override ?? fromStorage() ?? true
}

export function setEncoderBudget(on: boolean | null): void {
  override = on
  try {
    if (on === null) localStorage.removeItem(FLAG_KEY)
    else localStorage.setItem(FLAG_KEY, on ? '1' : '0')
  } catch {
    /* memory-only */
  }
}

/** Test seam — module state outlives test cases. */
export function resetEncoderBudgetForTests(): void {
  mem = null
  override = null
  try {
    localStorage.removeItem(KEY)
    localStorage.removeItem(FLAG_KEY)
  } catch {
    /* memory-only */
  }
}

/**
 * WHAT THIS MACHINE'S ENCODER MEASURED, in pixels per second (encoderWarm.ts).
 *
 * Overwritten every launch rather than accumulated: it is a reading of the
 * machine as it is now, and a laptop on battery, thermally throttled, or with a
 * game already running is a different machine from the one that was measured
 * yesterday. The freshest reading is the truthful one.
 */
export function rememberEncoderThroughput(mpxPerSec: number, width = 0, height = 0): void {
  if (!(mpxPerSec > 0)) return
  const s = load()
  s.throughput = Math.round(mpxPerSec * 1e6)
  s.throughputW = width > 0 ? Math.round(width) : 0
  s.throughputH = height > 0 ? Math.round(height) : 0
  save()
}

/**
 * The pixel rate a take may ATTEMPT on this machine, or 0 when it has not been
 * measured. Distinct from `encoderCeiling()` above, which is what this machine
 * has been observed to SURVIVE — this one is what its encoder can do when
 * asked directly, and it is available before any take has ever run.
 *
 * NO MARGIN IS APPLIED, deliberately. This decides only what is worth
 * ATTEMPTING; captureLadder.ts is the thing that measures the take as it runs
 * and steps the RATE down when the machine turns out to be busier than it was
 * at mount — which is Robert's own order of sacrifice, "if something needs to
 * be dropped it must be fps not resolution". Subtracting a margin here would
 * refuse, at arm time and forever, takes the ladder can carry perfectly well.
 */
export function measuredEncoderThroughput(): number {
  return load().throughput
}

/**
 * THE READING AND THE FRAME IT WAS TAKEN AT (B14), so a caller can say which
 * and a take can carry the fact instead of the next agent inferring it.
 * `width`/`height` are 0 for a number stored by a build that measured at a
 * fixed 1920x1080 and did not write the geometry down.
 */
export function measuredEncoderReading(): { pixelRate: number; width: number; height: number } {
  const s = load()
  return { pixelRate: s.throughput, width: s.throughputW, height: s.throughputH }
}
