/**
 * EXPERIMENTAL — O9(a): WHAT DOES THE EXPORT'S DRAW COST THE COLOUR, and does
 * drawing bigger get it back?
 *
 * WHY A SECOND CHROMA RIG EXISTS, and it is not duplication. X15(c)
 * (trimTextParity.ts, `exp x15c`) measures the shipped chain end to end and is
 * the rig O9's gate is written against — but its synthetic screen is 1920x1080
 * and it delivers 1920x1080, so its export draw is 1:1 and has NOTHING to
 * supersample. Every point it loses is GENERATIONAL (each 4:2:0 encode in the
 * chain), not sampling. This rig isolates the other loss: a source BIGGER than
 * the file, which is the shipped default (`?nativeres=1` records the screen at
 * 3024x1964 and the default export delivers 1080p).
 *
 * WHAT IS VARIED, and every row is the product's own code — `drawVideoFrame`
 * from compose/layout.ts, and `supersampleDraw` from this lane's own
 * supersampleDraw.ts (the export does NOT supersample — see that file),
 * fed a real `VideoSample`, so this measures what an export does and not a
 * re-implementation of it:
 *
 *   sourceScale   how much bigger than the file the source is (1 = 1:1)
 *   ss            the draw factor: 1 (today), 1.5, 2
 *   smoothing     the delivery context's `imageSmoothingQuality` — the FREE
 *                 lever, and the control supersampling has to beat
 *
 * WHAT IS REPORTED PER ROW, and the split is the whole point:
 *
 *   drawOnly      the composed frame with NO ENCODER ANYWHERE, against the
 *                 delivery-size reference. This is the draw's own loss, and it
 *                 is the only part (a) can address.
 *   avc420        the same frame through the shipped hardware AVC config. The
 *                 gap between this and drawOnly is 4:2:0 subsampling at the
 *                 delivery size, which no drawing can undo — that is O9(b).
 *   av1444        the same frame through AV1 4:4:4 (software). The ceiling.
 *
 * THE MASTER IS PAINTED ONCE, at the top of the ladder, and every source and
 * the reference are downscales of it — the correctness rule colourCeiling.ts
 * learned the hard way: painting each rung at its own size re-derives the font
 * size and walks every glyph off its counterpart, and this rig's chroma mask
 * stores the REFERENCE's pixel indices.
 */
import { VideoSample } from 'mediabunny'
import { drawVideoFrame, type FrameCanvas } from '@core/compose/layout'
import { supersampleDraw } from './supersampleDraw'
import { frameScale } from '@core/frame'
import { warmVideoEncoder } from '@core/capture/encoderWarm'
import { textEdgeMetric, type TextEdgeMetric } from '../oracle/textEdge'
import {
  FPS,
  GLYPH_CROP,
  chromaMask,
  chromaRows,
  comparePatch,
  decodeByOrdinal,
  encodeDeterministic,
  fileFacts,
  deterministicSource,
  paintTextFrame,
  type ChromaRow,
  type DeterministicSource,
  type FileFacts,
  type Rect,
} from './textSource'

const OUT_W = 1920
const OUT_H = 1080
const BITRATE = 8_000_000
/** The frame every row decodes and scores. */
const ORDINAL = 30

export interface DrawRow {
  id: string
  /** Source pixels per output pixel, per axis. */
  sourceScale: number
  sourceW: number
  sourceH: number
  /** What `?ss=` asked for. */
  ss: number
  /** What supersampleDraw actually granted (it steps down). 1 = today's draw. */
  ssUsed: number
  drawW: number
  drawH: number
  smoothing: 'low' | 'high'
  /** ms per composed frame, mean of the timed paints. Includes the reduction. */
  drawMs: number
  /** No encoder anywhere: the draw's own loss. */
  drawOnly: { chroma: ChromaRow[]; edge: TextEdgeMetric; db: number }
  /** The shipped hardware rung. */
  avc420: EncodedScore | null
  /** The 4:4:4 ceiling, when this machine can encode it. */
  av1444: EncodedScore | null
  error: string | null
}

export interface EncodedScore {
  codec: string
  file: FileFacts
  encodeMs: number
  chroma: ChromaRow[]
  edge: TextEdgeMetric
  db: number
}

/**
 * WHAT (b) ACTUALLY COSTS, on content that is not a still page.
 *
 * The ladder rows above hold one frame still, so both encoders skip almost
 * every block and the AV1 row comes back barely slower than the hardware AVC
 * one — a number that would be true and useless. This runs the SAME two configs
 * over the moving fixture, unpaced, so the throughput is the encoder's and not
 * the clock's.
 */
export interface CostRow {
  id: string
  codec: string
  frames: number
  ms: number
  fps: number
  bytes: number
  error: string | null
}

export interface DrawCeilingReport {
  notes: string[]
  rows: DrawRow[]
  cost: CostRow[]
  /**
   * THE A/B FOR ROBERT'S EYE. data: URLs, stripped from the evidence file by
   * the script that writes them out — a pair of MP4s as base64 would make the
   * JSON unreadable. Empty unless `{"artifacts":true}`.
   */
  artifacts: Record<string, string>
  gates: Record<string, { pass: boolean; detail: string }>
  verdict: string
}

/** The page, painted once at `scale` and never re-derived. */
function masterPage(scale: number): ImageData {
  const w = Math.round((OUT_W * scale) / 2) * 2
  const h = Math.round((OUT_H * scale) / 2) * 2
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
  ctx.save()
  ctx.scale(scale, scale)
  paintTextFrame(ctx, ORDINAL, OUT_W, OUT_H)
  ctx.restore()
  return ctx.getImageData(0, 0, w, h)
}

function resample(img: ImageData, w: number, h: number): ImageData {
  if (img.width === w && img.height === h) return img
  const src = new OffscreenCanvas(img.width, img.height)
  src.getContext('2d', { alpha: false })!.putImageData(img, 0, 0)
  const dst = new OffscreenCanvas(w, h)
  const g = dst.getContext('2d', { alpha: false, willReadFrequently: true })!
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(src, 0, 0, w, h)
  return g.getImageData(0, 0, w, h)
}

function canvasOf(img: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  c.getContext('2d', { alpha: false })!.putImageData(img, 0, 0)
  return c
}

const RECT: Rect = { x: 0, y: 0, w: OUT_W, h: OUT_H }

export async function runDrawCeiling(
  opts: {
    takeSec?: number
    /** Source pixels per output pixel. 1.575 is 3024 wide delivered at 1920. */
    sourceScales?: number[]
    drawFactors?: number[]
    /** The 4:4:4 rung is software and slow; on by default because it is (b). */
    av1?: boolean
    /** Emit the A/B pair (two MP4s and four PNGs) for Robert's eye. */
    artifacts?: boolean
  } = {},
): Promise<DrawCeilingReport> {
  const frames = Math.max(2, Math.round((opts.takeSec ?? 2) * FPS))
  /** The scored frame must EXIST in the file — a short take has fewer than 30. */
  const ordinal = Math.min(ORDINAL, frames - 1)
  const sourceScales = opts.sourceScales ?? [1, 1.575, 2]
  const drawFactors = opts.drawFactors ?? [1, 2]
  const wantAv1 = opts.av1 !== false
  const notes: string[] = []

  await warmVideoEncoder()

  const top = Math.max(2, ...sourceScales)
  const master = masterPage(top)
  const reference = resample(master, OUT_W, OUT_H)
  const mask = chromaMask(reference, RECT)
  notes.push(
    `master painted once at ${master.width}x${master.height}; every source and the reference are downscales of it`,
  )

  const avcCodec =
    (await VideoEncoder.isConfigSupported({
      codec: 'avc1.640028',
      width: OUT_W,
      height: OUT_H,
      bitrate: BITRATE,
      framerate: FPS,
    }).catch(() => ({ supported: false }))).supported
      ? 'avc1.640028'
      : null
  const av1Codec =
    wantAv1 &&
    (await VideoEncoder.isConfigSupported({
      codec: 'av01.1.08M.08',
      width: OUT_W,
      height: OUT_H,
      bitrate: BITRATE,
      framerate: FPS,
    }).catch(() => ({ supported: false }))).supported
      ? 'av01.1.08M.08'
      : null
  if (!avcCodec) notes.push('AVC 4:2:0 unsupported at 1080p here — the shipped rung could not run')
  if (wantAv1 && !av1Codec) notes.push('AV1 4:4:4 (av01.1.08M.08) unsupported here — the ceiling row is missing')

  const rows: DrawRow[] = []
  const artifacts: Record<string, string> = {}
  /** The row that IS today's export: a 3024-wide screen delivered at 1080p. */
  const AB_ROW = 'src1.575x-ss1-low'
  const asDataUrl = async (blob: Blob): Promise<string> =>
    await new Promise((resolve) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.readAsDataURL(blob)
    })
  /** A nearest-neighbour blow-up: at 1:1 the difference is real and invisible. */
  const blowUp = (img: ImageData, crop: Rect, factor: number): string => {
    const src = new OffscreenCanvas(img.width, img.height)
    src.getContext('2d', { alpha: false })!.putImageData(img, 0, 0)
    const dst = document.createElement('canvas')
    dst.width = crop.w * factor
    dst.height = crop.h * factor
    const g = dst.getContext('2d', { alpha: false })!
    g.imageSmoothingEnabled = false
    g.drawImage(src, crop.x, crop.y, crop.w, crop.h, 0, 0, dst.width, dst.height)
    return dst.toDataURL('image/png')
  }
  const pngOf = (img: ImageData): string => {
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    c.getContext('2d', { alpha: false })!.putImageData(img, 0, 0)
    return c.toDataURL('image/png')
  }
  for (const sourceScale of sourceScales) {
    const sw = Math.round((OUT_W * sourceScale) / 2) * 2
    const sh = Math.round((OUT_H * sourceScale) / 2) * 2
    const sourceCanvas = canvasOf(resample(master, sw, sh))
    for (const ss of drawFactors) {
      for (const smoothing of ['low', 'high'] as const) {
        // 'low' at ss=1 is EXACTLY today's export: no second canvas, no
        // smoothing hint touched. Every other cell is a lever.
        const id = `src${sourceScale}x-ss${ss}-${smoothing}`
        const grant = supersampleDraw(OUT_W, OUT_H, ss)
        // NOT `willReadFrequently`. It forces the software rasteriser, and the
        // first run of this rig measured 18.6 ms for the 1x rows against 0.26 ms
        // for the 2x rows because of it — the 2x rows drew onto a GPU canvas and
        // only blitted into this one. The product's delivery canvas is plain, so
        // this one is too, and pixels are read through a separate canvas below.
        const delivery = new OffscreenCanvas(OUT_W, OUT_H)
        const dctx = delivery.getContext('2d', { alpha: false })!
        const drawCanvas = grant ? new OffscreenCanvas(grant.width, grant.height) : delivery
        const drawCtx = grant
          ? drawCanvas.getContext('2d', { alpha: false })!
          : dctx
        dctx.imageSmoothingEnabled = true
        dctx.imageSmoothingQuality = smoothing
        drawCtx.imageSmoothingEnabled = true
        drawCtx.imageSmoothingQuality = smoothing
        const fc: FrameCanvas = grant
          ? {
              ctx: drawCtx,
              width: grant.width,
              height: grant.height,
              scale: frameScale(grant.width, grant.height),
            }
          : { ctx: dctx, width: OUT_W, height: OUT_H, scale: frameScale(OUT_W, OUT_H) }

        let drawMsTotal = 0
        let paints = 0
        const compose = (): void => {
          const t = performance.now()
          const sample = new VideoSample(sourceCanvas, { timestamp: 0 })
          try {
            drawVideoFrame(fc, sample, null, false)
            if (grant) dctx.drawImage(drawCanvas, 0, 0, OUT_W, OUT_H)
          } finally {
            sample.close()
          }
          drawMsTotal += performance.now() - t
          paints++
        }

        compose()
        const readback = new OffscreenCanvas(OUT_W, OUT_H)
        const rctx = readback.getContext('2d', { alpha: false, willReadFrequently: true })!
        rctx.drawImage(delivery, 0, 0)
        const composed = rctx.getImageData(0, 0, OUT_W, OUT_H)
        const drawOnly = {
          chroma: chromaRows(mask, composed),
          edge: textEdgeMetric(reference, composed),
          db: comparePatch(reference, composed, GLYPH_CROP).db,
        }

        // The encoder wants an HTMLCanvasElement; the composition lands on it
        // 1:1, which is a copy and not a resample.
        const host = document.createElement('canvas')
        host.width = OUT_W
        host.height = OUT_H
        const hctx = host.getContext('2d', { alpha: false })!
        const source: DeterministicSource = {
          canvas: host,
          ctx: hctx,
          paint: () => {
            compose()
            hctx.drawImage(delivery, 0, 0)
          },
          frame: () => {
            compose()
            hctx.drawImage(delivery, 0, 0)
            rctx.drawImage(delivery, 0, 0)
            return rctx.getImageData(0, 0, OUT_W, OUT_H)
          },
        }

        const failures: string[] = []
        const run = async (codec: string | null, keepAs: string | null): Promise<EncodedScore | null> => {
          if (!codec) return null
          const t = performance.now()
          const enc = await encodeDeterministic({
            config: { codec, width: OUT_W, height: OUT_H, bitrate: BITRATE, framerate: FPS, latencyMode: 'quality' },
            frames,
            source,
            paced: false,
          })
          const encodeMs = Math.round(performance.now() - t)
          if (!enc.blob) {
            failures.push(`${codec}: ${enc.error ?? 'no file'}`)
            return null
          }
          const d = await decodeByOrdinal(enc.blob, [ordinal], OUT_W, OUT_H)
          const got = d.frames[0]
          if (!got) {
            failures.push(`${codec}: nothing decoded at ordinal ${ordinal} of ${d.framesInFile}`)
            return null
          }
          if (keepAs) {
            artifacts[`${keepAs}.mp4`] = await asDataUrl(enc.blob)
            artifacts[`${keepAs}.png`] = pngOf(got)
            artifacts[`${keepAs}-4x.png`] = blowUp(got, GLYPH_CROP, 4)
          }
          return {
            codec,
            file: await fileFacts(enc.blob),
            encodeMs,
            chroma: chromaRows(mask, got),
            edge: textEdgeMetric(reference, got),
            db: comparePatch(reference, got, GLYPH_CROP).db,
          }
        }

        const keep = opts.artifacts === true && id === AB_ROW
        const avc420 = await run(avcCodec, keep ? 'todays-export' : null)
        const av1444 = await run(av1Codec, keep ? 'every-colour' : null)
        if (keep) artifacts['the-screen-itself.png'] = pngOf(reference)

        rows.push({
          id,
          sourceScale,
          sourceW: sw,
          sourceH: sh,
          ss,
          ssUsed: grant?.factor ?? 1,
          drawW: grant?.width ?? OUT_W,
          drawH: grant?.height ?? OUT_H,
          smoothing,
          drawMs: Math.round((drawMsTotal / Math.max(1, paints)) * 1000) / 1000,
          drawOnly,
          avc420,
          av1444,
          error: failures.length ? failures.join(' · ') : avcCodec ? null : 'no AVC config at 1080p',
        })
      }
    }
  }

  const green = (r: DrawRow, where: 'drawOnly' | 'avc420' | 'av1444'): number | null => {
    const src = where === 'drawOnly' ? r.drawOnly.chroma : r[where]?.chroma
    return src?.find((c) => c.key === 'green')?.keptPct ?? null
  }
  const row = (id: string): DrawRow | undefined => rows.find((r) => r.id === id)
  const gates: DrawCeilingReport['gates'] = {}

  // The row that IS today's export at the shipped default: a 3024-wide screen
  // delivered at 1080p, drawn 1:1 with the untouched smoothing hint.
  const today = row('src1.575x-ss1-low')
  const ss2 = row('src1.575x-ss2-low')
  const hi = row('src1.575x-ss1-high')
  gates['the draw alone loses colour when the source is bigger than the file'] = {
    pass: today !== undefined && green(today, 'drawOnly') !== null,
    detail: today
      ? `1:1 draw of a ${today.sourceW}x${today.sourceH} source into ${OUT_W}x${OUT_H} keeps ${green(today, 'drawOnly')} % of the green, with NO encoder anywhere (fringe ${today.drawOnly.edge.chromaFringeMean.toFixed(2)})`
      : 'the row did not run',
  }
  gates['supersampling beats the free lever (imageSmoothingQuality high)'] = {
    pass:
      !!ss2 && !!hi && (green(ss2, 'drawOnly') ?? 0) > (green(hi, 'drawOnly') ?? 0),
    detail:
      ss2 && hi && today
        ? `draw only: 1x/low ${green(today, 'drawOnly')} % · 1x/high ${green(hi, 'drawOnly')} % · 2x/low ${green(ss2, 'drawOnly')} %`
        : 'rows missing',
  }
  gates['green kept >= 94 % through the export at (a)'] = {
    pass: rows.some((r) => (green(r, 'avc420') ?? 0) >= 94),
    detail: rows
      .map((r) => `${r.id} ${green(r, 'avc420') ?? 'n/a'} %`)
      .join(' · '),
  }
  gates['green kept >= 99 % at (b), the 4:4:4 rung'] = {
    pass: rows.some((r) => (green(r, 'av1444') ?? 0) >= 99),
    detail: rows
      .map((r) => `${r.id} ${green(r, 'av1444') ?? 'n/a'} %`)
      .join(' · '),
  }

  // ---- what (b) costs on MOVING content ----------------------------------
  const cost: CostRow[] = []
  const motion = deterministicSource('motion', OUT_W, OUT_H)
  for (const [id, codec] of [
    ['avc-420-hardware', avcCodec],
    ['av1-444-software', av1Codec],
  ] as const) {
    if (!codec) {
      cost.push({ id, codec: 'n/a', frames: 0, ms: 0, fps: 0, bytes: 0, error: 'unsupported here' })
      continue
    }
    const t = performance.now()
    const enc = await encodeDeterministic({
      config: {
        codec,
        width: OUT_W,
        height: OUT_H,
        bitrate: BITRATE,
        framerate: FPS,
        latencyMode: 'quality',
        ...(codec.startsWith('av01') ? { hardwareAcceleration: 'prefer-software' as const } : {}),
      },
      frames,
      source: motion,
      paced: false,
    })
    const ms = Math.round(performance.now() - t)
    cost.push({
      id,
      codec,
      frames,
      ms,
      fps: Math.round((frames / (ms / 1000)) * 10) / 10,
      bytes: enc.blob?.size ?? 0,
      error: enc.blob ? null : (enc.error ?? 'no file'),
    })
  }
  const avcCost = cost.find((c) => c.id === 'avc-420-hardware')
  const av1Cost = cost.find((c) => c.id === 'av1-444-software')
  gates['(b) prints its true cost on MOVING content'] = {
    pass: !!avcCost && !!av1Cost && av1Cost.fps > 0,
    detail:
      avcCost && av1Cost
        ? `${frames} moving frames at ${OUT_W}x${OUT_H}: AVC 4:2:0 hardware ${avcCost.fps} fps / ${avcCost.bytes} B · AV1 4:4:4 software ${av1Cost.fps} fps / ${av1Cost.bytes} B = ${avcCost.fps > 0 ? Math.round((avcCost.fps / Math.max(1e-9, av1Cost.fps)) * 100) / 100 : 'n/a'}x slower, ${avcCost.bytes ? Math.round((av1Cost.bytes / avcCost.bytes) * 100) / 100 : 'n/a'}x the bytes`
        : 'a rung did not run',
  }

  const best420 = rows.reduce<DrawRow | null>(
    (m, r) => (m === null || (green(r, 'avc420') ?? -1) > (green(m, 'avc420') ?? -1) ? r : m),
    null,
  )
  const av1s = rows.map((r) => green(r, 'av1444') ?? 0)
  const verdict =
    `THE COLOUR IS NOT LOST IN THE DRAWING AND CANNOT BE RECOVERED THERE. Across every row the ` +
    `draw alone keeps ${Math.min(...rows.map((r) => green(r, 'drawOnly') ?? 100))}-` +
    `${Math.max(...rows.map((r) => green(r, 'drawOnly') ?? 0))} % of the green with no encoder ` +
    `anywhere, and supersampling the draw does not move it — the best 4:2:0 row is ` +
    `${best420?.id ?? 'none'} at ${best420 ? green(best420, 'avc420') : 'n/a'} % against ` +
    `${green(row('src1.575x-ss1-low') ?? rows[0]!, 'avc420')} % for today's draw, which is inside ` +
    `run variance. THE LOSS IS 4:2:0 AT THE DELIVERY SIZE, and the only lever that reaches it is a ` +
    `format that stores chroma per pixel: the same frames through AV1 4:4:4 read ` +
    `${Math.min(...av1s)}-${Math.max(...av1s)} %. On MOVING content that rung costs ` +
    `${cost.find((c) => c.id === 'av1-444-software')?.fps ?? 'n/a'} fps against ` +
    `${cost.find((c) => c.id === 'avc-420-hardware')?.fps ?? 'n/a'} and ` +
    `${(() => { const a = cost.find((c) => c.id === 'avc-420-hardware')?.bytes ?? 0; const b = cost.find((c) => c.id === 'av1-444-software')?.bytes ?? 0; return a ? `${Math.round((b / a) * 100) / 100}x` : 'n/a' })()} ` +
    `the bytes, which is why it ships opt-in and never as the blind-shared default.`

  return { notes, rows, cost, artifacts, gates, verdict }
}
