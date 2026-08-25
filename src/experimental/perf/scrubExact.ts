/**
 * EXPERIMENTAL — F8 step one: IS THE EDITOR'S SCRUB ACTUALLY OFF?
 *
 * F8 ("nle-scrub") is written on a premise: "scrub decodes the EXACT frame
 * (WebCodecs random access) instead of <video> seek granularity". That premise
 * has never been measured in this codebase, and O5 is the standing warning
 * about building on one that has not been (its whole task was written on "the
 * render is strictly serial", which turned out to be false).
 *
 * So this measures it, on the two paths side by side, at instants deliberately
 * off the frame grid:
 *
 *   the SHIPPED preview   a <video> element with `currentTime = t`, which is
 *                         what usePlayback does while paused
 *   the CANDIDATE         the same reader the EXPORT uses (openVideoChannel →
 *                         VideoSampleSink.sampleAt), i.e. the frame the
 *                         exported file would contain at that instant
 *
 * The rig paints a machine-readable timecode into every frame, so "which frame
 * did you land on" is not an eyeball question: both paths are decoded, both
 * strips are read, and the answer is in milliseconds of rig clock. A frame is
 * 33.3 ms at 30 fps, so anything under ~17 ms is the same frame.
 *
 * Reported per instant, and aggregated:
 *   · deltaMs        video-path frame minus exact-path frame, ms of rig clock
 *   · offByFrames    the same in frames — this is the number F8 lives or dies on
 *   · seekMs         wall clock each path costs, because "exact" is worthless
 *                    if it cannot keep up with a drag
 */
import { blobStore } from '@core/store'
import { channelSourceTimeAt, defaultEditState } from '@core/timeline'
import { openVideoChannel } from '@core/compose/video'
import type { EditState, Recording } from '@core/types'
import { decodeBits, FID_BLOCK, FID_BLOCK_COUNT, FID_MARGIN } from '../oracle/fiducial'
import { recordFiducialSession, RIG_HEIGHT, RIG_WIDTH } from '../oracle/rig'

/** 30 fps output — one frame. */
const FRAME_MS = 1000 / 30

function readStrip(g: CanvasRenderingContext2D, imageWidth: number): number | null {
  const scale = imageWidth / RIG_WIDTH
  const block = FID_BLOCK * scale
  const margin = FID_MARGIN * scale
  const read = (i: number): number => {
    const x = Math.round(margin + i * block + block * 0.3)
    const y = Math.round(margin + block * 0.3)
    const w = Math.max(1, Math.round(block * 0.4))
    const d = g.getImageData(x, y, w, w).data
    let sum = 0
    for (let p = 0; p < d.length; p += 4) sum += (d[p]! + d[p + 1]! + d[p + 2]!) / 3
    return sum / (d.length / 4)
  }
  const levels: number[] = []
  for (let i = 0; i < FID_BLOCK_COUNT; i++) levels.push(read(i))
  return decodeBits({ luma: (i: number) => levels[i]! })
}

export interface ScrubSample {
  outMs: number
  localMs: number
  /** Rig time painted into the frame the EXPORT would use here. */
  exactRigMs: number | null
  /** Rig time painted into the frame a <video> seek lands on. */
  videoRigMs: number | null
  /** video − exact, ms of rig clock. */
  deltaMs: number | null
  offByFrames: number | null
  exactSeekMs: number
  videoSeekMs: number
  /** What the element reported its own position as, after the seek. */
  videoCurrentTimeMs: number | null
}

export interface ScrubExactReport {
  takeMs: number
  channel: { kind: string; mimeType: string; width: number | null; height: number | null }
  samples: ScrubSample[]
  summary: {
    readable: number
    /** How many instants the two paths disagreed about by at least half a frame. */
    differentFrames: number
    maxOffByFrames: number | null
    meanAbsDeltaMs: number | null
    meanExactSeekMs: number
    meanVideoSeekMs: number
  }
  notes: string[]
}

async function seekVideo(el: HTMLVideoElement, sec: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      el.removeEventListener('seeked', onSeeked)
      resolve(ok)
    }
    const onSeeked = (): void => finish(true)
    el.addEventListener('seeked', onSeeked)
    // A seek that never answers must not hang the run (note 3, one level out).
    setTimeout(() => finish(false), 4000)
    el.currentTime = sec
  })
}

export async function runScrubExact(
  opts: { takeMs?: number; samples?: number } = {},
): Promise<ScrubExactReport> {
  const takeMs = opts.takeMs ?? 12000
  const sampleCount = opts.samples ?? 5
  const rig = await recordFiducialSession(takeMs, { flashClick: false, composite: false })
  const recording: Recording = rig.recording
  const edit: EditState = defaultEditState(recording)
  const channel = recording.channels.find((c) => c.media === 'video')
  if (!channel) throw new Error('scrubExact: the rig produced no video channel')

  const blob = await blobStore.read(channel.blobKey)
  const reader = await openVideoChannel(blob, channel.id, channel.kind, channel.durationMs / 1000)
  if (!reader) throw new Error('scrubExact: could not open the channel for random access')

  const url = URL.createObjectURL(blob)
  const el = document.createElement('video')
  el.src = url
  el.muted = true
  el.playsInline = true
  el.preload = 'auto'
  document.body.appendChild(el)
  el.style.cssText = 'position:fixed;left:-9999px;top:0;width:320px'
  await new Promise<void>((resolve) => {
    if (el.readyState >= 2) return resolve()
    el.addEventListener('loadeddata', () => resolve(), { once: true })
    setTimeout(resolve, 5000)
  })

  const w = channel.width ?? RIG_WIDTH
  const h = channel.height ?? RIG_HEIGHT
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d', { willReadFrequently: true })!

  const samples: ScrubSample[] = []
  try {
    for (let i = 0; i < sampleCount; i++) {
      // Deliberately off the 33.3 ms frame grid, and away from both ends.
      const outMs = Math.round(takeMs * 0.15 + ((takeMs * 0.7) / sampleCount) * i + 7.4)
      const localMs = channelSourceTimeAt(recording, edit, channel.id, outMs)
      if (localMs === null) continue

      const tExact0 = performance.now()
      const sample = await reader.sampleAt(localMs / 1000)
      const exactSeekMs = Math.round(performance.now() - tExact0)
      let exactRigMs: number | null = null
      if (sample) {
        g.clearRect(0, 0, w, h)
        sample.draw(g, 0, 0, w, h)
        exactRigMs = readStrip(g, w)
      }

      const tVideo0 = performance.now()
      const ok = await seekVideo(el, localMs / 1000)
      const videoSeekMs = Math.round(performance.now() - tVideo0)
      let videoRigMs: number | null = null
      if (ok) {
        g.clearRect(0, 0, w, h)
        g.drawImage(el, 0, 0, w, h)
        videoRigMs = readStrip(g, w)
      }

      const deltaMs =
        exactRigMs !== null && videoRigMs !== null ? videoRigMs - exactRigMs : null
      samples.push({
        outMs,
        localMs: Math.round(localMs),
        exactRigMs,
        videoRigMs,
        deltaMs,
        offByFrames: deltaMs === null ? null : Math.round((deltaMs / FRAME_MS) * 100) / 100,
        exactSeekMs,
        videoSeekMs,
        videoCurrentTimeMs: ok ? Math.round(el.currentTime * 1000) : null,
      })
    }
  } finally {
    reader.dispose()
    el.remove()
    URL.revokeObjectURL(url)
    await rig.cleanup?.()
  }

  const readable = samples.filter((s) => s.deltaMs !== null)
  const mean = (xs: number[]): number | null =>
    xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null
  return {
    takeMs,
    channel: {
      kind: channel.kind,
      mimeType: channel.mimeType,
      width: channel.width ?? null,
      height: channel.height ?? null,
    },
    samples,
    summary: {
      readable: readable.length,
      differentFrames: readable.filter((s) => Math.abs(s.offByFrames!) >= 0.5).length,
      maxOffByFrames: readable.length
        ? Math.max(...readable.map((s) => Math.abs(s.offByFrames!)))
        : null,
      meanAbsDeltaMs: mean(readable.map((s) => Math.abs(s.deltaMs!))),
      meanExactSeekMs: mean(samples.map((s) => s.exactSeekMs)) ?? 0,
      meanVideoSeekMs: mean(samples.map((s) => s.videoSeekMs)) ?? 0,
    },
    notes: [
      'the rig paints its clock into every frame, so "which frame did the seek land on" is decoded, not judged',
      'instants are off the 33.3 ms frame grid on purpose — a frame-aligned probe cannot see rounding',
      'the EXACT path is the same reader the export uses, so its frame is by definition the frame the exported file would contain at that instant',
      'a delta under half a frame (16.7 ms) means the two paths show the SAME frame and F8s premise does not hold for this content',
    ],
  }
}
