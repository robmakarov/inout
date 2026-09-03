import { useEffect, useRef, useState } from 'react'
import type { Recording } from '@core/types'
import { blobStore } from '@core/store'
import { planFilmstrip } from '@app/lib/filmstripPlan'
import type { LaneWave } from '@core/compose/lanewave'
import type { LaneWaveReply, LaneWaveRequest } from '@core/compose/laneWave.worker'

/**
 * What each timeline lane SHOWS (task F8): the take's own frames on a video
 * lane, its own sound on an audio one. Fetched once per take and kept out of
 * the render path.
 *
 * FOUR THINGS THIS HOOK EXISTS TO GET RIGHT, all of them about not paying for
 * a decoration:
 *
 * 1. IT IS DYNAMIC-IMPORTED. The builders pull mediabunny's demuxer and a
 *    decoder; the editor already carries them, but the import stays lazy so a
 *    take that needs neither never touches them.
 * 2. IT DOES NOT RE-DECODE ON EVERY RESIZE. Width is rounded into buckets, so
 *    dragging a window edge redraws the CSS and re-runs a decoder only when a
 *    lane has actually changed size by a thumbnail's worth.
 * 3. IT DECODES ONE CHANNEL AT A TIME, and VIDEO FIRST. Several decoders
 *    racing for the same GPU while the editor is trying to hold 60 fps is how
 *    a nicety becomes a jank report; and the picture is what a user looks for
 *    first, so it should not queue behind four audio tracks.
 * 4. EVERY FAILURE IS SILENT AND TOTAL. No art, and the lane looks exactly as
 *    it did before F8 — which is the correct behaviour for something the
 *    editor does not need in order to work.
 */
export interface LaneArt {
  url: string
  kind: 'film' | 'wave'
  /** Reported, because F8's gate asks what generation costs. */
  wallMs: number
  /** Frames or columns that actually decoded. */
  decoded: number
}

/**
 * B10 — ONE WAVEFORM, BUILT IN A WORKER.
 *
 * Returns `{ wave }` when a worker answered (its `wave` may itself be null:
 * a silent or undecodable channel), and `null` only when there was no worker
 * to ask. The caller needs that difference: a fallback that cannot tell them
 * apart decodes every silent channel twice, on the thread this exists to keep
 * free.
 *
 * A worker per call, torn down with the answer. A waveform is built once per
 * channel per width bucket, so the pool this does not have would spend more
 * lines than it saves — and a worker that outlives the take is a decoder
 * holding a file the user has moved on from.
 */
async function waveInWorker(
  blob: Blob,
  durationSec: number,
  width: number,
  height: number,
  signal: AbortSignal,
): Promise<{ wave: LaneWave | null } | null> {
  if (typeof Worker === 'undefined') return null
  let worker: Worker
  try {
    worker = new Worker(new URL('../../core/compose/laneWave.worker.ts', import.meta.url), {
      type: 'module',
    })
  } catch {
    return null
  }
  try {
    return await new Promise<{ wave: LaneWave | null } | null>((resolve) => {
      const done = (v: { wave: LaneWave | null } | null): void => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      }
      // An aborted build resolves as "the worker answered with nothing", not as
      // "there is no worker": re-running it inline is the last thing an
      // unmounting editor needs.
      function onAbort(): void {
        done({ wave: null })
      }
      signal.addEventListener('abort', onAbort, { once: true })
      worker.onmessage = (ev: MessageEvent<LaneWaveReply>) => done({ wave: ev.data.wave })
      worker.onerror = () => done(null)
      const req: LaneWaveRequest = { id: 'wave', blob, durationSec, width, height }
      worker.postMessage(req)
    })
  } finally {
    worker.terminate()
  }
}

/** Width buckets, CSS px — see note 2 above. */
const WIDTH_BUCKET = 48
/** How tall an audio lane's waveform is drawn, CSS px (the lane is 24). */
const WAVE_HEIGHT_PX = 22

export function useLaneArt(
  recording: Recording,
  trackWidthPx: number,
  thumbHeightPx: number,
): Record<string, LaneArt> {
  const [art, setArt] = useState<Record<string, LaneArt>>({})
  // Revoked on unmount and on every rebuild; an object URL that outlives its
  // take is a leak nobody sees until a long session runs out of them.
  const urls = useRef<string[]>([])

  const bucket = Math.round(trackWidthPx / WIDTH_BUCKET)
  const totalMs = Math.max(1, recording.durationMs)
  const channelKey = recording.channels.map((c) => `${c.id}:${c.media}:${c.durationMs}`).join('|')

  useEffect(() => {
    let alive = true
    const abort = new AbortController()
    const widthPx = bucket * WIDTH_BUCKET
    if (widthPx <= 0 || !channelKey) return
    void (async () => {
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
      const publish = (id: string, art: LaneArt): void => {
        urls.current.push(art.url)
        setArt((prev) => ({ ...prev, [id]: art }))
      }
      // Video first — see note 3.
      const ordered = [
        ...recording.channels.filter((c) => c.media === 'video'),
        ...recording.channels.filter((c) => c.media !== 'video'),
      ]
      let filmstrip: typeof import('@core/compose/filmstrip').buildFilmstrip | null = null
      let lanewave: typeof import('@core/compose/lanewave').buildLaneWave | null = null

      for (const ch of ordered) {
        if (!alive || abort.signal.aborted) return
        const barPx = (ch.durationMs / totalMs) * widthPx
        const durationSec = ch.durationMs / 1000
        if (!(barPx > 0) || !(durationSec > 0)) continue
        let blob: Blob
        try {
          blob = await blobStore.read(ch.blobKey)
        } catch {
          continue
        }
        if (ch.media === 'video') {
          const plan = planFilmstrip(barPx, durationSec, thumbHeightPx)
          if (!plan) continue
          filmstrip ??= (await import('@core/compose/filmstrip')).buildFilmstrip
          const strip = await filmstrip(
            blob,
            plan.atSec,
            Math.round(plan.thumbWidthPx * dpr),
            Math.round(thumbHeightPx * dpr),
            { signal: abort.signal },
          )
          if (!alive || abort.signal.aborted) return
          if (!strip) continue
          console.info(
            `[timeline] filmstrip ${ch.kind}: ${strip.decoded}/${strip.count} frames in ${strip.wallMs} ms`,
          )
          publish(ch.id, {
            url: URL.createObjectURL(strip.blob),
            kind: 'film',
            wallMs: strip.wallMs,
            decoded: strip.decoded,
          })
        } else {
          // B10 — THE AUDIO DECODER GOES TO A WORKER, THE VIDEO ONE DOES NOT.
          // G7 named the blocking task: `output() via AudioDataOutputCallback`,
          // 192.7 ms of blocking in a 269 ms frame, while the filmstrip's video
          // callback blocks 0 ms because it yields. A waveform built here is a
          // frame the editor does not get to draw.
          const offThread = await waveInWorker(
            blob,
            durationSec,
            Math.round(barPx * dpr),
            Math.round(WAVE_HEIGHT_PX * dpr),
            abort.signal,
          )
          // `null` here means NO WORKER (an old browser, a blocked
          // construction, a test environment) — not "no waveform". A worker
          // that answered with nothing has already decided, and decoding the
          // same channel a second time on this thread is the very cost B10 is
          // about.
          const wave =
            offThread === null
              ? await (lanewave ??= (await import('@core/compose/lanewave')).buildLaneWave)(
                  blob,
                  durationSec,
                  Math.round(barPx * dpr),
                  Math.round(WAVE_HEIGHT_PX * dpr),
                  { signal: abort.signal },
                )
              : offThread.wave
          if (!alive || abort.signal.aborted) return
          if (!wave) continue
          console.info(
            `[timeline] waveform ${ch.kind}: ${wave.decoded}/${wave.columns} columns in ` +
              `${wave.wallMs} ms, peak ${wave.peak.toFixed(3)}`,
          )
          publish(ch.id, {
            url: URL.createObjectURL(wave.blob),
            kind: 'wave',
            wallMs: wave.wallMs,
            decoded: wave.decoded,
          })
        }
      }
    })()
    return () => {
      alive = false
      abort.abort()
      for (const u of urls.current) URL.revokeObjectURL(u)
      urls.current = []
      setArt({})
    }
    // `recording` itself is deliberately not a dependency: the object identity
    // changes whenever anything upstream re-renders, and re-decoding a take on
    // an unrelated state change is exactly the cost this hook is written to
    // avoid. The channels' ids, media and lengths ARE the take, for this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelKey, bucket, thumbHeightPx, totalMs])

  return art
}
