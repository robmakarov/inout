/**
 * EXPERIMENTAL — WebCodecs capture A/B runner (Experiment 4).
 *
 * Records the SAME synthetic canvas source twice, sequentially:
 *   A) production-style MediaRecorder -> webm (vp8/vp9, opaque GOPs)
 *   B) prototype WebCodecs -> fragmented MP4 (AVC, forced 2s GOPs)
 * then demuxes both files and compares the properties that motivated the
 * experiment: keyframe cadence (smart-cut precondition), first-packet
 * timestamp fidelity, file size, and capture cost.
 */

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny'
import { expReadFile, expRemove } from '../shared/opfs'
import { captureTrackToFmp4, type WcapMetrics } from './capture'
import { hasWebCodecsCapture } from './webcodecs-types'

export interface FileProbe {
  container: string
  codec: string | null
  fileBytes: number
  packetCount: number
  keyPacketCount: number
  /** Spacing between key packets, seconds. */
  keySpacingSec: { min: number; max: number; mean: number }
  firstPacketSec: number | null
  durationSec: number
}

export interface WcapReport {
  supported: boolean
  recordMs: number
  mediaRecorder: FileProbe | null
  webcodecs: (FileProbe & { capture: WcapMetrics }) | null
  notes: string[]
}

async function probeFile(blob: Blob): Promise<FileProbe> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('no video track')
    const sink = new EncodedPacketSink(track)
    let packetCount = 0
    let keyPacketCount = 0
    let firstPacketSec: number | null = null
    const keyTimes: number[] = []
    for await (const p of sink.packets()) {
      packetCount++
      if (firstPacketSec === null) firstPacketSec = p.timestamp
      if (p.type === 'key') {
        keyPacketCount++
        keyTimes.push(p.timestamp)
      }
    }
    const spacings: number[] = []
    for (let i = 1; i < keyTimes.length; i++) spacings.push(keyTimes[i] - keyTimes[i - 1])
    const mean = spacings.length ? spacings.reduce((a, b) => a + b, 0) / spacings.length : 0
    return {
      container: (await input.getFormat()).name,
      codec: await track.getCodec(),
      fileBytes: blob.size,
      packetCount,
      keyPacketCount,
      keySpacingSec: {
        min: spacings.length ? Math.min(...spacings) : 0,
        max: spacings.length ? Math.max(...spacings) : 0,
        mean,
      },
      firstPacketSec,
      durationSec: await track.computeDuration(),
    }
  } finally {
    input.dispose()
  }
}

function makeSourceCanvas(): { stream: MediaStream; stop: () => void } {
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  const g = canvas.getContext('2d')
  if (!g) throw new Error('2d context unavailable')
  let raf = 0
  const draw = (): void => {
    const t = performance.now()
    g.fillStyle = `hsl(${(t / 30) % 360}, 45%, 16%)`
    g.fillRect(0, 0, 1280, 720)
    g.fillStyle = '#fff'
    g.font = 'bold 90px monospace'
    g.fillText((t / 1000).toFixed(2), 480, 360)
    g.fillStyle = `hsl(${(t / 5) % 360}, 80%, 60%)`
    g.fillRect((t / 4) % 1440 - 160, 560, 160, 40)
    raf = requestAnimationFrame(draw)
  }
  draw()
  return { stream: canvas.captureStream(30), stop: () => cancelAnimationFrame(raf) }
}

async function recordViaMediaRecorder(stream: MediaStream, durationMs: number): Promise<Blob> {
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm'
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = (ev) => {
    if (ev.data?.size) chunks.push(ev.data)
  }
  const stopped = new Promise<void>((r) => (recorder.onstop = () => r()))
  recorder.start(1000)
  await new Promise((r) => setTimeout(r, durationMs))
  recorder.stop()
  await stopped
  return new Blob(chunks, { type: mime })
}

export async function runWcapExperiment(recordMs = 5000): Promise<WcapReport> {
  const notes: string[] = []
  if (!hasWebCodecsCapture()) {
    return {
      supported: false,
      recordMs,
      mediaRecorder: null,
      webcodecs: null,
      notes: ['MediaStreamTrackProcessor/WebCodecs unavailable in this browser'],
    }
  }

  const src = makeSourceCanvas()
  try {
    // A: MediaRecorder baseline.
    const mrBlob = await recordViaMediaRecorder(src.stream, recordMs)
    const mrProbe = await probeFile(mrBlob)

    // B: WebCodecs prototype on the same live source.
    const track = src.stream.getVideoTracks()[0]
    const wc = await captureTrackToFmp4(track, recordMs)
    const wcBlob = await expReadFile(wc.fileName)
    const wcProbe = await probeFile(wcBlob)
    await expRemove(wc.fileName)

    if (wc.metrics.framesDroppedBackpressure > 0) {
      notes.push(
        `encoder backpressure dropped ${wc.metrics.framesDroppedBackpressure}/${wc.metrics.framesIn} frames — measure on target hardware before drawing conclusions`,
      )
    }
    notes.push(
      'keyframe cadence: MediaRecorder GOPs are opaque/uncontrolled; the prototype forces exact 2s GOPs — the smart-cut precondition',
      'first-packet timestamp in B comes from VideoFrame.timestamp (measured), not the onstart heuristic (estimated)',
    )

    return {
      supported: true,
      recordMs,
      mediaRecorder: mrProbe,
      webcodecs: { ...wcProbe, capture: wc.metrics },
      notes,
    }
  } finally {
    src.stop()
    for (const t of src.stream.getTracks()) t.stop()
  }
}
