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
  GLYPH_CROP,
  chromaMask,
  chromaRows,
  comparePatch,
  paintTextFrame,
  decodeByOrdinal,
  encodeDeterministic,
  fileFacts,
  type ChromaRow,
  type DeterministicSource,
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
  /** What the encoder was finally ASKED for. Differs from the ladder's nominal
   *  bitrate in equal-bytes mode, where it is searched. */
  bitrateUsed: number
  /** The search trail, so a run can be checked rather than trusted. */
  byteSearch: string | null
  /** Measured at the DELIVERY size, after a player-style downscale. */
  chroma: ChromaRow[]
  /**
   * T1. What a VIEWER gets: the decoded, downscaled picture against the
   * delivery-size reference page. A supersampled rung is legitimately allowed
   * to win here — capturing 3024 wide and delivering 1920 really does carry
   * better antialiasing than rendering 1920 directly, and for F18 that is a
   * real capture, not a re-render.
   */
  vsReference: PatchScore | null
  /**
   * IS THIS RUNG EVEN COMPARABLE TO THE REFERENCE? This rung's own
   * UNCOMPRESSED source, downscaled to delivery, against the delivery-size
   * reference — no encoder anywhere. It should be near-identical: the same page
   * painted at two sizes and brought back to one. Anything low means the two
   * pictures are not the same picture, and every cross-rung number in this
   * report — the chroma mask included, because it is built from the reference's
   * PIXEL INDICES and read at those indices in the decode — is comparing
   * pixels that do not correspond. Added by the T1 session after the first run
   * returned a 22.6 dB drop that no encoder could explain.
   */
  alignment: PatchScore | null
  /**
   * T1. What the ENCODE cost, with rendering held out of it: the decoded
   * picture against THIS rung's own uncompressed source, downscaled the same
   * way. This is the number the equal-bytes question actually turns on —
   * "luma gets fewer bits per pixel" is a claim about encode loss, and
   * measuring it against the 1x reference would confuse it with the
   * supersampling bonus above.
   */
  encodeLoss: PatchScore | null
  error: string | null
}

export interface PatchScore {
  /** Over the glyph crop — the text, which is what this whole lane is about. */
  textDb: number
  textMax: number
  textOver8Pct: number
  /** Over the whole delivered frame. */
  frameDb: number
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

/**
 * EVERY RUNG COMES OFF ONE MASTER, AND THAT IS THE FIXTURE'S WHOLE CORRECTNESS.
 *
 * Two things were wrong with painting each rung at its own canvas size, and the
 * first T1 run caught both by failing its own gate zero at 14.1 dB.
 *
 * ONE — IT WAS NOT THE SAME PAGE. `deterministicSource` re-derives geometry from
 * the canvas it is given (`font = round(height/38)px`, rows at `height/36`), so a
 * 2880x1620 render is not a 1.5x scaling of a 1920x1080 render: the font rounds
 * to 43 px where proportionality wants 42.6, and over a line of monospace that
 * walks every glyph off its counterpart. That matters far past T1, because this
 * rig's chroma mask stores the REFERENCE's pixel INDICES and reads the decode at
 * those indices — misaligned rungs were being scored on pixels that are not
 * theirs, and that is how the published X15(e) colour table was measured.
 *
 * TWO — IT MODELLED THE PRODUCT BACKWARDS. In production the source is the
 * user's 3024-wide screen and EVERY rung is a downscale of it: the shipped path
 * throws pixels away at capture, a 1.5x path throws away fewer, and the player
 * throws away the rest. Painting the 1x rung natively at 1080p gave it a
 * rasterisation it never gets in the field and made the ladder measure a
 * rendering difference on top of the encode.
 *
 * So: paint the page ONCE at the top of the ladder, and produce every rung by
 * downscaling that master to the rung's capture size. The reference is the same
 * master at delivery size. Correspondence is then exact by construction, the
 * only thing separating the rungs is how much of the master survives to the
 * encoder, and that is precisely what capture resolution is.
 *
 * Local to this file on purpose: textSource.ts is shared with the O9, bitsAudit
 * and X15(c) lanes, and changing the painter there would silently move numbers
 * those tasks are quoted against.
 */
function masterPage(scale: number, frameIndex: number): ImageData {
  const w = Math.round((OUT_W * scale) / 2) * 2
  const h = Math.round((OUT_H * scale) / 2) * 2
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
  ctx.save()
  ctx.scale(scale, scale)
  paintTextFrame(ctx, frameIndex, OUT_W, OUT_H)
  ctx.restore()
  return ctx.getImageData(0, 0, w, h)
}

/** Resample any image to any size with the player-quality filter. */
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

/** A source that replays ONE still, already at the rung's capture size. */
function fromImage(img: ImageData): DeterministicSource {
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
  const paint = (): void => ctx.putImageData(img, 0, 0)
  return { canvas, ctx, paint, frame: () => { paint(); return img } }
}

/** The player-style downscale, on its own so the UNCOMPRESSED source can be put
 *  through the identical path — otherwise the encode-loss number below would
 *  carry a resampling difference and be measuring the rig. */
function downscaleToDelivery(img: ImageData, w: number, h: number): ImageData {
  if (w === OUT_W && h === OUT_H) return img
  const src = new OffscreenCanvas(w, h)
  src.getContext('2d', { alpha: false })!.putImageData(img, 0, 0)
  const dst = new OffscreenCanvas(OUT_W, OUT_H)
  const g = dst.getContext('2d', { alpha: false, willReadFrequently: true })!
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  g.drawImage(src, 0, 0, OUT_W, OUT_H)
  return g.getImageData(0, 0, OUT_W, OUT_H)
}

function scoreOf(a: ImageData, b: ImageData): PatchScore {
  const text = comparePatch(a, b, GLYPH_CROP)
  const frame = comparePatch(a, b, { x: 0, y: 0, w: OUT_W, h: OUT_H })
  return { textDb: text.db, textMax: text.max, textOver8Pct: text.over8Pct, frameDb: frame.db }
}

async function atDeliverySize(blob: Blob, w: number, h: number): Promise<ImageData | null> {
  const d = await decodeByOrdinal(blob, [30], w, h)
  const got = d.frames[0]
  if (!got) return null
  return downscaleToDelivery(got, w, h)
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
  opts: { takeSec?: number; probeSource?: boolean; equalBytes?: boolean } = {},
): Promise<ColourCeilingReport> {
  const frames = Math.round((opts.takeSec ?? 3) * FPS)
  const notes: string[] = []

  await warmVideoEncoder()

  // The reference is the delivery-size page: 100 % means "as good as the screen
  // looks at the size the file is played at".
  // Painted at the TOP of the ladder (2x) and never above it: every rung and
  // the reference are downscales of this one picture.
  const master = masterPage(2, 30)
  const ref = resample(master, OUT_W, OUT_H)
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
  // The 1x shipped rung defines the file size every other rung must match in
  // equal-bytes mode. It is first in the ladder, so it is known by the time the
  // others need it.
  let targetBytes: number | null = null
  for (const rung of ladder) {
    const w = Math.round((OUT_W * rung.scale) / 2) * 2
    const h = Math.round((OUT_H * rung.scale) / 2) * 2
    const src = fromImage(resample(master, w, h))
    // TWO LADDERS, AND T1 IS THE SECOND ONE.
    //
    // Default: bitrate scales with pixels, so every rung holds the same bits
    // per pixel — otherwise the 2x row would be a bitrate experiment. That is
    // what the shipped X15(e) table measured, and it is why 1.5x costs 1.68x
    // the bytes.
    //
    // `{"equalBytes":true}`: every rung gets the SAME bits per second, i.e. the
    // same file for the same wall clock. This is T1, and it is the question the
    // first table could not answer — 1.68x the bytes collides head-on with the
    // standing minimal-size objective ("couple minutes video can be around
    // 10 mb"), so the only thing that makes supersampling a free win is if it
    // is still better AT THE SAME SIZE. Chroma gets full resolution either way;
    // luma gets fewer bits per pixel. Which wins is measured, not argued.
    const bitrate = opts.equalBytes
      ? BITRATE
      : Math.round(BITRATE * rung.scale * rung.scale)
    const codec = rung.codec.startsWith('avc')
      ? await avcForSize(w, h, bitrate)
      : (await VideoEncoder.isConfigSupported({ codec: rung.codec, width: w, height: h, bitrate, framerate: FPS }).catch(() => ({ supported: false }))).supported
        ? rung.codec
        : null
    if (!codec) {
      rows.push({ id: rung.id, note: rung.note, captureW: w, captureH: h, codec: rung.codec, file: null, chroma: [], bitrateUsed: 0, byteSearch: null, vsReference: null, encodeLoss: null, alignment: null, error: 'no supported config at this size' })
      continue
    }
    // EQUAL BYTES IS NOT WHAT AN EQUAL BITRATE BUYS, and the first T1 run found
    // that out: every rung asked for 8 Mbps and the files still came out
    // 583 KB / 939 KB / 1243 KB — 1.61x and 2.13x apart. Chrome's AVC rate
    // controller treats `bitrate` as a target it is free to UNDERSHOOT, and on
    // a near-static text page it undershoots hard and by different amounts at
    // different resolutions (X6 measured the same thing: "the raw AVC lane
    // undershooting its bitrate on screen content"; X15's own handoff records
    // bitrateMode as inert). A number the encoder is allowed to ignore cannot
    // hold a variable still, so the byte target is reached by SEARCH: encode,
    // read the file, scale the ask, repeat. Accept within 5 %.
    //
    // EIGHT ATTEMPTS, NOT FOUR, and the reason is itself a finding: the
    // response is strongly sublinear. On the 1.5x rung, asking for a THIRD of
    // the bitrate moved the file by 12 % (8000kbps→835 KB, 2402kbps→733 KB) —
    // the encoder has a quality floor for this content and walks down to a
    // byte target rather than jumping to it. Four steps left it 25 % high and
    // the run could not answer its own question.
    let bitrateUsed = bitrate
    let enc = await encodeDeterministic({
      config: { codec, width: w, height: h, bitrate: bitrateUsed, framerate: FPS, latencyMode: 'quality' },
      frames,
      source: src,
      paced: false,
    })
    const attempts: string[] = []
    if (opts.equalBytes && targetBytes !== null && enc.blob) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const got = enc.blob!.size
        attempts.push(`${Math.round(bitrateUsed / 1000)}kbps→${got}B`)
        if (Math.abs(got - targetBytes) / targetBytes <= 0.05) break
        const next = Math.max(200_000, Math.round((bitrateUsed * targetBytes) / got))
        if (next === bitrateUsed) break
        bitrateUsed = next
        const retry = await encodeDeterministic({
          config: { codec, width: w, height: h, bitrate: bitrateUsed, framerate: FPS, latencyMode: 'quality' },
          frames,
          source: src,
          paced: false,
        })
        if (!retry.blob) break
        enc = retry
      }
    }
    if (!enc.blob) {
      rows.push({ id: rung.id, note: rung.note, captureW: w, captureH: h, codec: rung.codec, file: null, chroma: [], bitrateUsed, byteSearch: null, vsReference: null, encodeLoss: null, alignment: null, error: enc.error })
      continue
    }
    if (opts.equalBytes && targetBytes === null) targetBytes = enc.blob!.size
    const shown = await atDeliverySize(enc.blob, w, h)
    // This rung's own picture with the ENCODER TAKEN OUT: the same source
    // frame, through the same downscale, never compressed. Frame 30 is the one
    // atDeliverySize decodes, so it is the one compared.
    const clean = downscaleToDelivery(src.frame(30), w, h)
    rows.push({
      id: rung.id,
      note: rung.note,
      captureW: w,
      captureH: h,
      codec,
      file: await fileFacts(enc.blob),
      chroma: shown ? chromaRows(mask, shown) : [],
      bitrateUsed,
      byteSearch: attempts.length ? attempts.join(' · ') : null,
      vsReference: shown ? scoreOf(ref, shown) : null,
      encodeLoss: shown ? scoreOf(clean, shown) : null,
      alignment: scoreOf(ref, clean),
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

  // T1 — THE GATE THAT DECIDES WHETHER F18's COLOUR HALF IS FREE.
  const row = (id: string): CeilingRow | undefined => rows.find((r) => r.id === id)
  const one = row('1x-420-SHIPPED')
  const onePointFive = row('1.5x-420')
  if (opts.equalBytes && one && onePointFive) {
    // GATE ZERO, AND EVERYTHING ELSE HANGS OFF IT. Before any rung is compared
    // to any other, the rungs have to BE the same picture. Both the chroma mask
    // and the reference PSNR read the decode at the REFERENCE's pixel indices,
    // so a rung whose page does not land on the same pixels is being scored on
    // pixels that do not correspond to it.
    const worstAlign = rows
      .filter((r) => r.alignment)
      .reduce((lo, r) => Math.min(lo, r.alignment!.frameDb), 99)
    gates['T1 GATE ZERO — the rungs are the same picture, before anything is compared'] = {
      pass: worstAlign >= 30,
      detail: rows
        .filter((r) => r.alignment)
        .map((r) => `${r.id} ${r.alignment!.frameDb} dB frame / ${r.alignment!.textDb} dB text vs the reference, UNCOMPRESSED`)
        .join(' · '),
    }
    const bytes1 = one.file?.bytes ?? 0
    const bytes15 = onePointFive.file?.bytes ?? 0
    const sameSize = bytes1 > 0 && Math.abs(bytes15 - bytes1) / bytes1 < 0.1
    gates['T1 — the files really are the same size'] = {
      pass: sameSize,
      detail:
        `1x ${bytes1} B · 1.5x ${bytes15} B` +
        (bytes1 > 0 ? ` (${(bytes15 / bytes1).toFixed(2)}x)` : '') +
        ' — search: ' +
        rows.map((r) => `${r.id} ${r.byteSearch ?? 'no search'}`).join(' | '),
    }
    // THE COMPARISON THAT SURVIVES A FAILED GATE ZERO. encodeLoss scores each
    // rung against ITS OWN uncompressed source through the same downscale, so
    // it needs no correspondence between rungs — it is the only cross-rung
    // number here that a layout difference cannot corrupt, and it is exactly
    // what "luma gets fewer bits per pixel" is a claim about.
    const encText = (id: string): number | null => row(id)?.encodeLoss?.textDb ?? null
    const dEnc = (encText('1.5x-420') ?? 0) - (encText('1x-420-SHIPPED') ?? 0)
    gates['T1 — at EQUAL BYTES, what does the ENCODE cost each rung on text?'] = {
      pass: sameSize && dEnc > 0,
      detail:
        rows
          .filter((r) => r.encodeLoss)
          .map((r) => `${r.id} ${r.encodeLoss!.textDb} dB (max ${r.encodeLoss!.textMax}, ${r.encodeLoss!.textOver8Pct}% over 8)`)
          .join(' · ') + ` — 1.5x is ${dEnc >= 0 ? '+' : ''}${dEnc.toFixed(1)} dB against 1x`,
    }
    gates['T1 — and the chroma, which is only readable if GATE ZERO passed'] = {
      pass: worstAlign >= 30 && (green('1.5x-420') ?? 0) > (shipped ?? 0),
      detail: `green kept 1x ${shipped}% → 1.5x ${green('1.5x-420')}%` +
        (worstAlign >= 30 ? '' : ' — NOT READABLE: gate zero failed, the mask is indexed off a different layout'),
    }
    notes.push(
      'T1 RAN: every rung holds the same BITS PER SECOND, so the rows are the same file size for the same wall clock and the comparison is quality-at-constant-size. The default ladder (no equalBytes) holds bits per PIXEL instead and is the one the shipped X15(e) table came from.',
    )
    notes.push(
      'two luma numbers per rung on purpose. vsReference is what a VIEWER gets and lets a supersampled rung keep its legitimate antialiasing advantage — for F18 that is a real capture of a real 3024-wide screen, not a re-render. encodeLoss holds rendering out and is the one the "luma gets fewer bits per pixel" objection is actually about.',
    )
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

  const zero = gates['T1 GATE ZERO — the rungs are the same picture, before anything is compared']
  const encGate = gates['T1 — at EQUAL BYTES, what does the ENCODE cost each rung on text?']
  const sizeGate = gates['T1 — the files really are the same size']
  if (encGate && zero && sizeGate) {
    const verdict = !sizeGate.pass
      ? `T1 CANNOT ANSWER: the byte search did not converge, so the rungs are not the same size and any quality comparison between them is a bitrate comparison. ${sizeGate.detail}`
      : !zero.pass
        ? `T1 ANSWERS ONLY HALF, AND THE INSTRUMENT IS WHY. Gate zero FAILED — the rungs are not pixel-aligned with the reference, so every number in this rig that reads the decode at the reference's indices (the chroma mask included, i.e. the published X15(e) colour table) is comparing pixels that do not correspond. The fixture paints its own font at \`round(height/38)\`px per rung, so a 1.5x page is not a 1.5x scaling of the 1x page. WHAT STILL STANDS is encodeLoss, which scores each rung against its own uncompressed source: ${encGate.detail}. ${zero.detail}`
        : encGate.pass
          ? `T1: AT EQUAL BYTES, 1.5x WINS. Supersampling is not a quality/size trade here — it costs less encode loss on text at the same file size, so it should simply become the rule rather than an F16 rung. ${encGate.detail}`
          : `T1: AT EQUAL BYTES, 1.5x DOES NOT WIN. It is a quality/size trade, it belongs to F16's rungs, and which side of it to take is Robert's ruling and not engineering's. ${encGate.detail}`
    return { notes, source, rows, gates, verdict }
  }

  const verdict =
    two !== null && ceiling !== null && shipped !== null
      ? two >= ceiling - 5
        ? `100 % IS A RESOLUTION QUESTION, NOT A CHROMA-FORMAT ONE. Capturing and delivering at 2x keeps ${two}% of the source green against the 4:4:4 ceiling's ${ceiling}% and the shipped 1x path's ${shipped}% — on the HARDWARE encoder, with no 4:4:4 anywhere. The cost is pixels (see the bytes gate), not the ~2x CPU a software 4:4:4 encode would take.`
        : `Supersampling does NOT reach the ceiling here: 2x keeps ${two}% against 4:4:4's ${ceiling}% and shipped ${shipped}%. The chroma format is the binding constraint after all.`
      : 'not measured'

  return { notes, source, rows, gates, verdict }
}
