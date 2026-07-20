import { ALL_FORMATS, AudioBufferSink, BlobSource, Input, type WrappedAudioBuffer } from 'mediabunny'
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
 * Streams one channel's decoded audio strictly forward and mixes it (by
 * summation, Hermite-resampled to 48 kHz) into output chunks.
 * `mixInto` must be called with non-decreasing chunk windows. Peak memory
 * stays O(one decoded buffer) per channel.
 *
 * Sample indices use floor/ceil (not round) so adjacent 1 s mix chunks share
 * no skipped/duplicated frame — the classic click source at chunk seams.
 */
export class AudioChannelMixer {
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

  constructor(
    private readonly input: Input,
    sink: AudioBufferSink,
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
      outStartSec,
      outEndSec,
      localOffsetSec,
    )
  } catch (err) {
    input.dispose()
    throw err
  }
}

/** Pure helpers exported for unit tests. */
export const audioMixInternals = { hermite, sampleAt, softLimitSample, mixGainForChannels }
