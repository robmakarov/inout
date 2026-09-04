/**
 * EXPERIMENTAL — J7: THE SHORT-EDIT FLOOR.
 *
 * Robert 2026-09-04: "we must make easy short edits faster anyway, despite we
 * have huge ones". Every render-speed number this repo owns is THROUGHPUT —
 * frames per second, and a long take is where it is read. What a thirty-second
 * edit feels is the part that does not move when the take gets shorter: the
 * ceremony before the first frame and after the last one.
 *
 * The rig measures it the only way a floor can be measured — the SAME edit at
 * several take lengths, so the fixed part falls out as the intercept instead of
 * being asserted. Four lanes per length, all through production code:
 *
 *   cold     chunk cache empty, one zoom span → renderChunked (the first press)
 *   tweak    the zoom nudged, so only the chunks it touches are stale (J1's case)
 *   warm     the same edit again, every chunk already on disk — THE FLOOR J5
 *            CANNOT HIDE: nothing renders and the press still costs what it costs
 *   unbroken the same edit through renderExport (the runtime fallback path)
 *
 * Reads the J7 sub-stage split added to RenderStats (`prep.*`, `publishMs`) and
 * to ChunkedRenderStats (`planMs`, `muxOpenMs`, `publishMs`), so the answer is
 * not "prepare is 40 %" but which of the suspects it actually is.
 *
 *   node scripts/exp.mjs j7 --timeout=3600
 *   node scripts/exp.mjs j7 '{"lengthsSec":[10,30],"coldRuns":1}' --timeout=1800
 *
 * Fixture is R2's builder (nativeRender.ts), the same one chunkRender.ts uses:
 * a manufactured take costs nothing to record and is identical run to run.
 */
import { blobStore } from '@core/store'
import { defaultEditState } from '@core/timeline'
import {
  describePlan,
  getLastChunkedStats,
  renderChunked,
  type ChunkedRenderStats,
} from '@core/compose/chunkedRender'
import { CHUNK_PART_PREFIX, CHUNK_PREFIX } from '@core/compose/chunkStore'
import { getLastRenderStats, renderExport, type RenderStats } from '@core/compose/render'
import { settingsForTier, tierById, type QualityTierId } from '@core/compose/quality'
import { newId } from '@core/id'
import type { EditState, ExportResult, Recording } from '@core/types'
import { buildAudioFile, buildChannelFile, channel, existingFixture, fixtureKey } from './nativeRender'

export interface ShortEditFloorOptions {
  /** Take lengths, seconds. Three points is the minimum for an honest fit. */
  lengthsSec?: number[]
  sourceW?: number
  sourceH?: number
  sourceFps?: number
  sourceMbps?: number
  output?: QualityTierId
  audioChannels?: number
  /** Repeats per lane. The cheap lanes get more because variance is the enemy. */
  coldRuns?: number
  tweakRuns?: number
  warmRuns?: number
  unbrokenRuns?: number
  rebuild?: boolean
  buildBudgetSec?: number
  /**
   * THE ONE LEVER THE FLOOR POINTS AT. The chunk grid IS the output's keyframe
   * interval (the concatenation copies packets, so a chunk must start on a
   * keyframe), and it decides how much output a small edit re-renders: at 5 s
   * a nudged keyframe costs 5 s of encoding whatever it actually touched.
   * Sweeping it prices the trade — seconds saved against bytes added — instead
   * of arguing it. `[]` skips the sweep.
   */
  gridsSec?: number[]
  /** The take the sweep runs on. One length: this is a trade, not a matrix. */
  gridLengthSec?: number
}

const r1 = (n: number): number => Math.round(n * 10) / 10

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/** Least squares on (x,y) — slope is per-second cost, intercept is the floor. */
function fit(points: { x: number; y: number }[]): { slope: number; intercept: number } {
  const n = points.length
  if (n < 2) return { slope: 0, intercept: points[0]?.y ?? 0 }
  const mx = points.reduce((a, p) => a + p.x, 0) / n
  const my = points.reduce((a, p) => a + p.y, 0) / n
  let num = 0
  let den = 0
  for (const p of points) {
    num += (p.x - mx) * (p.y - my)
    den += (p.x - mx) ** 2
  }
  const slope = den === 0 ? 0 : num / den
  return { slope, intercept: my - slope * mx }
}

async function clearChunks(): Promise<void> {
  for (const f of await blobStore.list()) {
    if (f.key.startsWith(CHUNK_PREFIX) || f.key.startsWith(CHUNK_PART_PREFIX)) {
      await blobStore.remove(f.key).catch(() => undefined)
    }
  }
}

/** One zoom span. `shiftMs` moves it so a different pair of chunks goes stale. */
function withZoomAt(edit: EditState, atMs: number): EditState {
  const whole = { xFrac: 0.5, yFrac: 0.5, widthFrac: 1 }
  return {
    ...edit,
    viewport: {
      keyframes: [
        { ...whole, atMs: Math.max(0, atMs - 2000) },
        { xFrac: 0.45, yFrac: 0.45, widthFrac: 0.5, atMs },
        { xFrac: 0.45, yFrac: 0.45, widthFrac: 0.5, atMs: atMs + 1000 },
        { ...whole, atMs: atMs + 3000 },
      ],
    },
  }
}

/** The same zoom, `steps` × 400 ms further along — a fresh small edit. */
function nudged(edit: EditState, zoomAtMs: number, steps: number): EditState {
  return withZoomAt(edit, zoomAtMs + steps * 400)
}

/** What one export cost, split into work and ceremony. Every field is ms. */
interface Sample {
  wallMs: number
  /** Chunked path only. */
  planMs: number
  muxOpenMs: number
  concatMs: number
  concatPublishMs: number
  chunksRendered: number
  chunksReused: number
  /** The moving parts, so an unexplained wall clock cannot hide behind "fixed". */
  decodeMs: number
  drawMs: number
  encodeMs: number
  audioMs: number
  /** Summed across every renderExport this export ran (1 for the unbroken lane). */
  prepareMs: number
  finalizeMs: number
  publishMs: number
  open: number
  probe: number
  target: number
  cq: number
  colour: number
  scratch: number
  start: number
  probeDecodes: number
  frames: number
  /** The produced file. The price of any grid that re-renders less. */
  bytes: number
}

function sampleFrom(wallMs: number, rs: RenderStats | null, cs: ChunkedRenderStats | null): Sample {
  const p = rs?.prep
  return {
    wallMs,
    planMs: cs?.planMs ?? 0,
    muxOpenMs: cs?.muxOpenMs ?? 0,
    concatMs: cs?.concatMs ?? 0,
    concatPublishMs: cs?.publishMs ?? 0,
    chunksRendered: cs?.rendered ?? (rs ? 1 : 0),
    chunksReused: cs?.reused ?? 0,
    decodeMs: rs?.decodeMs ?? 0,
    drawMs: rs?.drawMs ?? 0,
    encodeMs: rs?.encodeMs ?? 0,
    audioMs: rs?.audioMs ?? 0,
    prepareMs: rs?.prepareMs ?? 0,
    finalizeMs: rs?.finalizeMs ?? 0,
    publishMs: rs?.publishMs ?? 0,
    open: p?.open ?? 0,
    probe: p?.probe ?? 0,
    target: p?.target ?? 0,
    cq: p?.cq ?? 0,
    colour: p?.colour ?? 0,
    scratch: p?.scratch ?? 0,
    start: p?.start ?? 0,
    probeDecodes: rs?.probeDecodes ?? 0,
    frames: rs?.frames ?? 0,
    bytes: 0,
  }
}

/** Median of every field across repeats — one number per stage, not a cloud. */
function medianSample(samples: Sample[]): Sample {
  const keys = Object.keys(samples[0] ?? {}) as (keyof Sample)[]
  const out = {} as Sample
  for (const k of keys) out[k] = r1(median(samples.map((s) => s[k])))
  return out
}

export interface LaneReport {
  lane: string
  what: string
  runs: number
  /** Median across repeats. */
  median: Sample
  wallMsEach: number[]
  /** Everything in this export that is NOT drawing or encoding frames. */
  fixedMs: number
  fixedPct: number
  error: string | null
}

export interface LengthReport {
  takeSec: number
  chunks: number
  lanes: LaneReport[]
}

/** One chunk grid, priced: what a small edit costs and what the file costs. */
export interface GridReport {
  gridSec: number
  chunks: number
  coldMs: number
  tweakMs: number
  warmMs: number
  bytes: number
  /** Ceremony (prepare+finalize+publish over every chunk file) in the cold lane. */
  coldCeremonyMs: number
  error: string | null
}

export interface ShortEditFloorReport {
  source: { width: number; height: number; fps: number; mbps: number; lengths: number[] }
  output: { step: QualityTierId; width: number; height: number; fps: number; gopSec: number }
  lengths: LengthReport[]
  grid: GridReport[]
  lengths_note?: string
  floor: Record<string, string>
  suspects: Record<string, string>
  verdict: Record<string, string>
  notes: string[]
}

export async function runShortEditFloor(
  opts: ShortEditFloorOptions = {},
): Promise<ShortEditFloorReport> {
  const lengths = (opts.lengthsSec ?? [10, 30, 60]).map((n) => Math.max(4, Math.round(n)))
  const sourceW = opts.sourceW ?? 1920
  const sourceH = opts.sourceH ?? 1080
  const sourceFps = opts.sourceFps ?? 30
  const mbps = opts.sourceMbps ?? 12
  const step = opts.output ?? '1080p'
  const coldRuns = Math.max(1, opts.coldRuns ?? 2)
  const tweakRuns = Math.max(1, opts.tweakRuns ?? 2)
  const warmRuns = Math.max(1, opts.warmRuns ?? 5)
  const unbrokenRuns = Math.max(1, opts.unbrokenRuns ?? 1)
  const wantAudio = Math.max(0, Math.min(2, Math.round(opts.audioChannels ?? 2)))
  const gridsSec = opts.gridsSec ?? [5, 2.5, 1]
  const gridLengthSec = Math.max(4, Math.round(opts.gridLengthSec ?? 30))
  const notes: string[] = []
  const grid: GridReport[] = []
  const perLength: LengthReport[] = []
  let outMeta = { step, width: 0, height: 0, fps: 0, gopSec: 0 }

  /** One manufactured take of `takeSec`, cached between runs and between lengths. */
  const makeTake = async (takeSec: number): Promise<Recording> => {
    const key = fixtureKey(sourceW, sourceH, sourceFps, takeSec, mbps)
    let frames = Math.round(takeSec * sourceFps)
    if (!opts.rebuild && (await existingFixture(key)) !== null) {
      notes.push(`${takeSec}s: reusing cached fixture ${key}`)
    } else {
      await blobStore.remove(key).catch(() => undefined)
      const built = await buildChannelFile({
        key,
        width: sourceW,
        height: sourceH,
        fps: sourceFps,
        seconds: takeSec,
        mbps,
        budgetSec: opts.buildBudgetSec ?? 1800,
        label: 'screen',
      })
      frames = built.frames
    }
    const sourceBlob = await blobStore.read(key)
    const actualSec = frames / sourceFps
    const durationMs = Math.round(actualSec * 1000)
    const channels: Recording['channels'] = [
      channel('screen', key, sourceW, sourceH, sourceFps, durationMs, sourceBlob.size),
    ]
    for (let i = 0; i < wantAudio; i++) {
      const aKey = `r2aud-v1-${Math.round(actualSec)}s-${i}`
      let size = 0
      if (opts.rebuild || (await existingFixture(aKey)) === null) {
        await blobStore.remove(aKey).catch(() => undefined)
        size = await buildAudioFile(aKey, actualSec)
      } else {
        size = (await blobStore.read(aKey)).size
      }
      channels.push({
        id: newId('ch'),
        kind: i === 0 ? 'mic' : 'system-audio',
        media: 'audio',
        mimeType: 'audio/webm;codecs=opus',
        blobKey: aKey,
        startOffsetMs: 0,
        durationMs,
        bytes: size,
      })
    }
    return { id: newId('rec'), createdAt: Date.now(), durationMs, channels }
  }

  const laneOf = async (
    lane: string,
    what: string,
    runs: number,
    chunked: boolean,
    before: (() => Promise<void>) | null,
    run: (runIndex: number) => Promise<ExportResult>,
  ): Promise<LaneReport> => {
    const samples: Sample[] = []
    const wallMsEach: number[] = []
    let error: string | null = null
    for (let i = 0; i < runs; i++) {
      try {
        if (before) await before()
        const t0 = performance.now()
        const result = await run(i)
        const wall = performance.now() - t0
        wallMsEach.push(r1(wall))
        // The chunked stats are a module-level LAST, so the unbroken lane
        // would otherwise report the warm lane's concatenation as its own.
        const s = sampleFrom(wall, getLastRenderStats(), chunked ? getLastChunkedStats() : null)
        s.bytes = result.blob.size
        samples.push(s)
      } catch (err) {
        error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        break
      }
    }
    const med = medianSample(samples)
    // FIXED = everything that is not drawing or encoding frames. Named this
    // way deliberately: it is the part a longer take does not make cheaper.
    const fixed =
      med.prepareMs +
      med.finalizeMs +
      med.publishMs +
      med.planMs +
      med.concatMs +
      med.concatPublishMs
    return {
      lane,
      what,
      runs: samples.length,
      median: med,
      wallMsEach,
      fixedMs: r1(fixed),
      fixedPct: med.wallMs > 0 ? Math.round((100 * fixed) / med.wallMs) : 0,
      error,
    }
  }

  for (const takeSec of lengths) {
    const recording = await makeTake(takeSec)
    const durationMs = recording.durationMs
    const actualSec = durationMs / 1000
    const settings = settingsForTier(tierById(step), recording)
    const baseEdit = defaultEditState(recording)
    const plan = describePlan({ recording, edit: baseEdit, settings })
    outMeta = {
      step,
      width: settings.width,
      height: settings.height,
      fps: settings.fps,
      gopSec: plan.gopSec,
    }
    // The zoom sits in the middle so the tweak below can move it without
    // running off either end of a short take.
    const zoomAt = Math.round(durationMs * 0.5)
    const zoomEdit = withZoomAt(baseEdit, zoomAt)

    const lanes: LaneReport[] = []
    lanes.push(
      await laneOf('cold', 'chunk cache empty, one zoom span', coldRuns, true, clearChunks, () =>
        renderChunked({ recording, edit: zoomEdit, settings }),
      ),
    )
    // The cache now holds the cold export's chunks; each tweak nudges the zoom
    // 400 ms further, which is a DIFFERENT edit every run — the first version
    // of this lane re-pressed the identical edit and its second run was a pure
    // cache hit, so the median said 1267 ms for something that was half 2510
    // and half 25. This is the "easy short edit": a hand moved a keyframe.
    lanes.push(
      await laneOf('tweak', 'the zoom nudged 400 ms — a different edit each run', tweakRuns, true, null, (i) =>
        renderChunked({ recording, edit: nudged(baseEdit, zoomAt, i + 1), settings }),
      ),
    )
    lanes.push(
      await laneOf('warm', 'the last tweak pressed again, nothing to render', warmRuns, true, null, () =>
        renderChunked({ recording, edit: nudged(baseEdit, zoomAt, tweakRuns), settings }),
      ),
    )
    lanes.push(
      await laneOf('unbroken', 'the same edit through renderExport', unbrokenRuns, false, null, () =>
        renderExport({ recording, edit: nudged(baseEdit, zoomAt, tweakRuns), settings }),
      ),
    )
    await clearChunks()
    perLength.push({ takeSec: Math.round(actualSec), chunks: plan.chunks.length, lanes })
  }

  // ---- what a finer grid buys, and what it costs ------------------------
  if (gridsSec.length) {
    const recording = await makeTake(gridLengthSec)
    const base = settingsForTier(tierById(step), recording)
    const baseEdit = defaultEditState(recording)
    const zoomAt = Math.round(recording.durationMs * 0.5)
    for (const gridSec of gridsSec) {
      const settings = { ...base, keyFrameIntervalSec: gridSec }
      const plan = describePlan({ recording, edit: baseEdit, settings })
      const cold = await laneOf('cold', `grid ${gridSec}s`, 1, true, clearChunks, () =>
        renderChunked({ recording, edit: withZoomAt(baseEdit, zoomAt), settings }),
      )
      const tweak = await laneOf('tweak', `grid ${gridSec}s`, 2, true, null, (i) =>
        renderChunked({ recording, edit: nudged(baseEdit, zoomAt, i + 1), settings }),
      )
      const warm = await laneOf('warm', `grid ${gridSec}s`, 3, true, null, () =>
        renderChunked({ recording, edit: nudged(baseEdit, zoomAt, 2), settings }),
      )
      grid.push({
        gridSec,
        chunks: plan.chunks.length,
        coldMs: cold.median.wallMs,
        tweakMs: tweak.median.wallMs,
        warmMs: warm.median.wallMs,
        bytes: cold.median.bytes,
        coldCeremonyMs: r1(
          cold.median.prepareMs + cold.median.finalizeMs + cold.median.publishMs,
        ),
        error: cold.error ?? tweak.error ?? warm.error,
      })
      await clearChunks()
    }
  }

  // ---- the floor, as an intercept rather than an assertion ---------------
  const laneNamed = (l: LengthReport, name: string): LaneReport | undefined =>
    l.lanes.find((x) => x.lane === name)
  const pointsFor = (name: string, pick: (s: Sample) => number): { x: number; y: number }[] =>
    perLength
      .map((l) => ({ x: l.takeSec, y: pick(laneNamed(l, name)?.median ?? ({} as Sample)) }))
      .filter((p) => Number.isFinite(p.y))

  const warmFit = fit(pointsFor('warm', (s) => s.wallMs ?? 0))
  const coldFit = fit(pointsFor('cold', (s) => s.wallMs ?? 0))
  const tweakFit = fit(pointsFor('tweak', (s) => s.wallMs ?? 0))
  const unbrokenFit = fit(pointsFor('unbroken', (s) => s.wallMs ?? 0))

  // Per-chunk ceremony: the cold lane's summed prepare/finalize/publish over
  // the number of chunk files it actually made.
  const perChunk = perLength
    .map((l) => {
      const cold = laneNamed(l, 'cold')
      const m = cold?.median
      if (!m || !m.chunksRendered) return null
      return (m.prepareMs + m.finalizeMs + m.publishMs) / m.chunksRendered
    })
    .filter((n): n is number => n !== null)
  const perChunkMs = median(perChunk)

  const coldPrep = perLength.map((l) => laneNamed(l, 'cold')?.median).filter(Boolean) as Sample[]
  const sum = (pick: (s: Sample) => number): number => coldPrep.reduce((a, s) => a + pick(s), 0)
  const prepTotal = Math.max(1e-9, sum((s) => s.prepareMs))
  const share = (pick: (s: Sample) => number): string =>
    `${r1(sum(pick))}ms (${Math.round((100 * sum(pick)) / prepTotal)}%)`

  const floor: Record<string, string> = {
    warm:
      `every chunk pre-made: ${r1(warmFit.intercept)}ms fixed + ${r1(warmFit.slope)}ms per second of take` +
      ` — THIS IS WHAT J5 LEAVES BEHIND`,
    tweak: `one nudged span: ${r1(tweakFit.intercept)}ms fixed + ${r1(tweakFit.slope)}ms/s`,
    cold: `first press: ${r1(coldFit.intercept)}ms fixed + ${r1(coldFit.slope)}ms/s`,
    unbroken: `unbroken render: ${r1(unbrokenFit.intercept)}ms fixed + ${r1(unbrokenFit.slope)}ms/s`,
    perChunk: `${r1(perChunkMs)}ms of prepare+finalize+publish PER CHUNK FILE, paid ${outMeta.gopSec}s of output at a time`,
  }

  const suspects: Record<string, string> = {
    open: share((s) => s.open),
    loudnessProbe: share((s) => s.probe),
    codecLadder: share((s) => s.target),
    constantQualityProbe: share((s) => s.cq),
    colourProbe: share((s) => s.colour),
    scratchOpen: share((s) => s.scratch),
    encoderStart: share((s) => s.start),
    unattributed: share(
      (s) => s.prepareMs - (s.open + s.probe + s.target + s.cq + s.colour + s.scratch + s.start),
    ),
    probeDecodes: `${sum((s) => s.probeDecodes)} audio mixers opened purely to measure loudness across the cold lanes`,
  }

  const verdict: Record<string, string> = {}
  for (const g of grid) {
    verdict[`grid ${g.gridSec}s`] = g.error
      ? `ERROR ${g.error}`
      : `${g.chunks} chunks · first press ${r1(g.coldMs)}ms (ceremony ${g.coldCeremonyMs}ms) · ` +
        `a nudged keyframe ${r1(g.tweakMs)}ms · re-press ${r1(g.warmMs)}ms · file ${Math.round(g.bytes / 1024)}KB`
  }
  for (const l of perLength) {
    for (const lane of l.lanes) {
      verdict[`${l.takeSec}s/${lane.lane}`] = lane.error
        ? `ERROR ${lane.error}`
        : `${r1(lane.median.wallMs)}ms wall, ${lane.fixedMs}ms of it fixed (${lane.fixedPct}%)`
    }
  }

  return {
    source: { width: sourceW, height: sourceH, fps: sourceFps, mbps, lengths },
    output: outMeta,
    lengths: perLength,
    grid,
    floor,
    suspects,
    verdict,
    notes,
  }
}
