/**
 * X11a — THE PCM TAP'S READER, OFF THE MAIN THREAD.
 *
 * WHAT THIS FIXES, measured before it was written. B12 (2026-09-04) established
 * that `MediaStreamTrackProcessor` does not wait for a starved reader — it
 * DROPS — and that the platform holds only ~87 ms. B12 raised that to 4 s with
 * `maxBufferSize`; this removes the deadline instead of widening it, because a
 * reader on its own thread is never the thing that is late.
 *
 * THE PREMISE WAS PROBED FIRST, and it was not obvious: a transferred
 * ReadableStream could have been a proxy whose crank the ORIGINAL thread still
 * turns, in which case moving the reader would buy exactly nothing.
 * `scripts/x11a-workertap.mjs`, prod Chrome, a 21 s window with 20.0 s of the
 * main thread deliberately blocked and the processor pinned to the platform's
 * own 32-quantum buffer:
 *
 *   reader on the main thread   delivered  3.6 / 3.9 s   gap 13.8 / 15.3 s, worst 1730 ms
 *   reader in this worker       delivered 21.1 / 21.1 s   gap  0.70 / 0.70 s, worst    3 ms
 *
 * 0.70 s over 21 s is the SOURCE's own floor (33 ms/s, the same rate B12's
 * undosed control reads), not a loss: every gap in it is under 3 ms. So the
 * whole of the main thread's 20 s stall costs this path nothing.
 *
 * WHAT IT DOES NOT DO. The encoder, the wall-clock hold and the mix still run
 * on the main thread — batches simply arrive there in bulk when it wakes,
 * instead of being thrown away while it sleeps. Moving the rest is X11, which
 * is a capture change and Robert's to say yes to.
 *
 * The batching is the SAME 1024 frames the main-thread pump used
 * (measuredAudio.ts, TRACK_BATCH_FRAMES): ~43 messages a second rather than the
 * 344 a raw quantum stream would cost.
 */

/** Frames per batch handed to the main thread — measuredAudio's own constant. */
const TRACK_BATCH_FRAMES = 1024
/** Below this a step in media time is rounding, not a dropped quantum. */
const TAP_GAP_FLOOR_US = 1_000

export interface AudioTapOpen {
  cmd: 'open'
  /** Transferred. The processor is built on the main thread; only the read moves. */
  readable: ReadableStream<AudioData>
  sampleRate: number
  /** Bumped on every revival so a retiring pump's batches can be ignored. */
  generation: number
}

export interface AudioTapClose {
  cmd: 'close'
  generation: number
}

export type AudioTapMsg = AudioTapOpen | AudioTapClose

export interface AudioTapBatch {
  type: 'batch'
  generation: number
  frames: number
  channels: number
  /** `AudioData.timestamp` of the batch's LAST chunk, seconds — what the main
   *  thread's anchor used to read off the chunk it had just taken. */
  lastChunkTimeS: number
  planar: Float32Array
  /** B12's instrument, computed where the chunks actually are. Cumulative µs. */
  tapGapUs: number
  tapMaxGapUs: number
  /**
   * WHEN THIS BATCH ARRIVED, ON THIS WORKER'S OWN `performance.now()` — and it
   * is the reason moving the reader does not move the sound.
   *
   * The anchor dates sample 0 from when batches ARRIVE (measuredAudio.ts), so a
   * reader one thread away would place every take later by the cost of a
   * postMessage: measured at +14 ms (anchor 88.3 -> 102.1 ms) before this field
   * existed, on a seam X14a has already shown is 10.8-17.7 ms late. A min-filter
   * strips jitter, never a constant, so it could not have absorbed it.
   *
   * IT USED TO BE SENT AS `performance.timeOrigin + performance.now()`, on the
   * premise that the sum is a clock both realms agree on. It is not, and the
   * bill was Robert's 46-minute take opening as 553 minutes with the sound 8 h
   * 27 min after the picture — see core/realmClock.ts for the measurement and
   * the mechanism. So the stamp is now this realm's own reading and NOTHING
   * ELSE; the main thread converts it with an offset it measures from these
   * very messages (RealmOffset), which is a constant no sleep can move.
   */
  workerNowMs: number
}

export interface AudioTapEnded {
  type: 'ended'
  generation: number
}

export type AudioTapReply = AudioTapBatch | AudioTapEnded

interface Pump {
  reader: ReadableStreamDefaultReader<AudioData>
  stopped: boolean
}

const pumps = new Map<number, Pump>()

function post(msg: AudioTapReply, transfer: Transferable[] = []): void {
  ;(self as unknown as { postMessage: (m: unknown, t: Transferable[]) => void }).postMessage(
    msg,
    transfer,
  )
}

async function pump(gen: number, readable: ReadableStream<AudioData>, rate: number): Promise<void> {
  const reader = readable.getReader()
  const me: Pump = { reader, stopped: false }
  pumps.set(gen, me)

  let pending: Float32Array[][] = []
  let pendingFrames = 0
  let pendingChannels = 1
  let lastChunkTimeS = 0
  let prevEndUs: number | null = null
  let gapUs = 0
  let maxGapUs = 0

  const flush = (): void => {
    if (!pendingFrames) return
    const ch = pendingChannels
    const total = pendingFrames
    const planar = new Float32Array(ch * total)
    let off = 0
    for (const chunk of pending) {
      const n = chunk[0]?.length ?? 0
      for (let c = 0; c < ch; c++) planar.set(chunk[Math.min(c, chunk.length - 1)]!, c * total + off)
      off += n
    }
    pending = []
    pendingFrames = 0
    post(
      {
        type: 'batch',
        generation: gen,
        frames: total,
        channels: ch,
        lastChunkTimeS,
        planar,
        tapGapUs: gapUs,
        tapMaxGapUs: maxGapUs,
        workerNowMs: performance.now(),
      },
      [planar.buffer],
    )
  }

  for (;;) {
    if (me.stopped) break
    let res: ReadableStreamReadResult<AudioData>
    try {
      res = await reader.read()
    } catch {
      break
    }
    if (res.done) break
    const data = res.value
    try {
      if (me.stopped) break
      const n = data.numberOfFrames
      if (!n) continue
      const ch = Math.min(2, Math.max(1, data.numberOfChannels))
      const planes: Float32Array[] = []
      for (let c = 0; c < ch; c++) {
        const buf = new Float32Array(n)
        data.copyTo(buf, { planeIndex: c, format: 'f32-planar' })
        planes.push(buf)
      }
      lastChunkTimeS = data.timestamp / 1_000_000
      if (prevEndUs !== null) {
        const g = data.timestamp - prevEndUs
        if (g > TAP_GAP_FLOOR_US) {
          gapUs += g
          if (g > maxGapUs) maxGapUs = g
        }
      }
      prevEndUs = data.timestamp + Math.round((n / rate) * 1_000_000)
      pendingChannels = Math.max(pendingChannels, ch)
      pending.push(planes)
      pendingFrames += n
      if (pendingFrames >= TRACK_BATCH_FRAMES) flush()
    } catch {
      // A chunk that will not convert is not silence. Dropping it here would
      // splice the timeline; the wall-clock hold repays it as the loss it is.
    } finally {
      data.close()
    }
  }

  // The tail: whatever is in hand when the track ends belongs to the take.
  flush()
  pumps.delete(gen)
  post({ type: 'ended', generation: gen })
  void reader.cancel().catch(() => undefined)
}

self.onmessage = (ev: MessageEvent<AudioTapMsg>): void => {
  const msg = ev.data
  if (msg.cmd === 'open') {
    void pump(msg.generation, msg.readable, msg.sampleRate)
    return
  }
  if (msg.cmd === 'close') {
    const p = pumps.get(msg.generation)
    if (!p) return
    p.stopped = true
    void p.reader.cancel().catch(() => undefined)
  }
}
