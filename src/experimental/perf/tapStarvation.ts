/**
 * EXPERIMENTAL — WHY THE TAB-AUDIO TAP DIES UNDER MAX LOAD (task A1).
 *
 * THE FIELD EVIDENCE THIS RIG EXISTS TO REPRODUCE: rec_78ogcw052vdn, a 3,026 s
 * quality=max take with camera + mic + tab audio. The display-audio track was
 * LIVE and UNMUTED for all 50 minutes — no mute, no unmute, no ended, no
 * context state change — and the channel still recorded 1,650,144 ms of pure
 * digital silence, with the dead-tap rescue firing 25 times in six bursts. The
 * rescue was fixed (reviveSchedule.ts never retires); WHY THE TAP DIES was
 * never measured. paddedMs was 5,647 ms of 3,026 s, so the audio CLOCK was not
 * starving — something upstream of the worklet handed it zeros.
 *
 * WHAT THIS MEASURES, and why it can answer where the take could not: the tab
 * plays ONE CONTINUOUS TONE for the whole cell, so every zero the tap delivers
 * is a defect and not a quiet moment. The same source track is tapped TWO WAYS
 * AT ONCE —
 *   webaudio  the production path (AudioContext → MediaStreamAudioSourceNode →
 *             AudioWorklet → main-thread message → encoder), and
 *   mstp      MediaStreamTrackProcessor, which reads AudioData straight off the
 *             track with no AudioContext, no output-device clock and no
 *             WebAudio FIFO in the way.
 * Both see the same source, the same seconds and the same load, so a zero run
 * in one and not the other names the layer that dies. Under `load` the machine
 * carries a max60-class bill: real VideoEncoders at screen and camera sizes,
 * every core spinning, and 4K paints — switchable one family at a time, which
 * is how the contender gets named instead of assumed.
 *
 * Run with --keep-audio (the driver's default --mute-audio captures as silence
 * and makes the whole cell vacuous — `toneReached` says if it did).
 */

import { audioTapChoice, canReadTrackPcm } from '@core/capture/audioTap'
import { prewarmMeasuredAudio, startMeasuredAudioCapture } from '@core/capture/measuredAudio'

const SILENCE_FLOOR = 1e-5

export type LoadFamily = 'none' | 'cpu' | 'paint' | 'encode' | 'audiopeer' | 'all'

export type TapKind = 'webaudio' | 'webaudio-playback' | 'mstp'

export interface TapLane {
  kind: TapKind
  /** Which track this lane tapped — the acquired one, or a clone of it. */
  source: 'original' | 'clone'
  frames: number
  sampleRate: number
  /** Per-second buckets of the tap's own delivery, take-relative. */
  buckets: { maxAbs: number; frames: number }[]
  /** Runs of consecutive silent seconds — the defect, one row each. */
  zeroRuns: { atS: number; lengthS: number }[]
  longestZeroS: number
  silentSecs: number
  /** Wall gaps between deliveries: a stalled reader shows here, not in zeros. */
  gapMsP50: number
  gapMsP99: number
  gapMsMax: number
  /** webaudio lane only — the production witnesses the take carries. */
  paddedMs?: number
  trimmedMs?: number
  silentTailMs?: number
  revivals?: number
  events?: { atMs: number; type: string }[]
}

export interface TapStarvationReport {
  ok: boolean
  verdict: string
  load: LoadFamily
  takeSec: number
  /** False = the cell is vacuous: the tone never reached the captured track. */
  toneReached: boolean
  /**
   * WHICH TAP THE `webaudio` LANES ACTUALLY RAN ON. Those lanes call the
   * PRODUCTION function, and since A1 that function reads through the track tap
   * by default — so a cell meaning to measure the worklet must be driven with
   * `--query=audiotap=worklet`, and this field is how the report says which one
   * it got instead of the lane name implying it.
   */
  productionTap: 'worklet' | 'track'
  displayAudioSettings: MediaTrackSettings | null
  /**
   * WHAT A SYNTHETIC AUDIO TRACK REPORTS. Every oracle and every ?synthetic=1
   * run feeds capture from a MediaStreamAudioDestinationNode, and the track tap
   * is gated on the track NAMING ITS RATE. If these settings carry no
   * sampleRate then those runs exercise the worklet fallback, and no oracle
   * number describes the shipped path — which is a finding, not a detail.
   */
  syntheticAudioSettings: MediaTrackSettings | null
  syntheticTapEligible: boolean | null
  trackEvents: { atMs: number; type: string }[]
  lanes: TapLane[]
  /** setInterval(20ms) drift — is the MAIN THREAD the contender? */
  mainLatenessMsP50: number
  mainLatenessMsP99: number
  mainLatenessMsMax: number
  /** Frames the load encoders actually pushed — proof the load was real. */
  loadEncoded: { label: string; frames: number; encoded: number }[]
  hardwareConcurrency: number
  error?: string
}

/** One "video playing in the tab" — a continuous tone, never torn down. */
function startTone(freq: number): { stop: () => void } {
  const ctx = new AudioContext({ sampleRate: 48000 })
  const osc = new OscillatorNode(ctx, { frequency: freq })
  // A slow tremolo, so a tap that latches one sample forever is not mistaken
  // for a live one: a constant sine reads "signal" even when frozen.
  const lfo = new OscillatorNode(ctx, { frequency: 0.7 })
  const lfoGain = new GainNode(ctx, { gain: 0.25 })
  const gain = new GainNode(ctx, { gain: 0.4 })
  const dest = ctx.createMediaStreamDestination()
  lfo.connect(lfoGain)
  lfoGain.connect(gain.gain)
  osc.connect(gain)
  gain.connect(dest)
  osc.start()
  lfo.start()
  const el = document.createElement('audio')
  el.srcObject = dest.stream
  el.volume = 1
  void el.play().catch(() => undefined)
  document.body.appendChild(el)
  return {
    stop: () => {
      el.pause()
      el.srcObject = null
      el.remove()
      for (const t of dest.stream.getTracks()) t.stop()
      osc.stop()
      lfo.stop()
      void ctx.close().catch(() => undefined)
    },
  }
}

/** Every core busy — the CPU half of a max60 bill. */
function startCpuLoad(): () => void {
  const src = `onmessage=()=>{for(;;){let x=0;for(let i=0;i<1e7;i++)x+=Math.sqrt(i);postMessage(x);}}`
  const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))
  const workers: Worker[] = []
  const n = Math.max(4, navigator.hardwareConcurrency || 8)
  for (let i = 0; i < n; i++) {
    const w = new Worker(url)
    w.postMessage(1)
    workers.push(w)
  }
  return () => {
    for (const w of workers) w.terminate()
    URL.revokeObjectURL(url)
  }
}

/** The raster half — full-surface 4K paints, off rAF so a hidden page still pays. */
function startPaintLoad(): () => void {
  const canvas = document.createElement('canvas')
  canvas.width = 3840
  canvas.height = 2160
  const g = canvas.getContext('2d')
  if (!g) return () => undefined
  let k = 0
  const timer = setInterval(() => {
    for (let i = 0; i < 10; i++) {
      const grad = g.createLinearGradient(0, 0, 3840, 2160)
      grad.addColorStop(0, `hsl(${(k++ * 37) % 360}, 60%, 40%)`)
      grad.addColorStop(1, '#000')
      g.fillStyle = grad
      g.fillRect(0, 0, 3840, 2160)
    }
  }, 16)
  return () => clearInterval(timer)
}

/**
 * The load family production actually runs at max: real VideoEncoders on
 * workers, one per raw channel, at the sizes Robert's take used (screen
 * 3024x1964, camera 1920x1080). Synthetic frames, because a headless window
 * captures at 800x600 and would price nothing.
 */
const ENCODE_WORKER_SRC = `
let stop = false
let frames = 0, encoded = 0
async function pick(w, h, fps) {
  for (const codec of ['avc1.640034','avc1.4d0034','avc1.42E034','vp09.00.10.08','vp8']) {
    const config = {
      codec, width: w, height: h, framerate: fps,
      bitrate: Math.round(w * h * fps * 0.07),
      latencyMode: 'realtime',
      ...(codec.startsWith('avc') ? { avc: { format: 'annexb' } } : {}),
    }
    try {
      const s = await VideoEncoder.isConfigSupported(config)
      if (s.supported) return config
    } catch (e) { /* next */ }
  }
  return null
}
onmessage = async (e) => {
  if (e.data === 'stop') { stop = true; return }
  const { w, h, fps } = e.data
  const config = await pick(w, h, fps)
  if (!config) { postMessage({ ready: false }); return }
  const enc = new VideoEncoder({ output: (c) => { encoded++; c.close() }, error: () => undefined })
  enc.configure(config)
  const canvas = new OffscreenCanvas(w, h)
  const g = canvas.getContext('2d')
  postMessage({ ready: true })
  const period = 1000 / fps
  let next = performance.now()
  let n = 0
  while (!stop) {
    const now = performance.now()
    if (now < next) { await new Promise((r) => setTimeout(r, Math.min(8, next - now))); continue }
    next += period
    if (next < now - 200) next = now
    // Real content, not a flat fill: a static surface encodes to nothing and
    // prices no encoder.
    g.fillStyle = 'hsl(' + ((n * 7) % 360) + ',70%,45%)'
    g.fillRect(0, 0, w, h)
    g.fillStyle = '#fff'
    for (let i = 0; i < 40; i++) {
      g.fillRect((n * 13 + i * 97) % w, (n * 7 + i * 61) % h, 120, 90)
    }
    const frame = new VideoFrame(canvas, { timestamp: Math.round(n * period * 1000) })
    if (enc.encodeQueueSize < 4) { enc.encode(frame, { keyFrame: n % 120 === 0 }); frames++ }
    frame.close()
    n++
  }
  try { await enc.flush() } catch (e) { /* torn down */ }
  enc.close()
  postMessage({ done: true, frames, encoded })
}
`

interface EncodeLoad {
  stop: () => Promise<{ label: string; frames: number; encoded: number }[]>
}

async function startEncodeLoad(
  lanes: { label: string; w: number; h: number; fps: number }[],
): Promise<EncodeLoad> {
  const url = URL.createObjectURL(new Blob([ENCODE_WORKER_SRC], { type: 'application/javascript' }))
  const started = lanes.map((lane) => {
    const w = new Worker(url)
    const done = new Promise<{ label: string; frames: number; encoded: number }>((resolve) => {
      w.onmessage = (ev: MessageEvent) => {
        const m = ev.data as { ready?: boolean; done?: boolean; frames?: number; encoded?: number }
        if (m?.done) resolve({ label: lane.label, frames: m.frames ?? 0, encoded: m.encoded ?? 0 })
      }
    })
    w.postMessage({ w: lane.w, h: lane.h, fps: lane.fps })
    return { worker: w, done, label: lane.label }
  })
  return {
    stop: async () => {
      for (const s of started) s.worker.postMessage('stop')
      const out = await Promise.all(
        started.map((s) =>
          Promise.race([
            s.done,
            new Promise<{ label: string; frames: number; encoded: number }>((r) =>
              setTimeout(() => r({ label: s.label, frames: -1, encoded: -1 }), 5000),
            ),
          ]),
        ),
      )
      for (const s of started) s.worker.terminate()
      URL.revokeObjectURL(url)
      return out
    },
  }
}

/** A second measured-audio channel — production always has one (the mic). */
function syntheticVoiceStream(): { stream: MediaStream; stop: () => void } {
  const ctx = new AudioContext({ sampleRate: 48000 })
  const osc = new OscillatorNode(ctx, { frequency: 220 })
  const gain = new GainNode(ctx, { gain: 0.3 })
  const dest = ctx.createMediaStreamDestination()
  osc.connect(gain)
  gain.connect(dest)
  osc.start()
  return {
    stream: dest.stream,
    stop: () => {
      osc.stop()
      for (const t of dest.stream.getTracks()) t.stop()
      void ctx.close().catch(() => undefined)
    },
  }
}

interface LaneCollector {
  buckets: { maxAbs: number; frames: number }[]
  gaps: number[]
  frames: number
  lastMs: number
  sampleRate: number
}

function newCollector(secs: number): LaneCollector {
  return {
    buckets: Array.from({ length: secs + 2 }, () => ({ maxAbs: 0, frames: 0 })),
    gaps: [],
    frames: 0,
    lastMs: -Infinity,
    sampleRate: 0,
  }
}

function note(c: LaneCollector, atMs: number, maxAbs: number, frames: number, rate: number): void {
  const i = Math.max(0, Math.min(c.buckets.length - 1, Math.floor(atMs / 1000)))
  const b = c.buckets[i]!
  if (maxAbs > b.maxAbs) b.maxAbs = maxAbs
  b.frames += frames
  c.frames += frames
  c.sampleRate = rate
  if (c.lastMs > -Infinity) c.gaps.push(atMs - c.lastMs)
  c.lastMs = atMs
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return Math.round((sorted[i] ?? 0) * 10) / 10
}

function finishLane(
  kind: TapKind,
  source: 'original' | 'clone',
  c: LaneCollector,
  takeSec: number,
): TapLane {
  // Only seconds inside the take, and only after the first delivered second:
  // a tap that starts 200 ms in must not read as a 1 s death.
  const buckets = c.buckets.slice(0, takeSec).map((b) => ({ ...b }))
  const zeroRuns: { atS: number; lengthS: number }[] = []
  let runStart = -1
  for (let i = 0; i < buckets.length; i++) {
    const silent = (buckets[i]?.maxAbs ?? 0) <= SILENCE_FLOOR
    if (silent && runStart < 0) runStart = i
    if (!silent && runStart >= 0) {
      zeroRuns.push({ atS: runStart, lengthS: i - runStart })
      runStart = -1
    }
  }
  if (runStart >= 0) zeroRuns.push({ atS: runStart, lengthS: buckets.length - runStart })
  const gaps = [...c.gaps].sort((a, b) => a - b)
  return {
    kind,
    source,
    frames: c.frames,
    sampleRate: c.sampleRate,
    buckets,
    zeroRuns,
    longestZeroS: zeroRuns.reduce((m, r) => Math.max(m, r.lengthS), 0),
    silentSecs: zeroRuns.reduce((m, r) => m + r.lengthS, 0),
    gapMsP50: pct(gaps, 50),
    gapMsP99: pct(gaps, 99),
    gapMsMax: pct(gaps, 100),
  }
}

export async function runTapStarvation(opts?: {
  secs?: number
  load?: LoadFamily
  /** Which tap gets the ACQUIRED track; the others get clones of it. */
  originalTap?: TapKind
  /** Run only one lane — the A/B is the point, but a control needs one lane. */
  lanes?: TapKind[]
  screen?: { w: number; h: number; fps: number }
  camera?: { w: number; h: number; fps: number }
}): Promise<TapStarvationReport> {
  const takeSec = Math.max(10, Math.round(opts?.secs ?? 180))
  const load = opts?.load ?? 'all'
  const originalTap = opts?.originalTap ?? 'webaudio'
  const wantLanes: TapKind[] = opts?.lanes ?? ['webaudio', 'mstp']
  const screen = opts?.screen ?? { w: 3024, h: 1964, fps: 30 }
  const camera = opts?.camera ?? { w: 1920, h: 1080, fps: 60 }

  const report: TapStarvationReport = {
    ok: false,
    verdict: '',
    load,
    takeSec,
    toneReached: false,
    productionTap: audioTapChoice(),
    displayAudioSettings: null,
    syntheticAudioSettings: null,
    syntheticTapEligible: null,
    trackEvents: [],
    lanes: [],
    mainLatenessMsP50: 0,
    mainLatenessMsP99: 0,
    mainLatenessMsMax: 0,
    loadEncoded: [],
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
  }

  let tone: { stop: () => void } | null = null
  let display: MediaStream | null = null
  let stopCpu: (() => void) | null = null
  let stopPaint: (() => void) | null = null
  let encodeLoad: EncodeLoad | null = null
  let peer: { stream: MediaStream; stop: () => void } | null = null
  let peerHandle: Awaited<ReturnType<typeof startMeasuredAudioCapture>> | null = null
  const waHandles = new Map<TapKind, Awaited<ReturnType<typeof startMeasuredAudioCapture>>>()
  const waCollectors = new Map<TapKind, LaneCollector>()
  let mstpTrack: MediaStreamTrack | null = null
  let mstpReader: ReadableStreamDefaultReader<AudioData> | null = null
  let latenessTimer: ReturnType<typeof setInterval> | null = null

  try {
    tone = startTone(440)
    // Let the element actually reach the tab's audio output before capture.
    await new Promise((r) => setTimeout(r, 500))

    const request = navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      ...({ preferCurrentTab: true } as Record<string, unknown>),
    } as DisplayMediaStreamOptions)
    display = await Promise.race([
      request,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('getDisplayMedia never settled — auto-accept flags missing?')),
          20_000,
        ),
      ),
    ])
    const track = display.getAudioTracks()[0]
    if (!track) {
      report.verdict = 'VACUOUS: current-tab capture carried no audio track — flag or platform gap'
      return report
    }
    report.displayAudioSettings = track.getSettings()
    const epoch = performance.now()
    for (const type of ['mute', 'unmute', 'ended'] as const) {
      track.addEventListener(type, () =>
        report.trackEvents.push({ atMs: Math.round(performance.now() - epoch), type }),
      )
    }

    // ── the taps, all on ONE source ──
    const trackFor = (kind: TapKind): MediaStreamTrack =>
      kind === originalTap ? track : track.clone()
    // Only clone for a lane that was actually asked for: an unused clone is a
    // second live sink on the capture nothing ever stops.
    const mstpSourceTrack = wantLanes.includes('mstp') ? trackFor('mstp') : null
    const mstpCollector = newCollector(takeSec)

    for (const kind of wantLanes) {
      if (kind !== 'webaudio' && kind !== 'webaudio-playback') continue
      const collector = newCollector(takeSec)
      waCollectors.set(kind, collector)
      // THE ONE LEVER THAT NEEDS NO PRODUCTION CHANGE TO PRICE: the context's
      // output buffer. 'interactive' is what production builds today (smallest
      // buffer, tightest render deadline); 'playback' asks the platform for the
      // largest, which is the whole difference between the two lanes.
      const laneTrack = trackFor(kind)
      waHandles.set(
        kind,
        await startMeasuredAudioCapture({
          stream: new MediaStream([laneTrack]),
          epoch,
          label: `tap-${kind}`,
          ...(kind === 'webaudio-playback'
            ? { audioCtx: await prewarmMeasuredAudio(laneTrack, { latencyHint: 'playback' }) }
            : {}),
          writer: {
            write: async () => undefined,
            close: async () => undefined,
            abort: async () => undefined,
          },
          onPcm: (L, R, _startFrame, _startOffsetMs, sampleRate) => {
            let maxAbs = 0
            for (let i = 0; i < L.length; i++) {
              const a = Math.abs(L[i]!)
              if (a > maxAbs) maxAbs = a
            }
            if (R !== L) {
              for (let i = 0; i < R.length; i++) {
                const a = Math.abs(R[i]!)
                if (a > maxAbs) maxAbs = a
              }
            }
            note(collector, performance.now() - epoch, maxAbs, L.length, sampleRate)
          },
        }),
      )
    }

    if (wantLanes.includes('mstp')) {
      const Processor = (
        globalThis as unknown as { MediaStreamTrackProcessor?: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<AudioData> } }
      ).MediaStreamTrackProcessor
      if (!Processor) {
        report.verdict = 'VACUOUS: MediaStreamTrackProcessor unavailable — the A/B has one side'
      } else if (mstpSourceTrack) {
        mstpTrack = mstpSourceTrack
        const proc = new Processor({ track: mstpTrack })
        mstpReader = proc.readable.getReader()
        void (async () => {
          const scratch = new Float32Array(4096)
          const reader = mstpReader
          if (!reader) return
          for (;;) {
            let res: ReadableStreamReadResult<AudioData>
            try {
              res = await reader.read()
            } catch {
              return
            }
            if (res.done) return
            const data = res.value
            try {
              const n = data.numberOfFrames
              const buf = n <= scratch.length ? scratch : new Float32Array(n)
              let maxAbs = 0
              const planes = Math.min(2, data.numberOfChannels)
              for (let p = 0; p < planes; p++) {
                data.copyTo(buf.subarray(0, n), { planeIndex: p, format: 'f32-planar' })
                for (let i = 0; i < n; i++) {
                  const a = Math.abs(buf[i]!)
                  if (a > maxAbs) maxAbs = a
                }
              }
              note(mstpCollector, performance.now() - epoch, maxAbs, n, data.sampleRate)
            } catch {
              /* a frame we could not read is not a zero — skip it */
            } finally {
              data.close()
            }
          }
        })()
      }
    }

    // ── the load ──
    if (load === 'cpu' || load === 'all') stopCpu = startCpuLoad()
    if (load === 'paint' || load === 'all') stopPaint = startPaintLoad()
    if (load === 'encode' || load === 'all') {
      encodeLoad = await startEncodeLoad([
        { label: `screen ${screen.w}x${screen.h}@${screen.fps}`, ...screen },
        { label: `camera ${camera.w}x${camera.h}@${camera.fps}`, ...camera },
      ])
    }
    if (load === 'audiopeer' || load === 'all') {
      peer = syntheticVoiceStream()
      const peerTrack = peer.stream.getAudioTracks()[0]
      if (peerTrack) {
        report.syntheticAudioSettings = peerTrack.getSettings()
        report.syntheticTapEligible = canReadTrackPcm(peerTrack)
      }
      peerHandle = await startMeasuredAudioCapture({
        stream: peer.stream,
        epoch,
        label: 'tap-peer',
        writer: {
          write: async () => undefined,
          close: async () => undefined,
          abort: async () => undefined,
        },
      }).catch(() => null)
    }

    // Main-thread lateness — the cheapest possible witness for "the thread
    // carrying the PCM was busy", sampled the whole take.
    const lateness: number[] = []
    let expect = performance.now() + 20
    latenessTimer = setInterval(() => {
      const now = performance.now()
      lateness.push(Math.max(0, now - expect))
      expect = now + 20
    }, 20)

    await new Promise((r) => setTimeout(r, takeSec * 1000))

    clearInterval(latenessTimer)
    latenessTimer = null
    const sortedLate = [...lateness].sort((a, b) => a - b)
    report.mainLatenessMsP50 = pct(sortedLate, 50)
    report.mainLatenessMsP99 = pct(sortedLate, 99)
    report.mainLatenessMsMax = pct(sortedLate, 100)

    if (encodeLoad) report.loadEncoded = await encodeLoad.stop()
    encodeLoad = null

    for (const [kind, h] of waHandles) {
      const collector = waCollectors.get(kind)
      if (!collector) continue
      const lane = finishLane(kind, kind === originalTap ? 'original' : 'clone', collector, takeSec)
      const res = await h.stop().catch(() => null)
      if (res) {
        lane.paddedMs = Math.round(res.paddedMs)
        lane.trimmedMs = Math.round(res.trimmedMs)
        lane.silentTailMs = Math.round(res.silentTailMs)
        lane.revivals = res.diagnostics.revivals
        lane.events = res.diagnostics.events
      }
      report.lanes.push(lane)
    }
    waHandles.clear()
    if (wantLanes.includes('mstp') && mstpReader) {
      report.lanes.push(
        finishLane('mstp', originalTap === 'mstp' ? 'original' : 'clone', mstpCollector, takeSec),
      )
    }

    report.toneReached = report.lanes.some((l) => l.buckets.some((b) => b.maxAbs > SILENCE_FLOOR))
    if (!report.toneReached) {
      report.verdict =
        'VACUOUS: no lane ever saw the tone — run with --keep-audio, or the platform captured silence'
      return report
    }
    const wa = report.lanes.find((l) => l.kind === 'webaudio')
    const ms = report.lanes.find((l) => l.kind === 'mstp')
    const parts: string[] = []
    for (const l of report.lanes) {
      parts.push(
        `${l.kind}(${l.source}): ${l.silentSecs}s silent, longest ${l.longestZeroS}s` +
          (l.revivals !== undefined ? `, revivals ${l.revivals}, padded ${l.paddedMs}ms` : ''),
      )
    }
    report.ok = report.lanes.every((l) => l.longestZeroS === 0)
    report.verdict =
      (report.ok
        ? `NO STARVATION under load=${load}: `
        : wa && ms && wa.longestZeroS > 0 && ms.longestZeroS === 0
          ? `THE WEBAUDIO TAP DIES AND THE TRACK DOES NOT (load=${load}): `
          : `STARVATION under load=${load}: `) + parts.join(' | ')
    return report
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err)
    report.verdict = `ERROR: ${report.error}`
    return report
  } finally {
    if (latenessTimer) clearInterval(latenessTimer)
    if (encodeLoad) await encodeLoad.stop().catch(() => undefined)
    stopCpu?.()
    stopPaint?.()
    for (const h of waHandles.values()) await h.cancel().catch(() => undefined)
    await peerHandle?.cancel().catch(() => undefined)
    peer?.stop()
    await mstpReader?.cancel().catch(() => undefined)
    mstpTrack?.stop()
    if (display) for (const t of display.getTracks()) t.stop()
    tone?.stop()
  }
}
