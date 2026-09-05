/**
 * EXPERIMENTAL — J9: WHAT QUALITY NUMBER DOES THE AV1 4:4:4 RUNG TAKE?
 *
 * WHY THIS RIG EXISTS. O9(b) ships `?colour=all` on AV1 profile 1, and that
 * rung is the only encode in this product still driven by a BITRATE. Constant
 * quality (constantQuality.ts, `?cq=`) has been the export's rate control since
 * 2026-08-29, but `constantQualityCodec` returns null for anything that is not
 * avc, so full colour never gets a quality target and spends 8 Mbps of budget
 * on frames that do not need it.
 *
 * J8 IS WHAT MADE THAT VISIBLE, and the symptom was not size. With the chunked
 * concatenation able to read AV1, the chunked and unbroken 4:4:4 lanes render
 * the same 900 packets at the same timestamps and come out 19.5 % apart in
 * bytes and 37.1 dB apart in pixels — because bitrate rate control run over
 * twelve 2.5 s segments is not the same rate control run over one 30 s stream.
 * Measured to its cause: the SAME 4:2:0 AVC lanes with `?cq=off` diverge the
 * same way (40.6 dB, −3 %), and with `?cq=` on they are pixel-identical. A
 * quantizer is set per frame and does not know how long the stream is, which is
 * exactly why it makes an edit's re-render reproducible.
 *
 * SO THE QUESTION IS THE NUMBER, and it cannot be mapped from H.264's. The
 * `?cq=` dial is an H.264 QP, 1-51, and WebCodecs' AV1 quantizer is 0-63 on a
 * different curve entirely. DEFAULT_QP = 20 was chosen by measuring rungs on
 * this product's own content (constantQuality.ts) and this does the same thing
 * for AV1, on the content O9 measured its colour on: one still code page, no
 * minification anywhere, which is the row where 4:2:0 keeps 77.8 % of the green
 * and 4:4:4 keeps 99.3 %.
 *
 * WHAT EVERY LANE ENCODES IS THE SAME PICTURE. `stillSource` paints one fixed
 * frame forever, so the only variable between lanes is the rate control — a
 * painter difference and a re-encode added together is the mistake this lane's
 * own textSource.ts already wrote down.
 *
 *   node scripts/exp.mjs av1q --timeout=1800
 *   node scripts/exp.mjs av1q '{"quantizers":[20,28,36],"takeSec":1}'
 *
 * Heavy: AV1 4:4:4 has no hardware encoder anywhere, so every AV1 lane is
 * dav1d's counterpart on the CPU. Run it through scripts/gate.sh.
 */
import { warmVideoEncoder } from '@core/capture/encoderWarm'
import { textEdgeMetric, type TextEdgeMetric } from '../oracle/textEdge'
import {
  FPS,
  GLYPH_CROP,
  chromaMask,
  chromaRows,
  comparePatch,
  decodeByOrdinal,
  deterministicSource,
  encodeDeterministic,
  fileFacts,
  paintTextFrame,
  stillSource,
  type ChromaRow,
  type ContentKind,
  type DeterministicSource,
  type FileFacts,
  type Rect,
} from './textSource'

const OUT_W = 1920
const OUT_H = 1080
/** The rung the bitrate lanes target — codecs.ts's VIDEO_BITRATE. */
const BITRATE = 8_000_000
const AVC_CODEC = 'avc1.640028'
/** Profile 1 is the 4:4:4 profile — fullColour.ts owns the shipped list. */
const AV1_444_CODEC = 'av01.1.08M.08'

export interface QualityLane {
  id: string
  /** Which fixture — a still code page, or the moving one. */
  content: ContentKind
  codec: string
  /** 'bitrate' = today's rate control; a number = quantizer mode at that value. */
  rate: 'bitrate' | number
  file: FileFacts
  encodeMs: number
  /** Every colour the mask found, kept-percentage against the reference. */
  chroma: ChromaRow[]
  edge: TextEdgeMetric
  /** Whole-patch PSNR of the decoded glyph crop against the page itself. */
  db: number
  error: string | null
}

export interface Av1QualityReport {
  notes: string[]
  lanes: QualityLane[]
  gates: Record<string, { pass: boolean; detail: string }>
  verdict: string
}

/** The page, painted once at delivery size — O9's 1:1 row, no minification. */
function referencePage(): ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = OUT_W
  canvas.height = OUT_H
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!
  paintTextFrame(ctx, 30, OUT_W, OUT_H)
  return ctx.getImageData(0, 0, OUT_W, OUT_H)
}

const RECT: Rect = { x: 0, y: 0, w: OUT_W, h: OUT_H }

async function accepts(config: VideoEncoderConfig): Promise<boolean> {
  try {
    const support = await VideoEncoder.isConfigSupported(config)
    return support.supported === true
  } catch {
    return false
  }
}

export async function runAv1Quality(
  opts: {
    takeSec?: number
    /**
     * The AV1 quantizers to try, 0-63. The default spread is deliberately wide:
     * nothing in this project has ever measured this scale, so a narrow sweep
     * around a guessed centre would only confirm the guess.
     */
    quantizers?: number[]
    /** The AVC rungs for context. `?cq=`'s default is 20. */
    avcQps?: number[]
  } = {},
): Promise<Av1QualityReport> {
  const frames = Math.max(2, Math.round((opts.takeSec ?? 2) * FPS))
  const ordinal = Math.min(30, frames - 1)
  const quantizers = opts.quantizers ?? [8, 16, 24, 32, 40, 48]
  const avcQps = opts.avcQps ?? [20]
  const notes: string[] = []

  await warmVideoEncoder()

  /**
   * TWO CONTENTS, and the second is not decoration. A still page flatters every
   * rate control there is: nothing moves, so a bitrate target and a quantizer
   * both coast. DEFAULT_QP was chosen on two contents for that reason
   * (constantQuality.ts), and quantizer mode has NO BYTE CEILING by ruling
   * (robert (16), Q1) — so what a moving picture costs at a given rung is
   * exactly the thing a still page cannot tell us.
   */
  const contents: { kind: ContentKind; reference: ImageData; source: DeterministicSource }[] = []
  {
    const reference = referencePage()
    contents.push({ kind: 'text', reference, source: stillSource(reference) })
  }
  {
    const moving = deterministicSource('motion', OUT_W, OUT_H)
    contents.push({ kind: 'motion', reference: moving.frame(ordinal), source: moving })
  }
  notes.push(
    `text: one still code page at ${OUT_W}x${OUT_H} painted once and encoded ${frames} times — ` +
      'every lane sees the identical picture, so the only variable is the rate control',
  )
  notes.push(
    `motion: the deterministic moving fixture, ${frames} frames, scored at ordinal ${ordinal} — ` +
      'the same sequence for every lane, and the row that prices a rung with no byte ceiling',
  )

  const lanes: QualityLane[] = []
  const run = async (
    content: { kind: ContentKind; reference: ImageData; source: DeterministicSource },
    mask: ReturnType<typeof chromaMask>,
    id: string,
    codec: string,
    rate: 'bitrate' | number,
  ): Promise<void> => {
    const quantizerMode = rate !== 'bitrate'
    const config: VideoEncoderConfig = {
      codec,
      width: OUT_W,
      height: OUT_H,
      framerate: FPS,
      latencyMode: 'quality',
      // There is no hardware AV1 4:4:4 encoder anywhere; asking for software
      // outright keeps a machine from refusing a config it could satisfy.
      ...(codec.startsWith('av01') ? { hardwareAcceleration: 'prefer-software' as const } : {}),
      // `bitrate` is meaningless in quantizer mode and some Chrome builds
      // reject the pair — constantQuality.ts drops it for the same reason.
      ...(quantizerMode ? { bitrateMode: 'quantizer' as const } : { bitrate: BITRATE }),
    }
    const blank: FileFacts = {
      bytes: 0, durationSec: null, packets: null, keyframes: null, codec: null, achievedMbps: null,
    }
    const noEdge = { chromaFringeMean: NaN } as TextEdgeMetric
    if (!(await accepts(config))) {
      notes.push(`${content.kind}/${id}: this browser refused the config — lane skipped`)
      return
    }
    const t = performance.now()
    const enc = await encodeDeterministic({
      config,
      frames,
      source: content.source,
      paced: false,
      ...(quantizerMode ? { quantizer: rate } : {}),
    })
    const encodeMs = Math.round(performance.now() - t)
    if (!enc.blob) {
      lanes.push({
        id, content: content.kind, codec, rate, file: blank, encodeMs,
        chroma: [], edge: noEdge, db: NaN, error: enc.error ?? 'no file',
      })
      return
    }
    const decoded = await decodeByOrdinal(enc.blob, [ordinal], OUT_W, OUT_H)
    const got = decoded.frames[0]
    if (!got) {
      lanes.push({
        id, content: content.kind, codec, rate, file: await fileFacts(enc.blob), encodeMs,
        chroma: [], edge: noEdge, db: NaN,
        error: `nothing decoded at ordinal ${ordinal} of ${decoded.framesInFile}`,
      })
      return
    }
    lanes.push({
      id,
      content: content.kind,
      codec,
      rate,
      file: await fileFacts(enc.blob),
      encodeMs,
      chroma: chromaRows(mask, got),
      edge: textEdgeMetric(content.reference, got),
      db: comparePatch(content.reference, got, GLYPH_CROP).db,
      error: null,
    })
  }

  for (const content of contents) {
    const mask = chromaMask(content.reference, RECT)
    // The shipped rung, for context — this is what a default export is today.
    await run(content, mask, 'avc-bitrate', AVC_CODEC, 'bitrate')
    for (const qp of avcQps) await run(content, mask, `avc-qp${qp}`, AVC_CODEC, qp)
    // The control: O9(b) exactly as it ships, bitrate-targeted.
    await run(content, mask, 'av1-bitrate', AV1_444_CODEC, 'bitrate')
    for (const q of quantizers) await run(content, mask, `av1-q${q}`, AV1_444_CODEC, q)
  }

  // ---- the gates ---------------------------------------------------------
  const green = (l: QualityLane): number | null =>
    l.chroma.find((c) => c.key === 'green')?.keptPct ?? null
  const at = (content: ContentKind, id: string): QualityLane | null =>
    lanes.find((l) => l.content === content && l.id === id && !l.error) ?? null
  const rungsOn = (content: ContentKind): QualityLane[] =>
    lanes.filter((l) => l.content === content && l.codec === AV1_444_CODEC && l.rate !== 'bitrate' && !l.error)
  const gates: Record<string, { pass: boolean; detail: string }> = {}

  const textRungs = rungsOn('text')
  const motionRungs = rungsOn('motion')
  gates.quantizerModeReached = {
    pass: textRungs.length > 0 && motionRungs.length > 0,
    detail:
      `${textRungs.length}/${quantizers.length} AV1 4:4:4 quantizer rungs encoded and decoded on text, ` +
      `${motionRungs.length}/${quantizers.length} on motion`,
  }

  /**
   * THE COLOUR IS THE POINT OF THE RUNG, so a quality target that costs any of
   * it is not a candidate whatever it saves. Measured on the text page, which
   * is where O9 measured the 77.8 → 99.3 % it shipped on.
   */
  const control = at('text', 'av1-bitrate')
  const controlGreen = control ? green(control) : null
  const controlFringe = control ? control.edge.chromaFringeMean : null
  const qualified = textRungs.filter(
    (l) =>
      controlGreen !== null &&
      controlFringe !== null &&
      (green(l) ?? 0) >= controlGreen - 0.1 &&
      l.edge.chromaFringeMean <= controlFringe + 0.05,
  )
  gates.colourIsNotPaidFor = {
    pass: qualified.length > 0,
    detail:
      controlGreen === null
        ? 'the bitrate control lane did not run — nothing to compare against'
        : qualified.length
          ? `${qualified.map((l) => l.id).join(', ')} keep the control's colour ` +
            `(green >= ${controlGreen} %, fringe <= ${controlFringe})`
          : `NO quantizer rung matches the bitrate control's colour (green ${controlGreen} %, ` +
            `fringe ${controlFringe}) — a quality target would cost the thing O9(b) is for`,
  }

  /**
   * WHAT IT COSTS WHEN THE PICTURE MOVES, priced and not bounded — quantizer
   * mode has NO byte ceiling and that is a ruling (robert (16)). This gate
   * asserts the number EXISTS, and prints it; the trade is the reader's.
   */
  const motionControl = at('motion', 'av1-bitrate')
  const motionRatio = (l: QualityLane): string =>
    motionControl && motionControl.file.bytes > 0
      ? `${Math.round((l.file.bytes / motionControl.file.bytes) * 100) / 100}x`
      : 'n/a'
  gates.motionIsPriced = {
    pass: motionControl !== null && motionRungs.length > 0,
    detail: motionControl
      ? `against the moving fixture's bitrate control (${Math.round(motionControl.file.bytes / 1024)} KB): ` +
        motionRungs.map((l) => `${l.id} ${motionRatio(l)}`).join(', ')
      : 'the moving fixture\'s control did not run — the rung is unpriced on motion',
  }

  /**
   * The rung this rig would pick if it picked: the SMALLEST that costs no
   * colour. It does not pick — constantQuality.ts holds the constant and names
   * this table, exactly as DEFAULT_QP names X15(a)'s.
   */
  const cheapest = qualified.reduce<QualityLane | null>(
    (best, l) => (best === null || l.file.bytes < best.file.bytes ? l : best),
    null,
  )
  const cheapestOnMotion = cheapest ? at('motion', cheapest.id) : null
  gates.aRungToPick = {
    pass: cheapest !== null,
    detail: cheapest
      ? `${cheapest.id}: text green ${green(cheapest)} %, fringe ${cheapest.edge.chromaFringeMean.toFixed(2)}, ` +
        `${Math.round(cheapest.file.bytes / 1024)} KB against the control's ` +
        `${control ? Math.round(control.file.bytes / 1024) : '?'} KB` +
        (cheapestOnMotion ? `; on motion ${Math.round(cheapestOnMotion.file.bytes / 1024)} KB, ${motionRatio(cheapestOnMotion)}` : '')
      : 'no rung to pick',
  }

  const verdict = cheapest
    ? `THE AV1 4:4:4 RUNG TAKES A QUALITY TARGET. ${cheapest.id} keeps every point of colour the ` +
      `bitrate control keeps, on text at ${
        control && control.file.bytes > 0
          ? `${Math.round(((cheapest.file.bytes - control.file.bytes) / control.file.bytes) * 1000) / 10} %`
          : 'n/a'
      } of its size` +
      (cheapestOnMotion ? ` and on motion at ${motionRatio(cheapestOnMotion)} of the moving control` : '') +
      '. THIS RIG DOES NOT SET THE NUMBER — it prints the ladder; the constant is chosen in ' +
      'constantQuality.ts against this table, the way DEFAULT_QP was.'
    : 'NO RUNG QUALIFIED — a quality target would cost colour, and O9(b)\'s rung keeps its bitrate.'

  for (const l of lanes) {
    console.info(
      `[j9] ${l.content.padEnd(7)} ${l.id.padEnd(13)} ${String(Math.round(l.file.bytes / 1024)).padStart(6)} KB  ` +
        `green ${String(green(l) ?? '-').padStart(5)} %  fringe ${
          Number.isFinite(l.edge.chromaFringeMean) ? l.edge.chromaFringeMean.toFixed(2) : '-'
        }  ${Number.isFinite(l.db) ? `${l.db} dB` : '-'}  ${l.encodeMs} ms${l.error ? ` — ${l.error}` : ''}`,
    )
  }

  return { notes, lanes, gates, verdict }
}
