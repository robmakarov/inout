/**
 * EXPERIMENTAL — X15 lane (b): what a "crisp text" capture mode would COST, and
 * a repair of the baseline it has to be priced against.
 *
 * TWO THINGS, and the second one has to come first or the first is priced
 * against a number that is not real.
 *
 * (1) THE O9 STAGE BASELINE IS MEASURED AGAINST THE WRONG PICTURE. O9's
 *     headline — "capture destroys 51 % of glyph edge contrast, the export
 *     preserves it" (chromaFringe 23.2, lumaSmear 68.6, edgeContrastKept 0.49)
 *     — comes from comparing decoded frames at t = 1.0 / 3.5 / 6.0 s against ONE
 *     canvas readback taken AFTER the export finished. bitsAudit's screenLikeSource
 *     scrolls one line every 2.5 s and never repeats, so the reference is at a
 *     different scroll position from every sample it is compared with. The rig's
 *     own comment claims "the frame at 1.0 s and the frame at 1.0 s + 2.5·k are
 *     the same picture apart from the caret", and that is the error: `scroll =
 *     floor(t / 2.5)` is monotonic, not periodic.
 *     The tell was in the published numbers themselves. The EXPORT stage — file
 *     against file, sampled at the same instants, genuinely aligned — reads
 *     lumaSmear 2.4. The CAPTURE stage reads 68.6. A mean luma error of 68 of
 *     255 on every glyph edge is not an encoder; it is a different page.
 *     So this lane measures the capture stage BOTH ways in ONE run: aligned by
 *     ordinal, and deliberately misaligned by exactly one scroll step. If the
 *     misaligned figure lands on O9's, the diagnosis is not an argument.
 *
 * (2) THE 4:4:4 PRICE TAG. Every mode O9 names, probed per ACCELERATION MODE
 *     and all three reported — O9's probe stopped at the first mode that said
 *     yes, so "supported (software)" and "supported in hardware" were the same
 *     row. Then the same deterministic text frames through each supported mode,
 *     for glyph-edge contrast retained and for what it costs to run: bytes, and
 *     throughput measured UNPACED, because VideoEncoder.encode() is asynchronous
 *     and the time spent inside it is not the time the encoder spends.
 *     Whole-browser CPU is the process sampler's to report, one encoder per run:
 *         npm run exp -- x15b '{"only":"av1-high-444"}' --cpu
 *     A lane that shares a browser with six other encoders has no CPU number.
 */
import { newId } from '@core/id'
import { blobStore } from '@core/store'
import { warmRigEncoder } from '../rigWarm'
import { exportRecording } from '@core/compose'
import { defaultEditState } from '@core/timeline'
import type { ChannelRecording, Recording } from '@core/types'
import { textEdgeMetric, type TextEdgeMetric } from '../oracle/textEdge'
import {
  FPS,
  decodeByOrdinal,
  deterministicSource,
  encodeDeterministic,
  fileFacts,
  findOffsetSec,
  mean,
  openNative,
  psnr,
  recordDeterministic,
  GLYPH_CROP,
  magnify,
  type Crop,
  type FileFacts,
  type Rect,
} from './textSource'

const W = 1920
const H = 1080
const BITRATE = 8_000_000
/** One scroll step of the text source, in frames — see the header. */
const SCROLL_FRAMES = 2.5 * FPS

/** O9's candidate list, unchanged, so the two tables are comparable row by row. */
const CANDIDATES: { id: string; note: string; config: VideoEncoderConfig }[] = [
  {
    id: 'avc-420-shipped',
    note: 'what ships today: AVC High, 4:2:0, 8 Mbps',
    config: { codec: 'avc1.640028', width: W, height: H, bitrate: BITRATE, framerate: FPS },
  },
  {
    id: 'avc-420-24mbps',
    note: 'CONTROL: same codec, 3× the bits. Separates "needs bits" from "needs chroma"',
    config: { codec: 'avc1.640028', width: W, height: H, bitrate: 24_000_000, framerate: FPS },
  },
  {
    id: 'avc-444',
    note: 'O9(a): AVC High 4:4:4 Predictive',
    config: { codec: 'avc1.f40028', width: W, height: H, bitrate: BITRATE, framerate: FPS },
  },
  {
    id: 'vp9-profile0',
    note: 'VP9 4:2:0 — the codec the shipped raw channel writes',
    config: { codec: 'vp09.00.10.08', width: W, height: H, bitrate: BITRATE, framerate: FPS },
  },
  {
    id: 'vp9-profile1-444',
    note: 'O9(a): VP9 profile 1 is 4:4:4',
    config: { codec: 'vp09.01.10.08', width: W, height: H, bitrate: BITRATE, framerate: FPS },
  },
  {
    id: 'av1-main',
    note: 'O9(b): AV1 main',
    config: { codec: 'av01.0.08M.08', width: W, height: H, bitrate: BITRATE, framerate: FPS },
  },
  {
    id: 'av1-high-444',
    note: 'O9(b): AV1 profile 1 is 4:4:4 — O9 recommends this for the EXPORT',
    config: { codec: 'av01.1.08M.08', width: W, height: H, bitrate: BITRATE, framerate: FPS },
  },
]

const ACCEL_MODES = ['prefer-hardware', 'no-preference', 'prefer-software'] as const

export interface ModeSupport {
  mode: (typeof ACCEL_MODES)[number]
  supported: boolean
  reason: string | null
}

export interface CandidateSupport {
  id: string
  note: string
  codec: string
  /** ALL THREE modes, not the first that said yes. */
  modes: ModeSupport[]
  /** True only if 'prefer-hardware' itself said yes. */
  hardware: boolean
  usableMode: (typeof ACCEL_MODES)[number] | null
}

export interface CodecPriceRow {
  id: string
  note: string
  codec: string
  mode: (typeof ACCEL_MODES)[number] | null
  bytes: number
  bytesPerFrame: number
  file: FileFacts | null
  /** Unpaced: frames / wall seconds. What the mode costs to RUN. */
  throughputFps: number | null
  psnrVsSourceDb: number | null
  metric: TextEdgeMetric | null
  error: string | null
}

export interface StageRow {
  /** canvas → the raw MediaRecorder channel: what CAPTURE's encoder did. */
  capture: TextEdgeMetric | null
  /** the SAME comparison with the reference one scroll step out — O9's fault, reproduced. */
  captureMisaligned: TextEdgeMetric | null
  /** raw channel → exported file, both sampled at the same instants. */
  export: TextEdgeMetric | null
  /** canvas → exported file. */
  total: TextEdgeMetric | null
  channelBytes: number
  exportBytes: number
  framesInChannel: number
  framesPushed: number
  /** Where the render placed the channel, measured. 0 = where it was assumed. */
  exportOffsetSec: number
  exportFile: FileFacts | null
  channelFile: FileFacts | null
}

export interface X15ChromaReport {
  notes: string[]
  support: CandidateSupport[]
  codecs: CodecPriceRow[]
  stages: StageRow | null
  /** Robert-visible artifacts, magnified glyph crops. Only with {"crops":true}. */
  crops: Crop[]
  gates: Record<string, { pass: boolean; detail: string }>
  verdict: string
}

async function probeSupport(): Promise<CandidateSupport[]> {
  const out: CandidateSupport[] = []
  for (const c of CANDIDATES) {
    const modes: ModeSupport[] = []
    for (const mode of ACCEL_MODES) {
      let supported = false
      let reason: string | null = null
      try {
        const r = await VideoEncoder.isConfigSupported({ ...c.config, hardwareAcceleration: mode })
        supported = !!r.supported
        if (!supported) reason = 'isConfigSupported returned false'
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err)
      }
      modes.push({ mode, supported, reason })
    }
    out.push({
      id: c.id,
      note: c.note,
      codec: c.config.codec,
      modes,
      hardware: modes.find((m) => m.mode === 'prefer-hardware')?.supported ?? false,
      usableMode: modes.find((m) => m.supported)?.mode ?? null,
    })
  }
  return out
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

/**
 * The O9 chain, with a reference that is actually the picture that was encoded.
 *
 * The three stages need two different alignments and that is not a shortcut:
 * CAPTURE spans canvas → file, where only the ordinal is meaningful (the file's
 * timestamps are wall clock and the canvas has none); EXPORT spans file → file
 * on ONE timeline, where the timestamp is exactly right. TOTAL is the bridge —
 * the ordinal picks the channel frame, the channel frame's own timestamp picks
 * the export frame, and the canvas reference is the ordinal's.
 */
async function measureStages(takeSec: number): Promise<StageRow | null> {
  const frames = Math.round(takeSec * FPS)
  const source = deterministicSource('text', W, H)
  const rec = await recordDeterministic({ source, frames, bitrate: BITRATE })
  if (!rec.blob) return null

  const blobKey = `exp-x15b-${newId('src')}.webm`
  const writer = (await blobStore.createWriteStream(blobKey)).getWriter()
  await writer.write(rec.blob)
  await writer.close()

  try {
    const ordinals = [Math.round(frames * 0.25), Math.round(frames * 0.55), Math.round(frames * 0.85)]
    const decoded = await decodeByOrdinal(rec.blob, ordinals, W, H)

    // THE CHANNEL'S LENGTH IS THE FILE'S, NOT THE FRAME COUNT'S. The first
    // version of this computed frames/30 and was 600 ms short, because the
    // pacing loop is a setTimeout and 180 frames take 6.6 s rather than 6.0 —
    // and a recording that declares less than its file holds makes the render
    // place the picture somewhere the channel's own timestamps do not predict
    // (measured: 0.967 s). Production reads this from the take; a rig that
    // makes it up gets to debug its own arithmetic as if it were the product's.
    const channelFile = await fileFacts(rec.blob)
    const channel: ChannelRecording = {
      id: newId('ch'),
      kind: 'screen',
      media: 'video',
      mimeType: rec.mimeType,
      blobKey,
      startOffsetMs: 0,
      durationMs: Math.round((channelFile.durationSec ?? decoded.framesInFile / FPS) * 1000),
      width: W,
      height: H,
    }
    const recording: Recording = {
      id: newId('rec'),
      createdAt: Date.now(),
      durationMs: channel.durationMs,
      channels: [channel],
    }
    const exported = await exportRecording({
      recording,
      edit: defaultEditState(recording),
      settings: { width: W, height: H, fps: FPS, videoBitrate: BITRATE },
    })

    // THE EXPORT IS PLACED, NOT INDEXED. The channel's own timestamps are wall
    // clock (MediaRecorder stamps them), and the render puts that channel on
    // its own grid — so "the same instant" in the two files is a measured
    // quantity, not an assumption. The first run of this rig assumed it and
    // read the export stage at smear 47.2 with the exact fingerprint of a
    // scroll-step mismatch: the same fault this lane exists to expose in O9.
    const reader = await openNative(exported.blob)
    const whole: Rect = { x: 0, y: 0, w: W, h: H }
    const anchor = decoded.frames[0]
    const anchorT = decoded.times[0] ?? 0
    // ±1 s, and no wider: this content holds still for 2.5 s at a time, so a
    // search over a span approaching that is ill-conditioned — every candidate
    // inside one scroll interval is the same page, and the winner is decided by
    // a blinking caret. The span is a diagnostic for a placement bug, not a
    // licence to align anything to anything.
    const found =
      reader && anchor ? await findOffsetSec(anchor, reader, anchorT, whole, { spanSec: 1 }) : null
    const exportOffsetSec = found?.offsetSec ?? 0
    const exportFrames: (ImageData | null)[] = []
    for (const t of decoded.times) {
      exportFrames.push(reader ? await reader.at((t ?? 0) + exportOffsetSec) : null)
    }
    reader?.close()

    const capture: TextEdgeMetric[] = []
    const misaligned: TextEdgeMetric[] = []
    const exportStage: TextEdgeMetric[] = []
    const total: TextEdgeMetric[] = []
    for (let i = 0; i < ordinals.length; i++) {
      const k = ordinals[i]!
      const ch = decoded.frames[i]
      const ex = exportFrames[i]
      if (ch) {
        capture.push(textEdgeMetric(source.frame(k), ch))
        // O9's error, reproduced on purpose: the reference one scroll step off.
        misaligned.push(textEdgeMetric(source.frame(k + SCROLL_FRAMES), ch))
      }
      if (ch && ex) exportStage.push(textEdgeMetric(ch, ex))
      if (ex) total.push(textEdgeMetric(source.frame(k), ex))
    }

    return {
      capture: meanEdge(capture),
      captureMisaligned: meanEdge(misaligned),
      export: meanEdge(exportStage),
      total: meanEdge(total),
      channelBytes: rec.blob.size,
      exportBytes: exported.blob.size,
      framesInChannel: decoded.framesInFile,
      framesPushed: frames,
      exportOffsetSec: Math.round(exportOffsetSec * 1000) / 1000,
      exportFile: await fileFacts(exported.blob),
      channelFile,
    }
  } finally {
    await blobStore.remove(blobKey).catch(() => undefined)
  }
}

export async function runChromaPrice(
  opts: { takeSec?: number; only?: string; repeats?: number; crops?: boolean } = {},
): Promise<X15ChromaReport> {
  const takeSec = opts.takeSec ?? 6
  const frames = Math.round(takeSec * FPS)
  const notes: string[] = []
  const support = await probeSupport()

  const source = deterministicSource('text', W, H)
  const ordinals = [Math.round(frames * 0.25), Math.round(frames * 0.55), Math.round(frames * 0.85)]

  const wanted = opts.only ? CANDIDATES.filter((c) => c.id === opts.only) : CANDIDATES
  if (opts.only && !wanted.length) {
    notes.push(`no candidate named "${opts.only}" — ids are: ${CANDIDATES.map((c) => c.id).join(', ')}`)
  }
  // NOTE 6, AGAIN: a fresh process's first VideoEncoder pays a multi-second
  // init, and every one of these lanes fits inside it. Warm before measuring,
  // and run each lane twice — the first pass is the warm for THAT codec, and
  // the best of the two is the reading (X5's rig error (b): the host drifts
  // monotonically inside a run, so a mean measures when a lane happened to go).
  await warmRigEncoder()
  const repeats = opts.only ? (opts.repeats ?? 3) : 2
  if (opts.only) {
    notes.push(
      `CPU LANE: only "${opts.only}" runs, ${repeats}× so the process sampler has a window it can attribute. Run the same command per codec and compare — a browser that encoded seven codecs has no per-codec CPU number.`,
    )
  }

  const codecs: CodecPriceRow[] = []
  const crops: Crop[] = []
  if (opts.crops) {
    crops.push({ label: 'b-00-SOURCE-canvas', png: await magnify(source.frame(ordinals[0]!), GLYPH_CROP) })
  }
  for (const cand of wanted) {
    const sup = support.find((s) => s.id === cand.id)
    if (!sup?.usableMode) {
      codecs.push({
        id: cand.id,
        note: cand.note,
        codec: cand.config.codec,
        mode: null,
        bytes: 0,
        bytesPerFrame: 0,
        file: null,
        throughputFps: null,
        psnrVsSourceDb: null,
        metric: null,
        error: 'unsupported in every acceleration mode',
      })
      continue
    }
    let last: Awaited<ReturnType<typeof encodeDeterministic>> | null = null
    const fps: number[] = []
    for (let r = 0; r < repeats; r++) {
      last = await encodeDeterministic({
        config: { ...cand.config, hardwareAcceleration: sup.usableMode },
        frames,
        source,
        paced: false,
      })
      if (last.throughputFps !== null) fps.push(last.throughputFps)
    }
    if (!last?.blob) {
      codecs.push({
        id: cand.id,
        note: cand.note,
        codec: cand.config.codec,
        mode: sup.usableMode,
        bytes: 0,
        bytesPerFrame: 0,
        file: null,
        throughputFps: mean(fps),
        psnrVsSourceDb: null,
        metric: null,
        error: last?.error ?? 'no output',
      })
      continue
    }
    const file = await fileFacts(last.blob)
    const d = await decodeByOrdinal(last.blob, ordinals, W, H)
    const ps: number[] = []
    const es: TextEdgeMetric[] = []
    for (let i = 0; i < ordinals.length; i++) {
      const dec = d.frames[i]
      if (!dec) continue
      const ref = source.frame(ordinals[i]!)
      ps.push(psnr(ref, dec))
      es.push(textEdgeMetric(ref, dec))
    }
    if (opts.crops && d.frames[0]) {
      crops.push({ label: `b-01-${cand.id}`, png: await magnify(d.frames[0]!, GLYPH_CROP) })
    }
    codecs.push({
      id: cand.id,
      note: cand.note,
      codec: cand.config.codec,
      mode: sup.usableMode,
      bytes: last.blob.size,
      bytesPerFrame: Math.round(last.blob.size / frames),
      file,
      // BEST of the repeats, not the mean: the host drifts monotonically inside
      // a run (X5's rig error (b)), so a mean is a measurement of when a lane
      // happened to run.
      throughputFps: fps.length ? Math.max(...fps) : null,
      psnrVsSourceDb: mean(ps),
      metric: meanEdge(es),
      error: es.length ? null : 'nothing decoded back',
    })
  }

  const stages = opts.only ? null : await measureStages(takeSec)

  const gates: X15ChromaReport['gates'] = {}
  const shipped = codecs.find((c) => c.id === 'avc-420-shipped')
  const av1444 = codecs.find((c) => c.id === 'av1-high-444')

  gates['4:4:4 in HARDWARE exists on this machine'] = {
    pass: support.some((s) => s.id.includes('444') && s.hardware),
    detail: support
      .filter((s) => s.id.includes('444'))
      .map((s) => `${s.id}: ${s.modes.map((m) => `${m.mode}=${m.supported ? 'yes' : 'no'}`).join(' ')}`)
      .join(' · '),
  }
  if (shipped && av1444?.metric && shipped.metric) {
    gates['a 4:4:4 mode retains more glyph-edge colour than what ships'] = {
      pass: av1444.metric.chromaFringeMean < shipped.metric.chromaFringeMean,
      detail: `AV1 4:4:4 fringe ${av1444.metric.chromaFringeMean} against the shipped AVC 4:2:0 ${shipped.metric.chromaFringeMean}, contrast ${av1444.metric.edgeContrastKept} vs ${shipped.metric.edgeContrastKept}`,
    }
    gates['…and what it costs to RUN, which is the half O9 did not price'] = {
      pass: (av1444.throughputFps ?? 0) >= FPS,
      detail: `AV1 4:4:4 ${av1444.throughputFps ?? 'n/a'} fps (${av1444.mode}) against the shipped AVC ${shipped.throughputFps ?? 'n/a'} fps (${shipped.mode}) — unpaced, 1080p. Below ${FPS} fps it cannot keep up with capture at all.`,
    }
  }
  if (stages) {
    gates['THE O9 CAPTURE-STAGE BASELINE, re-measured against the right picture'] = {
      // The published figure is what this is checking, so "pass" means the
      // aligned number is NOT the published one — i.e. the fault is real.
      pass:
        !!stages.capture &&
        !!stages.captureMisaligned &&
        stages.capture.lumaSmearMean < stages.captureMisaligned.lumaSmearMean / 2,
      detail:
        `aligned: fringe ${stages.capture?.chromaFringeMean} · smear ${stages.capture?.lumaSmearMean} · contrast ${stages.capture?.edgeContrastKept}   ‖   ` +
        `one scroll step out (O9's method): fringe ${stages.captureMisaligned?.chromaFringeMean} · smear ${stages.captureMisaligned?.lumaSmearMean} · contrast ${stages.captureMisaligned?.edgeContrastKept}   ‖   ` +
        `O9 PUBLISHED: fringe 23.2 · smear 68.6 · contrast 0.49`,
    }
    gates['the channel holds every picture that was pushed into it'] = {
      pass: stages.framesInChannel === stages.framesPushed,
      detail: `${stages.framesInChannel} of ${stages.framesPushed} — ordinals are only meaningful when these agree`,
    }
    // NOT A PASS/FAIL, AND SAYING SO IS THE POINT. The search that aligns the
    // export to the channel runs on a page that holds still for 2.5 s at a
    // time, so every candidate inside one scroll interval is the same picture
    // and the winner is decided by a blinking caret — it saturates at the edge
    // of its own span. The stage metrics are unaffected (a same-page frame IS
    // the right reference for a glyph statistic); the OFFSET is simply not
    // something this fixture can measure, and a gate that pretended otherwise
    // would have read FAIL and been quoted as a placement bug. X15(c) measures
    // placement properly, on a region that moves.
    gates['export alignment: DIAGNOSTIC ONLY (this fixture cannot localise it)'] = {
      pass: true,
      detail:
        `search settled at ${stages.exportOffsetSec} s${Math.abs(stages.exportOffsetSec) >= 0.95 ? ' — SATURATED at the span edge, i.e. ambiguous' : ''}` +
        ` · channel ${stages.channelFile?.durationSec} s / ${stages.channelFile?.packets} packets · export ${stages.exportFile?.durationSec} s / ${stages.exportFile?.packets} packets` +
        ` · the stage metrics stand regardless: within one scroll interval every candidate is the same page`,
    }
  }

  notes.push(
    'support is reported for ALL THREE acceleration modes per candidate: O9 stopped at the first mode that said yes, so "software only" and "hardware" were indistinguishable in its table',
  )
  notes.push(
    'throughput is measured UNPACED with back-pressure at a queue of 8: VideoEncoder.encode() is asynchronous, so time spent inside it is enqueue cost and not encoder cost',
  )
  notes.push(
    'whole-browser CPU is the process sampler’s: `npm run exp -- x15b \'{"only":"<id>"}\' --cpu`, once per codec',
  )

  return { notes, support, codecs, stages, crops, gates, verdict: verdictOf(codecs, stages, support) }
}

function verdictOf(
  codecs: CodecPriceRow[],
  stages: StageRow | null,
  support: CandidateSupport[],
): string {
  const parts: string[] = []
  const hw444 = support.filter((s) => s.id.includes('444') && s.hardware).map((s) => s.id)
  parts.push(
    hw444.length
      ? `4:4:4 IN HARDWARE: ${hw444.join(', ')}.`
      : '4:4:4 IN HARDWARE: none. Every 4:4:4 mode this machine accepts is software, which is the CPU cost X6 exists to remove.',
  )
  const shipped = codecs.find((c) => c.id === 'avc-420-shipped')
  const av1 = codecs.find((c) => c.id === 'av1-high-444')
  if (shipped?.metric && av1?.metric) {
    parts.push(
      `THE PRICE: AV1 4:4:4 takes glyph fringe from ${shipped.metric.chromaFringeMean} to ${av1.metric.chromaFringeMean} at ${av1.bytesPerFrame} B/frame against ${shipped.bytesPerFrame}, and runs at ${av1.throughputFps} fps against ${shipped.throughputFps} on 1080p.`,
    )
  }
  if (stages?.capture && stages.captureMisaligned) {
    const fault = stages.capture.lumaSmearMean < stages.captureMisaligned.lumaSmearMean / 2
    parts.push(
      fault
        ? `AND THE BASELINE MOVED. Measured against the picture that was actually encoded, the capture stage costs fringe ${stages.capture.chromaFringeMean} · smear ${stages.capture.lumaSmearMean} · contrast ${stages.capture.edgeContrastKept} — not O9's 23.2 / 68.6 / 0.49. Shifting the reference by ONE SCROLL STEP, which is what O9's rig did, reproduces ${stages.captureMisaligned.chromaFringeMean} / ${stages.captureMisaligned.lumaSmearMean} / ${stages.captureMisaligned.edgeContrastKept}. "Capture destroys 51 % of glyph edge contrast" is a measurement of a scroll position.`
        : `The O9 capture-stage figure survives re-measurement against the aligned reference (${stages.capture.chromaFringeMean} / ${stages.capture.lumaSmearMean} / ${stages.capture.edgeContrastKept}).`,
    )
  }
  return parts.join(' ')
}
