/**
 * EXPERIMENTAL — J5: THE EXPORT IS MADE WHILE HE EDITS, MEASURED THROUGH THE
 * PRODUCT'S OWN DOOR.
 *
 * Robert 2026-09-04 (robert (27)): "kill the glued copy encoding and do
 * background render while editing". The order is part of that ruling — this
 * lands before J6 takes the composite's encoder out — so what this rig has to
 * answer is not "is a background render faster" (J1 and J7 already priced the
 * render) but the four things J5's gates ask, and each of them through
 * `noteEditorEdit`, the same call the editor makes:
 *
 *   untouched   the editor opened and nothing was touched → NOTHING renders,
 *               no job, no chunk on disk. Robert's own objection to the version
 *               he deleted, and the one gate that must never pass by accident.
 *   premade     one zoom edit, the settle, the background job, a QUIET MINUTE,
 *               then Export → the press, in ms, against the same edit pressed
 *               cold. This is "there is no visible wait" as a number.
 *   identical   that pre-made file against a cold foreground render of the same
 *               edit — EVERY PACKET hashed with its timestamp, duration and
 *               keyframe flag, plus the raw file diff and a control of two cold
 *               renders against each other. Starting a render earlier may never
 *               change what it produces. (The raw files are NOT equal and never
 *               can be: mediabunny stamps `Date.now()` into mvhd/tkhd/mdhd, so
 *               two foreground renders differ in the same 10 bytes. The control
 *               is what makes that statement a measurement.)
 *   invalidated a second, small edit (the zoom nudged 400 ms) rendered in the
 *               background over the first one's chunks → how many chunks were
 *               RE-RENDERED against how many were reused. J1's promise, read
 *               through J5's trigger rather than through renderChunked.
 *
 * WHAT IT CANNOT ANSWER, and does not pretend to: whether the editor stalls
 * while the job runs. That is main-thread lateness in a REAL, VISIBLE editor
 * with a hand on it — `node scripts/editor-drag-cost.mjs --j5`, which drives
 * Chrome, because this harness page has no editor in it and an agent's browser
 * pane is a hidden document whose timers are clamped to ~1 Hz.
 *
 *   node scripts/exp.mjs j5 --timeout=1800
 *   node scripts/exp.mjs j5 '{"takeSec":20,"quietMs":5000}' --timeout=900
 *
 * Fixture is R2's builder (nativeRender.ts), the same one J1's and J7's rigs
 * use: a manufactured take costs nothing to record and is identical run to run.
 */
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny'
import { blobStore } from '@core/store'
import { defaultEditState } from '@core/timeline'
import { exportByBestPath } from '@core/compose/choose'
import { getLastChunkedRenderStats } from '@core/compose/pipeline'
import { ChunkedRenderUnavailable, describePlan, renderChunked } from '@core/compose/chunkedRender'
import { CHUNK_PART_PREFIX, CHUNK_PREFIX } from '@core/compose/chunkStore'
import { cancelEditRender, noteEditorEdit, editRenderPending, EDIT_SETTLE_MS } from '@core/compose/editRender'
import { cancelPrerender, prerenderKey, prerenderStatus } from '@core/compose/prerender'
import { currentRenderFlags, type RenderFlagPrint } from '@core/compose/chunkPlan'
import { settingsForTier, tierById, type QualityTierId } from '@core/compose/quality'
import { renderExport } from '@core/compose/render'
import { newId } from '@core/id'
import type { EditState, ExportResult, ExportSettings, Recording } from '@core/types'
import { buildAudioFile, buildChannelFile, channel, existingFixture, fixtureKey } from './nativeRender'

export interface BackgroundEditRenderOptions {
  takeSec?: number
  sourceW?: number
  sourceH?: number
  sourceFps?: number
  sourceMbps?: number
  output?: QualityTierId
  audioChannels?: number
  /**
   * How long "a quiet minute" is. The gate's own number is 60 s; it is an
   * option only so a first pass can be run in a fifth of the time.
   */
  quietMs?: number
  /** How long the untouched editor is watched before the absence is believed. */
  untouchedWatchMs?: number
  rebuild?: boolean
  buildBudgetSec?: number
}

const r1 = (n: number): number => Math.round(n * 10) / 10

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))

async function clearChunks(): Promise<void> {
  for (const f of await blobStore.list()) {
    if (f.key.startsWith(CHUNK_PREFIX) || f.key.startsWith(CHUNK_PART_PREFIX)) {
      await blobStore.remove(f.key).catch(() => undefined)
    }
  }
}

async function countChunks(): Promise<number> {
  let n = 0
  for (const f of await blobStore.list()) if (f.key.startsWith(CHUNK_PREFIX)) n += 1
  return n
}

/**
 * THE COLD FOREGROUND RENDER, WITH THE PRODUCT'S OWN FALLBACK UNDER IT.
 *
 * Gates 3 and 4 used to call `renderChunked` bare, which is only the same thing
 * the product does while the chunked path is AVAILABLE. It is not always: under
 * O9(b)'s `?colour=all`, `renderChunked` declines by name (its concatenation
 * muxes one AVC track and a full-colour render encodes AV1) and pipeline.ts
 * falls through to the unbroken render. A rig that stops at the decline is
 * measuring its own shortcut rather than the export, so this is the same two
 * lines pipeline.ts has — chunked, then unbroken on `ChunkedRenderUnavailable`.
 *
 * At 4:2:0 — every J5 number ever quoted — the first call succeeds and nothing
 * about this rig moves.
 */
async function coldRender(args: {
  recording: Recording
  edit: EditState
  settings: ExportSettings
}): Promise<{ result: ExportResult; path: 'chunked' | 'unbroken' }> {
  try {
    return { result: await renderChunked(args), path: 'chunked' }
  } catch (err) {
    if (!(err instanceof ChunkedRenderUnavailable)) throw err
    return { result: await renderExport(args), path: 'unbroken' }
  }
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * WHERE two files differ, not merely THAT they do. A hash says "not identical"
 * and stops; a render that differs in four bytes near the start of the moov is
 * a container timestamp, and one that differs across the mdat is a different
 * picture. The gate is only worth having if it can tell those apart.
 */
interface ByteDiff {
  differingBytes: number
  spans: { at: number; len: number; a: string; b: string }[]
  size: number
}

async function byteDiff(a: Blob, b: Blob): Promise<ByteDiff> {
  const x = new Uint8Array(await a.arrayBuffer())
  const y = new Uint8Array(await b.arrayBuffer())
  const n = Math.min(x.length, y.length)
  const spans: ByteDiff['spans'] = []
  let differing = 0
  let i = 0
  while (i < n) {
    if (x[i] === y[i]) {
      i += 1
      continue
    }
    const at = i
    while (i < n && x[i] !== y[i]) i += 1
    differing += i - at
    if (spans.length < 12) {
      const hex = (u: Uint8Array): string =>
        [...u.slice(at, Math.min(i, at + 12))].map((v) => v.toString(16).padStart(2, '0')).join('')
      spans.push({ at, len: i - at, a: hex(x), b: hex(y) })
    }
  }
  differing += Math.abs(x.length - y.length)
  return { differingBytes: differing, spans, size: x.length }
}

export interface TrackFingerprint {
  packets: number
  keyframes: number
  bytes: number
  firstTimestamp: number
  lastTimestamp: number
  /** SHA-256 over every packet's bytes AND its timestamp, duration and type. */
  hash: string
}

export interface MediaFingerprint {
  video: TrackFingerprint
  audio: TrackFingerprint
}

const EMPTY_TRACK: TrackFingerprint = {
  packets: 0,
  keyframes: 0,
  bytes: 0,
  firstTimestamp: 0,
  lastTimestamp: 0,
  hash: '',
}

/**
 * WHAT THE FILE ACTUALLY CARRIES — every packet, in order, with its timestamp,
 * its duration and whether it is a keyframe. This is what "the same export"
 * means; the container around it carries a wall clock (see the control below).
 */
async function mediaFingerprint(blob: Blob): Promise<MediaFingerprint> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const readTrack = async (
    track: Awaited<ReturnType<typeof input.getPrimaryVideoTrack>>,
  ): Promise<TrackFingerprint> => {
    if (!track) return { ...EMPTY_TRACK }
    const parts: Uint8Array[] = []
    const out: TrackFingerprint = { ...EMPTY_TRACK }
    const sink = new EncodedPacketSink(track)
    const enc = new TextEncoder()
    for await (const packet of sink.packets()) {
      if (out.packets === 0) out.firstTimestamp = packet.timestamp
      out.lastTimestamp = packet.timestamp
      out.packets += 1
      if (packet.type === 'key') out.keyframes += 1
      out.bytes += packet.data.byteLength
      parts.push(enc.encode(`${packet.timestamp}|${packet.duration}|${packet.type}|`))
      parts.push(packet.data)
    }
    const total = parts.reduce((a, p) => a + p.byteLength, 0)
    const all = new Uint8Array(total)
    let at = 0
    for (const p of parts) {
      all.set(p, at)
      at += p.byteLength
    }
    const digest = await crypto.subtle.digest('SHA-256', all)
    out.hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    return out
  }
  const video = await readTrack(await input.getPrimaryVideoTrack())
  const audio = await readTrack(
    (await input.getPrimaryAudioTrack()) as Awaited<ReturnType<typeof input.getPrimaryVideoTrack>>,
  )
  return { video, audio }
}

/** One zoom span — a PIXEL edit, which is what forces a render at all. */
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

export interface BackgroundEditRenderReport {
  source: { width: number; height: number; fps: number; mbps: number; takeSec: number }
  output: { step: QualityTierId; width: number; height: number; fps: number; gopSec: number; chunks: number }
  /** What was in force. O9(b) reads `fullColour` off this run rather than trusting the command line. */
  flags: RenderFlagPrint
  untouched: {
    watchedMs: number
    scheduled: boolean
    jobStarted: boolean
    chunksOnDisk: number
    verdict: string
  }
  background: {
    /** From the edit landing to the job reporting done, ms — the settle is in it. */
    readyMs: number
    chunksOnDisk: number
    state: string
  }
  press: {
    quietMs: number
    premadeMs: number
    coldMs: number
    ratio: number
    path: string
    /** Which render the cold press actually ran — 'unbroken' whenever chunked declined. */
    coldPath: string
    bytes: number
    verdict: string
  }
  identical: {
    premade: string
    cold: string
    same: boolean
    bytesPremade: number
    bytesCold: number
    /** Only when the hashes differ: exactly where, so the cause can be named. */
    diff: ByteDiff | null
    /** Two COLD foreground renders of the same edit, against each other. */
    control: { hash: string; bytes: number; diff: ByteDiff } | null
    /** Every packet on both sides — the claim the container's clock cannot touch. */
    media: { premade: MediaFingerprint; cold: MediaFingerprint; same: boolean } | null
    verdict: string
  }
  invalidated: {
    rendered: number
    reused: number
    total: number
    readyMs: number
    verdict: string
  }
  notes: string[]
  error: string | null
}

export async function runBackgroundEditRender(
  opts: BackgroundEditRenderOptions = {},
): Promise<BackgroundEditRenderReport> {
  const takeSec = Math.max(6, Math.round(opts.takeSec ?? 30))
  const sourceW = opts.sourceW ?? 1920
  const sourceH = opts.sourceH ?? 1080
  const sourceFps = opts.sourceFps ?? 30
  const mbps = opts.sourceMbps ?? 12
  const step = opts.output ?? '1080p'
  const wantAudio = Math.max(0, Math.min(2, Math.round(opts.audioChannels ?? 2)))
  const quietMs = Math.max(0, Math.round(opts.quietMs ?? 60_000))
  const untouchedWatchMs = Math.max(EDIT_SETTLE_MS * 2, Math.round(opts.untouchedWatchMs ?? 5000))
  const notes: string[] = []

  // ---- the take ------------------------------------------------------------
  const key = fixtureKey(sourceW, sourceH, sourceFps, takeSec, mbps)
  let frames = Math.round(takeSec * sourceFps)
  if (!opts.rebuild && (await existingFixture(key)) !== null) {
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
  const recording: Recording = { id: newId('rec'), createdAt: Date.now(), durationMs, channels }
  const settings = settingsForTier(tierById(step), recording)
  const baseEdit = defaultEditState(recording)
  const plan = describePlan({ recording, edit: baseEdit, settings })
  const zoomAt = Math.round(durationMs * 0.5)
  const zoomEdit = withZoomAt(baseEdit, zoomAt)
  const nudgedEdit = withZoomAt(baseEdit, zoomAt + 400)

  const report: BackgroundEditRenderReport = {
    source: { width: sourceW, height: sourceH, fps: sourceFps, mbps, takeSec: Math.round(actualSec) },
    output: {
      step,
      width: settings.width,
      height: settings.height,
      fps: settings.fps,
      gopSec: plan.gopSec,
      chunks: plan.chunks.length,
    },
    flags: currentRenderFlags(),
    untouched: { watchedMs: untouchedWatchMs, scheduled: false, jobStarted: false, chunksOnDisk: 0, verdict: '' },
    background: { readyMs: 0, chunksOnDisk: 0, state: 'never started' },
    press: { quietMs, premadeMs: 0, coldMs: 0, ratio: 0, path: '', coldPath: '', bytes: 0, verdict: '' },
    identical: {
      premade: '',
      cold: '',
      same: false,
      bytesPremade: 0,
      bytesCold: 0,
      diff: null,
      control: null,
      media: null,
      verdict: '',
    },
    invalidated: { rendered: 0, reused: 0, total: plan.chunks.length, readyMs: 0, verdict: '' },
    notes,
    error: null,
  }

  /** Poll the job the door started until it settles. */
  const waitForJob = async (edit: EditState, timeoutMs: number): Promise<{ state: string; ms: number }> => {
    const jobKey = prerenderKey({ recording, edit, settings })
    const t0 = performance.now()
    let seen = 'never started'
    while (performance.now() - t0 < timeoutMs) {
      const st = prerenderStatus(jobKey)
      if (st) {
        seen = st.state
        if (st.state === 'done' || st.state === 'failed') break
      }
      await sleep(100)
    }
    return { state: seen, ms: r1(performance.now() - t0) }
  }

  try {
    cancelEditRender()
    cancelPrerender()
    await clearChunks()

    // ---- gate 1: an untouched editor renders nothing ----------------------
    // The editor mounting is one call with the take as it opened, and re-renders
    // are more of the same call. Neither is a touch.
    noteEditorEdit({ recording, edit: baseEdit, settings, wouldRender: true })
    noteEditorEdit({ recording, edit: baseEdit, settings, wouldRender: true })
    await sleep(untouchedWatchMs)
    report.untouched.scheduled = editRenderPending()
    report.untouched.jobStarted = prerenderStatus(prerenderKey({ recording, edit: baseEdit, settings })) !== null
    report.untouched.chunksOnDisk = await countChunks()
    report.untouched.verdict =
      !report.untouched.scheduled && !report.untouched.jobStarted && report.untouched.chunksOnDisk === 0
        ? `PASS — ${Math.round(untouchedWatchMs / 1000)} s of an open, untouched editor: nothing scheduled, no job, 0 chunks`
        : `FAIL — scheduled=${report.untouched.scheduled} job=${report.untouched.jobStarted} chunks=${report.untouched.chunksOnDisk}`

    // ---- the edit he made, rendered while he sits there --------------------
    const tEdit = performance.now()
    const decided = noteEditorEdit({ recording, edit: zoomEdit, settings, wouldRender: true })
    notes.push(`the door said: ${decided.why}`)
    const job = await waitForJob(zoomEdit, 15 * 60_000)
    report.background.state = job.state
    report.background.readyMs = r1(performance.now() - tEdit)
    report.background.chunksOnDisk = await countChunks()
    if (job.state !== 'done') throw new Error(`the background render did not finish: ${job.state}`)

    // ---- gate 2: the press after a quiet minute ----------------------------
    await sleep(quietMs)
    const tPress = performance.now()
    const chosen = await exportByBestPath({ recording, edit: zoomEdit, settings, allowPacketCopy: false })
    report.press.premadeMs = r1(performance.now() - tPress)
    report.press.path = chosen.path
    report.press.bytes = chosen.result.blob.size
    // Held: the scratch this blob views is the newest finished export's, and the
    // cold render below is about to become that. Read it now, keep the bytes.
    const premadeBlob = new Blob([await chosen.result.blob.arrayBuffer()], { type: 'video/mp4' })
    report.identical.premade = await sha256(premadeBlob)
    report.identical.bytesPremade = premadeBlob.size

    // ---- gate 3: byte-identical to a foreground render of the same edit ----
    // Cold on purpose: the chunks the background job left are cleared, so this
    // is the render that would have happened if J5 had never run.
    await clearChunks()
    const tCold = performance.now()
    const cold = await coldRender({ recording, edit: zoomEdit, settings })
    report.press.coldMs = r1(performance.now() - tCold)
    report.press.coldPath = cold.path
    const coldBlob = new Blob([await cold.result.blob.arrayBuffer()], { type: 'video/mp4' })
    report.identical.cold = await sha256(coldBlob)
    report.identical.bytesCold = coldBlob.size
    report.identical.same =
      report.identical.premade === report.identical.cold &&
      report.identical.bytesPremade === report.identical.bytesCold
    if (!report.identical.same) report.identical.diff = await byteDiff(premadeBlob, coldBlob)

    /**
     * THE CONTROL, and it is the whole reason this section is not one hash.
     * `Date.now()` goes into the container: mediabunny stamps mvhd/tkhd/mdhd
     * creation and modification times (isobmff-muxer.js, `this.creationTime =
     * Math.floor(Date.now() / 1000)`), so ANY two renders made seconds apart
     * differ in those bytes — two foreground renders included. A raw-hash gate
     * would therefore be red for every export this product has ever made, which
     * is a gate measuring the clock rather than the render.
     *
     * So the claim is proved twice over: the same file diff between TWO COLD
     * FOREGROUND RENDERS (this control), and the MEDIA — every packet's bytes,
     * timestamp, duration and keyframe flag — hashed on both sides.
     */
    await clearChunks()
    const control = await coldRender({ recording, edit: zoomEdit, settings })
    const controlBlob = new Blob([await control.result.blob.arrayBuffer()], { type: 'video/mp4' })
    report.identical.control = {
      hash: await sha256(controlBlob),
      bytes: controlBlob.size,
      diff: await byteDiff(coldBlob, controlBlob),
    }
    const mediaPremade = await mediaFingerprint(premadeBlob)
    const mediaCold = await mediaFingerprint(coldBlob)
    report.identical.media = {
      premade: mediaPremade,
      cold: mediaCold,
      same: mediaPremade.video.hash === mediaCold.video.hash && mediaPremade.audio.hash === mediaCold.audio.hash,
    }
    const diffBytes = report.identical.diff?.differingBytes ?? 0
    const controlBytes = report.identical.control.diff.differingBytes
    report.identical.verdict = report.identical.media.same
      ? report.identical.same
        ? 'PASS — the pre-made file is the cold render, byte for byte'
        : `PASS — every packet identical (${mediaCold.video.packets} video, ${mediaCold.audio.packets} audio, ` +
          `same timestamps, same keyframes); the files differ in ${diffBytes} container bytes, and two cold ` +
          `foreground renders of the same edit differ in ${controlBytes} of the same (mediabunny stamps Date.now() ` +
          `into mvhd/tkhd/mdhd)`
      : `FAIL — the media differs: video ${mediaPremade.video.packets}/${mediaCold.video.packets} packets, ` +
        `audio ${mediaPremade.audio.packets}/${mediaCold.audio.packets}`
    report.press.ratio = report.press.premadeMs > 0 ? r1(report.press.coldMs / report.press.premadeMs) : 0
    report.press.verdict =
      `press with the export already made ${report.press.premadeMs} ms against a cold ` +
      `${report.press.coldMs} ms (${report.press.ratio}x), path=${report.press.path}, ` +
      `cold render=${report.press.coldPath}`

    // ---- gate 4: a second small edit invalidates only its own chunks -------
    // The cold render above left this edit's chunks on disk, which is exactly
    // the state a second edit meets in the product.
    const tNudge = performance.now()
    noteEditorEdit({ recording, edit: nudgedEdit, settings, wouldRender: true })
    const second = await waitForJob(nudgedEdit, 15 * 60_000)
    report.invalidated.readyMs = r1(performance.now() - tNudge)
    if (second.state !== 'done') throw new Error(`the second background render did not finish: ${second.state}`)
    const stats = getLastChunkedRenderStats()
    report.invalidated.rendered = stats?.rendered ?? -1
    report.invalidated.reused = stats?.reused ?? -1
    report.invalidated.total = (stats?.rendered ?? 0) + (stats?.reused ?? 0)
    report.invalidated.verdict =
      report.invalidated.rendered >= 0
        ? `the zoom moved 400 ms: ${report.invalidated.rendered} chunk(s) re-rendered, ` +
          `${report.invalidated.reused} reused, of ${report.invalidated.total}`
        : report.flags.fullColour
          ? 'the unbroken render ran, as `?colour=all` requires — chunked declines at 4:4:4, so there ' +
            'are no chunks to reuse and this gate has nothing to count (J1 teaching its concatenation ' +
            'a second codec is its own task)'
          : 'FAIL — the chunked path did not report (the unbroken render ran instead)'
  } catch (err) {
    report.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  } finally {
    cancelEditRender()
    cancelPrerender()
    await clearChunks()
  }

  return report
}
