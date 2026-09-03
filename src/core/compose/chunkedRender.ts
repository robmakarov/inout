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
import { audioPresent, planChunks, type ChunkPlan, type PlannedChunk, type RenderFlagPrint } from './chunkPlan'
import {
  chunkKeyFor,
  hashDescriptor,
  listChunkKeys,
  openChunkWriter,
  touchChunk,
} from './chunkStore'
import { buildCertification, certificationComment } from './certify'
import { KEYFRAME_INTERVAL_SEC, VIDEO_BITRATE, pickEncodingTarget } from './codecs'
import { constantQualityQp } from './constantQuality'
import { loudnessMode } from './loudnessMode'
import { sourceFrameEnabled } from '@core/frame'
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

export class ChunkedRenderUnavailable extends Error {
  constructor(reason: string) {
    super(`chunked render: ${reason}`)
    this.name = 'ChunkedRenderUnavailable'
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

/** The flags the plan has to print, read where they can be read. */
export function currentRenderFlags(): RenderFlagPrint {
  return { cq: constantQualityQp(), loudness: loudnessMode(), sourceFrame: sourceFrameEnabled() }
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
 * The chunked export. Throws ChunkedRenderUnavailable for anything it cannot
 * do, so the caller renders unbroken and the user never learns this existed.
 */
export async function renderChunked(opts: ChunkedRenderOptions): Promise<ExportResult> {
  const { recording, edit, signal, onProgress } = opts
  const settings = opts.settings ?? DEFAULT_EXPORT_SETTINGS
  const t0 = performance.now()
  const flags = currentRenderFlags()
  const plan = planChunks({ recording, edit, settings, flags })
  if (!plan.chunkable) throw new ChunkedRenderUnavailable(plan.unchunkableReason ?? 'no plan')

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
  const stats: ChunkedRenderStats = {
    chunks: plan.chunks.length,
    reused,
    rendered: missing.size,
    audioReused: needAudio && !audioMissing,
    renderMs: 0,
    concatMs: 0,
    totalMs: 0,
    videoPacketsCopied: 0,
    audioPacketsCopied: 0,
    reencodedFrames: 0,
    bytes: 0,
  }
  const rollup: RenderStats = {
    frames: 0, decodeMs: 0, drawMs: 0, encodeMs: 0, audioMs: 0,
    prepareMs: 0, finalizeMs: 0, totalMs: 0, probeDecodes: 0,
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
    rollup.probeDecodes += s.probeDecodes
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
          if (!writer) throw new ChunkedRenderUnavailable('the chunk cache could not be written')
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
            video: target.videoCodec,
            audio: needAudio ? target.audioCodec : undefined,
            gopSec: settings.keyFrameIntervalSec ?? KEYFRAME_INTERVAL_SEC,
            rung: `${target.rung}-chunked`,
            qp: flags.cq ?? undefined,
          },
        }),
      ),
    })
    const videoSource = new EncodedVideoPacketSource(target.videoCodec)
    out.addVideoTrack(videoSource)
    let audioSource: EncodedAudioPacketSource | null = null
    if (needAudio) {
      audioSource = new EncodedAudioPacketSource(target.audioCodec)
      out.addAudioTrack(audioSource)
    }
    await out.start()

    let firstDescription: AllowSharedBufferSource | undefined
    let firstVideo = true
    for (const chunk of plan.chunks) {
      throwIfAborted()
      const blob = await blobStore.read(chunkKeyFor(hashes[chunk.index]!))
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
      try {
        const track = await input.getPrimaryVideoTrack()
        if (!track) throw new ChunkedRenderUnavailable(`chunk ${chunk.index} has no video track`)
        const config = await track.getDecoderConfig()
        if (!config) throw new ChunkedRenderUnavailable(`chunk ${chunk.index} has no decoder config`)
        if (firstVideo) {
          firstDescription = config.description
        } else if (!sameBytes(config.description, firstDescription)) {
          /**
           * ONE TRACK CARRIES ONE avcC. Two chunks whose encoders describe
           * their bitstreams differently cannot share it — half the file would
           * decode to garbage. Refuse the path rather than ship that; the
           * unbroken render is right there.
           */
          throw new ChunkedRenderUnavailable(
            `chunk ${chunk.index} has a different decoder description than the first`,
          )
        }
        const sink = new EncodedPacketSink(track)
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
          await videoSource.add(shifted, firstVideo ? { decoderConfig: config } : undefined)
          firstVideo = false
          stats.videoPacketsCopied++
        }
      } finally {
        input.dispose()
      }
    }
    videoSource.close()

    if (audioSource) {
      const blob = await blobStore.read(audioKey)
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
      try {
        const track = await input.getPrimaryAudioTrack()
        if (!track) throw new ChunkedRenderUnavailable('the audio artifact has no audio track')
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
    if (scratch) {
      blob = await scratch.finish(target.mimeType)
    } else {
      const buffer = bufferTarget?.buffer
      if (!buffer) throw new ChunkedRenderUnavailable('the muxer produced no output')
      blob = new Blob([buffer], { type: target.mimeType })
    }
    report('finalizing', 1)

    stats.bytes = blob.size
    stats.totalMs = Math.round(performance.now() - t0)
    lastStats = stats
    rollup.totalMs = stats.totalMs
    setLastRenderStats(rollup)
    console.info(
      `[compose] chunked export done — ${stats.chunks} chunks (${stats.reused} reused, ` +
        `${stats.rendered} rendered), audio ${stats.audioReused ? 'reused' : 'rendered'}; ` +
        `render ${stats.renderMs}ms + concat ${stats.concatMs}ms; ` +
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
    await scratch?.discard().catch(() => undefined)
    throw err
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
