/**
 * Measured audio capture — replaces MediaRecorder for mic / system-audio.
 *
 * Pipeline: AudioWorklet PCM (sample-counted) → first-sample wall clock
 * anchored to session epoch → WebCodecs AudioEncoder (opus) →
 * mediabunny EncodedAudioPacketSource → WebM → OPFS write stream.
 *
 * startOffsetMs = performance.now() at first PCM − session epoch.
 * No onstart heuristic, no machine-specific lag constants.
 */

import {
  EncodedAudioPacketSource,
  EncodedPacket,
  Output,
  StreamTarget,
  WebMOutputFormat,
  type StreamTargetChunk,
} from 'mediabunny'
import {
  audioTapChoice,
  audioTapThreadChoice,
  canReadTrackPcm,
  canTransferReadable,
  trackPcmReadable,
  trackPcmReader,
  trackPcmSampleRate,
  trackTapBufferChunks,
  trackTapBufferMs,
} from './audioTap'
import type { AudioTapMsg, AudioTapReply } from './audioTap.worker'
import { ReviveSchedule, SILENCE_CONVICTS_AT_ATTEMPT } from './reviveSchedule'
import { RealmOffset } from '@core/realmClock'
import { WallClockHold, compressInterleaved } from './wallClockHold'

const WORKLET_NAME = 'inout-pcm-capture'
const OPUS_BITRATE = 128_000
/** Anchor min-filter window; at 50ppm clock skew the bias stays < 0.2ms. */
const ANCHOR_WINDOW_S = 3
/** How far past the take's own arithmetic an anchor may still be believed.
 *  Batching, the drain and the stop budget all cost real milliseconds; a
 *  second of them is jitter, and the failure this bounds was 30,445,691. */
const ANCHOR_SLACK_MS = 1000

/** Nearest-rank quantile over an unsorted sample. Copies, so the caller's
 *  array keeps its order (X11a reads two quantiles off one sample). */
function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))
  return s[i]!
}
/**
 * G6(g). How soon after a tap rebuild returning sound still counts as THAT
 * rebuild having recovered it. A fresh tap on a live source sees signal in the
 * next batch or two (128-frame quanta at 48 kHz is ~2.7 ms); one second is
 * three orders of magnitude of headroom over that and still far below any
 * plausible "someone pressed play" reaction, so the two causes do not overlap.
 */
export const REVIVE_RECOVERY_FRAMES = (sampleRate: number): number => sampleRate

/** ~1.3ms, the same ramp the worklet uses on its own silence splices. */
const PAD_FADE = 64

export const MEASURED_AUDIO_MIME = 'audio/webm;codecs=opus'

/** B13. `getSettings()` in the shape the take stores — null means unreported. */
function readAudioTrackSettings(
  track: MediaStreamTrack,
): import('@core/types').DeliveredAudioSettings {
  let s: MediaTrackSettings & { latency?: number } = {}
  try {
    s = track.getSettings() as MediaTrackSettings & { latency?: number }
  } catch {
    /* a track torn down mid-read reports nothing; null is the finding */
  }
  const bool = (v: boolean | undefined): boolean | null => (typeof v === 'boolean' ? v : null)
  const num = (v: number | undefined): number | null => (typeof v === 'number' ? v : null)
  return {
    echoCancellation: bool(s.echoCancellation),
    noiseSuppression: bool(s.noiseSuppression),
    autoGainControl: bool(s.autoGainControl),
    channelCount: num(s.channelCount),
    sampleRate: num(s.sampleRate),
    latencyMs: typeof s.latency === 'number' ? Math.round(s.latency * 10000) / 10 : null,
  }
}

const WORKLET_SOURCE = `
class InoutPcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = []
    this.frames = 0
    this.channels = 1
    this.sawLive = false
    // Whether the last sample emitted by the previous flush was inserted
    // silence — lets fades span batch boundaries.
    this.prevSilent = false
    // ~21ms per post instead of 2.7ms: 8x less main-thread churn.
    this.batchFrames = 1024
    this.port.onmessage = (e) => {
      if (e.data && e.data.cmd === 'flush') {
        this.flush()
        this.port.postMessage({ flushed: true })
      }
    }
  }
  process(inputs) {
    const chans = inputs[0]
    const live = chans && chans.length && chans[0] && chans[0].length
    // Mid-stream starved quanta (bluetooth hiccups, device switches) MUST
    // become silence, not be skipped: timestamps are sample-counted, so a
    // skipped quantum splices the timeline and produces audible crackle.
    // But quanta BEFORE the first live one are the context's startup
    // catch-up burst — counting them prepends fast-forwarded silence and
    // shifts all real audio late. Sample 0 = first live sample.
    if (!live && !this.sawLive) return true
    const n = live ? chans[0].length : 128
    if (live) {
      this.sawLive = true
      this.channels = chans.length
      const copy = []
      for (let c = 0; c < chans.length; c++) copy.push(chans[c].slice(0))
      this.buf.push({ n, data: copy })
    } else {
      this.buf.push({ n, data: null })
    }
    this.frames += n
    if (this.frames >= this.batchFrames) this.flush()
    return true
  }
  flush() {
    if (!this.frames) return
    const total = this.frames
    const ch = this.channels
    const planar = new Float32Array(ch * total)
    let off = 0
    // Silence splices (starved quanta become zeros) are step discontinuities —
    // each live→silence→live edge is an audible click. Ramp ~1.3ms on both
    // sides of every splice so the timeline stays sample-counted but seamless.
    const FADE = 64
    let prevSilent = this.prevSilent
    for (const q of this.buf) {
      if (q.data) {
        for (let c = 0; c < ch && c < q.data.length; c++) planar.set(q.data[c], c * total + off)
        if (prevSilent) {
          const n = Math.min(FADE, q.n)
          for (let c = 0; c < ch; c++) {
            const base = c * total + off
            for (let i = 0; i < n; i++) planar[base + i] *= i / n
          }
        }
        prevSilent = false
      } else {
        if (!prevSilent && off > 0) {
          const n = Math.min(FADE, off)
          for (let c = 0; c < ch; c++) {
            const base = c * total + off
            for (let i = 1; i <= n; i++) planar[base - i] *= (i - 1) / n
          }
        }
        prevSilent = true
      }
      off += q.n
    }
    this.prevSilent = prevSilent
    this.port.postMessage({ frames: total, channels: ch, currentTime, planar }, [planar.buffer])
    this.buf = []
    this.frames = 0
  }
}
registerProcessor('${WORKLET_NAME}', InoutPcmCapture)
`

let workletUrl: string | null = null

function workletModuleUrl(): string {
  if (!workletUrl) {
    workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
  }
  return workletUrl
}

/**
 * Track clones created by the dead-tap revival. A page that goes away mid-take
 * (the wedge-refresh ritual, a tab close) must not leave one alive: an
 * unreleased display-capture claim is exactly what the screen-wedge family
 * feeds on, and the session's pagehide guard only knows the tracks it acquired.
 */
const liveClones = new Set<MediaStreamTrack>()
let clonePagehideGuard = false
function trackClone(t: MediaStreamTrack): void {
  liveClones.add(t)
  if (!clonePagehideGuard && typeof window !== 'undefined') {
    clonePagehideGuard = true
    window.addEventListener('pagehide', () => {
      for (const c of liveClones) c.stop()
      liveClones.clear()
    })
  }
}
function dropClone(t: MediaStreamTrack | null): void {
  if (!t) return
  t.stop()
  liveClones.delete(t)
}

export function canMeasureAudioCapture(): boolean {
  return (
    typeof AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof AudioData !== 'undefined' &&
    typeof AudioEncoder.isConfigSupported === 'function'
  )
}

export interface MeasuredAudioHandle {
  readonly mimeType: string
  /** Resolves with startOffsetMs once the first PCM quantum arrives. */
  readonly firstOffset: Promise<number>
  stop: () => Promise<{
    bytes: number
    durationMs: number
    startOffsetMs: number
    /** Silence inserted to hold the timeline against the wall clock — evidence
     *  the machine starved this take, 0 on a healthy one. */
    paddedMs: number
    /** Time removed to hold a FAST audio clock back onto the wall — evidence
     *  of the drift Robert reported 2026-08-29, 0 on a matched clock. */
    trimmedMs: number
    /** How long the channel's input had been pure digital silence when the take
     *  ended — the witness for "tab audio dies after a while": a muted or dead
     *  source records exact zeros no listener can tell from quiet. */
    silentTailMs: number
    /** Every millisecond of pure silence AFTER this channel was first heard —
     *  the number the open-run tail above cannot see. */
    silentTotalMs: number
    /** The same witnesses in persistable form — session stores them on the
     *  channel so the take carries its own evidence (the console dies with the tab). */
    diagnostics: import('@core/types').ChannelDiagnostics
  }>
  cancel: () => Promise<void>
}

/**
 * Map an AudioContext time to performance.now() using a calibration pair
 * taken at resume (not getOutputTimestamp — that clock includes output-
 * device latency and is wrong for capture-only MediaStreamSource graphs).
 */
export function contextTimeToPerformanceMs(
  contextTime: number,
  calib: { contextTime: number; performanceTime: number },
): number {
  return calib.performanceTime + (contextTime - calib.contextTime) * 1000
}

/** Compile the worklet module once (no live audio) — first-use latency killer. */
export async function prewarmWorkletModule(): Promise<void> {
  const ctx = new AudioContext()
  try {
    await ctx.audioWorklet.addModule(workletModuleUrl())
  } finally {
    await ctx.close().catch(() => undefined)
  }
}

export async function prewarmMeasuredAudio(
  track: MediaStreamTrack,
  opts?: {
    /** Output-buffer size hint. Production leaves it unset (Chrome's
     *  'interactive' default); the A1 rig passes 'playback' to price whether a
     *  bigger buffer is what the starving context needs. */
    latencyHint?: AudioContextLatencyCategory
  },
): Promise<AudioContext> {
  const trackRate = track.getSettings().sampleRate
  const audioCtx = new AudioContext({
    ...(trackRate ? { sampleRate: trackRate } : {}),
    ...(opts?.latencyHint ? { latencyHint: opts.latencyHint } : {}),
  })
  await audioCtx.audioWorklet.addModule(workletModuleUrl())
  await audioCtx.resume()
  return audioCtx
}

export async function startMeasuredAudioCapture(opts: {
  stream: MediaStream
  /** Session epoch (performance.now() at start()). */
  epoch: number
  /** Durable positioned writer (SyncAccessHandle worker) — crash-safe audio. */
  writer: import('@core/store').PositionedDurableWriter
  /** Channel name for evidence lines ('mic' / 'system-audio'); logs only. */
  label?: string
  /** Optional pre-warmed context from prewarmMeasuredAudio (arm phase). */
  audioCtx?: AudioContext
  /** Fired ONCE if capture dies mid-take (storage write / encoder failure).
   * Without it the take keeps "recording" while every later sample is lost —
   * the file just stops partway with no signal to the user. */
  onFatal?: (err: Error) => void
  /**
   * H1 harness (`?killenc=mic:9000`). Milliseconds until this channel's encoder
   * is made to report failure through the very `fatal()` a real one reaches.
   * An audio channel has no worker, so `?killworker=` does not apply to it.
   */
  killEncoderInMs?: number
  /**
   * Live PCM tap (task O2). Called once per worklet batch with the same samples
   * that go to the encoder, before any encode. `startFrame` is channel-local
   * (sample 0 = first live sample); `startOffsetMs` places that sample on the
   * session timeline. `right` aliases `left` for mono sources. Must be cheap
   * and must not throw — it runs on the capture path.
   */
  /**
   * B15 — THE CHANNEL WAS HEARD AND IS NOW WRITING PURE ZEROS, said WHILE the
   * take runs.
   *
   * Every liveness path this product had was about frames: a video source that
   * stops delivering raises 'channel-stalled' and puts a band on screen within
   * seconds. An audio source that goes dead delivers packets on time, keeps its
   * track `live` and unmuted, and writes silence — and until this callback the
   * only thing that ever said so was the editor, after the stop. Robert's 5:51
   * take carried 195 s of digital zeros and he was told nothing for any of them.
   *
   * `silent` fires ONCE per silent run and only after the rescue has tried and
   * failed twice on a live track — never on silence before the channel was
   * first heard, which is a channel that never arrived. `audible` closes it.
   * Runs on the capture path: must be cheap and must not throw.
   */
  onSilence?: (state: 'silent' | 'audible', sinceMs: number, attempts: number) => void
  onPcm?: (
    left: Float32Array,
    right: Float32Array,
    startFrame: number,
    startOffsetMs: number,
    sampleRate: number,
    /** AudioContext currentTime the worklet reported for this batch. */
    contextTime: number,
  ) => void
}): Promise<MeasuredAudioHandle> {
  const track = opts.stream.getAudioTracks()[0]
  if (!track) throw new Error('measured audio: no audio track')
  const label = opts.label ?? 'measured'

  /**
   * THE TRACK'S OWN LIFE EVENTS ARE EVIDENCE (Robert 2026-08-26: "in long video
   * tab audio still dies after a while"). Chromium is known to MUTE a captured
   * tab's audio track during captured-tab inactivity (crbug 40703184) and to
   * END display-audio tracks on audio-device changes (crbug 344876285 — AirPods
   * auto-switching is exactly that). A muted track records indistinguishable
   * silence, so without these stamps a dead tab-audio channel produces a report
   * with no numbers in it. Logs only — behaviour is unchanged.
   */
  const sinceEpochS = (): string => ((performance.now() - opts.epoch) / 1000).toFixed(1)
  /**
   * Built once the context's sample rate is known, which is several awaits
   * below — and the track's own listeners are already live by then, so every
   * touch from them is null-safe rather than a TDZ throw inside a listener.
   */
  let revive: ReviveSchedule | null = null
  /** One explanation per silent run: the muted/ended branch now gets looked at
   *  once a minute for as long as the take runs, and console work on the thread
   *  carrying the PCM is exactly what a starved audio path cannot afford. */
  let reviveSkipLogged = false
  /** B15 — has this silent run already been announced? One band per run. */
  let saidSilent = false
  /**
   * G6(g) — FRAME AT WHICH THE LAST TAP REBUILD HAPPENED, and the whole point
   * of recording it.
   *
   * A revive fires after seconds of pure digital zeros on a track that is live
   * and unmuted. It CANNOT see whether the source was silent: a paused tab and
   * a dead tap look identical from here. That ambiguity is what made the report
   * card's `rescue` dimension unpassable — 63 attempts across 15 silent runs
   * graded a take RED when every run was a quiet tab.
   *
   * There is exactly one moment the two stop looking alike: just after the
   * rebuild. If the tap was dead while the source played, the FRESH tap sees
   * signal immediately — the sound was there the whole time, we were not
   * hearing it, and that silent run is audio the take LOST. If the source was
   * simply quiet, the rebuild changes nothing and the zeros continue.
   *
   * So the capture side notes the recovery where the evidence is, and the card
   * grades loss instead of attempts.
   */
  let lastReviveFrame: number | null = null
  /** PERSISTED with the take (ChannelRecording.diagnostics): the console dies
   *  with the tab, and no field report has ever arrived with one — the file is
   *  the only witness that reliably survives to be read. */
  const diagEvents: { atMs: number; type: string }[] = []
  const noteEvent = (type: string): void => {
    if (diagEvents.length < 200) diagEvents.push({ atMs: Math.round(performance.now() - opts.epoch), type })
  }
  const onTrackMute = (): void => {
    noteEvent('mute')
    console.warn(
      `[capture] ${label} audio track MUTED at +${sinceEpochS()}s — the source delivers silence until it unmutes (crbug 40703184 family)`,
    )
  }
  const onTrackUnmute = (): void => {
    noteEvent('unmute')
    console.warn(`[capture] ${label} audio track unmuted at +${sinceEpochS()}s`)
    // A TRACK THAT UNMUTES DESERVES ANOTHER CHANCE. The revive path below
    // refuses to act on a muted track — correctly, since Chrome owns the mute
    // and a clone of a muted track is muted too — but it also burned an attempt
    // and left the exponential backoff where it was. So a source that muted
    // briefly and came back could arrive at the far end of the backoff, or out
    // of attempts entirely, and stay silent for the rest of the take with the
    // one mechanism that could rescue it already spent on the mute.
    // Robert 2026-08-30: "after 1 minute … tab audio died completly" — the same
    // shape as the 2026-08-26 autopsy (rec_cjqcxsfhg02b, zeros from t=71 s
    // while the same share's video kept playing).
    revive?.reset()
    reviveSkipLogged = false
  }
  const onTrackEndedEvidence = (): void => {
    noteEvent('ended')
    console.warn(
      `[capture] ${label} audio track ENDED at +${sinceEpochS()}s — the channel is dead from here (device change / capture revoked)`,
    )
  }
  track.addEventListener('mute', onTrackMute)
  track.addEventListener('unmute', onTrackUnmute)
  track.addEventListener('ended', onTrackEndedEvidence)
  const dropTrackEvidence = (): void => {
    track.removeEventListener('mute', onTrackMute)
    track.removeEventListener('unmute', onTrackUnmute)
    track.removeEventListener('ended', onTrackEndedEvidence)
  }

  /**
   * WHICH TAP CARRIES THE PCM. The worklet tap loses ten per cent of a take's
   * audio time on a machine whose cores are saturated — measured, see
   * audioTap.ts — and the track tap loses none. Capability decides; a platform
   * without MediaStreamTrackProcessor or without a rate on the track records
   * through the unchanged worklet path.
   */
  const useTrackTap = audioTapChoice() === 'track' && canReadTrackPcm(track)
  if (useTrackTap && opts.audioCtx && opts.audioCtx.state !== 'closed') {
    // The arm phase prewarms a context for the worklet tap. This channel is not
    // going to use one, and an AudioContext left open holds an output device
    // for the length of the take for nothing.
    void opts.audioCtx.close().catch(() => undefined)
  }

  // BOUNDED init: AudioContext setup on wedged hardware can pend forever, and
  // session.stop() awaits this whole function — an unbounded hang here wedges
  // both start AND stop. Fail the channel loudly instead.
  const audioCtx: AudioContext | null = useTrackTap
    ? null
    : opts.audioCtx && opts.audioCtx.state !== 'closed'
      ? opts.audioCtx
      : await new Promise<AudioContext>((resolve, reject) => {
          let late = false
          const timer = setTimeout(() => {
            late = true
            reject(new Error('measured audio: context init timed out after 5000ms'))
          }, 5000)
          prewarmMeasuredAudio(track).then(
            (ctx) => {
              if (late) {
                void ctx.close().catch(() => undefined)
                return
              }
              clearTimeout(timer)
              resolve(ctx)
            },
            (err) => {
              clearTimeout(timer)
              if (!late) reject(err)
            },
          )
        })


  // The context's own life events are the third witness (mute and ended are
  // the other two): a default-output-device switch mid-take (AirPods
  // auto-switching) can suspend or interrupt a rendering context, and that
  // reads as "audio just stops" with a healthy track.
  if (audioCtx) {
    audioCtx.onstatechange = () => {
      if (audioCtx.state !== 'closed') {
        noteEvent(`ctx:${audioCtx.state}`)
        console.warn(
          `[capture] ${label} AudioContext state → ${audioCtx.state} at +${sinceEpochS()}s`,
        )
      }
    }
  }

  const sampleRate = audioCtx ? audioCtx.sampleRate : trackPcmSampleRate(track)
  /**
   * The anchor dates sample 0 from when its batch ARRIVES. Everything upstream
   * — device capture buffer, stream transport — happened before that and is
   * invisible to it, so the anchor is late by exactly the input latency and the
   * export places audio that much late. Measured on a loopback rig: impulses
   * landed +128.7 ms late with sd 0.70, and dating sample 0 from the audio
   * clock instead of message arrival changed it by 1.1 ms — the delay is in the
   * signal path, not the messaging, so no amount of anchor cleverness sees it.
   *
   * The platform does report the part it knows: the track's own latency. Use
   * that, bounded, and log it — never a fitted constant (a 90 ms fallback was
   * rejected on exactly those grounds in the 2026-07 sync work).
   */
  // `latency` is in MediaTrackSupportedConstraints but not in this TS lib's
  // MediaTrackSettings; Chrome reports it for audio input tracks.
  const reportedLatencySec = (track.getSettings() as MediaTrackSettings & { latency?: number })
    .latency
  /**
   * B13(1), MEASURED AND CLOSED 2026-09-02: this subtraction is SHORT, not long.
   * The platform reports a constant — 10.0 ms at 48 kHz, 2.9 ms at 44.1 kHz,
   * never varying — while the real capture-to-arrival delay measured 20.6 ms on
   * tab audio and 11.7-41.7 ms on a mic across runs (X14a). So the sound is
   * placed 10.8-17.7 ms LATE, and a flag that removed the subtraction entirely
   * (there was one for an hour) made it worse and was deleted. The real repair
   * is X14's: anchor on `AudioData.timestamp`, which is on the page clock and
   * tracks a delay this constant cannot.
   */
  const reportedLatencyMs =
    typeof reportedLatencySec === 'number' && reportedLatencySec > 0
      ? Math.min(200, reportedLatencySec * 1000)
      : 0
  const inputLatencyMs = reportedLatencyMs
  // B13 / G6(h). What the platform DELIVERED, read now and again at stop, so a
  // take can be adjudicated after the console that logged it is gone.
  const deliveredSettings = readAudioTrackSettings(track)
  console.info(
    `[capture] ${label} track delivered: ec=${deliveredSettings.echoCancellation ?? 'unreported'} ` +
      `ns=${deliveredSettings.noiseSuppression ?? 'unreported'} agc=${deliveredSettings.autoGainControl ?? 'unreported'} ` +
      `ch=${deliveredSettings.channelCount ?? 'unreported'} sr=${deliveredSettings.sampleRate ?? 'unreported'} ` +
      `latency=${deliveredSettings.latencyMs ?? 'unreported'}ms`,
  )
  // Unreported channelCount (Chromium often omits it for display/system audio)
  // must default to STEREO: assuming mono downmixes tab music irreversibly,
  // while assuming stereo on a true mono source just duplicates the channel.
  const numberOfChannels = Math.min(2, Math.max(1, track.getSettings().channelCount ?? 2))

  const config: AudioEncoderConfig = {
    codec: 'opus',
    sampleRate,
    numberOfChannels,
    bitrate: OPUS_BITRATE,
  }
  const support = await AudioEncoder.isConfigSupported(config)
  if (!support.supported) {
    if (!opts.audioCtx && audioCtx) await audioCtx.close().catch(() => undefined)
    throw new Error('measured audio: opus AudioEncoder config unsupported')
  }

  let bytesWritten = 0
  let fatalError: Error | null = null
  const fatal = (err: unknown): void => {
    if (fatalError) return
    fatalError = err instanceof Error ? err : new Error(String(err))
    console.error('[capture] measured audio fatal', fatalError)
    try {
      opts.onFatal?.(fatalError)
    } catch {
      /* listener threw */
    }
  }
  if (opts.killEncoderInMs !== undefined && opts.killEncoderInMs > 0) {
    // H1 harness. One-shot, uncleared: a take that ends first has already had
    // its context closed and `fatal` is a no-op after the first call anyway.
    setTimeout(() => fatal(new Error('induced encoder error (?killenc)')), opts.killEncoderInMs)
  }
  const sinkStream = new WritableStream<StreamTargetChunk>({
    async write(chunk) {
      try {
        await opts.writer.write(chunk.data, chunk.position)
        bytesWritten = Math.max(bytesWritten, chunk.position + chunk.data.byteLength)
      } catch (err) {
        fatal(err)
        throw err
      }
    },
  })

  const output = new Output({
    format: new WebMOutputFormat(),
    target: new StreamTarget(sinkStream),
  })
  const packetSource = new EncodedAudioPacketSource('opus')
  output.addAudioTrack(packetSource)
  await output.start()

  let encodeChain: Promise<void> = Promise.resolve()
  let framesWritten = 0
  let anchorWallMs = Infinity
  let lastArrivalMs = -Infinity
  /**
   * THE CHANNEL'S TIMELINE IS HELD AGAINST THE WALL CLOCK — same defect and
   * same remedy as the composite's (compositor.worker.ts, Robert 2026-08-25's
   * 4K-game take). The worklet already turns starved quanta it SEES into
   * silence, because a skipped quantum splices a sample-counted timeline. What
   * neither it nor the sample count can see is a quantum the AudioContext never
   * rendered at all: measured on a loaded machine, a context returned 56.1 s of
   * quanta in 59.2 s of wall time, which shortens the channel by ~5 % and moves
   * everything after the loss that much earlier against the picture. This is
   * the path EVERY export mixes its audio from, so it needs the guard most.
   *
   * The decision lives in WallClockHold (shared with the composite worker)
   * because the first inline copy here was DEAD — it compared the arrival
   * stamp against itself, so the origin was never set and no take ever padded,
   * which is how the 08-25 fix shipped without reaching the audio Robert hears.
   */
  const wallHold = new WallClockHold({ sampleRate })
  let paddedFrames = 0
  /** Frames removed to walk a fast audio clock back onto the wall (Robert 2026-08-29). */
  let trimmedFrames = 0
  /** Input-silence witness. A muted track, a dead source and a paused player
   *  all deliver EXACT digital silence, which no rig and no listener can tell
   *  apart after the fact — so the channel tracks where the last signal was.
   *  Below this floor nothing dithered or live ever sits; zeros do. */
  const SILENCE_FLOOR = 1e-5
  /**
   * THE TAP IS REBUILT WHEN THE TAP IS DEAD (Robert 2026-08-26, autopsied take
   * rec_cjqcxsfhg02b: tab audio recorded pure zeros from t=71 s to the end of a
   * 7.5-min take while the SAME share's video kept delivering a playing movie —
   * an audio-only capture death on a live, unmuted track, which is the known
   * Chromium class where a MediaStreamSource goes permanently silent, e.g.
   * after an audio-device change). Recovery: build a NEW source on a CLONE of
   * the track (cloning re-taps the capture) and swap it in. SAFE BY
   * CONSTRUCTION: it fires only after seconds of pure digital silence, the
   * worklet keeps the timeline sample-counted through the swap, and on a
   * genuinely silent source the swap just yields the same silence — so a false
   * positive costs nothing audible. A muted or ended track is NOT revivable
   * from here (Chrome owns the mute); that case is logged and left alone.
   *
   * WHEN it fires is reviveSchedule.ts, and it never stops firing — the six-
   * attempt lifetime cap that shipped with this is what abandoned 25 minutes of
   * Robert's 50-minute take (rec_78ogcw052vdn, autopsied there).
   */
  revive = new ReviveSchedule({ sampleRate })
  let revivals = 0
  /** Last sample per channel of the previous batch — the fade-out needs a value. */
  const lastSample = new Float32Array(2)
  let flushResolve: (() => void) | null = null
  let startOffsetMs: number | null = null
  let resolveFirst!: (ms: number) => void
  const firstOffset = new Promise<number>((r) => {
    resolveFirst = r
  })
  let stopped = false
  let encodeError: Error | null = null

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      encodeChain = encodeChain.then(() =>
        packetSource.add(EncodedPacket.fromEncodedChunk(chunk), meta),
      )
    },
    error: (err) => {
      encodeError = err instanceof Error ? err : new Error(String(err))
      console.error('[capture] AudioEncoder error', err)
      fatal(err)
    },
  })
  encoder.configure(config)

  let sourceNode: MediaStreamAudioSourceNode | null = null
  /** After a revival the source runs on a CLONE of the track; kept to stop it. */
  let sourceClone: MediaStreamTrack | null = null
  let worklet: AudioWorkletNode | null = null
  if (audioCtx) {
    sourceNode = audioCtx.createMediaStreamSource(opts.stream)
    worklet = new AudioWorkletNode(audioCtx, WORKLET_NAME, {
      numberOfInputs: 1,
      // Safari stops rendering any capture subgraph that never reaches the
      // destination: with numberOfOutputs:0 the worklet ran ~1s then went idle,
      // truncating audio to a second while MediaRecorder video stayed full
      // length. Give it a (silent) output so it can be routed to the destination
      // through a zero-gain node below — keeps every browser pulling the graph.
      numberOfOutputs: 1,
      outputChannelCount: [numberOfChannels],
      channelCount: numberOfChannels,
    })
  }

  /**
   * THE TRACK TAP'S STATE. The reader is swapped WHOLE on a revival, so the
   * pump loop below identity-checks the reader it was started with and retires
   * itself the moment it is no longer the current one — two pumps must never
   * both be feeding the timeline.
   */
  let trackReader: ReadableStreamDefaultReader<AudioData> | null = null
  /** Chunks waiting to be batched. MediaStreamTrackProcessor delivers ~128
   *  frames at a time (~3 ms); handing those straight on would be 344 encode
   *  calls a second where the worklet's own batching costs 43. */
  const TRACK_BATCH_FRAMES = 1024
  let pending: Float32Array[][] = []
  let pendingFrames = 0
  let pendingChannels = 1
  let lastChunkTimeS = 0
  /** One explanation per run. A chunk the reader cannot convert would otherwise
   *  warn 344 times a second — console work on the thread carrying the PCM is
   *  the exact cost this task exists to remove (see the revive-skip note). */
  let chunkWarnLogged = false
  /**
   * B12 — THE THREE WAYS AUDIO TIME GOES MISSING, TOLD APART IN THE FILE.
   *
   * Both measured-audio channels of H2's heavy cells ended tens of seconds
   * short of the take on a clean stop, and nothing in the artifact could say
   * which of these it was:
   *
   *   1. the SOURCE rendered fewer quanta than wall time — chunks stay
   *      contiguous, media time falls behind, WallClockHold's `paddedMs` is the
   *      repayment and already says so;
   *   2. the CONSUMER could not keep up — MediaStreamTrackProcessor drops what
   *      it cannot hand over and the chunk timestamps JUMP. That audio was
   *      captured and thrown away here; no padding gets it back. `tapGapMs`;
   *   3. the tap STOPPED — no gap, no pad, the timeline simply ends. Only the
   *      wall time of the last batch can say it: `lastArrivalMs`.
   *
   * `tapGapMs` is the track tap's alone (the worklet is handed quanta and
   * cannot see what was never rendered); `lastArrivalMs` is written by both.
   * A revival resets the continuity check — a swap is `revivals`' business, and
   * counting its seam here would price one loss twice.
   */
  const TAP_GAP_FLOOR_US = 1_000
  let tapPrevEndUs: number | null = null
  let tapGapUs = 0
  let tapMaxGapUs = 0
  /**
   * X11a — THE READER ON ITS OWN THREAD. When the readable transfers, the pump
   * above never runs: `audioTap.worker.ts` holds the reader and posts the same
   * batches, so a stalled main thread costs the take nothing instead of ~87 ms
   * (measured: 20.0 s of block cost the main-thread reader 13.8-15.3 s of audio
   * and the worker reader 0, scripts/x11a-workertap.mjs). Null = the main pump.
   */
  let tapWorker: Worker | null = null
  /**
   * THE WORKER'S CLOCK MINUS THIS THREAD'S, MEASURED FROM THE BATCHES
   * THEMSELVES. It replaces `performance.timeOrigin` arithmetic, which is a
   * shared clock only in a page younger than its machine's last sleep — the
   * 553-minute take is written up in core/realmClock.ts. One per worker: a
   * revival that builds a new one starts a new zero.
   */
  let tapRealm = new RealmOffset()
  /** Bumped on every revival; a retiring pump's batches are ignored. */
  let tapGeneration = 0
  let tapEndedResolve: (() => void) | null = null
  /**
   * X11a — MAIN-THREAD RECEIPT MINUS THE WORKER'S OWN STAMP, per batch.
   *
   * The measurement of the correction this path exists to need: how late the
   * page is to a batch the worker finished. It is the whole of what moving the
   * reader could do to the anchor, and it can only ever run one way — the
   * stamp precedes its own delivery — so a small reading here is the evidence
   * that the sound did not move. Kept unsummarised (a take is ~43 batches a
   * second, ~2,600 a minute of Float64) and reduced once at stop.
   */
  const tapHandoffMs: number[] = []
  /** Set only when the stop below threw an impossible anchor away. Null on
   *  every healthy take, which is what makes its presence a finding. */
  let anchorRefusedMs: number | null = null
  /**
   * B12's gap counter is CUMULATIVE ACROSS REVIVALS on the main pump — it is
   * never reset by `swapTrackReader` — and the worker's is cumulative per
   * generation, because a new pump starts a new count. Without this base the
   * two arms would disagree about the same take: a revived worker take would
   * report only the gap since its last revival. The generation's running total
   * is banked here when the next one opens.
   */
  let tapGapBaseUs = 0
  let tapGapThisGenUs = 0

  const onBatch = (
    frames: number,
    channels: number,
    currentTime: number,
    planar: Float32Array,
    /**
     * X11a. When the reader is a thread away, the batch carries the moment it
     * was completed THERE, converted into this thread's frame. Without it the
     * anchor dates sample 0 from a postMessage's receipt and places the whole
     * take ~14 ms late (measured). Absent = stamp it here, which is A1's
     * behaviour exactly.
     */
    arrivalOverrideMs?: number,
  ): void => {
    if (stopped || fatalError) return
    // Anchor estimation: arrival wall time minus the audio-time of the frames
    // already received dates sample 0. Main-thread scheduling can only delay
    // arrival (one-sided error), so the MIN over many quanta converges on the
    // true wall time of sample 0 — the single-first-arrival anchor was exactly
    // the source of the +45–50ms audio-late runs. Window capped so audio-clock
    // vs performance.now drift (~50ppm) cannot bias the estimate.
    const arrivalMs = arrivalOverrideMs ?? performance.now()
    // Spacing vs the PREVIOUS batch, taken before the stamp moves: comparing
    // against a stamp this same batch just wrote reads 0 forever, which is the
    // ordering bug that killed the wall-clock hold below for a day.
    const sincePrevArrivalMs = arrivalMs - lastArrivalMs
    lastArrivalMs = arrivalMs
    if (framesWritten < ANCHOR_WINDOW_S * sampleRate) {
      // Catch-up bursts after resume() deliver quanta back-to-back; their
      // arrival times date sample 0 falsely early. Only steady-state quanta
      // (spaced >= half a quantum) may contribute anchor candidates.
      const quantumMs = (frames / sampleRate) * 1000
      if (sincePrevArrivalMs >= quantumMs / 2) {
        // Batches arrive when their LAST sample was rendered — date sample 0
        // from the end of the message, or batching biases the anchor late.
        const cand = arrivalMs - ((framesWritten + frames) / sampleRate) * 1000
        if (cand < anchorWallMs) anchorWallMs = cand
      }
    }
    if (startOffsetMs === null) {
      startOffsetMs = performance.now() - opts.epoch
      resolveFirst(startOffsetMs)
      console.info(
        `[capture] ${label} audio first-sample offset=${startOffsetMs.toFixed(1)}ms provisional ` +
          `(ctx=${currentTime.toFixed(4)}s rate=${sampleRate})`,
      )
    }

    const encCh = numberOfChannels
    const interleaved = new Float32Array(frames * encCh)
    if (channels === 1 && encCh === 1) {
      interleaved.set(planar.subarray(0, frames))
    } else if (channels >= 2 && encCh === 2) {
      const L = planar.subarray(0, frames)
      const R = planar.subarray(frames, frames * 2)
      for (let i = 0; i < frames; i++) {
        interleaved[i * 2] = L[i]!
        interleaved[i * 2 + 1] = R[i]!
      }
    } else if (channels >= 2 && encCh === 1) {
      const L = planar.subarray(0, frames)
      const R = planar.subarray(frames, frames * 2)
      for (let i = 0; i < frames; i++) interleaved[i] = 0.5 * (L[i]! + R[i]!)
    } else {
      for (let i = 0; i < frames; i++) {
        interleaved[i * 2] = planar[i]!
        interleaved[i * 2 + 1] = planar[i]!
      }
    }

    // What actually reaches the encoder. Normally the interleaved batch as
    // delivered; a wall-clock TRIM replaces it with a slightly shorter resample
    // of itself, so everything downstream reads these two and not `frames`.
    let encBuf = interleaved
    let encFrames = frames

    // Loudness tap: the certified mix is measured here, live, from the very
    // samples about to be encoded — so no export has to decode them again.
    if (opts.onPcm) {
      try {
        const L = planar.subarray(0, frames)
        const R = channels >= 2 ? planar.subarray(frames, frames * 2) : L
        opts.onPcm(L, R, framesWritten, startOffsetMs ?? 0, sampleRate, currentTime)
      } catch (err) {
        console.warn('[capture] loudness tap threw (ignored)', err)
      }
    }

    // Hold the timeline against the wall before placing this batch, in BOTH
    // directions. WallClockHold corrects only an offset that PERSISTS across
    // its settle window: a main-thread stall whose queued batches drain moments
    // later loses nothing and must not be touched, so a healthy take is
    // bit-identical to before. Positive = the context lost real time and owes
    // silence. Negative = this channel's audio clock runs FAST and the timeline
    // has walked ahead of the wall, which is what Robert hears as the sound falling
    // a second behind the picture across an hour.
    {
      const correction = wallHold.correctionFramesFor(arrivalMs, framesWritten, frames)
      if (correction < 0) {
        // Resampled shorter, not cut: no splice, so no click and no fade. See
        // the note on WallClockHold for why this is rate-limited and inaudible.
        const drop = -correction
        encBuf = compressInterleaved(interleaved, encCh, frames, drop)
        encFrames = frames - drop
        trimmedFrames += drop
      }
      const padFrames = Math.max(0, correction)
      if (padFrames > 0) {
        // Ramp out of the signal and back into it: a step to zero is a click,
        // which is the exact defect the worklet's own splice fades exist for.
        const padData = new Float32Array(padFrames * encCh)
        const head = Math.min(PAD_FADE, padFrames)
        for (let i = 0; i < head; i++) {
          const k = 1 - i / head
          for (let c = 0; c < encCh; c++) padData[i * encCh + c] = (lastSample[c] ?? 0) * k
        }
        const pad = new AudioData({
          format: 'f32',
          sampleRate,
          numberOfFrames: padFrames,
          numberOfChannels: encCh,
          timestamp: Math.round((framesWritten * 1_000_000) / sampleRate),
          data: padData,
        })
        framesWritten += padFrames
        paddedFrames += padFrames
        try {
          encoder.encode(pad)
        } finally {
          pad.close()
        }
        const tail = Math.min(PAD_FADE, encFrames)
        for (let i = 0; i < tail; i++) {
          const k = i / tail
          for (let c = 0; c < encCh; c++) encBuf[i * encCh + c] *= k
        }
        // Deliberately NOT fed to the loudness tap: the envelope describes the
        // take's CONTENT, and this silence is the machine choking, not content.
      }
    }
    for (let c = 0; c < encCh; c++) {
      lastSample[c] = encBuf[(encFrames - 1) * encCh + c] ?? 0
    }

    // Silence-run bookkeeping, on the input as delivered (pre-fade): one open
    // run at a time, closed by the first sample with signal in it. A run long
    // enough to be a dead tap (not a quiet moment) triggers the revival above.
    {
      // Non-null by construction: the schedule is built from the context's
      // sample rate, which is known long before this worklet exists.
      const rev = revive!
      let maxAbs = 0
      for (let i = 0, n = frames * channels; i < n; i++) {
        const a = Math.abs(planar[i]!)
        if (a > maxAbs) maxAbs = a
      }
      if (maxAbs > SILENCE_FLOOR) {
        /**
         * G6(g). Sound is back. If a tap rebuild happened within the recovery
         * window, the rebuild is what produced it and the silence before it was
         * LOST audio — the one case the `rescue` dimension should convict on.
         * Sound returning long after a rebuild is a source that started
         * playing, which is not our fault and not a loss.
         */
        if (
          lastReviveFrame !== null &&
          framesWritten - lastReviveFrame <= REVIVE_RECOVERY_FRAMES(sampleRate)
        ) {
          noteEvent('revive-recovered')
        }
        lastReviveFrame = null
        // B15: sound is back on a channel we said was dead — close the band.
        if (saidSilent) {
          saidSilent = false
          try {
            opts.onSilence?.('audible', 0, rev.attempts)
          } catch {
            /* a listener must never cost the capture path a batch */
          }
        }
        // noteSignal, not reset: this branch is SIGNAL arriving, and only
        // signal may mark the channel as having been heard. The unmute handler
        // calls reset() for the ladder alone (reviveSchedule.ts).
        rev.noteSignal()
        reviveSkipLogged = false
      } else {
        // THE BACKOFF ADVANCES ON EVERY CHECK, INCLUDING A SKIP — and it has
        // to. Making only a real rebuild count (first cut of this fix,
        // 2026-08-30) left the due-point where it was, so a muted, silent track
        // re-entered this branch on EVERY batch and warned on every one of
        // them. Console work on the thread that carries the PCM is exactly
        // what a starved audio path cannot afford: measured on the v2 oracle,
        // interleaved against clean main, spur went -49.9/-34.9/-33.1 dB
        // against main's -57.8/-40.2/-51.6 and failed 2 of 3 runs.
        // The real fix for spending the rescue on a mute is onTrackUnmute
        // resetting the ladder, which is where it belongs.
        if (rev.silentBatch(framesWritten, frames)) {
          const silentFrames = rev.silentFramesAt(framesWritten + frames)
          const attempt = rev.attempts
          if (track.readyState !== 'live' || track.muted) {
            noteEvent(track.muted ? 'revive-skipped:muted' : 'revive-skipped:ended')
            if (!reviveSkipLogged) {
              reviveSkipLogged = true
              console.warn(
                `[capture] ${label} audio silent ${(silentFrames / sampleRate).toFixed(0)}s but the track is ` +
                  `${track.muted ? 'MUTED — Chrome owns the mute, nothing to revive from here' : 'not live — the channel is over'}`,
              )
            }
          } else {
            try {
              const clone = track.clone()
              trackClone(clone)
              const old = sourceClone
              if (audioCtx && worklet) {
                const next = audioCtx.createMediaStreamSource(new MediaStream([clone]))
                next.connect(worklet)
                sourceNode?.disconnect()
                sourceNode = next
              } else {
                // Same rescue, one layer down: a fresh processor on a fresh
                // clone, and the pump on the dead one retires itself.
                swapTrackReader(clone)
              }
              sourceClone = clone
              dropClone(old)
              revivals++
              lastReviveFrame = framesWritten
              noteEvent('revive')
              console.warn(
                `[capture] ${label} audio input dead (pure silence ${(silentFrames / sampleRate).toFixed(0)}s on a live, ` +
                  `unmuted track) — rebuilt the source tap on a track clone (attempt ${attempt})`,
              )
              /**
               * B15 — SAY IT, NOW, NOT IN THE EDITOR.
               *
               * Two attempts is the threshold because one is what a genuine
               * quiet passage looks like: the ladder's first rung is 5 s of
               * digital zeros, and music has those. By the second rung (10 s)
               * the rescue has been tried and the source is still handing over
               * nothing on a track Chrome insists is live — which is the exact
               * shape of all three field deaths, and the shape the rescue is
               * known to be unable to fix (it re-taps a clone of a source that
               * is itself silent). `heardSignal` is what keeps this off a
               * channel that never arrived: that is Recording.missing's story,
               * not this one.
               */
              if (!saidSilent && rev.heardSignal && attempt >= SILENCE_CONVICTS_AT_ATTEMPT) {
                saidSilent = true
                try {
                  opts.onSilence?.(
                    'silent',
                    Math.round((silentFrames / sampleRate) * 1000),
                    attempt,
                  )
                } catch {
                  /* a listener must never cost the capture path a batch */
                }
              }
            } catch (err) {
              noteEvent('revive-failed')
              console.warn(`[capture] ${label} audio tap rebuild failed`, err)
            }
          }
        }
      }
    }

    const timestamp = Math.round((framesWritten * 1_000_000) / sampleRate)
    const data = new AudioData({
      format: 'f32',
      sampleRate,
      numberOfFrames: encFrames,
      numberOfChannels: encCh,
      timestamp,
      data: encBuf,
    })
    framesWritten += encFrames
    try {
      encoder.encode(data)
    } finally {
      data.close()
    }
  }

  /** Hand a completed batch on, in exactly the shape the worklet posts. */
  const flushTrackBatch = (): void => {
    if (!pendingFrames) return
    const ch = pendingChannels
    const total = pendingFrames
    const planar = new Float32Array(ch * total)
    let off = 0
    for (const chunk of pending) {
      const n = chunk[0]?.length ?? 0
      for (let c = 0; c < ch; c++) planar.set(chunk[Math.min(c, chunk.length - 1)]!, c * total + off)
      off += n
    }
    pending = []
    pendingFrames = 0
    onBatch(total, ch, lastChunkTimeS, planar)
  }

  const pumpTrackReader = async (
    reader: ReadableStreamDefaultReader<AudioData>,
  ): Promise<void> => {
    for (;;) {
      if (stopped || reader !== trackReader) return
      let res: ReadableStreamReadResult<AudioData>
      try {
        res = await reader.read()
      } catch {
        return
      }
      if (res.done) return
      const data = res.value
      try {
        if (stopped || reader !== trackReader) return
        const n = data.numberOfFrames
        if (!n) continue
        const ch = Math.min(2, Math.max(1, data.numberOfChannels))
        const planes: Float32Array[] = []
        for (let c = 0; c < ch; c++) {
          const buf = new Float32Array(n)
          data.copyTo(buf, { planeIndex: c, format: 'f32-planar' })
          planes.push(buf)
        }
        lastChunkTimeS = data.timestamp / 1_000_000
        // B12: media time this reader was never handed. See the note above.
        if (tapPrevEndUs !== null) {
          const gapUs = data.timestamp - tapPrevEndUs
          if (gapUs > TAP_GAP_FLOOR_US) {
            tapGapUs += gapUs
            if (gapUs > tapMaxGapUs) tapMaxGapUs = gapUs
          }
        }
        tapPrevEndUs = data.timestamp + Math.round((n / sampleRate) * 1_000_000)
        pendingChannels = Math.max(pendingChannels, ch)
        pending.push(planes)
        pendingFrames += n
        if (pendingFrames >= TRACK_BATCH_FRAMES) flushTrackBatch()
      } catch (err) {
        // A chunk we could not read is not silence — dropping it would splice
        // the timeline, so the wall-clock hold repays it as the loss it is.
        if (!chunkWarnLogged) {
          chunkWarnLogged = true
          console.warn(`[capture] ${label} audio chunk unreadable (skipped; logged once)`, err)
        }
      } finally {
        data.close()
      }
    }
  }

  /**
   * START THE TRACK TAP ON `clone`, on its own thread when the platform lets
   * the stream cross one. Returns which thread got it, because the take says so
   * in its own console line and a rig has to be able to check its premise.
   *
   * THE TRANSFER IS THE GATE. A platform with `Worker` and `ReadableStream`
   * that still refuses to move a stream throws here and falls straight through
   * to A1's main-thread pump — same audio, same file, the frozen rule kept
   * without a capability table to maintain.
   */
  const startTrackTap = (clone: MediaStreamTrack): 'worker' | 'main' => {
    // Bank the retiring generation's gap before its counter is replaced.
    tapGapBaseUs += tapGapThisGenUs
    tapGapThisGenUs = 0
    const gen = ++tapGeneration
    const bufChunks = trackTapBufferChunks(sampleRate)
    if (audioTapThreadChoice() === 'worker' && canTransferReadable()) {
      try {
        const readable = trackPcmReadable(clone, bufChunks)
        let w = tapWorker
        if (!w) {
          w = new Worker(new URL('./audioTap.worker.ts', import.meta.url), { type: 'module' })
          // A new realm is a new zero; the old offset describes a worker that
          // no longer exists.
          tapRealm = new RealmOffset()
        }
        w.onmessage = (ev: MessageEvent<AudioTapReply>) => {
          const msg = ev.data
          if (msg.generation !== tapGeneration) return
          if (msg.type === 'ended') {
            tapEndedResolve?.()
            return
          }
          // The worker sees the chunks, so it owns B12's instrument. Cumulative
          // per generation: a revival restarts it, exactly as the main pump's
          // reset does, because a swap's seam is `revivals` and not a drop.
          tapGapThisGenUs = msg.tapGapUs
          tapGapUs = tapGapBaseUs + tapGapThisGenUs
          if (msg.tapMaxGapUs > tapMaxGapUs) tapMaxGapUs = msg.tapMaxGapUs
          // The worker's clock, in this thread's frame. See AudioTapBatch.
          // Read BEFORE onBatch: everything that batch triggers (interleave,
          // loudness, the encoder) would otherwise be charged to the hand-off.
          const receivedAtMs = performance.now()
          tapRealm.note(msg.workerNowMs, receivedAtMs)
          const stampedMs = tapRealm.toLocal(msg.workerNowMs)
          tapHandoffMs.push(receivedAtMs - stampedMs)
          onBatch(msg.frames, msg.channels, msg.lastChunkTimeS, msg.planar, stampedMs)
        }
        const open: AudioTapMsg = {
          cmd: 'open',
          readable,
          sampleRate,
          generation: gen,
        }
        w.postMessage(open, [readable as unknown as Transferable])
        tapWorker = w
        // A take that armed on the main pump and only now got its transfer
        // (the first attempt threw, a revival's did not) would otherwise leave
        // that pump reading a clone nobody retired.
        const stale = trackReader
        trackReader = null
        void stale?.cancel().catch(() => undefined)
        return 'worker'
      } catch (err) {
        // Not a failure worth a warning on every platform that cannot do it —
        // but on one that was ASKED to, silence would hide the fallback.
        console.info(
          `[capture] ${label} audio tap could not cross a thread; reading on the main thread`,
          err,
        )
        tapWorker?.terminate()
        tapWorker = null
      }
    }
    const next = trackPcmReader(clone, bufChunks)
    const old = trackReader
    trackReader = next
    void old?.cancel().catch(() => undefined)
    void pumpTrackReader(next)
    return 'main'
  }

  /** A revival hands the reader a fresh clone; the old pump retires itself. */
  const swapTrackReader = (clone: MediaStreamTrack): void => {
    // Hand over what the dying tap already delivered before the fresh one can
    // push onto the same accumulator — two pumps must never interleave chunks.
    flushTrackBatch()
    // The new clone's clock is its own; the seam across a swap is `revivals`.
    tapPrevEndUs = null
    startTrackTap(clone)
  }

  let keepAlive: GainNode | null = null
  if (audioCtx && sourceNode && worklet) {
    const node = worklet
    node.port.onmessage = (ev: MessageEvent) => {
      if ((ev.data as { flushed?: boolean } | null)?.flushed) {
        flushResolve?.()
        return
      }
      const d = ev.data as {
        frames: number
        channels: number
        currentTime: number
        planar: Float32Array
      }
      onBatch(d.frames, d.channels, d.currentTime, d.planar)
    }
    sourceNode.connect(node)
    // Silent keep-alive: routes the (empty) worklet output to the destination at
    // zero gain. Nothing is audible, but the graph now reaches destination, so
    // Safari keeps pulling the worklet for the whole take (see note above).
    keepAlive = audioCtx.createGain()
    keepAlive.gain.value = 0
    node.connect(keepAlive)
    keepAlive.connect(audioCtx.destination)
    // resume() on an already-running (prewarmed) context is a no-op; on wedged
    // hardware it can pend — never let it block the take, proceed regardless.
    await Promise.race([
      audioCtx.resume().catch(() => undefined),
      new Promise<void>((r) => setTimeout(r, 2000)),
    ])
  } else {
    // MediaStreamTrackProcessor CONSUMES the track it is built on
    // (measuredVideo.ts pays the same rule), so it reads a CLONE and the
    // acquired track stays available to every other consumer of the stream.
    const clone = track.clone()
    trackClone(clone)
    sourceClone = clone
    const bufChunks = trackTapBufferChunks(sampleRate)
    const where = startTrackTap(clone)
    console.info(
      `[capture] ${label} audio tap = track reader (no AudioContext) rate=${sampleRate} ch=${numberOfChannels} ` +
        `buffer=${bufChunks > 0 ? `${trackTapBufferMs()}ms (${bufChunks} quanta)` : 'platform default'} ` +
        `reader=${where} thread`,
    )
  }

  const teardownGraph = async (): Promise<void> => {
    dropTrackEvidence()
    if (audioCtx) audioCtx.onstatechange = null
    if (!stopped && worklet) {
      // Drain the worklet's partial batch (<=21ms of tail audio) before teardown.
      const node = worklet
      await new Promise<void>((resolve) => {
        flushResolve = resolve
        setTimeout(resolve, 150)
        try {
          node.port.postMessage({ cmd: 'flush' })
        } catch {
          resolve()
        }
      })
    }
    // The track tap's tail is already in hand — emit it before `stopped` closes
    // the gate, or the last <=23ms of every take is dropped. On the worker path
    // the tail is on the OTHER thread, so it is asked for and waited on, under
    // the same 150 ms bound the worklet's flush uses: `stop()` is inside doStop's
    // 5 s budget (H5) and no drain may put that at risk.
    if (!stopped && tapWorker) {
      const w = tapWorker
      const gen = tapGeneration
      await new Promise<void>((resolve) => {
        tapEndedResolve = resolve
        setTimeout(resolve, 150)
        try {
          const close: AudioTapMsg = { cmd: 'close', generation: gen }
          w.postMessage(close)
        } catch {
          resolve()
        }
      })
      tapEndedResolve = null
    }
    if (!stopped && !worklet && !tapWorker) flushTrackBatch()
    stopped = true
    if (tapWorker) {
      tapWorker.onmessage = null
      tapWorker.terminate()
      tapWorker = null
    }
    const reader = trackReader
    trackReader = null
    if (reader) void reader.cancel().catch(() => undefined)
    try {
      sourceNode?.disconnect()
      worklet?.disconnect()
      keepAlive?.disconnect()
    } catch {
      /* already disconnected */
    }
    dropClone(sourceClone)
    sourceClone = null
    if (worklet) {
      worklet.port.onmessage = null
      worklet.port.close()
    }
    if (audioCtx && audioCtx.state !== 'closed') await audioCtx.close().catch(() => undefined)
  }

  const finishEncode = async (): Promise<void> => {
    await encoder.flush()
    encoder.close()
    await encodeChain
    packetSource.close()
    await output.finalize()
    try {
      await opts.writer.close()
    } catch {
      /* already closed */
    }
  }

  return {
    mimeType: MEASURED_AUDIO_MIME,
    firstOffset,
    async stop() {
      // B13: read the track BEFORE the graph comes down. A stopped track
      // reports nothing, and "nothing" here would read as every setting having
      // changed — an artefact of the teardown, not of the take.
      const settingsAtStop = readAudioTrackSettings(track)
      await teardownGraph()
      // A take that died mid-flight keeps everything durably written up to the
      // failure — never throw the whole channel away for a partial loss.
      try {
        await finishEncode()
      } catch (err) {
        fatal(err)
      }
      if (encodeError) fatal(encodeError)
      // Refined min-filter anchor beats the provisional first-arrival value,
      // then step back by the input latency the anchor structurally cannot see.
      //
      // AND IT IS BOUNDED BY THE TAKE ITSELF, which is the guard that has to
      // hold even when the clock underneath it does not. A channel that wrote
      // `mediaMs` of audio inside a take that ran `wallMs` cannot have STARTED
      // later than `wallMs - mediaMs`; anything past that is not a late channel,
      // it is a broken clock, and shipping it silently is what put 8 h 27 min of
      // nothing between Robert's picture and his sound (core/realmClock.ts).
      // The provisional offset — this thread's own `performance.now()` at the
      // first batch — is never wrong by more than a batch, so it is what stands.
      const anchorMs =
        anchorWallMs !== Infinity ? Math.max(0, anchorWallMs - opts.epoch) : (startOffsetMs ?? 0)
      const wallMs = Math.max(0, performance.now() - opts.epoch)
      const mediaMs = (framesWritten / sampleRate) * 1000
      const anchorCeilingMs = Math.max(0, wallMs - mediaMs) + ANCHOR_SLACK_MS
      let rawOffset = anchorMs
      if (anchorMs > anchorCeilingMs) {
        rawOffset = Math.max(0, Math.min(startOffsetMs ?? 0, anchorCeilingMs))
        console.error(
          `[capture] ${label} audio anchor ${Math.round(anchorMs)}ms is past everything this take ` +
            `could hold (${Math.round(mediaMs)}ms of audio inside ${Math.round(wallMs)}ms of take) — ` +
            `REFUSED, placed at ${Math.round(rawOffset)}ms. A clock under this channel is wrong; ` +
            `see core/realmClock.ts.`,
        )
        anchorRefusedMs = Math.round(anchorMs)
      }
      const offset = Math.max(0, rawOffset - inputLatencyMs)
      if (inputLatencyMs > 0) {
        console.info(
          `[capture] ${label} audio anchor ${rawOffset.toFixed(1)}ms − ${inputLatencyMs.toFixed(1)}ms reported input latency → ${offset.toFixed(1)}ms ` +
            `(baseLatency ${((audioCtx as (AudioContext & { baseLatency?: number }) | null)?.baseLatency ?? 0) * 1000}ms)`,
        )
      }
      if (paddedFrames > 0) {
        // Never silent: this take's audio graph lost real time, and the file
        // says where instead of sliding everything after it earlier.
        console.warn(
          `[capture] ${label} audio padded ${((paddedFrames / sampleRate) * 1000).toFixed(0)}ms of silence ` +
            `to hold the timeline against the wall clock (the machine was starving this take)`,
        )
      }
      const silentRunStartFrame = revive?.runStartFrame ?? null
      const silentTailMs =
        silentRunStartFrame !== null
          ? ((framesWritten - silentRunStartFrame) / sampleRate) * 1000
          : 0
      /**
       * EVERY zero after the channel was first heard, not just the open run.
       * A channel that dies at 52 minutes and is briefly revived reads a tail
       * of a second or two while nineteen minutes of the take are silent — the
       * exact shape of Robert's `rec_yx4mi1or851p`, which the card passed.
       */
      const silentTotalMs = revive
        ? (revive.silentFramesTotal / sampleRate) * 1000
        : 0
      if (silentTotalMs > silentTailMs + 10_000) {
        console.warn(
          `[capture] ${label} audio was silent for ${(silentTotalMs / 1000).toFixed(1)}s IN TOTAL ` +
            `while its unbroken tail was only ${(silentTailMs / 1000).toFixed(1)}s — the zeros are in ` +
            `the MIDDLE of this channel, which is what a revive that delivered one batch looks like.`,
        )
      }
      if (silentTailMs > 10_000) {
        console.warn(
          `[capture] ${label} audio input was PURE SILENCE for the final ${(silentTailMs / 1000).toFixed(1)}s — ` +
            `it went quiet ${(((silentRunStartFrame ?? 0) / sampleRate)).toFixed(1)}s into the channel and never came back. ` +
            `If a "track MUTED/ENDED" line appears above, that is the killer; without one, the source itself went silent.`,
        )
      }
      if (startOffsetMs === null) resolveFirst(offset)
      const paddedMs = (paddedFrames / sampleRate) * 1000
      const trimmedMs = (trimmedFrames / sampleRate) * 1000
      if (trimmedMs > 0) {
        const wallS = (framesWritten / sampleRate)
        console.info(
          `[capture] ${label} audio clock ran fast — trimmed ${trimmedMs.toFixed(0)}ms across ` +
            `${wallS.toFixed(0)}s (${Math.round((trimmedMs / 1000 / wallS) * 1e6)} ppm). Without this ` +
            `the sound would have drifted that far behind the picture.`,
        )
      }
      return {
        bytes: bytesWritten,
        durationMs: (framesWritten / sampleRate) * 1000,
        startOffsetMs: offset,
        paddedMs,
        trimmedMs,
        silentTailMs,
        silentTotalMs,
        diagnostics: {
          // S1: WRITTEN EVEN WHEN THEY ARE ZERO. A channel that carries no
          // counter is indistinguishable from one nobody counted — the same
          // container comes out of the MediaRecorder audio lane, which measures
          // none of this — and a report card that reads an absent field as
          // "nothing was lost" is scoring a measurement it did not take. Zero
          // is the finding on a healthy take; say it.
          paddedMs: Math.round(paddedMs),
          trimmedMs: Math.round(trimmedMs),
          silentTailMs: Math.round(silentTailMs),
        ...(revive?.heardSignal ? { silentTotalMs: Math.round(silentTotalMs) } : null),
          revivals,
          // B12: which of the three ways audio time goes missing this take hit.
          // Zeros are the finding on a healthy take, so they are written.
          tapGapMs: Math.round(tapGapUs / 1000),
          tapMaxGapMs: Math.round(tapMaxGapUs / 1000),
          // X11a: absent on the main pump, where the stamp IS the receipt.
          ...(tapHandoffMs.length > 0
            ? {
                tapHandoffMs: Math.round(quantile(tapHandoffMs, 0.5) * 100) / 100,
                tapHandoffP95Ms: Math.round(quantile(tapHandoffMs, 0.95) * 100) / 100,
              }
            : {}),
          // `lastArrivalMs` is the anchor's own arrival stamp, in take time:
          // when PCM last reached this thread. Nothing else here can say that
          // the tap simply stopped.
          ...(Number.isFinite(lastArrivalMs)
            ? { lastArrivalMs: Math.round(lastArrivalMs - opts.epoch) }
            : {}),
          // G6(h): which tap carried the PCM. Decided at arm from capability
          // and a flag, so it differs between two takes on one build; the
          // artifact has to carry it or a gate cannot check its own premise.
          audioTap: useTrackTap ? ('track' as const) : ('worklet' as const),
          ...(diagEvents.length > 0 ? { events: diagEvents } : {}),
          // B7: the two numbers this channel's offset was BUILT from. Always
          // written, including the zeros — "the platform reported no latency"
          // is the finding on a Bluetooth take, and an absent field cannot say
          // it. Descriptive only; nothing here moves an offset.
          anchor: {
            rawAnchorMs: Math.round(rawOffset * 10) / 10,
            // Written ONLY when the take refused an anchor as impossible, so a
            // field that exists at all is a clock bug caught in the act.
            ...(anchorRefusedMs !== null ? { anchorRefusedMs } : {}),
            // B13: what the platform REPORTED, always — not what was used. The
            // companion flag below says whether it was applied, so one field
            // can no longer mean two different takes.
            reportedInputLatencyMs: Math.round(reportedLatencyMs * 10) / 10,
          },
          // B13. Written for every measured audio channel, zeros and nulls
          // included: "the platform reported nothing" is the finding on a
          // display-audio track and an absent field cannot say it.
          audioTrack: (() => {
            const stop = settingsAtStop
            const moved =
              stop.echoCancellation !== deliveredSettings.echoCancellation ||
              stop.noiseSuppression !== deliveredSettings.noiseSuppression ||
              stop.autoGainControl !== deliveredSettings.autoGainControl ||
              stop.channelCount !== deliveredSettings.channelCount
            if (moved) {
              console.warn(
                `[capture] ${label} track settings MOVED during the take: ` +
                  `ec ${deliveredSettings.echoCancellation}→${stop.echoCancellation} ` +
                  `ns ${deliveredSettings.noiseSuppression}→${stop.noiseSuppression} ` +
                  `agc ${deliveredSettings.autoGainControl}→${stop.autoGainControl} ` +
                  `ch ${deliveredSettings.channelCount}→${stop.channelCount}`,
              )
            }
            return moved
              ? {
                  ...deliveredSettings,
                  atStop: {
                    echoCancellation: stop.echoCancellation,
                    noiseSuppression: stop.noiseSuppression,
                    autoGainControl: stop.autoGainControl,
                    channelCount: stop.channelCount,
                  },
                }
              : deliveredSettings
          })(),
        },
      }
    },
    async cancel() {
      await teardownGraph()
      try {
        encoder.close()
      } catch {
        /* already closed */
      }
      try {
        packetSource.close()
      } catch {
        /* */
      }
      try {
        await output.cancel()
      } catch {
        /* */
      }
      try {
        await opts.writer.abort()
      } catch {
        /* discarding */
      }
      if (startOffsetMs === null) resolveFirst(0)
    },
  }
}
