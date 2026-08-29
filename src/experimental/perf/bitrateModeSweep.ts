/**
 * EXPERIMENTAL — X15 lane (a): the bitrateMode sweep X6's handoff named as the
 * next measurement, and the number Robert's X6 ruling waits on.
 *
 * WHAT X6 LEFT OPEN. At the same requested ceiling the WebCodecs AVC raw
 * channel wrote 0.21× the MediaRecorder VP9 channel's bytes on screen content
 * and the two pictures agreed to only 27.9 dB. X6 read that as rate control
 * rather than loss — `latencyMode:'realtime'` with no `bitrateMode` undershoots
 * on near-static text — and wrote down the experiment: sweep bitrateMode and
 * re-run the quality row. If a config closes the gap at a bitrate the disk
 * still likes, the X6 default becomes a decision with numbers behind it.
 *
 * WHY THIS IS NOT THE x6 RIG WITH A MATRIX BOLTED ON. That rig records two
 * separate takes of a MOVING source through two engines, so the frame at t in
 * one is a different PHASE from the frame at t in the other; it searches ±0.6 s
 * for the best match and its own notes call the result a LOWER BOUND ("at least
 * this close"). A sweep of ten configs cannot afford ten takes, and more
 * importantly it cannot afford ten different lower bounds — a 2 dB difference
 * between configs would be indistinguishable from alignment luck. So every lane
 * here encodes THE IDENTICAL PICTURES (textSource.ts is deterministic in frame
 * index) and is compared by frame ORDINAL. No search, no phase, no bound.
 *
 * THE VP9 SIDE IS THE SHIPPED ONE. It is a real MediaRecorder on a real canvas
 * capture track, at the same ceiling, fed the same pictures through
 * requestFrame() — not a WebCodecs VP9 stand-in. A WebCodecs VP9 lane runs too,
 * as the control that says how much of any difference is the CODEC and how much
 * is MediaRecorder's own rate control.
 *
 * WHAT IT STILL CANNOT SEE, named because the next session will ask: the
 * production raw channel feeds GPU-resident frames out of a
 * MediaStreamTrackProcessor, and this feeds canvas frames. The encoder CONFIG
 * is what is being swept and that transfers; the frame source does not. A
 * winning config here has to be confirmed end to end through `npm run exp -- x6`
 * before anything is flipped.
 */
import { textEdgeMetric, type TextEdgeMetric } from '../oracle/textEdge'
import {
  FPS,
  decodeByOrdinal,
  deterministicSource,
  encodeDeterministic,
  fileFacts,
  mean,
  psnr,
  recordDeterministic,
  GLYPH_CROP,
  magnify,
  type ContentKind,
  type Crop,
  type FileFacts,
} from './textSource'

const W = 1920
const H = 1080
/** What a raw SCREEN channel asks for today (compose/quality + capture). */
const BITRATE = 8_000_000

/** The codec ladder rawVideo.worker.ts walks, in its order. */
const CODEC_CANDIDATES = ['avc1.42E01E', 'avc1.4D402A', 'avc1.640028'] as const

export interface SweepCell {
  id: string
  note: string
  codec: string
  hardware: string | null
  latencyMode: LatencyMode
  bitrateMode: VideoEncoderBitrateMode | 'default'
  quantizer: number | null
  supported: boolean
  error: string | null
  framesOut: number
  framesInFile: number
  file: FileFacts | null
  /** Against the CANVAS — how good the picture is, absolutely. */
  psnrVsSourceDb: number | null
  edgeVsSource: TextEdgeMetric | null
  /** Against the shipped VP9 lane — X6's 27.9 dB, without the phase search. */
  psnrVsVp9Db: number | null
  bytesRatioVsVp9: number | null
}

export interface SweepContent {
  content: ContentKind
  frames: number
  /** The shipped MediaRecorder lane: the thing every AVC cell is measured against. */
  vp9: {
    mimeType: string
    file: FileFacts | null
    framesInFile: number
    psnrVsSourceDb: number | null
    edgeVsSource: TextEdgeMetric | null
    error: string | null
  }
  cells: SweepCell[]
  /** Cells that clear all three bars, best picture first. */
  matches: string[]
}

export interface X15SweepReport {
  notes: string[]
  sampledOrdinals: number[]
  picked: { codec: string; hardware: string } | null
  contents: SweepContent[]
  /** Robert-visible artifacts, magnified glyph crops. Only with {"crops":true}. */
  crops: Crop[]
  gates: Record<string, { pass: boolean; detail: string }>
  verdict: string
}

/** THE BARS, from X15's own text. */
const MATCH_PSNR_DB = 35
const MATCH_BYTES_RATIO = 1.2
/** Glyph sharpness may not be worse than the lane it is replacing, by more than noise. */
const MATCH_CONTRAST_SLACK = 0.02

interface GridEntry {
  id: string
  note: string
  latencyMode: LatencyMode
  bitrateMode?: VideoEncoderBitrateMode
  quantizer?: number
  /** Overrides the shipped acceleration pick — the software arm of the sweep. */
  accel?: HardwareAcceleration
}

/**
 * The grid. `realtime` + no bitrateMode is the SHIPPED cell and is first so a
 * reader can see what it is being compared with; the rest is the sweep X6 asked
 * for, plus the two quantizer rungs — quantizer mode ignores `bitrate`
 * entirely, which makes it the one mode that cannot undershoot a ceiling.
 */
const GRID: GridEntry[] = [
  { id: 'shipped', note: "SHIPPED: latencyMode 'realtime', no bitrateMode", latencyMode: 'realtime' },
  { id: 'realtime-constant', note: "the sweep's headline candidate", latencyMode: 'realtime', bitrateMode: 'constant' },
  { id: 'realtime-variable', note: 'the spec default, stated explicitly', latencyMode: 'realtime', bitrateMode: 'variable' },
  { id: 'quality-default', note: "latencyMode 'quality', no bitrateMode", latencyMode: 'quality' },
  { id: 'quality-constant', note: 'quality + constant', latencyMode: 'quality', bitrateMode: 'constant' },
  { id: 'quality-variable', note: 'quality + variable', latencyMode: 'quality', bitrateMode: 'variable' },
  { id: 'realtime-qp14', note: 'quantizer 14 — the expensive rung, to bracket the frontier upward', latencyMode: 'realtime', bitrateMode: 'quantizer', quantizer: 14 },
  { id: 'realtime-qp20', note: 'quantizer 20 — bitrate ignored, quality pinned', latencyMode: 'realtime', bitrateMode: 'quantizer', quantizer: 20 },
  { id: 'realtime-qp26', note: 'quantizer 26 — the cheaper rung of the same idea', latencyMode: 'realtime', bitrateMode: 'quantizer', quantizer: 26 },
  { id: 'quality-qp20', note: 'quality + quantizer 20', latencyMode: 'quality', bitrateMode: 'quantizer', quantizer: 20 },
  // THE SOFTWARE ARM. A hardware encoder is free to ignore bitrateMode — it
  // negotiates with a fixed-function block, not with libavcodec — so a grid run
  // only on the shipped hardware pick cannot tell "the knob does nothing" from
  // "the knob does nothing HERE". These three cells are the control that tells
  // them apart, and they are the only reason a null result from the sweep is
  // reportable as a fact about the API rather than about this Mac.
  { id: 'sw-realtime-default', note: 'SOFTWARE arm: no bitrateMode', latencyMode: 'realtime', accel: 'prefer-software' },
  { id: 'sw-realtime-constant', note: 'SOFTWARE arm: constant', latencyMode: 'realtime', bitrateMode: 'constant', accel: 'prefer-software' },
  { id: 'sw-realtime-variable', note: 'SOFTWARE arm: variable', latencyMode: 'realtime', bitrateMode: 'variable', accel: 'prefer-software' },
]

/** Mirrors rawVideo.worker.ts's pickVideoConfig: hardware first, its codec order. */
async function pickShippedCodec(): Promise<{ codec: string; hardware: string } | null> {
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference', 'prefer-software'] as const) {
    for (const codec of CODEC_CANDIDATES) {
      try {
        const r = await VideoEncoder.isConfigSupported({
          codec,
          width: W,
          height: H,
          bitrate: BITRATE,
          framerate: FPS,
          latencyMode: 'realtime',
          hardwareAcceleration,
          avc: { format: 'avc' },
        })
        if (r.supported) return { codec, hardware: hardwareAcceleration }
      } catch {
        /* next */
      }
    }
  }
  return null
}

function configFor(
  picked: { codec: string; hardware: string },
  entry: GridEntry,
): VideoEncoderConfig {
  return {
    codec: picked.codec,
    width: W,
    height: H,
    bitrate: BITRATE,
    framerate: FPS,
    latencyMode: entry.latencyMode,
    hardwareAcceleration: entry.accel ?? (picked.hardware as HardwareAcceleration),
    avc: { format: 'avc' },
    ...(entry.bitrateMode ? { bitrateMode: entry.bitrateMode } : {}),
  }
}

/**
 * DOES bitrateMode DO ANYTHING? Byte-identical files across the three modes is
 * the only honest way to answer it: `isConfigSupported` returns true for a
 * value the encoder then ignores, so support is not evidence of effect. Run per
 * arm, because a hardware encoder ignoring the knob says nothing about software.
 */
function bitrateModeEffect(cells: SweepCell[], ids: string[]): { honoured: boolean; detail: string } {
  const rows = ids
    .map((id) => cells.find((c) => c.id === id))
    .filter((c): c is SweepCell => !!c && !!c.file)
  if (rows.length < 2) return { honoured: false, detail: 'fewer than two cells produced a file' }
  const sizes = new Set(rows.map((r) => r.file!.bytes))
  return {
    honoured: sizes.size > 1,
    detail: rows.map((r) => `${r.id} ${r.file!.bytes} B`).join(' · '),
  }
}

/** The cells worth a picture: what ships, the best rate-control rung, the worst. */
const CROPPED = new Set(['shipped', 'realtime-qp14', 'realtime-qp26'])

export async function runBitrateModeSweep(
  opts: { takeSec?: number; contents?: ContentKind[]; crops?: boolean } = {},
): Promise<X15SweepReport> {
  const takeSec = opts.takeSec ?? 6
  const frames = Math.round(takeSec * FPS)
  const wanted = opts.contents ?? (['text', 'motion'] as ContentKind[])
  const notes: string[] = []

  // Three ordinals inside the take, none of them the opening keyframe (which
  // flatters every encoder) and none in the last half-second (where a lane can
  // be short of its own declared length).
  const sampledOrdinals = [
    Math.round(frames * 0.22),
    Math.round(frames * 0.55),
    Math.round(frames * 0.88),
  ]

  const picked = await pickShippedCodec()
  if (!picked) {
    return {
      notes: ['no AVC VideoEncoder config is supported on this machine — the whole lane is moot here'],
      sampledOrdinals,
      picked: null,
      contents: [],
      crops: [],
      gates: {},
      verdict: 'NOT MEASURABLE: this browser accepts no AVC config from the shipped ladder.',
    }
  }
  notes.push(
    `the AVC codec and acceleration mode are the ones rawVideo.worker.ts would pick (${picked.codec}, ${picked.hardware}) — the sweep is over bitrateMode and latencyMode ONLY, so a difference cannot be a different codec`,
  )

  const contents: SweepContent[] = []
  const crops: Crop[] = []
  for (const content of wanted) {
    const source = deterministicSource(content, W, H)

    // The shipped VP9 lane first: everything else is measured against it.
    const rec = await recordDeterministic({ source, frames, bitrate: BITRATE })
    let vp9File: FileFacts | null = null
    let vp9Frames: (ImageData | null)[] = []
    let vp9InFile = 0
    let vp9Psnr: number | null = null
    let vp9Edge: TextEdgeMetric | null = null
    if (rec.blob) {
      vp9File = await fileFacts(rec.blob)
      const d = await decodeByOrdinal(rec.blob, sampledOrdinals, W, H)
      vp9Frames = d.frames
      vp9InFile = d.framesInFile
      const ps: number[] = []
      const es: TextEdgeMetric[] = []
      for (let i = 0; i < sampledOrdinals.length; i++) {
        const dec = vp9Frames[i]
        if (!dec) continue
        const ref = source.frame(sampledOrdinals[i]!)
        ps.push(psnr(ref, dec))
        es.push(textEdgeMetric(ref, dec))
      }
      vp9Psnr = mean(ps)
      vp9Edge = meanEdge(es)
      if (opts.crops && content === 'text') {
        crops.push({ label: 'a-00-SOURCE-canvas', png: await magnify(source.frame(sampledOrdinals[0]!), GLYPH_CROP) })
        const v = vp9Frames[0]
        if (v) crops.push({ label: 'a-01-vp9-mediarecorder-SHIPPED-raw-lane', png: await magnify(v, GLYPH_CROP) })
      }
    }

    const cells: SweepCell[] = []
    for (const entry of GRID) {
      const config = configFor(picked, entry)
      let supported = false
      let error: string | null = null
      try {
        const r = await VideoEncoder.isConfigSupported(config)
        supported = !!r.supported
        if (!supported) error = 'isConfigSupported returned false'
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
      if (!supported) {
        cells.push(emptyCell(entry, picked, error))
        continue
      }
      const enc = await encodeDeterministic({
        config,
        frames,
        source,
        ...(entry.quantizer !== undefined ? { quantizer: entry.quantizer } : {}),
      })
      if (!enc.blob) {
        cells.push({ ...emptyCell(entry, picked, enc.error ?? 'no output'), framesOut: enc.framesOut })
        continue
      }
      const file = await fileFacts(enc.blob)
      const d = await decodeByOrdinal(enc.blob, sampledOrdinals, W, H)
      const vsSource: number[] = []
      const vsVp9: number[] = []
      const edges: TextEdgeMetric[] = []
      for (let i = 0; i < sampledOrdinals.length; i++) {
        const dec = d.frames[i]
        if (!dec) continue
        const ref = source.frame(sampledOrdinals[i]!)
        vsSource.push(psnr(ref, dec))
        edges.push(textEdgeMetric(ref, dec))
        const v = vp9Frames[i]
        if (v) vsVp9.push(psnr(v, dec))
      }
      if (opts.crops && content === 'text' && CROPPED.has(entry.id) && d.frames[0]) {
        crops.push({ label: `a-02-avc-webcodecs-${entry.id}`, png: await magnify(d.frames[0]!, GLYPH_CROP) })
      }
      cells.push({
        id: entry.id,
        note: entry.note,
        codec: picked.codec,
        hardware: picked.hardware,
        latencyMode: entry.latencyMode,
        bitrateMode: entry.bitrateMode ?? 'default',
        quantizer: entry.quantizer ?? null,
        supported: true,
        error: null,
        framesOut: enc.framesOut,
        framesInFile: d.framesInFile,
        file,
        psnrVsSourceDb: mean(vsSource),
        edgeVsSource: meanEdge(edges),
        psnrVsVp9Db: mean(vsVp9),
        bytesRatioVsVp9:
          vp9File && vp9File.bytes > 0 ? Math.round((file.bytes / vp9File.bytes) * 100) / 100 : null,
      })
    }

    const matches = cells
      .filter((c) => isMatch(c, vp9Edge))
      .sort((a, b) => (b.psnrVsVp9Db ?? 0) - (a.psnrVsVp9Db ?? 0))
      .map((c) => c.id)

    contents.push({
      content,
      frames,
      vp9: {
        mimeType: rec.mimeType,
        file: vp9File,
        framesInFile: vp9InFile,
        psnrVsSourceDb: vp9Psnr,
        edgeVsSource: vp9Edge,
        error: rec.error,
      },
      cells,
      matches,
    })
  }

  const text = contents.find((c) => c.content === 'text')
  const gates: X15SweepReport['gates'] = {}

  for (const c of contents) {
    gates[`${c.content}: the shipped VP9 lane recorded every picture it was given`] = {
      pass: c.vp9.framesInFile === c.frames,
      detail: `${c.vp9.framesInFile} of ${c.frames} pictures in the file (${c.vp9.mimeType})${
        c.vp9.framesInFile === c.frames ? '' : ' — ordinals are NOT aligned, quality rows on this content are unsafe'
      }`,
    }
    gates[`${c.content}: every AVC cell encoded every frame (a dropping lane is not a comparison)`] = {
      pass: c.cells.filter((x) => x.supported && !x.error).every((x) => x.framesInFile === c.frames),
      detail: c.cells
        .filter((x) => x.supported && !x.error)
        .map((x) => `${x.id} ${x.framesInFile}/${c.frames}`)
        .join(' · '),
    }
  }

  if (text) {
    const hw = bitrateModeEffect(text.cells, ['shipped', 'realtime-constant', 'realtime-variable'])
    const sw = bitrateModeEffect(text.cells, [
      'sw-realtime-default',
      'sw-realtime-constant',
      'sw-realtime-variable',
    ])
    gates['bitrateMode CHANGES THE FILE on the shipped (hardware) encoder'] = {
      pass: hw.honoured,
      detail: hw.honoured
        ? `yes — ${hw.detail}`
        : `NO: byte-identical output across constant/variable/default. isConfigSupported accepts the value and the encoder ignores it. ${hw.detail}`,
    }
    gates['bitrateMode CHANGES THE FILE on the software encoder (the control)'] = {
      pass: sw.honoured,
      detail: sw.honoured ? `yes — ${sw.detail}` : `NO — ${sw.detail}`,
    }
    const qp = bitrateModeEffect(text.cells, ['realtime-qp14', 'realtime-qp20', 'realtime-qp26'])
    gates['quantizer mode IS honoured (the knob that is not inert)'] = {
      pass: qp.honoured,
      detail: qp.detail,
    }

    const shipped = text.cells.find((c) => c.id === 'shipped')
    gates['X6 REPRODUCED: the shipped raw config undershoots on screen text'] = {
      pass: (shipped?.bytesRatioVsVp9 ?? 1) < 0.5,
      detail: `shipped AVC writes ${shipped?.bytesRatioVsVp9 ?? 'n/a'}× the VP9 bytes and agrees with it to ${shipped?.psnrVsVp9Db ?? 'n/a'} dB (X6 measured 0.21× / 27.9 dB through the real session)`,
    }
    gates[`X15(a) DELIVERABLE: a config matches VP9 (≥${MATCH_PSNR_DB} dB, contrast not worse) at ≤${MATCH_BYTES_RATIO}× its bytes`] =
      {
        pass: text.matches.length > 0,
        detail: text.matches.length
          ? `${text.matches.join(', ')} — best is ${text.matches[0]}`
          : 'NO CELL IN THE GRID CLEARS ALL THREE BARS — that is the measured frontier, and it is the answer',
      }
  }

  notes.push(
    'every lane in a content encodes the IDENTICAL pictures and is compared by frame ORDINAL, so there is no alignment search and no lower bound — unlike X6’s 27.9 dB, which its own rig calls "at least this close"',
  )
  notes.push(
    'the VP9 side is a real MediaRecorder on a real canvas capture track at the same ceiling, driven frame by frame with requestFrame() — the shipped raw-channel path, not a WebCodecs stand-in',
  )
  notes.push(
    'the production raw channel feeds GPU-resident frames from a MediaStreamTrackProcessor and this feeds canvas frames: the CONFIG transfers, the frame source does not. A winning cell needs `npm run exp -- x6` to confirm it end to end before any default moves',
  )
  notes.push(
    'MOTION is the control. A config that only helps text is a content-specific tuning and the raw channel records both, so both are reported and neither is averaged away',
  )

  return {
    notes,
    sampledOrdinals,
    picked,
    contents,
    crops,
    gates,
    verdict: verdictOf(text),
  }
}

function emptyCell(
  entry: GridEntry,
  picked: { codec: string; hardware: string },
  error: string | null,
): SweepCell {
  return {
    id: entry.id,
    note: entry.note,
    codec: picked.codec,
    hardware: picked.hardware,
    latencyMode: entry.latencyMode,
    bitrateMode: entry.bitrateMode ?? 'default',
    quantizer: entry.quantizer ?? null,
    supported: false,
    error,
    framesOut: 0,
    framesInFile: 0,
    file: null,
    psnrVsSourceDb: null,
    edgeVsSource: null,
    psnrVsVp9Db: null,
    bytesRatioVsVp9: null,
  }
}

function isMatch(c: SweepCell, vp9Edge: TextEdgeMetric | null): boolean {
  if (!c.supported || c.error || c.psnrVsVp9Db === null || c.bytesRatioVsVp9 === null) return false
  if (c.psnrVsVp9Db < MATCH_PSNR_DB) return false
  if (c.bytesRatioVsVp9 > MATCH_BYTES_RATIO) return false
  if (vp9Edge && c.edgeVsSource) {
    if (c.edgeVsSource.edgeContrastKept < vp9Edge.edgeContrastKept - MATCH_CONTRAST_SLACK) return false
  }
  return true
}

function meanEdge(ms: TextEdgeMetric[]): TextEdgeMetric | null {
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

function verdictOf(text: SweepContent | undefined): string {
  if (!text) return 'no text content measured'
  const shipped = text.cells.find((c) => c.id === 'shipped')
  const head = `SHIPPED CONFIG on screen text: ${shipped?.bytesRatioVsVp9 ?? 'n/a'}× the VP9 bytes, ${shipped?.psnrVsVp9Db ?? 'n/a'} dB against it, glyph contrast ${shipped?.edgeVsSource?.edgeContrastKept ?? 'n/a'} against VP9's ${text.vp9.edgeVsSource?.edgeContrastKept ?? 'n/a'}.`
  if (!text.matches.length) {
    return `${head} NO CONFIG IN THE GRID CLEARS ALL THREE BARS. That is the frontier X15(a) was written to find, and it means the AVC raw channel cannot be made to match the VP9 picture at a comparable bitrate by rate-control settings alone.`
  }
  const best = text.cells.find((c) => c.id === text.matches[0])!
  return `${head} A MATCH EXISTS: ${best.id} (${best.note}) reaches ${best.psnrVsVp9Db} dB against VP9 at ${best.bytesRatioVsVp9}× its bytes, glyph contrast ${best.edgeVsSource?.edgeContrastKept}. X6's ruling can be a yes/no on this, AFTER the cell is confirmed end to end through the real capture session.`
}
