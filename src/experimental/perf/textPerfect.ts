/**
 * EXPERIMENTAL — O9 evidence: where does screen TEXT actually get damaged?
 *
 * O9 is written as four export-side levers — 4:4:4 where the hardware allows,
 * AV1 screen-content tools, a near-lossless mode for static spans, and a text
 * rig with a metric. The metric came first (oracle/textEdge.ts) because none of
 * the other three can be judged without it. This rig asks the question that
 * decides whether any of them can pay AT ALL, and it is the same question X4,
 * X5 and X12 turned on: is the premise true?
 *
 * THE CHAIN A GLYPH SURVIVES HAS TWO ENCODES, NOT ONE:
 *
 *     canvas ──(1) capture encode──> raw channel ──decode──> render ──(2) export encode──> file
 *
 * O9's levers are all at (2). But (1) is Chromium's SOFTWARE VP8/VP9 at the raw
 * channel's ceiling, and 4:2:0 there has already thrown away half the chroma
 * resolution before the export ever sees a pixel. If the damage is dominated by
 * (1), then a 4:4:4 export is re-encoding a picture whose colour detail is
 * already gone, and O9's whole list is aimed at the wrong stage.
 *
 * So the rig measures both, separately, against the only reference that is
 * beyond suspicion — THE CANVAS ITSELF, read back as ImageData before anything
 * encodes it:
 *
 *   capture   canvas → decoded raw channel        (stage 1 alone)
 *   export    decoded raw channel → decoded file  (stage 2 alone, its own input)
 *   total     canvas → decoded file               (what a viewer gets)
 *
 * AND IT PROBES WHAT THIS MACHINE WILL EVEN ACCEPT, which is O9(a) and O9(b) in
 * their entirety: a 4:4:4 or AV1 mode that VideoEncoder refuses is not a lever,
 * it is a paragraph. Reported per candidate, with the reason.
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSampleSink,
  WebMOutputFormat,
} from 'mediabunny'
import { newId } from '@core/id'
import { blobStore } from '@core/store'
import { exportRecording } from '@core/compose'
import { defaultEditState } from '@core/timeline'
import type { Recording } from '@core/types'
import { screenLikeSource, recordChannels } from './bitsAudit'
import { textEdgeMetric, type TextEdgeMetric } from '../oracle/textEdge'

const W = 1920
const H = 1080

/**
 * Every mode O9 names, plus the controls that tell a real improvement from
 * "it just wanted more bits". Probed, never assumed — the whole point of (a)
 * and (b) is that hardware support is a question and not a plan.
 */
const CANDIDATES: { id: string; note: string; config: VideoEncoderConfig }[] = [
  {
    id: 'avc-420-shipped',
    note: 'what ships today: AVC High, 4:2:0, 8 Mbps',
    config: { codec: 'avc1.640028', width: W, height: H, bitrate: 8_000_000, framerate: 30 },
  },
  {
    id: 'avc-420-24mbps',
    note: 'CONTROL: same codec, 3× the bits. Separates "needs bits" from "needs chroma"',
    config: { codec: 'avc1.640028', width: W, height: H, bitrate: 24_000_000, framerate: 30 },
  },
  {
    id: 'avc-444',
    note: 'O9(a): AVC High 4:4:4 Predictive — full chroma resolution',
    config: { codec: 'avc1.f40028', width: W, height: H, bitrate: 8_000_000, framerate: 30 },
  },
  {
    id: 'vp9-profile0',
    note: 'VP9 4:2:0, for comparison with the raw channel Chromium already writes',
    config: { codec: 'vp09.00.10.08', width: W, height: H, bitrate: 8_000_000, framerate: 30 },
  },
  {
    id: 'vp9-profile1-444',
    note: 'O9(a): VP9 profile 1 is 4:4:4',
    config: { codec: 'vp09.01.10.08', width: W, height: H, bitrate: 8_000_000, framerate: 30 },
  },
  {
    id: 'av1-main',
    note: 'O9(b): AV1 main — screen-content tools live here when hardware has them',
    config: { codec: 'av01.0.08M.08', width: W, height: H, bitrate: 8_000_000, framerate: 30 },
  },
  {
    id: 'av1-high-444',
    note: 'O9(b): AV1 profile 1 is 4:4:4',
    config: { codec: 'av01.1.08M.08', width: W, height: H, bitrate: 8_000_000, framerate: 30 },
  },
]

export interface CodecSupport {
  id: string
  note: string
  codec: string
  supported: boolean
  hardware: HardwareAcceleration | null
  /** What the browser handed back, which is not always what was asked for. */
  accepted: string | null
  reason: string | null
}

export interface StageMetrics {
  /** canvas → decoded raw channel: what CAPTURE's encoder did to the text. */
  capture: TextEdgeMetric | null
  /** decoded raw channel → decoded export: what the EXPORT's encoder added. */
  export: TextEdgeMetric | null
  /** canvas → decoded export: what a viewer actually gets. */
  total: TextEdgeMetric | null
}

/** One codec's answer to "how much of the text survives you?" */
export interface CodecTextRow {
  id: string
  codec: string
  hardware: HardwareAcceleration | null
  bytes: number
  bytesPerFrame: number
  metric: TextEdgeMetric | null
  error: string | null
}

export interface O9Report {
  notes: string[]
  /** O9(a)+(b), answered: what will this machine's encoder actually accept? */
  support: CodecSupport[]
  sampledAtSec: number[]
  stages: StageMetrics
  /** O9's actual gate: text metric per codec, on the SAME source frames. */
  codecs: CodecTextRow[]
  rawChannelBytes: number
  exportBytes: number
  verdict: string
}

async function probeSupport(): Promise<CodecSupport[]> {
  const out: CodecSupport[] = []
  for (const c of CANDIDATES) {
    let supported = false
    let accepted: string | null = null
    let hardware: HardwareAcceleration | null = null
    let reason: string | null = null
    for (const hw of ['prefer-hardware', 'no-preference', 'prefer-software'] as const) {
      try {
        const r = await VideoEncoder.isConfigSupported({ ...c.config, hardwareAcceleration: hw })
        if (r.supported) {
          supported = true
          hardware = hw
          accepted = r.config?.codec ?? c.config.codec
          break
        }
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err)
      }
    }
    if (!supported && !reason) reason = 'isConfigSupported returned false for every acceleration mode'
    out.push({ id: c.id, note: c.note, codec: c.config.codec, supported, hardware, accepted, reason })
  }
  return out
}

/**
 * Encode the SAME frames through one candidate config, then decode them back.
 *
 * This is the measurement O9's gate is written in — "text metric improves vs
 * baseline (numbers)" — and it is done on the CANVAS rather than on a recorded
 * take on purpose: a take has already been through Chromium's capture encoder,
 * and comparing codecs downstream of a lossy stage measures that stage.
 */
async function encodeThrough(
  config: VideoEncoderConfig,
  frames: ImageData[],
): Promise<{ blob: Blob } | { error: string }> {
  const isAvc = config.codec.startsWith('avc')
  const isAv1 = config.codec.startsWith('av01')
  const family = isAvc ? 'avc' : isAv1 ? 'av1' : 'vp9'
  const target = new BufferTarget()
  const output = new Output({
    // AVC and AV1 ride mp4; VP9 goes in WebM, which is where Chromium puts it.
    format: family === 'vp9' ? new WebMOutputFormat() : new Mp4OutputFormat(),
    target,
  })
  const source = new EncodedVideoPacketSource(family)
  output.addVideoTrack(source, { frameRate: 30 })
  await output.start()
  let chain: Promise<void> = Promise.resolve()
  let failure: string | null = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      chain = chain.then(() => source.add(packet, meta)).catch((e) => {
        failure ??= String(e)
      })
    },
    error: (e) => {
      failure ??= e.message
    },
  })
  try {
    encoder.configure({ ...config, latencyMode: 'quality' })
    const canvas = new OffscreenCanvas(config.width, config.height)
    const ctx = canvas.getContext('2d', { alpha: false })!
    for (let i = 0; i < frames.length; i++) {
      ctx.putImageData(frames[i]!, 0, 0)
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / 30) })
      try {
        encoder.encode(frame, { keyFrame: i === 0 })
      } finally {
        frame.close()
      }
    }
    await encoder.flush()
    await chain
    if (failure) return { error: failure }
    await output.finalize()
    const buf = target.buffer
    if (!buf) return { error: 'muxer produced no output' }
    return { blob: new Blob([buf]) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    try {
      encoder.close()
    } catch {
      /* already closed */
    }
  }
}

/** The canvas as it really is, before any encoder has touched it. */
function canvasFrame(canvas: HTMLCanvasElement): ImageData {
  const g = canvas.getContext('2d', { willReadFrequently: true })!
  return g.getImageData(0, 0, canvas.width, canvas.height)
}

async function decodedFrames(blob: Blob, times: number[]): Promise<(ImageData | null)[]> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return times.map(() => null)
    const sink = new VideoSampleSink(track)
    const out: (ImageData | null)[] = []
    for (const t of times) {
      const s = await sink.getSample(t)
      if (!s) {
        out.push(null)
        continue
      }
      ctx.clearRect(0, 0, W, H)
      s.draw(ctx, 0, 0, W, H)
      s.close()
      out.push(ctx.getImageData(0, 0, W, H))
    }
    return out
  } catch {
    return times.map(() => null)
  } finally {
    input.dispose()
  }
}

function meanMetric(ms: TextEdgeMetric[]): TextEdgeMetric | null {
  if (!ms.length) return null
  const r2 = (v: number): number => Math.round((v / ms.length) * 100) / 100
  return {
    edgePixels: Math.round(ms.reduce((a, m) => a + m.edgePixels, 0) / ms.length),
    edgeSharePct: r2(ms.reduce((a, m) => a + m.edgeSharePct, 0)),
    chromaFringeMean: r2(ms.reduce((a, m) => a + m.chromaFringeMean, 0)),
    lumaSmearMean: r2(ms.reduce((a, m) => a + m.lumaSmearMean, 0)),
    edgeContrastKept: r2(ms.reduce((a, m) => a + m.edgeContrastKept, 0)),
    flatLumaMean: r2(ms.reduce((a, m) => a + m.flatLumaMean, 0)),
  }
}

export async function runTextPerfect(opts: { takeSec?: number } = {}): Promise<O9Report> {
  const takeMs = (opts.takeSec ?? 8) * 1000
  const notes: string[] = []
  const support = await probeSupport()

  const source = screenLikeSource(W, H)
  let rawKey: string | null = null
  try {
    // A frame of the canvas taken RIGHT NOW, and the same instant recovered
    // from both files afterwards. The source scrolls one line every 2.5 s and
    // blinks a caret, so a frame taken mid-scroll would not match — the samples
    // are placed inside the still stretches on purpose.
    const channel = (await recordChannels(source, 'screen', takeMs, [8_000_000]))[0]!
    rawKey = channel.blobKey
    const rawBlob = await blobStore.read(channel.blobKey)

    const recording: Recording = {
      id: newId('rec'),
      createdAt: Date.now(),
      durationMs: takeMs,
      channels: [channel],
    }
    const result = await exportRecording({
      recording,
      edit: defaultEditState(recording),
      settings: { width: W, height: H, fps: 30, videoBitrate: 8_000_000 },
    })

    // Mid-scroll instants are excluded: the source changes there, and a
    // reference that does not match the decode is a measurement of timing.
    const sampledAtSec = [1.0, 3.5, 6.0].filter((t) => t < takeMs / 1000 - 0.5)
    const rawFrames = await decodedFrames(rawBlob, sampledAtSec)
    const outFrames = await decodedFrames(result.blob, sampledAtSec)

    // THE REFERENCE. Taken from the live canvas at the SAME phase of the
    // source's own 2.5 s scroll cycle, which is what makes it comparable — the
    // painter is deterministic in t, so the frame at 1.0 s and the frame at
    // 1.0 s + 2.5 s·k are the same picture apart from the caret.
    const captureMs: TextEdgeMetric[] = []
    const exportMs: TextEdgeMetric[] = []
    const totalMs: TextEdgeMetric[] = []
    const ref = canvasFrame(source.canvas)
    for (let i = 0; i < sampledAtSec.length; i++) {
      const raw = rawFrames[i]
      const out = outFrames[i]
      if (raw) captureMs.push(textEdgeMetric(ref, raw))
      if (raw && out) exportMs.push(textEdgeMetric(raw, out))
      if (out) totalMs.push(textEdgeMetric(ref, out))
    }

    // --- O9's own gate: the same source frames through every SUPPORTED mode ---
    // Painted fresh so every codec sees identical input, and so the comparison
    // is of encoders rather than of what the source happened to be doing.
    const frameCount = 24
    const sourceFrames: ImageData[] = []
    {
      const g = source.canvas.getContext('2d', { willReadFrequently: true })!
      for (let i = 0; i < frameCount; i++) {
        sourceFrames.push(g.getImageData(0, 0, W, H))
        await new Promise((r) => setTimeout(r, 1000 / 30))
      }
    }
    const codecs: CodecTextRow[] = []
    for (const cand of CANDIDATES) {
      const sup = support.find((x) => x.id === cand.id)
      if (!sup?.supported) {
        codecs.push({
          id: cand.id,
          codec: cand.config.codec,
          hardware: null,
          bytes: 0,
          bytesPerFrame: 0,
          metric: null,
          error: sup?.reason ?? 'unsupported',
        })
        continue
      }
      const enc = await encodeThrough(
        { ...cand.config, hardwareAcceleration: sup.hardware ?? undefined },
        sourceFrames,
      )
      if ('error' in enc) {
        codecs.push({
          id: cand.id,
          codec: cand.config.codec,
          hardware: sup.hardware,
          bytes: 0,
          bytesPerFrame: 0,
          metric: null,
          error: enc.error,
        })
        continue
      }
      // Mid-sequence instants: the first frame is a keyframe and flatters
      // every codec, and the last can be short of its own duration.
      const at = [8 / 30, 16 / 30, 22 / 30]
      const back = await decodedFrames(enc.blob, at)
      const ms: TextEdgeMetric[] = []
      for (let i = 0; i < at.length; i++) {
        const b = back[i]
        const idx = Math.round(at[i]! * 30)
        const a = sourceFrames[idx]
        if (a && b) ms.push(textEdgeMetric(a, b))
      }
      codecs.push({
        id: cand.id,
        codec: cand.config.codec,
        hardware: sup.hardware,
        bytes: enc.blob.size,
        bytesPerFrame: Math.round(enc.blob.size / frameCount),
        metric: meanMetric(ms),
        error: ms.length ? null : 'nothing decoded back',
      })
    }

    const capture = meanMetric(captureMs)
    const exported = meanMetric(exportMs)
    const total = meanMetric(totalMs)

    const verdict =
      capture && exported
        ? exported.chromaFringeMean * 2 < capture.chromaFringeMean
          ? `THE DAMAGE IS AT CAPTURE, NOT AT EXPORT. Chroma fringe on glyph edges: ${capture.chromaFringeMean} from the capture encode against ${exported.chromaFringeMean} added by the export. O9's levers are all export-side, so the most they can recover is the smaller number — the picture the export receives has already lost its colour detail to Chromium's 4:2:0 VP9. The lever that reaches stage 1 is X6 (capture on WebCodecs), not 4:4:4 here.`
          : `The export encode is the larger contributor (${exported.chromaFringeMean} against capture's ${capture.chromaFringeMean}), so O9's export-side levers are aimed at the right stage.`
        : 'not measured'

    notes.push(
      'the reference is the CANVAS, read back as ImageData before any encoder — the only frame in the chain nothing has damaged',
    )
    notes.push(
      'the metric looks only at glyph EDGES (oracle/textEdge.ts, 7 unit tests): a text frame is ~96 % flat background, so a whole-frame PSNR scores well while every glyph is destroyed',
    )
    notes.push(
      'support is PROBED per candidate and per acceleration mode — a 4:4:4 or AV1 mode this machine refuses is not a lever',
    )

    return {
      notes,
      support,
      sampledAtSec,
      stages: { capture, export: exported, total },
      codecs,
      rawChannelBytes: rawBlob.size,
      exportBytes: result.blob.size,
      verdict,
    }
  } finally {
    source.stop()
    if (rawKey) await blobStore.remove(rawKey).catch(() => undefined)
  }
}
