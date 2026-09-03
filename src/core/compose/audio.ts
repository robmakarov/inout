import { ALL_FORMATS, AudioSample, AudioSampleSink, BlobSource, Input } from 'mediabunny'
import { blobStore } from '@core/store'
import type { CaptureLoudness, EditState, Recording } from '@core/types'
import { keptSegments, segmentOutputMs, segmentSpeed } from '@core/timeline'
import { AUDIO_CHANNEL_COUNT, AUDIO_SAMPLE_RATE } from './codecs'
import { LufsAccumulator } from './lufs'
import { TimeStretcher } from './timeStretch'

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
 * B13(3) — WHAT THE EXPORT'S RESAMPLER COSTS, AND WHY ROBERT HEARS IT.
 *
 * Hermite is a smooth CURVE through four points. It is not a reconstruction
 * filter, and its error rises 12 dB per octave: measured on this very function,
 * 44.1 kHz to 48 kHz, error against the ideal band-limited sample —
 *
 *      100 Hz  -149.6 dB      4 kHz   -51.5 dB      12 kHz  -18.7 dB
 *      1 kHz    -89.4 dB      8 kHz   -30.8 dB      16 kHz  -10.6 dB
 *
 * Below a kilohertz it is beyond reproach. At eight it leaves a companion 31 dB
 * down; at sixteen, 11 dB down. On music that is cymbals, sibilance and string
 * harmonics each dragging a little grit behind them for the whole take — and
 * "some small noises in tab audio" is what it sounds like (Robert, on a 124.8
 * minute take, 2026-09-02).
 *
 * IT ONLY HAPPENS WHEN A CHANNEL IS NOT ALREADY 48 kHz, which is why the A/B
 * that found it looked backwards at first: the take with the RAW flags arrived
 * at 44.1 kHz and went through this, and the voice-processed one arrived at
 * 48 kHz and did not. The cleaner capture had the dirtier export.
 *
 * The replacement below is a windowed sinc — an actual reconstruction filter —
 * measured on the same sweep at -82 to -105 dB across the whole band, 81 dB
 * better at 16 kHz, and 351x realtime per channel (171 ms per channel-minute),
 * against an export that is decode-bound at 5-6x. IT IS ON: a defect fix that
 * ships disabled has fixed nothing, and the old maths is what carries the flag.
 *
 * AND IT IS INERT ON THE SHIPPED CAPTURE PATH — measured 2026-09-03, after
 * Robert listened to an A/B of it and said "c and d same to me". He was right
 * and the reason is one line up the chain: every measured audio channel is
 * stored as OPUS, opus always decodes at 48 kHz, and the mix bus is 48 kHz. So
 * `interpolatorFor` is called with equal rates and NEITHER interpolator runs.
 * The 44.1 kHz the tab delivers is resampled inside the opus encoder at capture
 * time, not here. The console line below exists so that can never again be
 * argued about instead of read.
 *
 * It stays because the mixer can still be handed a channel at another rate —
 * the MediaRecorder lane, a non-opus source — and being correct there is free.
 * It is NOT the answer to B13(3), and nothing should cite it as one.
 */
const SINC_TAPS = 32
const SINC_PHASES = 1024
const SINC_BETA = 8.6

/** Zeroth-order modified Bessel, by series — used for the Kaiser window. */
function besselI0(x: number): number {
  let sum = 1
  let term = 1
  for (let k = 1; k < 25; k++) {
    term *= (x * x) / (4 * k * k)
    sum += term
    if (term < 1e-12 * sum) break
  }
  return sum
}

function sinc(x: number): number {
  return Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
}

/**
 * One row of taps per fractional phase. Each row is normalised to unity DC
 * gain: without that the window's own ripple rides out as a slow amplitude
 * wobble at the difference of the two rates, which is a different artefact
 * from the one being fixed and would have been blamed on the same code.
 */
function buildSincTable(cutoff: number): Float32Array {
  const rows = new Float32Array((SINC_PHASES + 1) * SINC_TAPS)
  const half = SINC_TAPS / 2
  for (let p = 0; p <= SINC_PHASES; p++) {
    const frac = p / SINC_PHASES
    let sum = 0
    for (let j = 0; j < SINC_TAPS; j++) {
      const x = j - half + 1 - frac
      const t = 1 - (x / half) * (x / half)
      const w = t <= 0 ? 0 : besselI0(SINC_BETA * Math.sqrt(t)) / besselI0(SINC_BETA)
      const v = cutoff * sinc(cutoff * x) * w
      rows[p * SINC_TAPS + j] = v
      sum += v
    }
    if (sum !== 0) for (let j = 0; j < SINC_TAPS; j++) rows[p * SINC_TAPS + j] /= sum
  }
  return rows
}

export type AudioInterpolator = (chan: Float32Array, pos: number) => number

/**
 * Band-limited interpolator for one rate pair. `cutoff` follows the LOWER of
 * the two Nyquists, so the same table both reconstructs when upsampling and
 * anti-aliases when downsampling; a fixed cutoff would alias a 96 kHz source
 * into the mix.
 */
export function makeSincInterpolator(inRate: number, outRate: number): AudioInterpolator {
  const rows = buildSincTable(Math.min(1, outRate / inRate))
  const half = SINC_TAPS / 2
  return (chan: Float32Array, pos: number): number => {
    const last = chan.length - 1
    if (last < 0) return 0
    const i1 = Math.floor(pos)
    const fp = (pos - i1) * SINC_PHASES
    const p0 = Math.floor(fp)
    const pf = fp - p0
    const b0 = p0 * SINC_TAPS
    const b1 = b0 + SINC_TAPS
    let acc = 0
    for (let j = 0; j < SINC_TAPS; j++) {
      let idx = i1 - half + 1 + j
      if (idx < 0) idx = 0
      else if (idx > last) idx = last
      acc += chan[idx] * (rows[b0 + j] * (1 - pf) + rows[b1 + j] * pf)
    }
    return acc
  }
}

/**
 * ON BY DEFAULT SINCE 2026-09-03, and it shipped OFF for about an hour before
 * Robert said the obvious thing: "you did fix and turned it off so you fucking
 * did nothing?". He is right. The frozen rule is that behaviour a USER CHOSE
 * does not move without his word — it is not a licence to land a defect fix
 * disabled. A resampler that leaves a companion 11 dB down at 16 kHz is a bug,
 * and the old maths is what needs the flag, not the correct maths.
 *
 * Off (`?resamp=hermite`, or the test panel) puts the old interpolator back so
 * the two can be compared by ear on the same take. That is the runtime fallback
 * the frozen rule actually asks for.
 */
const STORAGE_KEY = 'inout.export.resamp'

function fromSearch(): boolean | null {
  if (typeof location === 'undefined') return null
  const v = new URLSearchParams(location.search).get('resamp')
  return v === 'sinc' || v === '1' ? true : v === 'hermite' || v === '0' ? false : null
}

function fromStorage(): boolean | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/** True when the export reconstructs properly instead of curve-fitting. */
export function bandLimitedResampling(): boolean {
  return fromSearch() ?? fromStorage() ?? true
}

/** `null` clears the sticky choice — the shape every other flag's setter has. */
export function setBandLimitedResampling(on: boolean | null): void {
  try {
    if (on === null) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0')
  } catch {
    /* storage unavailable — the URL parameter still works */
  }
}

/**
 * The interpolator for one source rate. EQUAL RATES ALWAYS TAKE THE HERMITE
 * PATH, whatever the setting says: at integer positions Hermite returns the
 * sample itself, so a 48 kHz channel is already bit-exact and there is nothing
 * for a filter to improve and everything for it to risk. That also keeps every
 * take that never resamples byte-identical across the switch — pinned by test.
 */
const announced = new Set<string>()

export function interpolatorFor(inRate: number, outRate: number): AudioInterpolator {
  const equal = inRate === outRate
  const on = bandLimitedResampling()
  /**
   * SAY WHICH PATH THE AUDIO TOOK, once per rate pair per export. Without this
   * line B13(3) spent a night arguing about an interpolator without knowing
   * whether it ran: every measured channel is stored as OPUS, opus always
   * decodes at 48 kHz, and the mix bus is 48 kHz — so for the shipped capture
   * path the rates are equal and neither interpolator does anything at all.
   * A resampling decision nobody can read is a decision nobody can check.
   */
  const key = `${inRate}->${outRate}:${equal ? 'none' : on ? 'sinc' : 'hermite'}`
  if (!announced.has(key)) {
    announced.add(key)
    console.info(
      `[compose] audio mix ${inRate} Hz → ${outRate} Hz: ` +
        (equal
          ? 'RATES EQUAL, no resampling (the sample is taken as it is)'
          : on
            ? 'band-limited (32-tap windowed sinc)'
            : 'the old 4-point Hermite (?resamp is off)'),
    )
  }
  if (equal || !on) return sampleAt
  return makeSincInterpolator(inRate, outRate)
}

/**
 * Soft-knee limiter used at the final mix bus. Hard clamp (±1) turns mic+
 * system-audio double-capture into harsh clipping buzz — but shaping EVERY
 * sample (the old plain tanh) audibly distorts music at normal levels
 * (tanh(0.7)≈0.60). Identity below the knee; only overs get folded into the
 * remaining headroom, C1-continuous at the knee.
 *
 * THE FOLD IS ALGEBRAIC (u/(1+u)), NOT tanh, and that is the whole point.
 * tanh saturates EXPONENTIALLY: with the argument scaled by (1-knee)=0.05 it
 * was numerically pinned to full scale by an input of 1.152, while
 * makeupGainForLoudness is licensed to drive true peaks to
 * NORMALIZE_PEAK_OVERDRIVE × knee = 1.9. Every sample in that 1.66:1 range
 * landed on the SAME output code, so a boosted transient lost its shape and
 * came out as an impulse — measured as 217 full-scale ~0.25 ms spikes from
 * t≈12.5s in Robert's 2026-08-23 take, out of a −40 dBFS background. Audible as
 * crackle, and reported as "sound broke into lag sounds".
 *
 * u/(1+u) has the same three properties that made tanh the choice — f(0)=0,
 * f′(0)=1 (so the knee stays C1-continuous and normal program is untouched),
 * f(∞)=1 (so the output never reaches full scale) — but it approaches the
 * ceiling POLYNOMIALLY, so it stays distinguishable out to LIMIT_USABLE_MAX
 * ≈ 82, i.e. ~43× past anything the normalizer can ask for. Below the knee
 * nothing changed at all: takes without overs are bit-identical.
 */
const LIMIT_KNEE = 0.95

export function softLimitSample(x: number): number {
  const a = Math.abs(x)
  if (a <= LIMIT_KNEE) return x
  const u = (a - LIMIT_KNEE) / (1 - LIMIT_KNEE)
  const shaped = LIMIT_KNEE + (1 - LIMIT_KNEE) * (u / (1 + u))
  return x < 0 ? -shaped : shaped
}

/**
 * Largest input the limiter still renders as something OTHER than full scale
 * at 16-bit output — i.e. the honest top of its working range. Derived from
 * the curve in closed form rather than asserted, so the limiter and the gain
 * bound that feeds it cannot drift apart again; a test pins the relationship.
 *
 * 1 − shaped ≥ step  ⟺  (1−knee)/(1+u) ≥ step  ⟺  u ≤ (1−knee)/step − 1.
 */
const OUTPUT_STEP = 1 / 32768
export const LIMIT_USABLE_MAX =
  LIMIT_KNEE + (1 - LIMIT_KNEE) * ((1 - LIMIT_KNEE) / OUTPUT_STEP - 1)

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
 * take defeated: Robert's 31s export had voice at −25 dB RMS but one 3-sample mic
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
/**
 * Bound on pervasive limiting: gain may push the true peak at most this far
 * past the knee (brief transients get shaped; sustained program does not).
 *
 * BACK TO 2 on 2026-08-25, because the listen test the 4 was shipped without
 * came back: Robert reports the audio quality regressed over the roadmap sessions.
 *
 * The history matters, because the 4 was not taste either. It was raised on
 * 2026-08-23 for a real defect: on Robert's take this bound BOUND, the target was
 * missed by 1.4 dB, and the reason was that ONE SHARP TRANSIENT set `peak` and
 * capped the gain for the whole take — a single click both crackled AND held
 * everything else quiet. Raising the licence bought loudness back by letting
 * the limiter crush harder, and the cost was written down honestly at the time:
 * peaks squashed up to ~11.6 dB rather than ~5.6 dB.
 *
 * THAT WAS TREATING THE SYMPTOM. The defect was never the licence, it was the
 * STATISTIC: a single sample must not be able to define a whole take's
 * headroom. The bound now reads `peakRobust` — the p99 of per-window peaks,
 * measured over the same 100 ms windows as the loudness — so a stray transient
 * cannot own it and the gain reaches target WITHOUT buying the room with three
 * extra dB of crushing. With that statistic in hand the licence goes back to
 * where it was before the regression Robert is reporting.
 *
 * Raise no further without a listen test. That instruction was already here.
 */
export const NORMALIZE_PEAK_OVERDRIVE = 2
/**
 * The licence for takes that have NO robust ceiling — everything recorded
 * before the statistic existed. They get the 4 they were made under, because
 * the 4 exists precisely to survive a stray transient owning `peak`, and
 * without `peakRobust` there is nothing else protecting them: dropping them to
 * 2 would re-open the defect of 2026-08-23 (a take held 1.4 dB under target by
 * one click) on the very files that cannot be re-measured. New takes carry the
 * statistic and take the tighter, cleaner licence above.
 */
export const NORMALIZE_PEAK_OVERDRIVE_RAW = 4
/** Post-gain ceiling for the take's noise floor (p20 window RMS): −40 dBFS.
 * Boosting speech must not boost room hiss into audibility — a +18 dB rescue
 * of a faint take was reported back as "still some noises". A clean floor
 * (near digital silence) leaves this bound at ∞ and full rescue applies. */
export const NORMALIZE_FLOOR_CEILING_RMS = 0.01

export interface MixLoudness {
  /** Max |sample| across the mix. Certification reports this; the makeup gain
   *  deliberately does NOT bound on it — see peakRobust. */
  peak: number
  /**
   * p99 of per-window peaks (the same 100 ms windows the loudness uses) — the
   * take's SUSTAINED ceiling, as opposed to its single loudest sample. This is
   * what bounds the makeup gain, because one transient must not be able to
   * define a whole take's headroom (it did, and cost 1.4 dB of loudness on a
   * real take, which was then bought back with 3 dB of extra crushing).
   * Optional: a take recorded before this statistic existed falls back to
   * `peak`, which is exactly the old behaviour for old takes.
   */
  peakRobust?: number
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
    // Scales linearly with gain exactly as the other statistics do; absent on
    // takes that predate it, and then the fallback in makeupGainForLoudness
    // reproduces the old behaviour for those takes.
    ...(stats.peakRobust !== undefined ? { peakRobust: stats.peakRobust * gain } : {}),
    loudRms: stats.loudRms * gain,
    floorRms: stats.floorRms * gain,
  }
  return guardCodecFloor(m)
}

/**
 * Reason 3 above, on its own so every capture-derived statistic takes it: hand
 * back the mix loudness unless the p20 FLOOR term could decide the makeup, in
 * which case return null and let the caller decode.
 *
 * Generalizes unchanged from windows-of-the-whole-take to windows-of-the-kept-
 * spans (X1): the argument is about the STATISTIC — a captured floor is an
 * upper estimate of the file's, so a captured floor bound that does not bind
 * proves the file's cannot either — and not about how many windows it was
 * taken over.
 */
function guardCodecFloor(m: MixLoudness): MixLoudness | null {
  if (!(m.loudRms > NORMALIZE_GATE_RMS)) return m // makeup is 1 either way
  const ceiling = m.peakRobust ?? m.peak
  const licence =
    m.peakRobust !== undefined ? NORMALIZE_PEAK_OVERDRIVE : NORMALIZE_PEAK_OVERDRIVE_RAW
  const nonFloor = Math.min(
    NORMALIZE_MAX_MAKEUP,
    NORMALIZE_TARGET_RMS / m.loudRms,
    ceiling > 0 ? (licence * LIMIT_KNEE) / ceiling : Infinity,
  )
  // A healthy mix needs no boost, so the floor cannot change the answer.
  if (nonFloor <= 1) return m
  const floorBound = m.floorRms && m.floorRms > 0 ? NORMALIZE_FLOOR_CEILING_RMS / m.floorRms : Infinity
  if (floorBound < nonFloor) return null
  return m
}

/** How many windows a selection must hold before its percentiles mean anything
 *  — 3 s of audio. Below that the p90 is one or two windows and the probe,
 *  which measures the whole output including the silence between spans, is the
 *  more honest answer. */
const MIN_ENVELOPE_WINDOWS = 30

/**
 * The same shortcut for an EDITED export (task X1).
 *
 * The probe pass exists to rebuild an envelope capture already measured and
 * then threw away. With `CaptureLoudness.envelope` kept in time order, an edit
 * does not need a second decode of every audio channel: p90/p20/p99 are
 * statistics of a MULTISET, so the windows lying inside the kept spans are the
 * whole answer and their order never mattered.
 *
 * Returns null — caller probes — whenever the kept windows would describe a
 * different signal from the one the file will carry:
 *  · no envelope (a take recorded before X1, or no capture stats at all);
 *  · a channel set that is not exactly what capture summed (same rule, same
 *    reason as loudnessFromCaptureStats);
 *  · a PER-CHANNEL trim, which removes one contributor part-way through a kept
 *    span while the stored windows there still hold its contribution;
 *  · a SPED span (F5b): WSOLA retimes the material, so a 100 ms source window
 *    is no longer a 100 ms output window and the multiset is reweighted;
 *  · too few windows survive to carry a percentile;
 *  · the codec-floor guard above.
 */
export function loudnessFromCaptureEnvelope(
  stats: CaptureLoudness | undefined,
  recording: Recording,
  edit: EditState,
  channelIds: string[],
  gain: number,
): MixLoudness | null {
  const env = stats?.envelope
  if (!stats || !env || stats.frames <= 0) return null
  const n = Math.min(env.windowRms.length, env.windowPeak.length)
  if (n <= 0 || !(env.windowMs > 0)) return null

  const distinct = [...new Set(channelIds)]
  if (distinct.length !== stats.channelIds.length) return null
  if (!distinct.every((id) => stats.channelIds.includes(id))) return null

  for (const c of recording.channels) {
    if (c.media !== 'audio') continue
    const ce = edit.channels.find((x) => x.channelId === c.id)
    if (!ce || !ce.enabled) continue // a dropped channel already failed the set check
    if (ce.trimStartMs > 0 || ce.trimEndMs < c.durationMs) return null
  }

  const rms: number[] = []
  const winPeaks: number[] = []
  // `peak` is a MAX, so a window the edit only partly keeps may still hold it.
  // Including those can only overestimate, which is the safe direction and the
  // one the probe takes too (its windows straddle the joins).
  let peak = 0
  for (const seg of keptSegments(edit)) {
    if (segmentSpeed(seg) !== 1) return null
    const first = Math.max(0, Math.floor((seg.startMs - env.startMs) / env.windowMs))
    const last = Math.min(n - 1, Math.ceil((seg.endMs - env.startMs) / env.windowMs) - 1)
    for (let i = first; i <= last; i++) {
      const winStart = env.startMs + i * env.windowMs
      const p = env.windowPeak[i]!
      if (p > peak) peak = p
      // Percentiles take only windows the edit keeps WHOLE — a straddling
      // window is part of a signal the file does not contain.
      if (winStart >= seg.startMs && winStart + env.windowMs <= seg.endMs) {
        rms.push(env.windowRms[i]!)
        winPeaks.push(p)
      }
    }
  }
  if (rms.length < MIN_ENVELOPE_WINDOWS) return null

  rms.sort((a, b) => a - b)
  winPeaks.sort((a, b) => a - b)
  const at = (q: number, w: number[]): number => w[Math.min(w.length - 1, Math.floor(q * w.length))]!
  return guardCodecFloor({
    peak: peak * gain,
    peakRobust: at(0.99, winPeaks) * gain,
    loudRms: at(0.9, rms) * gain,
    floorRms: at(0.2, rms) * gain,
  })
}

/**
 * Makeup gain that drives speech-level loudness to target. Only ever boosts
 * (a healthy or hot mix passes at 1.0); gated so noise-only takes stay put;
 * peak-bounded so sustained program cannot be driven deep into the limiter;
 * floor-bounded so the boost cannot raise the noise floor into audibility.
 */
/**
 * O10(a) — the SAME bounds, driven by an R128 target instead of the p90 RMS.
 *
 * The bounds are the point of reusing this: a loudness target on its own would
 * happily ask a quiet take for 12x, lifting its room tone into audibility — the
 * exact failure NORMALIZE_FLOOR_CEILING_RMS exists to prevent, and the exact
 * complaint Robert raised about the peak licence. So the only thing that changes
 * between the two modes is what `wanted` is; the peak ceiling, the noise-floor
 * ceiling and the "never attenuate" rule are shared, and a take that would be
 * unsafe under one is unsafe under the other.
 *
 * NOT SYMMETRIC WITH THE p90 PATH IN ONE RESPECT, deliberately: R128 can ask
 * for a gain BELOW 1 (bright content measured 8 dB hot in the o10 rig), and the
 * shipped path never attenuates. Attenuation is left out here too — turning a
 * take DOWN is a bigger behaviour change than turning it up, it interacts with
 * the limiter's knee, and it is not what "targeting" has to mean to be useful.
 * The asked-for figure is returned in the stats so the gap is visible.
 */
export function makeupGainForTargetLufs(m: MixLoudness, wanted: number): number {
  const ceiling = m.peakRobust ?? m.peak
  const licence =
    m.peakRobust !== undefined ? NORMALIZE_PEAK_OVERDRIVE : NORMALIZE_PEAK_OVERDRIVE_RAW
  const peakBound = ceiling > 0 ? (licence * LIMIT_KNEE) / ceiling : Infinity
  const floorBound =
    m.floorRms && m.floorRms > 0 ? NORMALIZE_FLOOR_CEILING_RMS / m.floorRms : Infinity
  return Math.max(1, Math.min(NORMALIZE_MAX_MAKEUP, wanted, peakBound, floorBound))
}

export function makeupGainForLoudness(m: MixLoudness): number {
  if (!(m.loudRms > NORMALIZE_GATE_RMS)) return 1
  const wanted = NORMALIZE_TARGET_RMS / m.loudRms
  // peakRobust, not peak — and the LICENCE moves with the statistic. A take
  // that carries the robust ceiling is protected from a stray transient, so it
  // needs only the tight licence; one that does not keeps the wide licence it
  // was recorded under. Same answer as before for every old take.
  const ceiling = m.peakRobust ?? m.peak
  const licence =
    m.peakRobust !== undefined ? NORMALIZE_PEAK_OVERDRIVE : NORMALIZE_PEAK_OVERDRIVE_RAW
  const peakBound = ceiling > 0 ? (licence * LIMIT_KNEE) / ceiling : Infinity
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

/**
 * One decoded audio sample → the two Float32 planes the mixer reads.
 *
 * O5 moved the export into a worker, and Web Audio is `[Exposed=Window]`: the
 * AudioBufferSink this used to run on constructs AudioBuffers and therefore
 * cannot exist off the main thread. AudioSampleSink decodes the identical PCM
 * through WebCodecs and hands it over as raw planes, so this is a change of
 * CARRIER, not of content — the fidelity oracle is what proves that, and it is
 * why the port went in before the worker did rather than alongside it.
 *
 * The sample is closed here: mediabunny's samples hold decoder resources, and
 * the mixer only ever needs the numbers.
 */
function planesOf(s: AudioSample): { left: Float32Array; right: Float32Array } {
  const frames = s.numberOfFrames
  const left = new Float32Array(frames)
  s.copyTo(left, { planeIndex: 0, format: 'f32-planar' })
  // Mono stays mono by SHARING the plane, exactly as the AudioBuffer path did
  // (getChannelData(0) twice) — never a silent second channel.
  let right = left
  if (s.numberOfChannels > 1) {
    right = new Float32Array(frames)
    s.copyTo(right, { planeIndex: 1, format: 'f32-planar' })
  }
  return { left, right }
}

export class AudioChannelMixer implements MixSource {
  private readonly iter: AsyncGenerator<AudioSample, void, unknown>
  private curr: CurrentBuffer | null = null
  private pending: AudioSample | null = null
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
    sink: AudioSampleSink,
    /** Which ChannelRecording this mixes — matched against Recording.loudness. */
    readonly channelId: string,
    /** Channel's active window on the output timeline, seconds. */
    private readonly outStartSec: number,
    private readonly outEndSec: number,
    /** localSec = outSec + localOffsetSec */
    private readonly localOffsetSec: number,
  ) {
    /* B13(3): filled in on the first buffer, rebuilt if the rate changes. */
    this.iter = sink.samples(
      Math.max(0, outStartSec + localOffsetSec),
      outEndSec + localOffsetSec,
    )
  }

  private interp: AudioInterpolator = sampleAt
  private interpRate = 0

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
        // B13(3): one interpolator per source rate, built once and reused. A
        // decoded buffer can change rate mid-take (a segmented channel), so it
        // is keyed on the rate rather than assumed for the channel.
        if (cur.rate !== this.interpRate) {
          this.interpRate = cur.rate
          this.interp = interpolatorFor(cur.rate, sr)
        }
        const interp = this.interp
        for (; k < runEnd; k++, srcPos += step) {
          let sL = interp(cur.left, srcPos)
          let sR = interp(cur.right, srcPos)

          // Heal discontinuous seams between mix chunks (and decoded-buffer
          // joins that land on k===0 of a new chunk).
          if (this.hasPrev && k === 0) {
            const jump = Math.max(Math.abs(sL - this.prevL), Math.abs(sR - this.prevR))
            if (jump > 0.05) {
              const fade = Math.min(SEAM_FADE, runEnd)
              for (let i = 0; i < fade; i++) {
                const t = (i + 1) / (fade + 1)
                const pos = srcPos + i * step
                const nL = interp(cur.left, pos)
                const nR = interp(cur.right, pos)
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

  private setCurrent(s: AudioSample): void {
    const { left, right } = planesOf(s)
    this.curr = {
      startSec: s.timestamp,
      endSec: s.timestamp + left.length / s.sampleRate,
      rate: s.sampleRate,
      left,
      right,
    }
    s.close()
  }

  dispose(): void {
    this.curr = null
    this.pending?.close()
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
      new AudioSampleSink(track),
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
  const { peak, peakRobust, loudRms, floorRms } = await measureMixEnvelope(
    mixers,
    gain,
    totalAudioFrames,
    throwIfAborted,
    onProgress,
  )
  // peakRobust travels. It used to be dropped here — measureMixEnvelope has
  // computed it since 2026-08-25 and this destructure took three fields of the
  // four — so the PROBE path, which is what every take without capture stats
  // gets, still bounded on the raw `peak` under the wide pre-statistic licence.
  // That is the regression the statistic was added to end, so the fix was
  // shipping to nobody: found by X1's rig lane printing `probe.peakRobust: 0`.
  return { peak, peakRobust, loudRms, floorRms }
}

export interface MixEnvelope extends MixLoudness {
  /** 100 ms window RMS of the mid signal, IN TIME ORDER. */
  windowRms: Float32Array
  windowMs: number
  /**
   * O10(a): BS.1770 integrated loudness of the SAME pass. Free to take — the
   * probe already has the mixed PCM in hand and the accumulator is streaming,
   * so this costs one biquad pair per sample and no memory that scales with
   * length. Reported even in p90 mode, because a number nobody can see is a
   * number nobody can check.
   */
  integratedLufs: number | null
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
  const lufs = new LufsAccumulator(AUDIO_SAMPLE_RATE)
  const windowRms: number[] = []
  const windowPeak: number[] = []
  let winSumSq = 0
  let winPeak = 0
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
    lufs.add(left, right, frames)
    for (let k = 0; k < frames; k++) {
      const a = Math.abs(left[k])
      const b = Math.abs(right[k])
      const s = a > b ? a : b
      if (s > peak) peak = s
      if (s > winPeak) winPeak = s
      // Mono-fold energy for the loudness windows (mid signal).
      const mid = 0.5 * (left[k] + right[k])
      winSumSq += mid * mid
      if (++winCount === LOUDNESS_WINDOW_FRAMES) {
        windowRms.push(Math.sqrt(winSumSq / winCount))
        windowPeak.push(winPeak)
        winSumSq = 0
        winPeak = 0
        winCount = 0
      }
    }
    onProgress?.((c + 1) / chunks)
    await new Promise((r) => setTimeout(r, 0))
  }
  if (winCount > 0) {
    windowRms.push(Math.sqrt(winSumSq / winCount))
    windowPeak.push(winPeak)
  }
  // Percentiles need it sorted; the caller needs it in time order. Sort a copy.
  const inOrder = Float32Array.from(windowRms)
  windowRms.sort((a, b) => a - b)
  windowPeak.sort((a, b) => a - b)
  // p99 of window peaks: high enough that it still tracks the take's real
  // ceiling, robust enough that one transient window cannot define it.
  const peakRobust = windowPeak.length
    ? windowPeak[Math.min(windowPeak.length - 1, Math.floor(0.99 * windowPeak.length))]!
    : peak
  const loudRms = windowRms.length
    ? windowRms[Math.min(windowRms.length - 1, Math.floor(0.9 * windowRms.length))]
    : 0
  const floorRms = windowRms.length
    ? windowRms[Math.min(windowRms.length - 1, Math.floor(0.2 * windowRms.length))]
    : 0
  return {
    peak,
    peakRobust,
    loudRms,
    floorRms,
    windowRms: inOrder,
    windowMs: (LOUDNESS_WINDOW_FRAMES / AUDIO_SAMPLE_RATE) * 1000,
    integratedLufs: lufs.finish().integratedLufs,
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

export async function openAudioMixers(
  recording: Recording,
  edit: EditState,
  throwIfAborted: () => void,
): Promise<MixSource[]> {
  const out: MixSource[] = []
  let outCursor = 0
  for (const seg of keptSegments(edit)) {
    const speed = segmentSpeed(seg)
    const segOutLen = segmentOutputMs(seg)
    // Channels of a SPED span are collected and handed to one stretcher, so the
    // two searches cannot pick different offsets and slide mic against system
    // audio inside the span (F5b).
    const spanMixers: AudioChannelMixer[] = []
    for (const channel of recording.channels) {
      if (channel.media !== 'audio') continue
      throwIfAborted()
      const ce = edit.channels.find((c) => c.channelId === channel.id)
      if (!ce || !ce.enabled) continue
      const recStart = channel.startOffsetMs + Math.max(0, ce.trimStartMs)
      const recEnd = channel.startOffsetMs + Math.min(channel.durationMs, ce.trimEndMs)
      const from = Math.max(recStart, seg.startMs)
      const to = Math.min(recEnd, seg.endMs)
      if (to <= from) continue
      const blob = await blobStore.read(channel.blobKey)
      if (speed === 1) {
        // One mixer per (channel x kept segment): each streams forward over its
        // own output span with its own source offset, so the existing
        // forward-only mixer needs no change to support cuts.
        const m = await openAudioChannel(
          blob,
          channel.id,
          (outCursor + (from - seg.startMs)) / 1000,
          (outCursor + (to - seg.startMs)) / 1000,
          (seg.startMs - outCursor - channel.startOffsetMs) / 1000,
        )
        if (m) out.push(m)
      } else {
        // IDENTITY mapping, in RECORDING seconds: the span's stretcher is what
        // turns recording time into output time, so the mixer must hand over
        // the material exactly as recorded.
        const m = await openAudioChannel(
          blob,
          channel.id,
          from / 1000,
          to / 1000,
          -channel.startOffsetMs / 1000,
        )
        if (m) spanMixers.push(m)
      }
    }
    if (speed !== 1 && spanMixers.length > 0) {
      out.push(
        new SpeedSpanMixer(
          spanMixers,
          outCursor / 1000,
          (outCursor + segOutLen) / 1000,
          seg.startMs / 1000,
          seg.endMs / 1000,
          speed,
        ),
      )
    }
    outCursor += segOutLen
  }
  return out
}

/**
 * Headroom for the render sum, counted in DISTINCT CHANNELS.
 *
 * It used to count MIXERS, and F1 had quietly made those different things: one
 * mic cut into three spans opens three mixers, so a cut take exported at 1/3
 * gain — 9.5 dB down — with the loudness normalizer silently spending its
 * makeup budget undoing it. Mixers for different spans never overlap in output
 * time, so they cannot sum and must not be staged against each other.
 */
export function busGainFor(sources: MixSource[]): number {
  const distinct = new Set(sources.flatMap((m) => m.channelIds)).size
  return distinct > 1 ? mixGainForChannels(distinct) : 1
}

/**
 * The mixed stereo chunk as the muxer wants it (task O5).
 *
 * Was `new AudioBuffer(...)` + AudioBufferSource in both export paths. Web
 * Audio does not exist in a worker, so the carrier is now an AudioSample over
 * f32-planar bytes: the two planes laid end to end, which is exactly what
 * copyToChannel used to produce. Same samples, same order, same rate — one
 * builder so the instant path and the render path cannot drift apart.
 */
export function makeStereoSample(
  left: Float32Array,
  right: Float32Array,
  timestampSec: number,
): AudioSample {
  const frames = left.length
  const data = new Float32Array(frames * AUDIO_CHANNEL_COUNT)
  data.set(left, 0)
  data.set(right, frames)
  return new AudioSample({
    data,
    format: 'f32-planar',
    numberOfChannels: AUDIO_CHANNEL_COUNT,
    sampleRate: AUDIO_SAMPLE_RATE,
    timestamp: timestampSec,
  })
}

/** Pure helpers exported for unit tests. */
export const audioMixInternals = {
  hermite,
  sampleAt,
  softLimitSample,
  mixGainForChannels,
  makeupGainForLoudness,
}
