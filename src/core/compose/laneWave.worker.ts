/**
 * THE WAVEFORM LANE, OFF THE MAIN THREAD (task B10).
 *
 * WHY THIS EXISTS AND THE FILMSTRIP HAS NO TWIN. G7's instrument measured the
 * editor stall on the built bundle and named the blocking task: `output() via
 * AudioDataOutputCallback`, 192.7 ms of BLOCKING inside a 269 ms frame. The
 * filmstrip's `VideoFrameOutputCallback` sits in the same task list with
 * 442.7 ms of duration and ZERO blocking — it yields, so it costs the drag
 * nothing. An audio decoder's output callback does not: it delivers its
 * packets synchronously, and on the main thread that is a frame the editor
 * does not get to draw.
 *
 * The whole of `buildLaneWave` was already worker-safe — mediabunny plus an
 * OffscreenCanvas, no DOM anywhere in it — so this moves it rather than
 * reimplementing it. One waveform per message; the hook keeps its own "one
 * channel at a time, video first" ordering, which is what stops several
 * decoders racing for the same hardware.
 *
 * THE MAIN-THREAD PATH STAYS. `useLaneArt` falls back to calling
 * `buildLaneWave` directly if a worker cannot be constructed, because a lane
 * decoration must never be the reason an editor fails to open.
 */
import { buildLaneWave, type LaneWave } from './lanewave'

export interface LaneWaveRequest {
  id: string
  blob: Blob
  durationSec: number
  width: number
  height: number
  columns?: number
}

export interface LaneWaveReply {
  id: string
  wave: LaneWave | null
  error?: string
}

self.onmessage = async (ev: MessageEvent<LaneWaveRequest>): Promise<void> => {
  const { id, blob, durationSec, width, height, columns } = ev.data
  try {
    const wave = await buildLaneWave(blob, durationSec, width, height, { columns })
    const reply: LaneWaveReply = { id, wave }
    self.postMessage(reply)
  } catch (err) {
    // Silent and total, exactly as the inline path fails: the lane simply looks
    // the way it did before F8.
    const reply: LaneWaveReply = { id, wave: null, error: String(err) }
    self.postMessage(reply)
  }
}
