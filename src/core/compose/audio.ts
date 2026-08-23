import { ALL_FORMATS, AudioBufferSink, BlobSource, Input, type WrappedAudioBuffer } from 'mediabunny'
import type { CaptureLoudness } from '@core/types'
import { AUDIO_SAMPLE_RATE } from './codecs'

interface CurrentBuffer {
  startSec: number
  endSec: number
  rate: number
  left: Float32Array
  right: Float32Array
}

/** 4-point Hermite — continuous C1, far less 44.1↔48 warble than linear. */
function hermite(y0: number, y1: number, y2: number, y3: number, t: number): number {
  const c0 = y1
  const c1 = 0.5 * (y2 - y0)
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2)
  return ((c3 * t + c2) * t + c1) * t + c0
}

function sampleAt(chan: Float32Array, pos: number): number {
  const last = chan.length - 1
  if (last < 0) return 0
  if (pos <= 0) return chan[0]
  if (pos >= last) return chan[last]
  const i1 = Math.floor(pos)
  const i0 = i1 > 0 ? i1 - 1 : 0
  const i2 = i1 < last ? i1 + 1 : last
  const i3 = i2 < last ? i2 + 1 : last
  return hermite(chan[i0], chan[i1], chan[i2], chan[i3], pos - i1)
}

/**
 * Soft-knee limiter used at the final mix bus. Hard clamp (±1) turns mic+
 * system-audio double-capture into harsh clipping buzz — but shaping EVERY
 * sample (the old plain tanh) audibly distorts music at normal levels
 * (tanh(0.7)≈0.60). Identity below the knee; only overs get tanh-folded
 * into the remaining headroom, C1-continuous at the knee.
 */
const LIMIT_KNEE = 0.95

export function softLimitSample(x: number): number {
  const a = Math.abs(x)
  if (a <= LIMIT_KNEE) return x
  const shaped = LIMIT_KNEE + (1 - LIMIT_KNEE) * Math.tanh((a - LIMIT_KNEE) / (1 - LIMIT_KNEE))
  return x < 0 ? -shaped : shaped
}

/**
 * Per-channel gain for the render mix bus. Single source = unity (full-scale,
 * never limited). Multiple sources use 1/N headroom — a HARD guarantee that
 * even worst-case in-phase peaks (mic + system audio both near full scale)
 * sum below the limiter knee. Equal-power (1/√N) was measured insufficient:
 * two decorrelated full-scale tones still clipped ~17% of samples (the
 * pervasive "noise in all sound"). 1/N trades ~6 dB loudness on multi-source
 * takes for zero pervasive limiting. Loudness makeup belongs in a later
 * two-pass normalize, not in a stage that can reintroduce clipping.
 */
export function mixGainForChannels(count: number): number {
  return count > 1 ? 1 / count : 1
}

/**
 * SPEECH-LOUDNESS normalization (replaces the peak-based rescue, which a real
 * take defeated: PO's 31s export had voice at −25 dB RMS but one 3-sample mic
 * bump peaking at 0.77 — peak-targeting saw "loud enough" and did nothing).
 *
 * Loudness is measured as the p90 of 100 ms window RMS: robust to silence
 * (windows during pauses land in the lower percentiles) and to transients
 * (3 loud samples cannot own a percentile). Gain drives that level to
 * NORMALIZE_TARGET_RMS; brief overs from boosted transients fold into the
 * soft limiter — 3 shaped samples beat a whole take of inaudible voice.
 */
/** Speech target: −18 dBFS window-RMS — clearly audible on laptop speakers,
 * ~4 dB below broadcast hot so music mixes keep headroom. */
export const NORMALIZE_TARGET_RMS = 0.125
/** Cap (+18 dB): a heavily AGC'd HFP mic still reaches target; pure noise
 * floors (gated below) never get blown up unbounded. */
export const NORMALIZE_MAX_MAKEUP = 8
/** Loudness gate: takes whose p90 window-RMS sits at/below this are treated as
 * having no real program (room tone only) and are left untouched. −50 dBFS. */
export const NORMALIZE_GATE_RMS = 0.0032
/** Bound on pervasive limiting: gain may push the true peak at most this far
 * past the knee (brief transients get shaped; sustained program does not). */
export const NORMALIZE_PEAK_OVERDRIVE = 2
/** Post-gain ceiling for the take's noise floor (p20 window RMS): −40 dBFS.
 * Boosting speech must not boost room hiss into audibility — a +18 dB rescue
 * of a faint take was reported back as "still some noises". A clean floor
 * (near digital silence) leaves this bound at ∞ and full rescue applies. */
export const NORMALIZE_FLOOR_CEILING_RMS = 0.01

export interface MixLoudness {
  /** Max |sample| across the mix. */
  peak: number
  /** p90 of 100 ms window RMS — the "speech level". */
  loudRms: number
  /** p20 of 100 ms window RMS — the noise floor (room tone between speech).
   * Optional: older callers/tests omit it; the floor bound then stays off. */
  floorRms?: number
}

/**
 * Capture-time stats (Recording.loudness) → the MixLoudness the probe pass
 * would have produced, for a mix of EXACTLY those channels at `gain`.
 *
 * The stats are taken on the unity sum, and every mixer applies the same
 * constant `gain`, so peak and both RMS percentiles scale linearly by it.
 *
 * Returns null — caller probes — in three cases:
 *  1. the stats do not describe this mix (channel disabled or failed to open,
 *     take predates O2, browser records audio via MediaRecorder);
 *  2. the take delivered no frames;
 *  3. the FLOOR bound could decide the makeup. Capture measures the PCM while
 *     export measures the decoded file, and a lossy codec discards content
 *     below its perceptual floor — measured at up to 15 dB apart on a source
 *     whose quiet passages fall below opus's floor, which is exactly what p20
 *     samples. A codec only ever removes such content, so the captured floor
 *     is an UPPER estimate of the file's, and floorBound(captured) is a LOWER
 *     bound on floorBound(file): when the captured floor bound does not bind,
 *     the file's cannot either and the shortcut is provably equivalent. When
 *     it could bind, the probe decides — correctness over speed.
 */
export function loudnessFromCaptureStats(
  stats: CaptureLoudness | undefined,
  channelIds: string[],
  gain: number,
): MixLoudness | null {
  if (!stats || stats.frames <= 0) return null
  if (stats.channelIds.length !== channelIds.length) return null
  if (!channelIds.every((id) => stats.channelIds.includes(id))) return null
  const m: MixLoudness = {
    peak: stats.peak * gain,
    loudRms: stats.loudRms * gain,
    floorRms: stats.floorRms * gain,
  }
  if (!(m.loudRms > NORMALIZE_GATE_RMS)) return m // makeup is 1 either way
  const nonFloor = Math.min(
    NORMALIZE_MAX_MAKEUP,
    NORMALIZE_TARGET_RMS / m.loudRms,
    m.peak > 0 ? (NORMALIZE_PEAK_OVERDRIVE * LIMIT_KNEE) / m.peak : Infinity,
  )
  // A healthy mix needs no boost, so the floor cannot change the answer.
  if (nonFloor <= 1) return m
  const floorBound = m.floorRms && m.floorRms > 0 ? NORMALIZE_FLOOR_CEILING_RMS / m.floorRms : Infinity
  if (floorBound < nonFloor) return null
  return m
}

/**
 * Makeup gain that drives speech-level loudness to target. Only ever boosts
 * (a healthy or hot mix passes at 1.0); gated so noise-only takes stay put;
 * peak-bounded so sustained program cannot be driven deep into the limiter;
 * floor-bounded so the boost cannot raise the noise floor into audibility.
 */
export function makeupGainForLoudness(m: MixLoudness): number {
  if (!(m.loudRms > NORMALIZE_GATE_RMS)) return 1
  const wanted = NORMALIZE_TARGET_RMS / m.loudRms
  const peakBound = m.peak > 0 ? (NORMALIZE_PEAK_OVERDRIVE * LIMIT_KNEE) / m.peak : Infinity
  const floorBound =
    m.floorRms && m.floorRms > 0 ? NORMALIZE_FLOOR_CEILING_RMS / m.floorRms : Infinity
  return Math.max(1, Math.min(NORMALIZE_MAX_MAKEUP, wanted, peakBound, floorBound))
}

/**
 * Streams one channel's decoded audio strictly forward and mixes it (by
 * summation, Hermite-resampled to 48 kHz) into output chunks.
 * `mixInto` must be called with non-decreasing chunk windows. Peak memory
 * stays O(one decoded buffer) per channel.
 *
 * Sample indices use floor/ceil (not round) so adjacent 1 s mix chunks share
 * no skipped/duplicated frame — the classic click source at chunk seams.
 */
/**
 * Anything that can add its contribution to an output chunk. Two implement it:
 * one channel over one kept span at natural rate, and a whole SPED span whose
 * channels are summed and then time-stretched together (task F5b).
 */
export interface MixSource {
  gain: number
  /** Channels this source contributes — the mix bus counts DISTINCT ones. */
  readonly channelIds: string[]
  /** '' when the source is not a single channel; see loudnessFromCaptureStats. */
  readonly channelId: string
  mixInto(left: Float32Array, right: Float32Array, chunkOutStartSec: number): Promise<void>
  dispose(): void
}

export class AudioChannelMixer implements MixSource {
  private readonly iter: AsyncGenerator<WrappedAudioBuffer, void, unknown>
  private curr: CurrentBuffer | null = null
  private pending: WrappedAudioBuffer | null = null
  private done = false
  /** Last contribution this mixer wrote (channel-local) for seam healing. */
  private prevL = 0
  private prevR = 0
  private hasPrev = false
  /**
   * Mix gain applied to this channel's contribution. Default 1 (single source
   * stays full-scale, never touches the limiter). With multiple audio channels
   * the bus sets headroom (e.g. 0.7) so mic+system-audio summing does not
   * clip into softLimitSample — the pervasive-noise cause when the composite
   * shortcut was removed and everything moved to this render sum (2026-07-16).
   */
  gain = 1

  get channelIds(): string[] {
    return [this.channelId]
  }

  constructor(
    private readonly input: Input,
    sink: AudioBufferSink,
    /** Which ChannelRecording this mixes — matched against Recording.loudness. */
    readonly channelId: string,
    /** Channel's active window on the output timeline, seconds. */
    private readonly outStartSec: number,
    private readonly outEndSec: number,
    /** localSec = outSec + localOffsetSec */
    private readonly localOffsetSec: number,
  ) {
    this.iter = sink.buffers(
      Math.max(0, outStartSec + localOffsetSec),
      outEndSec + localOffsetSec,
    )
  }

  async mixInto(left: Float32Array, right: Float32Array, chunkOutStartSec: number): Promise<void> {
    const sr = AUDIO_SAMPLE_RATE
    const frames = left.length
    const overlapStart = Math.max(chunkOutStartSec, this.outStartSec)
    const overlapEnd = Math.min(chunkOutStartSec + frames / sr, this.outEndSec)
    if (overlapEnd <= overlapStart) return

    let k = Math.max(0, Math.floor((overlapStart - chunkOutStartSec) * sr + 1e-9))
    const kEnd = Math.min(frames, Math.ceil((overlapEnd - chunkOutStartSec) * sr - 1e-9))
    const SEAM_FADE = 8

    while (k < kEnd) {
      const localSec = chunkOutStartSec + k / sr + this.localOffsetSec
      await this.advance(localSec)
      const cur = this.curr
      if (cur && localSec < cur.endSec) {
        const runEnd = Math.min(kEnd, k + Math.max(1, Math.ceil((cur.endSec - localSec) * sr)))
        let srcPos = (localSec - cur.startSec) * cur.rate
        const step = cur.rate / sr
        for (; k < runEnd; k++, srcPos += step) {
          let sL = sampleAt(cur.left, srcPos)
          let sR = sampleAt(cur.right, srcPos)

          // Heal discontinuous seams between mix chunks (and decoded-buffer
          // joins that land on k===0 of a new chunk).
          if (this.hasPrev && k === 0) {
            const jump = Math.max(Math.abs(sL - this.prevL), Math.abs(sR - this.prevR))
            if (jump > 0.05) {
              const fade = Math.min(SEAM_FADE, runEnd)
              for (let i = 0; i < fade; i++) {
                const t = (i + 1) / (fade + 1)
                const pos = srcPos + i * step
                const nL = sampleAt(cur.left, pos)
                const nR = sampleAt(cur.right, pos)
                const oL = this.prevL * (1 - t) + nL * t
                const oR = this.prevR * (1 - t) + nR * t
                left[k + i] += oL * this.gain
                right[k + i] += oR * this.gain
                this.prevL = oL
                this.prevR = oR
              }
              srcPos += fade * step
              k += fade
              continue
            }
          }

          left[k] += sL * this.gain
          right[k] += sR * this.gain
          this.prevL = sL
          this.prevR = sR
          this.hasPrev = true
        }
      } else if (this.pending) {
        const gapFrames = Math.max(1, Math.ceil((this.pending.timestamp - localSec) * sr))
        k += gapFrames
        this.prevL = 0
        this.prevR = 0
        this.hasPrev = true
      } else {
        break
      }
    }
  }

  /** Makes `curr` the last buffer starting at-or-before localSec. */
  private async advance(localSec: number): Promise<void> {
    while (!this.done) {
      if (this.pending) {
        if (this.pending.timestamp > localSec) return
        this.setCurrent(this.pending)
        this.pending = null
      } else {
        const r = await this.iter.next()
        if (r.done) this.done = true
        else this.pending = r.value
      }
    }
  }

  private setCurrent(w: WrappedAudioBuffer): void {
    const left = w.buffer.getChannelData(0)
    const right = w.buffer.numberOfChannels > 1 ? w.buffer.getChannelData(1) : left
    this.curr = {
      startSec: w.timestamp,
      endSec: w.timestamp + left.length / w.buffer.sampleRate,
      rate: w.buffer.sampleRate,
      left,
      right,
    }
  }

  dispose(): void {
    this.curr = null
    this.pending = null
    void this.iter.return(undefined).catch(() => undefined)
    this.input.dispose()
  }
}

export async function openAudioChannel(
  blob: Blob,
  channelId: string,
  outStartSec: number,
  outEndSec: number,
  localOffsetSec: number,
): Promise<AudioChannelMixer | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) {
      console.warn(`compose: channel ${channelId} has no decodable audio track, skipping`)
      input.dispose()
      return null
    }
    // MEASURED: surface native rate so 44.1 kHz device capture is visible in logs
    // (mixer resamples via Hermite; assuming 48 kHz was a warble/click source).
    const rate = track.sampleRate
    if (rate && rate !== AUDIO_SAMPLE_RATE) {
      console.info(
        `compose: channel ${channelId} native sampleRate=${rate} Hz → mix @ ${AUDIO_SAMPLE_RATE} Hz`,
      )
    }
    return new AudioChannelMixer(
      input,
      new AudioBufferSink(track),
      channelId,
      outStartSec,
      outEndSec,
      localOffsetSec,
    )
  } catch (err) {
    input.dispose()
    throw err
  }
}

/** 100 ms loudness window at 48 kHz. */
const LOUDNESS_WINDOW_FRAMES = 4800

/**
 * Loudness analysis pre-pass over the full mix at a given per-channel gain:
 * true peak + p90 of 100 ms window RMS (the "speech level"). Streams forward
 * exactly like the render (O(one decoded buffer) memory) so the measurement
 * matches what will be encoded. Shared by the full render AND the instant
 * path. Pass a THROWAWAY mixer set: mixing consumes it.
 */
export async function measureMixLoudness(
  mixers: MixSource[],
  gain: number,
  totalAudioFrames: number,
  throwIfAborted: () => void,
  onProgress?: (ratio: number) => void,
): Promise<MixLoudness> {
  const { peak, loudRms, floorRms } = await measureMixEnvelope(
    mixers,
    gain,
    totalAudioFrames,
    throwIfAborted,
    onProgress,
  )
  return { peak, loudRms, floorRms }
}

export interface MixEnvelope extends MixLoudness {
  /** 100 ms window RMS of the mid signal, IN TIME ORDER. */
  windowRms: Float32Array
  windowMs: number
}

/**
 * The same pass, keeping the envelope instead of only its percentiles (task
 * F5a). Silence detection needs to know WHERE the quiet is, not just how quiet
 * the take is on average — and it must be the same measurement the loudness
 * normalizer makes, or the two would disagree about what "quiet" means.
 */
export async function measureMixEnvelope(
  mixers: MixSource[],
  gain: number,
  totalAudioFrames: number,
  throwIfAborted: () => void,
  onProgress?: (ratio: number) => void,
): Promise<MixEnvelope> {
  for (const m of mixers) m.gain = gain
  let peak = 0
  const windowRms: number[] = []
  let winSumSq = 0
  let winCount = 0
  const chunks = Math.max(1, Math.ceil(totalAudioFrames / AUDIO_SAMPLE_RATE))
  for (let c = 0; c < chunks; c++) {
    throwIfAborted()
    const startFrame = c * AUDIO_SAMPLE_RATE
    const frames = Math.min(AUDIO_SAMPLE_RATE, totalAudioFrames - startFrame)
    if (frames <= 0) break
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    const chunkOutStartSec = startFrame / AUDIO_SAMPLE_RATE
    for (const m of mixers) await m.mixInto(left, right, chunkOutStartSec)
    for (let k = 0; k < frames; k++) {
      const a = Math.abs(left[k])
      const b = Math.abs(right[k])
      const s = a > b ? a : b
      if (s > peak) peak = s
      // Mono-fold energy for the loudness windows (mid signal).
      const mid = 0.5 * (left[k] + right[k])
      winSumSq += mid * mid
      if (++winCount === LOUDNESS_WINDOW_FRAMES) {
        windowRms.push(Math.sqrt(winSumSq / winCount))
        winSumSq = 0
        winCount = 0
      }
    }
    onProgress?.((c + 1) / chunks)
    await new Promise((r) => setTimeout(r, 0))
  }
  if (winCount > 0) windowRms.push(Math.sqrt(winSumSq / winCount))
  // Percentiles need it sorted; the caller needs it in time order. Sort a copy.
  const inOrder = Float32Array.from(windowRms)
  windowRms.sort((a, b) => a - b)
  const loudRms = windowRms.length
    ? windowRms[Math.min(windowRms.length - 1, Math.floor(0.9 * windowRms.length))]
    : 0
  const floorRms = windowRms.length
    ? windowRms[Math.min(windowRms.length - 1, Math.floor(0.2 * windowRms.length))]
    : 0
  return {
    peak,
    loudRms,
    floorRms,
    windowRms: inOrder,
    windowMs: (LOUDNESS_WINDOW_FRAMES / AUDIO_SAMPLE_RATE) * 1000,
  }
}

/**
 * A whole kept span played faster (task F5b), summed and time-stretched.
 *
 * The channels are mixed at NATURAL rate in RECORDING time — each of its inner
 * mixers is opened with an identity mapping, so `mixInto(_, _, recSec)` hands
 * back the material exactly as recorded — and the sum then goes through one
 * WSOLA stretcher. Summing BEFORE stretching is not an optimisation: stretching
 * each channel separately would let the two searches choose different offsets,
 * and mic and system audio would slide apart inside the span.
 */
export class SpeedSpanMixer implements MixSource {
  private readonly stretcher: TimeStretcher
  /** Next RECORDING second to pull from the channels. */
  private srcCursorSec: number
  private readonly srcL = new Float32Array(AUDIO_SAMPLE_RATE)
  private readonly srcR = new Float32Array(AUDIO_SAMPLE_RATE)
  private outL = new Float32Array(AUDIO_SAMPLE_RATE)
  private outR = new Float32Array(AUDIO_SAMPLE_RATE)
  private ended = false

  constructor(
    private readonly mixers: AudioChannelMixer[],
    private readonly outStartSec: number,
    private readonly outEndSec: number,
    recStartSec: number,
    private readonly recEndSec: number,
    readonly speed: number,
  ) {
    this.stretcher = new TimeStretcher(speed)
    this.srcCursorSec = recStartSec
  }

  get channelIds(): string[] {
    return this.mixers.map((m) => m.channelId)
  }

  /** Deliberately not a channel id: a span is several channels, and the only
   *  consumer of channelId (the capture-stats loudness match) must MISS rather
   *  than match a span — it describes a 1x mix that this is not. */
  get channelId(): string {
    return ''
  }

  get gain(): number {
    return this.mixers[0]?.gain ?? 1
  }

  set gain(g: number) {
    for (const m of this.mixers) m.gain = g
  }

  async mixInto(left: Float32Array, right: Float32Array, chunkOutStartSec: number): Promise<void> {
    const sr = AUDIO_SAMPLE_RATE
    const frames = left.length
    const overlapStart = Math.max(chunkOutStartSec, this.outStartSec)
    const overlapEnd = Math.min(chunkOutStartSec + frames / sr, this.outEndSec)
    if (overlapEnd <= overlapStart) return
    const at = Math.max(0, Math.round((overlapStart - chunkOutStartSec) * sr))
    const need = Math.min(frames - at, Math.max(0, Math.round((overlapEnd - overlapStart) * sr)))
    if (need <= 0) return
    if (this.outL.length < need) {
      this.outL = new Float32Array(need)
      this.outR = new Float32Array(need)
    }
    this.outL.fill(0, 0, need)
    this.outR.fill(0, 0, need)

    let done = 0
    while (done < need) {
      const want = this.stretcher.wants(need - done)
      if (want > 0 && !(await this.feed(want))) this.finish()
      const got = this.stretcher.pull(this.outL, this.outR, done, need - done)
      if (got === 0) {
        // Nothing more will come: leave the rest silent rather than spin. The
        // span is bounded by its own output window, so this is at most the
        // last partial synthesis block.
        if (this.ended) break
        this.finish()
        continue
      }
      done += got
    }
    // The mixer contract is to ADD, so the stretcher's output is staged and
    // summed rather than written over whatever the other sources put there.
    for (let i = 0; i < done; i++) {
      left[at + i] += this.outL[i]!
      right[at + i] += this.outR[i]!
    }
  }

  /** Pull up to `frames` of source into the stretcher. False when exhausted. */
  private async feed(frames: number): Promise<boolean> {
    const sr = AUDIO_SAMPLE_RATE
    const remaining = Math.max(0, Math.round((this.recEndSec - this.srcCursorSec) * sr))
    const n = Math.min(frames, remaining, this.srcL.length)
    if (n <= 0) return false
    const l = this.srcL.subarray(0, n)
    const r = this.srcR.subarray(0, n)
    l.fill(0)
    r.fill(0)
    for (const m of this.mixers) await m.mixInto(l, r, this.srcCursorSec)
    this.stretcher.push(l, r, n)
    this.srcCursorSec += n / sr
    return true
  }

  private finish(): void {
    if (this.ended) return
    this.ended = true
    this.stretcher.end()
  }

  dispose(): void {
    for (const m of this.mixers) m.dispose()
  }
}

/** Pure helpers exported for unit tests. */
export const audioMixInternals = {
  hermite,
  sampleAt,
  softLimitSample,
  mixGainForChannels,
  makeupGainForLoudness,
}
