/**
 * WHEN THE DEAD-TAP RESCUE FIRES — the schedule behind measuredAudio's revival,
 * pulled out so it can be PROVED rather than argued.
 *
 * The rescue itself (rebuild the source tap on a clone of the track) shipped
 * 2026-08-26 and works: field takes show sound back within ~5 s of an attempt.
 * What it did NOT have was persistence. The shipped ladder was 5/10/20/40/80/160
 * seconds of continuous silence and then a LIFETIME CAP of six attempts per
 * silent run — after 160 s the channel was abandoned for as long as the take ran.
 *
 * THE CAP COST ROBERT 25 MINUTES (take rec_78ogcw052vdn, 2026-09-01, 50.4 min,
 * quality=max, screen 3024x1964@30 — its own black box, read off the take):
 *
 *   revive attempts at 5.2 10.2 20.2 40.2 80.2 160.2 | 194.4 199.4 209.4 229.4
 *   269.5 349.5 | 460.1 465.1 475.1 495.1 535.1 | 712.7 | 1333.4 | 1381.3
 *   1386.3 1396.3 1416.3 1456.3 1536.4 s — and then nothing, ever.
 *   No mute, no unmute, no ended, no context state change: the track stayed
 *   live and unmuted the whole time. silentTailMs 1,650,144 of a 3,026,276 ms
 *   channel — the tap died at 22.9 min and recorded pure zeros to the end.
 *
 * Read the bursts and the ladder convicts itself twice over:
 *   · the runs starting 707.7 s and 1328.4 s got ONE attempt each and no
 *     second one was ever due — sound was back within 5 s. The rescue works.
 *   · the run starting 189.4 s burned all six attempts by 349.5 s and sound
 *     came back on its own somewhere before 455.1 s — MORE THAN 105 s AFTER WE
 *     STOPPED TRYING. A run that outlives the ladder is exactly the run that
 *     needed it.
 *   · the run starting 1376.3 s burned all six by 1536.4 s. The take had 1,490
 *     more seconds to run and not one more attempt was made in them.
 *
 * So the ladder never stops climbing: it doubles while doubling is cheap and
 * then holds a fixed cadence forever. Every attempt costs one track.clone()
 * and one MediaStreamAudioSourceNode swap on a channel that is, by definition,
 * already recording nothing — the same trade the rescue was shipped on, which
 * is why the price of one a minute is worth paying for the rest of a take.
 *
 * The rule is one line — the gap to the next attempt doubles, but never exceeds
 * the ceiling — which gives 5/10/20/40/80 exactly as shipped and then 140, 200,
 * 260, … for as long as the silence lasts. The only attempt that moves rather
 * than being added is the sixth, 20 s EARLIER than before; everything this
 * changes happens on a channel that is recording nothing at the time.
 */

/** Silence before the FIRST attempt. Long enough that a real quiet passage in
 *  the content is never mistaken for a dead tap. */
export const REVIVE_BASE_SEC = 5
/** The cadence the ladder settles into. Bounds the dead air between chances at
 *  one minute instead of "the rest of the take", and costs one clone swap a
 *  minute on a channel with genuinely nothing playing. */
export const REVIVE_CEILING_SEC = 60
/**
 * B15 — how many failed rescue attempts in one silent run before the product
 * SAYS the channel is dead while the take is still running.
 *
 * The first rung is 5 s of pure digital zeros, which real music has; the second
 * is 10 s, by which point the rescue has been tried on a live, unmuted track
 * and the source is still handing over nothing. That is the shape of all three
 * field deaths, and the one shape the rescue provably cannot fix.
 */
export const SILENCE_CONVICTS_AT_ATTEMPT = 2

/**
 * One silent run's worth of scheduling state. Frames, not milliseconds: the
 * channel's timeline is sample-counted, and the caller already has both.
 */
export class ReviveSchedule {
  private readonly base: number
  private readonly ceiling: number
  private runStart: number | null = null
  private due: number
  private attemptsMade = 0
  /**
   * TOTAL pure-digital silence after the channel was first heard, frames —
   * NOT the open run.
   *
   * Robert's 71.7-minute take (`rec_yx4mi1or851p`, 2026-09-04) lost its tab
   * audio at 52.5 min and never got it back, and the card graded
   * `audio-continuity` PASS on "silent tail 1840ms (0.0%)": the tail counter
   * reads the OPEN run, and a run that is interrupted — by a revive that
   * delivered one batch, by a moment of noise — starts again from zero. Zeros
   * in the MIDDLE of a take were invisible to every counter this take carried.
   */
  private silentTotal = 0
  /** Has this channel ever carried signal? Silence BEFORE the first sound is a
   *  channel that never arrived, which is `Recording.missing`'s subject and not
   *  this one — counting it here would convict every take of a muted mic. */
  private sawSignal = false

  constructor(opts: { sampleRate: number; baseSec?: number; ceilingSec?: number }) {
    const rate = opts.sampleRate
    this.base = Math.max(1, Math.round((opts.baseSec ?? REVIVE_BASE_SEC) * rate))
    this.ceiling = Math.max(1, Math.round((opts.ceilingSec ?? REVIVE_CEILING_SEC) * rate))
    this.due = this.base
  }

  /**
   * Signal arrived, or the track unmuted. The run is over and the ladder starts
   * from the bottom — a channel that recovers must not carry a spent backoff
   * into its next death.
   */
  reset(): void {
    this.runStart = null
    this.due = this.base
    this.attemptsMade = 0
  }

  /**
   * Signal actually arrived in a batch — as opposed to `reset()`, which the
   * unmute path also calls to give a recovered track its ladder back. Only
   * this one may claim the channel has been HEARD.
   */
  noteSignal(): void {
    this.sawSignal = true
    this.reset()
  }

  /**
   * One batch of pure digital silence. `framesWritten` is where its FIRST
   * sample sits on the channel timeline, `frames` how long it is. True means an
   * attempt is due for this batch — including an attempt the caller then
   * refuses (a muted track cannot be revived from here), because a refusal is
   * still a look at the channel and must not be free.
   */
  silentBatch(framesWritten: number, frames: number): boolean {
    if (this.sawSignal) this.silentTotal += frames
    this.runStart ??= framesWritten
    if (framesWritten + frames - this.runStart < this.due) return false
    this.attemptsMade++
    this.due = Math.min(this.due * 2, this.due + this.ceiling)
    return true
  }

  /** How many attempts this run has been given. */
  get attempts(): number {
    return this.attemptsMade
  }

  /** Where the open silent run began, or null when the input has signal in it. */
  get runStartFrame(): number | null {
    return this.runStart
  }

  /** Every frame of silence since the channel was first heard — the number the
   *  open-run tail cannot see. 0 on a channel that never carried sound. */
  get silentFramesTotal(): number {
    return this.silentTotal
  }

  /** Whether this channel ever carried signal at all. */
  get heardSignal(): boolean {
    return this.sawSignal
  }

  /** Length of the open silent run at a timeline position; 0 when there is none. */
  silentFramesAt(framesWritten: number): number {
    return this.runStart === null ? 0 : Math.max(0, framesWritten - this.runStart)
  }
}
