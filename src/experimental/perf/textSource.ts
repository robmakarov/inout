/**
 * EXPERIMENTAL — X15's shared instrument: a screen-text source that is
 * DETERMINISTIC IN FRAME INDEX, and the encode/decode plumbing built on it.
 *
 * WHY THIS EXISTS RATHER THAN bitsAudit's screenLikeSource. That source paints
 * from `performance.now()`, so the only way to know what it drew at a given
 * instant is to have been holding a reference frame at that instant. O9's rig
 * did not: it compares decoded frames at t = 1.0/3.5/6.0 s against ONE canvas
 * readback taken after the export finished, and the source scrolls one line
 * every 2.5 s — so the reference is at a different scroll position from every
 * sample it is compared with. That is note 10 again, and it is why X15 measures
 * the O9 capture stage BOTH ways before it quotes it (see chromaPrice.ts).
 *
 * Keyed on the frame INDEX, the same index is the same picture forever: the
 * reference for frame i is `paint(i)` and nothing has to be remembered. It also
 * means an encoder comparison can be exact — every lane encodes the identical
 * bytes — instead of searching a window for the best phase match, which is what
 * made X6's 27.9 dB a lower bound rather than a number.
 *
 * PACING IS REAL TIME ON PURPOSE. A `latencyMode:'realtime'` encoder budgets
 * against the wall clock, so feeding it 180 frames as fast as they can be
 * painted would measure a regime production never sees. Every lane here is fed
 * at ~30 fps, MediaRecorder and VideoEncoder alike.
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSampleSink,
  WebMOutputFormat,
} from 'mediabunny'

export const FPS = 30
/** screenLikeSource scrolls one line every 2.5 s; same cadence, in frames. */
const SCROLL_FRAMES = 2.5 * FPS
/** …and blinks its caret at 2 Hz. */
const CARET_FRAMES = 0.5 * FPS

const WORDS = ['const', 'function', 'return', 'await', 'export', 'if', 'for', 'type']
const LINES: { text: string; color: string }[] = []
for (let i = 0; i < 60; i++) {
  const indent = '  '.repeat(i % 4)
  LINES.push({
    text: `${indent}${WORDS[i % WORDS.length]} sample${i} = compute(${i}, 'channel-${i % 7}')`,
    color: i % 5 === 0 ? '#7ee787' : i % 3 === 0 ? '#79c0ff' : '#c9d1d9',
  })
}

type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/**
 * The same dark editor page bitsAudit paints — coloured text on #0d1117, a
 * scroll every 2.5 s, a blinking caret — with `t` replaced by `i / FPS`.
 * Deliberately pixel-comparable with screenLikeSource so an O9 number and an
 * X15 number are about the same content.
 */
export function paintTextFrame(g: AnyCtx, i: number, width: number, height: number): void {
  const scroll = Math.floor(i / SCROLL_FRAMES)
  g.fillStyle = '#0d1117'
  g.fillRect(0, 0, width, height)
  g.font = `${Math.round(height / 38)}px monospace`
  g.textBaseline = 'top'
  for (let row = 0; row < 34; row++) {
    const line = LINES[(row + scroll) % LINES.length]!
    g.fillStyle = '#484f58'
    g.fillText(String(row + scroll + 1).padStart(3, ' '), width * 0.01, row * (height / 36) + 8)
    g.fillStyle = line.color
    g.fillText(line.text, width * 0.05, row * (height / 36) + 8)
  }
  if (Math.floor(i / CARET_FRAMES) % 2 === 0) {
    g.fillStyle = '#c9d1d9'
    g.fillRect(width * 0.05 + 320, 12 * (height / 36) + 8, 3, height / 40)
  }
}

/** The motion CONTROL: every pixel changes every frame (bitsAudit's game tab). */
export function paintMotionFrame(g: AnyCtx, i: number, width: number, height: number): void {
  const t = i / FPS
  const hue = (t * 40) % 360
  const grad = g.createLinearGradient(0, 0, width, height)
  grad.addColorStop(0, `hsl(${hue}, 55%, 18%)`)
  grad.addColorStop(1, `hsl(${(hue + 90) % 360}, 55%, 32%)`)
  g.fillStyle = grad
  g.fillRect(0, 0, width, height)
  g.fillStyle = '#ffffff'
  const bar = width / 8
  g.fillRect(((t * width) / 2) % (width + bar) - bar, 0, bar, height)
}

export type ContentKind = 'text' | 'motion'

export function painterFor(kind: ContentKind): (g: AnyCtx, i: number, w: number, h: number) => void {
  return kind === 'text' ? paintTextFrame : paintMotionFrame
}

/**
 * A live canvas plus the painter, held together so every lane in a run draws
 * from one place. An HTMLCanvasElement rather than an OffscreenCanvas because
 * the MediaRecorder lane needs captureStream().
 */
export interface DeterministicSource {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  paint: (i: number) => void
  /** The exact pixels of frame i, painted fresh. The reference, always. */
  frame: (i: number) => ImageData
}

export function deterministicSource(
  kind: ContentKind,
  width: number,
  height: number,
): DeterministicSource {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
  const painter = painterFor(kind)
  const paint = (i: number): void => painter(ctx, i, width, height)
  return {
    canvas,
    ctx,
    paint,
    frame: (i) => {
      paint(i)
      return ctx.getImageData(0, 0, width, height)
    },
  }
}

/**
 * A source that paints ONE fixed picture, forever.
 *
 * The control for "is this difference the painters, or is it just a second
 * encode?" — feed a real decoded frame back through an encoder and measure what
 * the encode ALONE costs it. Without this, any cross-path comparison of two
 * files is a painter difference and a re-encode added together, and this repo
 * has already written down that the second term is ~37.5 dB on its own
 * (compose/smartCutFlag.ts: "the ceiling for two independent encodes of one
 * frame"). A reading at that ceiling therefore proves nothing until the ceiling
 * is measured on the same picture.
 */
export function stillSource(img: ImageData): DeterministicSource {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
  ctx.putImageData(img, 0, 0)
  return { canvas, ctx, paint: () => {}, frame: () => img }
}

// ---------------------------------------------------------------------------
// encode / record
// ---------------------------------------------------------------------------

export interface EncodeLaneResult {
  blob: Blob | null
  error: string | null
  /** Frames the encoder actually emitted — a dropping lane is not a comparison. */
  framesOut: number
  /**
   * Wall time from the first encode() to flush() returning, ms.
   *
   * NOT "time spent in encode()": VideoEncoder.encode() is asynchronous, so the
   * synchronous call is an enqueue and costs the same microseconds whatever the
   * codec does. Only an UNPACED lane's total, ending at flush(), contains the
   * encoder's actual work — which is why the codec table runs unpaced and the
   * rate-control sweep does not.
   */
  wallMs: number | null
  /** frames / wall seconds, unpaced. Meaningless on a paced lane. */
  throughputFps: number | null
}

function familyOf(codec: string): 'avc' | 'av1' | 'vp9' | 'vp8' {
  if (codec.startsWith('avc')) return 'avc'
  if (codec.startsWith('av01')) return 'av1'
  if (codec.startsWith('vp8')) return 'vp8'
  return 'vp9'
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Encode `frames` deterministic pictures through one VideoEncoder config and
 * mux them, at real-time cadence.
 *
 * `quantizer` is passed per frame because that is the only way bitrateMode
 * 'quantizer' takes a value — the config's `bitrate` is ignored in that mode,
 * which is exactly why it is the mode most likely to answer X6's undershoot.
 */
export async function encodeDeterministic(opts: {
  config: VideoEncoderConfig
  frames: number
  source: DeterministicSource
  /** Keyframe every N frames; production's raw channel asks for 2 s. */
  keyFrameEvery?: number
  quantizer?: number
  /** Feed at 1/FPS wall time (default true). False measures raw throughput. */
  paced?: boolean
}): Promise<EncodeLaneResult> {
  const family = familyOf(opts.config.codec)
  const target = new BufferTarget()
  const output = new Output({
    format: family === 'vp9' || family === 'vp8' ? new WebMOutputFormat() : new Mp4OutputFormat(),
    target,
  })
  const source = new EncodedVideoPacketSource(family)
  output.addVideoTrack(source, { frameRate: FPS })
  await output.start()

  let chain: Promise<void> = Promise.resolve()
  let failure: string | null = null
  let framesOut = 0
  let encodeMs = 0
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      framesOut++
      const packet = EncodedPacket.fromEncodedChunk(chunk)
      chain = chain
        .then(() => source.add(packet, meta))
        .catch((e) => {
          failure ??= String(e)
        })
    },
    error: (e) => {
      failure ??= e.message
    },
  })

  const keyEvery = opts.keyFrameEvery ?? 2 * FPS
  const startedAt = performance.now()
  try {
    encoder.configure(opts.config)
    for (let i = 0; i < opts.frames; i++) {
      const at = performance.now()
      opts.source.paint(i)
      const frame = new VideoFrame(opts.source.canvas, {
        timestamp: Math.round((i * 1e6) / FPS),
        duration: Math.round(1e6 / FPS),
      })
      try {
        const encodeOpts: VideoEncoderEncodeOptions = { keyFrame: i % keyEvery === 0 }
        if (opts.quantizer !== undefined && family === 'avc') {
          encodeOpts.avc = { quantizer: opts.quantizer }
        }
        encoder.encode(frame, encodeOpts)
      } finally {
        frame.close()
      }
      if (opts.paced !== false) {
        await sleep(Math.max(0, 1000 / FPS - (performance.now() - at)))
      } else if (encoder.encodeQueueSize > 8) {
        // Unpaced does NOT mean unbounded: a software AV1 encoder handed 180
        // 1080p frames as fast as they paint will hold every one of them in
        // memory. Back-pressure keeps the lane a throughput measurement rather
        // than a memory one (X5's rig error (a), which cost a wrong verdict).
        await new Promise<void>((r) => {
          const tick = (): void => {
            if (encoder.encodeQueueSize <= 4) r()
            else setTimeout(tick, 4)
          }
          tick()
        })
      }
      if (failure) break
    }
    await encoder.flush()
    encodeMs = performance.now() - startedAt
    await chain
    const timing = {
      wallMs: Math.round(encodeMs),
      throughputFps:
        opts.paced === false ? Math.round((opts.frames / (encodeMs / 1000)) * 10) / 10 : null,
    }
    if (failure) return { blob: null, error: failure, framesOut, ...timing }
    await output.finalize()
    const buf = target.buffer
    if (!buf) return { blob: null, error: 'muxer produced no output', framesOut, ...timing }
    return { blob: new Blob([buf]), error: null, framesOut, ...timing }
  } catch (err) {
    return {
      blob: null,
      error: err instanceof Error ? err.message : String(err),
      framesOut,
      wallMs: null,
      throughputFps: null,
    }
  } finally {
    try {
      encoder.close()
    } catch {
      /* already closed */
    }
  }
}

/** The RAW_MIMES ladder bitsAudit uses, which is what a raw channel records. */
const RAW_MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

/**
 * The SHIPPED raw-channel lane, on the identical pictures.
 *
 * captureStream(0) + requestFrame() is what makes this comparable rather than
 * merely similar: the canvas emits exactly the frames this rig paints, in the
 * order it paints them, so the MediaRecorder file and every VideoEncoder file
 * in the same run are encodes of ONE picture sequence. A captureStream(30)
 * would sample whatever the compositor happened to have.
 */
export async function recordDeterministic(opts: {
  source: DeterministicSource
  frames: number
  bitrate: number
}): Promise<{ blob: Blob | null; mimeType: string; error: string | null }> {
  const mime = RAW_MIMES.find((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) return { blob: null, mimeType: '', error: 'no supported raw recorder mime' }
  const stream = opts.source.canvas.captureStream(0)
  const track = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined
  if (!track?.requestFrame) {
    for (const t of stream.getTracks()) t.stop()
    return { blob: null, mimeType: mime, error: 'canvas track has no requestFrame()' }
  }
  const parts: Blob[] = []
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.bitrate })
  recorder.ondataavailable = (e) => {
    if (e.data.size) parts.push(e.data)
  }
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })
  recorder.start(1000)
  for (let i = 0; i < opts.frames; i++) {
    const at = performance.now()
    opts.source.paint(i)
    track.requestFrame()
    await sleep(Math.max(0, 1000 / FPS - (performance.now() - at)))
  }
  recorder.requestData()
  recorder.stop()
  await stopped
  for (const t of stream.getTracks()) t.stop()
  return { blob: new Blob(parts, { type: mime }), mimeType: mime, error: null }
}

// ---------------------------------------------------------------------------
// decode / compare
// ---------------------------------------------------------------------------

/**
 * Decode a file at the given FRAME INDICES, at the source's own size.
 *
 * By index and not by time: every lane declares 30 fps and stamps frame i at
 * i/30, so index i is the same picture in every file — and the reference is
 * `source.frame(i)`, with no alignment search anywhere.
 */
export async function decodeFrames(
  blob: Blob,
  indices: number[],
  width: number,
  height: number,
): Promise<(ImageData | null)[]> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return indices.map(() => null)
    const sink = new VideoSampleSink(track)
    const out: (ImageData | null)[] = []
    for (const i of indices) {
      const s = await sink.getSample(i / FPS)
      if (!s) {
        out.push(null)
        continue
      }
      ctx.clearRect(0, 0, width, height)
      s.draw(ctx, 0, 0, width, height)
      s.close()
      out.push(ctx.getImageData(0, 0, width, height))
    }
    return out
  } catch {
    return indices.map(() => null)
  } finally {
    input.dispose()
  }
}

/**
 * Decode a file by frame ORDINAL — the k-th picture in the file, whatever its
 * timestamp says.
 *
 * THE MEDIARECORDER LANE NEEDS THIS AND THE WEBCODECS LANES DO NOT, which is
 * why every lane uses it. A VideoEncoder is handed timestamp i/30 explicitly;
 * MediaRecorder stamps by WALL CLOCK, and this rig's pacing is a setTimeout, so
 * its file runs a few percent long and index i/30 would land on a neighbouring
 * source frame. That is precisely the phase error X6's 27.9 dB had to search
 * around. Ordinals have no phase: the k-th requestFrame() is the k-th picture.
 * A lane whose file holds fewer pictures than were pushed says so (see
 * `framesInFile`) rather than silently comparing frame k with frame k+3.
 */
export async function decodeByOrdinal(
  blob: Blob,
  ordinals: number[],
  width: number,
  height: number,
): Promise<{ frames: (ImageData | null)[]; times: (number | null)[]; framesInFile: number }> {
  const want = new Set(ordinals)
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
  const got = new Map<number, ImageData>()
  // The file's own timestamp for each picked ordinal — the bridge to anything
  // downstream that is placed by TIME rather than by count (the export is).
  const at = new Map<number, number>()
  let count = 0
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return { frames: ordinals.map(() => null), times: ordinals.map(() => null), framesInFile: 0 }
    const sink = new VideoSampleSink(track)
    for await (const s of sink.samples()) {
      const k = count++
      if (want.has(k)) {
        ctx.clearRect(0, 0, width, height)
        s.draw(ctx, 0, 0, width, height)
        got.set(k, ctx.getImageData(0, 0, width, height))
        at.set(k, s.timestamp)
      }
      s.close()
    }
  } catch {
    /* whatever was collected before the failure is still usable */
  } finally {
    input.dispose()
  }
  return {
    frames: ordinals.map((k) => got.get(k) ?? null),
    times: ordinals.map((k) => at.get(k) ?? null),
    framesInFile: count,
  }
}

/**
 * Decode at given times AT THE FILE'S OWN SIZE.
 *
 * The fixed-size decoders above exist because a codec sweep knows what it
 * painted. An EXPORT does not: it is whatever the product produced, and reading
 * it back through a canvas of an assumed size would resample every pixel —
 * which is a filter, applied to exactly the sharp edges the metric is about.
 */
export async function decodeNative(
  blob: Blob,
  times: number[],
): Promise<{ frames: (ImageData | null)[]; width: number; height: number }> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return { frames: times.map(() => null), width: 0, height: 0 }
    const width = track.displayWidth
    const height = track.displayHeight
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
    const sink = new VideoSampleSink(track)
    const out: (ImageData | null)[] = []
    for (const t of times) {
      const s = await sink.getSample(t)
      if (!s) {
        out.push(null)
        continue
      }
      ctx.clearRect(0, 0, width, height)
      s.draw(ctx, 0, 0, width, height)
      s.close()
      out.push(ctx.getImageData(0, 0, width, height))
    }
    return { frames: out, width, height }
  } catch {
    return { frames: times.map(() => null), width: 0, height: 0 }
  } finally {
    input.dispose()
  }
}

/**
 * An open file that can be asked for a frame at any time, repeatedly.
 *
 * `decodeNative` re-demuxes per call, which is fine for three samples and
 * useless for an ALIGNMENT SEARCH — and an alignment search is not optional
 * here. Two files produced by different export paths can differ because their
 * pictures differ or because one is placed later than the other, and this
 * project has already confused those twice (o5cut's "+1 frame", and O9's
 * capture stage, which is a scroll position reported as an encoder). Comparing
 * at one nominal instant assumes the answer.
 */
export interface NativeReader {
  width: number
  height: number
  at: (t: number) => Promise<ImageData | null>
  close: () => void
}

export async function openNative(blob: Blob): Promise<NativeReader | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const track = await input.getPrimaryVideoTrack()
  if (!track) {
    input.dispose()
    return null
  }
  const width = track.displayWidth
  const height = track.displayHeight
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
  const sink = new VideoSampleSink(track)
  return {
    width,
    height,
    at: async (t) => {
      const s = await sink.getSample(Math.max(0, t))
      if (!s) return null
      ctx.clearRect(0, 0, width, height)
      s.draw(ctx, 0, 0, width, height)
      s.close()
      return ctx.getImageData(0, 0, width, height)
    },
    close: () => input.dispose(),
  }
}

/**
 * WHERE in `reader` the picture `ref` actually sits, in seconds from `centre`.
 *
 * Coarse then fine, and ties go to the SMALLER offset: on near-static content
 * many neighbouring frames are byte-identical, so a search that keeps the first
 * best would report a placement difference that is only the order it looked in.
 * Candidates are decoded one at a time and discarded — a search that holds its
 * window is a memory measurement (X5's rig error (a)).
 */
export async function findOffsetSec(
  ref: ImageData,
  reader: NativeReader,
  centre: number,
  rect: Rect,
  opts: { spanSec?: number; coarseStepFrames?: number } = {},
): Promise<{ offsetSec: number; db: number } | null> {
  const span = opts.spanSec ?? 1.5
  const coarse = opts.coarseStepFrames ?? 3
  const better = (
    best: { offsetSec: number; db: number } | null,
    cand: { offsetSec: number; db: number },
  ): { offsetSec: number; db: number } =>
    !best ||
    cand.db > best.db + 1e-9 ||
    (Math.abs(cand.db - best.db) < 1e-9 && Math.abs(cand.offsetSec) < Math.abs(best.offsetSec))
      ? cand
      : best

  let best: { offsetSec: number; db: number } | null = null
  const span_f = Math.round(span * FPS)
  for (let d = -span_f; d <= span_f; d += coarse) {
    const frame = await reader.at(centre + d / FPS)
    if (!frame || frame.width !== ref.width) continue
    best = better(best, { offsetSec: d / FPS, db: comparePatch(ref, frame, rect).db })
  }
  if (!best) return null
  const around = Math.round(best.offsetSec * FPS)
  for (let d = around - coarse; d <= around + coarse; d++) {
    const frame = await reader.at(centre + d / FPS)
    if (!frame || frame.width !== ref.width) continue
    best = better(best, { offsetSec: d / FPS, db: comparePatch(ref, frame, rect).db })
  }
  return best
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A rect of a frame as its own ImageData, so textEdgeMetric can take a region. */
export function crop(img: ImageData, r: Rect): ImageData {
  const out = new ImageData(r.w, r.h)
  for (let y = 0; y < r.h; y++) {
    const src = ((r.y + y) * img.width + r.x) * 4
    out.data.set(img.data.subarray(src, src + r.w * 4), y * r.w * 4)
  }
  return out
}

/** PSNR + the two shapes of disagreement, over a rect. glComposite's form. */
export function comparePatch(
  a: ImageData,
  b: ImageData,
  r: Rect,
): { db: number; max: number; over8Pct: number; meanSigned: [number, number, number] } {
  let sum = 0
  let n = 0
  let max = 0
  let over8 = 0
  const signed: [number, number, number] = [0, 0, 0]
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const ia = (y * a.width + x) * 4
      const ib = (y * b.width + x) * 4
      let worst = 0
      for (let c = 0; c < 3; c++) {
        const d = a.data[ia + c]! - b.data[ib + c]!
        signed[c] += d
        const ad = Math.abs(d)
        if (ad > worst) worst = ad
        if (ad > max) max = ad
        sum += d * d
        n++
      }
      if (worst > 8) over8++
    }
  }
  const px = Math.max(1, r.w * r.h)
  const mse = sum / Math.max(1, n)
  const r1 = (v: number): number => Math.round((v / px) * 100) / 100
  return {
    db: mse === 0 ? 99 : Math.round(10 * Math.log10((255 * 255) / mse) * 10) / 10,
    max,
    over8Pct: Math.round((over8 / px) * 1000) / 10,
    meanSigned: [r1(signed[0]), r1(signed[1]), r1(signed[2])],
  }
}

/**
 * A rect of a frame, blown up with NEAREST-NEIGHBOUR, as a PNG data URL.
 *
 * PO's own condition on this task is "i need to see it", and the ruling is made
 * by eye — so the artifact has to show PIXELS, not a resampled impression of
 * them. Smoothing on a 4× magnification would apply exactly the kind of blur
 * the measurement is about, and would flatter every lane equally.
 */
export async function magnify(img: ImageData, r: Rect, scale = 4): Promise<string> {
  const src = new OffscreenCanvas(r.w, r.h)
  src.getContext('2d', { alpha: false })!.putImageData(crop(img, r), 0, 0)
  const dst = new OffscreenCanvas(r.w * scale, r.h * scale)
  const g = dst.getContext('2d', { alpha: false })!
  g.imageSmoothingEnabled = false
  g.drawImage(src, 0, 0, dst.width, dst.height)
  const blob = await dst.convertToBlob({ type: 'image/png' })
  const buf = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]!)
  return `data:image/png;base64,${btoa(s)}`
}

/** The crop every lane's artifact uses: a patch of coloured code, same place. */
export const GLYPH_CROP: Rect = { x: 96, y: 60, w: 400, h: 225 }

/** The synthetic text page's own palette — the reference every chroma row uses. */
export const PAGE_COLOURS: { name: string; rgb: [number, number, number] }[] = [
  { name: 'grey  #c9d1d9', rgb: [201, 209, 217] },
  { name: 'green #7ee787', rgb: [126, 231, 135] },
  { name: 'blue  #79c0ff', rgb: [121, 192, 255] },
]

/** max−min over max, in percent: how much COLOUR a pixel still carries. */
export function saturationPct(rgb: [number, number, number]): number {
  const mx = Math.max(...rgb)
  const mn = Math.min(...rgb)
  return mx === 0 ? 0 : Math.round(((mx - mn) / mx) * 1000) / 10
}

export interface ChromaRow {
  colour: string
  pixels: number
  mean: [number, number, number]
  saturationPct: number
  /** decoded saturation / source saturation, %. 100 = the colour survived. */
  keptPct: number
}

/**
 * How much of each glyph colour a decoded frame still carries, masked BY THE
 * SOURCE.
 *
 * THE MASK COMES FROM THE SOURCE AND THAT IS THE WHOLE POINT — the same rule
 * textEdge.ts follows for edges, for the same reason. Classifying the DECODED
 * pixels by their own colour would let a frame that has desaturated a glyph out
 * of the green cluster also drop it from the measurement, and the metric would
 * improve as the picture got worse.
 *
 * And this is the statistic X15(c)'s first pass could not have produced at all:
 * it compared export paths against EACH OTHER, so a loss every path shares —
 * which is exactly what 4:2:0 chroma subsampling is — cancels to zero. PO saw
 * it by eye in the artifacts. A file-against-file rig never will.
 */
export function chromaRows(
  source: ImageData,
  decoded: ImageData,
  rect: Rect,
  tolerance = 6,
): ChromaRow[] {
  return PAGE_COLOURS.map(({ name, rgb }) => {
    let n = 0
    const sum: [number, number, number] = [0, 0, 0]
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const si = (y * source.width + x) * 4
        if (
          Math.abs(source.data[si]! - rgb[0]) > tolerance ||
          Math.abs(source.data[si + 1]! - rgb[1]) > tolerance ||
          Math.abs(source.data[si + 2]! - rgb[2]) > tolerance
        ) {
          continue
        }
        const di = (y * decoded.width + x) * 4
        n++
        sum[0] += decoded.data[di]!
        sum[1] += decoded.data[di + 1]!
        sum[2] += decoded.data[di + 2]!
      }
    }
    const mean: [number, number, number] = n
      ? [
          Math.round((sum[0] / n) * 10) / 10,
          Math.round((sum[1] / n) * 10) / 10,
          Math.round((sum[2] / n) * 10) / 10,
        ]
      : [0, 0, 0]
    const src = saturationPct(rgb)
    const got = saturationPct(mean)
    return {
      colour: name,
      pixels: n,
      mean,
      saturationPct: got,
      keptPct: src > 0 ? Math.round((got / src) * 1000) / 10 : 0,
    }
  })
}

export interface Crop {
  label: string
  png: string
}

export interface FileFacts {
  bytes: number
  durationSec: number | null
  packets: number | null
  keyframes: number | null
  codec: string | null
  achievedMbps: number | null
}

/** Every number out of the FILE, the way bitsAudit does it. */
export async function fileFacts(blob: Blob): Promise<FileFacts> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) return { bytes: blob.size, durationSec: null, packets: null, keyframes: null, codec: null, achievedMbps: null }
    const durationSec = await input.computeDuration()
    let packets = 0
    let keyframes = 0
    const sink = new EncodedPacketSink(track)
    for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
      packets++
      if (p.type === 'key') keyframes++
    }
    return {
      bytes: blob.size,
      durationSec: Math.round(durationSec * 100) / 100,
      packets,
      keyframes,
      codec: (await track.getCodecParameterString()) ?? track.codec ?? null,
      achievedMbps: durationSec > 0 ? Math.round(((blob.size * 8) / durationSec / 1e6) * 100) / 100 : null,
    }
  } catch {
    return { bytes: blob.size, durationSec: null, packets: null, keyframes: null, codec: null, achievedMbps: null }
  } finally {
    input.dispose()
  }
}

/** Whole-frame PSNR, RGB. Reported next to the edge metric, never instead. */
export function psnr(a: ImageData, b: ImageData): number {
  const n = Math.min(a.data.length, b.data.length)
  let sum = 0
  let count = 0
  for (let i = 0; i < n; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a.data[i + c]! - b.data[i + c]!
      sum += d * d
      count++
    }
  }
  const mse = sum / Math.max(1, count)
  return mse === 0 ? 99 : Math.round(10 * Math.log10((255 * 255) / mse) * 10) / 10
}

/** Mean of a numeric field across rows, 2 dp — used all over the lanes. */
export function mean(values: number[]): number | null {
  if (!values.length) return null
  return Math.round((values.reduce((a, v) => a + v, 0) / values.length) * 100) / 100
}
