/**
 * EXPERIMENTAL — X4 evidence: decode one channel's whole render schedule on a
 * thread that is not the render's, and say what it cost.
 *
 * THIS WAS A PRODUCTION PATH FOR HALF A DAY AND IS NOT ONE ANY MORE. X4 step 1
 * built a decode FARM — one worker per video channel, the schedule sent up
 * front, decoded frames pushed ahead of the render inside a credit window — and
 * it produced a byte-identical file at 0.99-1.08× the speed against a gate that
 * asked for ≥2×. The farm is deleted; this probe is what is left, because the
 * verdict has to stay re-runnable (note 13's precedent: the encode lookahead and
 * the decoder prefetch pump were deleted too, and the rig still prints the floor
 * that refutes them).
 *
 * WHAT IT MEASURES, and the three numbers together are the whole refutation:
 *   alone            decode the schedule with nothing else running
 *   during a render  the same, while an export of the same take runs
 *   in-thread        the render's own decodeFloor, for the same frames
 * A worker decodes at 0.93-1.04× the main thread ALONE, and 3.7-5× slower while
 * the render encodes beside it. The decode is not thread-bound; it is competing
 * for something a second thread does not create.
 *
 * The picture is DROPPED, never handed back — the handoff was measured
 * separately at 0.4 % of a render (57-117 ms of 18-26 s) and is not the cost.
 */
import { blobStore } from '@core/store'
import type { ChannelKind } from '@core/types'
import { openVideoChannel, type VideoChannelReader } from '@core/compose/video'

export interface DecodeSiteStart {
  type: 'start'
  blobKey: string
  channelId: string
  kind: ChannelKind
  localEndSec: number
  /** Local source seconds per render step, in order. Negative = no contribution. */
  times: Float64Array
}

export type DecodeSiteIn = DecodeSiteStart | { type: 'stop' }

export type DecodeSiteOut =
  | { type: 'opened'; hasTrack: boolean }
  | { type: 'end'; decodeMs: number; runMs: number; frames: number; repeats: number }
  | { type: 'error'; message: string }

let stopped = false
let started = false

self.onmessage = (ev: MessageEvent<DecodeSiteIn>): void => {
  const msg = ev.data
  if (msg.type === 'stop') {
    stopped = true
    return
  }
  if (started) return
  started = true
  void run(msg)
}

async function run(msg: DecodeSiteStart): Promise<void> {
  const post = (m: DecodeSiteOut): void => self.postMessage(m)
  let reader: VideoChannelReader | null = null
  try {
    const blob = await blobStore.read(msg.blobKey)
    reader = await openVideoChannel(blob, msg.channelId, msg.kind, msg.localEndSec)
    if (!reader) {
      post({ type: 'opened', hasTrack: false })
      post({ type: 'end', decodeMs: 0, runMs: 0, frames: 0, repeats: 0 })
      return
    }
    post({ type: 'opened', hasTrack: true })
    let last: unknown = null
    let frames = 0
    let repeats = 0
    let decodeMs = 0
    const tRun = performance.now()
    for (let i = 0; i < msg.times.length; i++) {
      if (stopped) return
      const t = msg.times[i]!
      if (t < 0) continue
      const t0 = performance.now()
      const sample = await reader.sampleAt(t)
      decodeMs += performance.now() - t0
      if (!sample) continue
      if (sample === last) {
        repeats++
        continue
      }
      last = sample
      frames++
    }
    post({ type: 'end', decodeMs, runMs: performance.now() - tRun, frames, repeats })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  } finally {
    reader?.dispose()
  }
}
