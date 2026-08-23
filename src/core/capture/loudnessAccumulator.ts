/**
 * Capture-time loudness of the certified mix (task O2).
 *
 * Every export — including the "instant" one — used to decode ALL audio twice:
 * a throwaway mixer pass purely to measure loudness, then the real render. That
 * makes instant export O(duration) for no reason: the same samples already flow
 * through the capture worklet once, live.
 *
 * This accumulates the identical statistic (true peak, p90 and p20 of 100 ms
 * window RMS over the mono fold) on the SUM of the measured channels, aligned
 * on the session timeline. It sums at UNITY gain: the export's per-channel mix
 * gain is a constant factor, so peak/loudRms/floorRms all scale by it
 * afterwards and one accumulation serves any channel count.
 *
 * Alignment: channels deliver PCM independently, so frames are summed in a
 * ring covering `capacitySec` of skew and only folded once EVERY registered
 * channel has passed them. A channel that falls further behind than the ring
 * (i.e. died) stops holding the fold back; that marks the run degraded rather
 * than stalling the accumulator forever.
 */

const DEFAULT_CAPACITY_SEC = 2
/** 100 ms windows, matching compose/audio's LOUDNESS_WINDOW_FRAMES at 48 kHz. */
const WINDOW_SEC = 0.1

export interface AccumulatedLoudness {
  channelIds: string[]
  peak: number
  loudRms: number
  floorRms: number
  frames: number
  /** A channel lagged out of the alignment ring; its tail is missing from the sum. */
  degraded: boolean
}

export class MixLoudnessAccumulator {
  private readonly windowFrames: number
  private readonly capacity: number
  private readonly sumL: Float32Array
  private readonly sumR: Float32Array
  /** Absolute frame index of the oldest not-yet-folded frame. */
  private base = 0
  private readonly delivered = new Map<string, number>()
  /** First session frame each channel delivered — sets the window grid origin. */
  private readonly firstFrame = new Map<string, number>()
  /**
   * Folding waits until every registered channel has delivered once, so the
   * 100 ms window grid can start at the EARLIEST media — the same origin the
   * export's probe uses (output t=0). Starting the grid at the session epoch
   * instead put the windows out of phase with the probe's, which on a strongly
   * modulated signal moved p90 by ~0.5 dB.
   */
  private gridReady = false
  private peak = 0
  private winSumSq = 0
  private winCount = 0
  private readonly windowRms: number[] = []
  private folded = 0
  private degraded = false
  private finished = false

  constructor(opts: { sampleRate: number; capacitySec?: number }) {
    const rate = opts.sampleRate
    this.windowFrames = Math.max(1, Math.round(WINDOW_SEC * rate))
    this.capacity = Math.max(this.windowFrames * 4, Math.round((opts.capacitySec ?? DEFAULT_CAPACITY_SEC) * rate))
    this.sumL = new Float32Array(this.capacity)
    this.sumR = new Float32Array(this.capacity)
  }

  /** Declare a channel before it delivers: the fold waits for every registrant. */
  register(channelId: string): void {
    if (!this.delivered.has(channelId)) this.delivered.set(channelId, 0)
  }

  get channelIds(): string[] {
    return [...this.delivered.keys()]
  }

  /** Registered channels that actually delivered PCM. */
  contributed(): string[] {
    return [...this.delivered.entries()].filter(([, d]) => d > 0).map(([id]) => id)
  }

  /**
   * Add one channel's PCM. `startFrame` is that channel's frame index on the
   * SESSION timeline (channel-local index + its start offset in frames).
   * `right` may alias `left` for mono sources.
   */
  add(channelId: string, left: Float32Array, right: Float32Array, startFrame: number): void {
    if (this.finished) return
    this.register(channelId)
    const n = Math.min(left.length, right.length)
    if (n <= 0) {
      this.delivered.set(channelId, Math.max(this.delivered.get(channelId) ?? 0, startFrame))
      return
    }

    if (!this.firstFrame.has(channelId)) this.firstFrame.set(channelId, startFrame)
    if (!this.gridReady && this.firstFrame.size === this.delivered.size) this.openGrid()

    // Make room: fold forward until this batch fits inside the ring. Frames a
    // slower channel has not reached yet get folded without its contribution.
    const needBase = startFrame + n - this.capacity
    if (needBase > this.base) {
      // A registered channel never delivered (died during arming) — stop
      // waiting for it rather than stalling the fold for the whole take.
      if (!this.gridReady) this.openGrid()
      this.foldTo(needBase)
      this.degraded = true
    }

    // Frames older than the ring are already folded — they cannot be added.
    const skip = Math.max(0, this.base - startFrame)
    if (skip > 0) this.degraded = true
    for (let i = skip; i < n; i++) {
      const idx = (startFrame + i) % this.capacity
      this.sumL[idx] += left[i]!
      this.sumR[idx] += right[i]!
    }

    this.delivered.set(channelId, Math.max(this.delivered.get(channelId) ?? 0, startFrame + n))
    if (!this.gridReady) return
    let min = Infinity
    for (const d of this.delivered.values()) if (d < min) min = d
    if (Number.isFinite(min)) this.foldTo(min)
  }

  /** Anchor the window grid at the earliest media any channel delivered. */
  private openGrid(): void {
    let origin = Infinity
    for (const f of this.firstFrame.values()) if (f < origin) origin = f
    this.base = Number.isFinite(origin) ? origin : 0
    this.gridReady = true
  }

  /** Fold every frame below `target` into the running statistics. */
  private foldTo(target: number): void {
    const limit = Math.min(target, this.base + this.capacity)
    while (this.base < limit) {
      const idx = this.base % this.capacity
      const l = this.sumL[idx]!
      const r = this.sumR[idx]!
      const a = l < 0 ? -l : l
      const b = r < 0 ? -r : r
      const s = a > b ? a : b
      if (s > this.peak) this.peak = s
      const mid = 0.5 * (l + r)
      this.winSumSq += mid * mid
      if (++this.winCount === this.windowFrames) {
        this.windowRms.push(Math.sqrt(this.winSumSq / this.winCount))
        this.winSumSq = 0
        this.winCount = 0
      }
      this.sumL[idx] = 0
      this.sumR[idx] = 0
      this.base++
      this.folded++
    }
  }

  /** Fold the remainder and compute the percentiles. Idempotent. */
  finish(): AccumulatedLoudness {
    if (!this.finished) {
      if (!this.gridReady) this.openGrid()
      let max = 0
      for (const d of this.delivered.values()) if (d > max) max = d
      while (this.base < max) this.foldTo(Math.min(max, this.base + this.capacity))
      if (this.winCount > 0) this.windowRms.push(Math.sqrt(this.winSumSq / this.winCount))
      this.winSumSq = 0
      this.winCount = 0
      this.windowRms.sort((x, y) => x - y)
      this.finished = true
    }
    const w = this.windowRms
    const at = (q: number): number =>
      w.length ? w[Math.min(w.length - 1, Math.floor(q * w.length))]! : 0
    return {
      channelIds: this.contributed(),
      peak: this.peak,
      loudRms: at(0.9),
      floorRms: at(0.2),
      frames: this.folded,
      degraded: this.degraded,
    }
  }
}
