/**
 * The export, off the main thread (task O5a).
 *
 * The render is a decode/draw/encode loop that used to run where the UI runs.
 * It was polite about it — a setTimeout every 8 frames — but polite is not the
 * same as absent: the yields cost real wall-clock, and between them a slow
 * frame still blocked paint. Here there is nothing to block, so the yields are
 * gone (render.ts, yieldEveryFrames 0) and the loop runs flat out.
 *
 * The protocol is deliberately small: one 'start' in, progress out, one
 * terminal message. Everything the render needs is either structured-cloneable
 * (Recording, EditState, ExportSettings — all plain data by contract) or is
 * opened here from OPFS, which a worker reaches exactly as the main thread
 * does. The finished blob goes back as a Blob: it is disk-backed by the export
 * scratch (O1), so cloning it copies a handle, not 1.8 GB of file.
 *
 * Abort crosses the boundary as a message, not a signal — AbortSignal is not
 * cloneable — and is re-made into a local AbortController here.
 */
import type {
  EditState,
  ExportProgress,
  ExportResult,
  ExportSettings,
  Recording,
  WorkPace,
} from '@core/types'
import { setInlinePositionedWriterEnabled } from '@core/store'
import { setSourceFrame } from '@core/frame'
import { getLastRenderStats, renderExport, type RenderStats } from './render'
import {
  ChunkedRenderUnavailable,
  getLastChunkedStats,
  renderChunked,
  type ChunkedRenderStats,
} from './chunkedRender'
import { chunkedRenderActive as chunkedActive, setChunkedRenderOverride } from './chunkedFlag'
import { setConstantQualityOverride } from './constantQuality'
import { setKeyframeIntervalOverride } from './keyframeInterval'
import { setFullColourOverride } from './fullColour'
import { separateAudioTracks, setAudioTrackModeOverride, type AudioTrackMode } from './audioTracks'
import { setNoiseGateOverride } from './gateFlag'
import { setLoudnessMode, type LoudnessMode } from './loudnessMode'
import { getLastScratchStats, setExportScratchEnabled, type ScratchStats } from './scratch'

export type ExportWorkerIn =
  | {
      type: 'start'
      recording: Recording
      edit: EditState
      settings?: ExportSettings
      /**
       * Evidence levers. The worker has its OWN module instances, so a rig
       * flipping a flag on the main thread flips it on a thread that does not
       * render; both are forwarded here instead. Absent = the shipped path.
       */
      inlineScratchWriter?: boolean
      scratchEnabled?: boolean
      /**
       * EVERY FLAG THE RENDER ITSELF READS, decided on the thread that can
       * actually read them. A worker has no `localStorage` and its `location`
       * is its own script URL, so a getter called in here answers its DEFAULT
       * no matter what the page was opened with. Three switches were silently
       * dead on the shipped path because of it — see the note in pipeline.ts.
       */
      flags?: {
        cq?: number | null
        loudness?: LoudnessMode
        sourceFrame?: boolean
        /** J1's `?chunked=` — the render that remembers. Default off. */
        chunked?: boolean
        /** O9(b)'s `?colour=all` — the 4:4:4 rung. Default off. */
        fullColour?: boolean
        audioTracks?: AudioTrackMode
        /** O10c's `?noisegate=` — deterministic spectral gating. Default off. */
        noiseGate?: boolean
        /** `?gop=` — the keyframe interval, which is also J1's chunk grid. */
        gop?: number
      }
      /**
       * F16b: this render is a BACKGROUND job and obeys the elastic brake.
       * The pace itself arrives as `pace` messages — the broker that decides
       * it reads capture's pressure instrument, which lives on the main
       * thread, and a `PaceSource` is a pair of functions and not cloneable.
       */
      paced?: boolean
      /** The pace at the moment the job started, so a job that begins while a
       *  take is already running does not spend a whole message round trip at
       *  full speed. */
      pace?: WorkPace
    }
  | { type: 'abort' }
  | { type: 'pace'; level: WorkPace }

export type ExportWorkerOut =
  | { type: 'progress'; progress: ExportProgress }
  | {
      type: 'done'
      result: ExportResult
      stats: RenderStats | null
      scratch: ScratchStats | null
      /** J1: what the chunk cache did, when it ran. Null on the unbroken path. */
      chunked: ChunkedRenderStats | null
    }
  | { type: 'error'; message: string; name: string }

const abort = new AbortController()
let started = false

// ---- F16b: the pace, as this thread sees it -------------------------------
// A mirror of the main thread's broker, updated by message. The render builds
// its gate over this, so the mechanism in paceGate.ts is the same one the
// in-thread fallback render uses — one implementation, two sources.
let paceLevel: WorkPace = 'full'
const paceListeners = new Set<(level: WorkPace) => void>()
const paceSource = {
  level: (): WorkPace => paceLevel,
  subscribe: (cb: (level: WorkPace) => void): (() => void) => {
    paceListeners.add(cb)
    return () => paceListeners.delete(cb)
  },
}

self.onmessage = (ev: MessageEvent<ExportWorkerIn>): void => {
  const msg = ev.data
  if (msg.type === 'abort') {
    abort.abort()
    // A paused render is asleep inside its gate; waking it is what lets the
    // abort be noticed at once rather than at the end of a nap.
    for (const cb of paceListeners) cb(paceLevel)
    return
  }
  if (msg.type === 'pace') {
    paceLevel = msg.level
    for (const cb of paceListeners) cb(paceLevel)
    return
  }
  if (msg.type !== 'start' || started) return
  started = true
  void run(msg)
}

async function run(msg: Extract<ExportWorkerIn, { type: 'start' }>): Promise<void> {
  const post = (m: ExportWorkerOut): void => self.postMessage(m)
  if (msg.inlineScratchWriter === false) setInlinePositionedWriterEnabled(false)
  if (msg.scratchEnabled === false) setExportScratchEnabled(false)
  if (msg.flags) {
    // Absent means "the page did not say", which must stay distinct from
    // "the page said off" — hence the `in` checks rather than truthiness.
    if ('cq' in msg.flags) setConstantQualityOverride(msg.flags.cq)
    if (msg.flags.loudness) setLoudnessMode(msg.flags.loudness)
    if (typeof msg.flags.sourceFrame === 'boolean') setSourceFrame(msg.flags.sourceFrame)
    if (typeof msg.flags.chunked === 'boolean') setChunkedRenderOverride(msg.flags.chunked)
    if (typeof msg.flags.fullColour === 'boolean') setFullColourOverride(msg.flags.fullColour)
    if (typeof msg.flags.gop === 'number') setKeyframeIntervalOverride(msg.flags.gop)
    if (msg.flags.audioTracks) setAudioTrackModeOverride(msg.flags.audioTracks)
    if (typeof msg.flags.noiseGate === 'boolean') setNoiseGateOverride(msg.flags.noiseGate)
  }
  if (msg.pace) paceLevel = msg.pace
  try {
    /**
     * J1 — THE RENDER THAT REMEMBERS, tried first when it is armed and never
     * the only path: anything it declines (no video to chunk, a chunk cache
     * that will not open, an avcC that disagrees between chunks) falls through
     * to the unbroken render below, which is the export that shipped.
     *
     * An ABORT is not a decline. A user who cancelled must not be answered
     * with a second, slower render of the thing they cancelled.
     */
    /**
     * O10b DECLINES THE CHUNKED PATH BY NAME. J1's concatenation copies packets
     * into ONE audio track (chunkedRender.ts), so a separate-track render would
     * have its extra tracks silently dropped at the join — the file would play
     * and be wrong, which is the worst shape a defect can take. Until the
     * concatenation carries N tracks, asking for separate tracks takes the
     * unbroken render, and says so rather than leaving it to be discovered.
     */
    if (chunkedActive() && separateAudioTracks()) {
      console.info(
        '[compose] separate audio tracks asked for: the chunked render is declined ' +
          '(its concatenation carries one audio track), rendering unbroken',
      )
    }
    if (chunkedActive() && !separateAudioTracks()) {
      try {
        const result = await renderChunked({
          recording: msg.recording,
          edit: msg.edit,
          settings: msg.settings,
          signal: abort.signal,
          pace: msg.paced ? paceSource : undefined,
          yieldEveryFrames: 0,
          onProgress: (progress) => post({ type: 'progress', progress }),
        })
        post({
          type: 'done',
          result,
          stats: getLastRenderStats(),
          scratch: getLastScratchStats(),
          chunked: getLastChunkedStats(),
        })
        return
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err
        if (!(err instanceof ChunkedRenderUnavailable)) throw err
        console.info('[compose] chunked export declined, rendering unbroken —', err.message)
      }
    }
    const result = await renderExport({
      recording: msg.recording,
      edit: msg.edit,
      settings: msg.settings,
      signal: abort.signal,
      pace: msg.paced ? paceSource : undefined,
      // Nothing shares this thread: never sleep.
      yieldEveryFrames: 0,
      onProgress: (progress) => post({ type: 'progress', progress }),
    })
    post({
      type: 'done',
      result,
      stats: getLastRenderStats(),
      scratch: getLastScratchStats(),
      chunked: null,
    })
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    post({ type: 'error', message: e.message, name: e.name })
  }
}
