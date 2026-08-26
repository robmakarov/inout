/**
 * EXPERIMENTAL — Oracle audio-fidelity metric (task oracle-audio-fidelity).
 *
 * Measures music-path quality end-to-end on a known stereo multitone:
 * per-tone level error, THD/IMD estimates, L/R separation, soft-knee hits.
 * Catches the three 548b084 defect classes (tanh bus, mono downmix, limiter).
 */

import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny'

export const MAX_TONE_ERROR_DB = 1
export const MIN_SEPARATION_DB = 40
export const LIMIT_KNEE = 0.95

/** Known tones placed on L / R by the fidelity rig (peak amplitudes). */
export const FIDELITY_TONES = [
  { freqHz: 440, channel: 'L' as const, amp: 0.5 },
  { freqHz: 880, channel: 'L' as const, amp: 0.25 },
  { freqHz: 550, channel: 'R' as const, amp: 0.5 },
  { freqHz: 1100, channel: 'R' as const, amp: 0.25 },
]

export interface ToneMeasurement {
  freqHz: number
  channel: 'L' | 'R'
  expectedDbFs: number
  measuredDbFs: number
  errorDb: number
}

export interface AudioFidelityReport {
  sampleRate: number
  frames: number
  tones: ToneMeasurement[]
  maxToneErrorDb: number
  /** Worst harmonic distortion vs its fundamental (dB, more negative = cleaner). */
  thdDb: number | null
  /** Worst intermod product vs strongest tone (dB). */
  imdDb: number | null
  /** Min L-vs-R isolation across channel-owned tones (dB). */
  separationDb: number
  /** Decoded samples with |x| > soft-knee (0.95). */
  limiterHits: number
  tonePass: boolean
  separationPass: boolean
  limiterPass: boolean
  pass: boolean
  /** Where the measured window actually opened, seconds, and where the signal
   *  was found. Evidence: a level reading is only as good as its window, and
   *  these two are what say the window contained the programme. */
  windowStartSec?: number
  onsetSec?: number | null
}

export function ampToDbFs(amp: number): number {
  return 20 * Math.log10(Math.max(1e-20, amp))
}

export function goertzelPower(samples: Float32Array, sampleRate: number, freqHz: number): number {
  const w = (2 * Math.PI * freqHz) / sampleRate
  const coeff = 2 * Math.cos(w)
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i]! + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/** Peak amplitude of a pure sine estimated from Goertzel power over N samples. */
export function goertzelPeakAmp(samples: Float32Array, sampleRate: number, freqHz: number): number {
  const p = goertzelPower(samples, sampleRate, freqHz)
  return (2 * Math.sqrt(Math.max(0, p))) / Math.max(1, samples.length)
}

export function countLimiterHits(left: Float32Array, right: Float32Array, knee = LIMIT_KNEE): number {
  const n = Math.min(left.length, right.length)
  let hits = 0
  for (let i = 0; i < n; i++) {
    if (Math.abs(left[i]!) > knee || Math.abs(right[i]!) > knee) hits++
  }
  return hits
}

/**
 * Apply the pre-548b084 always-on tanh bus (for red-gate unit proof).
 * tanh(0.5)≈0.462 → ~0.7 dB error; stronger with hotter tones / harmonics.
 */
export function applyLegacyTanhBus(samples: Float32Array): Float32Array {
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) out[i] = Math.tanh(samples[i]!)
  return out
}

/** Collapse stereo to mono duplication (pre-548b084 channelCount??1 class). */
export function applyMonoDownmix(left: Float32Array, right: Float32Array): {
  left: Float32Array
  right: Float32Array
} {
  const n = Math.min(left.length, right.length)
  const m = new Float32Array(n)
  for (let i = 0; i < n; i++) m[i] = 0.5 * (left[i]! + right[i]!)
  return { left: m, right: m.slice() }
}

/**
 * Crude −6 dB / 20:1 dynamics (pre-548b084 composite limiter class).
 * Enough nonlinearity + level squash for the fidelity metric to go red.
 */
export function applyLegacyLimiter(samples: Float32Array): Float32Array {
  const threshold = Math.pow(10, -6 / 20) // ≈0.501
  const ratio = 20
  const out = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i]!
    const a = Math.abs(x)
    if (a <= threshold) {
      out[i] = x
    } else {
      const over = a - threshold
      const compressed = threshold + over / ratio
      out[i] = (x < 0 ? -1 : 1) * compressed
    }
  }
  return out
}

export function analyzeStereoBuffers(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  tones = FIDELITY_TONES,
): AudioFidelityReport {
  const frames = Math.min(left.length, right.length)
  const L = left.subarray(0, frames)
  const R = right.subarray(0, frames)

  const toneRows: ToneMeasurement[] = tones.map((t) => {
    const chan = t.channel === 'L' ? L : R
    const measuredAmp = goertzelPeakAmp(chan, sampleRate, t.freqHz)
    const expectedDbFs = ampToDbFs(t.amp)
    const measuredDbFs = ampToDbFs(measuredAmp)
    return {
      freqHz: t.freqHz,
      channel: t.channel,
      expectedDbFs,
      measuredDbFs,
      errorDb: measuredDbFs - expectedDbFs,
    }
  })

  let maxToneErrorDb = 0
  for (const t of toneRows) maxToneErrorDb = Math.max(maxToneErrorDb, Math.abs(t.errorDb))

  // Separation: for each L-owned tone, L power vs R power (and vice versa).
  let separationDb = Infinity
  for (const t of tones) {
    const own = t.channel === 'L' ? L : R
    const other = t.channel === 'L' ? R : L
    const pOwn = Math.max(1e-30, goertzelPower(own, sampleRate, t.freqHz))
    const pOther = Math.max(1e-30, goertzelPower(other, sampleRate, t.freqHz))
    const sep = 10 * Math.log10(pOwn / pOther)
    separationDb = Math.min(separationDb, sep)
  }
  if (!Number.isFinite(separationDb)) separationDb = 0

  // THD on 440: skip 2nd harmonic (880 is an intentional fidelity tone).
  const fund = 440
  const p1 = goertzelPower(L, sampleRate, fund)
  let harm = 0
  for (const h of [3, 4, 5]) {
    const f = fund * h
    if (f < sampleRate / 2 - 40) harm += goertzelPower(L, sampleRate, f)
  }
  const thdDb = p1 > 0 ? 10 * Math.log10(Math.max(1e-30, harm) / p1) : null

  // IMD probes: difference / sum products of the primary L/R pair.
  const imdProbes = [330, 990, 1430] // 880−550, 440+550, 880+550
  const pRef = Math.max(
    goertzelPower(L, sampleRate, 440),
    goertzelPower(R, sampleRate, 550),
    1e-30,
  )
  let worstImd = -Infinity
  for (const f of imdProbes) {
    if (f < 40 || f > sampleRate / 2 - 40) continue
    // Prefer the channel that shouldn't own this product strongly.
    const p = Math.max(goertzelPower(L, sampleRate, f), goertzelPower(R, sampleRate, f))
    worstImd = Math.max(worstImd, 10 * Math.log10(Math.max(1e-30, p) / pRef))
  }
  const imdDb = worstImd === -Infinity ? null : worstImd

  const limiterHits = countLimiterHits(L, R)
  const tonePass = maxToneErrorDb <= MAX_TONE_ERROR_DB
  const separationPass = separationDb >= MIN_SEPARATION_DB
  const limiterPass = limiterHits === 0

  return {
    sampleRate,
    frames,
    tones: toneRows,
    maxToneErrorDb,
    thdDb,
    imdDb,
    separationDb,
    limiterHits,
    tonePass,
    separationPass,
    limiterPass,
    pass: tonePass && separationPass && limiterPass,
  }
}

/** Synthesize the fidelity multitone (unit tests / defect proofs). */
export function synthesizeFidelityStereo(
  sampleRate: number,
  durationSec: number,
  tones = FIDELITY_TONES,
): { left: Float32Array; right: Float32Array } {
  const n = Math.floor(sampleRate * durationSec)
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    for (const tone of tones) {
      const s = tone.amp * Math.sin(2 * Math.PI * tone.freqHz * t)
      if (tone.channel === 'L') left[i]! += s
      else right[i]! += s
    }
  }
  return { left, right }
}

/** Level above which the fixture's programme is unambiguously present. The
 *  quietest tone the analyzer is ever pointed at peaks near 0.35 after a 1/N
 *  bus, so this sits well below the signal and well above codec noise. */
const ONSET_AMPLITUDE = 0.05
/** Onset search granularity, and the ramp allowed after it before measuring. */
const ONSET_BLOCK_SEC = 0.01
const ONSET_MARGIN_SEC = 0.2

/**
 * First instant at which THIS channel is actually playing, seconds — null if
 * it never rises above the floor.
 *
 * THE WINDOW HAS TO FIND THE SIGNAL, NOT BE TOLD WHERE IT IS. Two independent
 * startups put silence at the front of these files and neither is visible in
 * the metadata: the CAPTURE begins at its channel's own offset, and the
 * GENERATOR's AudioContext stalls before its oscillators advance — measured at
 * 115-500 ms in rig.ts and observed up to 2.15 s here — so a channel can be
 * recording, and recording silence. A tone absent for a fraction f of the
 * window reads (1−f) low on every tone at once, which is indistinguishable
 * from a mix-bus regression: measured as a phantom 0.5 dB twice, and as a
 * 1.3 dB gate FAILURE on green code once.
 *
 * PER CHANNEL, because the interesting case is a MULTI-SOURCE take, where the
 * L-owned tones and the R-owned tones come from two different sources that
 * stall independently. An onset taken on the mix fires when the FIRST of them
 * arrives and says nothing about the second — which read as 11.9 and 16.1 dB
 * of phantom attenuation before the window waited for both.
 */
export function findOnsetSec(
  samples: Float32Array,
  sampleRate: number,
  threshold = ONSET_AMPLITUDE,
): number | null {
  const block = Math.max(1, Math.floor(ONSET_BLOCK_SEC * sampleRate))
  for (let i = 0; i + block <= samples.length; i += block) {
    let peak = 0
    for (let k = i; k < i + block; k++) {
      const a = Math.abs(samples[k]!)
      if (a > peak) peak = a
    }
    if (peak >= threshold) return i / sampleRate
  }
  return null
}

/**
 * When every channel the fixture expects to carry tones is up — the instant
 * the window may open. Null if one of them never arrives, which is a real
 * finding (a source that never reached the file) and not a window to move.
 */
export function findProgrammeOnsetSec(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  tones: typeof FIDELITY_TONES,
): number | null {
  const needed: Float32Array[] = []
  if (tones.some((t) => t.channel === 'L')) needed.push(left)
  if (tones.some((t) => t.channel === 'R')) needed.push(right)
  let latest = 0
  for (const chan of needed) {
    const onset = findOnsetSec(chan, sampleRate)
    if (onset === null) return null
    latest = Math.max(latest, onset)
  }
  return needed.length ? latest : null
}

export interface FidelityAnalyzeOptions {
  /**
   * MINIMUM start of the measured window, seconds — a floor, not the answer.
   * The window opens at the later of this and the measured onset (see
   * findOnsetSec), because the two guard different things: the onset finds a
   * generator that had not started yet, and this floor covers a SECOND source
   * that starts after the first one's onset, which no amount of onset-seeking
   * on the mix can see. Multi-source callers pass their last channel's start.
   */
  skipSec?: number
  /** Length of the measured window, seconds. */
  windowSec?: number
  /**
   * Which tones this file is expected to carry. Defaults to all four. A RAW
   * channel of a multi-source take carries only its own source's tones, and
   * asking for the others reads −320 dB of digital silence as a level defect.
   */
  tones?: typeof FIDELITY_TONES
}

export async function analyzeAudioFidelity(
  blob: Blob,
  opts?: FidelityAnalyzeOptions,
): Promise<AudioFidelityReport> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) {
      return {
        sampleRate: 0,
        frames: 0,
        tones: [],
        maxToneErrorDb: Infinity,
        thdDb: null,
        imdDb: null,
        separationDb: 0,
        limiterHits: 0,
        tonePass: false,
        separationPass: false,
        limiterPass: false,
        pass: false,
      }
    }
    const sink = new AudioBufferSink(track)
    const leftChunks: Float32Array[] = []
    const rightChunks: Float32Array[] = []
    let sampleRate = 48_000
    for await (const { buffer } of sink.buffers()) {
      sampleRate = buffer.sampleRate
      leftChunks.push(buffer.getChannelData(0).slice())
      if (buffer.numberOfChannels > 1) rightChunks.push(buffer.getChannelData(1).slice())
      else rightChunks.push(buffer.getChannelData(0).slice())
    }
    let frames = 0
    for (const c of leftChunks) frames += c.length
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    let o = 0
    for (let i = 0; i < leftChunks.length; i++) {
      left.set(leftChunks[i]!, o)
      right.set(rightChunks[i]!, o)
      o += leftChunks[i]!.length
    }
    // Open the window on the programme: the later of the caller's floor and the
    // instant EVERY expected channel is up, plus a ramp.
    const windowSec = opts?.windowSec ?? 2.5
    const tones = opts?.tones ?? FIDELITY_TONES
    const onsetSec = findProgrammeOnsetSec(left, right, sampleRate, tones)
    const startSec = Math.max(
      opts?.skipSec ?? 0.25,
      onsetSec === null ? 0 : onsetSec + ONSET_MARGIN_SEC,
    )
    // A late onset SHORTENS the window rather than moving it back into the
    // silence — a shorter window of real programme beats a full one that is
    // part silence, which is the whole failure this positioning exists to stop.
    // One second is the floor below which the percentiles stop meaning much.
    const latestStart = Math.max(0, frames - Math.floor(sampleRate))
    const skip = Math.min(Math.floor(startSec * sampleRate), latestStart)
    const end = Math.min(frames, skip + Math.floor(windowSec * sampleRate))
    return {
      ...analyzeStereoBuffers(
        left.subarray(skip, end),
        right.subarray(skip, end),
        sampleRate,
        opts?.tones,
      ),
      windowStartSec: Math.round((skip / sampleRate) * 1000) / 1000,
      onsetSec: onsetSec === null ? null : Math.round(onsetSec * 1000) / 1000,
    }
  } finally {
    input.dispose()
  }
}
