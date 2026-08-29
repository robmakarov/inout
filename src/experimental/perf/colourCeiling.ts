/**
 * EXPERIMENTAL — X15(e): CAN WE ACTUALLY GET 100 % OF THE COLOUR? (Robert:
 * "i want 100% colors")
 *
 * The previous answer was "no, the source is already 4:2:0 (NV12) so the colour
 * is gone before our encoder runs". That is true AT 1:1 AND ONLY AT 1:1, and
 * stopping there was the mistake. 4:2:0 stores chroma at HALF RESOLUTION IN
 * EACH AXIS — of whatever frame it is given. So the chroma a file carries is
 * fixed in ABSOLUTE samples, not in percent:
 *
 *     1080p 4:2:0   →  960x540 chroma   →  viewed at 1080p: a quarter resolution
 *     2160p 4:2:0   → 1920x1080 chroma  →  viewed at 1080p: ONE SAMPLE PER PIXEL
 *
 * i.e. a 4K 4:2:0 file, seen at 1080p, is chroma-complete — with a HARDWARE
 * encoder and no 4:4:4 anywhere. The cost is pixels, not CPU class, which is a
 * completely different trade from "software AV1 at ~2x CPU".
 *
 * TWO THINGS ARE MEASURED HERE, and the first is the one that decides the rest.
 *
 * (1) WHAT DOES REAL getDisplayMedia HAND US? Every format number this project
 *     has is from the SYNTHETIC screen, which is a canvas in our own process.
 *     cdp-run passes Chrome's --auto-accept-this-tab-capture, so a rig can run
 *     the REAL path with no picker. Reported: pixel format, colour space, and
 *     the coded size — because if Chrome hands us the screen at a LOWER
 *     resolution than the display, the supersampling lever is already spent
 *     before we reach it.
 *
 * (2) THE SUPERSAMPLE LADDER. The same page painted at 1x / 1.5x / 2x of the
 *     delivery size, encoded 4:2:0 through the SHIPPED hardware AVC config,
 *     decoded, downscaled to the delivery size the way a player would, and
 *     measured against the 1x reference. Plus 4:4:4-at-1x as the known ceiling
 *     and 4:2:0-at-1x as what ships. If the 2x row lands on the 4:4:4 row, the
 *     answer to "100 %" is resolution, not chroma format.
 *
 * The fixture is the same still code page every other X15 lane uses, so these
 * numbers sit beside theirs.
 */
import { warmVideoEncoder } from '@core/capture/encoderWarm'
import {
  FPS,
  chromaMask,
  chromaRows,
  decodeByOrdinal,
  deterministicSource,
  encodeDeterministic,
  fileFacts,
  type ChromaRow,
  type FileFacts,
  type Rect,
} from './textSource'

/** What we deliver, and the size every row is judged at. */
const OUT_W = 1920
const OUT_H = 1080
const BITRATE = 8_000_000

export interface SourceFormatProbe {
  ran: boolean
  error: string | null
  /** 'NV12' / 'I420' = already 4:2:0. 'BGRA' / 'RGBA' / 'I444' = full chroma. */
  format: string | null
  codedWidth: number | null
  codedHeight: number | null
  colorSpace: Record<string, unknown> | null
  trackSettings: Record<string, unknown> | null
}

export interface CeilingRow {
  id: string
  note: string
  captureW: number
  captureH: number
  codec: string
  /** Bytes for the same wall-clock length — the price of the row. */
  file: FileFacts | null
  /** Measured at the DELIVERY size, after a player-style downscale. */
  chroma: ChromaRow[]
  error: string | null
}

export interface ColourCeilingReport {
  notes: string[]
  source: SourceFormatProbe
  rows: CeilingRow[]
  gates: Record<string, { pass: boolean; detail: string }>
  verdict: string
}

/** The REAL capture path, with no picker — see the header. */
async function probeRealSource(): Promise<SourceFormatProbe> {
  const empty: SourceFormatProbe = {
    ran: false,
    error: null,
    format: null,
    codedWidth: null,
    codedHeight: null,
    colorSpace: null,
    trackSettings: null,
  }
  const TP = (globalThis as { MediaStreamTrackProcessor?: new (i: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } })
    .MediaStreamTrackProcessor
  if (!TP) return { ...empty, error: 'MediaStreamTrackProcessor unavailable' }
  let stream: MediaStream | null = null
  try {
    // A DEADLINE, because this hung a run for ten minutes. --auto-accept-this-
    // tab-capture answers a TAB capture; a SCREEN capture wants a desktop
    // picker, and a headless Chrome has no desktop to show one on — so the
    // promise simply never settles. Note 3's rule applies to rigs too.
    stream = await Promise.race([
      navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('getDisplayMedia did not settle in 10 s — headless has no desktop picker; run this headed, or read the format off a real take (capture/measuredVideo.ts logs it)')),
          10_000,
        ),
      ),
    ])
    const track = stream.getVideoTracks()[0]
    if (!track) return { ...empty, error: 'no video track' }
    const reader = new TP({ track }).readable.getReader()
    const { value } = await reader.read()
    if (!value) {
      await reader.cancel().catch(() => undefined)
      return { ...empty, error: 'no frame delivered' }
    }
    const out: SourceFormatProbe = {
      ran: true,
      error: null,
      format: value.format ?? null,
      codedWidth: value.codedWidth,
      codedHeight: value.codedHeight,
      colorSpace: value.colorSpace ? { ...value.colorSpace.toJSON() } : null,
      trackSettings: { ...track.getSettings() } as Record<string, unknown>,
    }
    value.close()
    await reader.cancel().catch(() => undefined)
    return out
  } catch (err) {
    return { ...empty, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
  } finally {
    for (const t of stream?.getTracks() ?? []) t.stop()
  }
}

/** Decode one frame and resample it to the delivery size, as a player would. */
async function atDeliverySize(blob: Blob, w: number, h: number): Promise<ImageData | null> {
  const d = await decodeByOrdinal(blob, [30], w, h)
  const got = d.frames[0]
  if (!got || (w === OUT_W && h === OUT_H)) return got
  const src = new OffscreenCanvas(w, h)
  src.getContext('2d', { alpha: false })!.putImageData(got, 0, 0)
  const dst = new OffscreenCanvas(OUT_W, OUT_H)
  const g = dst.getContext('2d', { alpha: false, willReadFrequently: true })!
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(src, 0, 0, OUT_W, OUT_H)
  return g.getImageData(0, 0, OUT_W, OUT_H)
}

/**
 * An AVC codec string whose LEVEL actually admits this frame size.
 *
 * `avc1.640028` is High@4.0 and caps at 1920x1080 — the first run of this rig
 * reported the 1.5x and 2x rungs as "config unsupported" and would have
 * concluded that supersampling is unavailable, when what was unavailable was a
 * level 4.0 encoder at 4K. Levels are tried in order and the first the browser
 * accepts is used, so the rung is about resolution and not about a constant.
 */
async function avcForSize(w: number, h: number, bitrate: number): Promise<string | null> {
  for (const codec of ['avc1.640028', 'avc1.64002A', 'avc1.640032', 'avc1.640033', 'avc1.640034']) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate, framerate: FPS })
      if (r.supported) return codec
    } catch {
      /* next level */
    }
  }
  return null
}

export async function runColourCeiling(
  opts: { takeSec?: number; probeSource?: boolean } = {},
): Promise<ColourCeilingReport> {
  const frames = Math.round((opts.takeSec ?? 3) * FPS)
  const notes: string[] = []

  await warmVideoEncoder()

  // The reference is the delivery-size page: 100 % means "as good as the screen
  // looks at the size the file is played at".
  const ref = deterministicSource('text', OUT_W, OUT_H).frame(0)
  const rect: Rect = { x: 0, y: 0, w: OUT_W, h: OUT_H }
  // The mask is built ONCE from the delivery-size reference and reused for
  // every rung — so a 2x rung is scored on exactly the pixels the 1x rung is,
  // and cannot win by having its own idea of where the green text is.
  const mask = chromaMask(ref, rect)

  const ladder: { id: string; note: string; scale: number; codec: string }[] = [
    { id: '1x-420-SHIPPED', note: 'what ships: capture and deliver at 1080p, 4:2:0', scale: 1, codec: 'avc1.640028' },
    { id: '1.5x-420', note: 'capture at 1620p, deliver 1080p — 4:2:0, hardware', scale: 1.5, codec: 'avc1.640028' },
    { id: '2x-420', note: 'capture at 2160p, deliver 1080p — 4:2:0, HARDWARE. One chroma sample per delivered pixel', scale: 2, codec: 'avc1.640028' },
    { id: '1x-444-av1', note: 'THE KNOWN CEILING: 4:4:4 at 1080p, software AV1', scale: 1, codec: 'av01.1.08M.08' },
  ]

  const rows: CeilingRow[] = []
  for (const rung of ladder) {
    const w = Math.round((OUT_W * rung.scale) / 2) * 2
    const h = Math.round((OUT_H * rung.scale) / 2) * 2
    const src = deterministicSource('text', w, h)
    // Bitrate scales with pixels, so every rung is judged at the same bits per
    // pixel — otherwise the 2x row would be a bitrate experiment.
    const bitrate = Math.round(BITRATE * rung.scale * rung.scale)
    const codec = rung.codec.startsWith('avc')
      ? await avcForSize(w, h, bitrate)
      : (await VideoEncoder.isConfigSupported({ codec: rung.codec, width: w, height: h, bitrate, framerate: FPS }).catch(() => ({ supported: false }))).supported
        ? rung.codec
        : null
    if (!codec) {
      rows.push({ id: rung.id, note: rung.note, captureW: w, captureH: h, codec: rung.codec, file: null, chroma: [], error: 'no supported config at this size' })
      continue
    }
    const enc = await encodeDeterministic({
      config: { codec, width: w, height: h, bitrate, framerate: FPS, latencyMode: 'quality' },
      frames,
      source: src,
      paced: false,
    })
    if (!enc.blob) {
      rows.push({ id: rung.id, note: rung.note, captureW: w, captureH: h, codec: rung.codec, file: null, chroma: [], error: enc.error })
      continue
    }
    const shown = await atDeliverySize(enc.blob, w, h)
    rows.push({
      id: rung.id,
      note: rung.note,
      captureW: w,
      captureH: h,
      codec,
      file: await fileFacts(enc.blob),
      chroma: shown ? chromaRows(mask, shown) : [],
      error: shown ? null : 'nothing decoded back',
    })
  }

  // THE SOURCE PROBE RUNS LAST AND IS OPT-IN, because it is the only thing here
  // that can take the page down: driving REAL getDisplayMedia in a headless tab
  // killed a whole run once ("Inspected target navigated or closed") and cost
  // the ladder with it. The ladder is the deliverable; the probe is a bonus
  // reading, and it must not be able to destroy the deliverable to get itself.
  const source = opts.probeSource
    ? await probeRealSource()
    : {
        ran: false,
        error: 'not requested — pass {"probeSource":true}; it can crash a headless tab',
        format: null,
        codedWidth: null,
        codedHeight: null,
        colorSpace: null,
        trackSettings: null,
      }

  const green = (id: string): number | null =>
    rows.find((r) => r.id === id)?.chroma.find((c) => c.colour.startsWith('green'))?.keptPct ?? null
  const shipped = green('1x-420-SHIPPED')
  const two = green('2x-420')
  const ceiling = green('1x-444-av1')

  const gates: ColourCeilingReport['gates'] = {}
  gates['the REAL getDisplayMedia frame format was read (not the synthetic one)'] = {
    pass: source.ran,
    detail: source.ran
      ? `format ${source.format} · coded ${source.codedWidth}x${source.codedHeight} · settings ${JSON.stringify(source.trackSettings)} · colorSpace ${JSON.stringify(source.colorSpace)}`
      : `NOT READ: ${source.error}`,
  }
  gates['capturing at 2x delivers the colour that 4:4:4 delivers, on HARDWARE'] = {
    pass: two !== null && ceiling !== null && two >= ceiling - 5,
    detail: `green kept — shipped 1x 4:2:0 ${shipped}% · 2x 4:2:0 ${two}% · 4:4:4 ceiling ${ceiling}%`,
  }
  const bytesOf = (id: string): number | null => rows.find((r) => r.id === id)?.file?.bytes ?? null
  gates['…and what that costs in bytes'] = {
    pass: true,
    detail: rows.map((r) => `${r.id} ${r.file?.bytes ?? 'n/a'} B`).join(' · ') +
      (bytesOf('2x-420') && bytesOf('1x-420-SHIPPED')
        ? ` — 2x is ${(bytesOf('2x-420')! / bytesOf('1x-420-SHIPPED')!).toFixed(2)}x the shipped file`
        : ''),
  }

  notes.push(
    'every rung is judged AT THE DELIVERY SIZE (1920x1080) after a player-style high-quality downscale — that is where a viewer sees the colour, and it is the only fair place to compare rungs of different resolutions',
  )
  notes.push(
    'bitrate scales with pixel count so each rung holds the same bits per pixel; otherwise the 2x row would be measuring a bigger budget rather than more chroma samples',
  )
  notes.push(
    'the source probe uses Chrome --auto-accept-this-tab-capture (cdp-run passes it), so it is the REAL getDisplayMedia path against this tab — the only format reading in this project that is not a canvas',
  )

  const verdict =
    two !== null && ceiling !== null && shipped !== null
      ? two >= ceiling - 5
        ? `100 % IS A RESOLUTION QUESTION, NOT A CHROMA-FORMAT ONE. Capturing and delivering at 2x keeps ${two}% of the source green against the 4:4:4 ceiling's ${ceiling}% and the shipped 1x path's ${shipped}% — on the HARDWARE encoder, with no 4:4:4 anywhere. The cost is pixels (see the bytes gate), not the ~2x CPU a software 4:4:4 encode would take.`
        : `Supersampling does NOT reach the ceiling here: 2x keeps ${two}% against 4:4:4's ${ceiling}% and shipped ${shipped}%. The chroma format is the binding constraint after all.`
      : 'not measured'

  return { notes, source, rows, gates, verdict }
}
