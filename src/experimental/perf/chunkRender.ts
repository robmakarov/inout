/**
 * EXPERIMENTAL — J1: does the render actually remember?
 *
 * The unit gates (chunkPlan.test.ts) prove the arithmetic: the grid lands on
 * whole frames, one zoom keyframe invalidates two chunks of twenty-four, an
 * undo is a hit. None of that is worth anything until a real encoder has run,
 * because the claims that matter are about WALL CLOCK and about a FILE:
 *
 *   1 a chunked export is comparable to the unbroken render — same frames at
 *     the same instants — or the difference is bounded and stated;
 *   2 an edit confined to one span re-renders only the chunks it touches,
 *     proven by chunk count AND by the clock;
 *   3 a background change re-renders all of them and says so;
 *   4 an export killed early / mid / late resumes and finishes a VALID file;
 *   5 a superseded edit resumes nothing that changed and everything that did;
 *   6 the concatenation is a packet copy — never a re-encode.
 *
 * It manufactures its own source the way R2's rig does (nativeRender.ts, whose
 * builder this reuses rather than growing a second one), so the take can be as
 * long as the question needs without anything having to capture it in real
 * time. That is the whole reason a "the difference is minutes" gate is
 * reachable at all on one laptop.
 *
 *   node scripts/exp.mjs chunkrender '{"takeSec":300}' --timeout=3600
 *   node scripts/exp.mjs chunkrender '{"takeSec":1200,"sourceW":1920,"sourceH":1080,"sourceFps":30}' --headed --gpu --timeout=7200
 *
 * EVERY PHASE RUNS THE PRODUCTION CODE: `renderChunked` for the chunked lane
 * and `renderExport` for the unbroken one, both in this thread so the two wall
 * clocks are measured against the same scheduler.
 */
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny'
import { blobStore } from '@core/store'
import { defaultEditState } from '@core/timeline'
import { DEFAULT_BACKGROUND } from '@core/compose/background'
import {
  describePlan,
  getLastChunkedStats,
  renderChunked,
  type ChunkedRenderStats,
} from '@core/compose/chunkedRender'
import { CHUNK_PART_PREFIX, CHUNK_PREFIX } from '@core/compose/chunkStore'
import { renderExport } from '@core/compose/render'
import { settingsForTier, tierById, type QualityTierId } from '@core/compose/quality'
import { newId } from '@core/id'
import type { EditState, ExportResult, Recording } from '@core/types'
import { buildAudioFile, buildChannelFile, channel, existingFixture, fixtureKey } from './nativeRender'

const MB = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10

export interface ChunkRenderOptions {
  sourceW?: number
  sourceH?: number
  sourceFps?: number
  /** Length of the manufactured take. The gate wants this long enough to matter. */
  takeSec?: number
  sourceMbps?: number
  /** Export step. One only: this rig compares lanes, not tiers. */
  output?: QualityTierId
  /** Two audio channels is what a real take carries (mic + tab audio). */
  audioChannels?: number
  camera?: boolean
  /** Skip the slow unbroken control when only the cache behaviour is in question. */
  skipControl?: boolean
  /** Where to interrupt, as fractions of the chunk plan. */
  killAt?: number[]
  rebuild?: boolean
  buildBudgetSec?: number
}

/** What a produced file actually IS, read back off the disk rather than claimed. */
interface FileFacts {
  bytes: number
  /** Demuxed: the file opens and its tracks are readable. */
  demuxed: boolean
  durationSec: number | null
  videoPackets: number | null
  keyPackets: number | null
  audioPackets: number | null
  /** Every video packet's timestamp, rounded to microseconds — the comparison. */
  firstTimestamps: number[]
  lastTimestamp: number | null
  /** O8's certification survived into the concatenated file. */
  certified: boolean
  error: string | null
}

async function inspect(blob: Blob): Promise<FileFacts> {
  const facts: FileFacts = {
    bytes: blob.size,
    demuxed: false,
    durationSec: null,
    videoPackets: null,
    keyPackets: null,
    audioPackets: null,
    firstTimestamps: [],
    lastTimestamp: null,
    certified: false,
    error: null,
  }
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    facts.durationSec = Math.round((await input.computeDuration()) * 1000) / 1000
    const tags = await input.getMetadataTags()
    facts.certified = typeof tags.comment === 'string' && tags.comment.includes('"path"')
    const video = await input.getPrimaryVideoTrack()
    if (video) {
      const sink = new EncodedPacketSink(video)
      let n = 0
      let keys = 0
      let last: number | null = null
      for await (const p of sink.packets(undefined, undefined, { metadataOnly: true })) {
        if (n < 12) facts.firstTimestamps.push(Math.round(p.timestamp * 1e6) / 1e6)
        if (p.type === 'key') keys++
        last = p.timestamp
        n++
      }
      facts.videoPackets = n
      facts.keyPackets = keys
      facts.lastTimestamp = last === null ? null : Math.round(last * 1e6) / 1e6
    }
    const audio = await input.getPrimaryAudioTrack()
    if (audio) {
      const sink = new EncodedPacketSink(audio)
      let n = 0
      for await (const _p of sink.packets(undefined, undefined, { metadataOnly: true })) n++
      facts.audioPackets = n
    }
    facts.demuxed = true
  } catch (err) {
    facts.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  } finally {
    input.dispose()
  }
  return facts
}

/** Every chunk file this rig's take has left on disk, and what they weigh. */
async function chunkFootprint(): Promise<{ files: number; parts: number; mb: number }> {
  let files = 0
  let parts = 0
  let bytes = 0
  for (const f of await blobStore.list()) {
    if (f.key.startsWith(CHUNK_PART_PREFIX)) {
      parts++
      bytes += f.size
    } else if (f.key.startsWith(CHUNK_PREFIX)) {
      files++
      bytes += f.size
    }
  }
  return { files, parts, mb: MB(bytes) }
}

async function clearChunks(): Promise<void> {
  for (const f of await blobStore.list()) {
    if (f.key.startsWith(CHUNK_PREFIX) || f.key.startsWith(CHUNK_PART_PREFIX)) {
      await blobStore.remove(f.key).catch(() => undefined)
    }
  }
}

interface LaneReport {
  lane: string
  what: string
  wallMs: number
  chunks: ChunkedRenderStats | null
  file: FileFacts | null
  error: string | null
}

/** One zoom span, deliberately inside a single chunk's neighbourhood. */
function withZoomAt(edit: EditState, atMs: number): EditState {
  const whole = { xFrac: 0.5, yFrac: 0.5, widthFrac: 1 }
  return {
    ...edit,
    viewport: {
      keyframes: [
        { ...whole, atMs: atMs - 2000 },
        { xFrac: 0.45, yFrac: 0.45, widthFrac: 0.5, atMs },
        { xFrac: 0.45, yFrac: 0.45, widthFrac: 0.5, atMs: atMs + 1000 },
        { ...whole, atMs: atMs + 3000 },
      ],
    },
  }
}

export interface ChunkRenderReport {
  source: { width: number; height: number; fps: number; takeSec: number; sizeMB: number; cached: boolean }
  output: { step: QualityTierId; width: number; height: number; fps: number }
  plan: { chunks: number; gopSec: number; totalFrames: number }
  lanes: LaneReport[]
  footprint: { files: number; parts: number; mb: number }
  verdict: Record<string, string>
  notes: string[]
}

export async function runChunkRender(opts: ChunkRenderOptions = {}): Promise<ChunkRenderReport> {
  const sourceW = opts.sourceW ?? 1920
  const sourceH = opts.sourceH ?? 1080
  const sourceFps = opts.sourceFps ?? 30
  const takeSec = opts.takeSec ?? 300
  const mbps = opts.sourceMbps ?? 12
  const step = opts.output ?? '1080p'
  const notes: string[] = []
  const lanes: LaneReport[] = []

  // ---- the fixture (R2's builder; one rig owns it) -----------------------
  const key = fixtureKey(sourceW, sourceH, sourceFps, takeSec, mbps)
  const cached = !opts.rebuild && (await existingFixture(key)) !== null
  let frames = Math.round(takeSec * sourceFps)
  if (cached) {
    notes.push(`reusing cached fixture ${key}`)
  } else {
    await blobStore.remove(key).catch(() => undefined)
    const built = await buildChannelFile({
      key,
      width: sourceW,
      height: sourceH,
      fps: sourceFps,
      seconds: takeSec,
      mbps,
      budgetSec: opts.buildBudgetSec ?? 3600,
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
  if (opts.camera) {
    const camKey = fixtureKey(1280, 720, sourceFps, Math.round(actualSec), 4)
    if (opts.rebuild || (await existingFixture(camKey)) === null) {
      await blobStore.remove(camKey).catch(() => undefined)
      await buildChannelFile({
        key: camKey,
        width: 1280,
        height: 720,
        fps: sourceFps,
        seconds: actualSec,
        mbps: 4,
        budgetSec: opts.buildBudgetSec ?? 3600,
        label: 'camera',
      })
    }
    const camBlob = await blobStore.read(camKey)
    channels.push(channel('camera', camKey, 1280, 720, sourceFps, durationMs, camBlob.size))
  }
  const wantAudio = Math.max(0, Math.min(2, Math.round(opts.audioChannels ?? 2)))
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

  const recording: Recording = { id: newId('rec'), createdAt: Date.now(), durationMs, channels }
  const settings = settingsForTier(tierById(step), recording)
  const baseEdit = defaultEditState(recording)
  const plan = describePlan({ recording, edit: baseEdit, settings })
  notes.push(
    `plan: ${plan.chunks.length} chunks of ${plan.gopSec}s over ${plan.totalFrames} output frames`,
  )

  const run = async (
    lane: string,
    what: string,
    fn: () => Promise<ExportResult>,
    inspectFile = true,
  ): Promise<LaneReport> => {
    const t0 = performance.now()
    let file: FileFacts | null = null
    let error: string | null = null
    let chunks: ChunkedRenderStats | null = null
    try {
      const result = await fn()
      chunks = getLastChunkedStats()
      if (inspectFile) file = await inspect(result.blob)
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    }
    const report: LaneReport = {
      lane,
      what,
      wallMs: Math.round(performance.now() - t0),
      chunks,
      file,
      error,
    }
    console.info(
      `[j1] ${lane}: ${report.wallMs} ms` +
        (chunks ? ` — ${chunks.rendered} rendered / ${chunks.reused} reused` : '') +
        (error ? ` — ERROR ${error}` : ''),
    )
    lanes.push(report)
    return report
  }

  // Start from a clean slate: a rig that inherits a previous run's chunks is
  // measuring the previous run.
  await clearChunks()

  /**
   * WARM THE ENCODER BEFORE ANY LANE IS TIMED, or the first lane pays for the
   * whole comparison. The first VideoEncoder in a Chrome process costs ~3.2 s
   * (H6, which is why the product warms one at mount) and the control lane runs
   * first — measured 2026-09-03, that alone was half the 6.2 s the control
   * appeared to lose. A rig that hands one lane a fixed cost is not comparing
   * the lanes, and note 10 says the rig is wrong before the product is.
   */
  {
    const t0 = performance.now()
    try {
      const enc = new VideoEncoder({ output: () => undefined, error: () => undefined })
      enc.configure({ codec: 'avc1.640028', width: 1920, height: 1080, bitrate: 8_000_000 })
      const canvas = new OffscreenCanvas(1920, 1080)
      canvas.getContext('2d')?.fillRect(0, 0, 1920, 1080)
      const frame = new VideoFrame(canvas, { timestamp: 0, duration: 33_333 })
      enc.encode(frame, { keyFrame: true })
      frame.close()
      await enc.flush()
      enc.close()
      notes.push(`encoder warmed in ${Math.round(performance.now() - t0)} ms before any lane was timed`)
    } catch (err) {
      notes.push(`encoder warm-up failed (${String(err)}) — the first lane pays H6's cost`)
    }
  }

  // ---- 1. the unbroken control, first, on a cold cache -------------------
  let control: LaneReport | null = null
  if (!opts.skipControl) {
    control = await run('control-unbroken', 'the render that shipped, whole', () =>
      renderExport({ recording, edit: baseEdit, settings }),
    )
  }

  // ---- 2. the chunked lane, cold -----------------------------------------
  const cold = await run('chunked-cold', 'chunked, nothing on disk', () =>
    renderChunked({ recording, edit: baseEdit, settings }),
  )

  // ---- 3. the same export again — everything must be a hit ---------------
  const warm = await run('chunked-again', 'the same export a second time', () =>
    renderChunked({ recording, edit: baseEdit, settings }),
  )

  // ---- 4. an edit confined to one span -----------------------------------
  const zoomAt = Math.round(durationMs * 0.6)
  const zoomEdit = withZoomAt(baseEdit, zoomAt)
  const oneSpan = await run(
    'edit-one-span',
    `a zoom at ${(zoomAt / 1000).toFixed(0)}s of ${(durationMs / 1000).toFixed(0)}s`,
    () => renderChunked({ recording, edit: zoomEdit, settings }),
  )

  // ---- 5. the undo — nothing that changed, everything that did not -------
  const undone = await run('edit-undone', 'undo back to the original edit', () =>
    renderChunked({ recording, edit: baseEdit, settings }),
  )

  // ---- 6. a background change: honestly, all of them ---------------------
  const bgEdit: EditState = { ...baseEdit, background: { ...DEFAULT_BACKGROUND } }
  const background = await run('edit-background', 'a background frame — every pixel', () =>
    renderChunked({ recording, edit: bgEdit, settings }),
  )

  // ---- 7. killed early / mid / late, then resumed ------------------------
  const killAt = opts.killAt ?? [0.2, 0.5, 0.85]
  const resumes: { at: number; killedAfter: number; resumeRendered: number | null; ok: boolean }[] = []
  for (const at of killAt) {
    /**
     * HOW A KILL IS SIMULATED, and why this is stronger than an abort. A tab
     * that dies leaves the disk holding every chunk that was PUBLISHED and
     * nothing of the one in flight — publishing is a rename after finalize
     * (chunkStore.ts), so there is no third state. Rendering a PREFIX of the
     * take leaves exactly that: the first N chunks, complete, under the same
     * content names the full export will ask for. The prefix boundary is put on
     * a chunk boundary so those N are full-length and therefore identical.
     *
     * An abort would test the same thing more weakly, because an abort runs the
     * cleanup a kill never gets to run.
     */
    await clearChunks()
    const target = Math.max(1, Math.floor(plan.chunks.length * at))
    const killEdit = zoomEdit
    const prefixMs = Math.min(durationMs, target * plan.gopSec * 1000)
    const prefixEdit: EditState = { ...killEdit, globalTrimEndMs: prefixMs }
    let killedAfter = 0
    try {
      await renderChunked({ recording, edit: prefixEdit, settings })
      killedAfter = getLastChunkedStats()?.rendered ?? 0
    } catch (err) {
      notes.push(`resume ${at}: the prefix render failed — ${String(err)}`)
    }
    const t0 = performance.now()
    let ok = false
    let resumeRendered: number | null = null
    try {
      const result = await renderChunked({ recording, edit: killEdit, settings })
      resumeRendered = getLastChunkedStats()?.rendered ?? null
      const facts = await inspect(result.blob)
      ok =
        facts.demuxed &&
        facts.error === null &&
        facts.videoPackets === plan.totalFrames &&
        facts.certified
      lanes.push({
        lane: `resume-${at}`,
        what: `${killedAfter} chunks survived the kill, then the whole export`,
        wallMs: Math.round(performance.now() - t0),
        chunks: getLastChunkedStats(),
        file: facts,
        error: null,
      })
    } catch (err) {
      lanes.push({
        lane: `resume-${at}`,
        what: 'resume',
        wallMs: Math.round(performance.now() - t0),
        chunks: null,
        file: null,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      })
    }
    resumes.push({ at, killedAfter, resumeRendered, ok })
  }

  // ---- 8. a stray part file is never a hit -------------------------------
  await clearChunks()
  const stray = `${CHUNK_PART_PREFIX}${Date.now().toString(36)}-junk`
  await blobStore
    .createWriteStream(stray)
    .then(async (s) => {
      const w = s.getWriter()
      await w.write(new Uint8Array([1, 2, 3, 4]))
      await w.close()
    })
    .catch(() => undefined)
  const withStray = await run('stray-part-file', 'a half-written chunk left by a dead tab', () =>
    renderChunked({ recording, edit: baseEdit, settings }),
  )
  await blobStore.remove(stray).catch(() => undefined)

  const footprint = await chunkFootprint()

  // ---- the verdict, in words a gate can read -----------------------------
  const verdict: Record<string, string> = {}
  const f = (l: LaneReport | null): FileFacts | null => l?.file ?? null
  const controlFile = f(control)
  const coldFile = f(cold)
  if (controlFile && coldFile) {
    const samePackets = controlFile.videoPackets === coldFile.videoPackets
    const sameKeys = controlFile.keyPackets === coldFile.keyPackets
    const sizeDelta =
      controlFile.bytes > 0
        ? Math.round(((coldFile.bytes - controlFile.bytes) / controlFile.bytes) * 1000) / 10
        : null
    const sameStarts =
      JSON.stringify(controlFile.firstTimestamps) === JSON.stringify(coldFile.firstTimestamps)
    verdict.comparable =
      `${samePackets ? 'SAME' : 'DIFFERENT'} video packet count ` +
      `(${controlFile.videoPackets} vs ${coldFile.videoPackets}); keyframes ` +
      `${controlFile.keyPackets} vs ${coldFile.keyPackets} (${sameKeys ? 'same' : 'differ'}); ` +
      `timestamps ${sameStarts ? 'identical' : 'differ'}; size ${MB(controlFile.bytes)} vs ` +
      `${MB(coldFile.bytes)} MB (${sizeDelta === null ? 'n/a' : `${sizeDelta > 0 ? '+' : ''}${sizeDelta}%`})`
    /**
     * NOT A SPEED COMPARISON, AND IT SAYS SO — 2026-09-03. Both lanes run in
     * ONE page, and the first one pays every one-time cost there is: module
     * init, the OPFS handles, mediabunny's setup, the source file's decoder.
     * Measured, that handed the chunked lane a 25 % "win" it had not earned —
     * the same A/B through `exp nativerender --query=chunked=`, which runs one
     * export per Chrome process so each arm pays its own warm-up, came back
     * 1.08x the OTHER way (9,501 vs 10,232 ms, n=3 a side).
     *
     * The number is kept because the LANES are what this rig is for (what was
     * re-rendered, what was reused, what the file demuxes to), and deleting it
     * would only mean the next session measures it again and believes it.
     */
    verdict.speed =
      `NOT A VALID COMPARISON — unbroken ${control!.wallMs} ms vs chunked-cold ${cold.wallMs} ms ` +
      `(${(cold.wallMs / Math.max(1, control!.wallMs)).toFixed(2)}x), but the first lane in a page ` +
      `pays every one-time cost. For speed use: exp nativerender --query=chunked=1 vs =0`
  }
  verdict.reexport =
    `a second export of the same edit rendered ${warm.chunks?.rendered ?? '?'} chunks ` +
    `in ${warm.wallMs} ms against ${cold.wallMs} ms cold ` +
    `(${(warm.wallMs / Math.max(1, cold.wallMs)).toFixed(3)}x)`
  verdict.oneSpan =
    `one zoom span: ${oneSpan.chunks?.rendered ?? '?'} of ${plan.chunks.length} chunks ` +
    `re-rendered, ${oneSpan.wallMs} ms against a cold ${cold.wallMs} ms ` +
    `(saved ${Math.max(0, cold.wallMs - oneSpan.wallMs)} ms); audio ` +
    `${oneSpan.chunks?.audioReused ? 'REUSED' : 'rewritten'}`
  verdict.undo =
    `the undo rendered ${undone.chunks?.rendered ?? '?'} chunks in ${undone.wallMs} ms`
  verdict.background =
    `a background change re-rendered ${background.chunks?.rendered ?? '?'} of ` +
    `${plan.chunks.length} chunks in ${background.wallMs} ms; audio ` +
    `${background.chunks?.audioReused ? 'reused' : 'rewritten'}`
  verdict.packetCopy =
    `concatenation copied ${cold.chunks?.videoPacketsCopied ?? '?'} video and ` +
    `${cold.chunks?.audioPacketsCopied ?? '?'} audio packets and re-encoded ` +
    `${cold.chunks?.reencodedFrames ?? '?'} frames; concat wall ${cold.chunks?.concatMs ?? '?'} ms ` +
    `of ${cold.wallMs} ms`
  verdict.resume = resumes
    .map(
      (r) =>
        `killed at ${Math.round(r.at * 100)}% (${r.killedAfter} chunks on disk) → resumed rendering ` +
        `${r.resumeRendered} more, file ${r.ok ? 'VALID' : 'INVALID'}`,
    )
    .join(' · ')
  verdict.strayPart =
    `a stray part file left ${withStray.chunks?.rendered ?? '?'} chunks to render ` +
    `(the whole plan, as it must) and the export ${withStray.error ? 'FAILED' : 'completed'}`
  verdict.footprint = `${footprint.files} chunk files, ${footprint.parts} parts, ${footprint.mb} MB on disk`

  for (const [k, v] of Object.entries(verdict)) console.info(`[j1] ${k}: ${v}`)

  return {
    source: {
      width: sourceW,
      height: sourceH,
      fps: sourceFps,
      takeSec: Math.round(actualSec * 10) / 10,
      sizeMB: MB(sourceBlob.size),
      cached,
    },
    output: { step, width: settings.width, height: settings.height, fps: settings.fps },
    plan: { chunks: plan.chunks.length, gopSec: plan.gopSec, totalFrames: plan.totalFrames },
    lanes,
    footprint,
    verdict,
    notes,
  }
}
