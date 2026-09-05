/**
 * THE RENDER REMEMBERS — the orchestrator (task J1).
 *
 * WHAT IT REPLACES. The at-stop pre-render renders the whole take;
 * `editBindsPrerender` cancels it on any edit; `startPrerender` begins again
 * from zero 1.2 s later. A frame preset and a zoom cost two discarded hour-long
 * renders before Export is even pressed, on a machine that is then hot for the
 * render that counts. Nothing about that work was wrong. It was thrown away.
 *
 * WHAT THIS DOES INSTEAD, in one sentence: render the output five seconds at a
 * time into files named by their own content, and concatenate them by copying
 * packets. An edit then costs the chunks whose pixels actually moved and
 * nothing else, a killed tab costs the chunk it was in the middle of, and a
 * take's length stops being a policy question — a 2-hour take and a 2-minute
 * take are the same loop with a different number of trips through it.
 *
 * WHY CONCATENATION IS SAFE. Every chunk is encoded by the same encoder from
 * the same config, so every chunk's avcC — H.264's SPS/PPS, the one decoder
 * description an MP4 track can carry — is the same bytes. That is not assumed:
 * it is BYTE-COMPARED before a single packet is written, exactly as smart cut
 * compares the boundary encoder's description against the composite's, and a
 * mismatch refuses the whole path and renders unbroken instead. We can afford
 * to be strict because both encoders are ours.
 *
 * WHICH CODEC IT IS, IS READ AND NOT ASSUMED (task J8). This concatenation used
 * to open its one video track with `pickEncodingTarget`'s codec — the ladder's
 * answer, 'avc' — while the thing that actually made the chunks is
 * `render.ts`, which swaps in AV1 whenever O9(b)'s `?colour=all` is on. Two
 * different answers to one question, and the muxer said so:
 * "Couldn't extract an AVCDecoderConfigurationRecord from the AVC packet", i.e.
 * AV1 packets on an AVC track. So the track is now opened from the FIRST
 * CHUNK'S OWN TRACK, and every chunk after it must agree with that one on all
 * three of codec family, full codec string and decoder description — a mixed
 * set is refused, never muxed. The string and not only the description,
 * because AV1 carries no description at all: its av1C is generated from the
 * codec string (mediabunny codec.js), so `av01.0…` (4:2:0) and `av01.1…`
 * (4:4:4) chunks would both compare "equal" on bytes nobody wrote.
 *
 * WHY THE AUDIO IS NOT CHUNKED. AAC and opus both carry encoder priming, so
 * audio cut into pieces and spliced back together clicks at every boundary —
 * that is not a bounded difference, it is a broken file. The audio is one
 * continuous encode cached under its own key, and the key holds only what the
 * audio depends on: a zoom, a camera move or a background change does not
 * appear in it, so a pixel edit costs ZERO audio work. Proportional in kind
 * where it cannot be proportional in time.
 *
 * THE THREE CURSORS ARE ONE CURSOR. The chunk cache is the render cursor (what
 * is left to do), the resume cursor (a killed tab resumes at the last complete
 * chunk, because a complete chunk is a file that exists) and the shipping
 * cursor (an uploader reads finished, immutable, ordered files). None of them
 * needed building; they are what content-addressing IS.
 *
 * IT IS NEVER THE ONLY PATH. Anything unexpected — no video to chunk, a
 * descriptor the store cannot write, an avcC that disagrees, a chunk that will
 * not open — falls back to the unbroken render, which is the export this
 * product shipped before J1 and must always still be able to run.
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Output,
  type InputVideoTrack,
  type VideoCodec,
} from 'mediabunny'
import { blobStore } from '@core/store'
import { keptSegments, segmentSpeed } from '@core/timeline'
import {
  DEFAULT_EXPORT_SETTINGS,
  type EditState,
  type ExportProgress,
  type ExportResult,
  type ExportSettings,
  type PaceSource,
  type Recording,
} from '@core/types'
import { audioPresent, currentRenderFlags, planChunks, type ChunkPlan, type PlannedChunk } from './chunkPlan'
import {
  chunkKeyFor,
  chunkSize,
  claimChunkCache,
  hashDescriptor,
  listChunkKeys,
  makeRoomForChunks,
  openChunkWriter,
  removeChunk,
  touchChunk,
} from './chunkStore'
import { buildCertification, certificationComment } from './certify'
import { VIDEO_BITRATE, pickEncodingTarget, type EncodingTarget } from './codecs'
import { keyframeIntervalSec } from './keyframeInterval'
import { exportFileName } from './fileName'
import { createExportScratch, type ExportScratch } from './scratch'
import {
  activeOutputWindowsMs,
  getLastRenderStats,
  openVideoChannel,
  renderExport,
  setLastRenderStats,
  type RenderStats,
  type VideoChannelReader,
} from './render'

/** Timestamps within this of each other are the same instant (half a frame at 60). */
const EPS_SEC = 1 / 120

/** Bytes in the unit a person reads a disk in. Console lines only. */
const mb = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`

export class ChunkedRenderUnavailable extends Error {
  /**
   * J9: CAN A SECOND ATTEMPT DO BETTER THAN A FULL UNBROKEN RENDER?
   *
   * `false` is the original meaning of this error and the safe one — this take
   * cannot be chunked at all, so the caller renders it unbroken, once. `true`
   * says a PIECE went missing or disagreed under a plan that is otherwise
   * sound: a chunk was swept out from under the concatenation, or its codec did
   * not match its neighbours. The plan is deterministic and the cache is
   * content-addressed, so re-entering renderChunked re-renders exactly the
   * pieces that are gone and reuses every other one.
   *
   * That distinction is the difference between losing one 2.5-second chunk and
   * losing a 90-minute render, which is what this cost before J9.
   */
  readonly recoverable: boolean
  constructor(reason: string, recoverable = false) {
    super(`chunked render: ${reason}`)
    this.name = 'ChunkedRenderUnavailable'
    this.recoverable = recoverable
  }
}

export interface ChunkedRenderOptions {
  recording: Recording
  edit: EditState
  settings?: ExportSettings
  onProgress?: (p: ExportProgress) => void
  signal?: AbortSignal
  pace?: PaceSource
  yieldEveryFrames?: number
}

/** What the run did, in numbers a gate can read. */
export interface ChunkedRenderStats {
  chunks: number
  /** Chunks already on disk under their content name when the export started. */
  reused: number
  rendered: number
  audioReused: boolean
  /** Wall clock of the three phases. */
  renderMs: number
  concatMs: number
  totalMs: number
  /**
   * J7 — the chunked path's OWN fixed cost, none of which is proportional to
   * how much of the take actually changed. `planMs` hashes every chunk
   * descriptor and lists OPFS; `muxOpenMs` is the concatenation's ladder walk,
   * scratch open and `out.start()`; `publishMs` is the `scratch.finish()` that
   * runs after finalize and that `concatMs` therefore never counted.
   */
  planMs: number
  muxOpenMs: number
  publishMs: number
  /** Packets copied into the final file — the concatenation, measured. */
  videoPacketsCopied: number
  audioPacketsCopied: number
  /** ZERO, always, and asserted: concatenation never re-encodes. */
  reencodedFrames: number
  bytes: number
}

let lastStats: ChunkedRenderStats | null = null
export function getLastChunkedStats(): ChunkedRenderStats | null {
  return lastStats
}
export function resetChunkedStatsForTests(): void {
  lastStats = null
}



/**
 * Readers for every video channel that contributes, opened together.
 *
 * Positioned by their first use, not here: `VideoChannelReader` creates its
 * sample iterator at the first `sampleAt`, which seeks to the keyframe at or
 * before that instant. That is why one set can serve a whole RUN of missing
 * chunks and why a set must never be carried across a gap of cache hits —
 * walking it forward over the gap would decode every frame in it.
 */
async function openReadersFor(
  recording: Recording,
  edit: EditState,
): Promise<VideoChannelReader[]> {
  const readers: VideoChannelReader[] = []
  for (const channel of recording.channels) {
    if (channel.media !== 'video') continue
    const windows = activeOutputWindowsMs(edit, channel)
    if (windows.length === 0) continue
    const blob = await blobStore.read(channel.blobKey)
    const reader = await openVideoChannel(
      blob,
      channel.id,
      channel.kind,
      windows[windows.length - 1]!.localEndMs / 1000,
    )
    if (reader) readers.push(reader)
  }
  return readers
}

/** Consecutive runs of chunks that have to be rendered. */
function missingRuns(chunks: PlannedChunk[], missing: Set<number>): PlannedChunk[][] {
  const runs: PlannedChunk[][] = []
  let current: PlannedChunk[] = []
  for (const c of chunks) {
    if (!missing.has(c.index)) {
      if (current.length) runs.push(current)
      current = []
      continue
    }
    current.push(c)
  }
  if (current.length) runs.push(current)
  return runs
}

function asBytes(v: AllowSharedBufferSource): Uint8Array {
  if (v instanceof ArrayBuffer) return new Uint8Array(v)
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer as ArrayBuffer, v.byteOffset, v.byteLength)
  return new Uint8Array(v as ArrayBufferLike)
}

function sameBytes(
  a: AllowSharedBufferSource | undefined,
  b: AllowSharedBufferSource | undefined,
): boolean {
  if (!a || !b) return a === b
  const x = asBytes(a)
  const y = asBytes(b)
  if (x.byteLength !== y.byteLength) return false
  for (let i = 0; i < x.byteLength; i++) if (x[i] !== y[i]) return false
  return true
}

/**
 * One chunk file, opened far enough to say what is inside it (task J8).
 *
 * `codec` is the FAMILY the output track has to be opened with ('avc', 'av1');
 * `config.codec` is the exact string, which for AV1 is the only thing that
 * distinguishes 4:2:0 from 4:4:4 and is what the muxer builds av1C out of.
 */
export interface OpenChunkVideo {
  index: number
  input: Input
  track: InputVideoTrack
  codec: VideoCodec
  config: VideoDecoderConfig
}

/** Only what the three rules below read — so they can be pinned without a file. */
export type ChunkTrackShape = Pick<OpenChunkVideo, 'codec' | 'config'>

async function openChunkVideo(key: string, index: number): Promise<OpenChunkVideo> {
  /**
   * J9 — A CHUNK THAT IS NOT THERE IS A RECOVERABLE MISS, NOT A DEAD EXPORT.
   *
   * `blobStore.read` throws OPFS's own NotFoundError, which is not a
   * ChunkedRenderUnavailable, so before J9 a chunk swept out from under this
   * concatenation (another tab's boot sweep — see chunkStore's sweepChunks)
   * did not fall back to anything: it came out of the export as a raw error and
   * the user's press failed outright after the whole render. Named here so the
   * caller can do the only sensible thing, which is re-render that one piece.
   */
  let blob: Blob
  try {
    blob = await blobStore.read(key)
  } catch {
    throw new ChunkedRenderUnavailable(`chunk ${index} is gone from the cache`, true)
  }
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new ChunkedRenderUnavailable(`chunk ${index} has no video track`, true)
    const codec = await track.getCodec()
    if (!codec) throw new ChunkedRenderUnavailable(`chunk ${index} names no codec`, true)
    const config = await track.getDecoderConfig()
    if (!config) throw new ChunkedRenderUnavailable(`chunk ${index} has no decoder config`, true)
    return { index, input, track, codec, config }
  } catch (err) {
    input.dispose()
    throw err
  }
}

/**
 * Can these two chunks share one track? Returns null when they can, and the
 * reason in words when they cannot — a mixed set is REFUSED, never muxed.
 *
 * All three tests matter and each catches something the others cannot:
 *   codec        'avc' packets on an 'av1' track is the failure J8 was opened
 *                for, and it is the one the muxer reports as gibberish.
 *   codec string AV1 carries no `description` at all — its av1C is GENERATED
 *                from this string by the muxer — so a 4:2:0 chunk
 *                (`av01.0.08M.08`) and a 4:4:4 one (`av01.1.08M.08.0.000…`)
 *                are byte-identical on the test below and differ only here.
 *                Compared whole and not by parts: mediabunny derives the
 *                string from the track's own av1C/avcC, so it is the same
 *                string for the same encode and a normalisation would only be
 *                a way to accept something we cannot check.
 *   description  the original avcC test: one track carries one SPS/PPS.
 */
export function sameTrack(chunk: ChunkTrackShape, reference: ChunkTrackShape): string | null {
  if (chunk.codec !== reference.codec) {
    return `is ${chunk.codec} where the first chunk is ${reference.codec}`
  }
  if (chunk.config.codec !== reference.config.codec) {
    return `is encoded as ${chunk.config.codec} where the first chunk is ${reference.config.codec}`
  }
  if (!sameBytes(chunk.config.description, reference.config.description)) {
    return 'has a different decoder description than the first'
  }
  return null
}

/** Which rung the FILE is, said in render.ts's own words. */
export function rungOf(target: Pick<EncodingTarget, 'rung' | 'videoCodec'>, reference: ChunkTrackShape): string {
  if (reference.codec === target.videoCodec) return `${target.rung}-chunked`
  // The only swap that exists today is O9(b)'s, and its profile is in the
  // string: `av01.1…` is the 4:4:4 profile (fullColour.ts).
  const swapped = reference.config.codec.startsWith('av01.1') ? 'av1-444-sw' : reference.codec
  return `${target.rung}→${swapped}-chunked`
}

/**
 * The chunked export. Throws ChunkedRenderUnavailable for anything it cannot
 * do, so the caller renders unbroken and the user never learns this existed.
 */
export async function renderChunked(opts: ChunkedRenderOptions): Promise<ExportResult> {
  const { recording, edit, signal, onProgress } = opts
  const settings = opts.settings ?? DEFAULT_EXPORT_SETTINGS
  const t0 = performance.now()
  const flags = currentRenderFlags()
  /**
   * O9(b) USED TO DECLINE HERE — deleted 2026-09-05 by J8, which is the whole
   * of that task. `?colour=all` renders chunks like any other export now,
   * because the concatenation reads the codec off them instead of assuming the
   * ladder's. What it cost while it stood is measured: a second small edit at
   * 4:4:4 re-rendered the WHOLE take (9533.9 ms, 0 of 12 chunks reused) where
   * 4:2:0 re-rendered 3 chunks in 2729.5 ms, and that gap scales with the
   * TAKE, not with the edit.
   */
  const plan = planChunks({ recording, edit, settings, flags })
  if (!plan.chunkable) throw new ChunkedRenderUnavailable(plan.unchunkableReason ?? 'no plan')

  /**
   * J9: tell every other tab that this cache is in use before touching it. The
   * claim is released in the `finally` below on every path — done, thrown or
   * aborted — and ages out on its own if this tab dies holding it.
   */
  const claim = await claimChunkCache()

  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new DOMException('Export aborted', 'AbortError')
  }
  const report = (phase: ExportProgress['phase'], ratio: number): void => {
    onProgress?.({ phase, ratio: Math.min(1, Math.max(0, ratio)) })
  }
  report('preparing', 0)

  // ---- what is already on disk -------------------------------------------
  const hashes = await Promise.all(plan.chunks.map((c) => hashDescriptor(c.descriptor)))
  const audioHash = await hashDescriptor(plan.audioDescriptor)
  const needAudio = audioPresent(recording, edit)
  const onDisk = await listChunkKeys()
  const missing = new Set<number>()
  for (const c of plan.chunks) {
    const key = chunkKeyFor(hashes[c.index]!)
    if (onDisk.has(key)) touchChunk(key)
    else missing.add(c.index)
  }
  const audioKey = chunkKeyFor(audioHash)
  const audioMissing = needAudio && !onDisk.has(audioKey)
  if (needAudio && !audioMissing) touchChunk(audioKey)

  const reused = plan.chunks.length - missing.size
  console.info(
    `[compose] chunked export: ${plan.chunks.length} chunks of ${plan.gopSec}s — ` +
      `${reused} already made, ${missing.size} to render, audio ${
        !needAudio ? 'not present' : audioMissing ? 'to render' : 'already made'
      } (J1)`,
  )
  // J7: everything up to here is the plan — chunk grid, one content hash per
  // chunk, one OPFS listing — and it runs whether or not a single frame is
  // stale. Fixed cost of pressing export, measured rather than assumed.
  const planMs = performance.now() - t0

  // Work units, so progress is honest about what is actually left to do.
  const units = missing.size + (audioMissing ? Math.max(1, Math.round(plan.chunks.length * 0.1)) : 0)
  let done = 0
  const tick = (): void => {
    done += 1
    report('rendering', 0.02 + 0.88 * (done / Math.max(1, units)))
  }

  const tRender = performance.now()
  let scratch: ExportScratch | null = null
  let output: Output | null = null
  /** The reference chunk, while it is open and before the copy loop takes it. */
  let head: OpenChunkVideo | null = null
  const stats: ChunkedRenderStats = {
    chunks: plan.chunks.length,
    reused,
    rendered: missing.size,
    audioReused: needAudio && !audioMissing,
    renderMs: 0,
    concatMs: 0,
    totalMs: 0,
    planMs: Math.round(planMs),
    muxOpenMs: 0,
    publishMs: 0,
    videoPacketsCopied: 0,
    audioPacketsCopied: 0,
    reencodedFrames: 0,
    bytes: 0,
  }
  const rollup: RenderStats = {
    frames: 0, decodeMs: 0, drawMs: 0, encodeMs: 0, audioMs: 0,
    prepareMs: 0, finalizeMs: 0, publishMs: 0,
    prep: { open: 0, probe: 0, target: 0, cq: 0, colour: 0, scratch: 0, start: 0 },
    totalMs: 0, probeDecodes: 0,
  }
  const addUp = (): void => {
    const s = getLastRenderStats()
    if (!s) return
    rollup.frames += s.frames
    rollup.decodeMs += s.decodeMs
    rollup.drawMs += s.drawMs
    rollup.encodeMs += s.encodeMs
    rollup.audioMs += s.audioMs
    rollup.prepareMs += s.prepareMs
    rollup.finalizeMs += s.finalizeMs
    // J7: the per-chunk fixed cost, summed. A chunked export pays a whole
    // prepare per chunk file, so this rollup is where the floor is visible.
    rollup.publishMs += s.publishMs
    rollup.prep.open += s.prep.open
    rollup.prep.probe += s.prep.probe
    rollup.prep.target += s.prep.target
    rollup.prep.cq += s.prep.cq
    rollup.prep.colour += s.prep.colour
    rollup.prep.scratch += s.prep.scratch
    rollup.prep.start += s.prep.start
    rollup.probeDecodes += s.probeDecodes
  }

  /**
   * DOES THE REST OF THIS TAKE STILL FIT? — J9, and it is measured, not predicted.
   *
   * The declared bitrate is a CEILING and a bad estimator (the shipped qp20
   * path came in at 10.0 Mbps against a `max` ceiling of ~45), so this asks the
   * only honest source there is: the chunks this very export has already
   * written. After a handful of them the bytes-per-chunk is known exactly, and
   * the rest of the take is that number times what is left.
   *
   * WHY IT RUNS AT ALL. `sweepChunks` is a BOOT sweep; nothing on the shipped
   * path ever asked whether an export's output fits under the cache's cap. So a
   * 90-minute take — 6.8 GB of chunks at the rate his own max60 export measured
   * — rendered for over an hour, hit a cache that could not take it, and fell
   * all the way back to an unbroken render from frame zero. Two full
   * generations. This turns that into a decision made in the first few seconds:
   * evict other takes' chunks to make the room, and if the take is simply
   * bigger than the cache can ever hold, say so NOW and render it unbroken once.
   */
  const planKeys = new Set(plan.chunks.map((c) => chunkKeyFor(hashes[c.index]!)))
  if (needAudio) planKeys.add(audioKey)
  /** Chunks written before the projection is worth trusting. */
  const ROOM_SAMPLE = 4
  /** How often the projection is re-checked once it is trusted. */
  const ROOM_EVERY = 64
  let renderedSoFar = 0
  let renderedBytes = 0
  const keepRoom = async (index: number): Promise<void> => {
    renderedSoFar += 1
    renderedBytes += await chunkSize(chunkKeyFor(hashes[index]!))
    if (renderedSoFar < ROOM_SAMPLE) return
    if (renderedSoFar > ROOM_SAMPLE && renderedSoFar % ROOM_EVERY !== 0) return
    const perChunk = renderedBytes / renderedSoFar
    const wantBytes = Math.round(perChunk * (missing.size - renderedSoFar))
    if (wantBytes <= 0) return
    const room = await makeRoomForChunks(wantBytes, planKeys)
    if (room.fits) {
      if (room.freedBytes > 0) {
        console.info(
          `[compose] chunk cache: freed ${mb(room.freedBytes)} to fit ${mb(wantBytes)} more (J9)`,
        )
      }
      return
    }
    throw new ChunkedRenderUnavailable(
      `this take needs ${mb(room.heldBytes + wantBytes)} of chunk cache and the cap is ` +
        `${mb(room.capBytes)} — rendering it unbroken instead of twice`,
      false,
    )
  }

  try {
    // ---- the video chunks that are missing, run by run --------------------
    for (const run of missingRuns(plan.chunks, missing)) {
      throwIfAborted()
      const readers = await openReadersFor(recording, edit)
      try {
        for (const chunk of run) {
          throwIfAborted()
          const hash = hashes[chunk.index]!
          const writer = await openChunkWriter(hash)
          if (!writer) {
            throw new ChunkedRenderUnavailable('the chunk cache could not be written', true)
          }
          await renderExport({
            recording,
            edit,
            settings,
            signal,
            pace: opts.pace,
            yieldEveryFrames: opts.yieldEveryFrames ?? 0,
            window: { startFrame: chunk.startFrame, endFrame: chunk.endFrame },
            tracks: 'video',
            sink: writer,
            readers,
            targetNeedsAudio: needAudio,
          })
          addUp()
          tick()
          await keepRoom(chunk.index)
        }
      } finally {
        for (const r of readers) r.dispose()
      }
    }

    // ---- the audio artifact, once ----------------------------------------
    if (audioMissing) {
      throwIfAborted()
      const writer = await openChunkWriter(audioHash)
      if (!writer) throw new ChunkedRenderUnavailable('the audio artifact could not be written')
      await renderExport({
        recording,
        edit,
        settings,
        signal,
        pace: opts.pace,
        yieldEveryFrames: opts.yieldEveryFrames ?? 0,
        tracks: 'audio',
        sink: writer,
        targetNeedsAudio: needAudio,
      })
      addUp()
      tick()
    }
    stats.renderMs = Math.round(performance.now() - tRender)

    // ---- concatenate: packet copy, never a re-encode ----------------------
    throwIfAborted()
    report('finalizing', 0.9)
    const tConcat = performance.now()
    const videoBitrate = settings.videoBitrate ?? VIDEO_BITRATE
    const target = await pickEncodingTarget(settings.width, settings.height, needAudio, videoBitrate)

    /**
     * J8 — OPEN THE TRACK FROM THE CHUNKS. The ladder says what an export WOULD
     * be encoded as; the chunks on disk say what one WAS. Only the second can
     * open a track that the packets will fit into, so the first chunk is opened
     * here, before the Output exists, and it is the reference every other chunk
     * is checked against below. It is not opened twice: the copy loop takes
     * this one for index 0.
     */
    const chunkKeys = plan.chunks.map((c) => chunkKeyFor(hashes[c.index]!))
    const firstKey = chunkKeys[0]
    if (!firstKey) throw new ChunkedRenderUnavailable('the plan has no chunks to concatenate')
    const reference = await openChunkVideo(firstKey, plan.chunks[0]!.index)
    head = reference

    scratch = await createExportScratch()
    const bufferTarget = scratch ? null : new BufferTarget()
    const out = new Output({ format: target.format, target: scratch ? scratch.target : bufferTarget! })
    output = out
    out.setMetadataTags({
      title: 'INOUT recording',
      comment: certificationComment(
        buildCertification({
          recording,
          path: 'render',
          settings: {
            width: settings.width,
            height: settings.height,
            fps: settings.fps,
            videoBitrate,
          },
          audioChannels: needAudio ? recording.channels.filter((c) => c.media === 'audio').length : 0,
          cuts: Math.max(0, keptSegments(edit).length - 1),
          codec: {
            container: target.mimeType,
            // J8: what the file IS, read off the chunks — not what the ladder
            // would have picked. A certification that names the wrong codec is
            // exactly the unanswerable size/quality report O8 exists to prevent.
            video: reference.codec,
            audio: needAudio ? target.audioCodec : undefined,
            gopSec: settings.keyFrameIntervalSec ?? keyframeIntervalSec(),
            rung: rungOf(target, reference),
            qp: flags.cq ?? undefined,
          },
        }),
      ),
    })
    const videoSource = new EncodedVideoPacketSource(reference.codec)
    out.addVideoTrack(videoSource)
    let audioSource: EncodedAudioPacketSource | null = null
    if (needAudio) {
      audioSource = new EncodedAudioPacketSource(target.audioCodec)
      out.addAudioTrack(audioSource)
    }
    await out.start()
    stats.muxOpenMs = Math.round(performance.now() - tConcat)

    let firstVideo = true
    for (let i = 0; i < plan.chunks.length; i++) {
      throwIfAborted()
      const chunk = plan.chunks[i]!
      // Index 0 is already open — it is what the track above was opened FROM.
      const opened = i === 0 ? reference : await openChunkVideo(chunkKeys[i]!, chunk.index)
      if (i === 0) head = null
      try {
        // ONE TRACK CARRIES ONE DECODER DESCRIPTION. Refuse a set that does not
        // agree rather than ship a file half of which decodes to garbage; the
        // unbroken render is right there. `sameTrack` is what "agree" means.
        const disagreement = sameTrack(opened, reference)
        if (disagreement) {
          // J9: the odd one out is DROPPED, so a second pass re-renders exactly
          // it against the ladder the rest of the set already agrees on. Before
          // this the whole take re-rendered unbroken over one stale piece.
          await removeChunk(chunkKeys[i]!)
          throw new ChunkedRenderUnavailable(`chunk ${chunk.index} ${disagreement}`, true)
        }
        const sink = new EncodedPacketSink(opened.track)
        for await (const packet of sink.packets()) {
          throwIfAborted()
          const at = chunk.startSec + packet.timestamp
          if (at < -EPS_SEC) {
            throw new ChunkedRenderUnavailable(`chunk ${chunk.index} packet at ${at}s`)
          }
          const shifted = new EncodedPacket(
            packet.data,
            packet.type,
            Math.max(0, at),
            packet.duration,
          )
          await videoSource.add(shifted, firstVideo ? { decoderConfig: reference.config } : undefined)
          firstVideo = false
          stats.videoPacketsCopied++
        }
      } finally {
        opened.input.dispose()
      }
    }
    videoSource.close()

    if (audioSource) {
      const blob = await blobStore.read(audioKey)
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
      try {
        const track = await input.getPrimaryAudioTrack()
        if (!track) throw new ChunkedRenderUnavailable('the audio artifact has no audio track')
        // J8's rule on the other track: the artifact was encoded by the ladder
        // too, so this can only disagree if the ladder answered differently
        // between the render and here — refuse it rather than mis-mux it.
        const artifactCodec = await track.getCodec()
        if (artifactCodec !== target.audioCodec) {
          throw new ChunkedRenderUnavailable(
            `the audio artifact is ${artifactCodec} where the track is ${target.audioCodec}`,
          )
        }
        const config = await track.getDecoderConfig()
        if (!config) throw new ChunkedRenderUnavailable('the audio artifact has no decoder config')
        const sink = new EncodedPacketSink(track)
        let first = true
        for await (const packet of sink.packets()) {
          throwIfAborted()
          // The artifact spans the whole output already: copied as it stands,
          // timestamps untouched, which is why it cannot click.
          await audioSource.add(packet, first ? { decoderConfig: config } : undefined)
          first = false
          stats.audioPacketsCopied++
        }
      } finally {
        input.dispose()
      }
      audioSource.close()
    }

    throwIfAborted()
    await out.finalize()
    stats.concatMs = Math.round(performance.now() - tConcat)

    let blob: Blob
    const tPublish = performance.now()
    if (scratch) {
      blob = await scratch.finish(target.mimeType)
    } else {
      const buffer = bufferTarget?.buffer
      if (!buffer) throw new ChunkedRenderUnavailable('the muxer produced no output')
      blob = new Blob([buffer], { type: target.mimeType })
    }
    stats.publishMs = Math.round(performance.now() - tPublish)
    report('finalizing', 1)

    stats.bytes = blob.size
    stats.totalMs = Math.round(performance.now() - t0)
    lastStats = stats
    rollup.totalMs = stats.totalMs
    setLastRenderStats(rollup)
    console.info(
      `[compose] chunked export done — ${stats.chunks} chunks (${stats.reused} reused, ` +
        `${stats.rendered} rendered), audio ${stats.audioReused ? 'reused' : 'rendered'}; ` +
        `plan ${stats.planMs}ms + render ${stats.renderMs}ms + concat ${stats.concatMs}ms ` +
        `(mux open ${stats.muxOpenMs}ms) + publish ${stats.publishMs}ms; ` +
        `${stats.videoPacketsCopied} video and ${stats.audioPacketsCopied} audio packets COPIED, ` +
        `${stats.reencodedFrames} re-encoded (J1)`,
    )

    const durationMs = keptSegments(edit).reduce(
      (acc, s) => acc + (s.endMs - s.startMs) / segmentSpeed(s),
      0,
    )
    return {
      blob,
      mimeType: target.mimeType,
      fileName: exportFileName(recording.createdAt, target.fileExtension),
      durationMs: Math.round(durationMs),
      width: settings.width,
      height: settings.height,
      scratchKey: scratch?.key,
    }
  } catch (err) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel().catch(() => undefined)
    }
    // Open between the probe and the copy loop's first turn, and nobody else's
    // to close on the way out.
    head?.input.dispose()
    await scratch?.discard().catch(() => undefined)
    throw err
  } finally {
    await claim?.release()
  }
}

/**
 * THE CHUNKED EXPORT, AND ONE SECOND CHANCE — J9. This is what callers use.
 *
 * `renderChunked` gives up by throwing, and every caller answers a throw the
 * same way: render the whole take unbroken, from frame zero. That answer is
 * right when the take cannot be chunked at all and catastrophically wrong when
 * one 2.5-second piece went missing under an otherwise sound plan — it was the
 * difference between re-rendering 2.5 seconds and re-rendering 90 minutes on a
 * machine that renders max60 at about one times realtime.
 *
 * So a RECOVERABLE failure re-enters instead. Nothing is passed between the two
 * attempts and nothing needs to be: the plan is deterministic and the cache is
 * content-addressed, so the second pass re-lists the disk, finds every chunk
 * the first pass made, and renders only the ones that are gone. Exactly once —
 * a second failure means the disk is losing chunks faster than we make them,
 * and an unbroken render is then genuinely the shorter road.
 */
export async function renderChunkedResuming(
  opts: ChunkedRenderOptions,
  /** Test seam. The retry policy is the thing worth pinning, and it cannot be
   *  reached through a real render without a browser and an hour. */
  attempt: (o: ChunkedRenderOptions) => Promise<ExportResult> = renderChunked,
): Promise<ExportResult> {
  try {
    return await attempt(opts)
  } catch (err) {
    if (!(err instanceof ChunkedRenderUnavailable) || !err.recoverable) throw err
    console.info(`[compose] ${err.message} — resuming from what is on disk (J9)`)
    return await attempt(opts)
  }
}

/** What the plan would do, without doing it — for rigs and for evidence. */
export function describePlan(input: {
  recording: Recording
  edit: EditState
  settings?: ExportSettings
}): ChunkPlan {
  return planChunks({ ...input, flags: currentRenderFlags() })
}

/** One piece of the output as something that can be shipped on its own. */
export interface ShippableChunk {
  index: number
  startSec: number
  endSec: number
  /** OPFS key. Present on disk only when `ready`. */
  key: string
  ready: boolean
  bytes: number
}

/**
 * THE SHIPPING CURSOR, which is the same cursor as the render's and the
 * resume's — that is the point of naming a file by its content.
 *
 * An uploader for multi-device or an instant link wants exactly this: the
 * output in order, each piece finished and immutable, each one nameable before
 * it exists so a transfer can be planned against a render that is still
 * running. It needs no new bookkeeping because there is none to add — a piece
 * is ready when its file is there, and its file is there only when it is whole.
 *
 * Nothing ships anything yet. This is the seam, exported so the uploader that
 * comes later cannot invent a second answer to "which parts are done".
 */
export async function shippableChunks(input: {
  recording: Recording
  edit: EditState
  settings?: ExportSettings
}): Promise<ShippableChunk[]> {
  const plan = describePlan(input)
  const onDisk = await listChunkKeys()
  const out: ShippableChunk[] = []
  for (const c of plan.chunks) {
    const key = chunkKeyFor(await hashDescriptor(c.descriptor))
    const bytes = onDisk.get(key) ?? 0
    out.push({ index: c.index, startSec: c.startSec, endSec: c.endSec, key, ready: bytes > 0, bytes })
  }
  return out
}
