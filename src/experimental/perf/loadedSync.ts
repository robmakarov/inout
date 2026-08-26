/**
 * EXPERIMENTAL — A/V SYNC WHEN THE MACHINE IS BUSY (PO 2026-08-25: recording
 * beside a 4K game, "sounds go faster than video" from ~20 s in, "then it goes
 * with wrong speed").
 *
 * WHY THIS RIG HAD TO EXIST: every sync number this project has ever quoted was
 * taken on an IDLE machine. The oracle's own note says drift is dead (beta−1 =
 * −0.003 ms/s), and that verdict is true — on an idle machine. PO's take ran
 * starved beside a 4K game, and nothing in the gate covers that regime.
 *
 * WHAT IT MEASURES, and why it is the right quantity: the composite writes its
 * two tracks on TWO DIFFERENT CLOCKS. Video is stamped with each frame's
 * ARRIVAL time (compositor.worker.ts, `msg.atMs` → relMs), audio is
 * SAMPLE-COUNTED (`audioFramesTotal / sampleRate`). Both tracks start at zero,
 * so if one clock runs slower than the other the two tracks cover DIFFERENT
 * amounts of wall time and the gap between them grows linearly through the
 * take — which is exactly what "in sync at first, then audio runs ahead" is.
 * So the number that decides it is the SPAN of each track against the wall
 * clock of the same take, plus the slope that gap implies over PO's length.
 *
 * Run it both ways — `{"load":false}` is the control. A number from the loaded
 * cell alone proves nothing; it is the DIFFERENCE that is evidence.
 */

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny'
import { blobStore } from '@core/store'
import { startLiveCompositeV2 } from '@core/capture/liveCompositeV2'
import { startLiveComposite } from '@core/capture/liveComposite'
import { startMeasuredAudioCapture } from '@core/capture/measuredAudio'
import { warmVideoEncoder } from '@core/capture/encoderWarm'
import { makeRig } from './compositorEngine'

/**
 * Saturate the machine the way a 4K game does: every core busy AND the GPU/
 * raster path loaded with full-surface 4K paints. Both halves matter — CPU
 * alone leaves the compositor free, and paints alone leave the cores free.
 */
function startLoad(): () => void {
  const workers: Worker[] = []
  const src = `onmessage=()=>{for(;;){let x=0;for(let i=0;i<1e7;i++)x+=Math.sqrt(i);postMessage(x);}}`
  const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }))
  const n = Math.max(4, navigator.hardwareConcurrency || 8)
  for (let i = 0; i < n; i++) {
    const w = new Worker(url)
    w.postMessage(1)
    workers.push(w)
  }
  const canvas = document.createElement('canvas')
  canvas.width = 3840
  canvas.height = 2160
  const g = canvas.getContext('2d')!
  // setInterval, not rAF: a rig page that loses visibility must keep loading
  // the machine, or the "loaded" cell quietly becomes a second idle cell.
  const timer = setInterval(() => {
    for (let i = 0; i < 10; i++) {
      const grad = g.createLinearGradient(0, 0, 3840, 2160)
      grad.addColorStop(0, `hsl(${(i * 37) % 360}, 60%, 40%)`)
      grad.addColorStop(1, '#000')
      g.fillStyle = grad
      g.fillRect(0, 0, 3840, 2160)
    }
  }, 16)
  return () => {
    clearInterval(timer)
    for (const w of workers) w.terminate()
  }
}

/**
 * An INDEPENDENT frame counter on the same AudioContext, to name the guilty
 * clock. The composite's audio timeline is sample-counted, so a short audio
 * track means samples were never counted — but that can happen two ways, and
 * they have opposite fixes:
 *  · the CONTEXT rendered fewer quanta than wall time (audio-thread starvation
 *    — the context's own clock is behind), or
 *  · the context kept time but the tap never saw those samples.
 * This counter advances once per render quantum whatever the input does, so
 * comparing it against the wall clock separates the two.
 */
async function startContextClockProbe(
  stream: MediaStream | undefined,
): Promise<{
  read: () => { ctxMs: number; framesMs: number; liveMs: number; wallMs: number }
  close: () => Promise<void>
}> {
  // A SEPARATE context consuming the SAME stream through the SAME topology the
  // composite uses (createMediaStreamSource → worklet). That is the hop under
  // suspicion, so the probe has to cross it too.
  const ctx = new AudioContext({ sampleRate: 48000 })
  const src = `
class ClockProbe extends AudioWorkletProcessor {
  constructor(){ super(); this.f=0; this.live=0; this.last=0 }
  process(inputs){
    const c = inputs[0]
    const isLive = c && c.length && c[0] && c[0].length
    // Every quantum the graph renders, live or not — this tracks the CONTEXT.
    this.f += 128
    // Only quanta that actually carried input samples — this tracks DELIVERY.
    if (isLive) this.live += c[0].length
    if (this.f - this.last >= 4800) { this.last = this.f; this.port.postMessage({ f: this.f, live: this.live, ct: currentTime }) }
    return true
  }
}
registerProcessor('loadedsync-clock', ClockProbe)
`
  await ctx.audioWorklet.addModule(
    URL.createObjectURL(new Blob([src], { type: 'application/javascript' })),
  )
  const node = new AudioWorkletNode(ctx, 'loadedsync-clock', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
  })
  if (stream) ctx.createMediaStreamSource(stream).connect(node)
  const sink = ctx.createGain()
  sink.gain.value = 0
  node.connect(sink)
  sink.connect(ctx.destination)
  await ctx.resume()
  let t0: number | null = null
  let ct0 = 0
  let f0 = 0
  let live0 = 0
  let ctxMs = 0
  let framesMs = 0
  let liveMs = 0
  let wallMs = 0
  node.port.onmessage = (e: MessageEvent) => {
    const { f, live, ct } = e.data as { f: number; live: number; ct: number }
    const now = performance.now()
    if (t0 === null) {
      t0 = now
      ct0 = ct
      f0 = f
      live0 = live
      return
    }
    wallMs = now - t0
    ctxMs = (ct - ct0) * 1000
    framesMs = ((f - f0) / 48000) * 1000
    liveMs = ((live - live0) / 48000) * 1000
  }
  return {
    read: () => ({ ctxMs, framesMs, liveMs, wallMs }),
    close: async () => {
      await ctx.close().catch(() => undefined)
    },
  }
}

interface TrackSpans {
  videoSpanSec: number | null
  audioSpanSec: number | null
  videoFrames: number
  audioPackets: number
  /** Largest gap between consecutive VIDEO timestamps — the stall evidence. */
  maxVideoGapMs: number | null
  /** The worst holes AND WHERE they are: a gap at t=0 is a cold start, a gap in
   *  the middle is the freeze a user actually watches. */
  worstGaps: { atSec: number; gapMs: number }[]
  /** Spread of the frame intervals: how far from constant-rate the file is. */
  videoGapSdMs: number | null
}

async function probeSpans(blob: Blob): Promise<TrackSpans> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const out: TrackSpans = {
    videoSpanSec: null,
    audioSpanSec: null,
    videoFrames: 0,
    audioPackets: 0,
    maxVideoGapMs: null,
    worstGaps: [],
    videoGapSdMs: null,
  }
  try {
    const v = await input.getPrimaryVideoTrack()
    if (v) {
      const stamps: number[] = []
      for await (const packet of new EncodedPacketSink(v).packets()) stamps.push(packet.timestamp)
      out.videoFrames = stamps.length
      if (stamps.length > 1) {
        stamps.sort((a, b) => a - b)
        out.videoSpanSec = stamps[stamps.length - 1]! - stamps[0]!
        const gaps: number[] = []
        const located: { atSec: number; gapMs: number }[] = []
        for (let i = 1; i < stamps.length; i++) {
          const gapMs = (stamps[i]! - stamps[i - 1]!) * 1000
          gaps.push(gapMs)
          located.push({ atSec: Math.round(stamps[i - 1]! * 100) / 100, gapMs: Math.round(gapMs) })
        }
        const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
        out.maxVideoGapMs = Math.max(...gaps)
        out.worstGaps = located.sort((a, b) => b.gapMs - a.gapMs).slice(0, 4)
        out.videoGapSdMs = Math.sqrt(
          gaps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / gaps.length,
        )
      }
    }
    const a = await input.getPrimaryAudioTrack()
    if (a) {
      const stamps: number[] = []
      let lastDur = 0
      for await (const packet of new EncodedPacketSink(a).packets()) {
        stamps.push(packet.timestamp)
        lastDur = packet.duration
      }
      out.audioPackets = stamps.length
      if (stamps.length > 1) {
        stamps.sort((x, y) => x - y)
        // The audio track's span must include the last packet's own duration —
        // an audio packet covers a span, a video frame is an instant.
        out.audioSpanSec = stamps[stamps.length - 1]! - stamps[0]! + lastDur
      }
    }
  } finally {
    input.dispose()
  }
  return out
}

export interface LoadedSyncReport {
  engine: 'v1' | 'v2'
  loaded: boolean
  takeMs: number
  size: [number, number]
  /** Wall time the composite was actually running, start of stop − start. */
  wallMs: number
  sourceFrames: number
  spans: TrackSpans
  /** audioFrames/sampleRate from the compositor's own stats (v2 only). */
  statsAudioSec: number | null
  statsFramesIn: number | null
  statsFramesEncoded: number | null
  statsFramesDropped: number | null
  /** The worker's own view of the longest hole in the file — the freeze. */
  statsMaxEncodeGapMs: number | null
  statsKeepAliveFrames: number | null
  /** Audio the worker received and never encoded — the silent loss, counted. */
  audioDroppedNotReadySec: number | null
  audioDroppedLeadSec: number | null
  /** Silence inserted to hold the timeline against the wall — the fix, working. */
  audioPaddedSec: number | null
  degradeReason: string | null
  /**
   * Which clock lost the time. `ctxBehindWallMs` > 0 means the AudioContext
   * itself rendered fewer quanta than wall time (audio-thread starvation);
   * ~0 means the context kept time and the samples went missing elsewhere.
   */
  clock: {
    ctxMs: number
    framesMs: number
    liveMs: number
    wallMs: number
    ctxBehindWallMs: number
    /** Wall time whose audio NEVER ARRIVED as live input — the missing seconds. */
    liveBehindWallMs: number
  }
  /**
   * The RAW measured-audio path — the channels every export mixes its audio
   * from — run beside the composite on the same load. This lane did not exist
   * on 2026-08-25, which is how a wall-clock hold that never fired shipped as
   * "verified": the rig only ever measured the composite's copy.
   */
  measured: {
    durationSec: number
    /** Silence the hold inserted — >0 under real starvation, 0 on a healthy take. */
    paddedSec: number
    startOffsetMs: number
    /** (startOffset + duration) − wall at stop: ≈0 when the hold works, strongly
     *  negative when starvation shortens the channel unpadded. */
    vsWallMs: number
    /** How long the input had been pure digital silence at stop — the "tab
     *  audio dies" witness; ~0 here because the rig's oscillator never stops. */
    silentTailSec: number
  } | null
  /** THE NUMBER: how far the two tracks disagree about the same take. */
  avSpanGapMs: number | null
  /** Sign-named so a report cannot be misread. */
  verdict: string
  /** What that gap becomes over PO's own 5-minute take, if it is a rate error. */
  projectedGapAt300sMs: number | null
}

export async function runLoadedSync(opts?: {
  takeMs?: number
  width?: number
  height?: number
  load?: boolean
  engine?: 'v1' | 'v2'
}): Promise<LoadedSyncReport> {
  const takeMs = opts?.takeMs ?? 60_000
  const width = opts?.width ?? 3840
  const height = opts?.height ?? 2160
  const loaded = opts?.load ?? true
  const engine = opts?.engine ?? 'v2'

  // WARM THE ENCODER AS PRODUCTION DOES AT MOUNT (prearm.ts → encoderWarm.ts).
  // Without this the take pays a Chrome process's first-VideoEncoder init
  // DURING the recording, and it lands as a multi-second hole at t≈0.8 s that
  // reads exactly like a freeze — this rig reported one until it warmed. Note
  // 10 of .ai/TASKS, fourth instance: check the instrument before the product.
  await warmVideoEncoder().catch(() => undefined)
  const audioCtx = new AudioContext({ sampleRate: 48000 })
  await audioCtx.resume()
  const rig = makeRig(width, height, audioCtx)
  const clockProbe = await startContextClockProbe(rig.audio[0])
  const key = `exp-loadedsync-${engine}-${loaded ? 'load' : 'idle'}-${Date.now()}.mp4`
  let stopLoad: (() => void) | null = null
  let degradeReason: string | null = null

  try {
    if (loaded) stopLoad = startLoad()
    const inputs = { screen: rig.screen, camera: rig.camera, audio: rig.audio }
    const t0 = performance.now()
    const handle =
      engine === 'v2'
        ? await startLiveCompositeV2(inputs, key, {
            onDegrade: (reason) => {
              degradeReason = reason
            },
          })
        : await startLiveComposite(inputs, key)
    // The raw measured-audio path, on the same stream and the same load. Its
    // bytes are discarded — the lane exists for durationMs/paddedMs vs wall.
    let measuredHandle: Awaited<ReturnType<typeof startMeasuredAudioCapture>> | null = null
    if (rig.audio[0]) {
      try {
        measuredHandle = await startMeasuredAudioCapture({
          stream: rig.audio[0],
          epoch: t0,
          writer: {
            write: async () => undefined,
            close: async () => undefined,
            abort: async () => undefined,
          },
        })
      } catch (err) {
        console.warn('[loadedsync] measured-audio lane failed to start', err)
      }
    }
    await new Promise((r) => setTimeout(r, takeMs))
    const wallMs = performance.now() - t0
    const clock = clockProbe.read()
    let measured: LoadedSyncReport['measured'] = null
    if (measuredHandle) {
      const stopWallMs = performance.now() - t0
      const r = await measuredHandle.stop()
      measured = {
        durationSec: Math.round(r.durationMs) / 1000,
        paddedSec: Math.round(r.paddedMs) / 1000,
        startOffsetMs: Math.round(r.startOffsetMs),
        vsWallMs: Math.round(r.startOffsetMs + r.durationMs - stopWallMs),
        silentTailSec: Math.round(r.silentTailMs) / 1000,
      }
    }
    await handle.stop()
    const stats =
      engine === 'v2' ? (handle as { stats(): Record<string, number> | null }).stats() : null

    // A DEGRADED composite deletes its own blob at stop (liveCompositeV2), and
    // this rig used to throw on the read — discarding the measured lane and the
    // clock probe with it, twice, on runs whose whole point was those numbers.
    // The composite's absence is a RESULT (degradeReason says why), not a crash.
    let spans: TrackSpans = {
      videoSpanSec: null,
      audioSpanSec: null,
      videoFrames: 0,
      audioPackets: 0,
      maxVideoGapMs: null,
      worstGaps: [],
      videoGapSdMs: null,
    }
    try {
      spans = await probeSpans(await blobStore.read(key))
    } catch (err) {
      console.warn('[loadedsync] composite file unreadable (degraded take?) — reporting without spans', err)
    }
    const statsAudioSec =
      stats && typeof stats.audioFrames === 'number' ? stats.audioFrames / 48000 : null

    const avSpanGapMs =
      spans.videoSpanSec !== null && spans.audioSpanSec !== null
        ? (spans.audioSpanSec - spans.videoSpanSec) * 1000
        : null
    const verdict =
      avSpanGapMs === null
        ? 'one track missing — nothing to compare'
        : Math.abs(avSpanGapMs) < 100
          ? `tracks agree within ${avSpanGapMs.toFixed(0)}ms over ${(wallMs / 1000).toFixed(0)}s — no progressive desync in this file`
          : avSpanGapMs < 0
            ? `AUDIO IS SHORT by ${(-avSpanGapMs).toFixed(0)}ms — audio runs AHEAD of video, growing through the take`
            : `VIDEO IS SHORT by ${avSpanGapMs.toFixed(0)}ms — video runs ahead of audio, growing through the take`

    return {
      engine,
      loaded,
      takeMs,
      size: [width, height],
      wallMs: Math.round(wallMs),
      sourceFrames: rig.sourceFrames(),
      spans,
      statsAudioSec,
      statsFramesIn: stats && typeof stats.framesIn === 'number' ? stats.framesIn : null,
      statsFramesEncoded:
        stats && typeof stats.framesEncoded === 'number' ? stats.framesEncoded : null,
      statsFramesDropped:
        stats && typeof stats.framesDropped === 'number' ? stats.framesDropped : null,
      statsMaxEncodeGapMs:
        stats && typeof stats.maxEncodeGapMs === 'number' ? Math.round(stats.maxEncodeGapMs) : null,
      statsKeepAliveFrames:
        stats && typeof stats.keepAliveFrames === 'number' ? stats.keepAliveFrames : null,
      audioDroppedNotReadySec:
        stats && typeof stats.audioDroppedNotReady === 'number'
          ? stats.audioDroppedNotReady / 48000
          : null,
      audioDroppedLeadSec:
        stats && typeof stats.audioDroppedLead === 'number' ? stats.audioDroppedLead / 48000 : null,
      audioPaddedSec:
        stats && typeof stats.audioPaddedFrames === 'number'
          ? stats.audioPaddedFrames / 48000
          : null,
      degradeReason,
      measured,
      clock: {
        ctxMs: Math.round(clock.ctxMs),
        framesMs: Math.round(clock.framesMs),
        liveMs: Math.round(clock.liveMs),
        wallMs: Math.round(clock.wallMs),
        ctxBehindWallMs: Math.round(clock.wallMs - clock.ctxMs),
        liveBehindWallMs: Math.round(clock.wallMs - clock.liveMs),
      },
      avSpanGapMs: avSpanGapMs === null ? null : Math.round(avSpanGapMs),
      verdict,
      projectedGapAt300sMs:
        avSpanGapMs === null ? null : Math.round((avSpanGapMs / wallMs) * 300_000),
    }
  } finally {
    stopLoad?.()
    await clockProbe.close()
    rig.stop()
    for (const s of [rig.screen, rig.camera, ...rig.audio]) {
      for (const t of s.getTracks()) t.stop()
    }
    await audioCtx.close().catch(() => undefined)
    await blobStore.remove(key).catch(() => undefined)
  }
}
