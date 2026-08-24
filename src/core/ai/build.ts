/**
 * The AI export — one PDF an agent can read (task AI1).
 *
 * PO's bar: ONE file that ANY AI understands, not human-watchable, maximally
 * token-cheap. Agents do not watch video; they sample frames and pay about one
 * token per 750 pixels, so a five-minute MP4 is thousands of frames nobody can
 * afford. This builds the cheap thing instead: an index page of pure text, then
 * one pixel-delta keyframe per page.
 *
 * IT DECODES THE TAKE ONCE, through the SAME primitives the render uses
 * (compose/video.ts readers, compose/layout.ts drawVideoFrame), because note 13
 * is the standing verdict on this codebase's export cost: decode is the floor.
 * A second decode pipeline of its own would have doubled the only expensive
 * thing here. What it does NOT do is encode video, mix audio or mux — it draws
 * a composed frame four times a second, measures it, and keeps the few that say
 * something.
 *
 * WHAT IS DERIVED, AND WHAT WOULD HAVE BEEN A KNOB (spec docs/AI_EXPORT.md):
 *   frame rate      → the pixel delta (select.ts)
 *   resolution      → ≤1024 px view; the full-res crop appears only when the
 *                     changed region is small enough to be worth it
 *   cursor filter   → the delta's own size and persistence (select.ts)
 *   what to include → page order: index first, keyframes after, so an agent
 *                     that pages selectively descends only where it needs to
 * There is no setting in the UI, and there is nothing here for one to set.
 */
import type { VideoSample } from 'mediabunny'
import { blobStore } from '@core/store'
import {
  cameraPoseAt,
  cameraTrackIsActive,
  channelSourceTimeAt,
  hasEnabledVideo,
  outputDurationMs,
  outputToRecordingMs,
  viewportAt,
  viewportTrackIsActive,
} from '@core/timeline'
import { drawVideoFrame, type FrameCanvas } from '@core/compose/layout'
import { openVideoChannel, type VideoChannelReader } from '@core/compose/video'
import {
  DEFAULT_EXPORT_SETTINGS,
  type EditState,
  type ExportProgress,
  type ExportResult,
  type Recording,
} from '@core/types'
import { newId } from '@core/id'
import {
  GRID_COLS,
  GRID_ROWS,
  changedBlobs,
  emptyDelta,
  gridDelta,
  makeGrid,
  pointerMask,
  type LumaGrid,
  type Rect,
} from './delta'
import { buildIndexLines, type KeyframeEntry, type TrailPoint } from './indexText'
import { PdfWriter, wrapText, type PdfImage, type PdfSink } from './pdf'
import { currentPaceMs, initSelector, stepSelection, type Pointer } from './select'

/**
 * How often the picture is looked at.
 *
 * V1 looked 4 times a second and PO's first real take lost a whole sequence
 * between two pages — typing into a field, the button turning active, the click
 * and the tab switch, all inside one 5.5 s gap. Eight looks a second costs
 * nothing that matters (the decoder is already walking every frame — note 13 —
 * so this is one downscale and one diff more per second) and it is the floor
 * under everything else: nothing shorter than 125 ms can be seen at all.
 */
export const SAMPLE_FPS = 8
/** Longest side of the full-view image on a page: ~800 tokens at 16:9. */
const VIEW_MAX_PX = 1024
const JPEG_QUALITY = 0.72
/** Context around a changed region, as a share of the frame. */
const CROP_PAD_FRAC = 0.02
const CROP_MIN_PX = 240
/** A crop is full-res, but never more expensive than the view it sits under. */
const CROP_MAX_PX = 1024
/** Agents price images at roughly one token per this many pixels. */
const PIXELS_PER_TOKEN = 750
const CHARS_PER_TOKEN = 4
const MAX_TRAIL_POINTS = 12
/** Wrap width of the index text in half-ems: (468 pt page − 28 pt margins) / 4.5. */
const INDEX_WRAP_UNITS = 97
const INDEX_LINES_PER_PAGE = 96
/**
 * Stop adding frames past this size — the only HARD limit in the file's way.
 *
 * Claude accepts 32 MB per request, Gemini 50 MB; a page of ours is ~37 KB, so
 * 28 MB is ~750 pages and no ordinary take comes near it. It exists so a
 * pathological recording (4K detail, constant motion) degrades by stopping
 * rather than by producing a file the reader refuses.
 */
const MAX_FILE_BYTES = 28 * 1024 * 1024

/**
 * THE POINTER TRAIL IS A HEURISTIC AND THIS IS ITS SWITCH.
 *
 * The cursor FILTER is a threshold — a pointer is a handful of grid cells, a
 * tooltip is a hundred — and ships unconditionally. Reading the cursor's
 * POSITION out of the same pixels is a different claim: when the pointer moves,
 * the diff holds two marks (where it was, where it is) and only the previous
 * reading says which is which. The spec's rule is that the trail ships only if
 * the rig proves the detector reliable, so the measurement decides this
 * constant — see the AI1 handoff for the number it was set from.
 */
export const POINTER_TRAIL_ENABLED = true

export interface AiExportOptions {
  recording: Recording
  edit: EditState
  onProgress?: (p: ExportProgress) => void
  signal?: AbortSignal
}

export interface AiExportStats {
  /** Wall clock of the whole build. */
  totalMs: number
  /** Waiting for decoded source samples — the floor (note 13). */
  decodeMs: number
  /** Compositing and measuring. */
  drawMs: number
  /** JPEG encoding of the pages that were kept. */
  encodeMs: number
  samples: number
  keyframes: number
  pages: number
  bytes: number
  approxTokens: number
  perPageTokens: number[]
  /** Output-timeline ms of every keyframe — the distribution, for the rig. */
  keyframeAtOutMs: number[]
  /** Recording-epoch ms of every keyframe — what its caption states. */
  keyframeAtRecMs: number[]
  /** Whether each keyframe page carries a full-res crop (page image count). */
  keyframeHasCrop: boolean[]
  /** Every pointer reading the taxonomy made, before down-sampling. */
  pointerReadings: (Pointer & { atOutMs: number })[]
  /** How many samples each class accounted for. */
  classes: Record<string, number>
  /** Pages emitted inside a motion burst — the animation the file kept. */
  burstPages: number
  /** Pages this take was allowed, and the spacing the pace ended at. */
  budget: number
  finalPaceMs: number
}

let lastStats: AiExportStats | null = null

/** Stats of the most recent AI export (evidence; the AI1 gates read these). */
export function getLastAiExportStats(): AiExportStats | null {
  return lastStats
}

const SINK_PREFIX = 'aixport-'
let newestFinished: string | null = null

interface PdfDestination {
  sink: PdfSink
  finish(): Promise<Blob>
  discard(): Promise<void>
}

/**
 * Where the PDF goes while it is being written. OPFS first (O1's rule: the file
 * must not live in the heap — a long take is hundreds of JPEGs), memory as the
 * fallback so no platform loses the export.
 */
async function openPdfDestination(): Promise<PdfDestination> {
  const key = `${SINK_PREFIX}${newId('ai')}.pdf`
  try {
    for (const stale of await blobStore.listKeys()) {
      if (stale.startsWith(SINK_PREFIX) && stale !== newestFinished) {
        await blobStore.remove(stale).catch(() => undefined)
      }
    }
    const writer = (await blobStore.createWriteStream(key)).getWriter()
    let closed = false
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      await writer.close().catch(() => undefined)
    }
    return {
      sink: { write: (bytes) => writer.write(bytes) },
      async finish() {
        await close()
        const file = await blobStore.read(key)
        if (file.size === 0) throw new Error('ai export: file is empty')
        const previous = newestFinished
        newestFinished = key
        if (previous && previous !== key) await blobStore.remove(previous).catch(() => undefined)
        return file.slice(0, file.size, 'application/pdf')
      },
      async discard() {
        await close()
        await blobStore.remove(key).catch(() => undefined)
      },
    }
  } catch (err) {
    console.warn('[ai] OPFS unavailable, building the PDF in memory', err)
    const chunks: Uint8Array[] = []
    return {
      sink: {
        write: (bytes) => {
          chunks.push(bytes.slice())
          return Promise.resolve()
        },
      },
      finish: () => Promise.resolve(new Blob(chunks as BlobPart[], { type: 'application/pdf' })),
      discard: () => Promise.resolve(),
    }
  }
}

function readLuma(
  ctx: OffscreenCanvasRenderingContext2D,
  source: OffscreenCanvas,
  into: LumaGrid,
): void {
  ctx.drawImage(source, 0, 0, into.cols, into.rows)
  const { data } = ctx.getImageData(0, 0, into.cols, into.rows)
  for (let i = 0, p = 0; i < into.data.length; i++, p += 4) {
    // Rec.601 luma in integer arithmetic; the grid only needs 8 bits.
    into.data[i] = (data[p]! * 77 + data[p + 1]! * 150 + data[p + 2]! * 29) >> 8
  }
}

async function encodeJpeg(canvas: OffscreenCanvas): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY })
  if (blob.type !== 'image/jpeg') {
    throw new Error(`ai export: this browser encoded ${blob.type}, and a PDF image must be JPEG`)
  }
  return new Uint8Array(await blob.arrayBuffer())
}

/** Pixels of a crop, padded for context, clamped to the frame and to a token ceiling. */
function cropRectPx(
  region: Rect,
  width: number,
  height: number,
): { sx: number; sy: number; sw: number; sh: number; dw: number; dh: number } {
  const padX = CROP_PAD_FRAC * width
  const padY = CROP_PAD_FRAC * height
  let sx = Math.max(0, region.xFrac * width - padX)
  let sy = Math.max(0, region.yFrac * height - padY)
  let sw = Math.min(width - sx, region.widthFrac * width + padX * 2)
  let sh = Math.min(height - sy, region.heightFrac * height + padY * 2)
  // A 40×20 crop tells an agent nothing about where it is; give it a minimum.
  if (sw < CROP_MIN_PX) {
    sx = Math.max(0, Math.min(width - Math.min(CROP_MIN_PX, width), sx - (CROP_MIN_PX - sw) / 2))
    sw = Math.min(CROP_MIN_PX, width)
  }
  if (sh < CROP_MIN_PX) {
    sy = Math.max(0, Math.min(height - Math.min(CROP_MIN_PX, height), sy - (CROP_MIN_PX - sh) / 2))
    sh = Math.min(CROP_MIN_PX, height)
  }
  const scale = Math.min(1, CROP_MAX_PX / Math.max(sw, sh))
  return {
    sx: Math.round(sx),
    sy: Math.round(sy),
    sw: Math.round(sw),
    sh: Math.round(sh),
    dw: Math.max(1, Math.round(sw * scale)),
    dh: Math.max(1, Math.round(sh * scale)),
  }
}

function fileName(createdAt: number): string {
  const d = new Date(createdAt)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `inout-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-for-ai.pdf`
}

/**
 * The channel's last kept source instant — what a forward-only reader needs to
 * know to stop. Same quantity render.ts derives from its active windows; a
 * trim never moves a channel in time, so it is one number per channel.
 */
function localEndSec(edit: EditState, channelId: string, durationMs: number): number | null {
  const ce = edit.channels.find((c) => c.channelId === channelId)
  if (!ce || !ce.enabled) return null
  return Math.min(durationMs, ce.trimEndMs) / 1000
}

export async function exportForAi(opts: AiExportOptions): Promise<ExportResult> {
  const { recording, edit, onProgress, signal } = opts
  const { width, height } = DEFAULT_EXPORT_SETTINGS
  const t0 = performance.now()
  lastStats = null

  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError')
  }
  const report = (phase: ExportProgress['phase'], ratio: number): void => {
    onProgress?.({ phase, ratio: Math.min(1, Math.max(0, ratio)) })
  }

  const durationMs = outputDurationMs(edit)
  if (durationMs <= 0) throw new Error('Export window is empty')
  report('preparing', 0)

  const stats: AiExportStats = {
    totalMs: 0,
    decodeMs: 0,
    drawMs: 0,
    encodeMs: 0,
    samples: 0,
    keyframes: 0,
    pages: 0,
    bytes: 0,
    approxTokens: 0,
    perPageTokens: [],
    keyframeAtOutMs: [],
    keyframeAtRecMs: [],
    keyframeHasCrop: [],
    pointerReadings: [],
    classes: {},
    burstPages: 0,
    budget: 0,
    finalPaceMs: 0,
  }

  const readers: VideoChannelReader[] = []
  const destination = await openPdfDestination()
  const pdf = new PdfWriter(destination.sink)
  const keyframes: KeyframeEntry[] = []
  const trail: TrailPoint[] = []
  let ok = false

  try {
    await pdf.open()
    const hasVideo = hasEnabledVideo(recording, edit)
    if (hasVideo) {
      for (const channel of recording.channels) {
        if (channel.media !== 'video') continue
        throwIfAborted()
        const endSec = localEndSec(edit, channel.id, channel.durationMs)
        if (endSec === null) continue
        const blob = await blobStore.read(channel.blobKey)
        const reader = await openVideoChannel(blob, channel.id, channel.kind, endSec)
        if (reader) readers.push(reader)
      }
    }

    const viewScale = Math.min(1, VIEW_MAX_PX / Math.max(width, height))
    const viewW = Math.max(1, Math.round(width * viewScale))
    const viewH = Math.max(1, Math.round(height * viewScale))

    const full = new OffscreenCanvas(width, height)
    const fullCtx = full.getContext('2d', { alpha: false })
    const view = new OffscreenCanvas(viewW, viewH)
    const viewCtx = view.getContext('2d', { alpha: false })
    const small = new OffscreenCanvas(GRID_COLS, GRID_ROWS)
    const smallCtx = small.getContext('2d', { alpha: false, willReadFrequently: true })
    if (!fullCtx || !viewCtx || !smallCtx) throw new Error('Canvas 2D context unavailable')
    for (const c of [viewCtx, smallCtx]) {
      c.imageSmoothingEnabled = true
      c.imageSmoothingQuality = 'medium'
    }
    const frame: FrameCanvas = { ctx: fullCtx, width, height, scale: width / 1920 }

    const cameraFull = !readers.some((r) => r.kind === 'screen')
    const cameraMoves = !cameraFull && cameraTrackIsActive(edit.camera)
    const viewportMoves = viewportTrackIsActive(edit.viewport)

    let selector = initSelector(durationMs, 1000 / SAMPLE_FPS)
    const refGrid = makeGrid()
    const prevGrid = makeGrid()
    const nowGrid = makeGrid()
    let havePrev = false
    let sizeCapped = false
    // Where the pointer was at the reference frame and where it is now: both
    // differ between the two pictures, and neither is content.
    let refPointer: { xFrac: number; yFrac: number } | null = null

    const totalSamples = readers.length ? Math.max(1, Math.ceil((durationMs / 1000) * SAMPLE_FPS)) : 0
    for (let s = 0; s < totalSamples; s++) {
      throwIfAborted()
      const outMs = (s * 1000) / SAMPLE_FPS
      const recMs = outputToRecordingMs(edit, outMs) ?? outMs

      const tDecode = performance.now()
      let screen: VideoSample | null = null
      let camera: VideoSample | null = null
      for (const reader of readers) {
        const localMs = channelSourceTimeAt(recording, edit, reader.channelId, outMs)
        if (localMs === null) continue
        const sample = await reader.sampleAt(localMs / 1000)
        if (!sample) continue
        if (reader.kind === 'screen') screen = sample
        else camera = sample
      }
      stats.decodeMs += performance.now() - tDecode

      const tDraw = performance.now()
      let pose
      if (cameraMoves && camera && camera.displayWidth > 0 && camera.displayHeight > 0) {
        pose = cameraPoseAt(edit.camera, recMs, {
          frameAspect: width / height,
          cameraAspect: camera.displayWidth / camera.displayHeight,
        })
      }
      const viewportNow = viewportMoves ? viewportAt(edit.viewport, recMs) : undefined
      drawVideoFrame(frame, screen, camera, cameraFull, pose, edit.background, viewportNow)
      readLuma(smallCtx, full, nowGrid)
      // The pointer is subtracted from the CONTENT metric, never from the
      // motion one: a moving cursor is not an event, but the threshold that
      // used to hide it also hid a typed word and a button turning active.
      const mask = pointerMask(GRID_COLS, GRID_ROWS, [refPointer, selector.pointer])
      const vsRef = havePrev ? gridDelta(refGrid, nowGrid, undefined, mask) : emptyDelta()
      const vsPrev = havePrev ? gridDelta(prevGrid, nowGrid) : emptyDelta()
      const blobs = havePrev ? changedBlobs(prevGrid, nowGrid) : []
      stats.drawMs += performance.now() - tDraw

      const step = stepSelection(selector, {
        index: s,
        atOutMs: outMs,
        atRecMs: recMs,
        vsRef,
        vsPrev,
        blobsVsPrev: blobs,
      })
      selector = step.state
      const decision = step.decision
      stats.samples++
      stats.classes[decision.classification] = (stats.classes[decision.classification] ?? 0) + 1
      if (decision.pointer) {
        stats.pointerReadings.push({ ...decision.pointer, atOutMs: outMs })
      }

      if (decision.keyframe && pdf.bytesWritten >= MAX_FILE_BYTES) {
        if (!sizeCapped) {
          sizeCapped = true
          console.warn(
            `[ai] file reached ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} MB at t=${(outMs / 1000).toFixed(1)}s — no more frames (readers cap a PDF at 32-50 MB)`,
          )
        }
      } else if (decision.keyframe) {
        const tEncode = performance.now()
        viewCtx.drawImage(full, 0, 0, viewW, viewH)
        const viewImage = await pdf.addJpeg(await encodeJpeg(view), viewW, viewH)
        let cropImage: PdfImage | null = null
        let cropPixels = 0
        if (decision.crop) {
          const r = cropRectPx(decision.crop, width, height)
          const cropCanvas = new OffscreenCanvas(r.dw, r.dh)
          const cc = cropCanvas.getContext('2d', { alpha: false })
          if (cc) {
            cc.imageSmoothingEnabled = true
            cc.imageSmoothingQuality = 'medium'
            cc.drawImage(full, r.sx, r.sy, r.sw, r.sh, 0, 0, r.dw, r.dh)
            cropImage = await pdf.addJpeg(await encodeJpeg(cropCanvas), r.dw, r.dh)
            cropPixels = r.dw * r.dh
          }
        }
        // A page is read on its own as often as in sequence, so its caption
        // says what it belongs to — not just when it is. PO's first real test
        // came back with the AI asking what the file was; a bare "t=2.00s"
        // over a picture is not an answer to that.
        const caption = [
          `INOUT screen recording - frame ${keyframes.length + 1} at t=${(recMs / 1000).toFixed(2)}s of ${(durationMs / 1000).toFixed(2)}s` +
            `${decision.atCursor ? ' - the change is where the pointer was' : ''}`,
        ]
        if (cropImage) caption.push('lower image: close-up of what changed, at full resolution')
        const page = pdf.addImagePage(
          viewImage,
          cropImage,
          caption.map((text) => ({ text, size: 11 })),
        )
        stats.encodeMs += performance.now() - tEncode
        keyframes.push({
          atRecMs: recMs,
          page,
          hasCrop: !!cropImage,
          atCursor: decision.atCursor,
        })
        stats.keyframeAtOutMs.push(outMs)
        stats.keyframeAtRecMs.push(recMs)
        stats.keyframeHasCrop.push(!!cropImage)
        stats.perPageTokens.push(
          Math.round(
            (viewW * viewH + cropPixels) / PIXELS_PER_TOKEN +
              caption.join(' ').length / CHARS_PER_TOKEN,
          ),
        )
        refGrid.data.set(nowGrid.data)
        refPointer = selector.pointer
      }

      prevGrid.data.set(nowGrid.data)
      havePrev = true
      report('rendering', 0.05 + 0.85 * ((s + 1) / totalSamples))
    }

    for (const reader of readers) reader.dispose()
    readers.length = 0

    // The pointer trail is LOW RATE on purpose: a reading every 250 ms would
    // cost more tokens than the pages it annotates.
    const confident = stats.pointerReadings.filter((p) => p.confident)
    if (POINTER_TRAIL_ENABLED && confident.length) {
      const stride = Math.max(1, Math.ceil(confident.length / MAX_TRAIL_POINTS))
      for (let i = 0; i < confident.length; i += stride) {
        const p = confident[i]!
        trail.push({ atRecMs: p.atMs, xFrac: p.xFrac, yFrac: p.yFrac })
      }
    }

    report('finalizing', 0.92)
    // Page numbers depend on how many pages the index takes, and the index's
    // LINE COUNT does not depend on the numbers — so one pass fixes both.
    const imagePages = pdf.pageCount
    const provisional = buildIndexLines({
      recording,
      edit,
      keyframes,
      trail,
      width: viewW,
      height: viewH,
      sampleFps: SAMPLE_FPS,
      budgetSpent: selector.emitted >= selector.config.budget,
      approxTokens: 0,
      clockOffsetMs: 0,
    })
    const indexPages = Math.max(
      1,
      Math.ceil(
        provisional.flatMap((l) => wrapText(l, INDEX_WRAP_UNITS)).length / INDEX_LINES_PER_PAGE,
      ),
    )
    for (let i = 0; i < keyframes.length; i++) keyframes[i]!.page = indexPages + i + 1
    const pixelTokens = stats.perPageTokens.reduce((a, b) => a + b, 0)
    const lines = buildIndexLines({
      recording,
      edit,
      keyframes,
      trail,
      width: viewW,
      height: viewH,
      sampleFps: SAMPLE_FPS,
      budgetSpent: selector.emitted >= selector.config.budget,
      approxTokens: pixelTokens,
      clockOffsetMs: 0,
    }).flatMap((l) => wrapText(l, INDEX_WRAP_UNITS))
    for (let p = indexPages - 1; p >= 0; p--) {
      pdf.addTextPage(lines.slice(p * INDEX_LINES_PER_PAGE, (p + 1) * INDEX_LINES_PER_PAGE), {
        front: true,
      })
    }

    await pdf.close(
      `Screen recording, ${(durationMs / 1000).toFixed(1)}s, ${keyframes.length} frames - flattened for an AI reader`,
      'One screen recording as a document: page 1 says what it is and lists the frames, every page after it is a frame of that recording in time order. There is no video track — these frames are the recording.',
    )
    const blob = await destination.finish()
    ok = true

    stats.pages = indexPages + imagePages
    stats.keyframes = keyframes.length
    stats.burstPages = selector.burstPages
    stats.budget = selector.config.budget
    stats.finalPaceMs = currentPaceMs(selector, durationMs)
    stats.bytes = blob.size
    stats.approxTokens = Math.round(
      pixelTokens + lines.join(' ').length / CHARS_PER_TOKEN,
    )
    stats.totalMs = performance.now() - t0
    lastStats = stats
    console.info(
      `[ai] ${stats.pages} pages (${stats.keyframes} frames of ${stats.samples} looks, ` +
        `${stats.burstPages} inside motion bursts, budget ${stats.budget}, pace ended at ` +
        `${stats.finalPaceMs}ms) · ~${stats.approxTokens} tokens · ` +
        `${(blob.size / 1024).toFixed(0)} KB · ${Math.round(stats.totalMs)}ms ` +
        `(decode ${Math.round(stats.decodeMs)}ms · draw ${Math.round(stats.drawMs)}ms · jpeg ${Math.round(stats.encodeMs)}ms)`,
    )
    console.info(
      `[ai] per-page tokens: ${stats.perPageTokens.join(', ') || 'index only'} ` +
        `(pixels/${PIXELS_PER_TOKEN} + text/${CHARS_PER_TOKEN})`,
    )

    report('finalizing', 1)
    return {
      blob,
      mimeType: 'application/pdf',
      fileName: fileName(recording.createdAt),
      durationMs: Math.round(durationMs),
      width: viewW,
      height: viewH,
      ai: { pages: stats.pages, keyframes: stats.keyframes, approxTokens: stats.approxTokens },
    }
  } finally {
    for (const reader of readers) reader.dispose()
    if (!ok) await destination.discard().catch(() => undefined)
  }
}
